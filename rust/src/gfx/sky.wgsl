// Full-screen procedural sky: gradient from the real sun position, sun disc / glow, stars at night, lightning glow.
struct VOut { @builtin(position) clip: vec4<f32>, @location(0) ndc: vec2<f32> };
@vertex fn vs_sky(@builtin(vertex_index) vi: u32) -> VOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var o: VOut;
    o.clip = vec4<f32>(p[vi], 0.0, 1.0);
    o.ndc = p[vi];
    return o;
}
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
fn fbm(p0: vec2<f32>) -> f32 {
    var p = p0; var a = 0.5; var s = 0.0;
    for (var k = 0; k < 5; k = k + 1) { s = s + vnoise(p) * a; p = p * 2.03 + vec2<f32>(17.1, 9.3); a = a * 0.5; }
    return s;
}
@fragment fn fs_sky(i: VOut) -> @location(0) vec4<f32> {
    let h = g.inv_view_proj * vec4<f32>(i.ndc, 1.0, 1.0);
    let dir = normalize(h.xyz / h.w);
    let up = dir.y;
    let night = g.amb.a;
    var col = mix(g.fog.rgb, g.zenith.rgb, pow(clamp(up, 0.0, 1.0), 0.42));
    if (up < 0.0) { col = mix(g.fog.rgb, g.fog.rgb * 0.75, clamp(-up * 5.0, 0.0, 1.0)); }
    let sd = max(dot(dir, g.sun_dir.xyz), 0.0);
    let day = 1.0 - night;
    col = col + g.sun_col.rgb * (pow(sd, 900.0) * 40.0 + pow(sd, 12.0) * 0.20 * day + pow(sd, 3.0) * 0.06 * day);
    // stars
    if (night > 0.05 && up > 0.0) {
        let su = vec2<f32>(atan2(dir.z, dir.x) * 190.0, dir.y * 190.0);
        let cell = floor(su);
        let r = hash21(cell);
        let tw = 0.7 + 0.3 * sin(g.cam_pos.w * 3.0 + r * 40.0);
        let dotp = smoothstep(0.22, 0.0, length(fract(su) - vec2<f32>(0.5)));
        col = col + vec3<f32>(1.0) * step(0.985, r) * dotp * night * tw * clamp(up * 3.0, 0.0, 1.0);
    }
    // lightning: whole-sky flash, stronger towards the stroke azimuth (clouds are ray-marched in clouds.wgsl)
    if (g.params.z > 0.001) {
        let bolt = vec2<f32>(sin(g.env2.x), -cos(g.env2.x));
        let hd = normalize(dir.xz + vec2<f32>(1e-4));
        let tow = pow(max(dot(hd, bolt), 0.0), 3.0);
        col = col + vec3<f32>(0.62, 0.68, 1.0) * g.params.z * (0.18 + 0.9 * tow) * (1.0 - 0.6 * clamp(up, 0.0, 1.0));
    }
    return vec4<f32>(col, 1.0);
}
