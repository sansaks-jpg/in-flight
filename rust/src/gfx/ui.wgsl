struct Screen { size: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> scr: Screen;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VIn { @location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) col: vec4<f32> };
struct VOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) col: vec4<f32> };

@vertex fn vs_ui(v: VIn) -> VOut {
    var o: VOut;
    o.clip = vec4<f32>(v.pos.x / scr.size.x * 2.0 - 1.0, 1.0 - v.pos.y / scr.size.y * 2.0, 0.0, 1.0);
    o.uv = v.uv; o.col = v.col;
    return o;
}
@fragment fn fs_ui(i: VOut) -> @location(0) vec4<f32> {
    let a = textureSample(atlas, samp, i.uv).r;
    return vec4<f32>(i.col.rgb, i.col.a * a);
}
