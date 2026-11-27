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
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './indicator.js';
import {compileRules, parseRules} from './rules.js';

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

function windowIds(win) {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    const ids = [
        app?.get_id()?.replace(/\.desktop$/, ''),
        win.get_sandboxed_app_id?.(),
        win.get_gtk_application_id?.(),
        win.get_wm_class(),
        win.get_wm_class_instance(),
    ].filter(Boolean);
    return [...new Set(ids)];
}

class Session {
    constructor(ext, kind) {
        this._ext = ext;
        const s = ext.settings;
        this._sensitivity = s.get_double('sensitivity');
        this._speed = s.get_double('speed');
        this._dead = s.get_int('dead-zone');
        [this._ax, this._ay] = global.get_pointer();
        this._ox = 0;
        this._oy = 0;
        this._last = GLib.get_monotonic_time();

        this._indicator = new Indicator(this._ax, this._ay, {
            sticky: kind === 'sticky',
            deadZone: this._dead,
        });

        // The cursor stays visible: while Mutter hides it (inhibit_cursor_visibility) it also
        // stops sending pointer events, scroll included, to Wayland clients.

        this._timeline = new Clutter.Timeline({
            actor: this._indicator,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._frame());
        this._timeline.start();

        this._grabEscape();
        this._overviewId = Main.overview.connect('showing', () => this._ext.stop(true));
    }

    _grabEscape() {
        this._escAction = global.display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
        if (this._escAction === Meta.KeyBindingAction.NONE)
            return;
        this._escName = Meta.external_binding_name_for_action(this._escAction);
        Main.wm.allowKeybinding(this._escName, Shell.ActionMode.ALL);
        this._escId = global.display.connect('accelerator-activated', (_d, action) => {
            if (action === this._escAction)
                this._ext.stop(true);
        });
    }

    move(dx, dy) {
        this._ox += dx * this._sensitivity;
        this._oy += dy * this._sensitivity;
        const d = Math.hypot(this._ox, this._oy);
        if (d > MAX_OFFSET) {
            this._ox *= MAX_OFFSET / d;
            this._oy *= MAX_OFFSET / d;
        }
    }

    stick() {
        this._indicator.setSticky(true);
    }

    /** px/s for one axis: nothing inside the dead zone, then a gentle power curve. */
    _velocity(o) {
        const e = Math.abs(o) - this._dead;
        if (e <= 0)
            return 0;
        return Math.sign(o) * this._speed * 0.55 * Math.pow(e, 1.6);
    }

    _frame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.05, (now - this._last) / 1e6);
        this._last = now;

        const vx = this._velocity(this._ox);
        const vy = this._velocity(this._oy);
        if (vx || vy) {
            // Mutter turns 1.0 of a smooth scroll into 10 px for clients.
            this._ext.vdev.notify_scroll_continuous(now, vx * dt / 10, vy * dt / 10,
                Clutter.ScrollSource.CONTINUOUS, Clutter.ScrollFinishFlags.NONE);
        }
        this._indicator.update(this._ox, this._oy, vx, vy);
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
        Main.overview.disconnect(this._overviewId);
        if (this._escId) {
            global.display.disconnect(this._escId);
            global.display.ungrab_accelerator(this._escAction);
            Main.wm.allowKeybinding(this._escName, Shell.ActionMode.NONE);
        }
        this._indicator.dismiss();
        this._indicator = null;
    }
}

export default class GlideExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._loadRules();
        this._rulesId = this.settings.connect('changed::rules', () => this._loadRules());

        const seat = global.stage.context.get_backend().get_default_seat();
        this.vdev = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        this._session = null;
        this._last = null;
        this._daemonRunning = false;
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, DAEMON_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => {
                this._daemonRunning = true;
            },
            () => {
                this._daemonRunning = false;
                this.stop(false);
            });

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
    }

    disable() {
        this.stop(false);
        this._dbus.unexport();
        this._dbus = null;
        Gio.bus_unwatch_name(this._watchId);
        this.settings.disconnect(this._rulesId);
        this.settings = null;
        this.vdev = null;
        this._match = null;
    }

    _loadRules() {
        this._match = compileRules(parseRules(this.settings.get_string('rules')));
    }

    /** Resolves the mode for a window, plus why. */
    _decide(win) {
        const ids = windowIds(win);
        const title = win.get_title() ?? '';
        const rule = this._match(ids, title);
        if (rule)
            return {ids, title, mode: rule.mode, reason: rule.name || rule.match};
        if (win.is_fullscreen() && this.settings.get_boolean('fullscreen-off'))
            return {ids, title, mode: 'off', reason: 'fullscreen window'};
        return {ids, title, mode: this.settings.get_string('default-mode'), reason: 'default'};
    }

    _windowAt(x, y) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        for (let a = actor; a; a = a.get_parent()) {
            if (a instanceof Meta.WindowActor)
                return a.get_meta_window();
        }
        return null;
    }

    stop(notifyDaemon) {
        if (!this._session)
            return;
        this._session.destroy();
        this._session = null;
        if (notifyDaemon)
            this._dbus?.emit_signal('Ended', null);
    }

    // ----- D-Bus methods (called by glided) -----

    Query() {
        let decision;
        if (!this.settings.get_boolean('enabled')) {
            decision = {mode: 'off', reason: 'disabled'};
        } else if (Main.overview.visible || Main.modalCount > 0) {
            decision = {mode: 'off', reason: 'shell UI is active'};
        } else {
            const [x, y] = global.get_pointer();
            const win = this._windowAt(x, y);
            decision = win ? this._decide(win) : {mode: 'off', reason: 'not over a window'};
        }
        this._last = {...decision, at: Date.now()};
        // native and off are the same for the daemon: let the button through.
        return decision.mode;
    }

    Begin(kind) {
        this.stop(false);
        if (!this.settings.get_boolean('enabled'))
            return false;
        this._session = new Session(this, kind);
        return true;
    }

    Move(dx, dy) {
        this._session?.move(dx, dy);
    }

    Stick() {
        this._session?.stick();
    }

    End() {
        this.stop(false);
    }

    /** For the preferences window: open windows with their resolved mode, and daemon state. */
    Describe() {
        const windows = global.get_window_actors()
            .map(a => a.get_meta_window())
            .filter(w => w.get_window_type() === Meta.WindowType.NORMAL)
            .map(w => this._decide(w));
        return JSON.stringify({daemon: this._daemonRunning, last: this._last, windows});
    }
}
