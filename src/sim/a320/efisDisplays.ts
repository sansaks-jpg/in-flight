// A320 PFD and ND renderers (one canvas each, 1000 x 1000 virtual units).
// Layout, colours and symbology follow the real Airbus A320 displays (FCOM 1.31 / reference photographs): grey-blue speed and altitude tapes,
// trimmed circular horizon, horizontal heading strip, 5-column FMA, ARC / ROSE / PLAN navigation display with magnetic compass,
// GS/TAS + wind block, TO-waypoint block, ADF/VOR bearing pointers and the magenta optional-data layer.
// Both renderers take the EFIS side (0 = CAPT, 1 = F/O): FD, LS, baro, ND mode/range, option button and ADF/VOR switches are per side.
import type { Ctx } from './displays';
import { ND_RANGES } from './systems';
import { atmosphere } from '../physics';
import { NAVAIDS, airportsNear } from '../../data/airports';

type G = CanvasRenderingContext2D;
const F = 'Arial, Helvetica, sans-serif';
const COL = { green: '#27ff3c', cyan: '#44d4ff', amber: '#ffb000', red: '#ff3030', white: '#f6f6f6', mag: '#ff5cf0', yellow: '#ffd800', sky: '#00aedd', gnd: '#b78d27', tape: '#8aa0ab' };
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');
const wrap180 = (a: number) => ((a % 360) + 540) % 360 - 180;
function T(g: G, s: string | number, x: number, y: number, px: number, col: string = COL.white, al: CanvasTextAlign = 'center') { g.font = `bold ${px}px ${F}`; g.fillStyle = col; g.textAlign = al; g.textBaseline = 'middle'; g.fillText(String(s), x, y); }
function L(g: G, x1: number, y1: number, x2: number, y2: number, col: string, w = 3) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }

/** Stall reference speeds (kt IAS) for the current configuration and weight: Vs1g, VLS, Vα-prot. */
export function speeds(h: Ctx['host']) {
  const fm = h.fm, s = fm.spec, rho0 = 1.225, fl = fm.flapsPos;
  const clmax = s.CLmax + s.flapCL * fl * 1.05, vs1g = Math.sqrt(2 * fm.totalMass * 9.80665 / (rho0 * s.S * clmax)) / 0.514444;
  return { vs1g, vls: vs1g * 1.23, vaprot: vs1g * 1.08, vsw: vs1g * 1.03, green: vs1g * 1.6, vfe: s.vfe[Math.min(s.vfe.length - 1, Math.max(0, Math.ceil(fl * s.flapDetents - 1e-6)))] };
}

/** Baro reference text as shown on the PFD / EFIS window. */
export function baroText(e: { std: boolean; unitInHg: boolean; hpa: number; inHg: number }) { return e.std ? 'STD' : e.unitInHg ? (e.inHg / 100).toFixed(2) : String(Math.round(e.hpa)); }

// speed-trend memory per side (kt/s, low-pass filtered)
const trend = [{ k: 0, t: -1, v: 0 }, { k: 0, t: -1, v: 0 }];
const thrName = (t: number) => (t > 0.97 ? 'TOGA' : t > 0.82 ? 'FLX/MCT' : t > 0.6 ? 'CL' : t < 0.05 ? 'IDLE' : '');

// =============================================================== PFD
export function drawPFD(g: G, W: number, H: number, c: Ctx, side: 0 | 1 = 0) {
  const d = c.d, sys = c.sys, h = c.host, fm = h.fm, ef = sys.efis[side];
  g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
  if (!sys.dc) return;
  const sp = speeds(h), cx = 470, cy = 500, PX = 12.6;
  const alt = sys.indicatedAlt(side, d.altFt), corr = alt - d.altFt;
  // ---- attitude sphere (circle trimmed by two vertical edges) ----
  g.save(); g.beginPath(); g.rect(cx - 246, 150, 492, 700); g.clip(); g.beginPath(); g.arc(cx, cy, 288, 0, 7); g.clip();
  g.translate(cx, cy); g.rotate(-d.bank); // bank + = right wing down -> the horizon turns counter-clockwise
  const hy = d.pitch * PX;
  g.fillStyle = COL.sky; g.fillRect(-500, -900 + hy, 1000, 900); g.fillStyle = COL.gnd; g.fillRect(-500, hy, 1000, 900);
  L(g, -500, hy, 500, hy, '#fff', 4);
  for (let p = -30; p <= 30; p += 2.5) {
    if (!p) continue; const y = hy - p * PX, ten = p % 10 === 0, five = p % 5 === 0; const w = ten ? 66 : five ? 36 : 18;
    L(g, -w, y, w, y, '#fff', 3); if (ten) { T(g, Math.abs(p), -w - 34, y, 30, '#fff'); T(g, Math.abs(p), w + 34, y, 30, '#fff'); }
  }
  g.restore();
  // attitude-limit brackets (fixed, white)
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) { const x = cx + sx * 200, y = cy + sy * 135; g.moveTo(x - sx * 62, y); g.lineTo(x, y); g.lineTo(x, y - sy * 36); }
  g.stroke();
  // roll scale (fixed) + sky pointer / slip (moves with the horizon)
  g.save(); g.translate(cx, cy);
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) { const long = a % 30 === 0, l = long ? 34 : 20, r = 290, rad = a * D2R; L(g, Math.sin(rad) * r, -Math.cos(rad) * r, Math.sin(rad) * (r + l), -Math.cos(rad) * (r + l), '#fff', 4); }
  g.fillStyle = '#000'; g.strokeStyle = COL.yellow; g.lineWidth = 4; g.beginPath(); g.moveTo(0, -292); g.lineTo(-17, -322); g.lineTo(17, -322); g.closePath(); g.stroke(); // fixed index
  g.rotate(-d.bank); g.beginPath(); g.moveTo(0, -284); g.lineTo(-24, -240); g.lineTo(24, -240); g.closePath(); g.stroke();
  const sl = Math.max(-1, Math.min(1, d.slip * 6)); g.strokeRect(-26 + sl * 30, -232, 52, 14); g.restore();
  // ---- flight director (per side FD button) ----
  if (ef.fd) {
    const dh = wrap180(d.apHdg - d.hdg), rollCmd = Math.max(-25, Math.min(25, dh * 1.2)), pitchCmd = Math.max(-10, Math.min(15, (d.apAlt - d.altFt) / 150));
    g.save(); g.translate(cx, cy);
    const by = Math.max(-150, Math.min(150, (d.pitch - pitchCmd) * PX)); L(g, -110, by, 110, by, COL.green, 8);
    const bx = Math.max(-150, Math.min(150, (rollCmd + d.bank * R2D) * 4)); L(g, bx, -110, bx, 110, COL.green, 8); g.restore();
  }
  // aircraft symbol (fixed, yellow with black core)
  g.fillStyle = '#000'; g.strokeStyle = COL.yellow; g.lineWidth = 6;
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * 245, cy - 14); g.lineTo(cx + s * 100, cy - 14); g.lineTo(cx + s * 100, cy + 38); g.lineTo(cx + s * 128, cy + 38); g.lineTo(cx + s * 128, cy + 14); g.lineTo(cx + s * 245, cy + 14); g.closePath(); g.fill(); g.stroke(); }
  g.strokeRect(cx - 7, cy - 7, 14, 14);
  // ---- FMA (5 columns) ----
  g.strokeStyle = '#51606b'; g.lineWidth = 4; for (const x of [281, 449, 616, 778]) { g.beginPath(); g.moveTo(x, 44); g.lineTo(x, 150); g.stroke(); }
  const detent = thrName(d.throttle), airborne = !fm.wow, engaged = d.apOn || ef.fd;
  const toRoll = (d.flightPhase === 'takeoff' || (fm.wow && d.throttle > 0.8)) && engaged;
  const altErr = d.apAlt - d.altFt, lsCap = d.apAppr && !!d.ils?.valid;
  const vMode = !engaged ? '' : toRoll ? 'SRS' : lsCap ? 'G/S' : Math.abs(altErr) < 120 ? 'ALT' : sys.vsMode ? 'V/S' : altErr > 0 ? 'OP CLB' : 'OP DES';
  const lMode = !engaged ? '' : toRoll ? 'RWY' : lsCap ? 'LOC' : d.apNav ? 'NAV' : 'HDG';
  const vArm = !engaged ? '' : toRoll ? 'CLB' : d.apAppr && !lsCap ? 'G/S' : '';
  const lArm = !engaged ? '' : toRoll && h.route().length ? 'NAV' : d.apAppr && !lsCap ? 'LOC' : '';
  // column 1 – thrust
  const manual = airborne ? !d.apOn : detent === 'TOGA' || detent === 'FLX/MCT';
  const thrTxt = fm.wow && detent === 'TOGA' ? 'MAN TOGA' : fm.wow && detent === 'FLX/MCT' ? `MAN FLX +${c.mcdu.store.flex}` : manual ? (detent === 'CL' ? 'THR CLB' : d.throttle > 0.85 && airborne ? 'MAN THR' : '') : sys.spdMach ? 'MACH' : 'SPEED';
  if (thrTxt) {
    if (/^MAN/.test(thrTxt)) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(70, 52, 200, 66); const p = thrTxt.split(' '); T(g, p.slice(0, 2).join(' '), 170, 72, 30, '#fff'); T(g, p.slice(2).join(' '), 170, 104, 30, '#fff'); }
    else T(g, thrTxt, 170, 70, 32, COL.green);
  }
  // columns 2 / 3 – vertical and lateral modes (engaged green, armed cyan)
  if (vMode) { if (toRoll) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(300, 52, 134, 40); } T(g, vMode, 365, 72, 34, COL.green); } if (vArm) T(g, vArm, 365, 116, 34, COL.cyan);
  if (lMode) { if (toRoll) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(466, 52, 134, 40); } T(g, lMode, 533, 72, 34, COL.green); } if (lArm) T(g, lArm, 533, 116, 34, COL.cyan);
  if (lsCap) T(g, 'CAT1', 697, 72, 32, COL.white);
  // column 5 – AP / FD / A-THR engagement (FD annunciation shows both sides)
  const fdTxt = sys.efis[0].fd || sys.efis[1].fd ? `${sys.efis[0].fd ? '1' : '-'}FD${sys.efis[1].fd ? '2' : '-'}` : '';
  T(g, d.apOn ? 'AP1' : '', 890, 62, 32, COL.white); T(g, fdTxt, 890, 100, 32, COL.white);
  if (d.apOn || sys.athrArmed) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(808, 118, 164, 38); T(g, 'A/THR', 890, 138, 30, d.apOn ? COL.white : COL.cyan); }
  // ---- speed tape ----
  const k = Math.max(30, d.kias), ppk = 5.3, yOf = (v: number) => 500 - (v - k) * ppk;
  g.save(); g.beginPath(); g.rect(50, 255, 110, 490); g.clip(); g.fillStyle = COL.tape; g.fillRect(50, 255, 110, 490);
  for (let v = Math.max(30, Math.floor((k - 50) / 10) * 10); v <= k + 50; v += 10) { const y = yOf(v); L(g, 118, y, 160, y, '#fff', 3); if (v % 20 === 0) T(g, pad(v, 3), 78, y, 36, '#fff'); }
  const vmax = Math.min(sp.vfe < 900 ? sp.vfe : 350, 350);
  for (let y = yOf(vmax + 60); y < yOf(vmax); y += 20) { g.fillStyle = '#d00'; g.fillRect(146, y, 14, Math.min(10, yOf(vmax) - y)); }
  g.fillStyle = COL.amber; g.fillRect(150, yOf(sp.vls), 8, yOf(sp.vaprot) - yOf(sp.vls));
  for (let y = yOf(sp.vaprot); y < yOf(sp.vsw); y += 16) { g.fillStyle = COL.amber; g.fillRect(150, y, 8, 8); }
  g.fillStyle = COL.red; g.fillRect(150, yOf(sp.vsw), 10, yOf(sp.vsw - 70) - yOf(sp.vsw));
  if (fm.flapsPos < 0.05) { g.strokeStyle = COL.green; g.lineWidth = 4; g.beginPath(); g.arc(136, yOf(sp.green), 9, 0, 7); g.stroke(); }
  const bugCol = sys.spdManaged ? COL.mag : COL.cyan, by = Math.max(262, Math.min(738, yOf(d.apSpd)));
  g.strokeStyle = bugCol; g.lineWidth = 5; g.beginPath(); g.moveTo(160, by); g.lineTo(138, by - 14); g.lineTo(138, by + 14); g.closePath(); g.stroke();
  const tr = trend[side]; if (tr.t < 0 || c.t < tr.t || c.t - tr.t > 1) { tr.k = d.kias; tr.t = c.t; tr.v = 0; } else if (c.t - tr.t > 0.05) { tr.v += ((d.kias - tr.k) / (c.t - tr.t) - tr.v) * 0.15; tr.k = d.kias; tr.t = c.t; }
  const tv = Math.max(-40, Math.min(40, tr.v * 10));
  if (Math.abs(tv) > 2) { const ty = 500 - tv * ppk, sg = tv > 0 ? 1 : -1; L(g, 150, 500, 150, ty, COL.yellow, 5); g.fillStyle = COL.yellow; g.beginPath(); g.moveTo(150, ty - sg * 2); g.lineTo(140, ty + sg * 14); g.lineTo(160, ty + sg * 14); g.closePath(); g.fill(); }
  g.restore();
  g.fillStyle = COL.yellow; g.beginPath(); g.moveTo(150, 500); g.lineTo(184, 484); g.lineTo(184, 516); g.closePath(); g.fill(); L(g, 160, 500, 50, 500, COL.yellow, 5);
  L(g, 50, 250, 160, 250, '#fff', 3); T(g, pad(d.apSpd, 3), 105, 224, 40, bugCol);
  if (d.mach > 0.5) T(g, `.${pad(d.mach * 100, 2)}`, 105, 775, 36, COL.green);
  // ---- altitude tape ----
  const ppf = 0.5, yA = (v: number) => 500 - (v - alt) * ppf;
  g.save(); g.beginPath(); g.rect(740, 255, 96, 490); g.clip(); g.fillStyle = COL.tape; g.fillRect(740, 255, 96, 490);
  for (let v = Math.floor((alt - 520) / 100) * 100; v <= alt + 520; v += 100) { const y = yA(v); L(g, 740, y, v % 500 === 0 ? 790 : 770, y, '#fff', 3); if (v % 200 === 0) T(g, (v < 0 ? '-' : '') + pad(Math.abs(v) / 100, 3), 790, y, 36, '#fff', 'left'); }
  const bugA = Math.max(262, Math.min(738, yA(d.apAlt + corr))); g.strokeStyle = COL.cyan; g.lineWidth = 5; g.beginPath(); g.moveTo(740, bugA); g.lineTo(770, bugA - 18); g.lineTo(770, bugA + 18); g.closePath(); g.stroke();
  g.restore();
  g.fillStyle = '#000'; g.fillRect(826, 452, 118, 96); g.strokeStyle = COL.yellow; g.lineWidth = 4; g.strokeRect(826, 452, 118, 96);
  const ab = Math.abs(alt); T(g, (alt < 0 ? '-' : '') + pad(Math.floor(ab / 100), 2), 862, 500, 48, COL.green, 'center');
  g.save(); g.beginPath(); g.rect(888, 456, 54, 88); g.clip(); const a20 = Math.floor(ab / 20) * 20; for (let i = -2; i <= 3; i++) { const v = a20 + i * 20, y = 500 - ((v - ab) / 20) * 36; T(g, pad(((v % 100) + 100) % 100, 2), 915, y, 34, COL.green); } g.restore();
  L(g, 740, 250, 836, 250, '#fff', 3); T(g, pad(d.apAlt, 5), 790, 224, 40, COL.cyan);
  // baro reference (flashing amber box = wrong reference for the altitude: STD below transition, QNH above transition level)
  const flash = (ef.std && alt < 4900 && !fm.wow) || (!ef.std && alt > 6100);
  if (!flash || Math.floor(c.t * 2) % 2 === 0) {
    if (flash) { g.strokeStyle = COL.amber; g.lineWidth = 4; g.strokeRect(770, 765, 190, 50); }
    if (ef.std) T(g, 'STD', 855, 790, 42, COL.cyan); else { T(g, 'QNH', 782, 790, 28, COL.white, 'left'); T(g, baroText(ef), 862, 790, 38, COL.cyan, 'left'); }
  }
  if (d.aglFt < 2500) { const ra = Math.max(0, Math.round(d.aglFt - 18)); T(g, ra, cx, 700, 42, ra < 400 ? COL.amber : COL.green); }
  // ---- V/S ----
  const vsY = (f: number) => { const a = Math.abs(f) / 1000, s = Math.sign(f); return 500 - s * (a <= 1 ? a * 215 : a <= 2 ? 215 + (a - 1) * 38 : 253 + Math.min(4, a - 2) * 9.5); };
  g.fillStyle = COL.tape; g.beginPath(); g.moveTo(900, 205); g.lineTo(950, 235); g.lineTo(950, 765); g.lineTo(900, 795); g.closePath(); g.fill();
  for (const v of [-6000, -2000, -1000, 1000, 2000, 6000]) { const y = vsY(v); L(g, 925, y, 944, y, '#fff', 3); T(g, Math.abs(v) / 1000, 912, y, 24, '#fff'); }
  for (const v of [-1500, -500, 500, 1500]) L(g, 936, vsY(v), 944, vsY(v), '#fff', 2);
  L(g, 928, 500, 950, 500, '#fff', 3);
  const vsv = Math.max(-6000, Math.min(6000, d.vsFpm)), vy = vsY(vsv); L(g, 965, 500, 905, vy, COL.green, 5);
  if (Math.abs(d.vsFpm) > 200) T(g, pad(Math.abs(d.vsFpm) / 100, 2), 880, vy + (vsv > 0 ? -26 : 26), 28, COL.green);
  // ---- heading strip ----
  g.save(); g.beginPath(); g.rect(232, 862, 476, 66); g.clip(); g.fillStyle = COL.tape; g.fillRect(232, 862, 476, 66);
  const pph = 9.1, xH = (v: number) => cx + wrap180(v - d.hdg) * pph;
  for (let v = 0; v < 360; v += 5) { const x = xH(v), ten = v % 10 === 0; if (x < 225 || x > 715) continue; L(g, x, 862, x, ten ? 888 : 876, '#fff', 3); if (ten) T(g, pad(v / 10 % 36 || 36, 2), x, 906, Math.abs(wrap180(v - d.hdg)) < 5 ? 44 : 32, '#fff'); }
  const hb = Math.max(236, Math.min(704, xH(d.apHdg))); if (!sys.hdgManaged) { g.fillStyle = COL.cyan; g.beginPath(); g.moveTo(hb, 864); g.lineTo(hb - 15, 886); g.lineTo(hb + 15, 886); g.closePath(); g.fill(); }
  if (ef.ls && d.ils?.valid) { const cxp = Math.max(236, Math.min(704, xH((d.ils.courseTrue ?? d.hdg) + h.magVar(0)))); L(g, cxp, 862, cxp, 928, COL.mag, 5); }
  g.restore();
  L(g, cx, 826, cx, 862, COL.yellow, 6);
  const tx = Math.max(236, Math.min(704, xH(d.trk))); g.strokeStyle = COL.green; g.lineWidth = 4; g.beginPath(); g.moveTo(tx, 836); g.lineTo(tx + 13, 850); g.lineTo(tx, 864); g.lineTo(tx - 13, 850); g.closePath(); g.stroke();
  // ---- LS (landing system) – only when the LS pushbutton is lit ----
  if (ef.ls) {
    if (d.ils?.valid) {
      const lx = cx + Math.max(-2.4, Math.min(2.4, d.ils.loc)) * 60, gy = cy - Math.max(-2.4, Math.min(2.4, d.ils.gs)) * 60;
      for (const i of [-2, -1, 1, 2]) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(cx + i * 60, 755, 7, 0, 7); g.stroke(); g.beginPath(); g.arc(cx + 275, cy + i * 60, 7, 0, 7); g.stroke(); }
      L(g, cx, 740, cx, 770, COL.yellow, 4); L(g, cx + 262, cy, cx + 288, cy, COL.yellow, 4);
      g.fillStyle = COL.mag; for (const [x, y] of [[lx, 755], [cx + 275, gy]]) { g.beginPath(); g.moveTo(x, y - 15); g.lineTo(x + 15, y); g.lineTo(x, y + 15); g.lineTo(x - 15, y); g.closePath(); g.fill(); }
      T(g, d.ils.ident.split(' ')[1] ?? d.ils.ident, 60, 800, 28, COL.mag, 'left'); T(g, d.ils.distNm.toFixed(1), 60, 836, 28, COL.white, 'left'); T(g, 'NM', 150, 836, 22, COL.cyan, 'left');
    } else { T(g, 'LOC', cx, 755, 30, COL.amber); T(g, 'G/S', cx + 278, cy, 30, COL.amber); }
  }
  if (d.warn.some((w) => /STALL/i.test(w))) T(g, 'STALL', cx, 600, 46, COL.red);
  if (sys.lampTest > 0) T(g, 'TEST', cx, 420, 40, COL.amber);
}

// =============================================================== ND
interface NavHit { ident: string; lat: number; lon: number; dNm: number }
function nearestNav(lat: number, lon: number, adf: boolean): NavHit | null {
  let best: NavHit | null = null; const k = Math.cos(lat * D2R);
  for (const n of NAVAIDS) {
    if (n.type.startsWith('NDB') !== adf) continue;
    const dd = Math.hypot((n.lon - lon) * k * 60, (n.lat - lat) * 60); if (dd > (adf ? 120 : 200)) continue;
    if (!best || dd < best.dNm) best = { ident: n.ident, lat: n.lat, lon: n.lon, dNm: dd };
  }
  return best;
}
function star(g: G, x: number, y: number, r: number) { g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r * 0.28, y - r * 0.28); g.lineTo(x + r, y); g.lineTo(x + r * 0.28, y + r * 0.28); g.lineTo(x, y + r); g.lineTo(x - r * 0.28, y + r * 0.28); g.lineTo(x - r, y); g.lineTo(x - r * 0.28, y - r * 0.28); g.closePath(); }

export function drawND(g: G, W: number, H: number, c: Ctx, side: 0 | 1 = 0) {
  const d = c.d, sys = c.sys, h = c.host, fm = h.fm, ef = sys.efis[side];
  g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
  if (!sys.dc) return;
  const mode = ef.ndMode, rng = ND_RANGES[Math.max(0, Math.min(5, ef.ndRange))];
  const arc = mode === 3, plan = mode === 4, lsMode = mode === 0, showMap = mode === 2 || arc || plan;
  const cx = 500, cy = arc ? 850 : 540, R = arc ? 640 : 400, nmPx = arc ? R / rng : R / (rng / 2);
  const pos = h.position(), mv = h.magVar(0), rt = h.route(), hdgT = fm.heading, hdg = d.hdg;
  const ref = plan && rt.length ? rt[0] : pos;
  const proj = (lat: number, lon: number) => {
    const dx = (lon - ref.lon) * Math.cos(ref.lat * D2R) * 60, dy = (lat - ref.lat) * 60, r = Math.hypot(dx, dy), br = Math.atan2(dx, dy) * R2D;
    if (plan) return { x: cx + dx * nmPx, y: cy - dy * nmPx, r, br };
    const a = (br - hdgT) * D2R; return { x: cx + Math.sin(a) * r * nmPx, y: cy - Math.cos(a) * r * nmPx, r, br };
  };
  const own = proj(pos.lat, pos.lon);
  const vis = (p: { x: number; y: number }) => Math.hypot(p.x - cx, p.y - cy) <= R * 1.02 && (!arc || p.y < cy + 20);
  const relMag = (v: number) => wrap180(v - hdg);
  // --- clip region ---
  g.save(); g.beginPath(); if (arc) g.rect(0, 150, 1000, 700); else g.arc(cx, cy, R + 4, 0, 7); g.clip();
  // --- optional data layer (magenta): only one at a time ---
  if (ef.opt && showMap) {
    g.lineWidth = 3; g.strokeStyle = COL.mag; g.fillStyle = COL.mag; const reachNm = rng * (arc ? 1.05 : 0.55);
    if (ef.opt === 'arpt') {
      for (const a of airportsNear(ref.lat, ref.lon, reachNm * 1852).slice(0, 80)) { const p = proj(a.lat, a.lon); if (!vis(p)) continue; g.beginPath(); g.arc(p.x, p.y, 9, 0, 7); g.stroke(); L(g, p.x - 14, p.y, p.x + 14, p.y, COL.mag, 3); L(g, p.x, p.y - 14, p.x, p.y + 14, COL.mag, 3); T(g, a.icao, p.x + 18, p.y - 16, 24, COL.mag, 'left'); }
    } else if (ef.opt === 'cstr') {
      for (const w of rt) { const p = proj(w.lat, w.lon); if (!vis(p)) continue; g.beginPath(); g.arc(p.x, p.y, 18, 0, 7); g.stroke(); }
    } else {
      for (const n of NAVAIDS) {
        const ndb = n.type.startsWith('NDB'); if (ef.opt === 'ndb' && !ndb) continue; if (ef.opt === 'vord' && ndb) continue;
        if (Math.hypot((n.lon - ref.lon) * Math.cos(ref.lat * D2R) * 60, (n.lat - ref.lat) * 60) > reachNm) continue;
        const p = proj(n.lat, n.lon); if (!vis(p)) continue;
        if (ef.opt === 'wpt') { star(g, p.x, p.y, 11); g.fill(); }
        else if (ndb) { for (let a = 0; a < 6; a++) { g.beginPath(); g.arc(p.x + Math.cos(a) * 9, p.y + Math.sin(a) * 9, 2.2, 0, 7); g.fill(); } g.beginPath(); g.arc(p.x, p.y, 4, 0, 7); g.fill(); }
        else { g.beginPath(); for (let a = 0; a < 6; a++) { const t = a * Math.PI / 3; g.lineTo(p.x + Math.cos(t) * 12, p.y + Math.sin(t) * 12); } g.closePath(); g.stroke(); g.fillRect(p.x - 2, p.y - 2, 4, 4); }
        T(g, n.ident, p.x + 18, p.y - 16, 24, COL.mag, 'left');
      }
    }
  }
  // --- TERR ON ND: coarse EGPWS-style relative terrain dots ---
  if (sys.terrOnNd[side] && showMap && h.terrainFt) {
    const step = arc ? 34 : 38;
    for (let yy = -R; yy <= R; yy += step) for (let xx = -R; xx <= R; xx += step) {
      const px = cx + xx, py = cy + yy; if (Math.hypot(xx, yy) > R || (arc && py > cy)) continue;
      const rNm = Math.hypot(xx, yy) / nmPx, ang = Math.atan2(xx, -yy) * R2D + (plan ? 0 : hdgT);
      const t = h.terrainFt(ref.lat + Math.cos(ang * D2R) * rNm / 60, ref.lon + Math.sin(ang * D2R) * rNm / 60 / Math.cos(ref.lat * D2R)), dz = d.altFt - t; if (dz > 2000 || t < 50) continue;
      g.fillStyle = dz < 250 ? COL.red : dz < 1000 ? COL.amber : COL.green; g.globalAlpha = dz < 1000 ? 0.9 : 0.55;
      for (let a = 0; a < 5; a++) g.fillRect(px - 15 + ((a * 7) % 5) * 6, py - 15 + ((a * 11) % 5) * 6, 4, 4);
    }
    g.globalAlpha = 1;
  }
  // --- flight plan ---
  if (showMap && rt.length) {
    g.strokeStyle = COL.green; g.lineWidth = 5; g.beginPath(); g.moveTo(own.x, own.y); for (const w of rt) { const p = proj(w.lat, w.lon); g.lineTo(p.x, p.y); } g.stroke();
    rt.forEach((w, i) => { const p = proj(w.lat, w.lon); if (!vis(p) && !plan) return; const col = i === 0 ? COL.white : COL.green; g.fillStyle = col; star(g, p.x, p.y, 13); g.fill(); T(g, w.name, p.x + 18, p.y - 18, 28, col, 'left'); });
  }
  // --- bearing pointers (ADF / VOR switches; 1 = single line, 2 = double line) ---
  const navInfo: ({ kind: 'VOR' | 'ADF'; ident: string; dNm: number } | null)[] = [null, null];
  if (!plan) for (let i = 0; i < 2; i++) {
    const sel = ef.nav[i]; if (!sel) continue; const nv = nearestNav(pos.lat, pos.lon, sel < 0); if (!nv) continue;
    const brg = ((Math.atan2((nv.lon - pos.lon) * Math.cos(pos.lat * D2R), nv.lat - pos.lat) * R2D + mv) % 360 + 360) % 360;
    navInfo[i] = { kind: sel > 0 ? 'VOR' : 'ADF', ident: nv.ident, dNm: nv.dNm };
    g.save(); g.translate(cx, cy); g.rotate(relMag(brg) * D2R); g.strokeStyle = sel > 0 ? COL.white : COL.green; g.lineWidth = 4;
    for (const o of i === 0 ? [0] : [-5, 5]) { g.beginPath(); g.moveTo(o, -R * 0.22); g.lineTo(o, -R + 34); g.moveTo(o, R * 0.22); g.lineTo(o, R * 0.55); g.stroke(); }
    g.beginPath(); g.moveTo(-14, -R + 62); g.lineTo(0, -R + 34); g.lineTo(14, -R + 62); g.stroke(); g.restore();
  }
  // --- rose LS: ILS course / deviation bar ---
  if (lsMode && d.ils) {
    g.save(); g.translate(cx, cy); g.rotate(relMag((d.ils.courseTrue ?? hdgT) + mv) * D2R); g.strokeStyle = COL.mag; g.lineWidth = 5;
    g.beginPath(); g.moveTo(0, -R + 10); g.lineTo(0, -R * 0.62); g.moveTo(0, R * 0.62); g.lineTo(0, R - 10); g.stroke();
    if (d.ils.valid) { g.fillStyle = COL.mag; g.fillRect(Math.max(-2, Math.min(2, d.ils.loc)) * 40 - 4, -R * 0.55, 8, R * 1.1); }
    g.fillStyle = '#fff'; for (const i of [-2, -1, 1, 2]) { g.beginPath(); g.arc(i * 40, 0, 6, 0, 7); g.fill(); } g.restore();
  }
  // --- track line and selected-heading line ---
  if (!plan) {
    const tr = relMag(d.trk) * D2R; L(g, cx, cy, cx + Math.sin(tr) * R, cy - Math.cos(tr) * R, COL.green, 4);
    if (!sys.hdgManaged && !lsMode) { const hb = relMag(d.apHdg) * D2R; g.save(); g.setLineDash([14, 12]); L(g, cx, cy, cx + Math.sin(hb) * R, cy - Math.cos(hb) * R, COL.cyan, 3); g.restore(); }
  }
  g.restore();
  // --- compass / range rings ---
  g.save(); g.setLineDash([]);
  const span = arc ? 58 : 180;
  if (!plan) {
    for (let a = 0; a < 360; a += 5) {
      const rel = relMag(a); if (Math.abs(rel) > span) continue; const th = rel * D2R, ten = a % 10 === 0, r2 = R - (ten ? 28 : 15);
      L(g, cx + Math.sin(th) * R, cy - Math.cos(th) * R, cx + Math.sin(th) * r2, cy - Math.cos(th) * r2, '#fff', ten ? 3 : 2);
      if (ten) { g.save(); g.translate(cx + Math.sin(th) * (R - 62), cy - Math.cos(th) * (R - 62)); g.rotate(th); T(g, a / 10 % 36, 0, 0, a % 30 === 0 ? 44 : 32, '#fff'); g.restore(); }
    }
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); if (arc) g.arc(cx, cy, R, -Math.PI / 2 - span * D2R, -Math.PI / 2 + span * D2R); else g.arc(cx, cy, R, 0, 7); g.stroke();
    L(g, cx, cy - R - 22, cx, cy - R + 36, COL.yellow, 8); // fixed heading index
    const trel = Math.max(-span, Math.min(span, relMag(d.trk))) * D2R, dxm = cx + Math.sin(trel) * R, dym = cy - Math.cos(trel) * R;
    g.strokeStyle = COL.green; g.lineWidth = 4; g.beginPath(); g.moveTo(dxm, dym - 14); g.lineTo(dxm + 11, dym); g.lineTo(dxm, dym + 14); g.lineTo(dxm - 11, dym); g.closePath(); g.stroke(); // track diamond
    if (!sys.hdgManaged) { // selected heading bug (cyan), digital read-out when off the visible scale
      const rel = relMag(d.apHdg), cl = Math.max(-span, Math.min(span, rel)) * D2R; g.save(); g.translate(cx + Math.sin(cl) * R, cy - Math.cos(cl) * R); g.rotate(cl);
      g.strokeStyle = COL.cyan; g.lineWidth = 5; g.beginPath(); g.moveTo(-14, -2); g.lineTo(14, -2); g.lineTo(0, -22); g.closePath(); g.moveTo(-14, -2); g.lineTo(-14, 8); g.lineTo(14, 8); g.lineTo(14, -2); g.stroke(); g.restore();
      if (Math.abs(rel) > span) T(g, pad(d.apHdg, 3), cx + Math.sign(rel) * 300, cy - R * 0.92 + (arc ? 0 : 20), 34, COL.cyan);
    }
  } else { T(g, 'N', cx, cy - R - 28, 38, COL.cyan); g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke(); for (let a = 0; a < 360; a += 30) { const th = a * D2R; L(g, cx + Math.sin(th) * R, cy - Math.cos(th) * R, cx + Math.sin(th) * (R - 18), cy - Math.cos(th) * (R - 18), '#fff', 3); } }
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([9, 13]);
  const fr = arc ? [0.25, 0.5, 0.75] : [0.5], fmt = (v: number) => (v % 1 ? v.toFixed(1) : String(v));
  for (const f of fr) { g.beginPath(); if (arc) g.arc(cx, cy, R * f, -Math.PI / 2 - 56 * D2R, -Math.PI / 2 + 56 * D2R); else g.arc(cx, cy, R * f, 0, 7); g.stroke(); }
  g.setLineDash([]);
  if (arc) for (const f of fr) for (const s of [-1, 1]) T(g, fmt(rng * f), cx + s * Math.sin(42 * D2R) * R * f, cy - Math.cos(42 * D2R) * R * f + 24, 30, COL.cyan);
  else { const q = Math.SQRT1_2; T(g, fmt(rng / 4), cx - q * R * 0.5 + 4, cy + q * R * 0.5 + 4, 28, COL.cyan); T(g, fmt(rng / 2), cx - q * R * 0.98 + 4, cy + q * R * 0.98 + 4, 28, COL.cyan); }
  g.restore();
  // --- ownship ---
  g.save(); g.translate(plan ? own.x : cx, plan ? own.y : cy); if (plan) g.rotate(hdgT * D2R); g.lineCap = 'round';
  L(g, 0, -34, 0, 42, COL.yellow, 8); L(g, -38, 10, 38, 10, COL.yellow, 8); L(g, -15, 40, 15, 40, COL.yellow, 7); g.restore();
  // --- header: GS / TAS / wind ---
  const tas = d.kias / Math.sqrt(atmosphere(fm.pos.y).sigma);
  T(g, 'GS', 34, 40, 28, COL.white, 'left'); T(g, Math.round(d.gsKt), 100, 40, 40, COL.green, 'left'); T(g, 'TAS', 215, 40, 28, COL.white, 'left'); T(g, tas >= 100 ? Math.round(tas) : '---', 290, 40, 40, tas >= 100 ? COL.green : COL.white, 'left');
  if (d.wind && d.wind.kt >= 1) {
    T(g, pad(d.wind.dir, 3), 34, 92, 36, COL.green, 'left'); T(g, '/', 120, 92, 36, COL.white, 'left'); T(g, Math.round(d.wind.kt), 146, 92, 36, COL.green, 'left');
    if (d.wind.kt > 2) { g.save(); g.translate(70, 150); g.rotate((d.wind.dir + 180 - hdg) * D2R); L(g, 0, 26, 0, -22, COL.green, 5); g.fillStyle = COL.green; g.beginPath(); g.moveTo(0, -34); g.lineTo(-12, -14); g.lineTo(12, -14); g.closePath(); g.fill(); g.restore(); }
  } else T(g, '---/--', 34, 92, 36, COL.white, 'left');
  // --- header: TO waypoint (NAV / ARC / PLAN), ILS data (rose LS) ---
  if (showMap && rt.length) {
    const dx = (rt[0].lon - pos.lon) * Math.cos(pos.lat * D2R), dy = rt[0].lat - pos.lat, dd = Math.hypot(dx, dy) * 60, brg = ((Math.atan2(dx, dy) * R2D + mv) % 360 + 360) % 360;
    const eta = new Date(c.utc.getTime() + dd / Math.max(60, d.gsKt) * 3600000);
    T(g, rt[0].name, 966, 40, 36, COL.white, 'right'); T(g, `${pad(brg, 3)}°`, 966, 84, 34, COL.green, 'right');
    T(g, 'NM', 966, 128, 28, COL.cyan, 'right'); T(g, dd.toFixed(1), 924, 128, 34, COL.green, 'right'); T(g, `${pad(eta.getUTCHours(), 2)}:${pad(eta.getUTCMinutes(), 2)}`, 966, 172, 34, COL.green, 'right');
  } else if (lsMode && d.ils) { T(g, d.ils.ident, 966, 40, 30, COL.mag, 'right'); T(g, `${d.ils.distNm.toFixed(1)} NM`, 966, 84, 30, COL.white, 'right'); T(g, `CRS ${pad(((d.ils.courseTrue ?? hdgT) + mv + 360) % 360, 3)}`, 966, 128, 30, COL.mag, 'right'); }
  else if (lsMode) T(g, 'NO ILS', 966, 40, 30, COL.amber, 'right');
  // --- bottom corners: selected ADF / VOR data ---
  if (!plan) navInfo.forEach((n, i) => {
    if (!ef.nav[i]) return; const x = i === 0 ? 34 : 966, al: CanvasTextAlign = i === 0 ? 'left' : 'right', col = ef.nav[i] < 0 ? COL.green : COL.white;
    if (!n) { T(g, `${ef.nav[i] > 0 ? 'VOR' : 'ADF'}${i + 1}`, x, 900, 32, col, al); T(g, '---', x, 940, 32, COL.white, al); return; }
    T(g, `${n.kind}${i + 1}`, x, 880, 34, col, al); T(g, n.ident, x, 920, 34, col, al);
    if (n.kind === 'VOR') { T(g, n.dNm.toFixed(1), i === 0 ? x : x - 62, 960, 34, COL.green, al); T(g, 'NM', i === 0 ? x + 100 : x, 960, 26, COL.cyan, al); }
  });
  if (sys.chronoShow) { g.fillStyle = '#5c6a75'; g.fillRect(30, 780, 150, 52); const t = Math.floor(sys.chronoT); T(g, `${Math.floor(t / 60)}'${pad(t % 60, 2)}"`, 105, 807, 36, COL.cyan); }
  if (sys.terrOnNd[side]) T(g, 'TERR', 966, 800, 30, COL.cyan, 'right');
  if (sys.lampTest > 0) T(g, 'TEST', cx, cy - 120, 40, COL.amber);
}
