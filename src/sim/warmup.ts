// GPU warm-up helpers used behind the loading screen (see Game.prewarm).
//
// WebGL resources are created lazily by three.js: a shader program is linked on the first draw of its material, a texture is
// uploaded (and its mip chain generated) on the first draw that samples it, and a geometry's buffers are uploaded on the first
// draw of its mesh – and a mesh that is frustum-culled is never drawn, so none of that happens until the pilot looks at it.
// With a 344 MB flight deck, ~80 terrain tiles and a ray-marched sky that showed up as multi-hundred-millisecond hitches the first
// time the player looked out of the windshield. Everything below moves that work in front of the first playable frame:
//   1. compile every program in parallel (renderer.compileAsync, KHR_parallel_shader_compile where available),
//   2. upload every texture, a couple per frame so the loader keeps animating,
//   3. draw every object once with culling and visibility forced off (buffers, instancing attributes, render targets).
import * as THREE from 'three';

/** Resolves on the next animation frame (or after 100 ms – a hidden tab must never stall the loader). */
export const nextFrame = () => new Promise<void>((res) => { let done = false; const fin = () => { if (!done) { done = true; res(); } }; requestAnimationFrame(fin); setTimeout(fin, 100); });

/**
 * Makes every object of `root` drawable – visible and never frustum-culled – and returns the function that restores the exact
 * previous flags. Lights are left alone: their visibility changes the light count and with it the shader variant.
 */
export function forceDrawAll(root: THREE.Object3D): () => void {
  const hidden: THREE.Object3D[] = [], culled: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) return;
    if (!o.visible) { hidden.push(o); o.visible = true; }
    if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
  });
  return () => { for (const o of hidden) o.visible = false; for (const o of culled) o.frustumCulled = true; };
}

const TEXTURE_SLOTS = ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap', 'specularMap', 'gradientMap', 'clearcoatMap', 'sheenColorMap', 'transmissionMap'] as const;

/** Every distinct texture a scene can ever sample (material slots + custom shader uniforms), render-target and depth textures excluded. */
export function collectTextures(roots: THREE.Object3D[]): THREE.Texture[] {
  const seen = new Set<THREE.Texture>();
  const add = (t: unknown) => {
    const tex = t as THREE.Texture | null | undefined;
    if (!tex || !tex.isTexture || tex.isRenderTargetTexture || (tex as THREE.DepthTexture).isDepthTexture || !tex.image) return;
    seen.add(tex);
  };
  for (const root of roots) {
    root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        const rec = m as unknown as Record<string, unknown>;
        for (const k of TEXTURE_SLOTS) add(rec[k]);
        const u = (m as THREE.ShaderMaterial).uniforms;
        if (u) for (const k in u) add(u[k].value);
      }
    });
  }
  return [...seen];
}

/** Uploads textures to the GPU a few per frame (large PNG-backed textures cost 10-50 ms each). Reports 0..1. */
export async function uploadTextures(r: THREE.WebGLRenderer, textures: THREE.Texture[], onProgress: (p: number) => void, perFrame = 2): Promise<void> {
  for (let i = 0; i < textures.length; i += perFrame) {
    for (let j = i; j < Math.min(textures.length, i + perFrame); j++) { try { r.initTexture(textures[j]); } catch { /* an unusable texture must never block the flight */ } }
    onProgress(Math.min(1, (i + perFrame) / textures.length));
    await nextFrame();
  }
  onProgress(1);
}
