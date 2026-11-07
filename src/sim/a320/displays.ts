// Airbus-style display renderers drawn into canvases that replace the screen textures of the 3D flight deck:
// PFD, ND (ARC / ROSE / PLAN), E/WD, SD (13 system pages), MCDU, ISIS, FCU window strip and the clock.
// Every renderer works in a 1000 x 1000 (or W x H) virtual space so textures can be any resolution.
import type { PanelData } from '../instruments';
import type { A320Systems, CockpitHost, EcamPage } from './systems';
import { atmosphere } from '../physics';

type G = CanvasRenderingContext2D;
export interface Ctx { d: PanelData; sys: A320Systems; host: CockpitHost; t: number; mcdu: Mcdu; utc: Date }
const F = 'Arial, Helvetica, sans-serif', M = 'Consolas, "Courier New", monospace';
const C = { green: '#2bff4a', cyan: '#2ee6ff', amber: '#ffb000', red: '#ff3030', white: '#f4f4f4', mag: '#ff5cf0', sky: '#1d7fe0', gnd: '#7a4a1c', grey: '#8a96a3' };
const R2D = 180 / Math.PI, D2R = Math.PI / 180;
function T(g: G, s: string | number, x: number, y: number, px: number, col = C.white, al: CanvasTextAlign = 'center', font = F) { g.font = `bold ${px}px ${font}`; g.fillStyle = col; g.textAlign = al; g.textBaseline = 'middle'; g.fillText(String(s), x, y); }
function line(g: G, x1: number, y1: number, x2: number, y2: number, col: string, w = 3) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');
const off = (g: G, W: number, H: number, msg = '') => { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); if (msg) { g.setTransform(1, 0, 0, 1, 0, 0); } };

/** Stall reference speeds (kt IAS) for the current configuration and weight: Vs1g, VLS, Vα-prot. */
export function speeds(h: CockpitHost) {
  const fm = h.fm, s = fm.spec, rho0 = 1.225, fl = fm.flapsPos;
  const clmax = s.CLmax + s.flapCL * fl * 1.05, vs1g = Math.sqrt(2 * fm.totalMass * 9.80665 / (rho0 * s.S * clmax)) / 0.514444;
  return { vs1g, vls: vs1g * 1.23, vaprot: vs1g * 1.08, vsw: vs1g * 1.03, green: vs1g * 1.6, vfe: s.vfe[Math.min(s.vfe.length - 1, Math.max(0, Math.ceil(fl * s.flapDetents - 1e-6)))] };
}

// =============================================================== PFD
export function drawPFD(g: G, W: number, H: number, c: Ctx) {
  const d = c.d, sys = c.sys, h = c.host, fm = h.fm;
  g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
  if (!sys.dc) return;
  const sp = speeds(h), cx = 500, cy = 400, pxDeg = 11;
  // ---- attitude sphere ----
  g.save(); g.beginPath(); g.rect(190, 120, 620, 560); g.clip();
  g.translate(cx, cy); g.rotate(d.bank); // bank + = right wing down -> horizon rotates left
  const off0 = d.pitch * pxDeg;
  g.fillStyle = C.sky; g.fillRect(-700, -900 + off0, 1400, 900); g.fillStyle = C.gnd; g.fillRect(-700, off0, 1400, 900);
  line(g, -700, off0, 700, off0, '#fff', 3);
  for (let p = -30; p <= 30; p += 2.5) { if (!p) continue; const y = off0 - p * pxDeg, big = p % 10 === 0, mid = p % 5 === 0; const w = big ? 80 : mid ? 40 : 20; if (!big && !mid && Math.abs(p) > 15) continue; line(g, -w, y, w, y, '#fff', 2.5); if (big) { T(g, Math.abs(p), -w - 24, y, 24, '#fff'); T(g, Math.abs(p), w + 24, y, 24, '#fff'); } }
  g.restore();
  // roll scale
  g.save(); g.translate(cx, cy); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 3;
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { const r = 250, l = a % 30 === 0 ? 24 : 14, rad = (a - 90) * D2R; line(g, Math.cos(rad) * r, Math.sin(rad) * r, Math.cos(rad) * (r - l), Math.sin(rad) * (r - l), '#fff', 3); }
  g.rotate(d.bank); g.fillStyle = C.amber; g.beginPath(); g.moveTo(0, -250); g.lineTo(-14, -226); g.lineTo(14, -226); g.closePath(); g.fill();
  g.strokeStyle = C.amber; g.lineWidth = 3; g.strokeRect(-18 + Math.max(-1, Math.min(1, d.slip * 6)) * 18, -222, 36, 10); g.restore();
  // aircraft symbol (fixed)
  g.strokeStyle = C.amber; g.lineWidth = 7; g.beginPath(); g.moveTo(cx - 110, cy); g.lineTo(cx - 40, cy); g.lineTo(cx - 40, cy + 18); g.moveTo(cx + 110, cy); g.lineTo(cx + 40, cy); g.lineTo(cx + 40, cy + 18); g.stroke(); g.fillStyle = C.amber; g.fillRect(cx - 5, cy - 5, 10, 10);
  // flight director
  if (sys.fd[0] && d.apOn || sys.fd[0] && !d.apOn && sys.fd[1]) {
    const dh = ((d.apHdg - d.hdg + 540) % 360) - 180, rollCmd = Math.max(-25, Math.min(25, dh * 1.2)), pitchCmd = Math.max(-10, Math.min(15, (d.apAlt - d.altFt) / 150));
    g.save(); g.translate(cx, cy); g.strokeStyle = C.green; g.lineWidth = 6; const by = (pitchCmd - d.pitch) * pxDeg * -1; g.beginPath(); g.moveTo(-100, by); g.lineTo(100, by); g.stroke();
    const bx = (rollCmd - -d.bank * R2D) * 3; g.beginPath(); g.moveTo(bx, -90); g.lineTo(bx, 90); g.stroke(); g.restore();
  }
  // ---- FMA ----
  g.strokeStyle = '#888'; g.lineWidth = 2; for (let i = 1; i < 5; i++) line(g, i * 200, 8, i * 200, 108, '#666', 2); line(g, 0, 110, 1000, 110, '#666', 2);
  const altErr = d.apAlt - d.altFt, vMode = !d.apOn ? '' : d.apAppr && d.ils?.valid ? 'G/S' : Math.abs(altErr) < 120 ? 'ALT' : sys.vsMode ? 'V/S' : altErr > 0 ? 'OP CLB' : 'OP DES';
  const lMode = !d.apOn ? '' : d.apAppr && d.ils?.valid ? 'LOC' : d.apNav ? 'NAV' : 'HDG';
  const thrMode = fm.wow && d.throttle > 0.9 ? 'MAN TOGA' : d.apOn ? `SPEED ${Math.round(d.apSpd)}` : d.throttle > 0.85 ? 'MAN THR' : '';
  T(g, thrMode, 100, 34, 30, C.green); T(g, vMode, 300, 34, 34, C.green); T(g, lMode, 500, 34, 34, C.green);
  T(g, d.apAppr ? (d.ils?.valid ? 'LOC' : 'APPR') : '', 700, 34, 28, C.white);
  T(g, d.apOn ? 'AP1' : '', 900, 30, 30, C.white); T(g, `${sys.fd[0] ? '1' : '-'} FD ${sys.fd[1] ? '2' : '-'}`, 900, 62, 26, C.white); T(g, d.apOn ? 'A/THR' : (sys.athrArmed ? 'A/THR' : ''), 900, 92, 26, d.apOn ? C.white : C.cyan);
  if (d.apOn) { T(g, 'SPEED', 100, 72, 26, C.cyan); T(g, 'MAN' , 300, 72, 1, C.cyan); T(g, d.apNav ? '' : '', 500, 72, 1); }
  // ---- speed tape ----
  g.save(); g.beginPath(); g.rect(20, 120, 150, 560); g.clip(); g.fillStyle = '#16242f'; g.fillRect(20, 120, 150, 560);
  const k = Math.max(30, d.kias), ppk = 7, yOf = (v: number) => 400 - (v - k) * ppk;
  for (let v = Math.max(30, Math.floor((k - 45) / 10) * 10); v <= k + 45; v += 10) { const y = yOf(v); line(g, 140, y, 170, y, '#fff', 3); if (v % 20 === 0) T(g, v, 80, y, 30, '#fff', 'center'); }
  const vmax = Math.min(sp.vfe < 900 ? sp.vfe : 350, 350); g.fillStyle = 'rgba(255,0,0,0.9)'; g.fillRect(150, yOf(vmax + 80), 20, yOf(vmax) - yOf(vmax + 80));
  g.fillStyle = C.amber; g.fillRect(150, yOf(sp.vls), 12, yOf(sp.vls - 60) - yOf(sp.vls) + 0); g.fillStyle = 'rgba(255,60,60,0.95)'; g.fillRect(150, yOf(sp.vsw), 20, yOf(sp.vsw - 80) - yOf(sp.vsw));
  g.fillStyle = C.amber; g.fillRect(150, yOf(sp.vaprot), 8, yOf(sp.vsw) - yOf(sp.vaprot));
  if (fm.flapsPos < 0.05) { g.strokeStyle = C.green; g.lineWidth = 3; g.beginPath(); g.arc(160, yOf(sp.green), 8, 0, 7); g.stroke(); }
  const bugY = yOf(d.apSpd); g.strokeStyle = C.cyan; g.lineWidth = 4; g.beginPath(); g.moveTo(170, bugY); g.lineTo(150, bugY - 12); g.lineTo(150, bugY + 12); g.closePath(); g.stroke();
  g.restore();
  g.fillStyle = '#000'; g.fillRect(40, 372, 110, 56); g.strokeStyle = C.amber; g.lineWidth = 3; g.strokeRect(40, 372, 110, 56); T(g, pad(Math.max(30, d.kias), 3), 95, 401, 44, d.kias < sp.vls - 3 && !fm.wow ? C.amber : C.green);
  g.fillStyle = C.amber; g.beginPath(); g.moveTo(150, 400); g.lineTo(172, 388); g.lineTo(172, 412); g.fill();
  if (d.mach > 0.5) T(g, `.${pad(d.mach * 100, 2)}`, 95, 700, 34, C.green);
  T(g, `${Math.round(d.apSpd)}`, 95, 100 + 0, 1, C.cyan);
  T(g, `${Math.round(d.apSpd)}`, 95, 140, 30, C.cyan);
  // ---- altitude tape ----
  g.save(); g.beginPath(); g.rect(830, 120, 160, 560); g.clip(); g.fillStyle = '#16242f'; g.fillRect(830, 120, 160, 560);
  const alt = d.altFt, ppf = 0.56, yA = (v: number) => 400 - (v - alt) * ppf;
  for (let v = Math.floor((alt - 480) / 20) * 20; v <= alt + 480; v += 20) { const y = yA(v), big = v % 100 === 0; line(g, 830, y, big ? 870 : 850, y, '#fff', 3); if (v % 200 === 0) T(g, pad(Math.abs(v) / 100, 2) + (v < 0 ? '' : ''), 925, y, 30, '#fff'); }
  g.fillStyle = C.cyan; const aby = yA(d.apAlt); g.beginPath(); g.moveTo(830, aby); g.lineTo(856, aby - 14); g.lineTo(856, aby + 14); g.closePath(); g.fill();
  g.restore();
  g.fillStyle = '#000'; g.fillRect(840, 368, 150, 64); g.strokeStyle = C.amber; g.lineWidth = 3; g.strokeRect(840, 368, 150, 64);
  const ab = Math.round(alt / 20) * 20; T(g, pad(Math.floor(Math.abs(ab) / 100), 2), 890, 400, 46, C.green, 'center'); T(g, pad(Math.abs(ab) % 100, 2), 958, 404, 34, C.green);
  T(g, d.apAlt >= 1000 ? `${Math.round(d.apAlt)}` : `${Math.round(d.apAlt)}`, 905, 100 + 0, 1, C.cyan);
  T(g, Math.round(d.apAlt), 905, 140, 34, C.cyan);
  T(g, sys.std ? 'STD' : (sys.qnhInHg ? (sys.qnh * 0.02953).toFixed(2) : String(Math.round(sys.qnh))), 905, 716, 34, sys.std ? C.cyan : C.cyan);
  if (d.aglFt < 2500) { const ra = Math.max(0, Math.round(d.aglFt - 18)); T(g, ra, 500, 640, 40, ra < 400 ? C.amber : C.green); }
  // V/S
  g.fillStyle = '#16242f'; g.fillRect(800, 200, 24, 400);
  for (const v of [-6, -4, -2, -1, 0, 1, 2, 4, 6]) { const y = 400 - v * 30 * (Math.abs(v) <= 2 ? 3 : 1.5) * (Math.abs(v) <= 2 ? 1 : 1) / (Math.abs(v) <= 2 ? 1 : 1); line(g, 800, Math.max(205, Math.min(595, y)), 812, Math.max(205, Math.min(595, y)), '#fff', 2); }
  const vs = Math.max(-6000, Math.min(6000, d.vsFpm)) / 1000, vy = 400 - vs * (Math.abs(vs) <= 2 ? 90 : 0) - (Math.abs(vs) > 2 ? Math.sign(vs) * (180 + (Math.abs(vs) - 2) * 36) : 0);
  line(g, 824, 400, 800, vy, C.green, 4); if (Math.abs(d.vsFpm) > 200) T(g, Math.round(Math.abs(d.vsFpm) / 50) * 50, 770, vy, 22, C.green);
  // ---- ILS ----
  if (d.ils?.valid && (d.apAppr || sys.ndOverlay.ls)) {
    const lx = cx + Math.max(-2, Math.min(2, d.ils.loc)) * 60, gy = cy + Math.max(-2, Math.min(2, d.ils.gs)) * -60 * -1;
    g.fillStyle = C.mag; g.save(); g.translate(lx, 650); g.rotate(Math.PI / 4); g.fillRect(-9, -9, 18, 18); g.restore(); g.save(); g.translate(790, gy); g.rotate(Math.PI / 4); g.fillRect(-9, -9, 18, 18); g.restore();
    T(g, d.ils.ident, 230, 650, 28, C.mag);
  }
  // ---- heading scale ----
  g.fillStyle = '#16242f'; g.fillRect(190, 760, 620, 150); g.save(); g.beginPath(); g.rect(190, 760, 620, 150); g.clip();
  const hdg = d.hdg, pph = 8, xH = (v: number) => 500 + (((v - hdg + 540) % 360) - 180) * pph;
  for (let v = 0; v < 360; v += 5) { const x = xH(v), maj = v % 10 === 0; if (x < 190 || x > 810) continue; line(g, x, 768, x, maj ? 796 : 782, '#fff', 3); if (v % 10 === 0) T(g, pad(v / 10 % 36, 2), x, 826, 28, '#fff'); }
  const hb = xH(d.apHdg); g.fillStyle = C.cyan; g.beginPath(); g.moveTo(hb, 768); g.lineTo(hb - 14, 790); g.lineTo(hb + 14, 790); g.fill();
  const tx = xH(d.trk); g.strokeStyle = C.green; g.lineWidth = 4; g.beginPath(); g.moveTo(tx, 760); g.lineTo(tx - 10, 772); g.lineTo(tx, 784); g.lineTo(tx + 10, 772); g.closePath(); g.stroke();
  g.restore(); g.fillStyle = C.amber; g.beginPath(); g.moveTo(500, 760); g.lineTo(488, 744); g.lineTo(512, 744); g.fill(); T(g, pad(hdg, 3), 500, 722, 30, C.green);
  // flap/gear/warn flags
  if (!fm.wow && d.aglFt < 2000 && d.gear < 0.9) T(g, 'L/G NOT DOWN', 500, 190, 28, C.red);
  if (d.warn.some((w) => /STALL/i.test(w))) T(g, 'STALL', 500, 240, 44, C.red);
  T(g, sys.lampTest > 0 ? 'TEST' : '', 500, 500, 40, C.amber);
}

// =============================================================== ND
export function drawND(g: G, W: number, H: number, c: Ctx) {
  const d = c.d, sys = c.sys, h = c.host, fm = h.fm;
  g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
  if (!sys.dc) return;
  const mode = sys.ndMode; // 0 LS 1 VOR 2 NAV 3 ARC 4 PLAN
  const rng = [10, 20, 40, 80, 160, 320][Math.max(0, Math.min(5, sys.ndRange))];
  const arc = mode === 3, plan = mode === 4, cx = 500, cy = arc ? 800 : 500, rad = arc ? 640 : 380;
  const pos = h.position(), hdgT = fm.heading, up = plan ? 0 : hdgT;
  const proj = (lat: number, lon: number) => { const dx = (lon - pos.lon) * Math.cos(pos.lat * D2R) * 60, dy = (lat - pos.lat) * 60, r = Math.hypot(dx, dy), br = Math.atan2(dx, dy) * R2D; const a = (br - up) * D2R; return { x: cx + Math.sin(a) * r / rng * rad, y: cy - Math.cos(a) * r / rng * rad, r, br }; };
  g.save(); g.beginPath(); if (arc) { g.rect(0, 120, 1000, 880); } else g.rect(0, 0, 1000, 1000); g.clip();
  // compass
  const mv = h.magVar(0) - 0; const hdgM = d.hdg; void mv;
  if (!plan) {
    g.save(); g.translate(cx, cy); g.rotate(-hdgM * D2R); g.strokeStyle = '#fff'; g.lineWidth = 3;
    for (let a = 0; a < 360; a += 5) { const r1 = rad + 10, r2 = rad - (a % 10 === 0 ? 24 : 12), ca = Math.cos((a - 90) * D2R), sa = Math.sin((a - 90) * D2R); if (arc && (((a - hdgM + 540) % 360) - 180 > 60 || ((a - hdgM + 540) % 360) - 180 < -60)) continue; line(g, ca * r1, sa * r1, ca * r2, sa * r2, '#fff', a % 10 === 0 ? 3 : 2); if (a % 30 === 0) { g.save(); g.translate(ca * (r2 - 28), sa * (r2 - 28)); g.rotate(a * D2R); T(g, a % 90 === 0 ? 'NESW'[a / 90] : a / 10, 0, 0, 28, '#fff'); g.restore(); } }
    g.restore();
  } else T(g, 'N', cx, cy - rad - 20, 32, C.cyan);
  // range rings
  g.strokeStyle = '#6a7683'; g.lineWidth = 2; g.setLineDash([6, 10]); for (const f of [0.5]) { g.beginPath(); if (arc) g.arc(cx, cy, rad * f, Math.PI * 1.17, Math.PI * 1.83); else g.arc(cx, cy, rad * f, 0, 7); g.stroke(); } g.setLineDash([]);
  T(g, rng / 2, cx - 6 - rad * 0.5 * 0.5, cy - rad * 0.5 * 0.85 - (arc ? 0 : 0) + 0, 22, C.cyan);
  // route
  const rt = h.route(); const act = Math.max(0, h.ap.nav ? 0 : 0); void act;
  if (rt.length) {
    g.strokeStyle = C.green; g.lineWidth = 4; g.beginPath(); let first = true;
    const here = proj(pos.lat, pos.lon); g.moveTo(here.x, here.y);
    for (const w of rt) { const p = proj(w.lat, w.lon); g.lineTo(p.x, p.y); first = false; }
    void first; g.stroke();
    for (const w of rt) { const p = proj(w.lat, w.lon); if (p.r > rng * 1.3 && !plan) continue; g.strokeStyle = C.white; g.lineWidth = 3; g.beginPath(); g.moveTo(p.x, p.y - 12); g.lineTo(p.x + 11, p.y + 8); g.lineTo(p.x - 11, p.y + 8); g.closePath(); g.stroke(); if (sys.ndOverlay.wpt || w === rt[0]) T(g, w.name, p.x + 14, p.y - 18, 22, w === rt[0] ? C.mag : C.white, 'left'); }
  }
  // heading bug, track line
  const rel = (v: number) => ((v - hdgM + 540) % 360) - 180;
  if (!plan) {
    const tr = rel(d.trk) * D2R; line(g, cx, cy, cx + Math.sin(tr) * rad, cy - Math.cos(tr) * rad, C.green, 3);
    const hb = rel(d.apHdg) * D2R; g.save(); g.translate(cx + Math.sin(hb) * rad, cy - Math.cos(hb) * rad); g.rotate(hb); g.fillStyle = C.cyan; g.fillRect(-14, -8, 28, 16); g.restore();
  }
  // ownship
  g.save(); g.translate(cx, cy); if (plan) g.rotate(hdgT * D2R); g.strokeStyle = C.amber; g.lineWidth = 6; g.beginPath(); g.moveTo(0, -30); g.lineTo(0, 36); g.moveTo(-26, 12); g.lineTo(26, 12); g.moveTo(-10, 34); g.lineTo(10, 34); g.stroke(); g.restore();
  g.restore();
  // header
  g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 120);
  T(g, 'GS', 40, 30, 24, C.white, 'left'); T(g, Math.round(d.gsKt), 100, 30, 34, C.green, 'left'); T(g, 'TAS', 40, 66, 24, C.white, 'left'); T(g, Math.round(d.kias * 1 / Math.sqrt(atmosphere(fm.pos.y).sigma)), 110, 66, 34, C.green, 'left');
  T(g, pad(hdgM, 3), 500, 28, 36, C.green); T(g, ['ILS', 'VOR', 'NAV', 'ARC', 'PLAN'][mode], 330, 28, 26, C.green);
  if (rt.length) { const p = proj(rt[0].lat, rt[0].lon); T(g, rt[0].name, 760, 28, 32, C.mag, 'left'); T(g, `${Math.round((p.br + 360 - 0) % 360)}°`, 760, 66, 26, C.mag, 'left'); T(g, `${p.r.toFixed(1)}NM`, 880, 66, 26, C.white, 'left'); }
  if (d.wind) { T(g, `${pad(d.wind.dir, 3)}/${Math.round(d.wind.kt)}`, 100, 130, 28, C.green, 'left'); }
  T(g, `${rng}`, 940, 940, 26, C.cyan, 'right'); T(g, 'RANGE', 940, 910, 18, C.white, 'right');
  if (d.ils?.valid) { T(g, `${d.ils.ident}`, 60, 900, 28, C.mag, 'left'); T(g, `${d.ils.distNm.toFixed(1)}NM`, 60, 936, 26, C.white, 'left'); }
}

// =============================================================== E/WD
export function drawEWD(g: G, W: number, H: number, c: Ctx) {
  const d = c.d, sys = c.sys, fm = c.host.fm;
  g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
  if (!sys.dc) return;
  const fob = Math.round(fm.fuel / 10) * 10;
  T(g, 'F.O.B.:', 40, 30, 28, C.white, 'left'); T(g, fob, 270, 30, 32, C.green, 'right'); T(g, 'KG', 290, 30, 24, C.cyan, 'left');
  const arcGauge = (cx: number, cy: number, r: number, v: number, label: string, max = 100, red = 100) => {
    g.strokeStyle = '#ddd'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); g.stroke(); g.strokeStyle = C.red; g.beginPath(); g.arc(cx, cy, r, Math.PI * (0.75 + 1.5 * red / max), Math.PI * 2.25); g.stroke();
    const a = Math.PI * (0.75 + 1.5 * Math.min(1, v / max)); line(g, cx, cy, cx + Math.cos(a) * r, cy + Math.sin(a) * r, C.green, 5);
    T(g, v.toFixed(1), cx + r * 0.7, cy - r * 0.55 - 6, 36, C.green, 'right'); T(g, label, cx, cy - r - 20, 22, C.white);
  };
  const n1 = [fm.n[0] * 100, fm.n[1] * 100], toga = 100;
  arcGauge(240, 190, 90, n1[0], 'N1 %', 110, 100); arcGauge(560, 190, 90, n1[1], '', 110, 100);
  T(g, 'N1', 400, 120, 26, C.white); T(g, '%', 400, 148, 22, C.cyan);
  T(g, 'EGT', 400, 270, 26, C.white); T(g, '°C', 400, 298, 22, C.cyan); T(g, 'N2', 400, 350, 26, C.white); T(g, '%', 400, 378, 22, C.cyan); T(g, 'F.F.', 400, 430, 26, C.white); T(g, 'KG/H', 400, 458, 20, C.cyan);
  for (let i = 0; i < 2; i++) { const x = i ? 640 : 330; T(g, Math.round(sys.egt[i]), x, 280, 38, sys.egt[i] > 900 ? C.red : C.green, 'right'); T(g, sys.n2[i].toFixed(1), x, 350, 38, C.green, 'right'); T(g, Math.round(sys.ff[i] / 10) * 10, x, 430, 38, C.green, 'right'); }
  void toga;
  // flaps / slats
  const fi = fm.ctl.flapsIdx, lab = ['0', '1', '1+F', '2', '3', 'FULL'][fi === 1 ? 1 : fi + (fi > 1 ? 1 : 0)] ?? 'FULL'; const txt = ['0', '1', '2', '3', 'FULL'][fi];
  void lab; T(g, 'S  F', 840, 100, 24, C.white); T(g, `CONF ${txt === 'FULL' ? 'FULL' : txt}`, 840, 140, 28, C.green); T(g, d.gear > 0.95 ? 'L/G DN' : d.gear < 0.05 ? '' : 'L/G', 840, 200, 28, d.gear > 0.95 ? C.green : C.red);
  line(g, 20, 500, 980, 500, '#777', 2);
  // messages + memo
  const lines: { t: string; col: string }[] = [];
  for (const w of d.warn) lines.push({ t: w.toUpperCase().slice(0, 34), col: /STALL|FIRE|OVERSPEED|PULL UP|SINK|TERRAIN/i.test(w) ? C.red : C.amber });
  if (sys.startMsg) lines.push({ t: sys.startMsg.toUpperCase().slice(0, 34), col: C.amber });
  if (!lines.length) {
    const eng = fm.anyEngineRunning;
    if (fm.wow && eng && fm.gs < 40 && d.throttle < 0.3) { lines.push({ t: 'T.O MEMO', col: C.cyan }); lines.push({ t: `AUTO BRK  ${['OFF', 'LO', 'MED', 'MAX'][sys.autobrake]}`, col: sys.autobrake === 3 ? C.green : C.amber }); lines.push({ t: `SIGNS  ${c.host.seatbelt ? 'ON' : 'OFF'}`, col: c.host.seatbelt ? C.green : C.amber }); lines.push({ t: `SPLRS  ${sys.spoilerArm ? 'ARM' : 'NOT ARMED'}`, col: sys.spoilerArm ? C.green : C.amber }); lines.push({ t: `FLAPS  T.O  ${fi >= 1 && fi <= 2 ? 'OK' : 'CHECK'}`, col: fi >= 1 && fi <= 2 ? C.green : C.amber }); lines.push({ t: 'T.O CONFIG  NORMAL', col: C.green }); }
    else if (!fm.wow && d.aglFt < 2500 && d.gear > 0.1) { lines.push({ t: 'LDG MEMO', col: C.cyan }); lines.push({ t: `LDG GEAR  ${d.gear > 0.95 ? 'DN' : 'UP'}`, col: d.gear > 0.95 ? C.green : C.amber }); lines.push({ t: `SIGNS  ${c.host.seatbelt ? 'ON' : 'OFF'}`, col: c.host.seatbelt ? C.green : C.amber }); lines.push({ t: `SPLRS  ${sys.spoilerArm ? 'ARM' : 'NOT ARMED'}`, col: sys.spoilerArm ? C.green : C.amber }); lines.push({ t: `FLAPS  ${fi === 4 ? 'FULL' : fi === 3 ? 'CONF 3' : 'CHECK'}`, col: fi >= 3 ? C.green : C.amber }); }
    else { if (c.host.seatbelt) lines.push({ t: 'SEAT BELTS', col: C.green }); if (c.host.lights.land) lines.push({ t: 'LAND LT', col: C.green }); if (sys.apuRpm >= 95) lines.push({ t: `APU AVAIL`, col: C.green }); if (sys.ext) lines.push({ t: 'EXT PWR', col: C.green }); if (sys.apuBleed && sys.apuRpm >= 95) lines.push({ t: 'APU BLEED', col: C.green }); if (!c.host.lights.beacon && fm.anyEngineRunning) lines.push({ t: 'BEACON  OFF', col: C.amber }); if (fm.wow && fm.ctl.parking) lines.push({ t: 'PARK BRK', col: C.green }); if (fm.ctl.reverse) lines.push({ t: 'REV SELECTED', col: C.amber }); if (!lines.length) lines.push({ t: ' ', col: C.green }); }
  }
  lines.slice(0, 10).forEach((l, i) => T(g, l.t, 40, 545 + i * 44, 34, l.col, 'left'));
  if (sys.masterWarn || d.warn.some((w) => /STALL|FIRE/i.test(w))) { }
}

// =============================================================== SD
const SD_TITLES: Record<EcamPage, string> = { ENG: 'ENGINE', BLEED: 'BLEED', PRESS: 'CAB PRESS', ELEC: 'ELEC', HYD: 'HYD', FUEL: 'FUEL', APU: 'APU', COND: 'COND', DOOR: 'DOOR/OXY', WHEEL: 'WHEEL', 'F/CTL': 'F/CTL', STS: 'STATUS', CRZ: 'CRUISE' };
export function drawSD(g: G, W: number, H: number, c: Ctx) {
  const d = c.d, sys = c.sys, fm = c.host.fm, page = sys.page ?? sys.pageAuto;
  g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
  if (!sys.dc) return;
  T(g, SD_TITLES[page], 500, 36, 36, C.white); line(g, 360, 62, 640, 62, C.white, 3);
  const val = (x: number, y: number, v: string | number, col = C.green, unit = '', px = 38) => { T(g, v, x, y, px, col, 'center'); if (unit) T(g, unit, x, y + px * 0.8, 20, C.cyan); };
  const box = (x: number, y: number, w: number, h: number, col = C.white) => { g.strokeStyle = col; g.lineWidth = 3; g.strokeRect(x, y, w, h); };
  const lbl = (x: number, y: number, s: string, col = C.white, px = 26) => T(g, s, x, y, px, col);
  const psiCol = (p: number) => (p > 2500 ? C.green : p > 500 ? C.amber : C.amber);
  switch (page) {
    case 'ENG': for (let i = 0; i < 2; i++) { const x = 270 + i * 460; lbl(x, 130, `ENG ${i + 1}`, C.white, 30); lbl(x, 220, 'OIL', C.white); val(x, 270, Math.round(sys.oilQty[i] * 10) / 10, C.green, 'QT'); val(x, 360, Math.round(sys.oilPsi[i]), C.green, 'PSI'); lbl(x, 450, 'VIB N1', C.white); val(x, 490, sys.vib[i].toFixed(1)); lbl(x, 570, 'N1 MODE ' + (fm.eng[i].state === 2 ? 'RATED' : '---'), C.white, 22); lbl(x, 620, sys.ignA[i] ? 'IGN A' : '', C.green); lbl(x, 690, `FUEL USED`, C.white, 22); val(x, 730, Math.round((spec0(c).fuelCap - fm.fuel) / 2)); } break;
    case 'BLEED': { for (let i = 0; i < 2; i++) { const x = 250 + i * 500; lbl(x, 130, `ENG ${i + 1}`, C.white); val(x, 200, Math.round(sys.bleedPsi[i]), sys.bleedPsi[i] > 20 ? C.green : C.amber, 'PSI'); line(g, x, 260, x, 400, sys.engBleed[i] ? C.green : C.amber, 5); lbl(x, 440, `PACK ${i + 1}`, C.white); box(x - 60, 470, 120, 60, sys.packs[i] && sys.bleedPsi[i] > 20 ? C.green : C.amber); lbl(x, 500, sys.packs[i] ? 'ON' : 'OFF', sys.packs[i] ? C.green : C.amber); }
      line(g, 250, 330, 750, 330, C.green, 5); lbl(500, 300, 'X BLEED', C.white, 22); lbl(500, 360, sys.xbleed ? 'OPEN' : 'SHUT', C.green, 24); lbl(500, 600, 'APU BLEED', C.white, 22); lbl(500, 640, sys.apuBleed && sys.apuRpm >= 95 ? 'ON' : 'OFF', sys.apuBleed ? C.green : C.amber, 28); lbl(500, 740, `ANTI ICE  ${sys.wingAI ? 'WING ON' : 'OFF'}`, sys.wingAI ? C.green : C.white, 24); break; }
    case 'PRESS': lbl(200, 150, 'CAB ALT', C.white); val(200, 200, Math.round(sys.cabAltFt / 50) * 50, C.green, 'FT'); lbl(500, 150, 'V/S', C.white); val(500, 200, Math.round(sys.cabVs / 50) * 50, C.green, 'FT/MIN'); lbl(800, 150, 'ΔP', C.white); val(800, 200, sys.deltaP.toFixed(1), C.green, 'PSI'); box(380, 380, 240, 200, C.white); lbl(500, 420, 'CABIN', C.white, 24); lbl(500, 500, `OUTFLOW ${Math.round(sys.outflow * 100)}%`, C.green, 26); lbl(250, 700, `PACK 1 ${sys.packs[0] ? 'ON' : 'OFF'}`, C.green); lbl(750, 700, `PACK 2 ${sys.packs[1] ? 'ON' : 'OFF'}`, C.green); break;
    case 'ELEC': { const bus = (x: number, y: number, n: string, on: boolean) => { box(x - 80, y - 28, 160, 56, on ? C.green : C.amber); lbl(x, y, n, on ? C.green : C.amber, 26); };
      for (let i = 0; i < 2; i++) { const x = 230 + i * 540; lbl(x, 140, `BAT ${i + 1}`, C.white); val(x, 190, sys.batV[i].toFixed(1), sys.bat[i] ? C.green : C.amber, 'V'); lbl(x, 300, `GEN ${i + 1}`, C.white); val(x, 340, sys.ac && fm.eng[i].state === 2 && sys.gen[i] ? '115' : '--', C.green, 'V'); bus(x, 470, i ? 'AC BUS 2' : 'AC BUS 1', sys.ac); bus(x, 580, i ? 'DC BUS 2' : 'DC BUS 1', sys.dc); }
      bus(500, 520, 'AC ESS', sys.acEss); lbl(500, 220, 'APU GEN', C.white); val(500, 270, sys.apuRpm >= 95 && sys.apuGen ? '115' : '--'); lbl(500, 360, 'EXT PWR', C.white); val(500, 400, sys.ext ? 'ON' : 'OFF', sys.ext ? C.green : C.white); bus(500, 660, 'DC ESS', sys.dc); break; }
    case 'HYD': { const sysn: [string, number, number][] = [['GREEN', sys.hyd.green, 160], ['BLUE', sys.hyd.blue, 500], ['YELLOW', sys.hyd.yellow, 840]]; for (const [n, p, x] of sysn) { lbl(x, 140, n, p > 2500 ? C.green : C.amber, 30); val(x, 220, Math.round(p / 50) * 50, psiCol(p), 'PSI'); line(g, x, 280, x, 480, psiCol(p), 5); box(x - 60, 500, 120, 60, psiCol(p)); lbl(x, 530, p > 2500 ? 'ON' : 'LO', psiCol(p)); }
      lbl(330, 440, sys.hydPump.ptu ? 'PTU' : '', C.green, 22); lbl(500, 660, `ACCU ${Math.round(sys.accumPsi / 50) * 50}`, C.white, 24); lbl(500, 720, sys.ratOut ? 'RAT OUT' : '', C.amber); break; }
    case 'FUEL': { lbl(500, 120, 'FOB', C.white, 26); val(500, 160, Math.round(fm.fuel / 10) * 10, C.green, 'KG'); const tank = (x: number, y: number, w: number, h: number, v: number, n: string) => { box(x, y, w, h, C.white); lbl(x + w / 2, y + 36, Math.round(v / 10) * 10 + '', C.green, 36); lbl(x + w / 2, y - 18, n, C.white, 22); };
      tank(80, 260, 260, 150, sys.tank.l, 'LEFT'); tank(660, 260, 260, 150, sys.tank.r, 'RIGHT'); tank(380, 340, 240, 150, sys.tank.c, 'CTR'); for (let i = 0; i < 6; i++) { const x = i < 2 ? 130 + i * 90 : i < 4 ? 420 + (i - 2) * 90 : 700 + (i - 4) * 90, y = i < 2 || i > 3 ? 370 : 450; box(x, y, 70, 30, sys.pumps[i] ? C.green : C.amber); lbl(x + 35, y + 15, sys.pumps[i] ? 'ON' : 'OFF', sys.pumps[i] ? C.green : C.amber, 18); }
      lbl(500, 580, 'F.F.', C.white, 24); val(500, 620, Math.round(fm.fuelFlow * 3600 / 10) * 10, C.green, 'KG/H'); lbl(500, 720, `X FEED ${sys.xfeed ? 'OPEN' : 'SHUT'}`, C.white, 24); break; }
    case 'APU': lbl(500, 130, 'APU', sys.apuRpm > 5 ? C.green : C.white, 34); lbl(300, 230, 'N', C.white); val(300, 280, Math.round(sys.apuRpm), sys.apuRpm >= 95 ? C.green : C.amber, '%'); lbl(700, 230, 'EGT', C.white); val(700, 280, Math.round(sys.apuEgt), sys.apuEgt > 700 ? C.red : C.green, '°C'); lbl(300, 420, `GEN ${sys.apuRpm >= 95 && sys.apuGen ? 'ON' : 'OFF'}`, sys.apuRpm >= 95 && sys.apuGen ? C.green : C.white, 30); lbl(700, 420, `BLEED ${sys.apuBleed && sys.apuRpm >= 95 ? 'ON' : 'OFF'}`, sys.apuBleed ? C.green : C.white, 30); lbl(500, 560, sys.apuRpm >= 95 ? 'AVAIL' : sys.apuStart ? 'START' : '', C.green, 40); break;
    case 'COND': for (const [n, x] of [['CKPT', 200], ['FWD', 500], ['AFT', 800]] as [string, number][]) { lbl(x, 180, n, C.white); val(x, 240, Math.round(sys.cabTemp + (n === 'FWD' ? 1 : n === 'AFT' ? 2 : 0)), C.green, '°C'); } lbl(500, 420, `PACK 1 ${sys.packs[0] ? 'ON' : 'OFF'}   PACK 2 ${sys.packs[1] ? 'ON' : 'OFF'}`, C.green, 30); lbl(500, 520, 'HOT AIR  ON', C.green, 26); break;
    case 'DOOR': for (const [n, x, y] of [['CKPT', 500, 150], ['FWD L', 320, 300], ['FWD R', 680, 300], ['AFT L', 320, 520], ['AFT R', 680, 520], ['CARGO F', 500, 380], ['CARGO A', 500, 600]] as [string, number, number][]) { box(x - 60, y - 24, 120, 48, C.green); lbl(x, y, n, C.green, 22); } lbl(500, 760, 'OXY 1850 PSI', C.green, 28); lbl(500, 830, 'SLIDES ARMED', C.green, 24); break;
    case 'WHEEL': { lbl(500, 120, `A/SKID ${sys.antiSkid ? 'ON' : 'OFF'}   N/W STRG ${sys.nwStrg ? 'ON' : 'OFF'}`, C.green, 28); const gear = (x: number, y: number, n: string) => { lbl(x, y, n, C.white, 22); box(x - 50, y + 20, 100, 50, d.gear > 0.95 ? C.green : d.gear < 0.05 ? C.white : C.red); lbl(x, y + 45, d.gear > 0.95 ? 'DN' : d.gear < 0.05 ? 'UP' : '...', d.gear > 0.95 ? C.green : C.amber, 30); };
      gear(500, 190, 'NOSE'); gear(200, 330, 'LEFT'); gear(800, 330, 'RIGHT'); const br = Math.min(400, 60 + Math.max(0, fm.gs - 5) * 1.5 * (fm.ctl.brake + (fm.ctl.parking ? 0 : 0) + 0.2)); lbl(200, 480, 'BRAKE °C', C.white, 22); val(200, 530, Math.round(br), br > 300 ? C.amber : C.green); val(800, 530, Math.round(br), br > 300 ? C.amber : C.green); lbl(500, 480, `AUTO BRK ${['OFF', 'LO', 'MED', 'MAX'][sys.autobrake]}`, sys.autobrake ? C.green : C.white, 26); lbl(500, 560, `SPLRS ${sys.spoilerArm ? 'ARM' : '---'}`, sys.spoilerArm ? C.green : C.white, 24); lbl(500, 640, fm.ctl.parking ? 'PARK BRK ON' : '', C.red, 28); lbl(500, 720, 'TIRE 185 PSI', C.green, 22); break; }
    case 'F/CTL': { lbl(250, 130, 'ELAC 1 2   SEC 1 2 3   FAC 1 2', C.green, 22); const el = fm.surf.el, al = fm.surf.ail; lbl(500, 220, 'ELEV', C.white, 24); box(430, 250, 140, 200); line(g, 440, 350 - el * 90, 560, 350 - el * 90, C.green, 8); lbl(250, 220, 'AIL L', C.white, 24); line(g, 160, 330 + al * 60, 340, 330 + al * 60, C.green, 8); lbl(750, 220, 'AIL R', C.white, 24); line(g, 660, 330 - al * 60, 840, 330 - al * 60, C.green, 8); lbl(500, 520, 'SPLRS', C.white, 24); for (let i = 0; i < 5; i++) { for (const sx of [-1, 1]) line(g, 500 + sx * (60 + i * 55), 600, 500 + sx * (60 + i * 55), 600 - fm.sbPos * 70 - 4, C.green, 10); } lbl(500, 700, `FLAPS ${['0', '1', '2', '3', 'FULL'][fm.ctl.flapsIdx]}  ${Math.round(fm.flapsPos * 100)}%`, C.green, 28); lbl(500, 770, `PITCH TRIM ${(fm.trimAuto * 4).toFixed(1)}° ${fm.trimAuto > 0 ? 'UP' : 'DN'}`, C.green, 26); lbl(500, 830, `RUD ${(fm.surf.rud * 25).toFixed(0)}°`, C.green, 26); break; }
    case 'STS': lbl(500, 400, d.warn.length || sys.startMsg ? 'INOP SYS' : 'STATUS  NORMAL', d.warn.length ? C.amber : C.green, 44); d.warn.slice(0, 6).forEach((w, i) => lbl(500, 480 + i * 44, w.toUpperCase().slice(0, 30), C.amber, 30)); break;
    case 'CRZ': { lbl(150, 160, 'F.USED', C.white, 24); val(150, 210, Math.round((spec0(c).fuelCap - fm.fuel) / 10) * 10, C.green, 'KG'); lbl(500, 160, 'CAB V/S', C.white, 24); val(500, 210, Math.round(sys.cabVs / 50) * 50, C.green, 'FT/MIN'); lbl(850, 160, 'CAB ALT', C.white, 24); val(850, 210, Math.round(sys.cabAltFt / 50) * 50, C.green, 'FT'); lbl(850, 330, 'ΔP', C.white, 24); val(850, 370, sys.deltaP.toFixed(1), C.green, 'PSI'); lbl(150, 330, 'OIL', C.white, 24); val(150, 370, Math.round(sys.oilQty[0] * 10) / 10, C.green, 'QT'); lbl(500, 520, `ELEC ${sys.ac ? 'AC OK' : 'NO AC'}`, sys.ac ? C.green : C.amber, 28); lbl(500, 600, `HYD G ${Math.round(sys.hyd.green / 100) * 100}  B ${Math.round(sys.hyd.blue / 100) * 100}  Y ${Math.round(sys.hyd.yellow / 100) * 100}`, C.green, 26); break; }
  }
  // bottom status line
  line(g, 10, 905, 990, 905, '#777', 2); const at = atmosphere(fm.pos.y); const sat = Math.round(at.T - 273.15), tat = Math.round(sat + 0.2 * (fm.mach * 300) ** 2 / 1005 / 2);
  T(g, 'TAT', 40, 940, 22, C.white, 'left'); T(g, `${tat > 0 ? '+' : ''}${tat}`, 130, 940, 30, C.green, 'left'); T(g, '°C', 200, 940, 20, C.cyan, 'left'); T(g, 'SAT', 40, 975, 20, C.white, 'left'); T(g, `${sat > 0 ? '+' : ''}${sat}`, 130, 975, 26, C.green, 'left');
  T(g, `${pad(c.utc.getUTCHours(), 2)}  ${pad(c.utc.getUTCMinutes(), 2)}`, 590, 950, 34, C.white, 'left'); T(g, 'H', 640, 950, 1, C.cyan);
  T(g, `GW ${Math.round(fm.totalMass / 10) * 10} KG`, 960, 950, 28, C.green, 'right');
}
const spec0 = (c: Ctx) => c.host.fm.spec;

// =============================================================== MCDU
export class Mcdu {
  page = 'MENU'; scratch = ''; msg = ''; sub = 0;
  store = { flt: 'IFL320', crz: 350, ci: 35, v1: 0, vr: 0, v2: 0, flex: 55, zfw: 62.5, block: 0, fuelRes: 2.4, trans: 5000, toConf: 1, qnh: 1013 };
  private host?: CockpitHost;
  attach(h: CockpitHost) { this.host = h; }
  private setMsg(m: string) { this.msg = m; setTimeout(() => { if (this.msg === m) this.msg = ''; }, 3500); }
  /** Key names follow the 3D model: a.cpt … z.cpt, 0-9, L1-6, R1-6, init, f-pln, radnav, fuel-pred, prog, perf, data, dir, airport, clr, sp, ... */
  key(raw: string) {
    const k = raw.replace(/\.(cpt|fo)$/, '');
    if (/^[a-z]$/.test(k)) { this.add(k.toUpperCase()); return; }
    if (/^[0-9]$/.test(k)) { this.add(k); return; }
    switch (k) {
      case '.': this.add('.'); return; case '/': this.add('/'); return; case '+/-': this.add(this.scratch.startsWith('-') ? this.scratch.slice(1) : this.scratch === '' ? '-' : '-'); return;
      case 'sp': this.add(' '); return; case 'clr': this.scratch = this.scratch.slice(0, -1); this.msg = ''; return;
      case 'init': this.page = 'INIT'; return; case 'f-pln': case 'f-pln2': this.page = 'F-PLN'; this.sub = 0; return; case 'radnav': this.page = 'RADNAV'; return; case 'fuel-pred': this.page = 'FUEL'; return;
      case 'prog': this.page = 'PROG'; return; case 'perf': this.page = 'PERF'; return; case 'data': this.page = 'DATA'; return; case 'dir': this.page = 'DIR'; return; case 'airport': this.page = 'AIRPORT'; return; case 'menu': this.page = 'MENU'; return;
      case 'up': this.sub = Math.max(0, this.sub - 1); return; case 'down': this.sub++; return; case 'left': this.sub = Math.max(0, this.sub - 1); return; case 'right': this.sub++; return;
    }
    const m = /^([LR])([1-6])$/.exec(k); if (m) this.lsk(m[1] as 'L' | 'R', +m[2]);
  }
  private add(ch: string) { if (this.scratch.length < 22) this.scratch += ch; }
  private take(): string { const s = this.scratch; this.scratch = ''; return s; }
  private num(s: string) { const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; }
  private lsk(side: 'L' | 'R', n: number) {
    const st = this.store, h = this.host; if (!h) return;
    const input = this.scratch;
    if (this.page === 'MENU') { const t = ['', 'INIT', 'F-PLN', 'PERF', 'PROG', 'DATA', 'RADNAV'][n]; if (side === 'L' && t) this.page = t; return; }
    if (this.page === 'INIT') {
      if (side === 'L' && n === 2 && input) { st.flt = this.take().slice(0, 8); return; }
      if (side === 'R' && n === 1 && input) { const v = this.num(input.replace(/^FL/i, '')); if (v >= 100 && v <= 390) { st.crz = v; this.take(); h.setApTarget('alt', v * 100); } else this.setMsg('ENTRY OUT OF RANGE'); return; }
      if (side === 'L' && n === 5 && input) { const v = this.num(input); if (v >= 0 && v <= 200) { st.ci = v; this.take(); } else this.setMsg('ENTRY OUT OF RANGE'); return; }
      if (side === 'R' && n === 3 && input) { const v = this.num(input); if (v > 0) { st.zfw = v; this.take(); } return; }
      if (side === 'R' && n === 5) { this.page = 'PERF'; return; }
    }
    if (this.page === 'PERF') {
      const set = (key: 'v1' | 'vr' | 'v2') => { if (!input) return; const v = this.num(input); if (v >= 90 && v <= 200) { st[key] = v; this.take(); } else this.setMsg('ENTRY OUT OF RANGE'); };
      if (side === 'L' && n === 1) set('v1'); if (side === 'L' && n === 2) set('vr'); if (side === 'L' && n === 3) set('v2');
      if (side === 'R' && n === 3 && input) { const v = this.num(input); if (v >= 0 && v <= 70) { st.flex = v; this.take(); } }
      return;
    }
    if (this.page === 'F-PLN' && side === 'L' && n >= 1) { const rt = h.route(); const w = rt[this.sub + n - 2]; if (w && !input) { this.setMsg(`${w.name} SELECTED`); } return; }
    if (input && this.page !== 'MENU') this.setMsg('NOT ALLOWED');
  }
  draw(g: G, W: number, H: number, c: Ctx) {
    g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#04070b'; g.fillRect(0, 0, 1000, 1000);
    if (!c.sys.ac && !c.sys.acEss) return;
    const d = c.d, st = this.store, L = (i: number) => 76 + i * 64;
    const row = (i: number, l: string, r = '', cl = C.green, cr = C.green) => { T(g, l, 30, L(i), 40, cl, 'left', M); T(g, r, 970, L(i), 40, cr, 'right', M); };
    const small = (i: number, l: string, r = '') => { T(g, l, 30, L(i) - 32, 26, C.white, 'left', M); T(g, r, 970, L(i) - 32, 26, C.white, 'right', M); };
    const title = (s: string, sub = '') => { T(g, s, 500, 36, 44, C.white, 'center', M); if (sub) T(g, sub, 970, 36, 30, C.white, 'right', M); };
    const fp = c.host.route(); const brk = '[ ]';
    switch (this.page) {
      case 'MENU': title('MCDU MENU'); row(1, '<INIT', ''); row(2, '<F-PLN', ''); row(3, '<PERF', ''); row(4, '<PROG', ''); row(5, '<DATA', ''); row(6, '<RAD NAV'); T(g, 'FMGC', 970, 76, 30, C.white, 'right', M); break;
      case 'INIT': title('INIT', 'A'); small(1, 'CO RTE', 'FROM/TO'); row(1, '------------', c.host.route().length ? `${d.dest?.id ?? '----'}` : '----/----'); small(2, 'FLT NBR', 'ALTN/CO RTE'); row(2, st.flt, '----/---------', C.cyan); small(3, '', 'INIT REQUEST'); small(4, 'LAT', 'CRZ FL/TEMP'); row(1 + 0, '', ''); row(4, '----.-/-----.-', ''); T(g, `FL${st.crz}/${Math.round(-56.5 + 0)}°`, 970, L(1) + 0, 1, C.cyan); T(g, `FL${st.crz}`, 970, L(1) + 32, 40, C.cyan, 'right', M); small(5, 'COST INDEX', 'TROPO'); row(5, String(st.ci), '36090', C.cyan); small(3, 'ZFW/ZFWCG', ''); row(3, '', `${st.zfw.toFixed(1)}/ 25.0`, C.green, C.cyan); row(6, '', 'ALIGN IRS>', C.cyan, C.cyan); break;
      case 'F-PLN': { title('F-PLN', ''); T(g, `FROM`, 30, 76, 26, C.white, 'left', M); const pos = c.host.position(); void pos; row(1, d.dest ? 'PPOS' : '----', d.altFt > 0 ? `${pad(d.hdg, 3)}°` : '', C.white, C.green);
        const items = fp.slice(this.sub, this.sub + 5); items.forEach((w, i) => row(2 + i, w.name, i === 0 ? 'TO' : '', i === 0 ? C.mag : C.green, C.white)); if (!items.length) { row(2, '-----END OF F-PLN-----', '', C.white); row(3, '', ''); } else row(2 + items.length, '-----END OF F-PLN-----', '', C.white); break; }
      case 'PERF': title('TAKE OFF', ''); small(1, 'V1', 'FLAP/THS'); row(1, st.v1 ? String(st.v1) : brk, `${['0', '1', '2', '3', 'FULL'][c.host.fm.ctl.flapsIdx]}/UP0.0`, st.v1 ? C.cyan : C.cyan, C.cyan); small(2, 'VR', 'FLEX TO TEMP'); row(2, st.vr ? String(st.vr) : brk, `${st.flex}°`, C.cyan, C.cyan); small(3, 'V2', 'ENG OUT ACC'); row(3, st.v2 ? String(st.v2) : brk, '1500/1500', C.cyan, C.cyan); small(4, 'TRANS ALT', 'THR RED/ACC'); row(4, String(st.trans), '1500/1500', C.cyan, C.cyan); small(5, 'GW', 'VAPP');
        row(5, `${(c.host.fm.totalMass / 1000).toFixed(1)}`, `${d.vSpeeds ? Math.round(d.vSpeeds.vapp) : Math.round(speeds(c.host).vls + 5)}`, C.green, C.green); row(6, '<PHASE', 'NEXT PHASE>', C.white, C.white); break;
      case 'PROG': title('PROG', 'FL' + Math.round(d.altFt / 100)); small(1, 'CRZ', 'OPT   REC MAX'); row(1, `FL${st.crz}`, '', C.cyan); small(2, 'TO', 'DIST    EFOB'); row(2, d.dest?.id ?? '----', `${d.dest ? d.dest.distNm.toFixed(0) : '---'}   ${(c.host.fm.fuel / 1000).toFixed(1)}`, C.green, C.green); small(3, 'BRG/DIST', ''); row(3, d.activeWp ? `${d.activeWp.name}` : '----', d.activeWp ? `${d.activeWp.distNm.toFixed(0)}NM` : ''); small(4, 'XTK ERROR', 'ETA'); row(4, '0.0', d.dest ? `${pad((c.utc.getUTCHours() + Math.floor((d.dest.eteMin + c.utc.getUTCMinutes()) / 60)) % 24, 2)}${pad((c.utc.getUTCMinutes() + d.dest.eteMin) % 60, 2)}` : '----'); break;
      case 'RADNAV': title('RADIO NAV'); small(1, 'VOR1/FREQ', 'FREQ/VOR2'); row(1, '---/--.--', '--.--/---', C.cyan, C.cyan); small(2, 'CRS', 'CRS'); row(2, '---', '---', C.cyan, C.cyan); small(3, 'LS /FREQ', ''); row(3, d.ils?.valid ? `${d.ils.ident}/ ---` : '[ ]/[  ]', '', C.mag); small(4, 'CRS', ''); row(4, d.ils?.valid ? pad(d.apHdg, 3) : '---', '', C.cyan); break;
      case 'FUEL': title('FUEL PRED'); small(1, 'AT', 'EFOB'); row(1, d.dest?.id ?? '----', `${(c.host.fm.fuel / 1000 - 1.2).toFixed(1)}`); small(2, 'FOB', 'FLOW'); row(2, `${(c.host.fm.fuel / 1000).toFixed(1)}`, `${Math.round(c.host.fm.fuelFlow * 3600)} KG/H`); small(3, 'RTE RSV', 'FINAL'); row(3, '0.6', '2.4', C.cyan, C.cyan); break;
      case 'DATA': title('DATA INDEX'); row(1, '<POSITION MONITOR'); row(2, '<IRS MONITOR'); row(3, '<GPS MONITOR'); row(4, '<A/C STATUS'); T(g, 'A320-214 CFM56-5B4/P', 500, L(5), 30, C.white, 'center', M); T(g, 'IRS ' + (c.sys.sw['IR1ModeKnb'] === 0 ? 'OFF' : 'NAV'), 500, L(6), 30, C.green, 'center', M); break;
      case 'DIR': title('DIR TO'); row(1, '[    ]', '', C.cyan); fp.slice(0, 4).forEach((w, i) => row(2 + i, w.name, '', C.green)); break;
      case 'AIRPORT': title('AIRPORT'); row(1, d.dest?.id ?? '----', d.dest?.name?.slice(0, 18) ?? '', C.green, C.white); break;
    }
    // scratchpad
    T(g, this.msg || this.scratch + (Math.floor(c.t * 2) % 2 ? '_' : ' '), 30, 930, 42, this.msg ? C.amber : C.white, 'left', M);
    line(g, 20, 895, 980, 895, '#223', 2);
  }
}

// =============================================================== ISIS / FCU / clock
export function drawISIS(g: G, W: number, H: number, c: Ctx) {
  const d = c.d; g.setTransform(W / 400, 0, 0, H / 400, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 400, 400); if (!c.sys.dc) return;
  g.save(); g.translate(200, 200); g.rotate(d.bank); const o = d.pitch * 5; g.fillStyle = '#2a73c9'; g.fillRect(-300, -400 + o, 600, 400); g.fillStyle = '#7a4a1c'; g.fillRect(-300, o, 600, 400); line(g, -300, o, 300, o, '#fff', 3); g.restore();
  g.fillStyle = '#000'; g.fillRect(0, 0, 70, 400); g.fillRect(330, 0, 70, 400); T(g, Math.round(d.kias), 35, 200, 34, C.white); T(g, Math.round(d.altFt / 10) * 10, 365, 200, 30, C.white); T(g, 'SPD', 35, 40, 20, C.amber); T(g, 'ALT', 365, 40, 20, C.amber);
  g.strokeStyle = C.amber; g.lineWidth = 5; g.beginPath(); g.moveTo(130, 200); g.lineTo(190, 200); g.moveTo(210, 200); g.lineTo(270, 200); g.stroke(); T(g, c.sys.std ? 'STD' : Math.round(c.sys.qnh), 365, 370, 24, C.cyan);
}
/** FCU digits overlay: canvas covers the whole display strip; x positions map 1:1 to the model's `.ind` meshes. */
export function drawFCU(g: G, W: number, H: number, c: Ctx, zToX: (z: number) => number) {
  g.clearRect(0, 0, W, H); const d = c.d, sys = c.sys; if (!sys.ac && !sys.acEss) return;
  const px = H * 0.78, col = '#ffb23d';
  const seg = (z: number, s: string) => { g.font = `bold ${px}px ${M}`; g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = col; g.shadowBlur = H * 0.25; g.fillText(s, zToX(z) * W, H / 2); g.shadowBlur = 0; };
  seg(0.0985, sys.spdManaged ? '---' : sys.spdMach ? (d.apSpd / 600).toFixed(2).slice(1) : pad(d.apSpd, 3));
  seg(0.0575, sys.hdgManaged ? '---' : pad((d.apHdg + 360) % 360, 3));
  seg(-0.0435 + 0.0, sys.metric ? pad(d.apAlt * 0.3048 / 10, 4) + '0' : pad(d.apAlt, 5));
  seg(-0.0895, d.apOn && sys.vsMode ? (sys.vsTarget >= 0 ? '+' : '-') + pad(Math.abs(sys.vsTarget), 4) : '-----');
}
export function drawClock(g: G, W: number, H: number, c: Ctx) {
  g.setTransform(W / 400, 0, 0, H / 400, 0, 0); g.fillStyle = '#050505'; g.fillRect(0, 0, 400, 400); if (!c.sys.dc) return;
  const u = c.utc; T(g, `${pad(u.getUTCHours(), 2)}:${pad(u.getUTCMinutes(), 2)}:${pad(u.getUTCSeconds(), 2)}`, 200, 130, 62, C.amber, 'center', M); T(g, 'UTC', 200, 70, 28, C.white);
  const s = Math.floor(c.sys.chronoT); T(g, c.sys.chronoShow || c.sys.chronoRun || s ? `CHR ${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}` : `${pad(u.getUTCDate(), 2)}/${pad(u.getUTCMonth() + 1, 2)}`, 200, 270, 52, C.white, 'center', M);
}
export { off as _off };
