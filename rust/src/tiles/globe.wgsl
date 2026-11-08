// Textured, day/night-shaded globe tiles. Vertices arrive already projected to screen pixels (orthographic globe camera),
// so the GPU only does texturing + shading; painter's order (parents first) comes from the vertex order.
struct GU { size: vec2<f32>, pad: vec2<f32>, sun: vec4<f32> };   // sun.xyz: unit vector to the sub-solar point, sun.w: 1 = emissive style
@group(0) @binding(0) var<uniform> gu: GU;
@group(0) @binding(1) var atl: texture_2d_array<f32>;
@group(0) @binding(2) var asamp: sampler;

struct VIn {
    @location(0) pos: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) la: vec2<f32>,       // atlas layer, fade alpha
    @location(3) nrm: vec3<f32>,
    @location(4) depth: f32,
};
struct VOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) layer: i32,
    @location(2) alpha: f32,
    @location(3) nrm: vec3<f32>,
    @location(4) depth: f32,
};

@vertex fn vs_globe(v: VIn) -> VOut {
    var o: VOut;
    o.clip = vec4<f32>(v.pos.x / gu.size.x * 2.0 - 1.0, 1.0 - v.pos.y / gu.size.y * 2.0, 0.0, 1.0);
    o.uv = v.uv; o.layer = i32(v.la.x + 0.5); o.alpha = v.la.y; o.nrm = v.nrm; o.depth = v.depth;
    return o;
}

@fragment fn fs_globe(i: VOut) -> @location(0) vec4<f32> {
    let tex = textureSample(atl, asamp, i.uv, i.layer).rgb;
    let d = clamp(i.depth, 0.0, 1.0);
    let l = dot(normalize(i.nrm), gu.sun.xyz);
    let day = smoothstep(-0.105, 0.14, l);
    var c: vec3<f32>;
    var haze = (1.0 - d) * (1.0 - d) * (1.0 - d);
    if (gu.sun.w > 0.5) {
        c = tex * (0.55 + 0.45 * d);
        haze = haze * 0.25;
    } else {
        let lit = 0.34 + 0.76 * pow(max(l, 0.0), 0.7);
        let night = tex * vec3<f32>(0.045, 0.062, 0.115);
        c = mix(night, tex * lit, day);
        // twilight: warm band along the terminator
        let tw = exp(-pow(l / 0.075, 2.0)) * 0.30;
        c = mix(c, vec3<f32>(1.0, 0.50, 0.22) * (0.35 + 0.65 * dot(tex, vec3<f32>(0.33))), tw);
        c = c * (0.55 + 0.45 * d);
        haze = haze * (0.25 + 0.75 * day);
    }
    c = c + vec3<f32>(0.20, 0.38, 0.75) * haze;
    return vec4<f32>(c, i.alpha);
}
