// Level-of-detail satellite tile streaming for the planner globe.
//
//  * A screen-space-error quadtree selects the target tiles for the current camera view.
//  * The global base level (z = 4) is pinned in cache so there is never a hole or solid-color fallback anywhere on Earth.
//  * Target tiles + one binary-search midpoint ancestor are fetched first so deep zooms snap to full sharpness in one
//    round-trip instead of waiting behind 14 intermediate levels; off-screen in-flight requests are aborted on fast pans.
//  * Cross-fading keeps EVERY ancestor visible down to the first opaque (fade === 1) tile beneath it, so multi-level
//    transitions never dip below 100% total opacity.
//  * Esri is queried with `blankTile=false`: missing coverage answers 404 instead of a grey placeholder JPEG.
import * as THREE from 'three';
import { ESRI_IMAGERY_URL, tileUrl } from '../sim/tiles';

const TWO_PI = Math.PI * 2;
export const GLOBE_MIN_TILE_Z = 4;
const MAX_CONCURRENT = 8;
const FADE_S = 0.34;
const RETRY_AFTER_MS = [30_000, 120_000, 600_000];
/** A tile is split once it would be drawn larger than this many CSS pixels (256 px texture => ~1.2 texel/px). */
const SPLIT_PX = 310;

const tmpC = new Float64Array(3);
const tmpK = new Float64Array(3);

const mercLat = (ty: number, z: number) => {
  const n = Math.PI - (TWO_PI * ty) / 2 ** z;
  return (Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180) / Math.PI;
};
const unit = (latDeg: number, lonDeg: number, out: Float64Array, o = 0) => {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180, c = Math.cos(la);
  out[o] = c * Math.cos(lo); out[o + 1] = Math.sin(la); out[o + 2] = -c * Math.sin(lo);
};

interface TileInfo {
  key: string; z: number; x: number; y: number;
  cx: number; cy: number; cz: number;
  /** Angular radius (rad) of the tile around its centre. */
  radius: number;
  /** Tile edge length on the unit sphere. */
  edge: number;
}

interface TileEntry {
  info: TileInfo; mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; tex: THREE.Texture;
  fade: number; lastUsed: number; visible: boolean;
}

export interface GlobeView {
  /** Unit vector (sphere-local) of the point under the screen centre; the camera sits on this axis. */
  dirX: number; dirY: number; dirZ: number;
  /** Camera distance from the globe centre in globe radii (1 + altitude). */
  dist: number;
  viewH: number; viewW: number; tanHalfFov: number;
}

export class GlobeTiles {
  private infos = new Map<string, TileInfo>();
  private entries = new Map<string, TileEntry>();
  private failed = new Map<string, { until: number; n: number }>();
  private loading = new Map<string, { z: number; cancel: () => void }>();
  private pending = new Map<string, { info: TileInfo; prio: number }>();
  private decoded: { info: TileInfo; img: HTMLImageElement }[] = [];
  private disposed = false;
  private stamp = 0;
  /** Increments whenever something visible changed (tile appeared, fade running) so the host can skip idle renders. */
  version = 0;
  private fading = 0;
  private readonly visibleLeaves: TileInfo[] = [];
  private readonly wantedSet = new Set<string>();
  maxZ = 19;
  maxTextures = 560;
  needsSelection = false;

  constructor(private group: THREE.Group, private maxAniso: number, private onChange: () => void) {}

  get busy() { return this.fading > 0 || this.loading.size > 0 || this.decoded.length > 0; }

  dispose() {
    this.disposed = true;
    for (const l of this.loading.values()) l.cancel();
    this.loading.clear();
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
    this.pending.clear(); this.decoded.length = 0; this.wantedSet.clear();
  }

  private info(z: number, x: number, y: number): TileInfo {
    const key = `${z}/${x}/${y}`;
    let t = this.infos.get(key);
    if (t) return t;
    const n = 2 ** z;
    const lat0 = mercLat(y, z), lat1 = mercLat(y + 1, z);
    const lon0 = (x / n) * 360 - 180, lon1 = ((x + 1) / n) * 360 - 180;
    const midLatDeg = (lat0 + lat1) * 0.5;
    const midLonDeg = (lon0 + lon1) * 0.5;
    unit(midLatDeg, midLonDeg, tmpC);
    let r = 0;
    unit(lat0, lon0, tmpK); r = Math.max(r, Math.acos(Math.min(1, tmpC[0] * tmpK[0] + tmpC[1] * tmpK[1] + tmpC[2] * tmpK[2])));
    unit(lat0, lon1, tmpK); r = Math.max(r, Math.acos(Math.min(1, tmpC[0] * tmpK[0] + tmpC[1] * tmpK[1] + tmpC[2] * tmpK[2])));
    unit(lat1, lon0, tmpK); r = Math.max(r, Math.acos(Math.min(1, tmpC[0] * tmpK[0] + tmpC[1] * tmpK[1] + tmpC[2] * tmpK[2])));
    unit(lat1, lon1, tmpK); r = Math.max(r, Math.acos(Math.min(1, tmpC[0] * tmpK[0] + tmpC[1] * tmpK[1] + tmpC[2] * tmpK[2])));
    const midLat = midLatDeg * (Math.PI / 180);
    t = { key, z, x, y, cx: tmpC[0], cy: tmpC[1], cz: tmpC[2], radius: r * 1.02, edge: (TWO_PI / n) * Math.max(0.04, Math.cos(midLat)) };
    this.infos.set(key, t);
    if (this.infos.size > 6000) this.infos.clear();
    return t;
  }

  /** Tile covering (lat, lon) at level z. */
  private containing(latDeg: number, lonDeg: number, z: number) {
    const n = 2 ** z, s = Math.sin((Math.max(-85.05, Math.min(85.05, latDeg)) * Math.PI) / 180);
    const x = Math.min(n - 1, Math.max(0, Math.floor(((lonDeg + 180) / 360) * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)));
    return { x, y };
  }

  private isFailed(key: string, now: number) {
    const f = this.failed.get(key);
    return !!f && now < f.until;
  }

  private queueTile(info: TileInfo, prio: number, now: number) {
    if (this.entries.has(info.key) || this.loading.has(info.key) || this.isFailed(info.key, now)) return;
    const prev = this.pending.get(info.key);
    if (!prev || prio < prev.prio) this.pending.set(info.key, { info, prio });
  }

  /**
   * Walks the quadtree for the given view; schedules loads; decides which tiles are drawn.
   * Call at ~10 Hz (cheap) and immediately when new tiles arrive.
   */
  update(v: GlobeView, now: number) {
    if (this.disposed) return;
    this.needsSelection = false;
    this.stamp++;
    this.visibleLeaves.length = 0;
    this.wantedSet.clear();
    const acosInvD = Math.acos(Math.min(1, 1 / v.dist));
    const halfDiag = Math.atan(v.tanHalfFov * Math.hypot(1, v.viewW / v.viewH)) + 0.02;
    const pxPerRad = v.viewH / (2 * v.tanHalfFov);
    const visit = (info: TileInfo) => {
      const dot = info.cx * v.dirX + info.cy * v.dirY + info.cz * v.dirZ;
      const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
      // Minimum angular distance on the unit sphere from the screen-center ray to this tile's bounding cap
      const alpha = Math.max(0, theta - info.radius);
      if (alpha > acosInvD) return; // beyond the horizon
      const sinA = Math.sin(alpha), cosA = Math.cos(alpha);
      const phiMin = Math.atan2(sinA, v.dist - cosA);
      if (phiMin > halfDiag) return; // outside the view cone
      this.wantedSet.add(info.key);
      const existing = this.entries.get(info.key);
      if (existing) existing.lastUsed = this.stamp;
      const minCamDist = Math.hypot(sinA, v.dist - cosA);
      const foreshorten = Math.max(0.35, cosA);
      const sizePx = (info.edge / Math.max(1e-7, minCamDist)) * pxPerRad * foreshorten;
      const key = info.key;
      const canSplit = info.z < this.maxZ && sizePx > SPLIT_PX && !this.isFailed(key, now);
      if (canSplit) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) visit(this.info(info.z + 1, info.x * 2 + dx, info.y * 2 + dy));
        return;
      }
      this.visibleLeaves.push(info);
    };
    const n0 = 2 ** GLOBE_MIN_TILE_Z;
    for (let y = 0; y < n0; y++) for (let x = 0; x < n0; x++) visit(this.info(GLOBE_MIN_TILE_Z, x, y));

    // Schedule: base z=4 first, then target leaves directly + one midpoint stepping stone (binary search on 404s).
    this.pending.clear();
    for (const leaf of this.visibleLeaves) {
      const theta = Math.acos(Math.max(-1, Math.min(1, leaf.cx * v.dirX + leaf.cy * v.dirY + leaf.cz * v.dirZ))) * (180 / Math.PI);
      let topLoadedZ = -1;
      let topValidZ = -1;
      let topValidX = 0;
      let topValidY = 0;
      let z = leaf.z, x = leaf.x, y = leaf.y;
      for (;;) {
        const k = `${z}/${x}/${y}`;
        if (topLoadedZ < 0 && this.entries.has(k)) topLoadedZ = z;
        if (topValidZ < 0 && !this.isFailed(k, now)) { topValidZ = z; topValidX = x; topValidY = y; }
        if (z <= GLOBE_MIN_TILE_Z) break;
        z--; x >>= 1; y >>= 1;
      }
      // Ensure base z=4 ancestor is always requested when missing
      const shiftBase = leaf.z - GLOBE_MIN_TILE_Z;
      const bx = leaf.x >> shiftBase, by = leaf.y >> shiftBase;
      const baseInfo = this.info(GLOBE_MIN_TILE_Z, bx, by);
      this.queueTile(baseInfo, theta * 0.4, now);

      if (topValidZ > topLoadedZ && topValidZ >= GLOBE_MIN_TILE_Z) {
        const targetInfo = this.info(topValidZ, topValidX, topValidY);
        this.queueTile(targetInfo, 8 + theta * 0.5, now);
        const lowZ = Math.max(GLOBE_MIN_TILE_Z, topLoadedZ);
        if (topValidZ - lowZ >= 3) {
          const midZ = (lowZ + topValidZ) >> 1;
          const midShift = topValidZ - midZ;
          const midInfo = this.info(midZ, topValidX >> midShift, topValidY >> midShift);
          this.queueTile(midInfo, 14 + theta * 0.5, now);
        }
      }
    }

    // Abort stale in-flight requests (> z=4) that have moved out of the current view so sockets serve the active view.
    if (this.pending.size > 0 && this.loading.size >= MAX_CONCURRENT) {
      for (const [k, req] of this.loading) {
        if (req.z > GLOBE_MIN_TILE_Z && !this.wantedSet.has(k)) {
          req.cancel();
        }
      }
    }

    // Decide what to draw: a loaded leaf, else its nearest loaded ancestor (never a hole, never grey).
    for (const e of this.entries.values()) e.visible = false;
    for (const leaf of this.visibleLeaves) {
      let z = leaf.z, x = leaf.x, y = leaf.y;
      for (;;) {
        const e = this.entries.get(`${z}/${x}/${y}`);
        if (e) {
          e.visible = true; e.lastUsed = this.stamp;
          if (e.fade < 1) this.keepUnderlay(z, x, y);
          break;
        }
        if (z <= GLOBE_MIN_TILE_Z) break;
        z--; x >>= 1; y >>= 1;
      }
    }
    this.pump(now);
    this.evict();
    this.version++;
  }

  /** While a tile fades in, keep EVERY loaded ancestor visible down to the first opaque (`fade >= 1`) one. */
  private keepUnderlay(z: number, x: number, y: number) {
    while (z > GLOBE_MIN_TILE_Z) {
      z--; x >>= 1; y >>= 1;
      const e = this.entries.get(`${z}/${x}/${y}`);
      if (e) {
        e.visible = true;
        e.lastUsed = this.stamp;
        if (e.fade >= 1) return;
      }
    }
  }

  private hasLoadedAncestor(info: TileInfo): boolean {
    let z = info.z, x = info.x, y = info.y;
    while (z > GLOBE_MIN_TILE_Z) {
      z--; x >>= 1; y >>= 1;
      if (this.entries.has(`${z}/${x}/${y}`)) return true;
    }
    return false;
  }

  private pump(now: number) {
    while (this.loading.size < MAX_CONCURRENT && this.pending.size) {
      let bestKey = '', best = Infinity;
      for (const [k, p] of this.pending) if (p.prio < best) { best = p.prio; bestKey = k; }
      const p = this.pending.get(bestKey)!; this.pending.delete(bestKey);
      this.load(p.info, now);
    }
  }

  private load(info: TileInfo, now: number) {
    if (this.loading.has(info.key)) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    let settled = false;
    const finish = (ok: boolean, aborted = false) => {
      if (settled) return;
      settled = true;
      img.onload = img.onerror = null;
      this.loading.delete(info.key);
      if (aborted) { img.src = ''; return; }
      if (this.disposed) return;
      if (ok) { this.failed.delete(info.key); this.decoded.push({ info, img }); }
      else {
        const f = this.failed.get(info.key), n = (f?.n ?? 0) + 1;
        this.failed.set(info.key, { n, until: performance.now() + RETRY_AFTER_MS[Math.min(RETRY_AFTER_MS.length - 1, n - 1)] });
        img.src = '';
      }
      this.onChange();
    };
    this.loading.set(info.key, { z: info.z, cancel: () => finish(false, true) });
    img.onload = () => { (img.decode ? img.decode() : Promise.resolve()).then(() => finish(true), () => finish(true)); };
    img.onerror = () => { finish(false); };
    img.src = tileUrl(ESRI_IMAGERY_URL, info.z, info.x, info.y);
    void now;
  }

  private buildGeometry(info: TileInfo): { geo: THREE.BufferGeometry } {
    const { z, x: tx, y: ty } = info;
    const grid = z <= 5 ? 16 : z <= 8 ? 12 : z <= 11 ? 8 : 4;
    const n = 2 ** z, count = (grid + 1) * (grid + 1);
    const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    const idx: number[] = [];
    // Tiny UV-clamped overlap skirt prevents 1-pixel T-junction or float32 rounding seams between blocks at high zoom.
    const skirt = 0.0018;
    let a = 0, b = 0;
    for (let iy = 0; iy <= grid; iy++) {
      const v = -skirt + (iy / grid) * (1 + skirt * 2);
      const lat = mercLat(ty + v, z);
      const vc = Math.max(0, Math.min(1, v));
      for (let ix = 0; ix <= grid; ix++) {
        const u = -skirt + (ix / grid) * (1 + skirt * 2);
        const lon = ((tx + u) / n) * 360 - 180;
        const uc = Math.max(0, Math.min(1, u));
        unit(lat, lon, tmpK);
        // Relative to the tile centre (RTC): float32 stays sub-centimetre accurate even 550 m above a runway.
        pos[a++] = tmpK[0] - info.cx; pos[a++] = tmpK[1] - info.cy; pos[a++] = tmpK[2] - info.cz;
        // Half-texel inset: clamp-to-edge never samples across the tile seam.
        uv[b++] = 0.5 / 256 + uc * (255 / 256); uv[b++] = 1 - (0.5 / 256 + vc * (255 / 256));
      }
    }
    for (let iy = 0; iy < grid; iy++) for (let ix = 0; ix < grid; ix++) {
      const i0 = iy * (grid + 1) + ix, i1 = i0 + 1, i2 = i0 + grid + 1, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), info.radius * 1.06);
    return { geo };
  }

  /** Per-frame: create textures for pre-decoded images, advance cross-fades, show/hide meshes. */
  tick(dt: number): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (let i = 0; i < 6 && this.decoded.length; i++) {
      const { info, img } = this.decoded.shift()!;
      if (this.entries.has(info.key)) continue;
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = Math.min(8, this.maxAniso);
      tex.needsUpdate = true;
      // Only fade in when a loaded ancestor is already beneath this tile; otherwise appear immediately so
      // we never fade in from 0% opacity over the coarse base sphere.
      const startFade = this.hasLoadedAncestor(info) ? 0.06 : 1;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: startFade, depthTest: false, depthWrite: false, side: THREE.FrontSide, toneMapped: false });
      const { geo } = this.buildGeometry(info);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(info.cx, info.cy, info.cz);
      mesh.renderOrder = 10 + info.z; mesh.visible = false; mesh.matrixAutoUpdate = true;
      this.group.add(mesh);
      this.entries.set(info.key, { info, mesh, mat, tex, fade: startFade, lastUsed: this.stamp, visible: false });
      this.needsSelection = true;
      changed = true;
    }
    let fading = 0;
    for (const e of this.entries.values()) {
      if (e.visible && e.fade < 1) {
        e.fade = Math.min(1, e.fade + dt / FADE_S);
        const f = e.fade;
        e.mat.opacity = f * f * (3 - 2 * f);
        if (e.fade < 1) fading++;
        changed = true;
      }
      if (e.mesh.visible !== e.visible) { e.mesh.visible = e.visible; changed = true; }
    }
    this.fading = fading;
    if (changed) this.version++;
    return changed;
  }

  private drop(e: TileEntry) {
    this.group.remove(e.mesh);
    e.mesh.geometry.dispose(); e.mat.dispose(); e.tex.dispose();
  }

  private evict() {
    if (this.entries.size <= this.maxTextures) return;
    // Pin global base z=4 tiles first so panning across the globe never exposes holes in the base pyramid.
    const highZ = [...this.entries.values()]
      .filter((e) => e.info.z > GLOBE_MIN_TILE_Z && e.lastUsed !== this.stamp)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of highZ) {
      if (this.entries.size <= this.maxTextures) return;
      this.drop(e); this.entries.delete(e.info.key);
    }
    if (this.entries.size <= this.maxTextures) return;
    const baseZ = [...this.entries.values()]
      .filter((e) => e.lastUsed !== this.stamp)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of baseZ) {
      if (this.entries.size <= this.maxTextures) break;
      this.drop(e); this.entries.delete(e.info.key);
    }
  }

  /** Warm the pyramid for a view that is about to be shown (e.g. the destination of a fly-to). */
  prefetch(latDeg: number, lonDeg: number, z: number, now: number) {
    const levels = new Set<number>([GLOBE_MIN_TILE_Z, Math.min(z, this.maxZ)]);
    if (z - GLOBE_MIN_TILE_Z >= 3) levels.add((GLOBE_MIN_TILE_Z + Math.min(z, this.maxZ)) >> 1);
    for (const level of levels) {
      const { x, y } = this.containing(latDeg, lonDeg, level);
      const info = this.info(level, x, y), key = info.key;
      if (this.entries.has(key) || this.loading.has(key) || this.isFailed(key, now)) continue;
      if (this.loading.size < MAX_CONCURRENT + 4) this.load(info, now);
    }
  }
}
