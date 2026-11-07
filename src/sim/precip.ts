// Rain / snow streaks around the camera. Drops are advected by the real relative airflow (aircraft velocity vs. wind), so at
// 120 kt rain streams almost horizontally past the cockpit, while parked on the apron it falls straight down.
// The arrays are allocated ONCE for the largest preset budget (the caller passes QUALITY.ultra.precipMax)
// and the per-frame draw range / loop cap follow the ACTIVE preset via setQuality (quality.precipMax).
import * as THREE from 'three';

const RX = 26, RY = 18;
export class Precip {
  group = new THREE.Group();
  private max: number; private cap: number; private lastCnt = 0;
  private pos: Float32Array; private seg: Float32Array;
  private geo = new THREE.BufferGeometry(); private mat: THREE.LineBasicMaterial; private lines: THREE.LineSegments;
  private rain = 0; private snow = 0; private ready = false;
  constructor(scene: THREE.Scene, max = 2600) {
    this.max = Math.max(400, Math.round(max));
    this.cap = this.max;
    this.pos = new Float32Array(this.max * 3); this.seg = new Float32Array(this.max * 6);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.seg, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.LineBasicMaterial({ color: 0xbfcfe0, transparent: true, opacity: 0.4, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat); this.lines.frustumCulled = false; this.lines.renderOrder = 20; this.lines.visible = false;
    this.group.add(this.lines); scene.add(this.group);
  }
  /** Adjust the active particle cap to a (new) quality preset without reallocating (may raise up to the allocated max). */
  setQuality(max: number) { this.cap = Math.max(400, Math.min(this.max, Math.round(max))); }
  /** Segments drawn by the last update (tests / debug). */
  get drawn() { return this.geo.drawRange.count / 2; }
  set(rain: number, snow: number) { this.rain = rain; this.snow = snow; }
  /** @param rel velocity of the air relative to the camera (wind - aircraft), world axes; @param ceilingMsl rain only falls below the cloud deck */
  update(dt: number, cam: THREE.Vector3, rel: THREE.Vector3, ceilingMsl: number, brightness: number) {
    const inten = Math.max(this.rain, this.snow);
    const active = inten > 0.02 && cam.y < ceilingMsl + 400;
    this.lines.visible = active;
    if (!active) { this.ready = false; this.lastCnt = 0; this.geo.setDrawRange(0, 0); return; }
    if (!this.ready) {
      // seed every allocated slot once, so raising the cap later never spawns at the origin
      for (let i = 0; i < this.max; i++) { this.pos[i * 3] = cam.x + (Math.random() * 2 - 1) * RX; this.pos[i * 3 + 1] = cam.y + (Math.random() * 2 - 1) * RY; this.pos[i * 3 + 2] = cam.z + (Math.random() * 2 - 1) * RX; }
      this.ready = true;
      this.lastCnt = 0;
    }
    const snow = this.snow > this.rain;
    // terminal velocities: raindrops fall faster the heavier the shower (drizzle ~6.5, downpour ~9 m/s); snow drifts (~1.3 m/s)
    const fall = snow ? 1.3 : 6.5 + 2.5 * inten;
    const vx = rel.x, vy = rel.y - fall, vz = rel.z; const sp = Math.hypot(vx, vy, vz) || 1;
    const len = snow ? 0.12 : Math.min(3.5, Math.max(0.35, sp * 0.022));
    const dx = vx / sp * len, dy = vy / sp * len, dz = vz / sp * len;
    const cap = this.cap;
    const cnt = Math.max(80, Math.floor(cap * Math.min(1, 0.12 + inten * 0.9)));
    // slots newly drawn into the window (cap or intensity rose) seed around the camera instead of
    // thawing from wherever they froze when they were last active — no kilometre-away stragglers
    for (let i = this.lastCnt; i < cnt; i++) {
      const o = i * 3;
      this.pos[o] = cam.x + (Math.random() * 2 - 1) * RX; this.pos[o + 1] = cam.y + (Math.random() * 2 - 1) * RY; this.pos[o + 2] = cam.z + (Math.random() * 2 - 1) * RX;
    }
    this.lastCnt = cnt;
    for (let i = 0; i < cnt; i++) {
      const o = i * 3; let x = this.pos[o] + vx * dt, y = this.pos[o + 1] + vy * dt, z = this.pos[o + 2] + vz * dt;
      // wrap inside the box that follows the camera
      if (x - cam.x > RX) x -= 2 * RX; else if (x - cam.x < -RX) x += 2 * RX;
      if (z - cam.z > RX) z -= 2 * RX; else if (z - cam.z < -RX) z += 2 * RX;
      if (y - cam.y > RY) y -= 2 * RY; else if (y - cam.y < -RY) y += 2 * RY;
      this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
      const s = i * 6; this.seg[s] = x; this.seg[s + 1] = y; this.seg[s + 2] = z; this.seg[s + 3] = x - dx; this.seg[s + 4] = y - dy; this.seg[s + 5] = z - dz;
    }
    this.geo.setDrawRange(0, cnt * 2); (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.mat.opacity = (snow ? 0.7 : 0.18 + 0.3 * inten) * (0.35 + 0.65 * brightness); this.mat.color.setRGB(0.75 * (0.4 + 0.6 * brightness), 0.8 * (0.4 + 0.6 * brightness), 0.88 * (0.4 + 0.6 * brightness));
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.group.parent?.remove(this.group); }
}
