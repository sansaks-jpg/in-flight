// Runtime-procedural detail maps.
//
// The whole simulator ships as a single HTML file, so nothing here is a downloaded asset: every
// texel is generated from seeded maths at load time. That keeps the CC0/open-data promise of the
// stack (no API keys, no licence questions, no multi-megabyte base64 blobs) while still giving the
// terrain and the tarmac the band-limited high-frequency detail that satellite imagery lacks.
//
// The important property for the terrain is that these maps are *tileable and mipmapped*: the GPU
// can therefore prefilter them, so no world-space procedural function ever aliases into a plaid or
// dot lattice at distance — which is exactly what the old per-metre sine "grass grain" did.
import * as THREE from 'three';

const SIZE = 256;

let groundTex: THREE.Texture | null = null;
let asphaltTex: THREE.Texture | null = null;

/** Small, fast, deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Value noise on a `cells x cells` lattice that wraps exactly at the texture border, so the result
 * is seamless when the shader repeats it. `cells` must divide SIZE for the wrap to be exact.
 */
function tileNoise(cells: number, rand: () => number): Float32Array {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const fy = (y / SIZE) * cells, y0 = Math.floor(fy), ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < SIZE; x++) {
      const fx = (x / SIZE) * cells, x0 = Math.floor(fx), tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells, c1 = (x0 + 1) % cells;
      const top = lattice[r0 + c0] * (1 - sx) + lattice[r0 + c1] * sx;
      const bot = lattice[r1 + c0] * (1 - sx) + lattice[r1 + c1] * sx;
      out[y * SIZE + x] = top * (1 - sy) + bot * sy;
    }
  }
  return out;
}

function fbm(baseCells: number, octaves: number, rand: () => number): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  let amp = 0.5, cells = Math.max(2, baseCells), norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(Math.min(SIZE, cells), rand);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp; amp *= 0.5; cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

const stretch = (v: number) => Math.max(0, Math.min(1, (v - 0.5) * 1.7 + 0.5));

function dataTexture(data: Uint8Array<ArrayBuffer>, maxAniso: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.max(1, maxAniso);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Three decorrelated noise bands packed into RGB:
 *   R — macro relief/land-cover variation (~1/3 of a texture repeat)
 *   G — meso vegetation patchiness
 *   B — fine ground grain, only used within a few hundred metres
 * The shader reads one channel per scale from its own lookup, so a single 256² RGBA upload gives
 * three independent, correctly-mipmapped frequency bands.
 */
export function groundDetailTexture(maxAniso = 4): THREE.Texture {
  if (groundTex) return groundTex;
  const rand = prng(0x5eed1);
  const lo = fbm(3, 4, rand);
  const mid = fbm(12, 4, rand);
  const hi = fbm(48, 3, rand);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = Math.round(stretch(lo[i]) * 255);
    data[i * 4 + 1] = Math.round(stretch(mid[i]) * 255);
    data[i * 4 + 2] = Math.round(stretch(hi[i]) * 255);
    data[i * 4 + 3] = 255;
  }
  groundTex = dataTexture(data, maxAniso);
  return groundTex;
}

/**
 * Tarmac: mid-grey aggregate with a light patchy binder. Sampled in road metres, so one repeat is
 * a few metres wide and the grain reads at walking distance but mips to flat grey from the air.
 */
export function asphaltTexture(maxAniso = 4): THREE.Texture {
  if (asphaltTex) return asphaltTex;
  const rand = prng(0xa5fa17);
  const patch = fbm(16, 3, rand);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const grain = rand() - 0.5;
    const v = Math.max(0, Math.min(1, 0.52 + (patch[i] - 0.5) * 0.30 + grain * 0.42));
    const b = Math.round(v * 255);
    data[i * 4] = b;
    data[i * 4 + 1] = Math.round(b * 0.99);
    data[i * 4 + 2] = Math.round(b * 1.01);
    data[i * 4 + 3] = 255;
  }
  asphaltTex = dataTexture(data, maxAniso);
  return asphaltTex;
}
