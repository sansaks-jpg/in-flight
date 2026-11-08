// Shared uniform block. Concatenated in front of every shader (world, sky, clouds, precip, panel) by `gfx/mod.rs`.
struct Globals {
    view_proj: mat4x4<f32>,
    inv_view_proj: mat4x4<f32>,
    cam_pos: vec4<f32>,   // xyz = absolute world position, w = time (s)
    sun_dir: vec4<f32>,   // xyz = direction towards the sun
    sun_col: vec4<f32>,   // rgb = sun light colour * intensity, a = sun elevation (deg)
    amb: vec4<f32>,       // rgb = ambient light, a = night factor 0 (day) .. 1 (night)
    fog: vec4<f32>,       // rgb = horizon / fog colour, a = fog density (1/m)
    zenith: vec4<f32>,    // rgb = zenith colour
    params: vec4<f32>,    // x = cloud base (m), y = cloud cover 0..1, z = lightning flash 0..1, w = aspect
    cloud0: vec4<f32>,    // low layer: base, top, cover, sigma (1/m)
    cloud1: vec4<f32>,    // high layer
    env: vec4<f32>,       // x,y = cloud pattern wind offset (m), z = precip intensity, w = snow flag
    env2: vec4<f32>,      // x = lightning azimuth (rad), y = in-cloud 0..1, z = wetness 0..1, w = frame
};
@group(0) @binding(0) var<uniform> g: Globals;
