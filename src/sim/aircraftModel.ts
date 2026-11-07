// Original, fully procedural exterior models of the three aircraft (no imported meshes).
// Everything is authored in metres at 1:1 scale from the dimensions in specs.ts and the manufacturers' published data
// (length, span, height, track, wheelbase, engine / propeller diameter). Body frame: +X right, +Y up, -Z forward,
// origin = centre of gravity; the wheel contact points come straight from `spec.gear`, so wheels touch the ground exactly
// where the flight model puts them. The pilot's eye (`spec.eye`) sits inside the real cockpit volume of each model.
import * as THREE from 'three';
import { AircraftSpec } from './specs';
import { FlightModel } from './physics';
import { fuselage, Sta, Wing, WingSec, strut, wheel, propBlade, loft, V3 } from './aircraftGeo';

export interface AircraftVisual {
  root: THREE.Group; update(fm: FlightModel, dt: number, time: number, lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean }): void;
  setVisible(v: boolean): void; setInterior(v: boolean): void; bodyParts: THREE.Object3D[]; engineGlow: THREE.Object3D[];
}
export async function loadAircraftVisual(spec: AircraftSpec): Promise<AircraftVisual> { return buildAircraftModel(spec); }

interface Panel { pivot: THREE.Group; axis: THREE.Vector3 }
const D2R = Math.PI / 180;

/** Fuselage skin texture: paint scheme, window rows, doors, panel lines and titles (paint is in true metres). */
function livery(spec: AircraftSpec, len: number, o: {
  win?: { d0: number; d1: number; pitch: number; w: number; h: number; phi: number; skip: [number, number][] };
  doors?: { d: number; w: number; h: number; phi: number }[]; stripe?: { phi: number; w: number; d0: number; d1: number; col?: string };
  title?: { s: string; d: number; size: number; phi: number }; belly?: [number, number]; nose?: number; panelEvery?: number; tailTo?: string;
}) {
  // Headless guard: node tests build these models to verify the 1:1 geometry. Without a DOM there
  // is no canvas — the material simply renders unpainted (colour-only) instead of crashing.
  if (typeof document === 'undefined') return null;
  const W = 1024, pxM = Math.max(40, Math.min(70, 2200 / len)), H = Math.round(len * pxM), c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!, hex = (n: number) => '#' + n.toString(16).padStart(6, '0'), body = hex(spec.color), acc = hex(spec.accent);
  const U = (deg: number) => (deg / 360) * W, Y = (d: number) => H - d * pxM; // d metres from the nose tip
  g.fillStyle = body; g.fillRect(0, 0, W, H);
  // soft belly shade
  const bellyA = o.belly ?? [128, 232]; const gr = g.createLinearGradient(U(bellyA[0] - 30), 0, U(bellyA[1] + 30), 0);
  gr.addColorStop(0, 'rgba(120,130,140,0)'); gr.addColorStop(0.25, 'rgba(120,130,140,0.55)'); gr.addColorStop(0.75, 'rgba(120,130,140,0.55)'); gr.addColorStop(1, 'rgba(120,130,140,0)');
  g.fillStyle = gr; g.fillRect(U(bellyA[0] - 30), 0, U(bellyA[1] + 30) - U(bellyA[0] - 30), H);
  if (o.nose) { g.fillStyle = '#cfd5da'; g.fillRect(0, Y(o.nose), W, o.nose * pxM); }
  // panel lines
  g.strokeStyle = 'rgba(70,80,90,0.28)'; g.lineWidth = 1; for (let d = o.panelEvery ?? 3.2; d < len; d += o.panelEvery ?? 3.2) { g.beginPath(); g.moveTo(0, Y(d)); g.lineTo(W, Y(d)); g.stroke(); }
  for (const phi of [10, 45, 135, 180, 225, 315, 350]) { g.beginPath(); g.moveTo(U(phi), 0); g.lineTo(U(phi), H); g.stroke(); }
  const sides = [{ u: 90, s: 1 }, { u: 270, s: -1 }];
  if (o.stripe) for (const sd of sides) { g.fillStyle = o.stripe.col ?? acc; const ph = sd.s > 0 ? o.stripe.phi : 360 - o.stripe.phi; g.fillRect(U(ph - o.stripe.w / 2), Y(o.stripe.d1), U(o.stripe.w) , (o.stripe.d1 - o.stripe.d0) * pxM); }
  if (o.tailTo) { g.fillStyle = o.tailTo; g.fillRect(0, 0, W, Y(len - 1.3)); }
  for (const dr of o.doors ?? []) for (const sd of sides) {
    const ph = sd.s > 0 ? dr.phi : 360 - dr.phi, dphi = (dr.h / (spec.height > 6 ? 2.0 : 1.4)) * (180 / Math.PI);
    g.strokeStyle = 'rgba(40,50,60,0.75)'; g.lineWidth = 2; g.strokeRect(U(ph - dphi / 2), Y(dr.d + dr.w), U(dphi), dr.w * pxM);
    g.fillStyle = '#17212b'; g.fillRect(U(ph - dphi * 0.22), Y(dr.d + dr.w * 0.62), U(dphi * 0.2), dr.w * 0.3 * pxM);
  }
  if (o.win) {
    const w = o.win; g.fillStyle = '#10161d';
    for (let d = w.d0; d < w.d1; d += w.pitch) {
      if (w.skip.some(([a, b]) => d + w.w > a && d < b)) continue;
      for (const sd of sides) { const ph = sd.s > 0 ? w.phi : 360 - w.phi, dphi = (w.h / (spec.height > 6 ? 1.975 : 1.2)) * (180 / Math.PI); g.beginPath(); g.roundRect(U(ph - dphi / 2), Y(d + w.w), U(dphi), w.w * pxM, 3); g.fill(); }
    }
  }
  if (o.title) {
    g.fillStyle = acc; g.font = `700 ${Math.round(o.title.size * pxM)}px "Helvetica Neue", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    // starboard: reading direction towards the nose (canvas down); port: towards the tail (canvas up) – both read left-to-right from outside
    g.save(); g.setTransform(0, 1, 1, 0, U(o.title.phi), Y(o.title.d)); g.fillText(o.title.s, 0, 0); g.restore();
    g.save(); g.setTransform(0, -1, -1, 0, U(360 - o.title.phi), Y(o.title.d)); g.fillText(o.title.s, 0, 0); g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = THREE.RepeatWrapping; return t;
}

export function buildAircraftModel(spec: AircraftSpec): AircraftVisual {
  const root = new THREE.Group(); root.name = `aircraft-${spec.id}`;
  const jet = spec.id === 'sky', trek = spec.id === 'trek';
  const std = (color: number, rough: number, metal: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  const accent = std(spec.accent, 0.38, 0.15), dark = std(0x1a1e23, 0.55, 0.3), metal = std(0x9aa3ab, 0.32, 0.85), rubber = std(0x101112, 0.95, 0), steel = std(0x5d646b, 0.4, 0.8);
  const glass = std(0x0a141d, 0.06, 0.85, { transparent: true, opacity: 0.9 }), panelMat = std(0xe3e7ea, 0.4, 0.2), wingMat = std(0xeef1f3, 0.36, 0.15);
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, p?: V3, parent: THREE.Object3D = root) => { const o = new THREE.Mesh(g, m); if (p) o.position.set(...p); parent.add(o); return o; };
  const flaps: Panel[] = [], ailerons: Panel[] = [], spoilers: Panel[] = [], elevators: Panel[] = [], rudders: Panel[] = [];
  const navs: THREE.Mesh[] = [], strobes: THREE.Mesh[] = [];
  const bulb = (c: number, r: number, p: V3, parent: THREE.Object3D = root, list?: THREE.Mesh[]) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshBasicMaterial({ color: c })); m.position.set(...p); parent.add(m); list?.push(m); return m; };

  // ---------- per-type authored data ----------
  const zN = jet ? -15.9 : trek ? -12.9 : -2.4;                 // nose tip (z); tail tip = zN + length
  const L = spec.length;
  const Z = (d: number) => zN + d;                              // metres aft of the nose tip -> body z
  let stas: Sta[];
  if (jet) {
    const R = 1.975, c = (d: number, w: number, top: number, bot: number, yc: number, n = 2.1): Sta => ({ z: Z(d), w, top, bot, yc, n });
    stas = [c(0, 0.01, 0.01, 0.01, 0.05), c(0.5, 0.55, 0.5, 0.55, 0.15, 2.0), c(1.5, 1.15, 1.05, 1.2, 0.3, 2.0), c(3.0, 1.66, 1.6, 1.75, 0.4), c(4.6, 1.92, 1.92, 1.95, 0.45), c(6.5, R, R, R, 0.45), c(26, R, R, R, 0.45),
      c(29.5, 1.9, 1.85, 1.85, 0.55), c(32.5, 1.45, 1.4, 1.55, 0.85), c(35, 0.85, 0.8, 1.0, 1.25), c(36.8, 0.36, 0.35, 0.4, 1.6), c(L, 0.03, 0.03, 0.03, 1.65)];
  } else if (trek) {
    const c = (d: number, w: number, top: number, bot: number, yc: number, n = 2.1): Sta => ({ z: Z(d), w, top, bot, yc, n });
    stas = [c(0, 0.01, 0.01, 0.01, 0.55), c(0.5, 0.5, 0.45, 0.55, 0.72, 2.0), c(1.3, 0.95, 0.9, 1.05, 0.85, 2.0), c(2.4, 1.25, 1.25, 1.3, 0.92), c(3.6, 1.4, 1.4, 1.42, 0.93), c(5, 1.435, 1.435, 1.435, 0.93), c(20, 1.435, 1.435, 1.435, 0.93),
      c(21.5, 1.34, 1.34, 1.34, 1.0), c(23.8, 0.95, 0.95, 1.0, 1.4), c(25.8, 0.36, 0.36, 0.4, 1.95), c(L, 0.03, 0.03, 0.03, 2.2)];
  } else {
    const c = (d: number, w: number, top: number, bot: number, yc: number, n = 2.4): Sta => ({ z: Z(d), w, top, bot, yc, n });
    stas = [c(0.3, 0.01, 0.01, 0.01, 0.11), c(0.45, 0.27, 0.26, 0.28, 0.1, 2.0), c(0.9, 0.46, 0.38, 0.4, 0.1), c(1.45, 0.54, 0.42, 0.42, 0.1), c(1.9, 0.6, 0.62, 0.52, 0.17), c(2.9, 0.62, 0.66, 0.54, 0.15), c(3.5, 0.55, 0.52, 0.5, 0.15), c(4.4, 0.42, 0.4, 0.4, 0.2),
      c(5.6, 0.27, 0.27, 0.28, 0.27), c(7.0, 0.14, 0.15, 0.15, 0.3), c(8.0, 0.06, 0.07, 0.07, 0.31), c(8.28, 0.02, 0.03, 0.03, 0.31)];
  }
  const fusTex = jet
    ? livery(spec, L, { win: { d0: 6.9, d1: 33.5, pitch: 0.508, w: 0.24, h: 0.33, phi: 79, skip: [[16.8, 19.8], [28.4, 30.4]] }, doors: [{ d: 4.9, w: 0.95, h: 1.85, phi: 90 }, { d: 29.3, w: 0.8, h: 1.8, phi: 90 }, { d: 17.1, w: 0.55, h: 0.95, phi: 82 }, { d: 18.9, w: 0.55, h: 0.95, phi: 82 }],
      stripe: { phi: 99, w: 3.2, d0: 3.0, d1: 34.8 }, title: { s: 'SKYLINE', d: 12.2, size: 0.78, phi: 56 }, nose: 1.5 })
    : trek
      ? livery(spec, L, { win: { d0: 5.3, d1: 22.2, pitch: 0.48, w: 0.22, h: 0.3, phi: 80, skip: [[7.4, 8.8], [10.6, 11.9], [18.2, 19.6]] }, doors: [{ d: 6.1, w: 0.9, h: 1.5, phi: 90 }, { d: 20.0, w: 0.75, h: 1.4, phi: 90 }, { d: 10.8, w: 0.5, h: 0.75, phi: 84 }],
        stripe: { phi: 100, w: 3.4, d0: 2.6, d1: 24.8 }, title: { s: 'TREKAIR', d: 13.6, size: 0.62, phi: 57 }, nose: 1.1 })
      : livery(spec, L, { win: { d0: 2.05, d1: 3.9, pitch: 0.0001, w: 0.0, h: 0.0, phi: 80, skip: [] }, stripe: { phi: 96, w: 8, d0: 1.4, d1: 7.9 }, belly: [140, 220], panelEvery: 1.3, nose: 0 });
  const fusMat = new THREE.MeshStandardMaterial({ map: fusTex ?? null, roughness: 0.34, metalness: 0.12 });
  const fusGeo = fuselage(stas, { M: 40, sub: 5, uvz: [zN, zN + L] });
  const fus = mesh(fusGeo, fusMat);
  // glazing: cockpit panes lie on the skin (hidden in the cockpit view so the interior is not blocked)
  const glazing: THREE.Mesh[] = [];
  const pane = (z0: number, z1: number, p0: number, p1: number, g = 0.012) => { const m = mesh(fuselage(stas, { M: 8, sub: 6, z0, z1, phi0: p0 * D2R, phi1: p1 * D2R, grow: g }), glass); m.name = 'extwin'; glazing.push(m); return m; };
  if (jet) {
    for (const sd of [-1, 1]) { pane(Z(2.45), Z(3.95), sd > 0 ? 6 : -62, sd > 0 ? 62 : -6); pane(Z(3.7), Z(4.85), sd > 0 ? 66 : -108, sd > 0 ? 108 : -66); }
  } else if (trek) {
    for (const sd of [-1, 1]) { pane(Z(1.7), Z(2.9), sd > 0 ? 5 : -58, sd > 0 ? 58 : -5); pane(Z(2.75), Z(3.7), sd > 0 ? 64 : -92, sd > 0 ? 92 : -64); }
  } else {
    // C172: windshield, door glass, rear window (wrap-around cabin glass above the sill line)
    pane(Z(1.3), Z(1.95), -44, 44); for (const sd of [-1, 1]) pane(Z(1.95), Z(2.95), sd > 0 ? 66 : -96, sd > 0 ? 96 : -66); pane(Z(3.25), Z(3.85), -26, 26);
  }

  // ---------- wings & tail ----------
  const addWing = (w: Wing, mat: THREE.Material, opts: { mirror?: boolean; segs?: number } = {}) => {
    const geo = w.geometry({ N: 22, segs: opts.segs ?? 16 }); const sides = opts.mirror === false ? [1] : [1, -1], groups: THREE.Group[] = [];
    for (const sd of sides) { const gp = new THREE.Group(); gp.scale.x = sd; root.add(gp); mesh(geo, mat, undefined, gp); groups.push(gp); }
    return groups;
  };
  const addPanel = (w: Wing, gp: THREE.Group, s0: number, s1: number, h: number, mat: THREE.Material, list: Panel[], side: number) => {
    const sf = w.surface(s0, s1, h); const pivot = new THREE.Group(); pivot.position.copy(sf.origin); gp.add(pivot);
    mesh(sf.geo, mat, undefined, pivot); (pivot as any).userData = { side }; list.push({ pivot, axis: sf.axis }); return pivot;
  };
  let wingW: Wing, fin: Wing, stab: Wing;
  if (jet) {
    const S: WingSec[] = [{ y: 1.6, le: -4.3, chord: 6.25, t: 0.14, twist: 1 }, { y: 1.95, le: -4.1, chord: 6.1, t: 0.14, twist: 1 }, { y: 5.75, le: -2.16, chord: 4.9, t: 0.125, dih: 0.34, twist: 0 }, { y: 11, le: 0.52, chord: 3.1, t: 0.115, dih: 0.8, twist: -1.2 }, { y: 16, le: 3.07, chord: 1.75, t: 0.1, dih: 1.25, twist: -2.5 }, { y: 17.05, le: 3.58, chord: 1.5, t: 0.095, dih: 1.34, twist: -3 }];
    wingW = new Wing(S, [0, -0.9, 0], 0.12, 0.022);
    const span = (y: number) => (y - 1.6) / 15.45, wg = addWing(wingW, wingMat, { segs: 22 });
    wg.forEach((gp, i) => { const sd = i ? -1 : 1;
      addPanel(wingW, gp, span(2.7), span(5.25), 0.72, panelMat, flaps, sd); addPanel(wingW, gp, span(6.45), span(10.6), 0.72, panelMat, flaps, sd); addPanel(wingW, gp, span(12.0), span(16.3), 0.78, panelMat, ailerons, sd);
      addPanel(wingW, gp, span(3.0), span(10.4), 0.66, dark, spoilers, sd); bulb(sd > 0 ? 0x00ff55 : 0xff2200, 0.1, [wingW.pt(1, 0.5).x, wingW.pt(1, 0.5).y, wingW.pt(1, 1).z + 0.05], gp, navs);
    });
    // wingtip: small raked fence
    fin = new Wing([{ y: 1.7, le: 11.4, chord: 6.05, t: 0.1 }, { y: 4.5, le: 13.1, chord: 3.7, t: 0.09 }, { y: 8.46, le: 15.9, chord: 2.2, t: 0.075 }], [0, 0, 0], 0.1, 0, true);
    stab = new Wing([{ y: 0.55, le: 13.75, chord: 3.9, t: 0.1, dih: 0 }, { y: 6.22, le: 17.6, chord: 1.35, t: 0.085, dih: 0.62 }], [0, 1.15, 0], 0.09, 0);
  } else if (trek) {
    const S: WingSec[] = [{ y: 1.3, le: -1.8, chord: 2.75, t: 0.17 }, { y: 4.0, le: -1.78, chord: 2.7, t: 0.16 }, { y: 9.0, le: -1.6, chord: 1.9, t: 0.14, dih: 0.17 }, { y: 13.525, le: -1.32, chord: 1.28, t: 0.12, dih: 0.33 }];
    wingW = new Wing(S, [0, 2.0, 0], 0.15, 0.025);
    const span = (y: number) => (y - 1.3) / 12.225, wg = addWing(wingW, wingMat, { segs: 14 });
    wg.forEach((gp, i) => { const sd = i ? -1 : 1;
      addPanel(wingW, gp, span(1.9), span(3.8), 0.74, panelMat, flaps, sd); addPanel(wingW, gp, span(4.4), span(8.8), 0.74, panelMat, flaps, sd); addPanel(wingW, gp, span(9.4), span(13.0), 0.78, panelMat, ailerons, sd);
      bulb(sd > 0 ? 0x00ff55 : 0xff2200, 0.07, [13.525, 2.0 + 0.33 + 0.1, -1.05], gp, navs);
    });
    fin = new Wing([{ y: 1.8, le: 7.7, chord: 5.1, t: 0.12 }, { y: 3.8, le: 9.1, chord: 3.5, t: 0.1 }, { y: 5.59, le: 10.3, chord: 1.95, t: 0.09 }], [0, 0, 0], 0.11, 0, true);
    stab = new Wing([{ y: 0.35, le: 10.25, chord: 1.95, t: 0.1 }, { y: 3.65, le: 11.3, chord: 1.0, t: 0.085 }], [0, 5.38, 0], 0.09, 0);
  } else {
    const S: WingSec[] = [{ y: 0.55, le: -0.5, chord: 1.65, t: 0.15 }, { y: 2.2, le: -0.5, chord: 1.63, t: 0.15, dih: 0.05 }, { y: 5.5, le: -0.4, chord: 1.12, t: 0.12, dih: 0.2, twist: -2 }];
    wingW = new Wing(S, [0, 0.84, 0], 0.13, 0.03);
    const span = (y: number) => (y - 0.55) / 4.95, wg = addWing(wingW, wingMat, { segs: 10 });
    wg.forEach((gp, i) => { const sd = i ? -1 : 1;
      addPanel(wingW, gp, span(0.75), span(2.75), 0.72, panelMat, flaps, sd); addPanel(wingW, gp, span(3.0), span(5.3), 0.72, panelMat, ailerons, sd);
      bulb(sd > 0 ? 0x00ff55 : 0xff2200, 0.05, [5.5, 0.84 + 0.22, 0.55], gp, navs);
    });
    fin = new Wing([{ y: 0.15, le: 3.6, chord: 2.5, t: 0.09 }, { y: 1.67, le: 4.52, chord: 1.0, t: 0.07 }], [0, 0, 0], 0.08, 0, true);
    stab = new Wing([{ y: 0.15, le: 3.95, chord: 1.15, t: 0.1 }, { y: 1.7, le: 4.25, chord: 0.72, t: 0.09 }], [0, 0.2, 0], 0.09, 0);
  }
  // fin (shared, on the centreline, painted in the livery colour) + rudder
  { const geo = fin.geometry({ N: 18, segs: 10 }); const fm = mesh(geo, accent); void fm;
    const sf = fin.surface(0.08, 0.97, jet ? 0.7 : trek ? 0.68 : 0.62, 0.004); const pivot = new THREE.Group(); pivot.position.copy(sf.origin); root.add(pivot);
    mesh(sf.geo, accent, undefined, pivot); rudders.push({ pivot, axis: sf.axis }); }
  { const sgs = addWing(stab, wingMat, { segs: 8 });
    sgs.forEach((gp, i) => { const sd = i ? -1 : 1; addPanel(stab, gp, 0.06, 0.96, jet ? 0.68 : trek ? 0.66 : 0.6, panelMat, elevators, sd); }); }
  // tail beacon / nav
  { const tip = fin.pt(1, 1.0), tl = bulb(0xffffff, jet ? 0.09 : 0.06, [0, tip.y - (jet ? 0.5 : 0.3), tip.z + 0.06], root, navs); strobes.push(tl); }
  // dorsal / ventral details
  if (jet) { // APU exhaust, belly fairing (wing-body), antennas
    mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.5, 16).rotateX(Math.PI / 2), dark, [0, 1.6, zN + L - 0.1]);
    const fb = fuselage([{ z: -5.2, w: 0.01, top: 0.01, bot: 0.01, yc: -1.25 }, { z: -3.5, w: 1.95, top: 0.2, bot: 0.55, yc: -1.2, n: 3 }, { z: 2.6, w: 1.95, top: 0.2, bot: 0.55, yc: -1.2, n: 3 }, { z: 6.6, w: 0.01, top: 0.01, bot: 0.01, yc: -1.3 }], { M: 24, sub: 4 });
    mesh(fb, std(0xd9dde0, 0.4, 0.2));
    mesh(new THREE.BoxGeometry(0.03, 0.22, 0.4), metal, [0, 2.0 + 0.45, Z(8)]); mesh(new THREE.BoxGeometry(0.03, 0.18, 0.5), metal, [0, -1.58, Z(12)]);
  } else if (trek) {
    mesh(new THREE.BoxGeometry(0.03, 0.25, 0.5), metal, [0, 2.38, Z(9)]); mesh(new THREE.BoxGeometry(0.03, 0.18, 0.4), metal, [0, -0.5, Z(13)]);
  }

  // ---------- engines & propellers ----------
  const props: THREE.Group[] = [], fans: THREE.Group[] = [], engineGlow: THREE.Object3D[] = [];
  const makeProp = (parent: THREE.Object3D, R: number, blades: number, rHub: number, chord: number, thick: number) => {
    const g = new THREE.Group(), bl = new THREE.Group(), bg = propBlade(R, rHub, chord, thick, 24, 7);
    for (let i = 0; i < blades; i++) { const m = new THREE.Mesh(bg, std(0x1b1d20, 0.45, 0.4)); m.rotation.z = (i / blades) * Math.PI * 2; bl.add(m); const tip = new THREE.Mesh(new THREE.BoxGeometry(0.02, R * 0.07, chord * 0.5), std(0xf2c200, 0.5, 0.1)); tip.position.set(0, R - R * 0.04, 0); const h = new THREE.Group(); h.rotation.z = (i / blades) * Math.PI * 2; h.add(tip); bl.add(h); }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 40), new THREE.MeshBasicMaterial({ color: 0x20262c, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })); disc.visible = false;
    g.add(bl, disc); (g as any).userData = { bl, disc }; parent.add(g); props.push(g); return g;
  };
  if (!jet && !trek) { // Lycoming IO-360 cowling details + spinner + 2-blade McCauley
    const nz = zN, hubY = 0.11;
    const sp2 = new THREE.Mesh(new THREE.LatheGeometry([[0.001, -0.44], [0.07, -0.36], [0.13, -0.24], [0.172, -0.08], [0.18, 0]].map(([r, y]) => new THREE.Vector2(r, y)), 24).rotateX(Math.PI / 2), std(0x2a2d31, 0.3, 0.75, { side: THREE.DoubleSide })); sp2.position.set(0, hubY, nz + 0.44); root.add(sp2);
    // cowl inlets
    for (const sd of [-1, 1]) { const ib = mesh(new THREE.BoxGeometry(0.2, 0.12, 0.03), dark, [sd * 0.2, hubY - 0.1, nz + 0.45]); ib.name = 'extwin'; glazing.push(ib); }
    // wing struts (flat section) from the cabin sill to the wing at 40 % semi-span
    for (const sd of [-1, 1]) root.add(strut(new THREE.Vector3(sd * 0.6, -0.3, 0.15), new THREE.Vector3(sd * 2.25, 0.78, 0.38), 0.035, std(0xdfe3e6, 0.4, 0.3), 3.2));
    const p = makeProp(root, 0.94, 2, 0.1, 0.17, 0.09); p.position.set(0, hubY, nz + 0.5);
    mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.5, 8).rotateZ(Math.PI / 2 * 0).rotateX(Math.PI / 2), steel, [0.3, -0.35, nz + 1.4]); // exhaust
  }
  if (trek) for (const sd of [-1, 1]) { // PW127 nacelle: slender cowling + chin intake + exhaust stack
    const ex = sd * 4.0, ey = 1.05, nl = new THREE.Group(); nl.position.set(ex, ey, 0); root.add(nl);
    const prof = [[0.01, -3.1], [0.25, -3.05], [0.5, -2.7], [0.62, -2.1], [0.66, -1.0], [0.68, 0.5], [0.62, 1.8], [0.5, 2.5], [0.2, 3.0], [0.01, 3.2]].map(([r, z]) => new THREE.Vector2(r, z));
    mesh(new THREE.LatheGeometry(prof, 32).rotateX(Math.PI / 2), std(0xf0f2f3, 0.35, 0.2), undefined, nl);
    mesh(new THREE.BoxGeometry(0.5, 0.34, 1.1), dark, [0, -0.5, -2.55], nl); // chin intake
    mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.5, 10), steel, [sd * 0.52, 0.12, -1.6], nl);
    const spin = new THREE.Mesh(new THREE.LatheGeometry([[0.3, 0], [0.3, 0.15], [0.26, 0.36], [0.12, 0.6], [0.001, 0.72]].map(([r, y]) => new THREE.Vector2(r, y)), 24).rotateX(-Math.PI / 2), std(0x2a2e32, 0.3, 0.8, { side: THREE.DoubleSide })); spin.position.set(0, 0, -2.5); nl.add(spin);
    const p = makeProp(nl, 1.965, 6, 0.3, 0.4, 0.08); p.position.set(0, 0, -2.5);
    // gear / wing-root nacelle blend below the wing
    mesh(new THREE.BoxGeometry(0.8, 0.5, 3.4), std(0xe9ecee, 0.4, 0.2), [0, 0.55, 0.3], nl);
    // main-gear sponson on the fuselage side (the wheels live here)
    const gs = fuselage([{ z: -0.6, w: 0.01, top: 0.01, bot: 0.01, yc: -0.45 }, { z: 0.1, w: 0.52, top: 0.5, bot: 0.62, yc: -0.3, n: 2.6 }, { z: 2.2, w: 0.55, top: 0.5, bot: 0.66, yc: -0.3, n: 2.6 }, { z: 3.1, w: 0.01, top: 0.01, bot: 0.01, yc: -0.15 }], { M: 24, sub: 4 });
    mesh(gs, std(0xe9ecee, 0.4, 0.2), [sd * 1.92, 0, 0]);
  }
  if (jet) for (const sd of [-1, 1]) { // CFM56-5B nacelle (fan cowl, core cowl, exhaust plug), pylon, rotating fan
    const ex = sd * 5.75, ey = -1.5, ez = -2.2, eng = new THREE.Group(); eng.position.set(ex, ey, ez); root.add(eng);
    const outer = [[0.99, -1.95], [1.07, -1.88], [1.12, -1.6], [1.14, -1.0], [1.12, 0.1], [1.0, 0.85], [0.8, 1.5], [0.66, 2.1], [0.56, 2.7], [0.44, 3.0]].map(([r, z]) => new THREE.Vector2(r, z));
    mesh(new THREE.LatheGeometry(outer, 40).rotateX(Math.PI / 2), std(0xe6eaed, 0.35, 0.3), undefined, eng);
    const inner = [[0.99, -1.95], [0.9, -1.8], [0.86, -1.3], [0.84, -0.8]].map(([r, z]) => new THREE.Vector2(r, z));
    const inl = mesh(new THREE.LatheGeometry(inner, 32).rotateX(Math.PI / 2), std(0x2a3036, 0.5, 0.5, { side: THREE.DoubleSide }), undefined, eng);
    void inl; mesh(new THREE.CircleGeometry(0.85, 28).rotateY(Math.PI), dark, [0, 0, -0.8], eng);
    // core / exhaust: bare metal tail pipe and plug
    mesh(new THREE.LatheGeometry([[0.5, 1.4], [0.46, 2.2], [0.44, 3.0], [0.4, 3.0]].map(([r, z]) => new THREE.Vector2(r, z)), 28).rotateX(Math.PI / 2), std(0x7b8087, 0.45, 0.9, { side: THREE.DoubleSide }), undefined, eng);
    mesh(new THREE.ConeGeometry(0.3, 0.95, 20).rotateX(-Math.PI / 2), steel, [0, 0, 3.15 + 0.2], eng);
    const fan = new THREE.Group(); fan.position.z = -1.2; eng.add(fan); fans.push(fan);
    const bg = new THREE.BoxGeometry(0.11, 0.78, 0.02); bg.translate(0, 0.45, 0);
    for (let i = 0; i < 18; i++) { const b = new THREE.Mesh(bg, std(0x8b9298, 0.35, 0.85)); b.rotation.z = (i / 18) * Math.PI * 2; b.rotation.y = 0.35; fan.add(b); }
    mesh(new THREE.ConeGeometry(0.2, 0.5, 16).rotateX(-Math.PI / 2), std(0xd8dde0, 0.3, 0.7), [0, 0, -1.45], eng);
    // pylon: faired strut from the wing underside to the nacelle top
    const pyl = fuselage([{ z: -1.4, w: 0.01, top: 0.01, bot: 0.01, yc: 0.95 }, { z: -0.8, w: 0.17, top: 0.55, bot: 0.55, yc: 0.95, n: 2.4 }, { z: 1.6, w: 0.17, top: 0.55, bot: 0.55, yc: 0.95, n: 2.4 }, { z: 2.4, w: 0.01, top: 0.01, bot: 0.01, yc: 0.9 }], { M: 16, sub: 3 });
    mesh(pyl, std(0xdfe3e6, 0.4, 0.2), undefined, eng);
  }

  // ---------- landing gear (positions straight from the flight model) ----------
  const gearGroups: { g: THREE.Group; nose: boolean; wheels: THREE.Object3D[]; side: number; spin: number }[] = [];
  const wrMain = spec.wheelR[0], wrNose = spec.wheelR[1];
  spec.gear.forEach((gs) => {
    const [gx, gy, gz] = gs.pos, nose = !!gs.nose, R = nose ? wrNose : wrMain, axleY = gy + R;
    const attachY = jet ? (nose ? -1.0 : -0.95) : trek ? (nose ? -0.55 : -0.8) : (nose ? -0.45 : -0.36);
    const g = new THREE.Group(); g.position.set(gx, attachY, gz); root.add(g);
    const len = attachY - axleY, wheels: THREE.Object3D[] = [];
    const nW = jet || (trek && !nose) ? 2 : (trek && nose) ? 2 : 1, tw = jet ? (nose ? 0.23 : 0.36) : trek ? (nose ? 0.2 : 0.3) : (nose ? 0.12 : 0.15);
    if (!jet && !trek) { // C172: sprung-steel main leg (flat tapered) / oleo nose strut, wheel fairings
      if (nose) { mesh(new THREE.CylinderGeometry(0.035, 0.04, len, 10), metal, [0, -len / 2, 0], g); mesh(new THREE.CylinderGeometry(0.05, 0.05, len * 0.45, 10), steel, [0, -len * 0.18, 0], g); }
      else { const out = new THREE.Vector3(Math.sign(gx) * 0.6, 0, 0.1); const leg = strut(new THREE.Vector3(0, 0, 0).sub(new THREE.Vector3(Math.sign(gx) * 0.62, 0, 0.0)), new THREE.Vector3(0, -len, 0), 0.045, std(0x2b2e32, 0.4, 0.7), 2.6); leg.position.set(-Math.sign(gx) * 0.64, 0, 0); void out; g.add(leg); }
    } else {
      mesh(new THREE.CylinderGeometry(jet ? 0.08 : 0.06, jet ? 0.1 : 0.08, len, 12), metal, [0, -len / 2, 0], g);
      mesh(new THREE.CylinderGeometry(jet ? 0.12 : 0.09, jet ? 0.12 : 0.09, len * 0.4, 12), steel, [0, -len * 0.12, 0], g);
      mesh(new THREE.BoxGeometry(0.05, len * 0.3, 0.09), metal, [0, -len * 0.4, jet ? -0.22 : -0.16], g);   // torque links
      if (!nose) mesh(new THREE.BoxGeometry(jet ? 0.1 : 0.08, jet ? 0.12 : 0.1, 0.5), dark, [0, -len * 0.95, 0], g);
    }
    for (let i = 0; i < nW; i++) {
      const off = nW === 2 ? (i ? 1 : -1) * (jet ? (nose ? 0.2 : 0.36) : (nose ? 0.17 : 0.22)) : 0;
      const w = wheel(R, tw, rubber, metal); w.position.set(off, -len, 0); g.add(w); wheels.push(w);
    }
    if (nose && jet) { mesh(new THREE.BoxGeometry(0.02, 0.07, 0.3), dark, [0, -len * 0.05, 0.22], g); }
    if (!jet && !trek) { const f = mesh(new THREE.SphereGeometry(1, 16, 10), std(spec.color, 0.4, 0.15), [0, -len, 0], g); f.scale.set(0.09, R * 1.25, R * 2.1); wheels.forEach((w) => (w.position.x = 0)); }
    if (trek && !nose) mesh(new THREE.BoxGeometry(0.04, 0.9, 1.2), panelMat, [Math.sign(gx) * 0.35, -0.5, 0.3], g);
    gearGroups.push({ g, nose, wheels, side: Math.sign(gx), spin: 0 });
  });

  // ---------- lights ----------
  const landLights: THREE.Mesh[] = [];
  const ll = (p: V3) => { const m = new THREE.Mesh(new THREE.CircleGeometry(jet ? 0.14 : 0.1, 12), new THREE.MeshBasicMaterial({ color: 0xfff6d8 })); m.position.set(...p); m.rotation.y = Math.PI; root.add(m); landLights.push(m); };
  if (jet) { ll([-0.5, -1.0, Z(6.2) - 0.0]); ll([0.5, -1.0, Z(6.2)]); ll([-3.1, -1.35, -3.0]); ll([3.1, -1.35, -3.0]); } else if (trek) { ll([-2.2, -0.15, Z(5.4)]); ll([2.2, -0.15, Z(5.4)]); } else { ll([-0.18, 0.02, zN + 0.62]); }
  landLights.forEach((m) => { m.visible = false; });
  const beacons = [bulb(0xff2a00, 0.1, jet ? [0, 2.45, Z(10)] : trek ? [0, 2.4, Z(10)] : [0, 0.84 + 0.14, 3.0]), bulb(0xff2a00, 0.1, jet ? [0, -1.62, Z(14)] : trek ? [0, -0.55, Z(14)] : [0, -0.3, 2.5])];
  [...beacons].forEach((b) => ((b.material as THREE.MeshBasicMaterial).color.setHex(0xff3a10)));
  for (const sd of [-1, 1]) strobes.push(bulb(0xffffff, 0.06, jet ? [sd * 17.0, -0.9 + 1.34 + 0.05, 3.6] : trek ? [sd * 13.5, 2.0 + 0.33, -1.0] : [sd * 5.5, 0.84 + 0.2, 0.7]));

  // ---------- shadows / flags ----------
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  let spin = 0;
  const axisAngle = (p: Panel, ang: number) => p.pivot.quaternion.setFromAxisAngle(p.axis, ang);
  return {
    root, bodyParts: [fus], engineGlow,
    setVisible(v) { root.visible = v; },
    setInterior(v) { for (const m of glazing) m.visible = !v; },
    update(fm, dt, time, lights) {
      const c = fm.surf, fl = jet ? 0.62 : trek ? 0.55 : 0.5;
      for (const f of flaps) axisAngle(f, fm.flapsPos * fl);
      for (const a of ailerons) axisAngle(a, -c.ail * 0.4 * (a.pivot.userData.side as number));
      for (const e of elevators) axisAngle(e, -c.el * 0.4);
      for (const r of rudders) axisAngle(r, -c.rud * 0.42);
      for (const s of spoilers) axisAngle(s, -fm.sbPos * 0.85 - (fm.wow && fm.ctl.reverse ? 0 : 0));
      const gp = fm.gearPos;
      for (const gg of gearGroups) {
        gg.g.visible = gp > 0.02 || spec.fixedGear;
        if (!spec.fixedGear) { if (gg.nose) gg.g.rotation.x = (1 - gp) * 1.55; else if (trek) gg.g.rotation.x = (1 - gp) * 1.4; else gg.g.rotation.z = -gg.side * (1 - gp) * 1.5; }
        gg.spin += (fm.wow ? fm.gs : 0) * dt / (gg.nose ? wrNose : wrMain); for (const w of gg.wheels) w.rotation.x = gg.spin;
      }
      spin += dt * Math.max(0, fm.n[0] ?? 0) * (jet ? 40 : 100);
      for (const p of props) { const ud = p.userData as any, fast = (fm.n[0] ?? 0) > 0.45; ud.bl.rotation.z = spin; ud.bl.visible = !fast; ud.disc.visible = fast; (ud.disc.material as THREE.MeshBasicMaterial).opacity = fast ? 0.34 : 0; }
      for (const f of fans) f.rotation.z = spin * 0.7;
      for (const n of navs) n.visible = lights.nav;
      for (const m of landLights) m.visible = lights.land;
      const bOn = lights.beacon && Math.sin(time * 9) > 0; for (const b of beacons) b.visible = bOn;
      const sOn = lights.strobe && (time * 1.4) % 1 < 0.1; for (const s of strobes) s.visible = lights.strobe && sOn;
    },
  };
}
void loft;
