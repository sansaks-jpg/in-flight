// Procedural exterior models for the three aircraft. Body frame: +X right, +Y up, -Z forward (CG at origin).
import * as THREE from 'three';
import { AircraftSpec } from './specs';
import { FlightModel } from './physics';

function wingGeo(half: number, rc: number, tc: number, sweep: number, tr: number, tt: number, dihDeg: number) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const dih = Math.tan((dihDeg * Math.PI) / 180);
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) + 0.5, zc = p.getZ(i), yc = p.getY(i);
    const c = rc + (tc - rc) * t, th = tr + (tt - tr) * t;
    p.setXYZ(i, t * half, yc * th + t * half * dih, sweep * t + zc * c);
  }
  g.computeVertexNormals();
  return g;
}

export interface AircraftVisual {
  root: THREE.Group; update(fm: FlightModel, dt: number, time: number, lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean }): void;
  setVisible(v: boolean): void; setInterior(v: boolean): void; bodyParts: THREE.Object3D[]; engineGlow: THREE.Object3D[];
}

export function buildAircraftModel(spec: AircraftSpec): AircraftVisual {
  const root = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.38, metalness: 0.25 });
  const accent = new THREE.MeshStandardMaterial({ color: spec.accent, roughness: 0.4, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.6, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0c1824, roughness: 0.08, metalness: 0.7, transparent: true, opacity: 0.88 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa2aa, roughness: 0.35, metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = root) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); parent.add(o); return o; };

  const id = spec.id;
  const jet = id === 'sky', trek = id === 'trek';
  // ---------- fuselage ----------
  const prof: [number, number][] = id === 'swift'
    ? [[5.4, 0.05], [4.2, 0.16], [2.8, 0.34], [1.2, 0.5], [-0.4, 0.58], [-1.5, 0.55], [-2.2, 0.42], [-2.55, 0.2], [-2.7, 0.0]]
    : trek
      ? [[8.0, 0.1], [6.6, 0.4], [4.0, 0.85], [1.0, 1.05], [-3.0, 1.05], [-5.2, 0.8], [-6.2, 0.45], [-6.6, 0.0]]
      : [[19.5, 0.35], [18.2, 0.7], [15.0, 1.3], [11.0, 1.85], [5.0, 2.0], [-8.0, 2.0], [-12.5, 1.85], [-15.6, 1.35], [-17.0, 0.7], [-17.6, 0.0]];
  const pts = prof.map(([z, r]) => new THREE.Vector2(Math.max(r, 0.001), -z));
  const lathe = new THREE.LatheGeometry(pts, 28);
  lathe.rotateX(-Math.PI / 2);
  const fus = mesh(lathe, body);
  if (id === 'swift') fus.scale.set(1, 0.95, 1); else if (trek) fus.scale.set(0.95, 1.05, 1);
  // cheat line stripe
  const stripe = mesh(new THREE.BoxGeometry(spec.length * 0.0 + (jet ? 4.06 : trek ? 2.12 : 1.16), jet ? 0.22 : 0.12, spec.length * 0.72), accent, 0, jet ? -0.45 : -0.05, jet ? 1.0 : trek ? 1.2 : 1.4);
  stripe.scale.set(1, 1, 1); stripe.geometry.scale(0.995, 1, 1); stripe.visible = false; // rendered by belly band below instead
  const band = new THREE.Mesh(new THREE.CylinderGeometry(jet ? 2.003 : trek ? 1.055 : 0.585, jet ? 2.003 : trek ? 1.055 : 0.585, 0.22, 24, 1, true), accent);
  band.rotation.x = Math.PI / 2; band.position.set(0, jet ? -0.1 : 0, jet ? -3.0 : trek ? -2.0 : -0.6); band.scale.set(1, jet ? 3 : 2, 1); band.scale.z = trek ? 0.95 : 1; root.add(band);
  void band;
  // windows / canopy
  if (jet) {
    const wGeo = new THREE.BoxGeometry(0.06, 0.34, 0.5);
    const wins = new THREE.InstancedMesh(wGeo, dark, 2 * 24); wins.name = 'extwin'; const d = new THREE.Object3D(); let k = 0;
    for (let i = 0; i < 24; i++) for (const sd of [-1, 1]) { d.position.set(sd * 1.97, 0.5, -9.6 + i * 0.82); d.updateMatrix(); wins.setMatrixAt(k++, d.matrix); }
    root.add(wins);
    { const w = mesh(new THREE.BoxGeometry(1.7, 0.5, 0.8), dark, 0, 0.62, -15.6); w.rotation.x = -0.45; w.name = 'extwin'; }
  } else if (trek) {
    const wins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.3, 0.45), dark, 12); wins.name = 'extwin'; const d = new THREE.Object3D(); let k = 0;
    for (let i = 0; i < 6; i++) for (const sd of [-1, 1]) { d.position.set(sd * 1.0, 0.35, -3.1 + i * 0.85); d.updateMatrix(); wins.setMatrixAt(k++, d.matrix); }
    root.add(wins);
    { const w = mesh(new THREE.BoxGeometry(1.5, 0.45, 0.7), dark, 0, 0.55, -5.6); w.rotation.x = -0.5; w.name = 'extwin'; }
  } else {
    const cp = mesh(new THREE.SphereGeometry(1, 20, 12), glass, 0, 0.42, -0.35); cp.scale.set(0.5, 0.36, 1.25); cp.name = 'extwin';
  }
  // ---------- wings ----------
  const W = id === 'swift' ? { half: 5.45, rc: 1.7, tc: 1.1, sw: 0.25, tr: 0.2, tt: 0.1, dih: 2, y: -0.28, z: 0.15 }
    : trek ? { half: 9.9, rc: 2.5, tc: 1.7, sw: 0.4, tr: 0.35, tt: 0.18, dih: 0, y: 1.0, z: -0.2 }
      : { half: 17.0, rc: 6.2, tc: 1.6, sw: 8.4, tr: 0.7, tt: 0.22, dih: 5.5, y: -1.1, z: -1.2 };
  const wingG = wingGeo(W.half, W.rc, W.tc, W.sw, W.tr, W.tt, W.dih);
  const flapParts: THREE.Object3D[] = [], ailParts: THREE.Object3D[] = [], spoilers: THREE.Object3D[] = [];
  const chordAt = (t: number) => W.rc + (W.tc - W.rc) * t;
  const zTE = (t: number) => W.sw * t + chordAt(t) / 2;
  const yAt = (t: number) => t * W.half * Math.tan((W.dih * Math.PI) / 180);
  for (const sd of [-1, 1]) {
    const wg = new THREE.Group(); wg.position.set(0, W.y, W.z); wg.scale.x = sd; root.add(wg);
    mesh(wingG, body, 0, 0, 0, wg);
    // flaps (inboard) and ailerons (outboard)
    const addSurf = (t0: number, t1: number, depthF: number, store: THREE.Object3D[], mat: THREE.Material, sgn: number) => {
      const tm = (t0 + t1) / 2, span = (t1 - t0) * W.half, depth = chordAt(tm) * depthF;
      const piv = new THREE.Group(); piv.position.set(tm * W.half, yAt(tm), zTE(tm) - depth); wg.add(piv);
      const m = new THREE.Mesh(new THREE.BoxGeometry(span, 0.05, depth), mat); m.position.z = depth / 2; piv.add(m);
      (piv as any).userData = { sd, sgn }; store.push(piv); return piv;
    };
    addSurf(0.12, 0.55, 0.26, flapParts, accent === body ? body : metal, 1);
    addSurf(0.62, 0.95, 0.24, ailParts, metal, 1);
    if (jet) { const sp = addSurf(0.3, 0.62, 0.2, spoilers, dark, 1); sp.position.z -= 0.6; }
    // wingtip lights
    const nav = new THREE.Mesh(new THREE.SphereGeometry(jet ? 0.18 : 0.08, 8, 6), new THREE.MeshBasicMaterial({ color: sd < 0 ? 0xff2200 : 0x00ff55 }));
    nav.position.set(W.half, yAt(1), W.sw + (jet ? 0.4 : 0)); nav.name = 'nav'; wg.add(nav);
  }
  // ---------- empennage ----------
  const T = id === 'swift' ? { y: 0.55, z: 4.8, half: 1.7, rc: 1.1, tc: 0.7, sw: 0.25, fin: 1.25, finZ: 4.2, finC: 1.4 }
    : trek ? { y: 1.45, z: 7.1, half: 3.1, rc: 1.7, tc: 1.1, sw: 0.4, fin: 2.4, finZ: 6.5, finC: 2.2 }
      : { y: 0.9, z: 15.6, half: 6.2, rc: 3.5, tc: 1.2, sw: 3.8, fin: 6.3, finZ: 13.4, finC: 5.6 };
  const stabG = wingGeo(T.half, T.rc, T.tc, T.sw, T.rc * 0.1, T.rc * 0.05, 3);
  const elevators: THREE.Object3D[] = [];
  for (const sd of [-1, 1]) {
    const g = new THREE.Group(); g.position.set(0, T.y, T.z); g.scale.x = sd; root.add(g);
    mesh(stabG, body, 0, 0, 0, g);
    const tm = 0.5, depth = (T.rc + (T.tc - T.rc) * tm) * 0.35, piv = new THREE.Group();
    piv.position.set(tm * T.half, tm * T.half * 0.05, T.sw * tm + (T.rc + (T.tc - T.rc) * tm) / 2 - depth); g.add(piv);
    mesh(new THREE.BoxGeometry(T.half * 0.85, 0.04, depth), metal, 0, 0, depth / 2, piv); elevators.push(piv);
  }
  const finG = wingGeo(T.fin, T.finC, T.finC * 0.45, T.finC * 0.9, T.finC * 0.1, T.finC * 0.05, 0);
  const fin = mesh(finG, accent, 0, jet ? 0.9 : id === 'swift' ? 0.3 : 0.9, T.finZ); fin.rotation.z = Math.PI / 2; // spanwise +X -> +Y
  const rudPiv = new THREE.Group(); rudPiv.position.set(0, (jet ? 0.9 : id === 'swift' ? 0.3 : 0.9) + T.fin * 0.5, T.finZ + T.finC * 0.9 * 0.5 + (T.finC * (1 - 0.55 * 0.5)) / 2 - T.finC * 0.28); root.add(rudPiv);
  mesh(new THREE.BoxGeometry(0.04, T.fin * 0.85, T.finC * 0.3), body, 0, 0, T.finC * 0.15, rudPiv);
  const tailNav = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); tailNav.name = 'nav'; tailNav.position.set(0, T.y + T.fin * 0.95, T.finZ + T.finC * 1.1 + (jet ? 0.5 : 0)); root.add(tailNav);

  // ---------- engines / propellers ----------
  const props: THREE.Group[] = []; const engineGlow: THREE.Object3D[] = []; const fans: THREE.Object3D[] = [];
  const buildProp = (x: number, y: number, z: number, radius: number, blades: number) => {
    const g = new THREE.Group(); g.position.set(x, y, z);
    mesh(new THREE.ConeGeometry(radius * 0.13, radius * 0.42, 16).rotateX(-Math.PI / 2).translate(0, 0, -radius * 0.18), metal, 0, 0, 0, g);
    const bl = new THREE.Group(); g.add(bl);
    for (let i = 0; i < blades; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.09, radius, 0.025), dark); b.position.y = radius / 2; const h = new THREE.Group(); h.rotation.z = (i / blades) * Math.PI * 2; h.add(b); bl.add(h); }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), new THREE.MeshBasicMaterial({ color: 0x222831, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }));
    g.add(disc); (g as any).userData = { bl, disc }; root.add(g); props.push(g);
  };
  if (id === 'swift') { buildProp(0, 0, -2.72, 0.95, 2); mesh(new THREE.CylinderGeometry(0.58, 0.5, 0.9, 20).rotateX(Math.PI / 2), body, 0, 0, -2.0).scale.set(1, 0.95, 1); }
  if (trek) for (const sd of [-1, 1]) {
    mesh(new THREE.CylinderGeometry(0.5, 0.42, 3.6, 18).rotateX(Math.PI / 2), body, sd * 3.6, 0.55, -1.0);
    mesh(new THREE.CylinderGeometry(0.2, 0.5, 0.6, 18).rotateX(Math.PI / 2), metal, sd * 3.6, 0.55, -3.1);
    buildProp(sd * 3.6, 0.55, -3.45, 1.35, 4);
    mesh(new THREE.BoxGeometry(0.9, 0.35, 1.8), body, sd * 1.65, -0.85, 0.2); // gear sponson
  }
  if (jet) for (const sd of [-1, 1]) {
    const eng = new THREE.Group(); eng.position.set(sd * 5.7, -1.55, -3.2); root.add(eng);
    const nacP: [number, number][] = [[1.55, 0.0], [1.75, 0.0]];
    void nacP;
    const nac = new THREE.LatheGeometry([new THREE.Vector2(0.98, 2.0), new THREE.Vector2(1.12, 1.4), new THREE.Vector2(1.18, 0.2), new THREE.Vector2(1.1, -1.2), new THREE.Vector2(0.78, -2.0), new THREE.Vector2(0.3, -2.3)], 26).rotateX(-Math.PI / 2);
    mesh(nac, metal, 0, 0, 0, eng); mesh(new THREE.CylinderGeometry(0.96, 0.96, 0.05, 24).rotateX(Math.PI / 2), dark, 0, 0, -1.98, eng);
    const fan = new THREE.Group(); fan.position.z = -1.95; eng.add(fan); fans.push(fan);
    for (let i = 0; i < 12; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.02), new THREE.MeshStandardMaterial({ color: 0x555b62 })); b.position.y = 0.48; const h = new THREE.Group(); h.rotation.z = (i / 12) * Math.PI * 2; h.add(b); fan.add(h); }
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.55, 12).rotateX(-Math.PI / 2), metal); cone.position.z = -2.2; eng.add(cone);
    mesh(new THREE.BoxGeometry(0.28, 1.0, 1.9), metal, 0, 0.95, 0.1, eng); // pylon
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 16), new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); glow.position.set(0, 0, 2.05); glow.rotation.y = Math.PI; eng.add(glow); engineGlow.push(glow);
  }
  // ---------- landing gear ----------
  const gearGroups: { g: THREE.Group; nose: boolean; wheels: THREE.Object3D[]; side: number }[] = [];
  const wr = jet ? 0.58 : trek ? 0.36 : 0.2;
  spec.gear.forEach((gs) => {
    const [gx, gy, gz] = gs.pos; const nose = !!gs.nose;
    const attachY = jet ? -1.9 : trek ? -0.95 : id === 'swift' ? (nose ? -0.5 : -0.35) : -0.5;
    const g = new THREE.Group(); g.position.set(gx, attachY, gz); root.add(g);
    const wheelY = gy + wr - attachY, len = -wheelY;
    mesh(new THREE.CylinderGeometry(jet ? 0.09 : 0.05, jet ? 0.11 : 0.06, len, 10), metal, 0, -len / 2, 0, g);
    const wheels: THREE.Object3D[] = [];
    const nW = jet ? 2 : 1, rr = nose && jet ? 0.38 : wr;
    for (let i = 0; i < nW; i++) {
      const wx = nW === 2 ? (i ? 0.26 : -0.26) : 0;
      const w = new THREE.Group(); w.position.set(wx, -len + (rr - wr) * 0, 0); g.add(w);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, jet ? 0.3 : 0.18, 20).rotateZ(Math.PI / 2), rubber); w.add(tyre);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(rr * 0.55, rr * 0.55, jet ? 0.32 : 0.2, 12).rotateZ(Math.PI / 2), metal); w.add(hub);
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.22, rr * 1.7, 0.03), dark); w.add(spoke);
      wheels.push(w);
    }
    if (!nose && jet) mesh(new THREE.BoxGeometry(0.08, 0.1, 0.9), metal, 0, -len, 0, g);
    gearGroups.push({ g, nose, wheels, side: Math.sign(gx) });
    // gear door for mains on airliner
  });
  // landing light + beacon
  const landLight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffee }));
  landLight.position.set(0, jet ? -1.6 : -0.45, jet ? -13.4 : trek ? -4.4 : -1.3); root.add(landLight);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3300 }));
  beacon.position.set(0, jet ? 2.05 : trek ? 1.05 : 0.6, jet ? -4 : trek ? 0.5 : 1.5); root.add(beacon);
  const strobes = root.children.filter(() => false);
  void strobes;

  let spin = 0, wheelSpin = 0;
  return {
    root, bodyParts: [fus],
    engineGlow,
    setVisible(v) { root.visible = v; },
    setInterior(v) { root.traverse((o) => { if (o.name === 'extwin') o.visible = !v; }); },
    update(fm, dt, time, lights) {
      const c = fm.surf;
      for (const f of flapParts) f.rotation.x = fm.flapsPos * 0.7;
      for (const a of ailParts) a.rotation.x = -c.ail * 0.45 * (a.userData.sd as number);
      for (const e of elevators) e.rotation.x = -c.el * 0.45;
      rudPiv.rotation.y = -c.rud * 0.4;
      for (const s of spoilers) s.rotation.x = -fm.sbPos * 0.9 + (fm.wow && fm.ctl.reverse ? 0 : 0);
      const gp = fm.gearPos;
      for (const gg of gearGroups) {
        gg.g.visible = gp > 0.02;
        if (gg.nose) gg.g.rotation.x = (1 - gp) * 1.55; else gg.g.rotation.z = -gg.side * (1 - gp) * 1.5;
        wheelSpin += 0; for (const w of gg.wheels) w.rotation.x = wheelSpin;
      }
      wheelSpin += (fm.wow ? fm.gs : 0) * dt / wr;
      const nSpool = fm.n[0] ?? 0;
      spin += dt * nSpool * 100;
      for (const p of props) {
        const ud = p.userData as any; ud.bl.rotation.z = spin; const fast = fm.n[0] > 0.45;
        ud.bl.visible = !fast; (ud.disc.material as THREE.MeshBasicMaterial).opacity = fast ? 0.35 : 0; ud.disc.visible = fast;
      }
      for (const f of fans) f.rotation.z = spin * 0.7;
      engineGlow.forEach((m) => ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = Math.max(0, (fm.n[0] - 0.6) * 0.5));
      root.traverse((o) => {
        if (o.name === 'nav') o.visible = lights.nav;
      });
      landLight.visible = lights.land; beacon.visible = lights.beacon && Math.sin(time * 9) > 0;
      // strobes reuse nav spheres (white flash on tail) -> tail light flashes
      tailNav.visible = lights.nav && (!lights.strobe || Math.sin(time * 14) > -0.2);
    },
  };
}
