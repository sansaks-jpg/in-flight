// Pooled GPU-point particle system: sparks, smoke, fire, dust, tyre smoke.
import * as THREE from 'three';

const MAX = 900;
export class Effects {
  group = new THREE.Group();
  private pos = new Float32Array(MAX * 3); private col = new Float32Array(MAX * 3); private size = new Float32Array(MAX); private alpha = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3); private life = new Float32Array(MAX); private maxLife = new Float32Array(MAX); private grav = new Float32Array(MAX); private drag = new Float32Array(MAX); private grow = new Float32Array(MAX); private size0 = new Float32Array(MAX); private add = new Uint8Array(MAX); private c0 = new Float32Array(MAX * 3);
  private geo = new THREE.BufferGeometry(); private points: THREE.Points; private next = 0;
  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      // The main camera uses a logarithmic depth buffer (scene range is 2 m … 750 km), so this
      // custom shader must participate in it too or its depth values would not be comparable.
      vertexShader: `#include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float psize; attribute float palpha; attribute vec3 color; varying float vA; varying vec3 vC;
        void main(){ vA = palpha; vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = psize * 600.0 / max(1.0,-mv.z); gl_Position = projectionMatrix*mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `#include <logdepthbuf_pars_fragment>
        varying float vA; varying vec3 vC;
        void main(){ vec2 d = gl_PointCoord-0.5; float r = length(d); if(r>0.5) discard; float a = smoothstep(0.5,0.05,r)*vA; gl_FragColor = vec4(vC, a);
          #include <logdepthbuf_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat); this.points.frustumCulled = false; this.points.renderOrder = 5; this.group.add(this.points); scene.add(this.group);
    this.life.fill(0);
  }
  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, color: number, o: { grav?: number; drag?: number; grow?: number; add?: boolean } = {}) {
    const i = this.next; this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z; this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = this.maxLife[i] = life; this.size0[i] = size; this.grav[i] = o.grav ?? 0; this.drag[i] = o.drag ?? 0.5; this.grow[i] = o.grow ?? 0; this.add[i] = o.add ? 1 : 0;
    const c = new THREE.Color(color); this.c0[i * 3] = c.r; this.c0[i * 3 + 1] = c.g; this.c0[i * 3 + 2] = c.b;
  }
  sparks(p: THREE.Vector3, n: number, dir: THREE.Vector3) {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { v.set((Math.random() - 0.5) * 8 + dir.x * 0.3, Math.random() * 5 + 1, (Math.random() - 0.5) * 8 + dir.z * 0.3); this.emit(p, v, 0.4 + Math.random() * 0.5, 0.35, 0xffc15a, { grav: 12, drag: 0.1, add: true }); }
  }
  tyreSmoke(p: THREE.Vector3, vel: THREE.Vector3, n = 6) {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { v.set(vel.x * 0.15 + (Math.random() - 0.5) * 2, 0.6 + Math.random() * 1.2, vel.z * 0.15 + (Math.random() - 0.5) * 2); this.emit(p, v, 1.6 + Math.random(), 1.4, 0xd8d8d8, { drag: 1.5, grow: 2.2 }); }
  }
  dust(p: THREE.Vector3, n = 5) { const v = new THREE.Vector3(); for (let i = 0; i < n; i++) { v.set((Math.random() - 0.5) * 6, Math.random() * 2, (Math.random() - 0.5) * 6); this.emit(p, v, 1.5 + Math.random(), 2, 0xb9a98a, { drag: 1.2, grow: 3 }); } }
  explosion(p: THREE.Vector3, vel: THREE.Vector3, scale = 1) {
    const v = new THREE.Vector3();
    for (let i = 0; i < 110; i++) { v.set((Math.random() - 0.5) * 36, Math.random() * 26, (Math.random() - 0.5) * 36).multiplyScalar(scale).add(vel.clone().multiplyScalar(0.4)); this.emit(p, v, 0.8 + Math.random() * 1.4, (5 + Math.random() * 7) * scale, i % 3 ? 0xff7a1c : 0xffd24a, { drag: 1.4, grow: 6 * scale, add: true }); }
    for (let i = 0; i < 90; i++) { v.set((Math.random() - 0.5) * 22, Math.random() * 16 + 3, (Math.random() - 0.5) * 22).multiplyScalar(scale); this.emit(p, v, 3 + Math.random() * 4, (6 + Math.random() * 6) * scale, 0x222222, { drag: 0.6, grow: 5 * scale, grav: -2 }); }
    this.sparks(p, 40, vel);
  }
  fire(p: THREE.Vector3, scale = 1) {
    const v = new THREE.Vector3(); v.set((Math.random() - 0.5) * 3, 4 + Math.random() * 6, (Math.random() - 0.5) * 3);
    this.emit(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6 * scale, 0, (Math.random() - 0.5) * 6 * scale)), v, 0.9 + Math.random(), (3 + Math.random() * 3) * scale, Math.random() > 0.5 ? 0xff8a1a : 0xffd04a, { drag: 0.5, grow: 3, add: true });
    v.set((Math.random() - 0.5) * 3, 6 + Math.random() * 6, (Math.random() - 0.5) * 3); this.emit(p, v, 3 + Math.random() * 2, (4 + Math.random() * 4) * scale, 0x2a2a2a, { drag: 0.4, grow: 4 });
  }
  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt; const t = 1 - this.life[i] / this.maxLife[i];
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.size0[i] + this.grow[i] * t;
      const fade = this.add[i] ? 1 - t : Math.sin(Math.min(1, t * 4) * Math.PI / 2) * (1 - t);
      this.alpha[i] = Math.max(0, fade) * (this.add[i] ? 0.9 : 0.55);
      const k = this.add[i] ? 1 - t * 0.6 : 1;
      this.col[i * 3] = this.c0[i * 3] * k; this.col[i * 3 + 1] = this.c0[i * 3 + 1] * k * (this.add[i] ? 1 - t * 0.3 : 1); this.col[i * 3 + 2] = this.c0[i * 3 + 2] * k;
    }
    for (const a of ['position', 'color', 'psize', 'palpha']) (this.geo.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }
  clear() { this.life.fill(0); }
  shift(dx: number, dz: number) { for (let i = 0; i < MAX; i++) { this.pos[i * 3] += dx; this.pos[i * 3 + 2] += dz; } }
  dispose() { this.geo.dispose(); (this.points.material as THREE.Material).dispose(); this.group.parent?.remove(this.group); }
}
