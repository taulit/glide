// Shell actors for the autoscroll indicator; the drawing itself lives in paint.ts.
//
// Anchor, band and puck are separate small canvases, so a frame moves the puck and redraws
// a few hundred pixels instead of one large canvas.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
  ANCHOR_R,
  type AnchorState,
  BAND_H,
  PUCK_R,
  PUCK_SIZE,
  anchorSize,
  paintAnchor,
  paintBand,
  paintPuck,
} from './paint.js';

/** The shell turns "_" into "-" for the transition names, so ease() needs snake_case keys. */
type Ease = Parameters<Clutter.Actor['ease']>[0];

/** Speed (px/s) at which the band and the puck core are at full strength. */
const FULL_ENERGY = 4000;

export interface IndicatorOptions {
  sticky: boolean;
  deadZone: number;
}

interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where the puck may go: the monitor under the anchor, so it stays visible at the edges. */
function monitorBounds(x: number, y: number): Bounds {
  const m =
    Main.layoutManager.monitors.find(
      mon => x >= mon.x && x < mon.x + mon.width && y >= mon.y && y < mon.y + mon.height,
    ) ?? Main.layoutManager.primaryMonitor;
  const inset = PUCK_R + 2;
  if (!m) return { x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity };
  return {
    x1: m.x + inset,
    y1: m.y + inset,
    x2: m.x + m.width - inset,
    y2: m.y + m.height - inset,
  };
}

function repaintWith(
  area: St.DrawingArea,
  draw: (cr: ReturnType<St.DrawingArea['get_context']>) => void,
) {
  area.connect('repaint', () => {
    const cr = area.get_context();
    draw(cr);
    cr.$dispose();
  });
}

export class Indicator {
  private readonly group: Clutter.Actor;
  private readonly anchor: St.DrawingArea;
  private readonly band: St.DrawingArea;
  private readonly puck: St.DrawingArea;
  private readonly bounds: Bounds;
  private readonly state: AnchorState;
  private px: number;
  private py: number;
  private energy = 0;
  private puckEnergy = -1;
  private bandEnergy = -1;

  constructor(
    private readonly ax: number,
    private readonly ay: number,
    { sticky, deadZone }: IndicatorOptions,
  ) {
    this.px = ax;
    this.py = ay;
    this.bounds = monitorBounds(ax, ay);
    this.state = {
      dx: 0,
      dy: 0,
      resting: true,
      dead: deadZone,
      sticky,
      accent: [0.21, 0.52, 0.89],
    };

    this.group = new Clutter.Actor({ reactive: false, opacity: 0 });

    this.band = new St.DrawingArea({ reactive: false, visible: false, height: BAND_H });
    this.band.set_pivot_point(0, 0.5);
    this.band.set_position(ax, ay - BAND_H / 2);
    repaintWith(this.band, cr =>
      paintBand(cr, this.band.width, this.bandEnergy, this.state.accent),
    );

    const size = anchorSize(deadZone);
    this.anchor = new St.DrawingArea({
      style_class: 'glide-indicator',
      reactive: false,
      width: size,
      height: size,
      x: Math.round(ax - size / 2),
      y: Math.round(ay - size / 2),
      scale_x: 0.55,
      scale_y: 0.55,
      pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
    });
    repaintWith(this.anchor, cr => paintAnchor(cr, this.state));
    // The accent colour comes from the stylesheet (-st-accent-color).
    this.anchor.connect('style-changed', () => {
      const c = this.anchor.get_theme_node().get_foreground_color();
      this.state.accent = [c.red / 255, c.green / 255, c.blue / 255];
      this.anchor.queue_repaint();
      this.band.queue_repaint();
      this.puck.queue_repaint();
    });

    this.puck = new St.DrawingArea({
      reactive: false,
      visible: false,
      width: PUCK_SIZE,
      height: PUCK_SIZE,
    });
    repaintWith(this.puck, cr => paintPuck(cr, this.puckEnergy, this.state.accent));

    this.group.add_child(this.band);
    this.group.add_child(this.anchor);
    this.group.add_child(this.puck);
    Main.uiGroup.add_child(this.group);
    Main.uiGroup.set_child_above_sibling(this.group, null);

    this.group.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    this.anchor.ease({
      scale_x: 1,
      scale_y: 1,
      duration: 150,
      mode: Clutter.AnimationMode.EASE_OUT_BACK,
    } as unknown as Ease);
  }

  /** The actor the frame clock of the session follows. */
  get actor(): Clutter.Actor {
    return this.group;
  }

  /** Where the puck is on the stage; the cursor goes there when autoscroll ends. */
  get puckPosition(): [number, number] {
    return this.state.resting ? [this.ax, this.ay] : [this.px, this.py];
  }

  setSticky(sticky: boolean): void {
    if (this.state.sticky !== sticky) {
      this.state.sticky = sticky;
      this.anchor.queue_repaint();
    }
  }

  /** Offset of the virtual cursor and current velocity (px/s), once per frame. */
  update(ox: number, oy: number, vx: number, vy: number): void {
    const resting = Math.hypot(ox, oy) <= this.state.dead;
    const dx = Math.sign(vx);
    const dy = Math.sign(vy);
    if (resting !== this.state.resting || dx !== this.state.dx || dy !== this.state.dy) {
      Object.assign(this.state, { resting, dx, dy });
      this.anchor.queue_repaint();
    }
    this.energy = Math.min(1, Math.hypot(vx, vy) / FULL_ENERGY);

    // The puck follows the hand one to one, but stops at the edge of the monitor; the offset
    // behind it keeps growing, so pulling further still scrolls faster.
    const b = this.bounds;
    this.px = Math.min(b.x2, Math.max(b.x1, this.ax + ox));
    this.py = Math.min(b.y2, Math.max(b.y1, this.ay + oy));

    this.puck.visible = !resting;
    if (!resting) {
      this.puck.set_position(
        Math.round(this.px - PUCK_SIZE / 2),
        Math.round(this.py - PUCK_SIZE / 2),
      );
      if (Math.abs(this.energy - this.puckEnergy) > 0.03) {
        this.puckEnergy = this.energy;
        this.puck.queue_repaint();
      }
    }

    const length = Math.hypot(this.px - this.ax, this.py - this.ay);
    this.band.visible = !resting && length > ANCHOR_R;
    if (this.band.visible) {
      const width = Math.round(length);
      this.band.rotation_angle_z =
        (Math.atan2(this.py - this.ay, this.px - this.ax) * 180) / Math.PI;
      if (width !== this.band.width || Math.abs(this.energy - this.bandEnergy) > 0.03) {
        this.band.width = width;
        this.bandEnergy = this.energy;
        this.band.queue_repaint();
      }
    }
  }

  dismiss(): void {
    this.group.remove_all_transitions();
    this.group.ease({
      opacity: 0,
      duration: 120,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onStopped: () => this.group.destroy(),
    });
  }
}
