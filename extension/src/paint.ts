// Pure cairo drawing of the autoscroll indicator (no shell imports, so it can be rendered
// offline with plain gjs for previews):
// a small ink anchor with a white rim (matching Bibata-style cursors), four chevrons that
// light up in the scroll direction, and a "puck" on a rubber band that stands in for the
// hidden cursor and shows how far – and so how fast – you pushed.

import type cairo from 'cairo';

export const ANCHOR_R = 18;
export const PUCK_R = 6.5;
/** Max visual distance of the puck from the anchor. */
export const REACH = 96;
export const SIZE = 2 * (REACH + PUCK_R + 10);

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];
const INK: Rgb = [0.07, 0.07, 0.08];

export interface IndicatorState {
  /** Offset of the virtual cursor from the anchor, px. */
  ox: number;
  oy: number;
  /** Current scroll velocity, px/s. */
  vx: number;
  vy: number;
  /** Dead zone radius, px. */
  dead: number;
  /** Click-to-scroll mode. */
  sticky: boolean;
  accent: Rgb;
}

function rgba(cr: cairo.Context, [r, g, b]: Rgb, a: number) {
  cr.setSourceRGBA(r, g, b, a);
}

function circle(cr: cairo.Context, x: number, y: number, r: number) {
  cr.newSubPath();
  cr.arc(x, y, r, 0, 2 * Math.PI);
}

/** Draws on a SIZE×SIZE (logical px) context with the anchor in the centre. */
export function paint(cr: cairo.Context, s: IndicatorState): void {
  const c = SIZE / 2;
  const accent = s.accent;

  // Where the puck is drawn: soft-clamped so it never leaves the canvas.
  const dist = Math.hypot(s.ox, s.oy);
  const shown = REACH * Math.tanh(dist / REACH);
  const k = dist > 0 ? shown / dist : 0;
  const px = c + s.ox * k;
  const py = c + s.oy * k;
  const outside = dist > s.dead;
  const energy = Math.min(1, Math.hypot(s.vx, s.vy) / 2500);

  cr.setLineCap(1); // ROUND
  cr.setLineJoin(1);

  // Dead zone hint while the puck rests near the anchor.
  if (!outside) {
    circle(cr, c, c, Math.max(s.dead, ANCHOR_R + 3) + 4);
    rgba(cr, WHITE, 0.22);
    cr.setLineWidth(1);
    cr.stroke();
  }

  // Rubber band from anchor to puck, tapering towards the puck.
  if (outside && shown > ANCHOR_R) {
    const ux = (px - c) / shown;
    const uy = (py - c) / shown;
    const nx = -uy;
    const ny = ux;
    const w0 = 4.2;
    const w1 = 1.4;
    cr.moveTo(c + nx * w0, c + ny * w0);
    cr.lineTo(px + nx * w1, py + ny * w1);
    cr.lineTo(px - nx * w1, py - ny * w1);
    cr.lineTo(c - nx * w0, c - ny * w0);
    cr.closePath();
    rgba(cr, accent, 0.5 + 0.4 * energy);
    cr.fill();
  }

  // Anchor: soft shadow, ink body, white rim.
  for (let i = 4; i >= 1; i--) {
    circle(cr, c, c + 1.5, ANCHOR_R + i * 1.6);
    rgba(cr, BLACK, 0.05);
    cr.fill();
  }
  circle(cr, c, c, ANCHOR_R);
  rgba(cr, INK, 0.92);
  cr.fillPreserve();
  rgba(cr, WHITE, 0.95);
  cr.setLineWidth(2);
  cr.stroke();

  // Sticky (click-to-scroll) mode gets an accent halo: "locked on".
  if (s.sticky) {
    circle(cr, c, c, ANCHOR_R + 4.5);
    rgba(cr, accent, 0.95);
    cr.setLineWidth(2);
    cr.stroke();
  }

  // Chevrons: dim at rest, the active directions light up and lean outwards.
  const dirs: [number, number, boolean][] = [
    [0, -1, s.vy < 0],
    [0, 1, s.vy > 0],
    [-1, 0, s.vx < 0],
    [1, 0, s.vx > 0],
  ];
  for (const [dx, dy, on] of dirs) {
    const r = on ? 11.5 : 10;
    const tipX = c + dx * r;
    const tipY = c + dy * r;
    const bx = tipX - dx * 3.6;
    const by = tipY - dy * 3.6;
    const sx = dy * 3.8;
    const sy = dx * 3.8;
    cr.moveTo(bx + sx, by + sy);
    cr.lineTo(tipX, tipY);
    cr.lineTo(bx - sx, by - sy);
    rgba(cr, on ? accent : WHITE, on ? 1 : 0.6);
    cr.setLineWidth(on ? 2.4 : 1.8);
    cr.stroke();
  }
  circle(cr, c, c, 1.7);
  rgba(cr, WHITE, 0.95);
  cr.fill();

  // Puck: a tiny cursor-like dot, accent core growing with speed.
  if (outside) {
    circle(cr, px, py + 1, PUCK_R + 1.5);
    rgba(cr, BLACK, 0.18);
    cr.fill();
    circle(cr, px, py, PUCK_R);
    rgba(cr, INK, 0.95);
    cr.fillPreserve();
    rgba(cr, WHITE, 1);
    cr.setLineWidth(1.8);
    cr.stroke();
    circle(cr, px, py, 2.2 + 1.3 * energy);
    rgba(cr, accent, 1);
    cr.fill();
  }
}
