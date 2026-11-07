// A320 flight-deck asset loading. The GLB ships inside the project (public/models/a320) so `npm run build` is self-contained;
// if that copy cannot be fetched (e.g. a stripped ZIP) the loader falls back to the pinned, permanent public mirrors below,
// and as a last resort the caller builds the procedural cockpit.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const SHA = 'b2afd173081aea5db00031baa1003aa7c46a789a'; // radebit/flight-simulator, pinned commit
const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
export const COCKPIT_GLB_URLS = [
  `${base}models/a320/cockpit.glb`,
  `./models/a320/cockpit.glb`,
  // jsDelivr refuses files > 50 MB (HTTP 403 for the 50.6 MB original) – verified – so the raw GitHub URL is the working permanent mirror.
  `https://raw.githubusercontent.com/radebit/flight-simulator/${SHA}/public/models/a320/cockpit.glb`,
  `https://rawcdn.githack.com/radebit/flight-simulator/${SHA}/public/models/a320/cockpit.glb`,
];
export const COCKPIT_MANIFEST_URLS = [
  `${base}models/a320/cockpit-manifest.json`,
  `./models/a320/cockpit-manifest.json`,
  `https://cdn.jsdelivr.net/gh/radebit/flight-simulator@${SHA}/public/models/a320/cockpit-manifest.json`,
  `https://raw.githubusercontent.com/radebit/flight-simulator/${SHA}/public/models/a320/cockpit-manifest.json`,
];
export interface Axis { pivot: [number, number, number]; direction: [number, number, number]; }
export interface CockpitManifest { axes: Record<string, Axis>; }

async function firstOk<T>(urls: string[], fn: (u: string) => Promise<T>): Promise<T> {
  let err: unknown;
  for (const u of urls) { try { return await fn(u); } catch (e) { err = e; } }
  throw err ?? new Error('no URL');
}
export async function loadCockpitAssets(): Promise<{ scene: THREE.Group; manifest: CockpitManifest }> {
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, manifest] = await Promise.all([
    firstOk(COCKPIT_GLB_URLS, (u) => loader.loadAsync(u)),
    firstOk(COCKPIT_MANIFEST_URLS, async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as CockpitManifest; }).catch(() => ({ axes: {} } as CockpitManifest)),
  ]);
  return { scene: gltf.scene, manifest };
}
