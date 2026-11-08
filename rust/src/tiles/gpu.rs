//! GPU side of the tile system: one shared texture-array atlas (all tiles of the active style, with mips), the ground
//! page-table resources and the globe tile pipeline. Everything is allocated once; per frame the only work is a bounded
//! number of `write_texture` uploads (see [`TileAtlas::pump`]) and one small page-table write when it changed.

use super::decode::{mip_dim, mip_offset, MIPS, TILE_BYTES};
use super::globe_tiles::{GlobeV, MAX_GLOBE_VERTS};
use super::ground::{GroundPlan, GroundU, PT_H, PT_W};
use super::hub::{Decoded, TileHub};
use super::math::TILE_PX;
use bytemuck::{Pod, Zeroable};
use std::time::Instant;

pub const ATLAS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// Upper bound of atlas layers (VRAM = layers x 350 KB: 512 -> ~180 MB).
pub const MAX_LAYERS: u32 = 512;

pub struct TileAtlas {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub sampler: wgpu::Sampler,
    pub layers: u32,
    scratch: Vec<(u16, Decoded)>,
    /// CPU time of the last upload burst (ms) and the worst one seen
    pub last_ms: f32,
    pub worst_ms: f32,
    pub last_count: u32,
}

impl TileAtlas {
    /// Layer count to request / use for this device (`required_limits` must allow it, see `app.rs`).
    pub fn layers_for(limits: &wgpu::Limits) -> u32 {
        limits.max_texture_array_layers.min(MAX_LAYERS)
    }

    pub fn new(device: &wgpu::Device, layers: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("tile-atlas"),
            size: wgpu::Extent3d { width: TILE_PX as u32, height: TILE_PX as u32, depth_or_array_layers: layers },
            mip_level_count: MIPS as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: ATLAS_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("tile-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: 8,
            ..Default::default()
        });
        Self { texture, view, sampler, layers, scratch: Vec::with_capacity(16), last_ms: 0.0, worst_ms: 0.0, last_count: 0 }
    }

    /// Uploads at most a few decoded tiles (bounded bytes => bounded frame time). Call once per frame.
    pub fn pump(&mut self, queue: &wgpu::Queue, hub: &TileHub) -> u32 {
        let backlog = hub.stats().ready;
        let tiles = if backlog > 24 { 8 } else if backlog > 8 { 5 } else { 3 };
        hub.take_uploads(tiles * TILE_BYTES, &mut self.scratch);
        let t = Instant::now();
        let n = self.scratch.len() as u32;
        for (layer, d) in self.scratch.drain(..) {
            for m in 0..MIPS {
                let dim = mip_dim(m) as u32;
                let off = mip_offset(m);
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: m as u32, origin: wgpu::Origin3d { x: 0, y: 0, z: layer as u32 }, aspect: wgpu::TextureAspect::All },
                    &d.data[off..off + (dim * dim * 4) as usize],
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(dim * 4), rows_per_image: Some(dim) },
                    wgpu::Extent3d { width: dim, height: dim, depth_or_array_layers: 1 },
                );
            }
        }
        self.last_count = n;
        if n > 0 {
            self.last_ms = t.elapsed().as_secs_f32() * 1000.0;
            self.worst_ms = self.worst_ms.max(self.last_ms);
        } else {
            self.last_ms = 0.0;
        }
        n
    }
}

// ------------------------------------------------------------------------------------------------ ground

pub struct GroundGpu {
    pub bgl: wgpu::BindGroupLayout,
    pub bg: wgpu::BindGroup,
    pub pipe: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    table: wgpu::Texture,
}

const TV_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2];

/// Source of the satellite terrain shader module (globals + world + ground), also used by the shader validation test.
pub fn ground_shader_source() -> String {
    format!("{}\n{}\n{}", include_str!("../gfx/globals.wgsl"), include_str!("../gfx/world.wgsl"), include_str!("ground.wgsl"))
}

impl GroundGpu {
    #[allow(clippy::too_many_arguments)]
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, atlas: &TileAtlas, globals_bgl: &wgpu::BindGroupLayout, model_bgl: &wgpu::BindGroupLayout, terrain_stride: usize) -> Self {
        let both = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ground"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: both, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor { label: Some("ground-u"), size: std::mem::size_of::<GroundU>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let table = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ground-pages"),
            size: wgpu::Extent3d { width: PT_W as u32, height: PT_H as u32, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let table_view = table.create_view(&wgpu::TextureViewDescriptor::default());
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ground"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&table_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&atlas.view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&atlas.sampler) },
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ground"), source: wgpu::ShaderSource::Wgsl(ground_shader_source().into()) });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("ground"), bind_group_layouts: &[Some(globals_bgl), Some(model_bgl), Some(&bgl)], immediate_size: 0 });
        let vb = wgpu::VertexBufferLayout { array_stride: terrain_stride as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &TV_ATTRS };
        let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("terrain-sat"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_terrain_sat"), buffers: &[Some(vb)], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_terrain_sat"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: crate::gfx::DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Greater),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Self { bgl, bg, pipe, uniform, table }
    }

    /// Uniforms every frame (272 bytes, camera-relative tile origins); the page table only when it changed.
    pub fn upload(&self, queue: &wgpu::Queue, plan: &GroundPlan, table_changed: bool) {
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&plan.u));
        if table_changed {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.table, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                bytemuck::cast_slice(&plan.table),
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(PT_W as u32 * 16), rows_per_image: Some(PT_H as u32) },
                wgpu::Extent3d { width: PT_W as u32, height: PT_H as u32, depth_or_array_layers: 1 },
            );
        }
    }
}

// ------------------------------------------------------------------------------------------------ globe

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct GlobeU {
    pub size: [f32; 2],
    pub pad: [f32; 2],
    pub sun: [f32; 4],
}

pub struct GlobeGpu {
    pub pipe: wgpu::RenderPipeline,
    pub bg: wgpu::BindGroup,
    pub vb: wgpu::Buffer,
    pub uniform: wgpu::Buffer,
}

const GV_ATTRS: [wgpu::VertexAttribute; 5] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x2, 3 => Float32x3, 4 => Float32];

pub fn globe_shader_source() -> &'static str {
    include_str!("globe.wgsl")
}

impl GlobeGpu {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, atlas: &TileAtlas) -> Self {
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globe-tiles"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor { label: Some("globe-u"), size: std::mem::size_of::<GlobeU>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let vb = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globe-vb"),
            size: (MAX_GLOBE_VERTS * std::mem::size_of::<GlobeV>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globe-tiles"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&atlas.view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&atlas.sampler) },
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("globe-tiles"), source: wgpu::ShaderSource::Wgsl(globe_shader_source().into()) });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("globe-tiles"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let vbl = wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<GlobeV>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &GV_ATTRS };
        let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("globe-tiles"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_globe"), buffers: &[Some(vbl)], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_globe"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        Self { pipe, bg, vb, uniform }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(src: &str, name: &str) {
        let module = naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(src)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
            .validate(&module)
            .unwrap_or_else(|e| panic!("{name}: validation failed: {e:?}"));
    }

    #[test]
    fn ground_shader_validates() {
        validate(&ground_shader_source(), "ground");
    }

    #[test]
    fn globe_shader_validates() {
        validate(globe_shader_source(), "globe");
    }

    #[test]
    fn gpu_structs_match_shader_layouts() {
        assert_eq!(std::mem::size_of::<GroundU>(), 8 * 32 + 16);
        assert_eq!(std::mem::size_of::<GlobeV>(), 40);
        assert_eq!(std::mem::size_of::<GlobeU>(), 32);
        assert_eq!(TILE_BYTES, 349_524);
    }
}
