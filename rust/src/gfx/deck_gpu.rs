//! GPU side of the HD flight deck: one vertex / index buffer for the whole 439k-triangle GLB, a storage buffer of per-control
//! poses (`deck::Slot`), one bind group per material (base colour + mip-mapped texture) and the display-atlas quads.
//! Created lazily when the add-on is loaded (`Fx::load_deck`), never at start-up, so the installer stays small.

use crate::deck::{Draw, GpuMesh, Slot};
use crate::glb::{Image, Material};
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MatU {
    base: [f32; 4],
    params: [f32; 4],
}

pub struct DeckPipes {
    pub opaque: wgpu::RenderPipeline,
    pub blend: wgpu::RenderPipeline,
    pub slots_bgl: wgpu::BindGroupLayout,
    pub mat_bgl: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
}

pub struct DeckGpu {
    vb: wgpu::Buffer,
    ib: wgpu::Buffer,
    slot_buf: wgpu::Buffer,
    slot_bg: wgpu::BindGroup,
    mats: Vec<wgpu::BindGroup>,
    draws: Vec<Draw>,
    /// draws[..opaque_n] are opaque / alpha-test, the rest are blended
    opaque_n: usize,
    pub scr_vb: wgpu::Buffer,
    pub scr_ib: wgpu::Buffer,
    pub scr_n: u32,
    pub slot_count: usize,
    pub triangles: u32,
}

impl DeckPipes {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, depth_format: wgpu::TextureFormat, globals_bgl: &wgpu::BindGroupLayout, model_bgl: &wgpu::BindGroupLayout, globals_wgsl: &str) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("deck"), source: wgpu::ShaderSource::Wgsl(format!("{globals_wgsl}\n{}", include_str!("deck.wgsl")).into()) });
        let slots_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("deck_slots"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            }],
        });
        let mat_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("deck_mat"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("deck"), bind_group_layouts: &[Some(globals_bgl), Some(model_bgl), Some(&slots_bgl), Some(&mat_bgl)], immediate_size: 0 });
        let attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Uint32];
        let mk = |label: &str, blend: Option<wgpu::BlendState>, write: bool| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs_deck"),
                    buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<crate::deck::DeckV>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs_deck"),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: depth_format,
                    depth_write_enabled: Some(write),
                    depth_compare: Some(wgpu::CompareFunction::Greater),
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let opaque = mk("deck_opaque", Some(wgpu::BlendState::REPLACE), true);
        let blend = mk("deck_blend", Some(wgpu::BlendState::ALPHA_BLENDING), false);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("deck_sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: 8,
            ..Default::default()
        });
        Self { opaque, blend, slots_bgl, mat_bgl, sampler }
    }
}

/// Box-filter mip chain (RGBA8). Returns concatenated levels, level count.
pub fn mip_chain(img: &Image) -> (Vec<u8>, u32) {
    let (mut w, mut h) = (img.w as usize, img.h as usize);
    let mut cur = img.rgba.clone();
    let mut out = cur.clone();
    let mut levels = 1;
    while w > 1 || h > 1 {
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let mut next = vec![0u8; nw * nh * 4];
        for y in 0..nh {
            for x in 0..nw {
                for c in 0..4 {
                    let s = |dx: usize, dy: usize| cur[(((y * 2 + dy).min(h - 1)) * w + (x * 2 + dx).min(w - 1)) * 4 + c] as u32;
                    next[(y * nw + x) * 4 + c] = ((s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1) + 2) / 4) as u8;
                }
            }
        }
        out.extend_from_slice(&next);
        cur = next;
        (w, h) = (nw, nh);
        levels += 1;
    }
    (out, levels)
}

fn upload_texture(device: &wgpu::Device, queue: &wgpu::Queue, img: &Image, label: &str) -> wgpu::TextureView {
    let (data, levels) = mip_chain(img);
    let tex = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: img.w, height: img.h, depth_or_array_layers: 1 },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &data,
    );
    tex.create_view(&wgpu::TextureViewDescriptor::default())
}

impl DeckGpu {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, pipes: &DeckPipes, mesh: &GpuMesh, images: &[Option<Image>]) -> Self {
        let vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("deck_vb"), contents: bytemuck::cast_slice(&mesh.verts), usage: wgpu::BufferUsages::VERTEX });
        let ib = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("deck_ib"), contents: bytemuck::cast_slice(&mesh.indices), usage: wgpu::BufferUsages::INDEX });
        let slot_size = (mesh.slot_count.max(1) * std::mem::size_of::<Slot>()) as u64;
        let slot_buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("deck_slots"), size: slot_size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        // identity poses until the first update
        let ident: Vec<Slot> = (0..mesh.slot_count).map(|_| Slot { m: glam::Mat4::IDENTITY.to_cols_array_2d(), mul: [1.0; 4], add: [0.0; 4] }).collect();
        queue.write_buffer(&slot_buf, 0, bytemuck::cast_slice(&ident));
        let slot_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("deck_slots"), layout: &pipes.slots_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: slot_buf.as_entire_binding() }] });

        let white = Image { w: 1, h: 1, rgba: vec![255; 4] };
        let white_view = upload_texture(device, queue, &white, "deck_white");
        let views: Vec<Option<wgpu::TextureView>> = images.iter().enumerate().map(|(i, im)| im.as_ref().map(|im| upload_texture(device, queue, im, &format!("deck_tex{i}")))).collect();
        let mats = mesh
            .materials
            .iter()
            .map(|m: &Material| {
                let view = m.image.and_then(|i| views.get(i)).and_then(|v| v.as_ref());
                let u = MatU { base: m.base, params: [m.mode as f32, m.cutoff, view.is_some() as i32 as f32, 0.0] };
                let ub = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("deck_mat"), contents: bytemuck::bytes_of(&u), usage: wgpu::BufferUsages::UNIFORM });
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("deck_mat"),
                    layout: &pipes.mat_bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: ub.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view.unwrap_or(&white_view)) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&pipes.sampler) },
                    ],
                })
            })
            .collect();
        let opaque_n = mesh.draws.iter().take_while(|d| mesh.materials[d.mat as usize].mode != 2).count();
        let scr_vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("deck_scr_vb"), contents: bytemuck::cast_slice(&mesh.screen_v), usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST });
        let scr_ib = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("deck_scr_ib"), contents: bytemuck::cast_slice(&mesh.screen_i), usage: wgpu::BufferUsages::INDEX });
        Self {
            vb,
            ib,
            slot_buf,
            slot_bg,
            mats,
            draws: mesh.draws.clone(),
            opaque_n,
            scr_vb,
            scr_ib,
            scr_n: mesh.screen_i.len() as u32,
            slot_count: mesh.slot_count,
            triangles: (mesh.indices.len() / 3) as u32,
        }
    }

    /// Re-aim the display quads (same vertex count, new UVs) after the ECAM / ND XFR routing changed.
    pub fn update_screens(&self, queue: &wgpu::Queue, verts: &[crate::cockpit::PanelV]) {
        if !verts.is_empty() && (verts.len() * std::mem::size_of::<crate::cockpit::PanelV>()) as u64 == self.scr_vb.size() {
            queue.write_buffer(&self.scr_vb, 0, bytemuck::cast_slice(verts));
        }
    }

    pub fn update_slots(&self, queue: &wgpu::Queue, slots: &[Slot]) {
        if slots.len() == self.slot_count {
            queue.write_buffer(&self.slot_buf, 0, bytemuck::cast_slice(slots));
        }
    }

    fn draw_range(&self, rp: &mut wgpu::RenderPass<'_>, r: std::ops::Range<usize>) {
        for d in &self.draws[r] {
            rp.set_bind_group(3, &self.mats[d.mat as usize], &[]);
            rp.draw_indexed(d.first..d.first + d.count, 0, 0..1);
        }
    }

    /// Opaque + alpha-tested geometry, then the live display quads, then blended glass. Needs groups 0 (globals) and 1 (aircraft matrix).
    pub fn draw(&self, rp: &mut wgpu::RenderPass<'_>, pipes: &DeckPipes, panel_pipe: &wgpu::RenderPipeline, panel_bg: &wgpu::BindGroup) -> u32 {
        rp.set_vertex_buffer(0, self.vb.slice(..));
        rp.set_index_buffer(self.ib.slice(..), wgpu::IndexFormat::Uint32);
        rp.set_pipeline(&pipes.opaque);
        rp.set_bind_group(2, &self.slot_bg, &[]);
        self.draw_range(rp, 0..self.opaque_n);
        if self.scr_n > 0 {
            rp.set_pipeline(panel_pipe);
            rp.set_bind_group(2, panel_bg, &[]);
            rp.set_vertex_buffer(0, self.scr_vb.slice(..));
            rp.set_index_buffer(self.scr_ib.slice(..), wgpu::IndexFormat::Uint32);
            rp.draw_indexed(0..self.scr_n, 0, 0..1);
        }
        if self.opaque_n < self.draws.len() {
            rp.set_vertex_buffer(0, self.vb.slice(..));
            rp.set_index_buffer(self.ib.slice(..), wgpu::IndexFormat::Uint32);
            rp.set_pipeline(&pipes.blend);
            rp.set_bind_group(2, &self.slot_bg, &[]);
            self.draw_range(rp, self.opaque_n..self.draws.len());
        }
        self.triangles
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mip_chain_sizes_and_average() {
        let img = Image { w: 4, h: 2, rgba: (0..4 * 2 * 4).map(|i| if i % 4 == 3 { 255 } else { 100 }).collect() };
        let (data, levels) = mip_chain(&img);
        assert_eq!(levels, 3);
        assert_eq!(data.len(), (4 * 2 + 2 * 1 + 1) * 4);
        assert_eq!(data[data.len() - 4], 100, "average of constant colour stays constant");
    }
}

#[cfg(test)]
mod shader_tests {
    /// The HD-deck shader must parse and validate (globals + deck.wgsl) - catches WGSL mistakes without needing a GPU.
    #[test]
    fn deck_wgsl_validates() {
        let src = format!("{}\n{}", include_str!("globals.wgsl"), include_str!("deck.wgsl"));
        let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&src)));
        let mut v = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all());
        v.validate(&module).unwrap_or_else(|e| panic!("{e:?}"));
        let names: Vec<_> = module.entry_points.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"vs_deck") && names.contains(&"fs_deck"));
    }
}
