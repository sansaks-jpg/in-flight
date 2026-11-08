// Cockpit display units: quads textured from the render-to-texture atlas that `gfx/displays.rs` draws every frame.
// Self-illuminated (no sun lighting) with a faint glass reflection and a dark bezel falloff at the edges.
struct Model { m: mat4x4<f32>, tint: vec4<f32> };
@group(1) @binding(0) var<uniform> model: Model;
@group(2) @binding(0) var disp_tex: texture_2d<f32>;
@group(2) @binding(1) var disp_smp: sampler;

struct POut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) nrm: vec3<f32> };
@vertex fn vs_panel(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>) -> POut {
    var o: POut;
    let rel = (model.m * vec4<f32>(pos, 1.0)).xyz;
    o.clip = g.view_proj * vec4<f32>(rel, 1.0);
    o.uv = uv;
    o.nrm = normalize((model.m * vec4<f32>(0.0, 0.0, 1.0, 0.0)).xyz);
    return o;
}
@fragment fn fs_panel(i: POut) -> @location(0) vec4<f32> {
    let c = textureSample(disp_tex, disp_smp, i.uv).rgb;
    // glass: a little sky reflection towards the top of each screen
    let glare = g.amb.rgb * 0.10 * (1.0 - g.amb.a);
    return vec4<f32>(c * 1.05 + glare, 1.0);
}
