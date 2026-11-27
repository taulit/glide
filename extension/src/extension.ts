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

/** Offset (px of virtual cursor travel) beyond which pushing further does nothing. */
const MAX_OFFSET = 420;

/** What a middle press does over a window, and why. Also sent to the prefs window. */
export interface Decision {
  ids?: string[];
  title?: string;
  mode: Mode;
  reason: string;
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

  constructor(
    private readonly ext: GlideExtension,
    private readonly vdev: Clutter.VirtualInputDevice,
    settings: Gio.Settings,
    kind: string,
  ) {
    this.sensitivity = settings.get_double('sensitivity');
    this.speed = settings.get_double('speed');
    this.dead = settings.get_int('dead-zone');
    const [ax, ay] = global.get_pointer();

    this.indicator = new Indicator(ax, ay, { sticky: kind === 'sticky', deadZone: this.dead });

    // The indicator takes the place of the cursor. Hiding the cursor alone would also take
    // pointer focus away from the window, and with it the scroll events: Mutter keeps the
    // focus while the seat's unfocus is inhibited, so that comes first.
    this.seat = global.stage.context.get_backend().get_default_seat();
    this.seat.inhibit_unfocus();
    this.cursor = global.backend.get_cursor_tracker();
    this.cursor.inhibit_cursor_visibility();

    this.timeline = new Clutter.Timeline({
      actor: this.indicator,
      duration: 1000,
      repeat_count: -1,
    });
    this.timeline.connect('new-frame', () => this.frame());
    this.timeline.start();

    this.grabEscape();
    this.overviewId = Main.overview.connect('showing', () => this.ext.stop(true));
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
        (vx * dt) / 10,
        (vy * dt) / 10,
        Clutter.ScrollSource.CONTINUOUS,
        Clutter.ScrollFinishFlags.NONE,
      );
    }
    this.indicator.update(this.ox, this.oy, vx, vy);
  }

  destroy() {
    this.timeline.stop();
    Main.overview.disconnect(this.overviewId);
    if (this.escId) {
      global.display.disconnect(this.escId);
      global.display.ungrab_accelerator(this.escAction);
      Main.wm.allowKeybinding(this.escName, Shell.ActionMode.NONE);
    }
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

  private windowAt(x: number, y: number): Meta.Window | null {
    const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    for (let a: Clutter.Actor | null = actor; a; a = a.get_parent()) {
      if (a instanceof Meta.WindowActor) return a.get_meta_window();
    }
    return null;
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
      const win = this.windowAt(x, y);
      decision = win ? this.decide(settings, win) : { mode: 'off', reason: 'not over a window' };
    }
    this.last = { ...decision, at: Date.now() };
    // native and off are the same for the daemon: let the button through.
    return decision.mode;
  }

  Begin(kind: string): boolean {
    this.stop(false);
    if (!this.settings?.get_boolean('enabled') || !this.vdev) return false;
    this.session = new Session(this, this.vdev, this.settings, kind);
    return true;
  }

  Move(dx: number, dy: number): void {
    this.session?.move(dx, dy);
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
