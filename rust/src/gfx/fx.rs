//! Extra GPU effects layered on the base renderer: volumetric cloud pass (depth-aware), rain / snow streaks, the 3D
//! flight deck and the render-to-texture display units. Every buffer is allocated once at start-up (fixed capacity).

use super::geom::MeshBuilder;
use super::ui::{self, Ui, MAX_UI_VERTS};
use super::{buf_init, uniform_entry, ModelU, ScreenU, DEPTH_FORMAT};
use crate::cockpit::{build_cockpit, build_screens, PanelV, ATLAS_SIZE};
use crate::game::Flight;
use wgpu::util::DeviceExt;

pub const MAX_DROPS: u32 = 9000;

pub struct Fx {
    depth_bgl: wgpu::BindGroupLayout,
    depth_bg: wgpu::BindGroup,
    cloud_pipe: wgpu::RenderPipeline,
    precip_pipe: wgpu::RenderPipeline,
    precip_buf: wgpu::Buffer,
    precip_bg: wgpu::BindGroup,
    precip_n: u32,
    panel_pipe: wgpu::RenderPipeline,
    panel_bg: wgpu::BindGroup,
    scr_vb: wgpu::Buffer,
    scr_ib: wgpu::Buffer,
    scr_n: u32,
    cp_vb: wgpu::Buffer,
    cp_ib: wgpu::Buffer,
    cp_n: u32,
    disp_view: wgpu::TextureView,
    disp_ui: Ui,
    disp_vb: wgpu::Buffer,
    disp_bg: wgpu::BindGroup,
    pub cloud_ms: f32,
}

fn depth_layout_entry() -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
        count: None,
    }
}

impl Fx {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        globals_bgl: &wgpu::BindGroupLayout,
        model_bgl: &wgpu::BindGroupLayout,
        ui_bgl: &wgpu::BindGroupLayout,
        atlas_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        depth_view: &wgpu::TextureView,
    ) -> Self {
        let globals = include_str!("globals.wgsl");
        let module = |label: &str, body: &str| device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(format!("{globals}\n{body}").into()) });
        let clouds = module("clouds", include_str!("clouds.wgsl"));
        let precip = module("precip", include_str!("precip.wgsl"));
        let panel = module("panel", include_str!("panel.wgsl"));

        // ---- cloud pass (reads scene depth) ----
        let depth_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("cloud_depth"), entries: &[depth_layout_entry()] });
        let depth_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("cloud_depth"), layout: &depth_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(depth_view) }] });
        let cloud_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("clouds"), bind_group_layouts: &[Some(globals_bgl), Some(&depth_bgl)], immediate_size: 0 });
        let premul = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let prim = wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() };
        let cloud_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("clouds"),
            layout: Some(&cloud_layout),
            vertex: wgpu::VertexState { module: &clouds, entry_point: Some("vs_clouds"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &clouds,
                entry_point: Some("fs_clouds"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(premul), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: prim,
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        // ---- precipitation ----
        let depth_test = |write: bool| wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(write),
            depth_compare: Some(wgpu::CompareFunction::Greater),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };
        let world_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("precip"), bind_group_layouts: &[Some(globals_bgl), Some(model_bgl)], immediate_size: 0 });
        let precip_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("precip"),
            layout: Some(&world_layout),
            vertex: wgpu::VertexState { module: &precip, entry_point: Some("vs_precip"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &precip,
                entry_point: Some("fs_precip"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: prim,
            depth_stencil: Some(depth_test(false)),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let precip_buf = buf_init(device, "precip", wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, std::mem::size_of::<ModelU>());
        let precip_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("precip"), layout: model_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: precip_buf.as_entire_binding() }] });

        // ---- display units: panel pipeline + render-to-texture atlas ----
        let disp_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("displays"),
            size: wgpu::Extent3d { width: ATLAS_SIZE, height: ATLAS_SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let disp_view = disp_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let disp_sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let panel_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("panel"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let panel_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("panel"),
            layout: &panel_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&disp_view) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&disp_sampler) }],
        });
        let panel_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("panel"), bind_group_layouts: &[Some(globals_bgl), Some(model_bgl), Some(&panel_bgl)], immediate_size: 0 });
        let attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2];
        let panel_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("panel"),
            layout: Some(&panel_layout),
            vertex: wgpu::VertexState {
                module: &panel,
                entry_point: Some("vs_panel"),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<PanelV>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &panel,
                entry_point: Some("fs_panel"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: prim,
            depth_stencil: Some(depth_test(true)),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let (mut sv, mut si) = (Vec::new(), Vec::new());
        build_screens(&mut sv, &mut si);
        let scr_vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("scr_vb"), contents: bytemuck::cast_slice(&sv), usage: wgpu::BufferUsages::VERTEX });
        let scr_ib = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("scr_ib"), contents: bytemuck::cast_slice(&si), usage: wgpu::BufferUsages::INDEX });
        let mut mb = MeshBuilder::default();
        build_cockpit(&mut mb);
        let cp_vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("cp_vb"), contents: bytemuck::cast_slice(&mb.v), usage: wgpu::BufferUsages::VERTEX });
        let cp_ib = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("cp_ib"), contents: bytemuck::cast_slice(&mb.i), usage: wgpu::BufferUsages::INDEX });

        // 2D batch that targets the atlas (own screen uniform = atlas size, shares the glyph atlas)
        let disp_screen = buf_init(device, "disp_screen", wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, std::mem::size_of::<ScreenU>());
        queue.write_buffer(&disp_screen, 0, bytemuck::bytes_of(&ScreenU { size: [ATLAS_SIZE as f32, ATLAS_SIZE as f32], pad: [0.0; 2] }));
        let disp_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("disp_ui"),
            layout: ui_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: disp_screen.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(atlas_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
            ],
        });
        let disp_vb = buf_init(device, "disp_vb", wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, MAX_UI_VERTS * std::mem::size_of::<ui::UiV>());
        let _ = uniform_entry; // (kept for symmetry with the base renderer's layouts)

        Self {
            depth_bgl,
            depth_bg,
            cloud_pipe,
            precip_pipe,
            precip_buf,
            precip_bg,
            precip_n: 0,
            panel_pipe,
            panel_bg,
            scr_vb,
            scr_ib,
            scr_n: si.len() as u32,
            cp_vb,
            cp_ib,
            cp_n: mb.i.len() as u32,
            disp_view,
            disp_ui: Ui::new(),
            disp_vb,
            disp_bg,
            cloud_ms: 0.0,
        }
    }

    /// The depth texture is recreated on resize: rebind it for the cloud pass.
    pub fn rebind_depth(&mut self, device: &wgpu::Device, depth_view: &wgpu::TextureView) {
        self.depth_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("cloud_depth"), layout: &self.depth_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(depth_view) }] });
    }

    /// Upload rain / snow parameters. `vel` = aircraft velocity (m/s).
    pub fn set_precip(&mut self, queue: &wgpu::Queue, vel: [f32; 3], intensity: f32, snow: bool) {
        let mut m = [[0.0f32; 4]; 4];
        m[0][0] = snow as i32 as f32;
        queue.write_buffer(&self.precip_buf, 0, bytemuck::bytes_of(&ModelU { m, tint: [vel[0], vel[1], vel[2], intensity] }));
        self.precip_n = if intensity > 0.01 { ((MAX_DROPS as f32) * if snow { 0.6 } else { 1.0 }) as u32 } else { 0 };
    }

    /// Draw the six display units into the atlas (their own render pass, before the main scene).
    pub fn render_displays(&mut self, enc: &mut wgpu::CommandEncoder, queue: &wgpu::Queue, ui_pipe: &wgpu::RenderPipeline, f: &Flight, time: f64) {
        self.disp_ui.begin(ATLAS_SIZE as f32, ATLAS_SIZE as f32);
        super::displays::draw_atlas(&mut self.disp_ui, f, time);
        self.disp_ui.end();
        queue.write_buffer(&self.disp_vb, 0, bytemuck::cast_slice(&self.disp_ui.verts));
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("displays"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.disp_view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.004, g: 0.006, b: 0.009, a: 1.0 }), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        rp.set_pipeline(ui_pipe);
        rp.set_bind_group(0, &self.disp_bg, &[]);
        rp.set_vertex_buffer(0, self.disp_vb.slice(..));
        let n = ATLAS_SIZE;
        for c in &self.disp_ui.cmds {
            match c.scissor {
                Some([x, y, sw, sh]) => {
                    let (x, y) = (x.min(n - 1), y.min(n - 1));
                    rp.set_scissor_rect(x, y, sw.min(n - x), sh.min(n - y));
                }
                None => rp.set_scissor_rect(0, 0, n, n),
            }
            rp.draw(c.start..c.start + c.count, 0..1);
        }
    }

    /// Flight deck + display quads (inside the main pass, aircraft model matrix bound at group 1).
    pub fn draw_cockpit(&self, rp: &mut wgpu::RenderPass<'_>, model_pipe: &wgpu::RenderPipeline) -> u32 {
        rp.set_pipeline(model_pipe);
        rp.set_vertex_buffer(0, self.cp_vb.slice(..));
        rp.set_index_buffer(self.cp_ib.slice(..), wgpu::IndexFormat::Uint32);
        rp.draw_indexed(0..self.cp_n, 0, 0..1);
        rp.set_pipeline(&self.panel_pipe);
        rp.set_bind_group(2, &self.panel_bg, &[]);
        rp.set_vertex_buffer(0, self.scr_vb.slice(..));
        rp.set_index_buffer(self.scr_ib.slice(..), wgpu::IndexFormat::Uint32);
        rp.draw_indexed(0..self.scr_n, 0, 0..1);
        (self.cp_n + self.scr_n) / 3
    }

    /// Rain / snow streaks (inside the main pass, after the opaque geometry). Needs group 0 bound; binds group 1.
    pub fn draw_precip(&self, rp: &mut wgpu::RenderPass<'_>) -> bool {
        if self.precip_n == 0 {
            return false;
        }
        rp.set_pipeline(&self.precip_pipe);
        rp.set_bind_group(1, &self.precip_bg, &[]);
        rp.draw(0..6, 0..self.precip_n);
        true
    }

    /// Volumetric cloud pass: full-screen ray-march limited by the scene depth, composited with premultiplied alpha.
    pub fn draw_clouds(&self, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, globals_bg: &wgpu::BindGroup) {
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clouds"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        rp.set_pipeline(&self.cloud_pipe);
        rp.set_bind_group(0, globals_bg, &[]);
        rp.set_bind_group(1, &self.depth_bg, &[]);
        rp.draw(0..3, 0..1);
    }
}
