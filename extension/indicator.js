// Shell actor for the autoscroll indicator; the drawing itself lives in paint.js.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SIZE, paint} from './paint.js';

export const Indicator = GObject.registerClass(
class GlideIndicator extends St.DrawingArea {
    _init(x, y, {sticky, deadZone}) {
        super._init({
            style_class: 'glide-indicator',
            reactive: false,
            width: SIZE,
            height: SIZE,
            x: Math.round(x - SIZE / 2),
            y: Math.round(y - SIZE / 2),
            opacity: 0,
            scale_x: 0.55,
            scale_y: 0.55,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._state = {ox: 0, oy: 0, vx: 0, vy: 0, dead: deadZone, sticky, accent: [0.21, 0.52, 0.89]};

        Main.uiGroup.add_child(this);
        Main.uiGroup.set_child_above_sibling(this, null);
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        const c = this.get_theme_node().get_foreground_color();
        this._state.accent = [c.red / 255, c.green / 255, c.blue / 255];
    }

    setSticky(sticky) {
        if (this._state.sticky !== sticky) {
            this._state.sticky = sticky;
            this.queue_repaint();
        }
    }

    /** Offset of the virtual cursor and current velocity (px/s), once per frame. */
    update(ox, oy, vx, vy) {
        Object.assign(this._state, {ox, oy, vx, vy});
        this.queue_repaint();
    }

    dismiss() {
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            scale_x: 0.7,
            scale_y: 0.7,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    vfunc_repaint() {
        const cr = this.get_context();
        paint(cr, this._state);
        cr.$dispose();
    }
});
