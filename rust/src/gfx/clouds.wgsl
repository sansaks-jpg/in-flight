// Volumetric clouds: two slabs (cumulus deck + cirrus) ray-marched in a full-screen pass AFTER the opaque scene.
// The scene depth buffer limits the march, so terrain / aircraft / cockpit correctly occlude (and are veiled by) clouds.
// Density function is a bit-compatible mirror of src/clouds.rs (integer hash, same fBm, same height profile).
@group(1) @binding(0) var depth_tex: texture_depth_2d;

struct VOut { @builtin(position) clip: vec4<f32>, @location(0) ndc: vec2<f32> };
@vertex fn vs_clouds(@builtin(vertex_index) vi: u32) -> VOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var o: VOut;
    o.clip = vec4<f32>(p[vi], 0.0, 1.0);
    o.ndc = p[vi];
    return o;
}

fn hash3(ix: i32, iy: i32, iz: i32) -> f32 {
    var h = (bitcast<u32>(ix) * 0x27d4eb2du) ^ (bitcast<u32>(iy) * 0x165667b1u) ^ (bitcast<u32>(iz) * 0x9e3779b9u);
    h = h ^ (h >> 15u);
    h = h * 0x85ebca6bu;
    h = h ^ (h >> 13u);
    h = h * 0xc2b2ae35u;
    h = h ^ (h >> 16u);
    return f32(h >> 8u) / 16777216.0;
}
fn vnoise3(p: vec3<f32>) -> f32 {
    let fp = floor(p);
    let ip = vec3<i32>(fp);
    let t = p - fp;
    let u = t * t * (3.0 - 2.0 * t);
    let x00 = mix(hash3(ip.x, ip.y, ip.z), hash3(ip.x + 1, ip.y, ip.z), u.x);
    let x10 = mix(hash3(ip.x, ip.y + 1, ip.z), hash3(ip.x + 1, ip.y + 1, ip.z), u.x);
    let x01 = mix(hash3(ip.x, ip.y, ip.z + 1), hash3(ip.x + 1, ip.y, ip.z + 1), u.x);
    let x11 = mix(hash3(ip.x, ip.y + 1, ip.z + 1), hash3(ip.x + 1, ip.y + 1, ip.z + 1), u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
fn fbm3(p0: vec3<f32>, oct: i32) -> f32 {
    var p = p0;
    var sum = 0.0;
    var amp = 0.5;
    var norm = 0.0;
    for (var k = 0; k < oct; k = k + 1) {
        sum = sum + vnoise3(p) * amp;
        norm = norm + amp;
        amp = amp * 0.5;
        p = p * 2.02 + vec3<f32>(17.1, 9.3, 5.7);
    }
    return sum / norm;
}

// layer = (base, top, cover, sigma); freq in 1/m
fn cloud_density(p: vec3<f32>, layer: vec4<f32>, freq: f32, oct: i32) -> f32 {
    if (layer.z <= 0.0 || p.y < layer.x || p.y > layer.y) { return 0.0; }
    let hn = (p.y - layer.x) / (layer.y - layer.x);
    let profile = smoothstep(0.0, 0.14, hn) * (1.0 - smoothstep(0.55, 1.0, hn));
    let q = vec3<f32>(p.x - g.env.x, p.y, p.z - g.env.y) * freq;
    let n = fbm3(q, oct);
    let thr = 0.62 - 0.30 * layer.z;
    return clamp((n - thr) * 4.0, 0.0, 1.0) * profile;
}

fn slab(layer: vec4<f32>, y0: f32, dy: f32, tmax: f32) -> vec2<f32> {
    if (layer.z <= 0.0) { return vec2<f32>(0.0, -1.0); }
    var ta = 0.0;
    var tb = tmax;
    if (abs(dy) < 1e-4) {
        if (y0 < layer.x || y0 > layer.y) { return vec2<f32>(0.0, -1.0); }
    } else {
        let t1 = (layer.x - y0) / dy;
        let t2 = (layer.y - y0) / dy;
        ta = max(min(t1, t2), 0.0);
        tb = min(max(t1, t2), tmax);
    }
    return vec2<f32>(ta, tb);
}

fn hash12(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2<f32>(0.1031, 0.1030));
    q = q + dot(q, q.yx + 33.33);
    return fract((q.x + q.y) * q.x);
}

struct March { col: vec3<f32>, trans: f32 };

fn march(layer: vec4<f32>, freq: f32, o: vec3<f32>, dir: vec3<f32>, rng: vec2<f32>, jit: f32, acc_in: March) -> March {
    var acc = acc_in;
    // a long horizontal path through a thin slab: cap the length so the step stays useful, far cloud fades into the haze
    let t0 = rng.x;
    let t1 = min(rng.y, rng.x + 36000.0);
    if (t1 <= t0) { return acc; }
    let steps = 26;
    let dt = (t1 - t0) / f32(steps);
    let cos_s = dot(dir, g.sun_dir.xyz);
    let phase = 0.9 + 2.6 * pow(max(cos_s, 0.0), 10.0);
    let lstep = select(110.0, 260.0, layer.w < 0.004);
    let thick = layer.y - layer.x;
    for (var k = 0; k < steps; k = k + 1) {
        let t = t0 + (f32(k) + jit) * dt;
        let p = o + dir * t;
        let d = cloud_density(p, layer, freq, 4);
        if (d > 0.004) {
            let sig = layer.w * d;
            let tr = exp(-sig * dt);
            // optical depth towards the sun (3 coarse samples) => self shadowing / dark bases / silver linings
            var od = 0.0;
            for (var j = 1; j <= 3; j = j + 1) {
                od = od + cloud_density(p + g.sun_dir.xyz * (f32(j) * lstep), layer, freq, 2) * lstep * layer.w;
            }
            let beer = exp(-od * 1.15) + 0.12 * exp(-od * 0.25);
            let hn = clamp((p.y - layer.x) / thick, 0.0, 1.0);
            let shade = mix(0.55, 1.0, hn);
            let amb_c = (g.amb.rgb * 1.7 + g.zenith.rgb * 0.15) * shade;
            var c = g.sun_col.rgb * beer * phase * 0.85 + amb_c;
            // lightning lights the cloud from inside
            c = c + vec3<f32>(0.75, 0.82, 1.0) * g.params.z * (0.6 + 1.4 * d);
            // aerial perspective
            let fa = 1.0 - exp(-pow(max(t * g.fog.a * 0.55, 0.0), 1.5));
            c = mix(c, g.fog.rgb, clamp(fa, 0.0, 0.92));
            acc.col = acc.col + acc.trans * (1.0 - tr) * c;
            acc.trans = acc.trans * tr;
            if (acc.trans < 0.02) { break; }
        }
    }
    return acc;
}

@fragment fn fs_clouds(i: VOut) -> @location(0) vec4<f32> {
    let h0 = g.inv_view_proj * vec4<f32>(i.ndc, 1.0, 1.0);
    let dir = normalize(h0.xyz / h0.w);
    let d = textureLoad(depth_tex, vec2<i32>(i.clip.xy), 0);
    var tmax = 150000.0;
    if (d > 0.0) {
        let hp = g.inv_view_proj * vec4<f32>(i.ndc, d, 1.0);
        tmax = length(hp.xyz / hp.w);
    }
    let y0 = g.cam_pos.y;
    let r0 = slab(g.cloud0, y0, dir.y, tmax);
    let r1 = slab(g.cloud1, y0, dir.y, tmax);
    if (r0.y <= r0.x && r1.y <= r1.x) { return vec4<f32>(0.0); }
    let jit = hash12(i.clip.xy + vec2<f32>(fract(g.cam_pos.w) * 61.0, 0.0));
    var acc = March(vec3<f32>(0.0), 1.0);
    let o = g.cam_pos.xyz;
    // front-to-back: whichever slab is entered first is marched first
    if (r0.x <= r1.x) {
        acc = march(g.cloud0, 1.0 / 2600.0, o, dir, r0, jit, acc);
        acc = march(g.cloud1, 1.0 / 7000.0, o, dir, r1, jit, acc);
    } else {
        acc = march(g.cloud1, 1.0 / 7000.0, o, dir, r1, jit, acc);
        acc = march(g.cloud0, 1.0 / 2600.0, o, dir, r0, jit, acc);
    }
    // premultiplied colour, alpha = 1 - transmittance
    return vec4<f32>(acc.col, 1.0 - acc.trans);
}
