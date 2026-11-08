//! Tile image decoding. Runs on loader worker threads only: PNG / JPEG bytes -> 256x256 RGBA8 + a full mip chain, laid out
//! as one contiguous buffer so the render thread only has to issue `write_texture` calls (no CPU work, no allocation).

use super::math::TILE_PX;

/// Mip levels of a 256x256 tile (256, 128, ... 1).
pub const MIPS: usize = 9;

/// Byte offset of mip `level` inside a decoded buffer.
pub const fn mip_offset(level: usize) -> usize {
    let mut off = 0;
    let mut l = 0;
    while l < level {
        let d = TILE_PX >> l;
        off += d * d * 4;
        l += 1;
    }
    off
}
pub const fn mip_dim(level: usize) -> usize {
    let d = TILE_PX >> level;
    if d == 0 {
        1
    } else {
        d
    }
}
/// Total size of a tile with mips.
pub const TILE_BYTES: usize = mip_offset(MIPS);

/// Decodes a PNG or JPEG into RGBA8 `(w, h, pixels)`.
pub fn decode_rgba(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    if bytes.len() < 8 {
        return Err("empty tile".into());
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
        dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut rd = dec.read_info().map_err(|e| format!("png: {e}"))?;
        let mut buf = vec![0u8; rd.output_buffer_size().ok_or("png: size overflow")?];
        let info = rd.next_frame(&mut buf).map_err(|e| format!("png: {e}"))?;
        let (w, h) = (info.width as usize, info.height as usize);
        let src = &buf[..info.buffer_size()];
        let mut out = Vec::with_capacity(w * h * 4);
        match info.color_type {
            png::ColorType::Rgba => out.extend_from_slice(src),
            png::ColorType::Rgb => src.chunks_exact(3).for_each(|p| out.extend_from_slice(&[p[0], p[1], p[2], 255])),
            png::ColorType::Grayscale => src.iter().for_each(|&g| out.extend_from_slice(&[g, g, g, 255])),
            png::ColorType::GrayscaleAlpha => src.chunks_exact(2).for_each(|p| out.extend_from_slice(&[p[0], p[0], p[0], p[1]])),
            png::ColorType::Indexed => return Err("png: unexpanded palette".into()),
        }
        if out.len() != w * h * 4 {
            return Err("png: size mismatch".into());
        }
        Ok((w, h, out))
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut dec = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
        let px = dec.decode().map_err(|e| format!("jpeg: {e}"))?;
        let info = dec.info().ok_or("jpeg: no info")?;
        let (w, h) = (info.width as usize, info.height as usize);
        let mut out = Vec::with_capacity(w * h * 4);
        match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => px.chunks_exact(3).for_each(|p| out.extend_from_slice(&[p[0], p[1], p[2], 255])),
            jpeg_decoder::PixelFormat::L8 => px.iter().for_each(|&g| out.extend_from_slice(&[g, g, g, 255])),
            jpeg_decoder::PixelFormat::L16 => px.chunks_exact(2).for_each(|p| out.extend_from_slice(&[p[0], p[0], p[0], 255])),
            jpeg_decoder::PixelFormat::CMYK32 => px.chunks_exact(4).for_each(|p| {
                let k = p[3] as u32;
                out.extend_from_slice(&[(p[0] as u32 * k / 255) as u8, (p[1] as u32 * k / 255) as u8, (p[2] as u32 * k / 255) as u8, 255])
            }),
        }
        if out.len() != w * h * 4 {
            return Err("jpeg: size mismatch".into());
        }
        Ok((w, h, out))
    } else {
        Err("unknown tile format (neither PNG nor JPEG)".into())
    }
}

/// Resamples to exactly 256x256 (area average when shrinking by an integer factor, nearest otherwise).
fn to_tile_size(w: usize, h: usize, src: Vec<u8>) -> Vec<u8> {
    if w == TILE_PX && h == TILE_PX {
        return src;
    }
    let mut out = vec![0u8; TILE_PX * TILE_PX * 4];
    let (fx, fy) = (w / TILE_PX, h / TILE_PX);
    let integer = fx >= 1 && fy >= 1 && w % TILE_PX == 0 && h % TILE_PX == 0;
    for y in 0..TILE_PX {
        for x in 0..TILE_PX {
            let o = (y * TILE_PX + x) * 4;
            if integer {
                let mut acc = [0u32; 4];
                for dy in 0..fy {
                    for dx in 0..fx {
                        let i = ((y * fy + dy) * w + x * fx + dx) * 4;
                        for c in 0..4 {
                            acc[c] += src[i + c] as u32;
                        }
                    }
                }
                let n = (fx * fy) as u32;
                for c in 0..4 {
                    out[o + c] = (acc[c] / n) as u8;
                }
            } else {
                let i = ((y * h / TILE_PX) * w + x * w / TILE_PX) * 4;
                out[o..o + 4].copy_from_slice(&src[i..i + 4]);
            }
        }
    }
    out
}

/// Builds the contiguous mip chain (box filter) from a 256x256 RGBA image.
pub fn build_mips(base: Vec<u8>) -> Vec<u8> {
    debug_assert_eq!(base.len(), TILE_PX * TILE_PX * 4);
    let mut out = base;
    out.resize(TILE_BYTES, 0);
    for l in 1..MIPS {
        let (sd, dd) = (mip_dim(l - 1), mip_dim(l));
        let (so, dof) = (mip_offset(l - 1), mip_offset(l));
        for y in 0..dd {
            for x in 0..dd {
                for c in 0..4 {
                    let at = |xx: usize, yy: usize| out[so + (yy.min(sd - 1) * sd + xx.min(sd - 1)) * 4 + c] as u32;
                    let v = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1) + 2) / 4;
                    out[dof + (y * dd + x) * 4 + c] = v as u8;
                }
            }
        }
    }
    out
}

/// PNG / JPEG bytes -> ready-to-upload tile (256x256 RGBA + mips, `TILE_BYTES` long).
pub fn decode_tile(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (w, h, px) = decode_rgba(bytes)?;
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        return Err(format!("bad tile size {w}x{h}"));
    }
    Ok(build_mips(to_tile_size(w, h, px)))
}

#[cfg(test)]
pub(crate) fn encode_test_png(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().unwrap();
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend_from_slice(&f(x, y));
            }
        }
        wr.write_image_data(&data).unwrap();
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mip_layout_is_contiguous() {
        assert_eq!(mip_offset(0), 0);
        assert_eq!(mip_offset(1), 256 * 256 * 4);
        assert_eq!(TILE_BYTES, (0..MIPS).map(|l| mip_dim(l) * mip_dim(l) * 4).sum::<usize>());
        assert_eq!(mip_dim(MIPS - 1), 1);
    }

    #[test]
    fn png_roundtrip_with_mips() {
        let png = encode_test_png(256, 256, |x, y| [x as u8, y as u8, 128, 255]);
        let t = decode_tile(&png).unwrap();
        assert_eq!(t.len(), TILE_BYTES);
        assert_eq!(&t[..4], &[0, 0, 128, 255]);
        let o = (10 * 256 + 20) * 4;
        assert_eq!(&t[o..o + 4], &[20, 10, 128, 255]);
        // the 1x1 mip is the average colour
        let last = mip_offset(MIPS - 1);
        assert!((t[last] as i32 - 127).abs() <= 2 && (t[last + 1] as i32 - 127).abs() <= 2);
    }

    #[test]
    fn oversize_tiles_are_resampled() {
        let png = encode_test_png(512, 512, |_, _| [200, 100, 50, 255]);
        let t = decode_tile(&png).unwrap();
        assert_eq!(&t[..4], &[200, 100, 50, 255]);
        let png = encode_test_png(100, 60, |_, _| [9, 8, 7, 255]);
        assert_eq!(&decode_tile(&png).unwrap()[..3], &[9, 8, 7]);
    }

    #[test]
    fn garbage_is_rejected_not_panicking() {
        assert!(decode_tile(b"<html>rate limited</html>").is_err());
        assert!(decode_tile(&[]).is_err());
        assert!(decode_tile(&[0xFF, 0xD8, 0xFF, 0x00, 1, 2, 3, 4, 5, 6]).is_err());
        let mut p = encode_test_png(8, 8, |_, _| [1, 2, 3, 255]);
        p.truncate(p.len() / 2);
        assert!(decode_tile(&p).is_err());
    }
}
