// Runway markings for the planner globe, drawn in REAL-WORLD METRES (ICAO Annex 14 proportions) and blended into the imagery.
//
// The old overlay stroked fixed-pixel casings, halos and `setLineDash` centrelines, which looked like noisy "wires" when zoomed
// out and glitched because pixel dash lengths do not scale with the map. Now:
//  * everything is positioned in a runway-local metre frame (translate + rotate + uniform scale), so dashes, piano keys, edge
//    stripes and numerals scale exactly with the ground and never alias into lines;
//  * the layer fades in smoothly only when a runway is wide enough on screen to carry markings (metres-per-pixel gate), and is
//    completely skipped (no work) beyond that;
//  * the surface is only a faint wash so the real satellite runway stays visible underneath.
import type { Runway } from '../data/airports';

/** Fully hidden at/above this ground resolution (m/px)… */
export const RUNWAY_FADE_FAR_MPP = 24;
/** …and fully visible at/below this one. */
export const RUNWAY_FADE_NEAR_MPP = 8;

export function runwayAlpha(metresPerPx: number): number {
  const t = Math.max(0, Math.min(1, (RUNWAY_FADE_FAR_MPP - metresPerPx) / (RUNWAY_FADE_FAR_MPP - RUNWAY_FADE_NEAR_MPP)));
  return t * t * (3 - 2 * t);
}

export interface RunwayDrawOptions {
  alpha: number;
  /** Selected as departure / arrival runway at this airport (outline + threshold chevron). */
  role: 'dep' | 'arr' | null;
  /** Which physical end is the selected one. */
  end: 'le' | 'he' | null;
  hovered: boolean;
}

const WHITE = (a: number) => `rgba(255,255,255,${a.toFixed(3)})`;

/** Number of threshold stripes by runway width (ICAO Annex 14 table 5-?). */
function stripeCount(widthM: number) { return widthM >= 60 ? 16 : widthM >= 45 ? 12 : widthM >= 30 ? 8 : widthM >= 23 ? 6 : 4; }

function thresholdMarks(ctx: CanvasRenderingContext2D, ident: string, w: number, k: number, a: number) {
  const wPx = w * k;
  // Piano keys: two symmetric groups about the centreline, 30 m long, starting 6 m inside the threshold.
  if (wPx >= 5) {
    const half = stripeCount(w) / 2, pitch = (w / 2 - 2.2 - 1.8) / half, keyW = Math.max(0.9, pitch * 0.52);
    ctx.fillStyle = WHITE(0.74 * a);
    for (let i = 0; i < half; i++) {
      const off = 1.8 + i * pitch;
      ctx.fillRect(6, off, 30, keyW);
      ctx.fillRect(6, -off - keyW, 30, keyW);
    }
  }
  // Designator: painted numerals (number farther down the runway, L/R/C letter closer to the threshold).
  if (wPx >= 7 && k >= 0.55) {
    const m = /^(\d{1,2})([LRC]?)$/.exec(ident);
    ctx.fillStyle = WHITE(0.82 * a);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 12px Arial, Helvetica, sans-serif';
    const draw = (txt: string, along: number) => { ctx.save(); ctx.translate(along, 0); ctx.rotate(Math.PI / 2); ctx.fillText(txt, 0, 0); ctx.restore(); };
    if (m) { if (m[2]) { draw(m[2], 47); draw(m[1], 60); } else draw(m[1], 52); } else draw(ident, 52);
  }
}

/**
 * Draws one runway between its two projected thresholds.
 * @param lengthM true ground length between the two ends (defines the px/m scale along the projected runway)
 */
export function drawRunwayMarkings(
  ctx: CanvasRenderingContext2D, rw: Runway, x1: number, y1: number, x2: number, y2: number, lengthM: number, o: RunwayDrawOptions,
): void {
  const dx = x2 - x1, dy = y2 - y1, lenPx = Math.hypot(dx, dy);
  if (lenPx < 10 || lengthM < 100 || o.alpha <= 0.01) return;
  const k = lenPx / lengthM; // px per metre
  const w = Math.max(18, Math.min(75, rw.width || 45));
  const a = o.alpha;
  ctx.save();
  ctx.translate(x1, y1); ctx.rotate(Math.atan2(dy, dx)); ctx.scale(k, k);

  // 1. Surface: only a faint wash – the real pavement in the imagery stays visible and the markings sit on it.
  ctx.fillStyle = `rgba(22,26,32,${(0.24 * a).toFixed(3)})`;
  ctx.fillRect(0, -w / 2, lengthM, w);

  // 2. Edge stripes
  if (w * k >= 4.5) {
    const e = Math.max(0.35, 0.3);
    ctx.fillStyle = WHITE(0.5 * a);
    ctx.fillRect(0, -w / 2 + 1.4, lengthM, e);
    ctx.fillRect(0, w / 2 - 1.4 - e, lengthM, e);
  }

  // 3. Centreline: 30 m dashes with 20 m gaps (explicit rectangles, no pixel-based line dash).
  const dashW = 0.9;
  if (dashW * k >= 0.3 && lengthM > 160) {
    ctx.fillStyle = WHITE(0.8 * a);
    for (let s = 75; s + 30 <= lengthM - 75; s += 50) ctx.fillRect(s, -dashW / 2, 30, dashW);
  }

  // 4. Threshold markings & designators at both ends (the far end is the same drawing rotated by 180°).
  thresholdMarks(ctx, rw.le, w, k, a);
  ctx.save(); ctx.translate(lengthM, 0); ctx.rotate(Math.PI); thresholdMarks(ctx, rw.he, w, k, a); ctx.restore();

  // 5. Selection / hover feedback: thin outline in screen pixels (line widths divided by the metre scale).
  if (o.role) {
    ctx.lineWidth = 2.2 / k;
    ctx.strokeStyle = o.role === 'dep' ? 'rgba(74,222,128,0.92)' : 'rgba(251,191,36,0.92)';
    ctx.strokeRect(-1 / k, -w / 2 - 1.8 / k, lengthM + 2 / k, w + 3.6 / k);
    if (o.end && lenPx >= 30) {
      // Chevron on the selected threshold pointing in the direction of use.
      const le = o.end === 'le', x0 = le ? 0 : lengthM, dir = le ? 1 : -1, u = 1 / k;
      ctx.beginPath();
      ctx.moveTo(x0 + dir * 24 * u, 0); ctx.lineTo(x0 + dir * 9 * u, -7 * u); ctx.lineTo(x0 + dir * 9 * u, 7 * u); ctx.closePath();
      ctx.fillStyle = o.role === 'dep' ? '#22c55e' : '#f59e0b'; ctx.fill();
      ctx.lineWidth = 1.1 * u; ctx.strokeStyle = 'rgba(11,18,32,0.9)'; ctx.stroke();
    }
  }
  if (o.hovered) {
    ctx.lineWidth = 1.6 / k; ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.strokeRect(-1 / k, -w / 2 - 1.2 / k, lengthM + 2 / k, w + 2.4 / k);
  }
  ctx.restore();
}
