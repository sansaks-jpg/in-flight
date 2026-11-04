// Interactive 3D flight deck + passenger cabin, rendered in a second pass (own near plane) over the world.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AircraftSpec } from './specs';
import { drawSteam, drawPFD, drawND, drawEICAS, PanelData } from './instruments';
import { QualityPreset } from './storage';

export interface CockpitInputs { pitch: number; roll: number; yaw: number; throttle: number; flapsIdx: number; gearDown: boolean; speedbrake: number; }
export interface CockpitUi { lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean }; seatbelt: boolean; parking: boolean; reverse: boolean; apOn: boolean; apNav: boolean; apAppr: boolean; apHdg: number; apAlt: number; apSpd: number; mood: number; shake: number; }
export interface View { pos: THREE.Vector3; yaw: number; pitch: number; }

class TouchPanel {
  canvas = document.createElement('canvas'); tex: THREE.CanvasTexture; mesh: THREE.Mesh; lastKey = '';
  constructor(public W: number, public H: number, public cols: number, public rows: number, public items: { id: string; label: string; c: number; r: number; w?: number }[], size: [number, number]) {
    this.canvas.width = W; this.canvas.height = H;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 4;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ map: this.tex }));
    this.mesh.userData.panel = this;
  }
  cell(it: { c: number; r: number; w?: number }) { const cw = this.W / this.cols, ch = this.H / this.rows; return { x: it.c * cw + 5, y: it.r * ch + 5, w: cw * (it.w || 1) - 10, h: ch - 10 }; }
  draw(lit: (id: string) => boolean, info: (id: string) => string | undefined) {
    const key = this.items.map((i) => (lit(i.id) ? 1 : 0) + (info(i.id) || '')).join('|');
    if (key === this.lastKey) return; this.lastKey = key;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#16181b'; g.fillRect(0, 0, this.W, this.H);
    for (const it of this.items) {
      const b = this.cell(it), on = lit(it.id), display = it.id.startsWith('_');
      g.fillStyle = display ? '#0a0d10' : on ? '#1b4a35' : '#2b2f35'; g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 8); g.fill();
      g.strokeStyle = display ? '#234' : on ? '#3dff95' : '#555b63'; g.lineWidth = 3; g.stroke();
      const label0 = info(it.id) ?? it.label; const longest = Math.max(...label0.split('\n').map((l) => l.length)); const fs = Math.min(b.h * (display ? 0.3 : 0.3), (b.w / Math.max(3, longest)) * 1.1);
      g.fillStyle = display ? '#7fe0ff' : on ? '#9dffcd' : '#c8ccd2'; g.font = `bold ${Math.round(fs)}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const label = info(it.id) ?? it.label; const parts = label.split('\n');
      parts.forEach((p, i) => g.fillText(p, b.x + b.w / 2, b.y + b.h / 2 + (i - (parts.length - 1) / 2) * b.h * 0.34));
      if (!display) { g.fillStyle = on ? '#3dff95' : '#24282c'; g.fillRect(b.x + b.w * 0.3, b.y + 6, b.w * 0.4, 4); }
    }
    this.tex.needsUpdate = true;
  }
  hit(uv: THREE.Vector2) {
    const px = uv.x * this.W, py = (1 - uv.y) * this.H;
    for (const it of this.items) { if (it.id.startsWith('_')) continue; const b = this.cell(it); if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return it.id; }
    return null;
  }
}

export class Cockpit {
  scene = new THREE.Scene(); group = new THREE.Group();
  camera = new THREE.PerspectiveCamera(70, 1, 0.04, 200);
  interactive: THREE.Object3D[] = [];
  views: Record<'cockpit' | 'aisle' | 'window', View>;
  private panels: { c: HTMLCanvasElement; t: THREE.CanvasTexture; draw: (g: CanvasRenderingContext2D, W: number, H: number, d: PanelData) => void; W: number; H: number }[] = [];
  private touch: TouchPanel[] = [];
  private throttleLever!: THREE.Group; private flapsLever!: THREE.Group; private gearLever!: THREE.Group; private sbLever?: THREE.Group;
  private yoke!: THREE.Group; private yokeWheel?: THREE.Object3D; private isStick = false;
  private pedals: THREE.Object3D[] = [];
  private heads?: THREE.InstancedMesh; private torsos?: THREE.InstancedMesh; private paxN = 0; private paxBase: THREE.Matrix4[] = []; private paxHeadBase: THREE.Matrix4[] = [];
  private beltSign?: THREE.Mesh; private acc = 0; private paxAcc = 0;
  readonly cabinHeads: THREE.Object3D[] = [];

  constructor(public spec: AircraftSpec, private quality: QualityPreset) {
    const [ex, ey, ez] = spec.eye;
    this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x4a4036, 1.5));
    const sun = new THREE.DirectionalLight(0xfff3dd, 1.6); sun.position.set(-2, 4, -3); this.scene.add(sun);
    const amb = new THREE.AmbientLight(0xffffff, 0.45); this.scene.add(amb);
    const M = (c: number, r = 0.7, m = 0.1) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const matDark = M(0x1d2024), matGrey = M(0x3a3f45), matMetal = M(0x9aa0a8, 0.35, 0.8), matSeat = M(spec.accent, 0.85, 0), matBlack = M(0x0a0b0d);
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.group) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); parent.add(o); return o; };
    const jet = spec.kind === 'jet', piston = spec.kind === 'piston', trek = spec.kind === 'turboprop';
    const panelW = jet ? 1.9 : piston ? 1.1 : 1.35;
    this.views = { cockpit: { pos: new THREE.Vector3(ex, ey, ez), yaw: 0, pitch: -0.1 }, aisle: { pos: jet ? new THREE.Vector3(0, 0.95, -10.2) : trek ? new THREE.Vector3(0, 0.25, -3.2) : new THREE.Vector3(0.05, 0.5, ez + 1.3), yaw: jet || trek ? Math.PI : 0, pitch: -0.04 }, window: { pos: new THREE.Vector3(jet ? 1.3 : 0.4, jet ? 0.5 : 0.3, jet ? -1.3 : 1.4), yaw: jet ? -1.15 : -1.1, pitch: -0.05 } };

    // ---------------- flight deck shell ----------------
    box(panelW + 0.5, 0.04, 0.55, matDark, 0, ey - 0.045, ez - 1.12);   // glareshield deck (forward of the panel)
    box(panelW + 0.7, 0.9, 0.04, matDark, 0, ey - 0.55, ez - (jet ? 0.93 : 0.87));    // panel backing
    box(1.9, 0.08, 1.6, matGrey, 0, ey + (jet ? 0.62 : 0.44), ez + 0.1);  // roof liner
    for (const sd of [-1, 1]) {
      const post = box(0.04, 0.6, 0.05, matGrey, sd * (jet ? 0.98 : piston ? 0.62 : 0.78), ey + 0.2, ez - 1.1); post.rotation.z = -sd * 0.12;
      box(0.05, 0.5, 1.7, matGrey, sd * (jet ? 1.05 : piston ? 0.7 : 0.88), ey - 0.42, ez + 0.0);        // side wall lower (door sill)
      box(0.05, 0.1, 1.5, matGrey, sd * (jet ? 1.0 : 0.66), ey + 0.38, ez + 0.1);                      // side window header
      box(0.05, 0.62, 0.07, matGrey, sd * (jet ? 1.04 : 0.7), ey + 0.1, ez + 0.58);                    // B pillar
    }
    box(panelW + 0.5, 0.07, 0.09, matGrey, 0, ey + (jet ? 0.44 : 0.38), ez - 1.0);                      // windshield header
    box(0.04, 0.55, 0.05, matGrey, 0, ey + 0.1, ez - 1.1);                                             // centre post
    // pedestal
    box(0.3, 0.4, 0.8, matGrey, 0, ey - 0.62, ez - 0.2);
    box(0.34, 0.03, 0.8, matDark, 0, ey - 0.42, ez - 0.2);
    // seats
    const seat = (x: number, withFigure: boolean) => {
      box(0.5, 0.12, 0.5, matSeat, x, ey - 0.72, ez + 0.35); const back = box(0.5, 0.75, 0.12, matSeat, x, ey - 0.35, ez + 0.62); back.rotation.x = -0.12;
      box(0.26, 0.2, 0.1, matSeat, x, ey + 0.1, ez + 0.66);
      if (withFigure) { const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.35, 4, 10), M(0x2a3a5a)); t.position.set(x, ey - 0.35, ez + 0.35); this.group.add(t); const h = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), M(0xd9a47d)); h.position.set(x, ey + 0.0, ez + 0.3); this.group.add(h); if (jet || spec.kind === 'turboprop') { box(0.24, 0.05, 0.2, M(0x151a30), x, ey + 0.1, ez + 0.3); } }
    };
    seat(ex, false); seat(-ex, spec.kind !== 'piston' || true);
    // ---------------- instrument panels ----------------
    const mkCanvasPanel = (W: number, H: number, size: [number, number], pos: [number, number, number], tilt: number, draw: (g: CanvasRenderingContext2D, W: number, H: number, d: PanelData) => void, shared?: { c: HTMLCanvasElement; t: THREE.CanvasTexture }) => {
      const c = shared?.c || document.createElement('canvas'); c.width = W; c.height = H;
      const t = shared?.t || new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ map: t }));
      m.position.set(...pos); m.rotation.x = tilt; this.group.add(m);
      if (!shared) this.panels.push({ c, t, draw, W, H });
      return { c, t };
    };
    if (!jet) {
      const pw = piston ? 1.0 : 1.2;
      mkCanvasPanel(1024, 512, [pw, pw / 2], [ex + 0.2, ey - 0.3, ez - 0.8], -0.22, (g, W, H, d) => drawSteam(g, W, H, d, spec));
      // yoke
      this.yoke = new THREE.Group(); this.yoke.position.set(ex + 0.05, ey - 0.33, ez - 0.52); this.group.add(this.yoke);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.35, 10).rotateX(Math.PI / 2), matMetal); col.position.z = -0.17; this.yoke.add(col);
      const wheelG = new THREE.Group(); wheelG.position.z = 0.0; this.yoke.add(wheelG); this.yokeWheel = wheelG;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.014, 8, 24), matBlack); wheelG.add(ring);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.03, 0.03), matBlack); wheelG.add(bar);
      const hub = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), matBlack); wheelG.add(hub);
      for (const sx of [-1, 1]) { const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 8), matBlack); grip.position.set(sx * 0.115, 0, 0); wheelG.add(grip); }
      const hitY = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshBasicMaterial({ visible: false })); hitY.userData.id = 'yoke'; wheelG.add(hitY); this.interactive.push(hitY);
      // copilot yoke
      const y2 = this.yoke.clone(); y2.position.x = -ex - 0.05; this.group.add(y2); y2.traverse((o) => { if (o.userData.id) o.userData.id = undefined; });
    } else {
      this.isStick = true;
      const sizeS: [number, number] = [0.36, 0.36];
      const pfd = mkCanvasPanel(512, 512, sizeS, [ex - 0.02, ey - 0.4, ez - 0.88], -0.18, (g, W, H, d) => drawPFD(g, W, H, d, spec));
      const nd = mkCanvasPanel(512, 512, sizeS, [ex + 0.36, ey - 0.4, ez - 0.88], -0.18, (g, W, H, d) => drawND(g, W, H, d, spec));
      const ei = mkCanvasPanel(512, 512, sizeS, [0.0, ey - 0.38, ez - 0.88], -0.18, (g, W, H, d) => drawEICAS(g, W, H, d, spec));
      mkCanvasPanel(512, 512, sizeS, [-ex + 0.02, ey - 0.4, ez - 0.88], -0.18, () => 0, pfd); mkCanvasPanel(512, 512, sizeS, [-ex - 0.36, ey - 0.4, ez - 0.88], -0.18, () => 0, nd);
      mkCanvasPanel(512, 512, [0.3, 0.3], [0.0, ey - 0.7, ez - 0.8], -0.5, () => 0, ei);
      this.yoke = new THREE.Group(); this.yoke.position.set(ex - 0.42, ey - 0.42, ez - 0.2); this.group.add(this.yoke);
      box(0.12, 0.08, 0.3, matDark, 0, -0.05, 0.05, this.yoke);
      const stick = new THREE.Group(); this.yoke.add(stick); this.yokeWheel = stick;
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.2, 10), matBlack); sh.position.y = 0.1; stick.add(sh);
      const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.08, 4, 8), matBlack); grip.position.y = 0.22; grip.rotation.x = -0.3; stick.add(grip);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 0.15; hit.userData.id = 'yoke'; stick.add(hit); this.interactive.push(hit);
      const y2 = this.yoke.clone(); y2.position.x = -ex + 0.42; this.group.add(y2); y2.traverse((o) => { o.userData.id = undefined; });
      // overhead panel
      box(0.9, 0.04, 0.6, matGrey, 0, ey + 0.55, ez - 0.55).rotation.x = 0.2;
    }
    // pedals
    for (const sd of [-1, 1]) { const p = box(0.12, 0.2, 0.03, matMetal, ex + sd * 0.15, ey - 0.86, ez - 0.55); p.rotation.x = -0.4; this.pedals.push(p); }
    // ---------------- touch panels ----------------
    const sw = [['bcn', 'BEACON'], ['strb', 'STROBE'], ['nav', 'NAV LT'], ['land', 'LAND LT'], ['belt', 'SEAT\nBELTS'], ['pa', 'CABIN\nPA'], ['park', 'PARK\nBRAKE']];
    if (spec.hasReverse) sw.push(['rev', 'REVERSE']); if (spec.hasSpeedbrake) sw.push(['sb', 'SPOILER']);
    const swPanel = new TouchPanel(96 * sw.length, 112, sw.length, 1, sw.map((s, i) => ({ id: s[0], label: s[1], c: i, r: 0 })), [0.115 * sw.length, 0.13]);
    const ap = [['ap', 'AP'], ['apnav', 'NAV'], ['appr', 'APPR'], ['_hdg', 'HDG'], ['hdg-', 'HDG −'], ['hdg+', 'HDG +'], ['_alt', 'ALT'], ['alt-', 'ALT −'], ['alt+', 'ALT +'], ['_spd', 'SPD'], ['spd-', 'SPD −'], ['spd+', 'SPD +']];
    const apPanel = new TouchPanel(96 * 6, 224, 6, 2, [{ id: 'ap', label: 'AP', c: 0, r: 0 }, { id: 'apnav', label: 'NAV', c: 1, r: 0 }, { id: 'appr', label: 'APPR', c: 2, r: 0 }, { id: '_hdg', label: 'HDG', c: 3, r: 0 }, { id: '_alt', label: 'ALT', c: 4, r: 0 }, { id: '_spd', label: 'SPD', c: 5, r: 0 },
      { id: 'hdg-', label: 'HDG −', c: 0, r: 1 }, { id: 'hdg+', label: 'HDG +', c: 1, r: 1 }, { id: 'alt-', label: 'ALT −', c: 2, r: 1 }, { id: 'alt+', label: 'ALT +', c: 3, r: 1 }, { id: 'spd-', label: 'SPD −', c: 4, r: 1 }, { id: 'spd+', label: 'SPD +', c: 5, r: 1 }], [0.62, 0.23]);
    void ap;
    if (jet) { swPanel.mesh.position.set(0.0, ey - 0.56, ez - 0.7); swPanel.mesh.rotation.x = -0.9; swPanel.mesh.position.x = 0; apPanel.mesh.position.set(ex + 0.35, ey - 0.03, ez - 0.98); apPanel.mesh.rotation.x = -1.05; }
    else { swPanel.mesh.position.set(ex + 0.2, ey - 0.63, ez - 0.74); swPanel.mesh.rotation.x = -0.35; apPanel.mesh.position.set(ex + 0.2, ey - 0.02, ez - 1.0); apPanel.mesh.rotation.x = -1.15; apPanel.mesh.scale.setScalar(0.75); }
    this.group.add(swPanel.mesh, apPanel.mesh); this.interactive.push(swPanel.mesh, apPanel.mesh); this.touch.push(swPanel, apPanel);
    // ---------------- levers ----------------
    const lever = (id: string, x: number, h: number, color: number, knob: THREE.BufferGeometry, rest: number, name = '') => {
      const g = new THREE.Group(); g.name = name; g.position.set(x, ey - 0.43, ez - 0.2 + rest); this.group.add(g);
      const slot = box(0.025, 0.012, 0.4, matBlack, x, ey - 0.425, ez - 0.2 + rest - 0.0); void slot;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, h, 0.02), matMetal); arm.position.y = h / 2; g.add(arm);
      const k = new THREE.Mesh(knob, M(color, 0.5, 0.2)); k.position.y = h; g.add(k);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = h * 0.8; hit.userData.id = id; g.add(hit); this.interactive.push(hit);
      return g;
    };
    const kx = ex + 0.0;
    this.throttleLever = lever('throttle', jet ? -0.07 : 0.05, 0.14, 0x111111, new THREE.SphereGeometry(0.032, 12, 10), 0);
    if (!piston) lever('throttle', jet ? 0.02 : -0.02, 0.14, 0x111111, new THREE.SphereGeometry(0.032, 12, 10), 0, 'thr2');
    this.flapsLever = lever('flaps', jet ? 0.11 : 0.12, 0.1, 0x2b66d0, new THREE.BoxGeometry(0.05, 0.03, 0.04), 0);
    this.gearLever = lever('gear', jet ? -0.15 : -0.13, 0.08, 0xdddddd, new THREE.CylinderGeometry(0.03, 0.03, 0.025, 16).rotateZ(Math.PI / 2), 0);
    if (spec.hasSpeedbrake) this.sbLever = lever('speedbrake', 0.17, 0.12, 0xd93a3a, new THREE.BoxGeometry(0.04, 0.025, 0.05), 0);
    void kx;
    // ---------------- cabin ----------------
    this.buildCabin(M, box, matSeat);
    this.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = true; });
  }

  private buildCabin(M: (c: number, r?: number, m?: number) => THREE.MeshStandardMaterial, box: (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D) => THREE.Mesh, matSeat: THREE.Material) {
    const s = this.spec, [, ey, ez] = s.eye;
    const jet = s.kind === 'jet', trek = s.kind === 'turboprop';
    const radius = jet ? 1.93 : trek ? 0.98 : 0.6;
    const floorY = jet ? -0.62 : trek ? -0.5 : -0.6;
    const rows = jet ? 25 : trek ? 6 : 1, pitch = jet ? 0.8 : trek ? 0.88 : 1;
    const perSide = jet ? 3 : trek ? 1 : 1;
    const zFront = jet ? -10.6 : trek ? -3.6 : ez + 0.75, len = jet ? 21.5 : trek ? 9.4 : 2.0;
    const zc = zFront + len / 2;
    // shell with window cut-outs (alpha-tested so the world pass shows through)
    const W = 1024, H = jet ? 2048 : 1024, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d')!;
    g.fillStyle = '#e8e4da'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#d3cec2'; g.fillRect(W * 0.38, 0, W * 0.24, H); // ceiling panel
    g.fillStyle = '#b9b4a8'; g.fillRect(0, 0, W * 0.02, H);
    const circ = 2 * Math.PI * radius;
    const nWin = Math.floor(len / (jet ? 0.8 : trek ? 0.88 : 0.9));
    g.globalCompositeOperation = 'destination-out';
    for (const side of jet || trek ? [0.266, 0.734] : [0.27, 0.73]) for (let i = 0; i < nWin; i++) {
      const wz = zFront + (i + 0.5) * (len / nWin), v = (wz - zFront) / len, cxp = side * W, cyp = (1 - v) * H;
      const wpx = (0.3 / circ) * W * (jet ? 1 : 1.2), hpx = (0.3 / len) * H * (jet ? 1.1 : 0.9);
      g.beginPath(); g.roundRect(cxp - wpx / 2, cyp - hpx / 2, wpx, hpx, 12); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const shellGeo = new THREE.CylinderGeometry(radius, radius, len, 40, 1, true).rotateX(Math.PI / 2);
    const shell = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.BackSide, roughness: 0.9, metalness: 0 }));
    shell.position.set(0, 0, zc); this.group.add(shell);
    // window frames (dark ring)
    // floor + carpet
    box(radius * 1.5, 0.06, len, M(0x3a4552, 0.95, 0), 0, floorY - 0.03, zc); box(0.5, 0.062, len, M(spec_color(s.accent), 0.95, 0), 0, floorY - 0.029, zc);
    // end bulkheads
    const bh = box(radius * 2, radius * 2, 0.06, M(0xdcd8cf, 0.9, 0), 0, 0, zFront + len + 0.03); void bh;
    if (jet || trek) { const front = box(radius * 2, radius * 2, 0.06, M(0xdcd8cf, 0.9, 0), 0, 0, zFront - 0.03); void front; box(0.8, 1.8, 0.08, M(0x6a737d, 0.5, 0.2), 0, floorY + 0.9, zFront + 0.02); }
    // seats (merged) instanced
    const seatGeo = mergeGeometries([
      new THREE.BoxGeometry(0.44, 0.1, 0.46).translate(0, 0.0, 0), new THREE.BoxGeometry(0.44, 0.62, 0.1).translate(0, 0.34, 0.2), new THREE.BoxGeometry(0.24, 0.16, 0.08).translate(0, 0.72, 0.2), new THREE.BoxGeometry(0.04, 0.3, 0.38).translate(-0.22, 0.12, 0), new THREE.BoxGeometry(0.04, 0.3, 0.38).translate(0.22, 0.12, 0),
    ])!;
    const xs: number[] = jet ? [-1.38, -0.94, -0.5, 0.5, 0.94, 1.38] : trek ? [-0.5, 0.5] : [-0.33, 0.33];
    void perSide;
    const seatCount = rows * xs.length;
    const seats = new THREE.InstancedMesh(seatGeo, matSeat, seatCount);
    const d = new THREE.Object3D(); let k = 0;
    const paxSlots: { x: number; y: number; z: number }[] = [];
    for (let r = 0; r < rows; r++) for (const x of xs) {
      const z = (jet ? zFront + 1.0 : zFront + 0.9) + r * pitch;
      d.position.set(x, floorY + 0.25, z); d.rotation.y = jet || trek ? 0 : Math.PI; d.updateMatrix(); seats.setMatrixAt(k++, d.matrix);
      paxSlots.push({ x, y: floorY + 0.25, z });
    }
    seats.instanceMatrix.needsUpdate = true; this.group.add(seats);
    // overhead bins + lights
    if (jet || trek) for (const sd of [-1, 1]) {
      box(0.5, 0.34, len - 0.2, M(0xd8d4ca, 0.9, 0), sd * (radius - 0.55), radius * 0.62, zc).rotation.z = sd * 0.35;
      box(0.05, 0.03, len - 0.4, new THREE.MeshBasicMaterial({ color: 0xfff4d6 }), sd * 0.45, radius - 0.2, zc);
    }
    // sign
    this.beltSign = box(0.28, 0.08, 0.02, new THREE.MeshBasicMaterial({ color: 0x223322 }), 0, jet ? 1.35 : 0.8, zFront + 0.1 + (jet ? 0 : 0.1));
    // passengers
    const want = Math.min(s.pax, paxSlots.length);
    const slots = paxSlots.slice().sort(() => Math.random() - 0.5).slice(0, want);
    if (s.kind === 'piston') { const sl = paxSlots.slice(0, 2); slots.length = 0; slots.push(...sl, { x: -this.spec.eye[0], y: ey - 0.9, z: ez + 0.35 }); slots.length = Math.min(3, slots.length); }
    this.paxN = slots.length;
    const torsoGeo = new THREE.CapsuleGeometry(0.15, 0.28, 3, 8).translate(0, 0.38, 0.0), headGeo = new THREE.SphereGeometry(0.1, 10, 8);
    this.torsos = new THREE.InstancedMesh(torsoGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), this.paxN);
    this.heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), this.paxN);
    const cl = [0x2f4f7a, 0x7a2f3a, 0x3e6b4a, 0x6b5a3a, 0x5a3e6b, 0x888888, 0xc2a23a, 0x2a2a2a], sk = [0xf1c8a0, 0xd9a47d, 0xb97c55, 0x8d5a3b, 0x5e3b24];
    slots.forEach((p, i) => {
      d.rotation.set(0, 0, 0); d.position.set(p.x, p.y + 0.02, p.z + 0.04); d.updateMatrix(); this.torsos!.setMatrixAt(i, d.matrix); this.paxBase.push(d.matrix.clone());
      this.torsos!.setColorAt(i, new THREE.Color(cl[(Math.random() * cl.length) | 0]));
      d.position.set(p.x, p.y + 0.82, p.z + 0.02); d.updateMatrix(); this.heads!.setMatrixAt(i, d.matrix); this.paxHeadBase.push(d.matrix.clone());
      this.heads!.setColorAt(i, new THREE.Color(sk[(Math.random() * sk.length) | 0]));
    });
    this.heads.userData.id = 'pax'; this.interactive.push(this.heads); this.torsos.userData.id = 'pax'; this.interactive.push(this.torsos);
    this.group.add(this.torsos, this.heads);
    this.heads.frustumCulled = false; this.torsos.frustumCulled = false;
  }

  setQuality(q: QualityPreset) { this.quality = q; }

  /** Called every frame while interior is visible. */
  update(dt: number, time: number, data: PanelData, inp: CockpitInputs, ui: CockpitUi, visible: boolean) {
    if (!visible) return;
    this.acc += dt;
    const period = this.quality === 'ultra' ? 1 / 60 : this.quality === 'high' ? 1 / 30 : this.quality === 'medium' ? 1 / 25 : 1 / 15;
    if (this.acc >= period) {
      this.acc = 0;
      for (const p of this.panels) { const g = p.c.getContext('2d')!; p.draw(g, p.W, p.H, data); p.t.needsUpdate = true; }
    }
    const L = ui.lights;
    const lit = (id: string) => ({ bcn: L.beacon, strb: L.strobe, nav: L.nav, land: L.land, belt: ui.seatbelt, park: ui.parking, rev: ui.reverse, sb: inp.speedbrake > 0.1, ap: ui.apOn, apnav: ui.apNav, appr: ui.apAppr, pa: false } as Record<string, boolean>)[id] || false;
    const info = (id: string) => id === '_hdg' ? `HDG\n${String(Math.round(ui.apHdg)).padStart(3, '0')}` : id === '_alt' ? `ALT\n${Math.round(ui.apAlt)}` : id === '_spd' ? `SPD\n${Math.round(ui.apSpd)}` : undefined;
    for (const t of this.touch) t.draw(lit, info);
    // levers & controls
    this.throttleLever.rotation.x = -inp.throttle * 0.75 + 0.35 * 0;
    const t2 = this.group.getObjectByName('thr2'); if (t2) t2.rotation.x = -inp.throttle * 0.75;
    this.flapsLever.rotation.x = -(inp.flapsIdx / this.spec.flapDetents) * 0.6;
    this.gearLever.position.y = (this.gearLever.userData.y0 ??= this.gearLever.position.y) + (inp.gearDown ? -0.0 : 0.035);
    if (this.sbLever) this.sbLever.rotation.x = inp.speedbrake * 0.7;
    if (this.yokeWheel) {
      if (this.isStick) { this.yokeWheel.rotation.z = -inp.roll * 0.4; this.yokeWheel.rotation.x = -inp.pitch * 0.35; }
      else { this.yokeWheel.rotation.z = -inp.roll * 1.1; this.yoke.position.z = (this.yoke.userData.z0 ??= this.yoke.position.z) + inp.pitch * 0.07; }
    }
    this.pedals[0].position.z = (this.pedals[0].userData.z0 ??= this.pedals[0].position.z) - inp.yaw * 0.04; this.pedals[1].position.z = (this.pedals[1].userData.z0 ??= this.pedals[1].position.z) + inp.yaw * 0.04;
    if (this.beltSign) (this.beltSign.material as THREE.MeshBasicMaterial).color.set(ui.seatbelt ? 0x44ff77 : 0x1b2a1f);
    // passenger idle motion
    this.paxAcc += dt;
    if (this.heads && this.torsos && this.paxAcc > 0.06) {
      this.paxAcc = 0; const m = new THREE.Matrix4(), tm = new THREE.Matrix4();
      const shake = ui.shake, calm = ui.mood;
      for (let i = 0; i < this.paxN; i++) {
        const ph = i * 1.7, bob = Math.sin(time * 1.2 + ph) * 0.004 + Math.sin(time * 17 + ph) * 0.012 * shake;
        const sway = Math.sin(time * 9 + ph * 3) * 0.02 * shake, look = Math.sin(time * 0.3 + ph) * 0.4;
        tm.makeRotationZ(sway); m.copy(this.paxHeadBase[i]); m.multiply(new THREE.Matrix4().makeRotationY(look)); m.elements[13] += bob + (calm < 0.4 ? Math.sin(time * 3 + ph) * 0.006 : 0); m.elements[12] += sway * 0.2;
        this.heads.setMatrixAt(i, m); this.torsos.setMatrixAt(i, this.paxBase[i].clone().multiply(tm));
      }
      this.heads.instanceMatrix.needsUpdate = true; this.torsos.instanceMatrix.needsUpdate = true;
    }
  }

  /** Raycast helper: returns id (+ optional instance) of the interactive element under the pointer. */
  pick(ray: THREE.Raycaster): { id: string; instance?: number; point: THREE.Vector3 } | null {
    const hits = ray.intersectObjects(this.interactive, false);
    for (const h of hits) {
      const panel = h.object.userData.panel as TouchPanel | undefined;
      if (panel && h.uv) { const id = panel.hit(h.uv); if (id) return { id, point: h.point }; continue; }
      if (h.object.userData.id) return { id: h.object.userData.id as string, instance: h.instanceId, point: h.point };
    }
    return null;
  }
  dispose() { this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); }); }
}
const spec_color = (c: number) => (c & 0xfefefe) >> 1 | 0x101010 & 0;
