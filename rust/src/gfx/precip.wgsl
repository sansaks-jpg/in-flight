// Rain / snow: instanced camera-facing streaks recycled inside a box around the camera. The streak direction is the
// air velocity relative to the aircraft (fall speed minus aircraft velocity), so rain streaks stretch along the flight path
// at speed and fall nearly straight when parked. Drops are depth-tested against the scene (terrain / cockpit occlude).
struct P { m: mat4x4<f32>, v: vec4<f32> };      // v.xyz = aircraft velocity (m/s), v.w = intensity; m[0].x = snow
@group(1) @binding(0) var<uniform> pr: P;

const BOX: f32 = 80.0;

fn hu(n: u32) -> f32 {
    var h = n * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h = (h >> 22u) ^ h;
    return f32(h) / 4294967295.0;
}

struct POut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) alpha: f32 };

@vertex fn vs_precip(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
    var o: POut;
    o.clip = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    o.uv = vec2<f32>(0.0);
    o.alpha = 0.0;
    let active_ = step(hu(ii * 4u + 3u), pr.v.w);
    if (active_ < 0.5) { return o; }
    let snow = pr.m[0].x;
    let fall = mix(9.0, 1.3, snow);
    let t = g.cam_pos.w;
    let base = vec3<f32>(hu(ii * 4u), hu(ii * 4u + 1u), hu(ii * 4u + 2u)) * BOX;
    var wp = base - vec3<f32>(sin(t * 0.7 + f32(ii)) * 0.4 * snow, fall * t, 0.0);
    var rel = wp - g.cam_pos.xyz;
    rel = (fract(rel / BOX + 0.5) - 0.5) * BOX;
    let dist = length(rel);
    var vrel = vec3<f32>(0.0, -fall, 0.0) - pr.v.xyz;
    let vl = max(length(vrel), 0.01);
    let d = vrel / vl;
    let len = select(clamp(vl * 0.014, 0.10, 4.5), 0.07, snow > 0.5);
    let wid = select(0.010 + 0.0012 * dist * 0.2, 0.040, snow > 0.5);
    let side = normalize(cross(d, rel) + vec3<f32>(1e-5, 0.0, 0.0));
    var c = array<vec2<f32>, 6>(vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let k = c[vi];
    let pos = rel + side * k.x * wid - d * len * k.y;
    o.clip = g.view_proj * vec4<f32>(pos, 1.0);
    o.uv = vec2<f32>(k.x, k.y);
    let edge = 1.0 - smoothstep(BOX * 0.30, BOX * 0.5, dist);
    let near = smoothstep(0.6, 3.0, dist);
    o.alpha = edge * near * select(0.30, 0.75, snow > 0.5);
    return o;
}

@fragment fn fs_precip(i: POut) -> @location(0) vec4<f32> {
    let snow = pr.m[0].x;
    let shape = select(1.0 - i.uv.y * 0.85, 1.0 - length(i.uv - vec2<f32>(0.0, 0.5)), snow > 0.5);
    let a = i.alpha * clamp(shape, 0.0, 1.0) * (1.0 - abs(i.uv.x) * 0.5);
    let lum = g.amb.rgb * 1.8 + g.sun_col.rgb * 0.25 + vec3<f32>(0.06, 0.07, 0.08) + vec3<f32>(0.6, 0.65, 0.9) * g.params.z;
    return vec4<f32>(select(lum, vec3<f32>(0.9, 0.93, 1.0) * (lum + 0.15), snow > 0.5), a);
}
