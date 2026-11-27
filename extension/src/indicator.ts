// Shell actor for the autoscroll indicator; the drawing itself lives in paint.ts.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { type IndicatorState, SIZE, paint } from './paint.js';

/** The shell turns "_" into "-" for the transition names, so ease() needs snake_case keys. */
type Ease = Parameters<St.DrawingArea['ease']>[0];

export interface IndicatorOptions {
  sticky: boolean;
  deadZone: number;
}

export const Indicator = GObject.registerClass(
  class GlideIndicator extends St.DrawingArea {
    private state: IndicatorState;

    constructor(x: number, y: number, { sticky, deadZone }: IndicatorOptions) {
      super({
        style_class: 'glide-indicator',
        reactive: false,
        width: SIZE,
        height: SIZE,
        x: Math.round(x - SIZE / 2),
        y: Math.round(y - SIZE / 2),
        opacity: 0,
        scale_x: 0.55,
        scale_y: 0.55,
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
      });
      this.state = {
        ox: 0,
        oy: 0,
        vx: 0,
        vy: 0,
        dead: deadZone,
        sticky,
        accent: [0.21, 0.52, 0.89],
      };

      Main.uiGroup.add_child(this);
      Main.uiGroup.set_child_above_sibling(this, null);
      this.ease({
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
        duration: 150,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
      } as unknown as Ease);
    }

    override vfunc_style_changed(): void {
      super.vfunc_style_changed();
      const c = this.get_theme_node().get_foreground_color();
      // style-changed can fire from the parent constructor, before the state exists.
      if (this.state) this.state.accent = [c.red / 255, c.green / 255, c.blue / 255];
    }

    setSticky(sticky: boolean): void {
      if (this.state.sticky !== sticky) {
        this.state.sticky = sticky;
        this.queue_repaint();
      }
    }

    /** Offset of the virtual cursor and current velocity (px/s), once per frame. */
    update(ox: number, oy: number, vx: number, vy: number): void {
      Object.assign(this.state, { ox, oy, vx, vy });
      this.queue_repaint();
    }

    dismiss(): void {
      this.remove_all_transitions();
      this.ease({
        opacity: 0,
        scale_x: 0.7,
        scale_y: 0.7,
        duration: 120,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onStopped: () => this.destroy(),
      } as unknown as Ease);
    }

    override vfunc_repaint(): void {
      const cr = this.get_context();
      paint(cr, this.state);
      cr.$dispose();
    }
  },
);

export type Indicator = InstanceType<typeof Indicator>;
