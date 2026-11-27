// Glide: Windows-style middle-click autoscroll for GNOME.
//
// Mutter hands pointer buttons directly to Wayland clients, so this extension cannot catch a
// middle click on an app by itself. The companion daemon (glided) grabs the mice, asks us via
// D-Bus what a middle press over the current window should do (Query), and while autoscroll
// runs it freezes the cursor and forwards mouse motion (Move). We pick the rule, draw the
// indicator and emit smooth scroll events through a Clutter virtual pointer.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Indicator } from './indicator.js';
import { type Mode, type RuleMatcher, compileRules, isMode, parseRules } from './rules.js';

const OBJECT_PATH = '/io/github/taulit/Glide';
const DAEMON_NAME = 'io.github.taulit.Glided';
const IFACE_XML = `
<node>
  <interface name="io.github.taulit.Glide">
    <method name="Query"><arg type="s" direction="out" name="mode"/></method>
    <method name="Begin">
      <arg type="s" direction="in" name="kind"/>
      <arg type="b" direction="out" name="started"/>
    </method>
    <method name="Start">
      <arg type="s" direction="in" name="kind"/>
      <arg type="b" direction="out" name="started"/>
      <arg type="b" direction="out" name="tracked"/>
    </method>
    <method name="Move">
      <arg type="i" direction="in" name="dx"/>
      <arg type="i" direction="in" name="dy"/>
    </method>
    <method name="Stick"/>
    <method name="End"/>
    <method name="Describe"><arg type="s" direction="out" name="json"/></method>
    <signal name="Ended"/>
  </interface>
</node>`;

/**
 * Offset (px of virtual cursor travel) beyond which pushing further does nothing. Larger than
 * the distance to most screen edges on purpose: the puck stops at the edge, the speed does not.
 */
const MAX_OFFSET = 900;

/** What a middle press does over a window, and why. Also sent to the prefs window. */
export interface Decision {
  ids?: string[];
  title?: string;
  mode: Mode;
  reason: string;
}

function windowAt(x: number, y: number): Meta.Window | null {
  const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
  for (let a: Clutter.Actor | null = actor; a; a = a.get_parent()) {
    if (a instanceof Meta.WindowActor) return a.get_meta_window();
  }
  return null;
}

/**
 * Clients turn the same smooth scroll into very different distances. Measured px per unit
 * (GNOME 51): Chromium and Electron 12, Firefox 13.2, GTK 3 15.5, GTK 4 only 2.5. GTK 4 apps
 * (Files, Settings, most of GNOME) are therefore scaled up to match the others. Chromium and
 * Electron load libgtk-4 too (for dialogs); the V8 snapshot next to their binary tells them
 * apart.
 */
const GTK4_SCROLL_SCALE = 4.8;

function scrollScale(win: Meta.Window | null): number {
  const pid = win?.get_pid() ?? 0;
  if (pid <= 0) return 1;
  try {
    const dir = GLib.path_get_dirname(GLib.file_read_link(`/proc/${pid}/exe`));
    if (GLib.file_test(`${dir}/v8_context_snapshot.bin`, GLib.FileTest.EXISTS)) return 1;
    const [, maps] = GLib.file_get_contents(`/proc/${pid}/maps`);
    return new TextDecoder().decode(maps).includes('/libgtk-4.so') ? GTK4_SCROLL_SCALE : 1;
  } catch {
    return 1;
  }
}

function windowIds(win: Meta.Window): string[] {
  const app = Shell.WindowTracker.get_default().get_window_app(win);
  const ids = [
    app?.get_id()?.replace(/\.desktop$/, ''),
    win.get_sandboxed_app_id(),
    win.get_gtk_application_id(),
    win.get_wm_class(),
    win.get_wm_class_instance(),
  ].filter((id): id is string => !!id);
  return [...new Set(ids)];
}

class Session {
  private readonly sensitivity: number;
  private readonly speed: number;
  private readonly dead: number;
  /** Toolkit correction for the window under the anchor, see scrollScale. */
  private readonly scale: number;
  private ox = 0;
  private oy = 0;
  private last = GLib.get_monotonic_time();
  private readonly indicator: Indicator;
  private readonly seat: Clutter.Seat;
  private readonly cursor: Meta.CursorTracker;
  private readonly timeline: Clutter.Timeline;
  private readonly overviewId: number;
  private escAction = Meta.KeyBindingAction.NONE;
  private escName = '';
  private escId = 0;
  private barriers: Meta.Barrier[] = [];
  private lastHit = '';
  /** The session reads the motion from barriers around the anchor, not from Move. */
  readonly tracked: boolean;

  constructor(
    private readonly ext: GlideExtension,
    private readonly vdev: Clutter.VirtualInputDevice,
    settings: Gio.Settings,
    kind: string,
    track: boolean,
  ) {
    this.sensitivity = settings.get_double('sensitivity');
    this.speed = settings.get_double('speed');
    this.dead = settings.get_int('dead-zone');
    const [ax, ay] = global.get_pointer();
    this.scale = scrollScale(windowAt(ax, ay));

    this.indicator = new Indicator(ax, ay, { sticky: kind === 'sticky', deadZone: this.dead });

    // The indicator takes the place of the cursor. Hiding the cursor alone would also take
    // pointer focus away from the window, and with it the scroll events: Mutter keeps the
    // focus while the seat's unfocus is inhibited, so that comes first.
    this.seat = global.stage.context.get_backend().get_default_seat();
    this.seat.inhibit_unfocus();
    this.cursor = global.backend.get_cursor_tracker();
    this.cursor.inhibit_cursor_visibility();
    // Fullscreen windows can be scanned out directly, without the shell drawing on top: the
    // indicator would show for a frame and then vanish.
    global.compositor.disable_unredirect();

    this.timeline = new Clutter.Timeline({
      actor: this.indicator.actor,
      duration: 1000,
      repeat_count: -1,
    });
    this.timeline.connect('new-frame', () => this.frame());
    this.timeline.start();

    this.tracked = track && this.holdCursor(ax, ay);
    this.grabEscape();
    this.overviewId = Main.overview.connect('showing', () => this.ext.stop(true));
  }

  /**
   * Boxes the real cursor in at the anchor with four barriers. glided then passes the mouse
   * motion on as usual, libinput accelerates it like any cursor motion, and Mutter reports
   * each push against a wall with the full delta: the puck moves exactly as the cursor would.
   */
  private holdCursor(ax: number, ay: number): boolean {
    const D = Meta.BarrierDirection;
    const wall = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      letsIn: Meta.BarrierDirection,
    ) => {
      const barrier = new Meta.Barrier({
        backend: global.backend,
        x1,
        y1,
        x2,
        y2,
        directions: letsIn,
      });
      barrier.connect('hit', (_b, event: Meta.BarrierEvent) => this.onHit(event));
      this.barriers.push(barrier);
    };
    try {
      wall(ax - 1, ay - 1, ax - 1, ay + 1, D.POSITIVE_X);
      wall(ax + 1, ay - 1, ax + 1, ay + 1, D.NEGATIVE_X);
      wall(ax - 1, ay - 1, ax + 1, ay - 1, D.POSITIVE_Y);
      wall(ax - 1, ay + 1, ax + 1, ay + 1, D.NEGATIVE_Y);
      return true;
    } catch (e) {
      console.warn(`Glide: cannot hold the cursor with barriers, using raw motion: ${e}`);
      this.releaseCursor();
      return false;
    }
  }

  private onHit(event: Meta.BarrierEvent) {
    // A push into a corner reaches two walls with the same event.
    const key = `${event.time} ${event.x} ${event.y} ${event.dx} ${event.dy}`;
    if (key === this.lastHit) return;
    this.lastHit = key;
    this.move(event.dx, event.dy);
  }

  private releaseCursor() {
    this.barriers.forEach(b => b.destroy());
    this.barriers = [];
  }

  private grabEscape() {
    this.escAction = global.display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
    if (this.escAction === Meta.KeyBindingAction.NONE) return;
    this.escName = Meta.external_binding_name_for_action(this.escAction);
    Main.wm.allowKeybinding(this.escName, Shell.ActionMode.ALL);
    this.escId = global.display.connect('accelerator-activated', (_d, action) => {
      if (action === this.escAction) this.ext.stop(true);
    });
  }

  move(dx: number, dy: number) {
    this.ox += dx * this.sensitivity;
    this.oy += dy * this.sensitivity;
    const d = Math.hypot(this.ox, this.oy);
    if (d > MAX_OFFSET) {
      this.ox *= MAX_OFFSET / d;
      this.oy *= MAX_OFFSET / d;
    }
  }

  stick() {
    this.indicator.setSticky(true);
  }

  /** px/s for one axis: nothing inside the dead zone, then a gentle power curve. */
  private velocity(o: number) {
    const e = Math.abs(o) - this.dead;
    if (e <= 0) return 0;
    return Math.sign(o) * this.speed * 0.55 * Math.pow(e, 1.6);
  }

  private frame() {
    const now = GLib.get_monotonic_time();
    const dt = Math.min(0.05, (now - this.last) / 1e6);
    this.last = now;

    const vx = this.velocity(this.ox);
    const vy = this.velocity(this.oy);
    if (vx || vy) {
      // Mutter turns 1.0 of a smooth scroll into 10 px for clients.
      this.vdev.notify_scroll_continuous(
        now,
        (vx * dt * this.scale) / 10,
        (vy * dt * this.scale) / 10,
        Clutter.ScrollSource.CONTINUOUS,
        Clutter.ScrollFinishFlags.NONE,
      );
    }
    this.indicator.update(this.ox, this.oy, vx, vy);
  }

  destroy() {
    this.timeline.stop();
    this.releaseCursor();
    Main.overview.disconnect(this.overviewId);
    if (this.escId) {
      global.display.disconnect(this.escId);
      global.display.ungrab_accelerator(this.escAction);
      Main.wm.allowKeybinding(this.escName, Shell.ActionMode.NONE);
    }
    // The cursor comes back where the puck is, the point the hand pulled to.
    const [x, y] = this.indicator.puckPosition;
    this.vdev.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    global.compositor.enable_unredirect();
    this.cursor.uninhibit_cursor_visibility();
    this.seat.uninhibit_unfocus();
    this.indicator.dismiss();
  }
}

export default class GlideExtension extends Extension {
  private settings: Gio.Settings | null = null;
  private vdev: Clutter.VirtualInputDevice | null = null;
  private match: RuleMatcher = () => null;
  private rulesId = 0;
  private session: Session | null = null;
  private last: (Decision & { at: number }) | null = null;
  private daemonRunning = false;
  private watchId = 0;
  private dbus: Gio.DBusExportedObject | null = null;

  override enable(): void {
    const settings = this.getSettings();
    this.settings = settings;
    this.loadRules(settings);
    this.rulesId = settings.connect('changed::rules', () => this.loadRules(settings));

    const seat = global.stage.context.get_backend().get_default_seat();
    this.vdev = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

    this.watchId = Gio.bus_watch_name(
      Gio.BusType.SESSION,
      DAEMON_NAME,
      Gio.BusNameWatcherFlags.NONE,
      () => {
        this.daemonRunning = true;
      },
      () => {
        this.daemonRunning = false;
        this.stop(false);
      },
    );

    this.dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
    this.dbus.export(Gio.DBus.session, OBJECT_PATH);
  }

  override disable(): void {
    this.stop(false);
    this.dbus?.unexport();
    this.dbus = null;
    Gio.bus_unwatch_name(this.watchId);
    this.settings?.disconnect(this.rulesId);
    this.settings = null;
    this.vdev = null;
    this.match = () => null;
  }

  private loadRules(settings: Gio.Settings) {
    this.match = compileRules(parseRules(settings.get_string('rules')));
  }

  /** Resolves the mode for a window, plus why. */
  private decide(settings: Gio.Settings, win: Meta.Window): Decision {
    const ids = windowIds(win);
    const title = win.get_title() ?? '';
    const rule = this.match(ids, title);
    if (rule) return { ids, title, mode: rule.mode, reason: rule.name || rule.match };
    if (win.is_fullscreen() && settings.get_boolean('fullscreen-off'))
      return { ids, title, mode: 'off', reason: 'fullscreen window' };
    const fallback = settings.get_string('default-mode');
    return { ids, title, mode: isMode(fallback) ? fallback : 'smart', reason: 'default' };
  }

  stop(notifyDaemon: boolean): void {
    if (!this.session) return;
    this.session.destroy();
    this.session = null;
    if (notifyDaemon) this.dbus?.emit_signal('Ended', null as unknown as GLib.Variant);
  }

  // ----- D-Bus methods (called by glided) -----

  Query(): string {
    const settings = this.settings;
    let decision: Decision;
    if (!settings?.get_boolean('enabled')) {
      decision = { mode: 'off', reason: 'disabled' };
    } else if (Main.overview.visible || Main.modalCount > 0) {
      decision = { mode: 'off', reason: 'shell UI is active' };
    } else {
      const [x, y] = global.get_pointer();
      const win = windowAt(x, y);
      decision = win ? this.decide(settings, win) : { mode: 'off', reason: 'not over a window' };
    }
    this.last = { ...decision, at: Date.now() };
    // native and off are the same for the daemon: let the button through.
    return decision.mode;
  }

  /** Older glided: it holds the cursor itself and sends the raw motion with Move. */
  Begin(kind: string): boolean {
    return this.start(kind, false);
  }

  /**
   * Current glided: if `tracked` comes back true, it passes the mouse motion on and the
   * extension holds the cursor and reads the motion itself.
   */
  Start(kind: string): [boolean, boolean] {
    const started = this.start(kind, true);
    return [started, started && !!this.session?.tracked];
  }

  private start(kind: string, track: boolean): boolean {
    this.stop(false);
    if (!this.settings?.get_boolean('enabled') || !this.vdev) return false;
    this.session = new Session(this, this.vdev, this.settings, kind, track);
    return true;
  }

  Move(dx: number, dy: number): void {
    if (this.session && !this.session.tracked) this.session.move(dx, dy);
  }

  Stick(): void {
    this.session?.stick();
  }

  End(): void {
    this.stop(false);
  }

  /** For the preferences window: open windows with their resolved mode, and daemon state. */
  Describe(): string {
    const settings = this.settings;
    const windows = settings
      ? global
          .get_window_actors()
          .map(a => a.get_meta_window())
          .filter((w): w is Meta.Window => w?.get_window_type() === Meta.WindowType.NORMAL)
          .map(w => this.decide(settings, w))
      : [];
    return JSON.stringify({ daemon: this.daemonRunning, last: this.last, windows });
  }
}
