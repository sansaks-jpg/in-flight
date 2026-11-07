// A320 flight-deck asset loading.
//
// Per AGENTS.md §5 heavy 3D binaries are NOT stored in this repository: the 50.6 MB GLB is fetched at runtime from a pinned, immutable
// commit of the upstream conversion project (radebit/flight-simulator). Verified mirrors (HTTP status checked, not assumed):
//   raw.githubusercontent.com  200 + `access-control-allow-origin: *`  ← the only host that serves the 50.6 MB file
//   cdn.jsdelivr.net           403 for files > 50 MB (fine for the small manifest, not for the GLB)
//   rawcdn.githack.com         403  (dead – removed)
// Because the commit SHA is pinned the bytes can never change, so they are kept in the Cache Storage API (GitHub raw only sends
// `max-age=300`, which would otherwise re-download 50 MB every few minutes). If everything fails the caller builds the procedural cockpit.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const SHA = 'b2afd173081aea5db00031baa1003aa7c46a789a'; // radebit/flight-simulator, pinned commit
const RAW = `https://raw.githubusercontent.com/radebit/flight-simulator/${SHA}/public/models/a320`;
export const COCKPIT_GLB_URLS = [
  `${RAW}/cockpit.glb`,
  `https://github.com/radebit/flight-simulator/raw/${SHA}/public/models/a320/cockpit.glb`, // 302 → raw.githubusercontent.com, CORS-enabled
];
export const COCKPIT_MANIFEST_URLS = [
  `https://cdn.jsdelivr.net/gh/radebit/flight-simulator@${SHA}/public/models/a320/cockpit-manifest.json`,
  `${RAW}/cockpit-manifest.json`,
];
export interface Axis { pivot: [number, number, number]; direction: [number, number, number]; }
export interface CockpitManifest { axes: Record<string, Axis>; }

async function firstOk<T>(urls: string[], fn: (u: string) => Promise<T>): Promise<T> {
  let err: unknown;
  for (const u of urls) { try { return await fn(u); } catch (e) { err = e; } }
  throw err ?? new Error('no URL');
}

const CACHE_NAME = 'in-flight-assets-v1';
/** GET with a persistent cache (immutable, SHA-pinned URLs only). Cache failures never break loading. */
async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; } catch { cache = null; }
  try { const hit = await cache?.match(url); if (hit) return await hit.arrayBuffer(); } catch { /* corrupt entry: refetch */ }
  const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const copy = r.clone(); const buf = await r.arrayBuffer();
  try { await cache?.put(url, copy); } catch { /* quota exceeded: fine, just not cached */ }
  return buf;
}

export async function loadCockpitAssets(): Promise<{ scene: THREE.Group; manifest: CockpitManifest }> {
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, manifest] = await Promise.all([
    firstOk(COCKPIT_GLB_URLS, async (u) => loader.parseAsync(await fetchBuffer(u), '')),
    firstOk(COCKPIT_MANIFEST_URLS, async (u) => JSON.parse(new TextDecoder().decode(await fetchBuffer(u))) as CockpitManifest).catch(() => ({ axes: {} } as CockpitManifest)),
  ]);
  return { scene: gltf.scene, manifest };
}
