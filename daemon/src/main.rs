//! glided: the input half of Glide.
//!
//! GNOME Shell (Mutter) delivers pointer buttons straight to Wayland clients, so an extension
//! can neither see nor swallow a middle click on an app window. This daemon sits below the
//! compositor instead: it grabs every mouse, re-emits its events through a uinput clone and,
//! for the middle button only, asks the extension what to do with the window under the pointer.
//!
//! The extension draws the indicator and emits the smooth scroll events itself; the daemon
//! swallows pointer motion while autoscroll runs (so the cursor and the scroll target stay
//! put) and forwards it as `Move` deltas instead.

mod shell;

use evdev::{
    uinput::VirtualDevice, AbsoluteAxisCode, AttributeSet, Device, EventSummary, EventType,
    InputEvent, KeyCode, RelativeAxisCode, SynchronizationCode, UinputAbsSetup,
};
use shell::{Mode, Shell};
use std::collections::HashSet;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VIRTUAL_PREFIX: &str = "Glide virtual pointer";

#[derive(Clone, Copy)]
struct Tuning {
    /// Raw mouse counts the pointer has to travel while the button is held before a press
    /// becomes a drag-autoscroll (smart mode).
    drag_threshold: i32,
    /// Holding the button still this long arms sticky autoscroll (smart mode).
    hold_delay: Duration,
    /// In classic mode a press shorter than this (and not moved) leaves autoscroll running.
    click_time: Duration,
    /// How often accumulated motion is sent to the extension.
    move_interval: Duration,
}

fn main() {
    let tuning = parse_args();
    let shell = Arc::new(Shell::connect().unwrap_or_else(|e| {
        eprintln!("glided: cannot connect to the session bus: {e}");
        std::process::exit(1);
    }));
    shell.spawn_ended_listener();

    let active: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();
    eprintln!("glided: watching for mice");
    loop {
        for (path, dev) in evdev::enumerate() {
            if !is_mouse(&dev) || active.lock().unwrap().contains(&path) {
                continue;
            }
            let name = dev.name().unwrap_or("?").to_string();
            match Pipe::new(dev, &name) {
                Ok(pipe) => {
                    eprintln!("glided: grabbed {name} ({})", path.display());
                    active.lock().unwrap().insert(path.clone());
                    let (active, shell) = (active.clone(), shell.clone());
                    std::thread::spawn(move || {
                        if let Err(e) = pipe.run(&shell, tuning) {
                            eprintln!("glided: {name} gone: {e}");
                        }
                        active.lock().unwrap().remove(&path);
                    });
                }
                Err(e) => eprintln!("glided: skipping {name}: {e}"),
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn parse_args() -> Tuning {
    let mut t = Tuning {
        drag_threshold: 12,
        hold_delay: Duration::from_millis(280),
        click_time: Duration::from_millis(250),
        move_interval: Duration::from_millis(7),
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut num = || -> u64 {
            it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| {
                eprintln!("glided: {a} needs a number");
                std::process::exit(2)
            })
        };
        match a.as_str() {
            "--drag-threshold" => t.drag_threshold = num() as i32,
            "--hold-delay-ms" => t.hold_delay = Duration::from_millis(num()),
            "--click-ms" => t.click_time = Duration::from_millis(num()),
            "-h" | "--help" => {
                println!("glided [--drag-threshold COUNTS] [--hold-delay-ms MS] [--click-ms MS]");
                std::process::exit(0);
            }
            other => {
                eprintln!("glided: unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    t
}

fn is_mouse(dev: &Device) -> bool {
    if dev.name().is_some_and(|n| n.starts_with(VIRTUAL_PREFIX)) {
        return false;
    }
    let has_middle = dev
        .supported_keys()
        .is_some_and(|k| k.contains(KeyCode::BTN_MIDDLE));
    let has_motion = dev.supported_relative_axes().is_some_and(|r| {
        r.contains(RelativeAxisCode::REL_X) && r.contains(RelativeAxisCode::REL_Y)
    });
    // Touchpads and tablets report absolute positions; leave them to libinput. Other absolute
    // axes are fine: Logitech receivers add ABS_VOLUME to the mouse node, for example.
    let has_position = dev.supported_absolute_axes().is_some_and(|a| {
        a.contains(AbsoluteAxisCode::ABS_X) || a.contains(AbsoluteAxisCode::ABS_Y)
    });
    has_middle && has_motion && !has_position
}

/// One grabbed mouse and its uinput clone.
struct Pipe {
    dev: Device,
    out: VirtualDevice,
}

impl Pipe {
    fn new(mut dev: Device, name: &str) -> std::io::Result<Self> {
        let mut keys = AttributeSet::<KeyCode>::new();
        for k in dev.supported_keys().into_iter().flat_map(|s| s.iter()) {
            keys.insert(k);
        }
        let mut rels = AttributeSet::<RelativeAxisCode>::new();
        for r in dev
            .supported_relative_axes()
            .into_iter()
            .flat_map(|s| s.iter())
        {
            rels.insert(r);
        }
        let clone_name = format!("{VIRTUAL_PREFIX} ({name})");
        let mut builder = VirtualDevice::builder()?
            .name(&clone_name)
            .with_keys(&keys)?
            .with_relative_axes(&rels)?;
        if dev.supported_absolute_axes().is_some() {
            for (code, info) in dev.get_absinfo()? {
                builder = builder.with_absolute_axis(&UinputAbsSetup::new(code, info))?;
            }
        }
        let out = builder.build()?;
        dev.grab()?;
        Ok(Self { dev, out })
    }

    fn run(mut self, shell: &Shell, tuning: Tuning) -> std::io::Result<()> {
        let fd = self.dev.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        let mut m = Machine::new(shell, tuning);
        let mut frame: Vec<InputEvent> = Vec::with_capacity(16);
        loop {
            let timeout = m.poll_timeout();
            let mut pfd = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut pfd, 1, timeout) };
            if ready < 0 {
                let err = std::io::Error::last_os_error();
                if err.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(err);
            }
            if pfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                return Err(std::io::Error::other("device removed"));
            }
            if ready > 0 {
                let events: Vec<InputEvent> = match self.dev.fetch_events() {
                    Ok(evs) => evs.collect(),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Vec::new(),
                    Err(e) => return Err(e),
                };
                for ev in events {
                    if ev.event_type() == EventType::SYNCHRONIZATION {
                        if !frame.is_empty() {
                            self.out.emit(&frame)?;
                            frame.clear();
                        }
                        m.on_frame_end();
                    } else {
                        m.on_event(ev, &mut frame);
                    }
                }
            }
            let mut extra = Vec::new();
            m.tick(&mut extra);
            if !extra.is_empty() {
                self.out.emit(&extra)?;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    /// Classic mode, button still held right after the press.
    ClassicPress,
    /// Drag started while holding: ends on release.
    Hold,
    /// Held still long enough: continues after release.
    StickyArmed,
}

#[derive(Debug)]
enum State {
    Idle,
    /// Smart mode: press withheld, deciding between click and autoscroll.
    Pending {
        since: Instant,
        dx: i32,
        dy: i32,
    },
    /// Autoscroll running while the middle button is held.
    Active {
        kind: Kind,
        since: Instant,
        moved: i32,
        gen: u64,
    },
    /// Autoscroll running with the button released; any click stops it.
    Sticky {
        gen: u64,
    },
}

struct Machine<'a> {
    shell: &'a Shell,
    t: Tuning,
    state: State,
    /// Buttons whose press was swallowed: their release must be swallowed too.
    swallowed: HashSet<KeyCode>,
    move_dx: i32,
    move_dy: i32,
    last_move: Instant,
}

fn key(code: KeyCode, value: i32) -> InputEvent {
    InputEvent::new(EventType::KEY.0, code.0, value)
}

fn syn() -> InputEvent {
    InputEvent::new(
        EventType::SYNCHRONIZATION.0,
        SynchronizationCode::SYN_REPORT.0,
        0,
    )
}

impl<'a> Machine<'a> {
    fn new(shell: &'a Shell, t: Tuning) -> Self {
        Self {
            shell,
            t,
            state: State::Idle,
            swallowed: HashSet::new(),
            move_dx: 0,
            move_dy: 0,
            last_move: Instant::now(),
        }
    }

    fn scrolling(&self) -> bool {
        matches!(self.state, State::Active { .. } | State::Sticky { .. })
    }

    fn poll_timeout(&self) -> i32 {
        match self.state {
            State::Idle => 500,
            State::Pending { since, .. } => {
                let left = self.t.hold_delay.saturating_sub(since.elapsed());
                left.as_millis().clamp(1, 500) as i32
            }
            _ => self.t.move_interval.as_millis() as i32,
        }
    }

    fn begin(&mut self, kind: Kind) -> bool {
        let label = match kind {
            Kind::ClassicPress => "classic",
            Kind::Hold => "hold",
            Kind::StickyArmed => "sticky",
        };
        let gen = self.shell.generation();
        if !self.shell.begin(label) {
            return false;
        }
        self.move_dx = 0;
        self.move_dy = 0;
        self.last_move = Instant::now();
        self.state = State::Active {
            kind,
            since: Instant::now(),
            moved: 0,
            gen,
        };
        true
    }

    fn end(&mut self) {
        if self.scrolling() {
            self.flush_moves();
            self.shell.end();
        }
        self.state = State::Idle;
    }

    fn flush_moves(&mut self) {
        if self.move_dx != 0 || self.move_dy != 0 {
            self.shell.moved(self.move_dx, self.move_dy);
            self.move_dx = 0;
            self.move_dy = 0;
        }
        self.last_move = Instant::now();
    }

    fn on_event(&mut self, ev: InputEvent, out: &mut Vec<InputEvent>) {
        match ev.destructure() {
            EventSummary::Key(_, code, value) => self.on_key(ev, code, value, out),
            EventSummary::RelativeAxis(_, axis, value) => self.on_rel(ev, axis, value, out),
            _ => out.push(ev),
        }
    }

    fn on_key(&mut self, ev: InputEvent, code: KeyCode, value: i32, out: &mut Vec<InputEvent>) {
        let middle = code == KeyCode::BTN_MIDDLE;
        match value {
            1 => match self.state {
                State::Idle if middle => self.middle_pressed(ev, out),
                State::Idle => out.push(ev),
                State::Pending { .. } => {
                    // A chord (e.g. middle + left): hand both to the app unchanged.
                    out.push(key(KeyCode::BTN_MIDDLE, 1));
                    out.push(ev);
                    self.state = State::Idle;
                }
                State::Active { .. } | State::Sticky { .. } => {
                    // Like Windows: a click stops autoscroll and is consumed.
                    self.end();
                    self.swallowed.insert(code);
                }
            },
            0 => {
                if middle {
                    match self.state {
                        State::Pending { .. } => {
                            // Plain middle click: replay it so paste, open-in-tab and
                            // close-tab keep working.
                            out.push(key(KeyCode::BTN_MIDDLE, 1));
                            out.push(syn());
                            out.push(ev);
                            self.state = State::Idle;
                            return;
                        }
                        State::Active {
                            kind,
                            since,
                            moved,
                            gen,
                        } => {
                            self.swallowed.remove(&code);
                            let tap = since.elapsed() < self.t.click_time
                                && moved < self.t.drag_threshold;
                            let stay =
                                kind == Kind::StickyArmed || (kind == Kind::ClassicPress && tap);
                            if stay {
                                self.shell.stick();
                                self.state = State::Sticky { gen };
                            } else {
                                self.end();
                            }
                            return;
                        }
                        _ => {}
                    }
                }
                if !self.swallowed.remove(&code) {
                    out.push(ev);
                }
            }
            _ => {
                if !self.swallowed.contains(&code) {
                    out.push(ev);
                }
            }
        }
    }

    fn middle_pressed(&mut self, ev: InputEvent, out: &mut Vec<InputEvent>) {
        match self.shell.query() {
            Mode::Smart => {
                self.state = State::Pending {
                    since: Instant::now(),
                    dx: 0,
                    dy: 0,
                };
            }
            Mode::Classic if self.begin(Kind::ClassicPress) => {
                self.swallowed.insert(KeyCode::BTN_MIDDLE);
            }
            _ => out.push(ev),
        }
    }

    fn on_rel(
        &mut self,
        ev: InputEvent,
        axis: RelativeAxisCode,
        value: i32,
        out: &mut Vec<InputEvent>,
    ) {
        let motion = axis == RelativeAxisCode::REL_X || axis == RelativeAxisCode::REL_Y;
        match &mut self.state {
            State::Active { .. } | State::Sticky { .. } if motion => {
                if axis == RelativeAxisCode::REL_X {
                    self.move_dx += value;
                } else {
                    self.move_dy += value;
                }
                if let State::Active { moved, .. } = &mut self.state {
                    *moved += value.abs();
                }
            }
            State::Active { .. } | State::Sticky { .. } => {
                // Turning the wheel stops autoscroll and scrolls normally.
                self.end();
                out.push(ev);
            }
            State::Pending { dx, dy, .. } if motion => {
                if axis == RelativeAxisCode::REL_X {
                    *dx += value;
                } else {
                    *dy += value;
                }
                let (dx, dy) = (*dx, *dy);
                out.push(ev);
                let thr = self.t.drag_threshold;
                if dx * dx + dy * dy >= thr * thr {
                    if self.begin(Kind::Hold) {
                        self.swallowed.insert(KeyCode::BTN_MIDDLE);
                    } else {
                        out.push(key(KeyCode::BTN_MIDDLE, 1));
                        self.state = State::Idle;
                    }
                }
            }
            State::Pending { .. } => {
                out.push(key(KeyCode::BTN_MIDDLE, 1));
                out.push(ev);
                self.state = State::Idle;
            }
            State::Idle => out.push(ev),
        }
    }

    fn on_frame_end(&mut self) {
        if self.scrolling() && self.last_move.elapsed() >= self.t.move_interval {
            self.flush_moves();
        }
    }

    fn tick(&mut self, out: &mut Vec<InputEvent>) {
        match self.state {
            State::Pending { since, .. } if since.elapsed() >= self.t.hold_delay => {
                if self.begin(Kind::StickyArmed) {
                    self.swallowed.insert(KeyCode::BTN_MIDDLE);
                } else {
                    out.push(key(KeyCode::BTN_MIDDLE, 1));
                    self.state = State::Idle;
                }
            }
            State::Active { gen, .. } | State::Sticky { gen } if self.shell.generation() != gen => {
                // The extension stopped on its own (Esc, overview, window gone...).
                self.move_dx = 0;
                self.move_dy = 0;
                self.state = State::Idle;
            }
            State::Active { .. } | State::Sticky { .. }
                if self.last_move.elapsed() >= self.t.move_interval =>
            {
                self.flush_moves();
            }
            _ => {}
        }
    }
}
