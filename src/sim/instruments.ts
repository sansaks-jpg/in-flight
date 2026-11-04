// Canvas-drawn flight instruments used as textures in the 3D cockpit.
import { AircraftSpec } from './specs';

export interface PanelData {
  kias: number; altFt: number; vsFpm: number; hdg: number; trk: number; pitch: number; bank: number; slip: number; mach: number; gsKt: number;
  n1: number[]; fuelKg: number; fuelFrac: number; flapsIdx: number; flapsDet: number; gear: number; throttle: number; parking: boolean; reverse: boolean; spoilers: number;
  apOn: boolean; apHdg: number; apAlt: number; apSpd: number; apNav: boolean; apAppr: boolean; apVsMode: boolean;
  dest: { id: string; name: string; brg: number; distNm: number; eteMin: number } | null;
  ils: { valid: boolean; loc: number; gs: number; ident: string; distNm: number } | null;
  warn: string[]; aglFt: number; alphaFrac: number; time: number; thrustPct: number; fuelFlowKgH: number;
  wind?: { dir: number; kt: number; cross: number };
  activeWp?: { name: string; distNm: number; etaMin: number } | null;
  flightPhase?: string;
  vSpeeds?: { v1: number; vr: number; v2: number; vapp: number };
  qnhInHg?: number;
  oatC?: number;
}
const D = Math.PI / 180;
type C = CanvasRenderingContext2D;
const FONT = 'Arial, Helvetica, sans-serif';
function text(g: C, s: string, x: number, y: number, size: number, col = '#fff', align: CanvasTextAlign = 'center', bold = true) {
  g.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y);
}
function bezel(g: C, cx: number, cy: number, r: number) {
  g.fillStyle = '#0b0c0e'; g.beginPath(); g.arc(cx, cy, r + 8, 0, 7); g.fill();
  g.strokeStyle = '#555a60'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r + 6, 0, 7); g.stroke();
  g.fillStyle = '#0d0e10'; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
}
function needle(g: C, cx: number, cy: number, ang: number, len: number, w: number, col = '#fff', tail = 0.18) {
  g.save(); g.translate(cx, cy); g.rotate(ang); g.fillStyle = col;
  g.beginPath(); g.moveTo(-w / 2, len * tail); g.lineTo(-w / 2, -len * 0.85); g.lineTo(0, -len); g.lineTo(w / 2, -len * 0.85); g.lineTo(w / 2, len * tail); g.closePath(); g.fill(); g.restore();
}
function arc(g: C, cx: number, cy: number, r: number, a0: number, a1: number, col: string, w: number) {
  g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
}
// angle helper: dial value -> radians (0 = up)
const dialA = (v: number, v0: number, v1: number, a0: number, a1: number) => (a0 + ((v - v0) / (v1 - v0)) * (a1 - a0)) * D - Math.PI / 2;

function drawASI(g: C, cx: number, cy: number, r: number, d: PanelData, s: AircraftSpec) {
  bezel(g, cx, cy, r);
  const max = Math.ceil((s.vne + 20) / 20) * 20, a0 = 30, a1 = 330;
  const A = (v: number) => dialA(v, 0, max, a0, a1);
  arc(g, cx, cy, r * 0.86, A(s.vs0), A(s.vfe[1] || s.vs0 + 40), '#fff', 6);
  arc(g, cx, cy, r * 0.8, A(s.vs1), A(s.vne * 0.88), '#2bd35a', 8);
  arc(g, cx, cy, r * 0.8, A(s.vne * 0.88), A(s.vne), '#ffd23a', 8);
  g.strokeStyle = '#ff3030'; g.lineWidth = 5; g.beginPath(); g.moveTo(cx + Math.cos(A(s.vne)) * r * 0.7, cy + Math.sin(A(s.vne)) * r * 0.7); g.lineTo(cx + Math.cos(A(s.vne)) * r * 0.96, cy + Math.sin(A(s.vne)) * r * 0.96); g.stroke();
  const step = max > 300 ? 50 : 20;
  for (let v = 0; v <= max; v += step) {
    const a = A(v); g.strokeStyle = '#ddd'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); g.lineTo(cx + Math.cos(a) * r * 0.74, cy + Math.sin(a) * r * 0.74); g.stroke();
    if (v % (step * 2) === 0 || max < 250) text(g, String(v), cx + Math.cos(a) * r * 0.57, cy + Math.sin(a) * r * 0.57, r * 0.17, '#eee');
  }
  text(g, 'AIRSPEED', cx, cy - r * 0.28, r * 0.12, '#aaa'); text(g, 'KNOTS', cx, cy + r * 0.3, r * 0.12, '#aaa');
  needle(g, cx, cy, A(Math.min(max, d.kias)), r * 0.86, 7);
  g.fillStyle = '#333'; g.beginPath(); g.arc(cx, cy, 8, 0, 7); g.fill();
}
function drawAI(g: C, cx: number, cy: number, r: number, d: PanelData) {
  bezel(g, cx, cy, r);
  g.save(); g.beginPath(); g.arc(cx, cy, r - 2, 0, 7); g.clip();
  g.translate(cx, cy); g.rotate(d.bank * D * 0 - d.bank); // bank positive = right wing down -> horizon rotates counter-clockwise
  const py = d.pitch * (r / 28);
  g.fillStyle = '#2f79d6'; g.fillRect(-r * 2, -r * 2 + py, r * 4, r * 2);
  g.fillStyle = '#7a5230'; g.fillRect(-r * 2, py, r * 4, r * 2);
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.moveTo(-r * 2, py); g.lineTo(r * 2, py); g.stroke();
  for (let p = -30; p <= 30; p += 5) {
    if (p === 0) continue; const y = py - p * (r / 28), w = p % 10 === 0 ? r * 0.38 : r * 0.2;
    g.lineWidth = 2; g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
    if (p % 10 === 0) text(g, String(Math.abs(p)), -w - r * 0.14, y, r * 0.12, '#fff');
  }
  g.restore();
  g.save(); g.translate(cx, cy);
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { g.save(); g.rotate(a * D); g.strokeStyle = '#fff'; g.lineWidth = a % 30 === 0 ? 4 : 2; g.beginPath(); g.moveTo(0, -r * 0.94); g.lineTo(0, -r * (a % 30 === 0 ? 0.8 : 0.86)); g.stroke(); g.restore(); }
  g.rotate(-d.bank); g.fillStyle = '#ffd23a'; g.beginPath(); g.moveTo(0, -r * 0.93); g.lineTo(-9, -r * 0.8); g.lineTo(9, -r * 0.8); g.fill(); g.restore();
  g.strokeStyle = '#ffb300'; g.lineWidth = 6; g.beginPath(); g.moveTo(cx - r * 0.55, cy); g.lineTo(cx - r * 0.2, cy); g.lineTo(cx - r * 0.2, cy + 10); g.moveTo(cx + r * 0.55, cy); g.lineTo(cx + r * 0.2, cy); g.lineTo(cx + r * 0.2, cy + 10); g.stroke();
  g.fillStyle = '#ffb300'; g.fillRect(cx - 5, cy - 5, 10, 10);
}
function drawALT(g: C, cx: number, cy: number, r: number, d: PanelData) {
  bezel(g, cx, cy, r);
  for (let i = 0; i < 50; i++) { const a = (i / 50) * Math.PI * 2 - Math.PI / 2, big = i % 5 === 0; g.strokeStyle = '#ddd'; g.lineWidth = big ? 3 : 1.5; g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92); g.lineTo(cx + Math.cos(a) * r * (big ? 0.78 : 0.84), cy + Math.sin(a) * r * (big ? 0.78 : 0.84)); g.stroke(); if (big) text(g, String(i / 5), cx + Math.cos(a) * r * 0.64, cy + Math.sin(a) * r * 0.64, r * 0.2, '#fff'); }
  text(g, 'ALT', cx, cy - r * 0.3, r * 0.13, '#aaa'); text(g, '29.92', cx + r * 0.42, cy, r * 0.1, '#aaa');
  const a = (v: number) => (v / 1000) * Math.PI * 2 - Math.PI / 2;
  needle(g, cx, cy, a(d.altFt) + Math.PI / 2, r * 0.5, 10, '#fff', 0.1); needle(g, cx, cy, a(d.altFt * 10) + Math.PI / 2, r * 0.82, 6, '#fff', 0.2);
  needle(g, cx, cy, (d.altFt / 10000) * Math.PI * 2, r * 0.7, 4, '#ffd23a', 0.2);
  g.fillStyle = '#333'; g.beginPath(); g.arc(cx, cy, 8, 0, 7); g.fill();
}
function drawDG(g: C, cx: number, cy: number, r: number, d: PanelData) {
  bezel(g, cx, cy, r);
  g.save(); g.translate(cx, cy); g.rotate(-d.hdg * D);
  for (let a = 0; a < 360; a += 5) { g.save(); g.rotate(a * D); g.strokeStyle = '#ddd'; g.lineWidth = a % 10 === 0 ? 3 : 1.5; g.beginPath(); g.moveTo(0, -r * 0.92); g.lineTo(0, -r * (a % 10 === 0 ? 0.8 : 0.86)); g.stroke();
    if (a % 30 === 0) { const lab = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10); g.translate(0, -r * 0.64); text(g, lab, 0, 0, r * 0.19, a % 90 === 0 ? '#ffd23a' : '#fff'); } g.restore(); }
  if (d.apOn || true) { g.save(); g.rotate(d.apHdg * D); g.fillStyle = '#ff4fd8'; g.fillRect(-9, -r * 0.97, 18, 12); g.restore(); }
  if (d.dest) { g.save(); g.rotate(d.dest.brg * D); g.strokeStyle = '#ff4fd8'; g.lineWidth = 5; g.beginPath(); g.moveTo(0, -r * 0.6); g.lineTo(0, -r * 0.2); g.moveTo(0, r * 0.2); g.lineTo(0, r * 0.5); g.stroke(); g.fillStyle = '#ff4fd8'; g.beginPath(); g.moveTo(0, -r * 0.62); g.lineTo(-10, -r * 0.45); g.lineTo(10, -r * 0.45); g.fill(); g.restore(); }
  g.restore();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx, cy - 22); g.lineTo(cx - 20, cy + 22); g.lineTo(cx, cy + 12); g.lineTo(cx + 20, cy + 22); g.fill();
  g.fillStyle = '#ffd23a'; g.fillRect(cx - 3, cy - r - 4, 6, 16);
  text(g, `${Math.round(d.hdg).toString().padStart(3, '0')}°`, cx, cy + r * 0.38, r * 0.16, '#fff');
}
function drawVSI(g: C, cx: number, cy: number, r: number, d: PanelData) {
  bezel(g, cx, cy, r);
  const A = (v: number) => dialA(Math.max(-2000, Math.min(2000, v)), -2000, 2000, 90 - 160 + 0, 90 + 160 - 0) ;
  const A2 = (v: number) => ((Math.max(-2000, Math.min(2000, v)) / 2000) * 160 + 270) * D - Math.PI / 2 + Math.PI / 2 * 0;
  void A;
  const ang = (v: number) => (-90 + 180 - (Math.max(-2000, Math.min(2000, v)) / 2000) * 160 + 0) * D * 0 + ((Math.max(-2000, Math.min(2000, v)) / 2000) * 160 + 270) * D * 0;
  void A2; void ang;
  const aa = (v: number) => (Math.PI - (Math.max(-2000, Math.min(2000, v)) / 2000) * 2.7925) ; // 0 fpm at 9 o'clock (left)
  for (let v = -2000; v <= 2000; v += 500) { const a = aa(v); g.strokeStyle = '#ddd'; g.lineWidth = v % 1000 === 0 ? 3 : 2; g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.9, cy - Math.sin(a) * r * 0.9); g.lineTo(cx + Math.cos(a) * r * 0.76, cy - Math.sin(a) * r * 0.76); g.stroke(); if (v % 1000 === 0 || v === 0) text(g, String(Math.abs(v) / 100), cx + Math.cos(a) * r * 0.6, cy - Math.sin(a) * r * 0.6, r * 0.17, '#fff'); }
  text(g, 'VERTICAL', cx, cy - r * 0.26, r * 0.1, '#aaa'); text(g, 'SPEED', cx, cy - r * 0.14, r * 0.1, '#aaa'); text(g, 'x100 FPM', cx, cy + r * 0.38, r * 0.1, '#aaa');
  const a = aa(d.vsFpm); g.save(); g.translate(cx, cy); g.rotate(-a + Math.PI / 2); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(-3.5, 0); g.lineTo(-3.5, -r * 0.82); g.lineTo(0, -r * 0.88); g.lineTo(3.5, -r * 0.82); g.lineTo(3.5, 0); g.fill(); g.restore();
  g.fillStyle = '#333'; g.beginPath(); g.arc(cx, cy, 7, 0, 7); g.fill();
}
function drawEngineDial(g: C, cx: number, cy: number, r: number, d: PanelData, s: AircraftSpec) {
  bezel(g, cx, cy, r);
  const pct = (d.n1[0] || 0) * 100;
  const A = (v: number) => dialA(v, 0, 100, 40, 320);
  arc(g, cx, cy, r * 0.82, A(0), A(75), '#2bd35a', 8); arc(g, cx, cy, r * 0.82, A(75), A(92), '#ffd23a', 8); arc(g, cx, cy, r * 0.82, A(92), A(100), '#ff3030', 8);
  for (let v = 0; v <= 100; v += 10) { const a = A(v); g.strokeStyle = '#ddd'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); g.lineTo(cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72); g.stroke(); if (v % 20 === 0) text(g, String(v / 10), cx + Math.cos(a) * r * 0.56, cy + Math.sin(a) * r * 0.56, r * 0.16, '#fff'); }
  text(g, s.kind === 'piston' ? 'RPM x270' : 'TORQUE %', cx, cy - r * 0.25, r * 0.11, '#aaa');
  text(g, `FUEL ${Math.round(d.fuelKg)}kg`, cx, cy + r * 0.34, r * 0.12, d.fuelFrac < 0.15 ? '#ff5555' : '#9fe5a6');
  needle(g, cx, cy, A(pct), r * 0.84, 7); g.fillStyle = '#333'; g.beginPath(); g.arc(cx, cy, 8, 0, 7); g.fill();
}
export function drawSteam(g: C, W: number, H: number, d: PanelData, s: AircraftSpec) {
  g.fillStyle = '#1a1c1f'; g.fillRect(0, 0, W, H);
  const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#2a2d31'); grd.addColorStop(1, '#17181a'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const r = 108;
  drawASI(g, 170, 150, r, d, s); drawAI(g, 420, 150, r, d); drawALT(g, 670, 150, r, d);
  drawDG(g, 170, 372, r, d); drawVSI(g, 420, 372, r, d); drawEngineDial(g, 670, 372, r, d, s);
  // annunciators
  const ann = (x: number, y: number, label: string, on: boolean, col: string) => { g.fillStyle = on ? col : '#2a1d1d'; g.fillRect(x, y, 100, 34); text(g, label, x + 50, y + 17, 17, on ? '#111' : '#554'); };
  ann(850, 28, 'STALL', d.warn.includes('STALL'), '#ff3b3b'); ann(850, 72, 'GEAR UNSAFE', d.gear > 0.02 && d.gear < 0.98, '#ffb020'); ann(850, 116, 'OVERSPEED', d.warn.includes('OVERSPEED'), '#ff3b3b');
  ann(850, 160, 'PARK BRK', d.parking, '#ffb020'); ann(850, 204, 'LOW FUEL', d.fuelFrac < 0.15, '#ffb020'); ann(850, 248, d.apOn ? 'AP ENGD' : 'AP OFF', d.apOn, '#38e07a');
  text(g, `FLAPS ${d.flapsIdx}/${d.flapsDet}`, 900, 306, 22, '#fff'); text(g, d.gear > 0.98 ? 'GEAR DOWN' : d.gear < 0.02 ? 'GEAR UP' : 'GEAR ...', 900, 336, 22, d.gear > 0.98 ? '#38e07a' : '#ffd23a');
  text(g, `GS ${Math.round(d.gsKt)} kt`, 900, 380, 22, '#8fd0ff'); text(g, `AGL ${Math.round(d.aglFt)} ft`, 900, 410, 22, '#8fd0ff');
  if (d.dest) { text(g, `${d.dest.id}  ${Math.round(d.dest.distNm)} nm`, 900, 450, 20, '#ff9bea'); }
}

// ----------------------------- glass cockpit -----------------------------
export function drawPFD(g: C, W: number, H: number, d: PanelData, s: AircraftSpec) {
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H * 0.5;
  g.save(); g.beginPath(); g.rect(60, 50, W - 120, H - 110); g.clip(); g.translate(cx, cy); g.rotate(-d.bank);
  const ppd = 7.2, py = d.pitch * ppd;
  const sky = g.createLinearGradient(0, -400 + py, 0, py); sky.addColorStop(0, '#104ea6'); sky.addColorStop(1, '#458ee2'); g.fillStyle = sky; g.fillRect(-600, -600 + py, 1200, 600);
  const gr = g.createLinearGradient(0, py, 0, py + 400); gr.addColorStop(0, '#754b23'); gr.addColorStop(1, '#3b220e'); g.fillStyle = gr; g.fillRect(-600, py, 1200, 600);
  g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-600, py); g.lineTo(600, py); g.stroke();
  for (let p = -30; p <= 30; p += 2.5) {
    if (p === 0) continue;
    const y = py - p * ppd, w = p % 10 === 0 ? 60 : p % 5 === 0 ? 34 : 16;
    g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
    if (p % 10 === 0) { text(g, String(Math.abs(p)), -w - 18, y, 15); text(g, String(Math.abs(p)), w + 18, y, 15); }
  }
  g.restore();

  // Flight Path Vector (FPV bird) on PFD
  const fpaDeg = Math.atan2(d.vsFpm * 0.00508, Math.max(1, d.gsKt * 0.514444)) * (180 / Math.PI);
  const fpvY = cy - fpaDeg * 7.2;
  const fpvX = cx + ((d.trk - d.hdg + 540) % 360 - 180) * 4.4;
  g.save();
  g.beginPath(); g.rect(60, 50, W - 120, H - 110); g.clip();
  g.strokeStyle = '#22d3ee'; g.lineWidth = 2;
  g.beginPath(); g.arc(fpvX, fpvY, 7, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(fpvX - 14, fpvY); g.lineTo(fpvX - 7, fpvY); g.moveTo(fpvX + 7, fpvY); g.lineTo(fpvX + 14, fpvY); g.moveTo(fpvX, fpvY - 7); g.lineTo(fpvX, fpvY - 14); g.stroke();
  g.restore();

  // roll scale
  g.save(); g.translate(cx, cy); g.strokeStyle = '#fff'; g.lineWidth = 2;
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) { g.save(); g.rotate(a * D); g.beginPath(); g.moveTo(0, -150); g.lineTo(0, -(a % 30 === 0 ? 132 : 140)); g.stroke(); g.restore(); }
  g.rotate(-d.bank); g.fillStyle = '#ffd23a'; g.beginPath(); g.moveTo(0, -148); g.lineTo(-9, -132); g.lineTo(9, -132); g.fill(); g.restore();
  g.strokeStyle = '#ffd23a'; g.lineWidth = 5; g.beginPath(); g.moveTo(cx - 90, cy); g.lineTo(cx - 35, cy); g.lineTo(cx - 35, cy + 12); g.moveTo(cx + 90, cy); g.lineTo(cx + 35, cy); g.lineTo(cx + 35, cy + 12); g.stroke(); g.fillStyle = '#ffd23a'; g.fillRect(cx - 4, cy - 4, 8, 8);

  // speed tape
  g.fillStyle = 'rgba(15,18,22,0.92)'; g.fillRect(0, 50, 60, H - 110);
  g.save(); g.beginPath(); g.rect(0, 50, 60, H - 110); g.clip();
  const spdPx = 2.6; for (let v = Math.max(0, Math.floor(d.kias / 10) * 10 - 60); v <= d.kias + 70; v += 10) { const y = cy - (v - d.kias) * spdPx; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(48, y); g.lineTo(60, y); g.stroke(); if (v % 20 === 0) text(g, String(v), 24, y, 16); }
  const y1 = cy - (s.vs1 * 1.13 - d.kias) * spdPx; g.fillStyle = '#ffb000'; g.fillRect(56, Math.max(50, y1), 4, 600); // low-speed amber
  g.fillStyle = '#ff2020'; const yv = cy - (s.vne - d.kias) * spdPx; g.fillRect(56, -100, 4, yv + 100);

  // V-speeds on tape
  if (d.vSpeeds) {
    const vrY = cy - (d.vSpeeds.vr - d.kias) * spdPx;
    if (vrY >= 50 && vrY <= H - 60) {
      g.fillStyle = '#f59e0b'; g.font = 'bold 11px Arial'; text(g, 'R', 50, vrY, 11, '#f59e0b');
    }
  }

  // AP target speed bug
  if (d.apOn) {
    const bugY = cy - (d.apSpd - d.kias) * spdPx;
    if (bugY >= 50 && bugY <= H - 60) {
      g.fillStyle = '#06b6d4'; g.beginPath(); g.moveTo(60, bugY); g.lineTo(52, bugY - 5); g.lineTo(52, bugY + 5); g.fill();
    }
  }
  g.restore();

  g.fillStyle = '#000'; g.fillRect(0, cy - 16, 62, 32); g.strokeStyle = '#ffd23a'; g.lineWidth = 2; g.strokeRect(1, cy - 16, 60, 32); text(g, String(Math.round(d.kias)), 31, cy, 24, '#fff');
  text(g, `GS ${Math.round(d.gsKt)}`, 30, H - 90, 13, '#38bdf8');
  text(g, `M.${Math.round(d.mach * 100).toString().padStart(2, '0')}`, 30, H - 70, 14, '#ccc');

  // alt tape
  g.fillStyle = 'rgba(15,18,22,0.92)'; g.fillRect(W - 80, 50, 80, H - 110);
  g.save(); g.beginPath(); g.rect(W - 80, 50, 80, H - 110); g.clip();
  const altPx = 0.36; for (let v = Math.floor(d.altFt / 100) * 100 - 500; v <= d.altFt + 600; v += 100) { const y = cy - (v - d.altFt) * altPx; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(W - 80, y); g.lineTo(W - 68, y); g.stroke(); if (v % 200 === 0) text(g, String(v), W - 38, y, 15); }
  const ya = cy - (d.apAlt - d.altFt) * altPx; g.fillStyle = '#ff4fd8'; g.fillRect(W - 84, Math.max(52, Math.min(H - 62, ya)) - 6, 10, 12);
  g.restore();

  g.fillStyle = '#000'; g.fillRect(W - 84, cy - 16, 84, 32); g.strokeStyle = '#ffd23a'; g.strokeRect(W - 83, cy - 16, 82, 32); text(g, String(Math.round(d.altFt / 20) * 20), W - 42, cy, 22, '#fff');
  text(g, String(Math.round(d.apAlt)), W - 42, 38, 17, '#ff7aea');
  // Baro & Radar Altimeter
  if (d.aglFt < 2500) {
    text(g, `RA ${Math.round(d.aglFt)}`, W - 42, H - 90, 14, d.aglFt < 400 ? '#f59e0b' : '#34d399');
  } else {
    text(g, '29.92IN', W - 42, H - 90, 13, '#94a3b8');
  }

  // vertical speed
  text(g, `${d.vsFpm >= 0 ? '+' : ''}${Math.round(d.vsFpm / 50) * 50}`, W - 40, H - 70, 16, Math.abs(d.vsFpm) > 2000 ? '#ff9a3a' : '#7dff9a');

  // heading tape
  g.fillStyle = 'rgba(15,18,22,0.92)'; g.fillRect(60, H - 52, W - 120, 52); g.save(); g.beginPath(); g.rect(60, H - 52, W - 120, 52); g.clip();
  for (let a = -40; a <= 40; a += 5) { const hv = Math.round((d.hdg + a) / 5) * 5, x = cx + (hv - d.hdg) * 4.4 + 0; g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(x, H - 52); g.lineTo(x, H - 42); g.stroke(); if (hv % 10 === 0) text(g, String(((hv % 360) + 360) % 360 / 10).padStart(2, '0'), x, H - 24, 15); }
  const bug = ((d.apHdg - d.hdg + 540) % 360) - 180; g.fillStyle = '#ff4fd8'; g.fillRect(cx + bug * 4.4 - 5, H - 52, 10, 9);
  // Track diamond
  const trkDiff = ((d.trk - d.hdg + 540) % 360) - 180;
  g.fillStyle = '#d946ef'; g.beginPath(); g.arc(cx + trkDiff * 4.4, H - 46, 4, 0, Math.PI * 2); g.fill();
  g.restore(); g.fillStyle = '#ffd23a'; g.beginPath(); g.moveTo(cx, H - 53); g.lineTo(cx - 7, H - 62); g.lineTo(cx + 7, H - 62); g.fill();

  // Wind readout & Waypoint
  if (d.wind) {
    text(g, `WIND ${d.wind.dir}°/${d.wind.kt}kt`, 100, 64, 12, '#38bdf8', 'left');
  }
  if (d.activeWp) {
    text(g, `WPT ${d.activeWp.name} ${d.activeWp.distNm.toFixed(1)}nm`, W - 90, 64, 12, '#a855f7', 'right');
  }

  // ILS
  if (d.ils && d.ils.valid) {
    const dots = (v: number) => Math.max(-2.4, Math.min(2.4, v)) * 20;
    g.fillStyle = '#fff'; for (let i = -2; i <= 2; i++) { g.beginPath(); g.arc(cx + i * 20, H - 78, 3, 0, 7); g.fill(); g.beginPath(); g.arc(W - 100, cy + i * 20, 3, 0, 7); g.fill(); }
    g.fillStyle = '#ff4fd8'; g.fillRect(cx + dots(d.ils.loc) - 4, H - 88, 8, 20); g.fillRect(W - 110, cy + dots(-d.ils.gs) - 4, 20, 8);
    text(g, `${d.ils.ident} ${d.ils.distNm.toFixed(1)}nm`, cx, 64, 14, '#ff7aea');
  }
  // FMA
  g.fillStyle = '#0a0a0a'; g.fillRect(60, 0, W - 120, 48);
  const fma = (x: number, label: string, on: boolean) => text(g, label, x, 24, 19, on ? '#37ff7a' : '#444');
  fma(120, d.apAppr ? 'LOC/G/S' : d.apNav ? 'NAV' : 'HDG', d.apOn); fma(215, d.apVsMode ? 'V/S' : 'ALT', d.apOn); fma(290, 'SPD', d.apOn); fma(360, d.apOn ? 'AP 1' : 'AP OFF', d.apOn);
  if (d.warn.length) { g.fillStyle = '#d00'; g.fillRect(cx - 70, 70, 140, 34); text(g, d.warn[0], cx, 87, 20, '#fff'); }
}
export function drawND(g: C, W: number, H: number, d: PanelData, _s: AircraftSpec) {
  g.fillStyle = '#04070a'; g.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H * 0.84, R = 330, range = d.dest ? Math.max(20, Math.min(320, Math.ceil(d.dest.distNm * 1.1 / 20) * 20)) : 40;
  g.save(); g.translate(cx, cy);
  g.strokeStyle = '#1b4a5a'; g.lineWidth = 2;
  for (const f of [0.25, 0.5, 0.75, 1]) { g.beginPath(); g.arc(0, 0, R * f, Math.PI, 0); g.stroke(); }
  g.rotate(-d.hdg * D);
  for (let a = 0; a < 360; a += 5) { g.save(); g.rotate(a * D); g.strokeStyle = '#cfd'; g.lineWidth = a % 10 === 0 ? 3 : 1.5; g.beginPath(); g.moveTo(0, -R); g.lineTo(0, -R + (a % 10 === 0 ? 20 : 10)); g.stroke(); if (a % 30 === 0) { g.translate(0, -R + 36); text(g, a === 0 ? 'N' : String(a / 10), 0, 0, 18, '#fff'); } g.restore(); }
  if (d.dest) {
    g.save(); g.rotate(d.dest.brg * D); const rr = Math.min(R, (d.dest.distNm / range) * R);
    g.strokeStyle = '#ff4fd8'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -rr); g.stroke();
    g.fillStyle = '#ff4fd8'; g.translate(0, -rr); g.beginPath(); g.moveTo(0, -12); g.lineTo(10, 8); g.lineTo(-10, 8); g.fill(); g.rotate(-(d.dest.brg - 0) * D + d.hdg * D); text(g, d.dest.id, 0, 30, 18, '#ff9bea'); g.restore();
  }
  g.restore();
  g.fillStyle = '#ffd23a'; g.beginPath(); g.moveTo(cx, cy - 26); g.lineTo(cx - 18, cy + 18); g.lineTo(cx, cy + 8); g.lineTo(cx + 18, cy + 18); g.fill();
  text(g, `${Math.round(d.gsKt)}kt`, 50, 30, 20, '#fff', 'left'); text(g, `TRK ${Math.round(d.trk).toString().padStart(3, '0')}`, W - 20, 30, 20, '#7dff9a', 'right');
  text(g, `${range}nm`, W - 20, H * 0.5, 16, '#6bc'); text(g, `${Math.round(d.hdg).toString().padStart(3, '0')}°`, cx, 30, 26, '#fff');
  if (d.dest) { text(g, `${d.dest.id}  ${d.dest.distNm.toFixed(0)} nm   ETE ${Math.floor(d.dest.eteMin / 60)}:${String(Math.floor(d.dest.eteMin % 60)).padStart(2, '0')}`, cx, H - 20, 20, '#ff9bea'); }
  text(g, 'WIND', 50, 70, 14, '#8cf', 'left');
}
export function drawEICAS(g: C, W: number, H: number, d: PanelData, _s: AircraftSpec) {
  g.fillStyle = '#05080b'; g.fillRect(0, 0, W, H);
  const bar = (x: number, label: string, v: number, col: string) => { text(g, label, x, 30, 20, '#9ad'); g.strokeStyle = '#334'; g.lineWidth = 3; g.strokeRect(x - 28, 50, 56, 190); g.fillStyle = col; g.fillRect(x - 24, 238 - 186 * v, 48, 186 * v); text(g, (v * 100).toFixed(0), x, 262, 24, '#fff'); };
  const n = d.n1.length ? d.n1 : [0, 0]; bar(90, 'N1 L', n[0], n[0] > 0.97 ? '#ff4040' : '#37ff7a'); bar(180, 'N1 R', n[1] ?? n[0], (n[1] ?? n[0]) > 0.97 ? '#ff4040' : '#37ff7a');
  text(g, 'FUEL', 330, 30, 20, '#9ad'); text(g, `${Math.round(d.fuelKg)} kg`, 330, 70, 28, d.fuelFrac < 0.12 ? '#ff5555' : '#fff'); text(g, `FF ${Math.round(d.fuelFlowKgH)} kg/h`, 330, 106, 18, '#8cf');
  text(g, 'FLAPS', 330, 160, 18, '#9ad'); text(g, ['UP', '1', '1+F', '2', '3', 'FULL'][d.flapsIdx] || String(d.flapsIdx), 330, 190, 26, '#37ff7a');
  const lamp = (x: number, y: number, label: string, on: boolean, col: string) => { g.fillStyle = on ? col : '#1a2229'; g.fillRect(x, y, 100, 30); text(g, label, x + 50, y + 15, 16, on ? '#001' : '#456'); };
  lamp(30, 290, d.gear > 0.98 ? 'GEAR DN' : d.gear < 0.02 ? 'GEAR UP' : 'GEAR ...', d.gear > 0.98, '#37ff7a'); lamp(140, 290, 'SPOILER', d.spoilers > 0.1, '#ffb020'); lamp(250, 290, 'REVERSE', d.reverse, '#ffb020');
  lamp(30, 330, 'PARK BRK', d.parking, '#ffb020'); lamp(140, 330, 'AUTOPILOT', d.apOn, '#37ff7a'); lamp(250, 330, d.apAppr ? 'APPR' : d.apNav ? 'NAV' : 'HDG', d.apOn, '#37ff7a');
  d.warn.slice(0, 4).forEach((w, i) => text(g, w, W / 2, 390 + i * 26, 22, i === 0 ? '#ff5050' : '#ffb020'));
  if (!d.warn.length) text(g, 'NO WARNINGS', W / 2, 410, 18, '#2a5');
  text(g, `THR ${Math.round(d.thrustPct)}%`, 330, 240, 22, '#fff');
}
