// Cockpit render-quality helpers: texture filtering, alpha-cut-out hardening and the live-screen resolution policy.
//
// WHY THIS FILE EXISTS (wide-angle blur / shimmer bug)
// ----------------------------------------------------
// The FlightGear flight-deck GLB bakes every legend, icon and label into big RGBA atlases (fd_main / fd_other / fd_glare, 4096²,
// fd_buttons 2048²) and 28 of its 35 materials are glTF `alphaMode: MASK` (alphaCutoff 0.25) → three.js `alphaTest`, a hard `discard`.
// Zoomed in the GPU samples mip 0, so the glyphs look HD. Zoomed OUT (wide FOV) the same texels are minified onto mip 2–4, and
// *averaging alpha shrinks thin strokes*: their alpha falls under the cut-off, strokes get eroded, edges crawl and the whole panel looks
// out of focus. This is the well-known "mip-mapped alpha test" problem (Castaño, "Computing alpha mipmaps"; Golus, "Anti-aliased alpha test").
// Remedy used here, all inside the standard three.js material (no extra passes):
//   1. scale alpha up with the sampled mip level so average coverage stays constant across mips (Unity/Ignacio-Castaño style `mipScale`);
//   2. re-centre + sharpen the cut-off on the screen-space alpha gradient (`(a - cutoff) / fwidth(a) + 0.5`), an analytic AA edge;
//   3. let MSAA resolve that edge with `alphaToCoverage` (only when the framebuffer really is multisampled – otherwise plain discard);
//   4. anisotropic trilinear filtering at the GPU maximum so panels seen at grazing angles keep their detail.
import * as THREE from 'three';

/** GPU facts the cockpit needs, filled in by `Game` right after the WebGLRenderer exists (before any cockpit is built). */
export const renderCaps = { maxAniso: 16, msaa: false };

/** Read what the GPU/driver actually gives us (anisotropy limit, and whether the default framebuffer is multisampled). */
export function probeRenderCaps(r: THREE.WebGLRenderer) {
  renderCaps.maxAniso = Math.max(1, r.capabilities.getMaxAnisotropy());
  const gl = r.getContext();
  renderCaps.msaa = (gl.getParameter(gl.SAMPLES) as number) > 1;
}

/** Trilinear + max-anisotropy filtering with a full mip chain – the only sane setup for small text on a 3D panel. */
export function sharpenTexture(tex: THREE.Texture | null | undefined) {
  if (!tex) return;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderCaps.maxAniso;
  tex.needsUpdate = true;
}

/** Per mip level the alpha is boosted by this fraction so thin glyph strokes keep their screen coverage (0.25 = Unity's default `mip scale`). */
const MIP_ALPHA_BOOST = 0.3;

const CUTOUT_FRAG = /* glsl */ `
#ifdef USE_ALPHATEST
  #ifdef USE_MAP
    {
      // mip level this fragment samples from (WebGL2: textureSize is available, textureQueryLod is not)
      vec2 mipTs = vec2(textureSize(map, 0));
      vec2 mipDx = dFdx(vMapUv * mipTs), mipDy = dFdy(vMapUv * mipTs);
      float mipLod = max(0.0, 0.5 * log2(max(max(dot(mipDx, mipDx), dot(mipDy, mipDy)), 1e-8)));
      diffuseColor.a *= 1.0 + mipLod * ${MIP_ALPHA_BOOST.toFixed(2)};
    }
  #endif
  #ifdef ALPHA_TO_COVERAGE
    // analytic anti-aliased edge: the 0.5 level sits exactly on the cut-off, the ramp is one screen pixel wide
    diffuseColor.a = clamp((diffuseColor.a - alphaTest) / max(fwidth(diffuseColor.a), 1e-4) + 0.5, 0.0, 1.0);
    if (diffuseColor.a <= 0.0) discard;
  #else
    if (diffuseColor.a < alphaTest) discard;
  #endif
#endif
`;

const hardened = new WeakSet<THREE.Material>();

/** Patch one alpha-tested standard material (idempotent). Opaque / blended materials are left untouched. */
export function hardenAlphaCutout(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial;
  if (hardened.has(m) || !m.isMeshStandardMaterial || !(m.alphaTest > 0) || m.transparent) return;
  hardened.add(m);
  sharpenTexture(m.map); if (m.emissiveMap && m.emissiveMap !== m.map) sharpenTexture(m.emissiveMap);
  m.alphaToCoverage = renderCaps.msaa;
  m.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', CUTOUT_FRAG); };
  m.customProgramCacheKey = () => 'cockpit-cutout-v1';
  m.needsUpdate = true;
}

/** Apply texture filtering to every material under `root` and harden the alpha cut-outs. Returns the number of cut-out materials patched. */
export function tuneCockpitMaterials(root: THREE.Object3D): number {
  const seen = new Set<THREE.Material>(); let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
    for (const mt of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(mt)) continue; seen.add(mt);
      const sm = mt as THREE.MeshStandardMaterial;
      if (sm.map) sharpenTexture(sm.map);
      if (sm.emissiveMap) sharpenTexture(sm.emissiveMap);
      if (sm.alphaTest > 0 && !sm.transparent) { hardenAlphaCutout(mt); n++; }
    }
  });
  return n;
}

/** Texel-per-pixel target for live canvas screens: > 1 makes trilinear/anisotropic filtering act as a proper down-sampler (super-sampling)
 *  instead of sitting right at the 1:1 mip transition, where text looks soft. Tiers above the quality preset's `maxRes` are still refused. */
export const SCREEN_SUPERSAMPLE = 1.4;
