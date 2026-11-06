// Rain / snow streaks around the camera. Drops are advected by the real relative airflow (aircraft velocity vs. wind), so at
// 120 kt rain streams almost horizontally past the cockpit, while parked on the apron it falls straight down.
import * as THREE from 'three';

const N = 2600, RX = 26, RY = 18;
export class Precip {
  group = new THREE.Group();
  private pos = new Float32Array(N * 3); private seg = new Float32Array(N * 6);
  private geo = new THREE.BufferGeometry(); private mat: THREE.LineBasicMaterial; private lines: THREE.LineSegments;
  private rain = 0; private snow = 0; private ready = false;
  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.seg, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.LineBasicMaterial({ color: 0xbfcfe0, transparent: true, opacity: 0.4, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat); this.lines.frustumCulled = false; this.lines.renderOrder = 20; this.lines.visible = false;
    this.group.add(this.lines); scene.add(this.group);
  }
  set(rain: number, snow: number) { this.rain = rain; this.snow = snow; }
  /** @param rel velocity of the air relative to the camera (wind - aircraft), world axes; @param ceilingMsl rain only falls below the cloud deck */
  update(dt: number, cam: THREE.Vector3, rel: THREE.Vector3, ceilingMsl: number, brightness: number) {
    const inten = Math.max(this.rain, this.snow);
    const active = inten > 0.02 && cam.y < ceilingMsl + 400;
    this.lines.visible = active; if (!active) { this.ready = false; return; }
    if (!this.ready) {
      for (let i = 0; i < N; i++) { this.pos[i * 3] = cam.x + (Math.random() * 2 - 1) * RX; this.pos[i * 3 + 1] = cam.y + (Math.random() * 2 - 1) * RY; this.pos[i * 3 + 2] = cam.z + (Math.random() * 2 - 1) * RX; }
      this.ready = true;
    }
    const snow = this.snow > this.rain; const fall = snow ? 1.3 : 8.5;
    const vx = rel.x, vy = rel.y - fall, vz = rel.z; const sp = Math.hypot(vx, vy, vz) || 1;
    const len = snow ? 0.12 : Math.min(3.5, Math.max(0.35, sp * 0.022));
    const dx = vx / sp * len, dy = vy / sp * len, dz = vz / sp * len;
    const cnt = Math.max(100, Math.floor(N * Math.min(1, 0.12 + inten * 0.9)));
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
