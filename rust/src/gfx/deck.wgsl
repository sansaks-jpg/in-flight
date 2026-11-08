// HD flight deck (downloaded GLB). Concatenated after globals.wgsl.
// Vertices are in model space; every vertex carries a `slot` into a storage buffer holding the model->body pose of its control
// (so a knob / switch / lever is animated without touching the vertex buffer), a colour multiplier (alpha 0 hides the node - lamps)
// and an additive emissive colour (lit legends / LEDs). Group 1 is the aircraft model matrix (body -> camera-relative world).
struct Model { m: mat4x4<f32>, tint: vec4<f32> };
struct Slot { m: mat4x4<f32>, mul: vec4<f32>, add: vec4<f32> };
struct Mat { base: vec4<f32>, params: vec4<f32> }; // params: x = alpha mode (0 opaque, 1 mask, 2 blend), y = cutoff, z = has texture
@group(1) @binding(0) var<uniform> model: Model;
@group(2) @binding(0) var<storage, read> slots: array<Slot>;
@group(3) @binding(0) var<uniform> mat: Mat;
@group(3) @binding(1) var tex: texture_2d<f32>;
@group(3) @binding(2) var smp: sampler;

struct DOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) mul: vec4<f32>,
    @location(3) add: vec3<f32>,
};

@vertex fn vs_deck(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) slot: u32) -> DOut {
    var o: DOut;
    let s = slots[slot];
    let body = s.m * vec4<f32>(pos, 1.0);
    let rel = (model.m * body).xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.uv = uv;
    o.nrm = normalize((model.m * (s.m * vec4<f32>(nrm, 0.0))).xyz);
    o.mul = s.mul;
    o.add = s.add.rgb;
    return o;
}

fn shade(i: DOut, front: bool) -> vec4<f32> {
    var c = mat.base;
    if (mat.params.z > 0.5) { c = c * textureSample(tex, smp, i.uv); }
    c = vec4<f32>(c.rgb * i.mul.rgb, c.a);
    if (i.mul.a < 0.5) { discard; }
    if (mat.params.x > 0.5 && mat.params.x < 1.5 && c.a < mat.params.y) { discard; }
    var n = normalize(i.nrm);
    if (!front) { n = -n; }
    // cabin lighting: sky ambient + a little sun through the windows + a dim floor so the deck never goes pitch black at night
    let ndl = max(dot(n, g.sun_dir.xyz), 0.0);
    let night = g.amb.a;
    let lit = g.amb.rgb * 1.15 + g.sun_col.rgb * ndl * 0.22 + vec3<f32>(0.075, 0.07, 0.065) * (0.35 + night);
    let rgb = c.rgb * min(lit, vec3<f32>(1.25)) + i.add;
    return vec4<f32>(rgb, select(1.0, c.a, mat.params.x > 1.5));
}

@fragment fn fs_deck(i: DOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    return shade(i, front);
}
