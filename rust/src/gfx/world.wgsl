// Shared globals + terrain / water / mesh shaders. Camera-relative rendering: every vertex position is converted to
// "world - camera" in f32 before the view-projection, so precision stays millimetric even 100+ km from the origin.
struct Model { m: mat4x4<f32>, tint: vec4<f32> };
@group(1) @binding(0) var<uniform> model: Model;

fn hash21(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2<f32>(123.34, 456.21));
    q = q + dot(q, q + 45.32);
    return fract(q.x * q.y);
}
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn fogmix(col: vec3<f32>, dist: f32) -> vec3<f32> {
    let f = 1.0 - exp(-pow(dist * g.fog.a, 1.5));
    return mix(col, g.fog.rgb, clamp(f, 0.0, 1.0));
}
fn light(n: vec3<f32>) -> vec3<f32> {
    let nd = max(dot(n, g.sun_dir.xyz), 0.0);
    return g.amb.rgb + g.sun_col.rgb * nd;
}

// ---------------- terrain ----------------
struct TIn { @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) ex: vec2<f32> };
struct TOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) ex: vec2<f32>, @location(3) dist: f32,
};
@vertex fn vs_terrain(v: TIn) -> TOut {
    var o: TOut;
    let rel = v.pos - g.cam_pos.xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.world = v.pos; o.nrm = v.nrm; o.ex = v.ex; o.dist = length(rel);
    return o;
}
@fragment fn fs_terrain(i: TOut) -> @location(0) vec4<f32> {
    let n = normalize(i.nrm);
    let h = i.world.y;
    let slope = 1.0 - n.y;
    let nz = vnoise(i.world.xz * 0.02) * 0.6 + vnoise(i.world.xz * 0.2) * 0.4;
    var col = mix(vec3<f32>(0.20, 0.34, 0.12), vec3<f32>(0.33, 0.42, 0.17), nz);          // grass
    col = mix(col, vec3<f32>(0.10, 0.22, 0.09), i.ex.y * 0.9);                              // forest
    col = mix(vec3<f32>(0.62, 0.57, 0.42), col, smoothstep(-1.0, 2.5, h));                   // beach
    col = mix(col, vec3<f32>(0.42, 0.40, 0.37), smoothstep(700.0, 1700.0, h) * 0.8);        // alpine rock
    col = mix(col, vec3<f32>(0.46, 0.42, 0.36), smoothstep(0.18, 0.42, slope));             // steep rock
    col = mix(col, vec3<f32>(0.94, 0.95, 0.98), smoothstep(1900.0, 2500.0, h + nz * 220.0)); // snow
    col = mix(col, vec3<f32>(0.20, 0.21, 0.23) + nz * 0.08, i.ex.x * 0.85);                 // urban
    var lit = col * light(n);
    // city lights at night
    let cell = floor(i.world.xz / 38.0);
    let lamp = step(0.55, hash21(cell)) * step(0.35, i.ex.x);
    lit = lit + vec3<f32>(1.0, 0.75, 0.4) * lamp * g.amb.a * 0.9;
    return vec4<f32>(fogmix(lit, i.dist), 1.0);
}

// ---------------- water ----------------
struct WOut { @builtin(position) clip: vec4<f32>, @location(0) world: vec3<f32>, @location(1) dist: f32 };
@vertex fn vs_water(@builtin(vertex_index) vi: u32) -> WOut {
    var c = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let k = c[vi] * 400000.0;
    let rel = vec3<f32>(k.x, -g.cam_pos.y, k.y);
    var o: WOut;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.world = vec3<f32>(g.cam_pos.x + k.x, 0.0, g.cam_pos.z + k.y);
    o.dist = length(rel);
    return o;
}
@fragment fn fs_water(i: WOut) -> @location(0) vec4<f32> {
    let t = g.cam_pos.w;
    let p = i.world.xz;
    let e = 0.06;
    let w0 = vnoise(p * 0.05 + vec2<f32>(t * 0.4, t * 0.2)) + 0.5 * vnoise(p * 0.21 - vec2<f32>(t * 0.3, 0.0));
    let wx = vnoise((p + vec2<f32>(1.0, 0.0)) * 0.05 + vec2<f32>(t * 0.4, t * 0.2)) + 0.5 * vnoise((p + vec2<f32>(1.0, 0.0)) * 0.21 - vec2<f32>(t * 0.3, 0.0));
    let wz = vnoise((p + vec2<f32>(0.0, 1.0)) * 0.05 + vec2<f32>(t * 0.4, t * 0.2)) + 0.5 * vnoise((p + vec2<f32>(0.0, 1.0)) * 0.21 - vec2<f32>(t * 0.3, 0.0));
    let n = normalize(vec3<f32>(-(wx - w0) * e * 8.0, 1.0, -(wz - w0) * e * 8.0));
    let v = normalize(g.cam_pos.xyz - i.world);
    let fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
    let deep = vec3<f32>(0.02, 0.10, 0.18) * (g.amb.rgb * 2.0 + 0.15);
    var col = mix(deep, g.zenith.rgb * 0.8 + g.fog.rgb * 0.2, clamp(fres * 0.9 + 0.08, 0.0, 1.0));
    let r = reflect(-v, n);
    let spec = pow(max(dot(r, g.sun_dir.xyz), 0.0), 220.0);
    col = col + g.sun_col.rgb * spec * 2.5;
    return vec4<f32>(fogmix(col, i.dist), 1.0);
}

// ---------------- meshes ----------------
struct MIn { @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) col: vec4<f32> };
struct MOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) nrm: vec3<f32>, @location(1) col: vec4<f32>, @location(2) dist: f32,
};
@vertex fn vs_mesh(v: MIn) -> MOut {
    var o: MOut;
    let rel = v.pos - g.cam_pos.xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.nrm = v.nrm; o.col = v.col; o.dist = length(rel);
    return o;
}
@vertex fn vs_model(v: MIn) -> MOut {
    var o: MOut;
    let rel = (model.m * vec4<f32>(v.pos, 1.0)).xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.nrm = normalize((model.m * vec4<f32>(v.nrm, 0.0)).xyz);
    o.col = v.col; o.dist = length(rel);
    return o;
}
struct IIn {
    @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) col: vec4<f32>,
    @location(3) ipos: vec3<f32>, @location(4) iyaw: f32, @location(5) iscale: vec3<f32>, @location(6) itint: f32,
};
@vertex fn vs_inst(v: IIn) -> MOut {
    var o: MOut;
    let c = cos(v.iyaw); let s = sin(v.iyaw);
    let l = v.pos * v.iscale;
    let w = vec3<f32>(l.x * c + l.z * s, l.y, -l.x * s + l.z * c) + v.ipos;
    let rel = w - g.cam_pos.xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.nrm = vec3<f32>(v.nrm.x * c + v.nrm.z * s, v.nrm.y, -v.nrm.x * s + v.nrm.z * c);
    o.col = vec4<f32>(v.col.rgb * v.itint, v.col.a); o.dist = length(rel);
    return o;
}
@fragment fn fs_mesh(i: MOut) -> @location(0) vec4<f32> {
    let n = normalize(i.nrm);
    var c = i.col.rgb * light(n);
    // a = emissive weight (runway lights, windows, nav lights): bright at night, faint by day
    c = c + i.col.rgb * i.col.a * (0.25 + 9.0 * g.amb.a);
    return vec4<f32>(fogmix(c, i.dist), 1.0);
}
