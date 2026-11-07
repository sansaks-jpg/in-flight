// Cloud-to-ground lightning for thunderstorm conditions (wx.thunder from the live report):
//   * pre-built jagged ribbon bolts (three variants, unit height, scaled to the cloud-to-ground
//     span) billboarded to face the camera per strike — geometry is never rebuilt at runtime,
//   * a dedicated directional flash light so the sun/hemisphere lights are never left polluted,
//   * a distance hook (`onStrike`) the host wires to procedural thunder (audio.ts) — sound covers
//     ~343 m/s, so the rumble arrives after the flash exactly like reality,
//   * the cadence runs on the simulation clock passed by World.update, so pausing the sim freezes
//     the storm (the old fixed-1/60 decrement advanced flashes 2× too fast at 120 Hz and ran on
//     its own timer).
// Zero-allocation per frame: only scalars and pre-existing objects are touched.
import * as THREE from 'three';

export const BOLT_DUR = 0.34; // seconds of visible flicker per strike
const STRIKE_MIN_M = 2600;
const STRIKE_MAX_M = 8200;

const hashN = (a: number, b: number, s = 0) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Jagged ribbon strip for one bolt variant. Unit space: y ∈ [0,1] spans ground→cloud base, so
 *  jitter and width (fractions of the height) scale with the real strike span via uniform scaling.
 *  One main channel plus two branches, converted to indexed triangles (two vertices per point). */
function buildBoltGeometry(seed: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const strip = (line: number[], base: number) => {
    const n = line.length / 3;
    for (let i = 0; i < n; i++) {
      pos.push(line[i * 3] - line[i * 3 + 2], line[i * 3 + 1], 0);
      pos.push(line[i * 3] + line[i * 3 + 2], line[i * 3 + 1], 0);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    return base + n * 2;
  };
  // main channel: random walk upward, jitter growing toward the cloud, wider inside the deck
  const main: number[] = [];
  let x = 0;
  for (let i = 0; i <= 10; i++) {
    const y = i / 10;
    x += (hashN(seed, i, 1) - 0.5) * 0.05 * (0.3 + y);
    main.push(x, y, 0.0045 * (0.55 + 0.45 * y));
  }
  let base = strip(main, 0);
  // two branches hanging from mid-channel points, drifting sideways on the way down
  for (let b = 0; b < 2; b++) {
    const at = 4 + b * 3;
    const sx = main[at * 3], sy = main[at * 3 + 1];
    const dir = hashN(seed, b, 21) > 0.5 ? 1 : -1;
    const br: number[] = [];
    let bx = sx;
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      bx += (hashN(seed, i + b * 10, 22) - 0.5) * 0.05 + dir * 0.012;
      br.push(bx, sy * (1 - t * 0.75), 0.0022 * (1 - t * 0.4));
    }
    base = strip(br, base);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class LightningSystem {
  group = new THREE.Group();
  light: THREE.DirectionalLight;
  /** Wired by the host (game.ts) to play procedural thunder; receives the strike distance in metres. */
  onStrike: ((distM: number) => void) | null = null;
  private bolts: THREE.Mesh[] = [];
  private mat: THREE.MeshBasicMaterial;
  private active = false;
  private nextT = 5;
  private boltT = -1;
  private lastTime = -1;
  private timeInit = false;
  private power = 1;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xe6ecff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false, // the bolt is an emissive source — FogExp2 would dim its blue-white colour into a flat grey band
    });
    for (let v = 0; v < 3; v++) {
      const m = new THREE.Mesh(buildBoltGeometry(v * 17 + 3), this.mat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 25; // after precipitation (20): the bolt reads through the rain
      this.bolts.push(m);
      this.group.add(m);
    }
    // straight-down flash light (position→target), intensity driven by the strike envelope only
    this.light = new THREE.DirectionalLight(0xdfe6ff, 0);
    this.light.position.set(0, 1, 0);
    this.group.add(this.light, this.light.target);
    scene.add(this.group);
  }

  setActive(on: boolean) {
    this.active = on;
    if (on) {
      // a storm that re-arms (METAR flip) must not strike instantly on a near-expired countdown
      this.nextT = Math.max(this.nextT, 1.2);
    } else {
      this.boltT = -1;
      this.light.intensity = 0;
      this.mat.opacity = 0;
      for (const b of this.bolts) b.visible = false;
    }
  }

  /** @param time simulation clock (seconds; dt derived here — 0 while paused/loading) */
  update(time: number, cam: THREE.Vector3, cloudBaseMsl: number, heightAt: (x: number, z: number) => number) {
    let dt = time - this.lastTime;
    this.lastTime = time;
    if (!this.timeInit) { dt = 0; this.timeInit = true; } // the very first frame must not step the countdown
    if (!(dt > 0) || dt > 2) dt = 0;
    if (dt > 0 && this.active) {
      this.nextT -= dt;
      if (this.nextT <= 0) this.strike(cam, cloudBaseMsl, heightAt);
    }
    if (this.boltT > 0) {
      this.boltT -= dt;
      const f = Math.max(0, this.boltT / BOLT_DUR);
      // double-stroke envelope: return stroke, brief dark pause, restrike, decay
      const env = f > 0.82 ? 1 : f > 0.68 ? 0.1 : f > 0.55 ? 0.8 : f > 0.34 ? 0.22 : f > 0.12 ? 0.55 : f * 4;
      const flick = 0.72 + 0.28 * Math.random();
      this.mat.opacity = env * flick;
      this.light.intensity = env * flick * 3.4 * this.power;
      if (this.boltT <= 0) {
        this.boltT = -1;
        this.light.intensity = 0;
        this.mat.opacity = 0;
        for (const b of this.bolts) b.visible = false;
      }
    }
  }

  private strike(cam: THREE.Vector3, cloudBaseMsl: number, heightAt: (x: number, z: number) => number) {
    const ang = Math.random() * Math.PI * 2;
    const d = STRIKE_MIN_M + Math.random() * (STRIKE_MAX_M - STRIKE_MIN_M);
    const x = cam.x + Math.sin(ang) * d, z = cam.z + Math.cos(ang) * d;
    const ground = heightAt(x, z);
    const span = Math.max(150, cloudBaseMsl - ground);
    const bolt = this.bolts[(Math.random() * this.bolts.length) | 0];
    bolt.position.set(x, ground, z);
    bolt.scale.set(span, span, span); // unit-space geometry: uniform scale = the real strike span
    bolt.rotation.y = Math.atan2(cam.x - x, cam.z - z); // ribbon plane faces the camera
    for (const b of this.bolts) b.visible = b === bolt;
    this.boltT = BOLT_DUR;
    this.power = 0.65 + Math.random() * 0.6 * (1 - (0.5 * d) / STRIKE_MAX_M);
    this.nextT = 2.5 + Math.random() * 8.5;
    if (this.onStrike) this.onStrike(d);
  }

  dispose() {
    for (const b of this.bolts) b.geometry.dispose();
    this.bolts.length = 0;
    this.mat.dispose();
    this.scene.remove(this.group);
  }
}
