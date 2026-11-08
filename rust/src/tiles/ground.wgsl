// Satellite ground: shades the terrain clipmap rings from the shared tile atlas through a per-level page table.
// Appended after globals.wgsl + world.wgsl (uses TIn, Model, light(), fogmix(), vnoise()).
//
// Page table layout (Rgba32Float, 48 x 128 texels): level l, tile slot (sx, sy) -> row l*16 + sy, texels sx*3 + {0,1,2}
//   texel 0: (atlas layer or -1, uv scale, uv offset x, uv offset y)    tile (or nearest resident ancestor) to draw
//   texel 1: same for the parent, used only while the tile is fading in
//   texel 2: (fade 0..1, absolute tile x, absolute tile y, 1 = entry valid)
struct GLevel { org: vec4<f32>, base: vec4<i32> };
struct GroundU { lv: array<GLevel, 8>, misc: vec4<f32> };
@group(2) @binding(0) var<uniform> gu: GroundU;
@group(2) @binding(1) var pt: texture_2d<f32>;
@group(2) @binding(2) var atl: texture_2d_array<f32>;
@group(2) @binding(3) var asamp: sampler;

struct SOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) rel: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) dist: f32,
    @location(3) @interpolate(flat) lvl: u32,
};

@vertex fn vs_terrain_sat(v: TIn, @builtin(instance_index) ii: u32) -> SOut {
    var o: SOut;
    let rel = v.pos - g.cam_pos.xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.rel = rel; o.nrm = v.nrm; o.dist = length(rel); o.lvl = ii;
    return o;
}

// rgb + validity. `rel` is camera-relative so the tile coordinate keeps full precision however far from the origin we are.
fn sat_color(rel_xz: vec2<f32>, l: u32) -> vec4<f32> {
    let L = gu.lv[l];
    let tf = L.org.xy + rel_xz * L.org.z;
    // gradients of the *continuous* tile coordinate: correct mip selection across tile borders (no seams)
    let dx = dpdx(tf);
    let dy = dpdy(tf);
    let ti = floor(tf);
    let uv = tf - ti;
    let ab = L.base.xy + vec2<i32>(ti);
    let sx = ((ab.x % 16) + 16) % 16;
    let sy = ((ab.y % 16) + 16) % 16;
    let row = i32(l) * 16 + sy;
    let e0 = textureLoad(pt, vec2<i32>(sx * 3, row), 0);
    let e1 = textureLoad(pt, vec2<i32>(sx * 3 + 1, row), 0);
    let e2 = textureLoad(pt, vec2<i32>(sx * 3 + 2, row), 0);
    if (e2.w < 0.5 || e0.x < 0.0 || e2.y != f32(ab.x) || e2.z != f32(ab.y)) {
        return vec4<f32>(0.0);
    }
    var c = textureSampleGrad(atl, asamp, e0.zw + uv * e0.y, i32(e0.x), dx * e0.y, dy * e0.y).rgb;
    if (e2.x < 0.999 && e1.x >= 0.0) {
        let c1 = textureSampleGrad(atl, asamp, e1.zw + uv * e1.y, i32(e1.x), dx * e1.y, dy * e1.y).rgb;
        c = mix(c1, c, e2.x);
    }
    return vec4<f32>(c, 1.0);
}

@fragment fn fs_terrain_sat(i: SOut) -> @location(0) vec4<f32> {
    let n = normalize(i.nrm);
    let s = sat_color(i.rel.xz, i.lvl);
    // neutral fallback while a tile is still on its way (never a hole): dry-grass tone, same lighting
    let wp = i.rel.xz + g.cam_pos.xz;
    let nz = vnoise(wp * 0.02) * 0.6 + vnoise(wp * 0.2) * 0.4;
    let fallback = mix(vec3<f32>(0.20, 0.27, 0.14), vec3<f32>(0.32, 0.36, 0.20), nz);
    let albedo = mix(fallback, s.rgb, s.a);
    var lit: vec3<f32>;
    if (gu.misc.y > 0.5) {
        // emissive data (night lights): not lit by the sun
        lit = albedo * (0.55 + 0.45 * (1.0 - g.amb.a));
    } else {
        lit = albedo * light(n);
    }
    return vec4<f32>(fogmix(lit, i.dist), 1.0);
}
