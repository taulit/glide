// Pure cairo drawing of the autoscroll indicator (no shell imports, so it can be rendered
// offline with plain gjs for previews). Three parts, each on its own small canvas:
// - the anchor: an ink disc with a white rim (matching Bibata-style cursors) and four chevrons
//   that light up in the scroll direction,
// - the band: a tapered rubber band from the anchor to the puck,
// - the puck: a small cursor-like dot that stands in for the hidden cursor; the cursor comes
//   back where the puck is when autoscroll ends.

import type cairo from 'cairo';

export const ANCHOR_R = 18;
export const PUCK_R = 6.5;
/** Height of the band canvas; the band itself tapers from 8.4 to 2.8 px. */
export const BAND_H = 10;

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];
const INK: Rgb = [0.07, 0.07, 0.08];

export interface AnchorState {
  /** Scroll direction per axis: -1, 0 or 1. */
  dx: number;
  dy: number;
  /** The puck is inside the dead zone. */
  resting: boolean;
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

/** Radius of the dead zone hint ring. */
function deadRing(dead: number) {
  return Math.max(dead, ANCHOR_R + 3) + 4;
}

/** Side of the square anchor canvas. */
export function anchorSize(dead: number): number {
  return 2 * Math.ceil(deadRing(dead) + 6);
}

/** Side of the square puck canvas. */
export const PUCK_SIZE = 2 * Math.ceil(PUCK_R + 6);

/** Draws the anchor centred on an anchorSize(s.dead) square. */
export function paintAnchor(cr: cairo.Context, s: AnchorState): void {
  const c = anchorSize(s.dead) / 2;
  cr.setLineCap(1); // ROUND
  cr.setLineJoin(1);

  // Dead zone hint while the puck rests near the anchor.
  if (s.resting) {
    circle(cr, c, c, deadRing(s.dead));
    rgba(cr, WHITE, 0.22);
    cr.setLineWidth(1);
    cr.stroke();
  }

  // Soft shadow, ink body, white rim.
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
    rgba(cr, s.accent, 0.95);
    cr.setLineWidth(2);
    cr.stroke();
  }

  // Chevrons: dim at rest, the active directions light up and lean outwards.
  const dirs: [number, number, boolean][] = [
    [0, -1, s.dy < 0],
    [0, 1, s.dy > 0],
    [-1, 0, s.dx < 0],
    [1, 0, s.dx > 0],
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
    rgba(cr, on ? s.accent : WHITE, on ? 1 : 0.6);
    cr.setLineWidth(on ? 2.4 : 1.8);
    cr.stroke();
  }
  circle(cr, c, c, 1.7);
  rgba(cr, WHITE, 0.95);
  cr.fill();
}

/**
 * Draws the band on a length×BAND_H canvas, from the anchor (x = 0) to the puck
 * (x = length). `energy` is 0…1 with the scroll speed.
 */
export function paintBand(cr: cairo.Context, length: number, energy: number, accent: Rgb): void {
  const m = BAND_H / 2;
  cr.moveTo(0, m - 4.2);
  cr.lineTo(length, m - 1.4);
  cr.lineTo(length, m + 1.4);
  cr.lineTo(0, m + 4.2);
  cr.closePath();
  rgba(cr, accent, 0.5 + 0.4 * energy);
  cr.fill();
}

/** Draws the puck centred on a PUCK_SIZE square; its accent core grows with `energy`. */
export function paintPuck(cr: cairo.Context, energy: number, accent: Rgb): void {
  const c = PUCK_SIZE / 2;
  circle(cr, c, c + 1, PUCK_R + 1.5);
  rgba(cr, BLACK, 0.18);
  cr.fill();
  circle(cr, c, c, PUCK_R);
  rgba(cr, INK, 0.95);
  cr.fillPreserve();
  rgba(cr, WHITE, 1);
  cr.setLineWidth(1.8);
  cr.stroke();
  circle(cr, c, c, 2.2 + 1.3 * energy);
  rgba(cr, accent, 1);
  cr.fill();
}
