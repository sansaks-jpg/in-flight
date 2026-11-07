// Original procedural geometry kit for the aircraft models (no imported meshes).
//   * loft()        – skins a stack of closed rings (fuselage sections, airfoil sections) into one smooth mesh,
//   * fuselage()    – superellipse cross-sections interpolated with Catmull-Rom between a few authored stations,
//   * Wing          – airfoil lofted along a multi-section planform; also cuts flap / aileron / elevator panels that
//                     hinge about the true (swept) hinge line,
//   * propBlade(), wheel(), strut() – small helpers.
// Body frame everywhere: +X right (starboard), +Y up, -Z forward.
import * as THREE from 'three';

export type V3 = [number, number, number];

/** Skin rings (each ring: first point == last point) into a mesh. Winding is auto-corrected to face outward. */
export function loft(rings: V3[][], opts: { uv?: (i: number, j: number, n: number, m: number) => [number, number]; capEnd?: boolean; capStart?: boolean; flip?: boolean } = {}): THREE.BufferGeometry {
  const n = rings.length, m = rings[0].length;
  const extra = (opts.capStart ? 1 : 0) + (opts.capEnd ? 1 : 0);
  const pos = new Float32Array((n * m + extra) * 3), uv = new Float32Array((n * m + extra) * 2), idx: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const p = rings[i][j], k = i * m + j; pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
    const t = opts.uv ? opts.uv(i, j, n, m) : [j / (m - 1), i / (n - 1)]; uv[k * 2] = t[0]; uv[k * 2 + 1] = t[1];
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < m - 1; j++) {
    const a = i * m + j, b = a + 1, c = a + m, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  // auto-orientation: the first quad's normal must point away from the ring centroid
  const mid = Math.max(0, Math.min(n - 2, n >> 1)), a0 = mid * m + (m >> 2), b0 = a0 + m, c0 = a0 + 1;
  const pa = new THREE.Vector3().fromArray(pos, a0 * 3), pb = new THREE.Vector3().fromArray(pos, b0 * 3), pc = new THREE.Vector3().fromArray(pos, c0 * 3);
  const fn = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
  const cen = new THREE.Vector3(); for (let j = 0; j < m - 1; j++) cen.add(new THREE.Vector3().fromArray(pos, (mid * m + j) * 3)); cen.divideScalar(m - 1);
  const out = pa.clone().sub(cen);
  if ((fn.dot(out) < 0) !== !!opts.flip) { const ix = g.index!.array as unknown as number[]; for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; } }
  // end caps (fan to the ring centroid), each wound so that its normal points away from the body
  const capIdx: number[] = []; let nextCap = n * m;
  const cap = (i: number, nb: number) => {
    const k = nextCap++; let cx = 0, cy = 0, cz = 0; for (let j = 0; j < m - 1; j++) { cx += rings[i][j][0]; cy += rings[i][j][1]; cz += rings[i][j][2]; }
    pos[k * 3] = cx / (m - 1); pos[k * 3 + 1] = cy / (m - 1); pos[k * 3 + 2] = cz / (m - 1); uv[k * 2] = 0.5; uv[k * 2 + 1] = i ? 1 : 0;
    let nc = [0, 0, 0]; for (let j = 0; j < m - 1; j++) { nc[0] += rings[nb][j][0]; nc[1] += rings[nb][j][1]; nc[2] += rings[nb][j][2]; } nc = nc.map((v) => v / (m - 1));
    const out = new THREE.Vector3(pos[k * 3] - nc[0], pos[k * 3 + 1] - nc[1], pos[k * 3 + 2] - nc[2]);
    const A = new THREE.Vector3().fromArray(pos, k * 3), B = new THREE.Vector3().fromArray(pos, (i * m + 1) * 3), C = new THREE.Vector3().fromArray(pos, i * m * 3);
    const nrm = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
    for (let j = 0; j < m - 1; j++) { const a = i * m + j, b = a + 1; if (nrm.dot(out) >= 0) capIdx.push(k, b, a); else capIdx.push(k, a, b); }
  };
  if (opts.capStart && n > 1) cap(0, 1); if (opts.capEnd && n > 1) cap(n - 1, n - 2);
  // cap winding check uses the first triangle's orientation; recompute per cap fan if the ring runs the other way
  g.setIndex([...Array.from(g.index!.array as ArrayLike<number>), ...capIdx]); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  // weld the shading across the seam column
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) { const a = i * m, b = i * m + m - 1; const x = nor.getX(a) + nor.getX(b), y = nor.getY(a) + nor.getY(b), z = nor.getZ(a) + nor.getZ(b), l = Math.hypot(x, y, z) || 1; nor.setXYZ(a, x / l, y / l, z / l); nor.setXYZ(b, x / l, y / l, z / l); }
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
export interface Sta { z: number; w: number; top: number; bot: number; yc: number; n?: number }
const sp = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e);
const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
/** Cross-section ring at one station: phi = 0 top, +pi/2 starboard, pi bottom. */
function ringAt(s: Sta, M: number, phi0 = 0, phi1 = Math.PI * 2, grow = 0): V3[] {
  const out: V3[] = [], e = 2 / (s.n ?? 2.3);
  for (let j = 0; j <= M; j++) {
    const phi = phi0 + (phi1 - phi0) * (j / M), c = Math.cos(phi), si = Math.sin(phi);
    out.push([(s.w + grow) * sp(si, e), s.yc + (c >= 0 ? s.top + grow : s.bot + grow) * sp(c, e), s.z]);
  }
  return out;
}
/** Interpolate authored stations (sorted by z, nose first) with Catmull-Rom and loft them. */
export function fuselage(stas: Sta[], o: { M?: number; sub?: number; z0?: number; z1?: number; phi0?: number; phi1?: number; grow?: number; uvz?: [number, number] } = {}): THREE.BufferGeometry {
  const M = o.M ?? 32, sub = o.sub ?? 4, rings: V3[][] = [];
  const zMin = stas[0].z, zMax = stas[stas.length - 1].z, uvz = o.uvz ?? [zMin, zMax];
  const keys: (keyof Sta)[] = ['z', 'w', 'top', 'bot', 'yc'];
  const at = (i: number) => stas[Math.max(0, Math.min(stas.length - 1, i))];
  const samples: Sta[] = [];
  for (let i = 0; i < stas.length - 1; i++) for (let k = 0; k < sub; k++) {
    const t = k / sub, r: any = { n: stas[i].n ?? 2.3 };
    for (const key of keys) r[key] = cr(at(i - 1)[key] as number, at(i)[key] as number, at(i + 1)[key] as number, at(i + 2)[key] as number, t);
    r.n = (stas[i].n ?? 2.3) * (1 - t) + (stas[i + 1].n ?? 2.3) * t; samples.push(r);
  }
  samples.push(stas[stas.length - 1]);
  const z0 = o.z0 ?? zMin, z1 = o.z1 ?? zMax;
  for (const s of samples) if (s.z >= z0 - 1e-6 && s.z <= z1 + 1e-6) rings.push(ringAt({ ...s, w: Math.max(0.004, s.w), top: Math.max(0.004, s.top), bot: Math.max(0.004, s.bot) }, M, o.phi0 ?? 0, o.phi1 ?? Math.PI * 2, o.grow ?? 0));
  const open = o.phi0 !== undefined;
  return loft(rings, { uv: (i, j, _n, m) => [j / (m - 1), (rings[i][0][2] - uvz[0]) / (uvz[1] - uvz[0])], flip: open ? false : false });
}
/** Station parameters at an arbitrary z (for placing details exactly on the skin). */
export function staAt(stas: Sta[], z: number): Sta {
  let i = 0; while (i < stas.length - 2 && z > stas[i + 1].z) i++;
  const a = stas[i], b = stas[i + 1], t = Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z || 1)));
  const l = (x: number, y: number) => x + (y - x) * t; return { z, w: l(a.w, b.w), top: l(a.top, b.top), bot: l(a.bot, b.bot), yc: l(a.yc, b.yc), n: a.n };
}

// ---------------------------------------------------------------------------------------------------------------
/** NACA-4-digit-like closed thickness profile, returns ring in (x along chord 0..1, y) from TE upper -> LE -> TE lower. */
export function foilPoints(N: number, t: number, camber: number, x0 = 0, x1 = 1): [number, number][] {
  const yt = (x: number) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x: number) => camber * 4 * x * (1 - x) * 0.5;
  const xs: number[] = []; for (let i = 0; i <= N; i++) { const b = (1 - Math.cos((i / N) * Math.PI)) / 2; xs.push(x0 + (x1 - x0) * b); }
  const up: [number, number][] = xs.map((x) => [x, yc(x) + yt(x)]), lo: [number, number][] = xs.map((x) => [x, yc(x) - yt(x)]);
  const pts: [number, number][] = [];
  for (let i = up.length - 1; i >= 0; i--) pts.push(up[i]);
  for (let i = x0 > 0 ? 0 : 1; i < lo.length; i++) pts.push(lo[i]);
  pts.push(up[up.length - 1]);
  return pts;
}

export interface WingSec { y: number; le: number; chord: number; t?: number; dih?: number; twist?: number }
/**
 * A wing / tail surface defined by sections along a half span. `y` is the spanwise offset (for a fin: the height),
 * `le` the z of the leading edge, `dih` the vertical offset of the section (dihedral) added to the surface base height.
 * `vertical` swaps the span axis to +Y (fins). Everything is built for the starboard side; mirror with scale.x = -1.
 */
export class Wing {
  constructor(public secs: WingSec[], public base: V3, public t = 0.12, public camber = 0.02, public vertical = false) {}
  /** interpolated section at normalised span s (0 root … 1 tip) */
  at(s: number): { span: number; le: number; chord: number; t: number; dih: number; twist: number } {
    const S = this.secs, y0 = S[0].y, y1 = S[S.length - 1].y, y = y0 + (y1 - y0) * s;
    let i = 0; while (i < S.length - 2 && y > S[i + 1].y) i++;
    const a = S[i], b = S[i + 1], u = (y - a.y) / ((b.y - a.y) || 1), L = (p: number, q: number) => p + (q - p) * u;
    return { span: y, le: L(a.le, b.le), chord: L(a.chord, b.chord), t: L(a.t ?? this.t, b.t ?? this.t), dih: L(a.dih ?? 0, b.dih ?? 0), twist: L(a.twist ?? 0, b.twist ?? 0) };
  }
  /** world position of a point at chord fraction c on the section at span s, height offset dy */
  pt(s: number, c: number, dy = 0): THREE.Vector3 {
    const q = this.at(s), v = new THREE.Vector3(); this.place(v, q.span, q.dih, q.le + q.chord * c, dy, q.twist, c, q.chord); return v;
  }
  private place(out: THREE.Vector3, span: number, dih: number, z: number, yy: number, twist: number, c: number, chord: number) {
    // rotate the section about its quarter chord (nose-up positive); z is the un-twisted chord-line position
    const tw = (twist * Math.PI) / 180, dz = (c - 0.25) * chord, zq = z - dz;
    const zz = zq + dz * Math.cos(tw) + yy * Math.sin(tw), yo = yy * Math.cos(tw) - dz * Math.sin(tw);
    if (this.vertical) out.set(this.base[0] + yo, this.base[1] + span, this.base[2] + zz); else out.set(this.base[0] + span, this.base[1] + dih + yo, this.base[2] + zz);
  }
  private ring(s: number, N: number, x0: number, x1: number, grow: number, tt?: number): V3[] {
    const q = this.at(s), pts = foilPoints(N, tt ?? q.t, this.camber, x0, x1), v = new THREE.Vector3();
    return pts.map(([x, y]) => { const yy = y * q.chord + (y >= 0 ? grow : -grow); this.place(v, q.span, q.dih, q.le + x * q.chord, yy, q.twist, x, q.chord); return [v.x, v.y, v.z] as V3; });
  }
  /** The main lifting surface. */
  geometry(opts: { N?: number; segs?: number; s0?: number; s1?: number } = {}): THREE.BufferGeometry {
    const N = opts.N ?? 18, segs = opts.segs ?? 14, s0 = opts.s0 ?? 0, s1 = opts.s1 ?? 1, rings: V3[][] = [];
    // denser sections near the tip and at every authored section for crisp planform breaks
    const ss = new Set<number>(); for (let k = 0; k <= segs; k++) ss.add(s0 + (s1 - s0) * k / segs);
    for (const sec of this.secs) { const sN = (sec.y - this.secs[0].y) / ((this.secs[this.secs.length - 1].y - this.secs[0].y) || 1); if (sN > s0 && sN < s1) ss.add(sN); }
    for (const s of [...ss].sort((a, b) => a - b)) rings.push(this.ring(s, N, 0, 1, 0));
    return loft(rings, { capEnd: true });
  }
  /** Movable panel between span s0..s1 behind hinge fraction h (of local chord). Pivot sits on the hinge line at s0. */
  surface(s0: number, s1: number, h: number, grow = 0.004): { geo: THREE.BufferGeometry; origin: THREE.Vector3; axis: THREE.Vector3 } {
    const N = 7, rings: V3[][] = [], H0 = this.pt(s0, h), H1 = this.pt(s1, h), axis = H1.clone().sub(H0).normalize();
    const steps = 3;
    for (let k = 0; k <= steps; k++) {
      const s = s0 + (s1 - s0) * k / steps;
      rings.push(this.ring(s, N, h, 1, grow).map((p) => [p[0] - H0.x, p[1] - H0.y, p[2] - H0.z] as V3));
    }
    return { geo: loft(rings, { capStart: true, capEnd: true }), origin: H0, axis };
  }
}

// ---------------------------------------------------------------------------------------------------------------
/** Two points -> cylinder / elliptic strut mesh between them (r = radius, fx scales the cross-section across X). */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, fx = 1, rb = r): THREE.Mesh {
  const len = a.distanceTo(b), g = new THREE.CylinderGeometry(rb, r, len, 10, 1); g.translate(0, len / 2, 0); g.scale(fx, 1, 1 / fx);
  const m = new THREE.Mesh(g, mat); m.position.copy(a);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return m;
}
/** Tyre + hub, axle along X, centred on the origin. */
export function wheel(R: number, width: number, tyreMat: THREE.Material, hubMat: THREE.Material): THREE.Group {
  const g = new THREE.Group(), hw = width / 2, r0 = R * 0.56;
  const prof = [[r0, -hw * 0.85], [R * 0.82, -hw], [R * 0.96, -hw * 0.72], [R, -hw * 0.3], [R, hw * 0.3], [R * 0.96, hw * 0.72], [R * 0.82, hw], [r0, hw * 0.85]].map(([x, y]) => new THREE.Vector2(x, y));
  const tyre = new THREE.Mesh(new THREE.LatheGeometry(prof, 28).rotateZ(Math.PI / 2), tyreMat); g.add(tyre);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.98, r0 * 0.98, width * 0.96, 20).rotateZ(Math.PI / 2), hubMat); g.add(hub);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.4, r0 * 0.4, width * 1.02, 12).rotateZ(Math.PI / 2), tyreMat); g.add(cap);
  return g;
}
/** One tapered, twisted propeller blade pointing along +Y from the hub, thrust axis -Z. */
export function propBlade(R: number, rHub: number, chord: number, thick: number, pitchRootDeg: number, pitchTipDeg: number): THREE.BufferGeometry {
  const rings: V3[][] = [], N = 8, S = 8;
  for (let k = 0; k <= S; k++) {
    const f = k / S, r = rHub + (R - rHub) * f, c = chord * (0.75 + 0.45 * Math.sin(Math.min(1, f * 1.6) * Math.PI * 0.7)) * (1 - 0.35 * f * f), pit = ((pitchRootDeg + (pitchTipDeg - pitchRootDeg) * f) * Math.PI) / 180;
    const pts = foilPoints(N, thick * (1 - 0.5 * f), 0.03).map(([x, y]) => { const xx = (x - 0.4) * c, yy = y * c; return [xx * Math.cos(pit) - yy * Math.sin(pit), r, -(xx * Math.sin(pit) + yy * Math.cos(pit))] as V3; });
    rings.push(pts);
  }
  const g = loft(rings, { capEnd: true });
  // loft treats the ring axis as chord (x) / thickness (z); orient so thrust axis is z
  return g;
}
export const radial = (n: number, f: (a: number) => void) => { for (let i = 0; i < n; i++) f((i / n) * Math.PI * 2); };
