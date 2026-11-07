// Airbus-style display renderers drawn into canvases that replace the screen textures of the 3D flight deck:
// PFD, ND (ARC / ROSE / PLAN), E/WD, SD (13 system pages), MCDU, ISIS, FCU window strip and the clock.
// Every renderer works in a 1000 x 1000 (or W x H) virtual space so textures can be any resolution.
import type { PanelData } from '../instruments';
import type { A320Systems, CockpitHost, EcamPage } from './systems';
import { speeds } from './efisDisplays';
import { atmosphere } from '../physics';

type G = CanvasRenderingContext2D;
export interface Ctx { d: PanelData; sys: A320Systems; host: CockpitHost; t: number; mcdu: Mcdu; utc: Date }
const F = 'Arial, Helvetica, sans-serif', M = 'Consolas, "Courier New", monospace';
const C = { green: '#2bff4a', cyan: '#2ee6ff', amber: '#ffb000', red: '#ff3030', white: '#f4f4f4', mag: '#ff5cf0', sky: '#1d7fe0', gnd: '#7a4a1c', grey: '#8a96a3' };
function T(g: G, s: string | number, x: number, y: number, px: number, col = C.white, al: CanvasTextAlign = 'center', font = F) { g.font = `bold ${px}px ${font}`; g.fillStyle = col; g.textAlign = al; g.textBaseline = 'middle'; g.fillText(String(s), x, y); }
function line(g: G, x1: number, y1: number, x2: number, y2: number, col: string, w = 3) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');
const off = (g: G, W: number, H: number, msg = '') => { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); if (msg) { g.setTransform(1, 0, 0, 1, 0, 0); } };

// PFD / ND live in efisDisplays.ts (per-side EFIS state).
export { drawPFD, drawND, speeds, baroText } from './efisDisplays';

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
  if (sys.ecam.statusPending && sys.sdPage !== 'STS') T(g, 'STS', 900, 960, 30, C.white);   // status reminder
  if (sys.masterWarn || d.warn.some((w) => /STALL|FIRE/i.test(w))) { }
}

// =============================================================== SD
const SD_TITLES: Record<EcamPage, string> = { ENG: 'ENGINE', BLEED: 'BLEED', PRESS: 'CAB PRESS', ELEC: 'ELEC', HYD: 'HYD', FUEL: 'FUEL', APU: 'APU', COND: 'COND', DOOR: 'DOOR/OXY', WHEEL: 'WHEEL', 'F/CTL': 'F/CTL', STS: 'STATUS', CRZ: 'CRUISE' };
export function drawSD(g: G, W: number, H: number, c: Ctx) {
  const d = c.d, sys = c.sys, fm = c.host.fm, page = sys.sdPage;
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
    case 'STS': { const it = sys.ecam.statusItems; if (it.length) { lbl(500, 220, 'CANCELLED CAUTION', C.white, 34); it.slice(0, 7).forEach((w, k) => lbl(500, 300 + k * 52, w.toUpperCase().slice(0, 30), C.amber, 32)); } else lbl(500, 420, 'NORMAL', C.green, 56); break; }
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
  /** Screen brightness 0.15..1, stepped by the BRT / DIM keys. */
  brt = 1;
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
      case '.': this.add('.'); return; case '/': this.add('/'); return;
      // +/- : appends '-', then toggles the sign character at the end of the scratchpad ('-' <-> '+')
      case '+/-': { const l = this.scratch.slice(-1); if (l === '-') this.scratch = this.scratch.slice(0, -1) + '+'; else if (l === '+') this.scratch = this.scratch.slice(0, -1) + '-'; else this.add('-'); return; }
      case 'sp': this.add(' '); return;
      case 'clr': if (this.msg) this.msg = ''; else this.scratch = this.scratch.slice(0, -1); return;
      case 'BRT': this.brt = Math.min(1, +(this.brt + 0.15).toFixed(2)); return; case 'DIM': this.brt = Math.max(0.15, +(this.brt - 0.15).toFixed(2)); return;
      case 'init': this.page = 'INIT'; this.sub = 0; return; case 'f-pln': this.page = 'F-PLN'; this.sub = 0; return; case 'f-pln2': this.page = 'SEC'; this.sub = 0; return;
      case 'radnav': this.page = 'RADNAV'; this.sub = 0; return; case 'fuel-pred': this.page = 'FUEL'; this.sub = 0; return;
      case 'prog': this.page = 'PROG'; this.sub = 0; return; case 'perf': this.page = 'PERF'; this.sub = 0; return; case 'data': this.page = 'DATA'; this.sub = 0; return;
      case 'dir': this.page = 'DIR'; this.sub = 0; return; case 'airport': this.page = 'AIRPORT'; this.sub = 0; return; case 'menu': this.page = 'MENU'; this.sub = 0; return;
      // F-PLN scrolls with the arrow keys; the other pages have a single screen, so the keys are accepted and do nothing
      case 'up': case 'left': if (this.page === 'F-PLN') this.sub = Math.max(0, this.sub - 1); return;
      case 'down': case 'right': if (this.page === 'F-PLN') this.sub = Math.min(Math.max(0, this.host ? this.host.route().length - 1 : 0), this.sub + 1); return;
      case 'overfly': case 'opt1': case 'opt2': return; // no overfly / PERF-option behaviour is modelled
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
      case 'SEC': title('SEC F-PLN'); row(1, '<COPY ACTIVE'); row(2, '<INIT', ''); T(g, 'SECONDARY F-PLN NOT CREATED', 500, L(4), 30, C.white, 'center', M); break;
      case 'AIRPORT': title('AIRPORT'); row(1, d.dest?.id ?? '----', d.dest?.name?.slice(0, 18) ?? '', C.green, C.white); break;
    }
    // scratchpad
    T(g, this.msg || this.scratch + (Math.floor(c.t * 2) % 2 ? '_' : ' '), 30, 930, 42, this.msg ? C.amber : C.white, 'left', M);
    line(g, 20, 895, 980, 895, '#223', 2);
    if (this.brt < 1) { g.fillStyle = `rgba(0,0,0,${(1 - this.brt) * 0.85})`; g.fillRect(0, 0, 1000, 1000); }
  }
}

// =============================================================== ISIS / FCU / clock
export function drawISIS(g: G, W: number, H: number, c: Ctx) {
  const d = c.d; g.setTransform(W / 400, 0, 0, H / 400, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 400, 400); if (!c.sys.dc) return;
  g.save(); g.translate(200, 200); g.rotate(d.bank); const o = d.pitch * 5; g.fillStyle = '#2a73c9'; g.fillRect(-300, -400 + o, 600, 400); g.fillStyle = '#7a4a1c'; g.fillRect(-300, o, 600, 400); line(g, -300, o, 300, o, '#fff', 3); g.restore();
  g.fillStyle = '#000'; g.fillRect(0, 0, 70, 400); g.fillRect(330, 0, 70, 400); T(g, Math.round(d.kias), 35, 200, 34, C.white); T(g, Math.round(d.altFt / 10) * 10, 365, 200, 30, C.white); T(g, 'SPD', 35, 40, 20, C.amber); T(g, 'ALT', 365, 40, 20, C.amber);
  g.strokeStyle = C.amber; g.lineWidth = 5; g.beginPath(); g.moveTo(130, 200); g.lineTo(190, 200); g.moveTo(210, 200); g.lineTo(270, 200); g.stroke(); T(g, c.sys.isis.std ? 'STD' : Math.round(c.sys.isis.hpa), 365, 370, 24, C.cyan);
}
/** FCU digits overlay: canvas covers the whole display strip; x positions map 1:1 to the model's `.ind` meshes. */
export function drawFCU(g: G, W: number, H: number, c: Ctx, zToX: (z: number) => number) {
  g.clearRect(0, 0, W, H); const d = c.d, sys = c.sys; if (!sys.ac && !sys.acEss) return;
  const px = H * 0.68, col = '#ffb23d', f = d.mach > 0.05 && d.kias > 30 ? d.kias / d.mach : 661.5;
  g.globalAlpha = 0.4 + 0.6 * sys.bright.fcu;
  const seg = (z: number, s: string) => { g.font = `bold ${px}px ${M}`; g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = col; g.shadowBlur = H * 0.25; g.fillText(s, zToX(z) * W, H / 2); g.shadowBlur = 0; };
  const spd = (v: number) => sys.spdMach ? (v / f).toFixed(2).slice(1) : pad(v, 3);
  // managed (pushed) windows show dashes; a preselection made while managed is displayed until it times out (10 s SPD, 45 s HDG / V/S)
  seg(0.0985, sys.spdManaged ? (sys.spdPre > 0 ? spd(sys.spdPreVal) : '---') : spd(d.apSpd));
  seg(0.0575, sys.hdgManaged ? (sys.hdgPre > 0 ? pad(sys.hdgPreVal, 3) : '---') : pad(((Math.round(d.apHdg) % 360) + 360) % 360, 3));
  seg(-0.0435, pad(d.apAlt, 5));   // the ALT window is always feet; METRIC ALT only adds metres on the PFD / ECAM
  const vsShown = sys.vsMode || sys.vsPre > 0;
  seg(-0.0895, !vsShown ? '-----' : sys.trkFpa ? (sys.fpaTarget >= 0 ? '+' : '-') + Math.abs(sys.fpaTarget).toFixed(1) : (sys.vsTarget >= 0 ? '+' : '-') + pad(Math.abs(sys.vsTarget), 4));
  g.globalAlpha = 1;
}
/** EFIS BARO window (above the BARO knob): QNH in hPa / inHg, or "Std". */
export function drawBaro(g: G, W: number, H: number, c: Ctx, side: 0 | 1 = 0) {
  g.clearRect(0, 0, W, H); if (!c.sys.dc) return; const e = c.sys.efis[side], col = '#cfe8ff';
  g.fillStyle = '#05090e'; g.fillRect(0, 0, W, H);
  g.font = `bold ${H * 0.2}px ${M}`; g.fillStyle = '#7fa6d6'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BARO', W / 2, H * 0.17);
  g.font = `bold ${H * 0.52}px ${M}`; g.fillStyle = col; g.shadowColor = col; g.shadowBlur = H * 0.12;
  g.fillText(e.std ? 'Std' : e.unitInHg ? (e.inHg / 100).toFixed(2) : String(Math.round(e.hpa)).padStart(4, ' '), W / 2, H * 0.64); g.shadowBlur = 0;
}
export function drawClock(g: G, W: number, H: number, c: Ctx) {
  g.setTransform(W / 400, 0, 0, H / 400, 0, 0); g.fillStyle = '#050505'; g.fillRect(0, 0, 400, 400); if (!c.sys.dc) return;
  const u = c.utc; T(g, `${pad(u.getUTCHours(), 2)}:${pad(u.getUTCMinutes(), 2)}:${pad(u.getUTCSeconds(), 2)}`, 200, 130, 62, C.amber, 'center', M); T(g, 'UTC', 200, 70, 28, C.white);
  const s = Math.floor(c.sys.chronoT); T(g, c.sys.chronoShow || c.sys.chronoRun || s ? `CHR ${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}` : `${pad(u.getUTCDate(), 2)}/${pad(u.getUTCMonth() + 1, 2)}`, 200, 270, 52, C.white, 'center', M);
}
export { off as _off };
