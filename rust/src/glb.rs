//! Minimal binary-glTF (GLB 2.0) reader for the downloaded A320 flight-deck model.
//!
//! Only what the pinned `cockpit.glb` needs (`asset.generator = "AeroDeck AC3D converter"`): flat node list (one mesh per node, no
//! compression extensions), float POSITION / NORMAL / TEXCOORD_0, u32 indices, base-colour factor + texture, `alphaMode`
//! OPAQUE / MASK / BLEND, embedded PNG / JPEG images. Node transforms (matrix or TRS) are baked into the vertices so every
//! mesh is expressed in model space (metres, -X forward, +Y up, +Z captain's side).

use glam::{Mat3, Mat4, Quat, Vec3};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Material {
    pub name: String,
    pub base: [f32; 4],
    pub image: Option<usize>,
    /// 0 opaque, 1 alpha-test (MASK), 2 blend
    pub mode: u8,
    pub cutoff: f32,
    pub double_sided: bool,
}

#[derive(Clone, Debug, Default)]
pub struct MeshData {
    /// original (un-sanitised) node name, e.g. `pfd1.screen`, `ap1.cpt`
    pub name: String,
    pub material: usize,
    pub pos: Vec<[f32; 3]>,
    pub nrm: Vec<[f32; 3]>,
    pub uv: Vec<[f32; 2]>,
    pub idx: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Image {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct Glb {
    pub meshes: Vec<MeshData>,
    pub materials: Vec<Material>,
    /// raw encoded image bytes (decoded on demand, see `decode_image`)
    pub images: Vec<(String, Vec<u8>)>,
}

fn u32le(b: &[u8], o: usize) -> Result<u32, String> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| "truncated GLB".to_string())
}

fn f32s(bin: &[u8], off: usize, n: usize) -> Result<Vec<f32>, String> {
    let s = bin.get(off..off + n * 4).ok_or("accessor out of range")?;
    Ok(s.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

struct Acc<'a> {
    j: &'a Value,
    bin: &'a [u8],
}

impl Acc<'_> {
    /// (byte offset of element 0, count, stride)
    fn locate(&self, acc: usize, comps: usize, ctype: u64) -> Result<(usize, usize, usize), String> {
        let a = &self.j["accessors"][acc];
        if a["componentType"].as_u64() != Some(ctype) {
            return Err(format!("accessor {acc}: unsupported component type {:?}", a["componentType"]));
        }
        let count = a["count"].as_u64().ok_or("accessor count")? as usize;
        let bv = &self.j["bufferViews"][a["bufferView"].as_u64().ok_or("sparse accessors unsupported")? as usize];
        let off = bv["byteOffset"].as_u64().unwrap_or(0) as usize + a["byteOffset"].as_u64().unwrap_or(0) as usize;
        let stride = bv["byteStride"].as_u64().map(|s| s as usize).unwrap_or(comps * if ctype == 5126 || ctype == 5125 { 4 } else { 2 });
        Ok((off, count, stride))
    }

    fn floats(&self, acc: usize, comps: usize) -> Result<Vec<f32>, String> {
        let (off, count, stride) = self.locate(acc, comps, 5126)?;
        let mut out = Vec::with_capacity(count * comps);
        for i in 0..count {
            out.extend(f32s(self.bin, off + i * stride, comps)?);
        }
        Ok(out)
    }

    fn indices(&self, acc: usize) -> Result<Vec<u32>, String> {
        let ctype = self.j["accessors"][acc]["componentType"].as_u64().unwrap_or(0);
        match ctype {
            5125 => {
                let (off, count, stride) = self.locate(acc, 1, 5125)?;
                (0..count).map(|i| u32le(self.bin, off + i * stride)).collect()
            }
            5123 => {
                let (off, count, stride) = self.locate(acc, 1, 5123)?;
                (0..count).map(|i| self.bin.get(off + i * stride..off + i * stride + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as u32).ok_or_else(|| "truncated".to_string())).collect()
            }
            _ => Err(format!("unsupported index type {ctype}")),
        }
    }
}

/// Parse a GLB container.
pub fn parse(data: &[u8]) -> Result<Glb, String> {
    if data.len() < 20 || &data[0..4] != b"glTF" {
        return Err("not a GLB file".into());
    }
    if u32le(data, 4)? != 2 {
        return Err("only glTF 2.0 is supported".into());
    }
    let total = u32le(data, 8)? as usize;
    if total > data.len() {
        return Err("GLB is truncated".into());
    }
    let (mut json, mut bin) = (None, None);
    let mut o = 12;
    while o + 8 <= total {
        let len = u32le(data, o)? as usize;
        let ty = &data[o + 4..o + 8];
        let body = data.get(o + 8..o + 8 + len).ok_or("chunk out of range")?;
        match ty {
            b"JSON" => json = Some(body),
            b"BIN\0" => bin = Some(body),
            _ => {}
        }
        o += 8 + len.div_ceil(4) * 4;
    }
    let j: Value = serde_json::from_slice(json.ok_or("missing JSON chunk")?).map_err(|e| e.to_string())?;
    let bin = bin.unwrap_or(&[]);
    let acc = Acc { j: &j, bin };

    // ---- materials ----
    let mut materials: Vec<Material> = Vec::new();
    let tex_img = |ti: usize| j["textures"][ti]["source"].as_u64().map(|v| v as usize);
    if let Some(ms) = j["materials"].as_array() {
        for m in ms {
            let pbr = &m["pbrMetallicRoughness"];
            let mut base = [1.0f32; 4];
            if let Some(a) = pbr["baseColorFactor"].as_array() {
                for (k, v) in a.iter().take(4).enumerate() {
                    base[k] = v.as_f64().unwrap_or(1.0) as f32;
                }
            }
            materials.push(Material {
                name: m["name"].as_str().unwrap_or("").to_string(),
                base,
                image: pbr["baseColorTexture"]["index"].as_u64().and_then(|t| tex_img(t as usize)),
                mode: match m["alphaMode"].as_str() {
                    Some("MASK") => 1,
                    Some("BLEND") => 2,
                    _ => 0,
                },
                cutoff: m["alphaCutoff"].as_f64().unwrap_or(0.5) as f32,
                double_sided: m["doubleSided"].as_bool().unwrap_or(false),
            });
        }
    }
    if materials.is_empty() {
        materials.push(Material { name: "default".into(), base: [0.7; 4], image: None, mode: 0, cutoff: 0.5, double_sided: true });
    }

    // ---- images (kept encoded) ----
    let mut images = Vec::new();
    if let Some(is) = j["images"].as_array() {
        for im in is {
            let name = im["name"].as_str().unwrap_or("").to_string();
            let bytes = match im["bufferView"].as_u64() {
                Some(bv) => {
                    let v = &j["bufferViews"][bv as usize];
                    let off = v["byteOffset"].as_u64().unwrap_or(0) as usize;
                    let len = v["byteLength"].as_u64().unwrap_or(0) as usize;
                    bin.get(off..off + len).ok_or("image out of range")?.to_vec()
                }
                None => Vec::new(),
            };
            images.push((name, bytes));
        }
    }

    // ---- meshes (one per node; node transform baked) ----
    let mut meshes = Vec::new();
    for node in j["nodes"].as_array().ok_or("no nodes")? {
        let Some(mi) = node["mesh"].as_u64() else { continue };
        let name = node["extras"]["sourceName"].as_str().or(node["name"].as_str()).unwrap_or("").to_string();
        let xf = node_matrix(node);
        let nm = Mat3::from_mat4(xf).inverse().transpose();
        for prim in j["meshes"][mi as usize]["primitives"].as_array().ok_or("mesh without primitives")? {
            if prim["mode"].as_u64().unwrap_or(4) != 4 {
                continue;
            }
            let at = &prim["attributes"];
            let p = acc.floats(at["POSITION"].as_u64().ok_or("no POSITION")? as usize, 3)?;
            let n = match at["NORMAL"].as_u64() {
                Some(a) => acc.floats(a as usize, 3)?,
                None => vec![0.0, 1.0, 0.0].repeat(p.len() / 3),
            };
            let t = match at["TEXCOORD_0"].as_u64() {
                Some(a) => acc.floats(a as usize, 2)?,
                None => vec![0.0; p.len() / 3 * 2],
            };
            let idx = match prim["indices"].as_u64() {
                Some(a) => acc.indices(a as usize)?,
                None => (0..(p.len() / 3) as u32).collect(),
            };
            let nv = p.len() / 3;
            if idx.iter().any(|&i| i as usize >= nv) {
                return Err(format!("{name}: index out of range"));
            }
            let mut m = MeshData { name: name.clone(), material: prim["material"].as_u64().unwrap_or(0) as usize, idx, ..Default::default() };
            m.material = m.material.min(materials.len() - 1);
            for i in 0..nv {
                m.pos.push(xf.transform_point3(Vec3::new(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])).to_array());
                m.nrm.push((nm * Vec3::new(n[i * 3], n[i * 3 + 1], n[i * 3 + 2])).normalize_or_zero().to_array());
                m.uv.push([t[i * 2], t[i * 2 + 1]]);
            }
            meshes.push(m);
        }
    }
    Ok(Glb { meshes, materials, images })
}

fn node_matrix(n: &Value) -> Mat4 {
    if let Some(a) = n["matrix"].as_array() {
        let v: Vec<f32> = a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
        if v.len() == 16 {
            return Mat4::from_cols_slice(&v);
        }
    }
    let arr = |k: &str, d: &[f32]| -> Vec<f32> { n[k].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).filter(|v: &Vec<f32>| v.len() == d.len()).unwrap_or_else(|| d.to_vec()) };
    let (t, r, s) = (arr("translation", &[0.0; 3]), arr("rotation", &[0.0, 0.0, 0.0, 1.0]), arr("scale", &[1.0; 3]));
    Mat4::from_scale_rotation_translation(Vec3::new(s[0], s[1], s[2]), Quat::from_xyzw(r[0], r[1], r[2], r[3]).normalize(), Vec3::new(t[0], t[1], t[2]))
}

/// Decode an embedded PNG / JPEG to RGBA8, box-downscaling by 2 until both sides are <= `max_dim`.
pub fn decode_image(bytes: &[u8], max_dim: u32) -> Result<Image, String> {
    let (mut w, mut h, mut rgba);
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
        dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut rd = dec.read_info().map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; rd.output_buffer_size().ok_or("image too large")?];
        let info = rd.next_frame(&mut buf).map_err(|e| e.to_string())?;
        (w, h) = (info.width, info.height);
        let px = (w * h) as usize;
        rgba = Vec::with_capacity(px * 4);
        let src = &buf[..info.buffer_size()];
        match info.color_type {
            png::ColorType::Rgba => rgba.extend_from_slice(src),
            png::ColorType::Rgb => src.chunks_exact(3).for_each(|c| rgba.extend_from_slice(&[c[0], c[1], c[2], 255])),
            png::ColorType::Grayscale => src.iter().for_each(|&g| rgba.extend_from_slice(&[g, g, g, 255])),
            png::ColorType::GrayscaleAlpha => src.chunks_exact(2).for_each(|c| rgba.extend_from_slice(&[c[0], c[0], c[0], c[1]])),
            png::ColorType::Indexed => return Err("indexed PNG not expanded".into()),
        }
    } else {
        let mut dec = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
        let px = dec.decode().map_err(|e| e.to_string())?;
        let i = dec.info().ok_or("no JPEG info")?;
        (w, h) = (i.width as u32, i.height as u32);
        rgba = Vec::with_capacity((w * h * 4) as usize);
        match i.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => px.chunks_exact(3).for_each(|c| rgba.extend_from_slice(&[c[0], c[1], c[2], 255])),
            jpeg_decoder::PixelFormat::L8 => px.iter().for_each(|&g| rgba.extend_from_slice(&[g, g, g, 255])),
            _ => return Err("unsupported JPEG pixel format".into()),
        }
    }
    while w > max_dim || h > max_dim {
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let mut out = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                for c in 0..4 {
                    let g = |dx: u32, dy: u32| rgba[(((y * 2 + dy).min(h - 1) * w + (x * 2 + dx).min(w - 1)) * 4 + c) as usize] as u32;
                    out[((y * nw + x) * 4 + c) as usize] = ((g(0, 0) + g(1, 0) + g(0, 1) + g(1, 1) + 2) / 4) as u8;
                }
            }
        }
        (w, h, rgba) = (nw, nh, out);
    }
    Ok(Image { w, h, rgba })
}

impl Glb {
    pub fn triangle_count(&self) -> usize {
        self.meshes.iter().map(|m| m.idx.len() / 3).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a tiny GLB (one triangle with a translation) to test the container + accessor logic without the 50 MB asset.
    fn mini() -> Vec<u8> {
        let mut bin = Vec::new();
        for v in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0] {
            bin.extend_from_slice(&v.to_le_bytes());
        }
        for i in [0u32, 1, 2] {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        let json = r#"{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
        "nodes":[{"name":"tri","mesh":0,"translation":[1,2,3],"extras":{"sourceName":"a.b.cpt"}}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":2},"indices":3,"material":0}]}],
        "materials":[{"name":"m","alphaMode":"MASK","alphaCutoff":0.25,"pbrMetallicRoughness":{"baseColorFactor":[1,0.5,0,1]}}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},{"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},{"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"},{"bufferView":3,"componentType":5125,"count":3,"type":"SCALAR"}],
        "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":36},{"buffer":0,"byteOffset":72,"byteLength":24},{"buffer":0,"byteOffset":96,"byteLength":12}],
        "buffers":[{"byteLength":108}]}"#;
        let mut j = json.as_bytes().to_vec();
        while j.len() % 4 != 0 {
            j.push(b' ');
        }
        let total = 12 + 8 + j.len() + 8 + bin.len();
        let mut v = b"glTF".to_vec();
        v.extend_from_slice(&2u32.to_le_bytes());
        v.extend_from_slice(&(total as u32).to_le_bytes());
        v.extend_from_slice(&(j.len() as u32).to_le_bytes());
        v.extend_from_slice(b"JSON");
        v.extend_from_slice(&j);
        v.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        v.extend_from_slice(b"BIN\0");
        v.extend_from_slice(&bin);
        v
    }

    #[test]
    fn parses_minimal_glb_and_bakes_transform() {
        let g = parse(&mini()).unwrap();
        assert_eq!(g.meshes.len(), 1);
        let m = &g.meshes[0];
        assert_eq!(m.name, "a.b.cpt", "original (extras.sourceName) node name is preserved");
        assert_eq!(m.pos[0], [1.0, 2.0, 3.0]);
        assert_eq!(m.pos[1], [2.0, 2.0, 3.0]);
        assert_eq!(m.idx, vec![0, 1, 2]);
        assert_eq!(g.materials[0].mode, 1);
        assert_eq!(g.materials[0].cutoff, 0.25);
        assert_eq!(g.materials[0].base, [1.0, 0.5, 0.0, 1.0]);
        assert_eq!(g.triangle_count(), 1);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse(b"hello world, definitely not a GLB").is_err());
        let mut t = mini();
        t.truncate(60);
        assert!(parse(&t).is_err());
    }

    /// Full-fidelity check against the real downloaded model (skipped when the add-on is not installed).
    #[test]
    fn real_cockpit_model_if_installed() {
        let Some((bytes, _)) = crate::addons::AddonManager::new().read_installed() else {
            eprintln!("cockpit add-on not installed: skipping real-model test");
            return;
        };
        let g = parse(&bytes).expect("parse real GLB");
        assert_eq!(g.meshes.len(), 1223);
        assert_eq!(g.triangle_count(), 438_982, "triangle count of the upstream manifest");
        assert_eq!(g.materials.len(), 35);
        assert_eq!(g.images.len(), 21);
        for n in ["pfd1.screen", "ND.screen", "uecam.screen", "lecam.screen", "ap1", "FlapsLever", "gear_lever", "thr_l_body"] {
            assert!(g.meshes.iter().any(|m| m.name == n), "missing node {n}");
        }
        let im = decode_image(&g.images[0].1, 1024).unwrap();
        assert!(im.w <= 1024 && im.rgba.len() == (im.w * im.h * 4) as usize);
    }
}
