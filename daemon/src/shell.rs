//! D-Bus link to the Glide GNOME Shell extension (object exported inside gnome-shell).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use zbus::blocking::{connection, proxy, Connection, Proxy};

const DEST: &str = "org.gnome.Shell";
const PATH: &str = "/io/github/taulit/Glide";
const IFACE: &str = "io.github.taulit.Glide";
/// Name the daemon owns so the extension can show whether it is running.
const OWN_NAME: &str = "io.github.taulit.Glided";

#[derive(Debug, PartialEq)]
pub enum Mode {
    /// Pass the middle button through untouched (also used when the app scrolls natively).
    Off,
    /// Click = normal middle click, drag or press-and-pause = autoscroll.
    Smart,
    /// Windows behaviour: every middle press starts autoscroll.
    Classic,
}

pub struct Shell {
    conn: Connection,
    /// Bumped whenever the extension ends autoscroll on its own.
    ended: Arc<AtomicU64>,
}

impl Shell {
    pub fn connect() -> zbus::Result<Self> {
        let conn = connection::Builder::session()?
            // The middle press is held back while we wait, so never wait long.
            .method_timeout(Duration::from_millis(150))
            .name(OWN_NAME)?
            .build()?;
        Ok(Self {
            conn,
            ended: Arc::default(),
        })
    }

    fn proxy(&self) -> zbus::Result<Proxy<'static>> {
        proxy::Builder::new(&self.conn)
            .destination(DEST)?
            .path(PATH)?
            .interface(IFACE)?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
    }

    pub fn generation(&self) -> u64 {
        self.ended.load(Ordering::SeqCst)
    }

    pub fn query(&self) -> Mode {
        let mode: zbus::Result<String> = self.proxy().and_then(|p| p.call("Query", &()));
        match mode.as_deref() {
            Ok("smart") => Mode::Smart,
            Ok("classic") => Mode::Classic,
            Ok(_) => Mode::Off,
            Err(e) => {
                // Extension disabled or shell busy: behave like a plain mouse.
                eprintln!("glided: Query failed ({e}), passing click through");
                Mode::Off
            }
        }
    }

    /// Starts autoscroll. `None` if it did not start, otherwise whether the extension reads
    /// the mouse motion itself (then the motion must reach the compositor as usual).
    pub fn begin(&self, kind: &str) -> Option<bool> {
        let start = self
            .proxy()
            .and_then(|p| p.call::<_, _, (bool, bool)>("Start", &(kind,)));
        let result = match start {
            Ok((started, tracked)) => Ok(started.then_some(tracked)),
            // An older extension without Start: it takes the raw motion through Move.
            Err(_) => self
                .proxy()
                .and_then(|p| p.call::<_, _, bool>("Begin", &(kind,)))
                .map(|started| started.then_some(false)),
        };
        result.unwrap_or_else(|e| {
            eprintln!("glided: Begin failed: {e}");
            None
        })
    }

    pub fn moved(&self, dx: i32, dy: i32) {
        if let Ok(p) = self.proxy() {
            let _ = p.call_noreply("Move", &(dx, dy));
        }
    }

    pub fn stick(&self) {
        if let Ok(p) = self.proxy() {
            let _ = p.call_noreply("Stick", &());
        }
    }

    /// Keeps the session alive. `Some(false)` if the extension has no session any more;
    /// `None` if it did not answer (its own lease then lets the cursor go).
    pub fn alive(&self) -> Option<bool> {
        self.proxy()
            .and_then(|p| p.call::<_, _, bool>("Alive", &()))
            .ok()
    }

    pub fn end(&self) {
        if let Ok(p) = self.proxy() {
            let _ = p.call_noreply("End", &());
        }
    }

    pub fn spawn_ended_listener(&self) {
        let conn = self.conn.clone();
        let ended = self.ended.clone();
        std::thread::spawn(move || loop {
            let listen = || -> zbus::Result<()> {
                let p: Proxy = proxy::Builder::new(&conn)
                    .destination(DEST)?
                    .path(PATH)?
                    .interface(IFACE)?
                    .cache_properties(zbus::proxy::CacheProperties::No)
                    .build()?;
                for _ in p.receive_signal("Ended")? {
                    ended.fetch_add(1, Ordering::SeqCst);
                }
                Ok(())
            };
            if let Err(e) = listen() {
                eprintln!("glided: signal listener: {e}");
            }
            std::thread::sleep(Duration::from_secs(2));
        });
    }
}
