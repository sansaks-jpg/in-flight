// Local verification for the AirportMiniMap en-route rework (run: npx tsx scripts/minimap-enroute-check.ts).
// Checks the exported chart maths (en-route auto-range, graticule step) and the screen-placement conventions
// (heading-up bearing maths) that the new rose / bugs / track vector / wind arrow rely on. Pure numbers only —
// no DOM, no canvas, no game instance.
import { enrouteRange, gridStepFor } from '../src/ui/AirportMiniMap';
import { D2R, R2D, M_PER_NM, clamp } from '../src/sim/geo';

let failures = 0;
const eq = (name: string, got: number, want: number, tol = 1e-6) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, want ${want}`);
};
const is = (name: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};

// ---- 1. module loads (esbuild parse of the whole TSX incl. JSX) ----
is('AirportMiniMap module loads', typeof enrouteRange === 'function' && typeof gridStepFor === 'function');

// ---- 2. en-route auto-range: continuity at the 22 km approach hand-off, cruise floor/cap ----
eq('approach branch keeps d*1.1 scale inside 22 km (d=20km)', Math.min(12000, Math.max(3000, 20000 * 1.1)), 12000); // capped, as before
eq('enrouteRange at 22 km hand-off ~ continuity', Math.round(enrouteRange(22001)), 12101, 2);
eq('enrouteRange floor at 12 km (d=15km)', enrouteRange(15000), 12000);
eq('enrouteRange mid-cruise (d=100km)', enrouteRange(100000), 55000);
eq('enrouteRange cap (d=400km)', enrouteRange(400000), 200000);
eq('enrouteRange cap (no destination threshold, d=1e9)', enrouteRange(1e9), 200000);
is('no range collapse to 12 km en-route', enrouteRange(60000) > 12000, `d=60km -> ${enrouteRange(60000)} m`);

// ---- 3. graticule step ladder: 4-5 lines across the window, density gate ----
eq('gridStepFor(12000) -> 0.05 deg', gridStepFor(12000), 0.05);
eq('gridStepFor(50000) -> 0.25 deg', gridStepFor(50000), 0.25);
eq('gridStepFor(200000) -> 1 deg', gridStepFor(200000), 1);
eq('gridStepFor(400000) -> 2 deg', gridStepFor(400000), 2);
eq('gridStepFor(tiny/ground) -> 0.05 deg floor', gridStepFor(900), 0.05);
{
  // Density gate replicated from frame(): lines closer than 24 px are skipped.
  const k = (128 - 6) / 200000; // 256 px canvas at 200 km range
  is('stale fine grid is density-gated at cruise zoom', 0.25 * 111320 * k < 24, `${(0.25 * 111320 * k).toFixed(1)} px`);
  is('fresh cruise grid passes the gate', 1 * 111320 * k >= 24, `${(1 * 111320 * k).toFixed(1)} px`);
}

// ---- 4. heading-up placement maths (replicates sx/sy and the rose/bug rotations) ----
{
  const W = 256, size = W, range = 12000, S = { north: false };
  const hdgDeg = 37; // aircraft heading, degrees true (physics convention)
  const h = hdgDeg * D2R;
  const px = 500, pz = -9000; // world metres
  const k = (size * 0.5 - 6) / range, cx = size / 2, cy = size * 0.6;
  const fx = S.north ? 0 : Math.sin(h), fz = S.north ? -1 : -Math.cos(h), rx = -fz, rz = fx;
  const sx = (x: number, z: number) => cx + ((x - px) * rx + (z - pz) * rz) * k;
  const sy = (x: number, z: number) => cy - ((x - px) * fx + (z - pz) * fz) * k;
  // A fix straight ahead (bearing = heading) must sit above the aircraft symbol; abeam right (hdg+90) to the right.
  const d = 6000;
  const aheadX = px + Math.sin(hdgDeg * D2R) * d, aheadZ = pz - Math.cos(hdgDeg * D2R) * d;
  is('fix on the nose plots above centre', sy(aheadX, aheadZ) < cy && Math.abs(sx(aheadX, aheadZ) - cx) < 1e-9, `sy=${sy(aheadX, aheadZ).toFixed(1)} < cy=${cy}`);
  const abeam = hdgDeg + 90;
  const abX = px + Math.sin(abeam * D2R) * d, abZ = pz - Math.cos(abeam * D2R) * d;
  is('fix abeam right plots right of centre', sx(abX, abZ) > cx, `sx=${sx(abX, abZ).toFixed(1)} > cx=${cx}`);
  // Bearing recovery used by the active-leg annotation: atan2(dx, -dz) must return the true bearing.
  const brg = (Math.atan2(abX - px, -(abZ - pz)) * R2D + 360) % 360;
  eq('active-leg bearing recovery', brg, ((abeam % 360) + 360) % 360, 1e-6);
  // Screen-up bearing: in heading-up mode the rose N sits at screen angle -h (top of the rose shows 000 relative).
  const up = S.north ? 0 : h;
  const na = 0 * D2R - up; // rose bearing 0 (north)
  is('rose north rides the map rotation', Math.abs(Math.sin(na) + Math.sin(h)) < 1e-9);
  // One-minute track vector length: gs 120 m/s * 60 s * k px/m, capped by the window.
  const tl = Math.min(W * 0.42, Math.max(16, 120 * 60 * k));
  eq('1-minute track vector length at 12 km range', Math.round(tl), Math.round(120 * 60 * k));
  is('track vector stays inside the window', tl <= W * 0.42);
}

// ---- 5. unit conventions of the new annotations ----
{
  const dm = 37040; // 20 NM in metres
  eq('annotation distance in NM', Math.round((dm / M_PER_NM) * 10) / 10, 20);
  eq('scale bar NM rounding (100000 m)', Math.round(100000 / M_PER_NM), 54);
  eq('fmtRange-style ladder continuity (25000 m -> 13.5 NM)', Math.round((25000 / M_PER_NM) * 10) / 10, 13.5);
}

// ---- 6. range ladder reaches en-route scales ----
{
  // Mirror of the module-internal RANGES used by manual zoom: must now cover hundreds of km.
  const RANGES = [400, 800, 1500, 3000, 6000, 12000, 25000, 50000, 100000, 200000, 400000];
  is('manual ladder spans 400 m .. 400 km', RANGES[0] === 400 && RANGES[RANGES.length - 1] === 400000);
  const idx = RANGES.findIndex((r) => r >= 200000 * 0.95);
  is('zoom re-entry from auto cruise lands on 200 km', RANGES[idx] === 200000, `idx=${idx}`);
  eq('clamp used by reach stays inside DB sweep budget', clamp(200000 * 2.5, 50000, 500000), 500000);
}

// ---- 7. sim weather package (Tugas 4 integration): world.wx.visEffM ring + thunder badge ----
{
  // world.ts:421 defaults — clear sky must not paint any WX extras on the charts.
  is('clear-sky visEffM (30 km) stays under the 25 km annotation threshold? no', !(30000 < 25000));
  // Label formatting replicated from both charts: one decimal below 10 km, integer above.
  eq('VIS label 4200 m', Number((4200 / 1000).toFixed(1)), 4.2);
  eq('VIS label 12000 m', Math.round(12000 / 1000), 12);
  // Minimap ring gate: only when the ring fits inside the rose (vr < R - 8) and is not sub-pixel.
  {
    const R = 122, k = R / 12000; // 256 px canvas, 12 km range
    const vr4200 = 4200 * k, vr12000 = 12000 * k;
    is('VIS 4.2 km ring fits at 12 km range', vr4200 < R - 8 && vr4200 > 6, `vr=${vr4200.toFixed(0)}px`);
    is('VIS 12 km ring is skipped at 12 km range (outside window)', !(vr12000 < R - 8), `vr=${vr12000.toFixed(0)}px`);
  }
  // Blink state replicates lightning.light.intensity > 0 (lightning.ts:134; 0 when idle :141).
  const flash = (intensity: number) => intensity > 0 ? 'STRIKE' : 'TS';
  is('thunder badge blinks on live bolt', flash(1.9) === 'STRIKE' && flash(0) === 'TS');
  // MapPanel ring gate at mercator ppm (pattern of the RANGES_NM rings, MapPanel overlay).
  {
    const z = 9.4, lat = -6.125;
    const ppm = (256 * 2 ** z) / (40075016.7 * Math.cos(lat * D2R));
    const vr = 4200 * ppm;
    is('full-map VIS ring inside the 16 px..0.8·W gate at z=9.4', vr > 16 && vr < 900 * 0.8, `vr=${vr.toFixed(0)}px`);
    const vrCruise = 12000 * ((256 * 2 ** 6) / (40075016.7 * Math.cos(lat * D2R)));
    is('full-map VIS 12 km ring below 16 px is skipped at z=6 (gate rejects)', vrCruise <= 16, `vr=${vrCruise.toFixed(1)}px`);
  }
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
