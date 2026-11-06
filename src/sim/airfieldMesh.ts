// 3D ground layout of an airfield from surveyed OpenStreetMap data: taxiways (with yellow centrelines),
// aprons, stand markers, hold-short markers, helipads and low hangar / terminal footprints.
import * as THREE from 'three';
import { Airport, AirfieldLayout, LatLon } from '../data/airports';
import { Projection } from './geo';

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function buildAirfieldMeshes(ap: Airport, L: AirfieldLayout, proj: Projection, group: THREE.Group, detailed: boolean) {
  const y0 = ap.elev;
  const P = (ll: LatLon): [number, number] => [proj.x(ll[1]), proj.z(ll[0])];

  // ---- taxiways: one merged mesh for the surface and one for the centre lines ----
  const pos: number[] = [], cpos: number[] = [];
  const quad = (arr: number[], ax: number, az: number, bx: number, bz: number, w: number, y: number) => {
    const dx = bx - ax, dz = bz - az, L2 = Math.hypot(dx, dz); if (L2 < 0.05) return;
    const nx = (-dz / L2) * (w / 2), nz = (dx / L2) * (w / 2);
    arr.push(ax + nx, y, az + nz, ax - nx, y, az - nz, bx + nx, y, bz + nz, ax - nx, y, az - nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz);
  };
  const disc = (arr: number[], cx: number, cz: number, r: number, y: number) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      arr.push(cx, y, cz, cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r);
    }
  };
  for (const t of L.taxiways) {
    const w = clampN(t.width, 8, 30);
    const pts = t.pts.map(P);
    for (let i = 0; i + 1 < pts.length; i++) {
      quad(pos, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, y0 + 0.07);
      quad(cpos, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 0.35, y0 + 0.09);
    }
    for (let i = 1; i + 1 < pts.length; i++) disc(pos, pts[i][0], pts[i][1], w / 2, y0 + 0.07);
  }
  const mkMesh = (arr: number[], mat: THREE.Material) => {
    if (!arr.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    group.add(m);
  };
  // triangles from quad() may face down depending on winding: render both sides
  mkMesh(pos, new THREE.MeshLambertMaterial({ color: 0x3a3d42, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  mkMesh(cpos, new THREE.MeshBasicMaterial({ color: 0xe8c33a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }));

  // ---- aprons ----
  const apronMat = new THREE.MeshLambertMaterial({ color: 0x62666b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const flatPoly = (ring: LatLon[], y: number, mat: THREE.Material) => {
    if (ring.length < 3) return;
    const sh = new THREE.Shape(ring.map((p) => { const [x, z] = P(p); return new THREE.Vector2(x, -z); }));
    const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat); m.position.y = y; m.frustumCulled = false; group.add(m);
  };
  for (const a of L.aprons) flatPoly(a.ring, y0 + 0.05, apronMat);

  if (!detailed) return;

  // ---- low building footprints (the OSM vector tiles supply the taller 3D buildings; these stay below them) ----
  const extrude = (ring: LatLon[], h: number, mat: THREE.Material) => {
    if (ring.length < 3) return;
    const sh = new THREE.Shape(ring.map((p) => { const [x, z] = P(p); return new THREE.Vector2(x, -z); }));
    const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false }); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat); m.position.y = y0; m.frustumCulled = false; group.add(m);
  };
  const hangarMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad }), termMat = new THREE.MeshLambertMaterial({ color: 0xcfd8e3 });
  for (const h of L.hangars) extrude(h.ring, 5.5, hangarMat);
  for (const t of L.terminals) extrude(t.ring, 8, termMat);

  // ---- stand + hold-short + helipad markers ----
  const dm = new THREE.Object3D();
  if (L.stands.length) {
    const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.1, 1.1, 0.06, 10), new THREE.MeshBasicMaterial({ color: 0xf5d442 }), L.stands.length);
    L.stands.forEach((s, i) => { const [x, z] = P([s.lat, s.lon]); dm.position.set(x, y0 + 0.14, z); dm.updateMatrix(); inst.setMatrixAt(i, dm.matrix); });
    inst.frustumCulled = false; group.add(inst);
  }
  if (L.holds.length) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(5, 0.06, 0.6), new THREE.MeshBasicMaterial({ color: 0xf2c200 }), L.holds.length);
    L.holds.forEach((s, i) => { const [x, z] = P([s.lat, s.lon]); dm.position.set(x, y0 + 0.14, z); dm.updateMatrix(); inst.setMatrixAt(i, dm.matrix); });
    inst.frustumCulled = false; group.add(inst);
  }
  if (L.helipads.length) {
    const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(6, 6, 0.08, 20), new THREE.MeshLambertMaterial({ color: 0x8b9096 }), L.helipads.length);
    L.helipads.forEach((s, i) => { const [x, z] = P(s); dm.position.set(x, y0 + 0.12, z); dm.updateMatrix(); inst.setMatrixAt(i, dm.matrix); });
    inst.frustumCulled = false; group.add(inst);
  }
}
