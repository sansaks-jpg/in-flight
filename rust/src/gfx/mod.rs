//! wgpu renderer. Every GPU buffer is allocated once with a fixed capacity; per-frame work is `write_buffer` into those
//! buffers, so frame time is flat and memory use is constant (no leaks by construction).

pub mod deck_gpu;
pub mod displays;
pub mod efis;
pub mod fx;
pub mod geom;
pub mod ui;


use crate::clock::sun_position;
use crate::clouds::{self, Clouds};
use crate::precip;
use crate::game::Flight;
use geom::*;
use glam::{DVec3, Mat4, Quat, Vec3, Vec4};
use std::time::Instant;
use crate::tiles::globe_tiles::MAX_GLOBE_VERTS;
use crate::tiles::gpu::{GlobeGpu, GlobeU, GroundGpu, TileAtlas};
use crate::tiles::ground::GroundPlan;
use crate::tiles::{styles, TileHub};
use ui::{Ui, MAX_UI_VERTS};
use wgpu::util::DeviceExt;

pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const MAX_TREES: usize = 7000;
const MAX_BUILDINGS: usize = 3500;
const STATIC_VERTS: usize = 220_000;
const STATIC_IDX: usize = 520_000;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Globals {
    view_proj: [[f32; 4]; 4],
    inv_view_proj: [[f32; 4]; 4],
    cam_pos: [f32; 4],
    sun_dir: [f32; 4],
    sun_col: [f32; 4],
    amb: [f32; 4],
    fog: [f32; 4],
    zenith: [f32; 4],
    params: [f32; 4],
    cloud0: [f32; 4],
    cloud1: [f32; 4],
    env: [f32; 4],
    env2: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ModelU {
    m: [[f32; 4]; 4],
    tint: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ScreenU {
    size: [f32; 2],
    pad: [f32; 2],
}

pub struct Camera {
    pub pos: DVec3,
    pub fwd: Vec3,
    pub up: Vec3,
    pub fov_deg: f32,
    pub near: f32,
}

pub struct FrameParams<'a> {
    pub flight: Option<&'a Flight>,
    pub sys: Option<&'a crate::a320sys::A320Systems>,
    pub cam: Camera,
    pub utc: f64,
    pub time: f32,
    pub lat: f64,
    pub lon: f64,
    pub vis_km: f32,
    pub cloud_base: f32,
    pub cloud_cover: f32,
    pub show_aircraft: bool,
    /// draw the 3D flight deck + working display units (captain / panel views)
    pub cockpit: bool,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct FrameStats {
    pub terrain_ms: f32,
    /// CPU time of the satellite-tile work on the render thread (GPU upload burst + page-table planning)
    pub tile_ms: f32,
    pub scatter_ms: f32,
    pub ui_ms: f32,
    pub submit_ms: f32,
    pub rings_rebuilt: u32,
    pub draw_calls: u32,
    pub triangles: u32,
}

pub use crate::atmosphere::{sky_colors, sky_colors_ex, SkyColors};

/// Right-handed view matrix for a camera at the origin (camera-relative rendering).
pub fn view_matrix(fwd: Vec3, up: Vec3) -> Mat4 {
    let f = fwd.normalize();
    let s = f.cross(up).normalize();
    let u = s.cross(f);
    Mat4::from_cols(Vec4::new(s.x, u.x, -f.x, 0.0), Vec4::new(s.y, u.y, -f.y, 0.0), Vec4::new(s.z, u.z, -f.z, 0.0), Vec4::new(0.0, 0.0, 0.0, 1.0))
}

/// Infinite far plane, reversed depth (1 at the near plane, 0 at infinity): float32 depth keeps ~1e-7 relative
/// precision at every distance, so runway markings never z-fight even tens of kilometres away.
pub fn proj_infinite_reverse(fovy: f32, aspect: f32, near: f32) -> Mat4 {
    let f = 1.0 / (fovy * 0.5).tan();
    Mat4::from_cols(Vec4::new(f / aspect, 0.0, 0.0, 0.0), Vec4::new(0.0, f, 0.0, 0.0), Vec4::new(0.0, 0.0, 0.0, -1.0), Vec4::new(0.0, 0.0, near, 0.0))
}

pub struct Renderer {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub format: wgpu::TextureFormat,
    pub size: (u32, u32),
    depth_view: wgpu::TextureView,
    globals_buf: wgpu::Buffer,
    globals_bg: wgpu::BindGroup,
    model_buf: wgpu::Buffer,
    model_bg: wgpu::BindGroup,
    screen_buf: wgpu::Buffer,
    ui_bg: wgpu::BindGroup,
    sky_pipe: wgpu::RenderPipeline,
    terrain_pipe: wgpu::RenderPipeline,
    water_pipe: wgpu::RenderPipeline,
    mesh_pipe: wgpu::RenderPipeline,
    model_pipe: wgpu::RenderPipeline,
    inst_pipe: wgpu::RenderPipeline,
    ui_pipe: wgpu::RenderPipeline,
    ring_vb: Vec<wgpu::Buffer>,
    ring_ib: [wgpu::Buffer; 2],
    ring_icount: [u32; 2],
    ring_origin: [Option<(i64, i64)>; LEVELS],
    ring_cpu: Vec<TerrainV>,
    ring_scratch: Vec<f32>,
    static_vb: wgpu::Buffer,
    static_ib: wgpu::Buffer,
    static_icount: u32,
    static_key: String,
    static_mb: MeshBuilder,
    ac_vb: wgpu::Buffer,
    ac_ib: wgpu::Buffer,
    ac_body: u32,
    ac_total: u32,
    tree_mesh: (wgpu::Buffer, wgpu::Buffer, u32),
    bldg_mesh: (wgpu::Buffer, wgpu::Buffer, u32),
    tree_inst: wgpu::Buffer,
    bldg_inst: wgpu::Buffer,
    tree_cpu: Vec<Inst>,
    bldg_cpu: Vec<Inst>,
    scatter_center: Option<(f64, f64)>,
    pub ui: Ui,
    ui_vb: wgpu::Buffer,
    pub stats: FrameStats,
    fx: fx::Fx,
    tiles: Option<TileHub>,
    atlas: Option<TileAtlas>,
    ground_gpu: Option<GroundGpu>,
    ground_plan: GroundPlan,
    globe_gpu: Option<GlobeGpu>,
}

/// Device limits to request: the satellite atlas is a texture array and wants more than the 256-layer default.
pub fn tile_limits(adapter: &wgpu::Adapter) -> wgpu::Limits {
    let mut l = wgpu::Limits::default();
    l.max_texture_array_layers = adapter.limits().max_texture_array_layers.min(crate::tiles::gpu::MAX_LAYERS).max(l.max_texture_array_layers);
    l
}

fn buf_init(device: &wgpu::Device, label: &str, usage: wgpu::BufferUsages, size: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size as u64, usage, mapped_at_creation: false })
}

fn depth_view(device: &wgpu::Device, w: u32, h: u32) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("depth"),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

const V3_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4];
const TV_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2];
const INST_ATTRS: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![3 => Float32x3, 4 => Float32, 5 => Float32x3, 6 => Float32];
const UI_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4];

fn layout<'a>(stride: usize, mode: wgpu::VertexStepMode, attrs: &'a [wgpu::VertexAttribute]) -> wgpu::VertexBufferLayout<'a> {
    wgpu::VertexBufferLayout { array_stride: stride as u64, step_mode: mode, attributes: attrs }
}

fn uniform_entry(binding: u32, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: vis,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

impl Renderer {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat, w: u32, h: u32) -> Self {
        let both = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let globals_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("globals"), entries: &[uniform_entry(0, both)] });
        let model_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("model"), entries: &[uniform_entry(0, both)] });
        let ui_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ui"),
            entries: &[
                uniform_entry(0, wgpu::ShaderStages::VERTEX),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let globals_buf = buf_init(&device, "globals", wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, std::mem::size_of::<Globals>());
        let model_buf = buf_init(&device, "model", wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, std::mem::size_of::<ModelU>());
        let screen_buf = buf_init(&device, "screen", wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, std::mem::size_of::<ScreenU>());
        let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("globals"), layout: &globals_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: globals_buf.as_entire_binding() }] });
        let model_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("model"), layout: &model_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: model_buf.as_entire_binding() }] });

        // ---- UI atlas ----
        let atlas_px = ui::build_atlas();
        let atlas = device.create_texture_with_data(
            &queue,
            &wgpu::TextureDescriptor {
                label: Some("atlas"),
                size: wgpu::Extent3d { width: ui::ATLAS_W as u32, height: ui::ATLAS_H as u32, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &atlas_px,
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let ui_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ui"),
            layout: &ui_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: screen_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&atlas_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });

        // ---- pipelines ----
        let world_src = format!("{}\n{}", include_str!("globals.wgsl"), include_str!("world.wgsl"));
        let world = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("world"), source: wgpu::ShaderSource::Wgsl(world_src.into()) });
        let sky = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("sky"), source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", include_str!("globals.wgsl"), include_str!("sky.wgsl")).into()) });
        let uis = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ui"), source: wgpu::ShaderSource::Wgsl(include_str!("ui.wgsl").into()) });
        let world_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("world"), bind_group_layouts: &[Some(&globals_bgl), Some(&model_bgl)], immediate_size: 0 });
        let sky_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("sky"), bind_group_layouts: &[Some(&globals_bgl)], immediate_size: 0 });
        let ui_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("ui"), bind_group_layouts: &[Some(&ui_bgl)], immediate_size: 0 });

        let depth = |write: bool, cmp: wgpu::CompareFunction| wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(write),
            depth_compare: Some(cmp),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };
        let prim = wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() };
        let opaque = [Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })];
        let blend = [Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })];
        let mk = |label: &str, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, vs: &str, fs: &str, bufs: &[wgpu::VertexBufferLayout], ds: Option<wgpu::DepthStencilState>, targets: &[Option<wgpu::ColorTargetState>]| {
            let bufs: Vec<Option<wgpu::VertexBufferLayout>> = bufs.iter().cloned().map(Some).collect();
            let bufs = &bufs[..];
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                vertex: wgpu::VertexState { module, entry_point: Some(vs), buffers: bufs, compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState { module, entry_point: Some(fs), targets, compilation_options: Default::default() }),
                primitive: prim,
                depth_stencil: ds,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let sky_pipe = mk("sky", &sky_layout, &sky, "vs_sky", "fs_sky", &[], Some(depth(false, wgpu::CompareFunction::Always)), &opaque);
        let terrain_pipe = mk("terrain", &world_layout, &world, "vs_terrain", "fs_terrain", &[layout(std::mem::size_of::<TerrainV>(), wgpu::VertexStepMode::Vertex, &TV_ATTRS)], Some(depth(true, wgpu::CompareFunction::Greater)), &opaque);
        let water_pipe = mk("water", &world_layout, &world, "vs_water", "fs_water", &[], Some(depth(true, wgpu::CompareFunction::Greater)), &opaque);
        let v3l = || layout(std::mem::size_of::<V3>(), wgpu::VertexStepMode::Vertex, &V3_ATTRS);
        let mesh_pipe = mk("mesh", &world_layout, &world, "vs_mesh", "fs_mesh", &[v3l()], Some(depth(true, wgpu::CompareFunction::Greater)), &opaque);
        let model_pipe = mk("model", &world_layout, &world, "vs_model", "fs_mesh", &[v3l()], Some(depth(true, wgpu::CompareFunction::Greater)), &opaque);
        let inst_pipe = mk("inst", &world_layout, &world, "vs_inst", "fs_mesh", &[v3l(), layout(std::mem::size_of::<Inst>(), wgpu::VertexStepMode::Instance, &INST_ATTRS)], Some(depth(true, wgpu::CompareFunction::Greater)), &opaque);
        let ui_pipe = mk("ui", &ui_layout, &uis, "vs_ui", "fs_ui", &[layout(std::mem::size_of::<ui::UiV>(), wgpu::VertexStepMode::Vertex, &UI_ATTRS)], None, &blend);

        // ---- fixed-capacity geometry buffers ----
        let vb_usage = wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST;
        let ib_usage = wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST;
        let ring_vb = (0..LEVELS).map(|l| buf_init(&device, &format!("ring{l}"), vb_usage, RING_VERTS * std::mem::size_of::<TerrainV>())).collect();
        let (full, holed) = (ring_indices(false), ring_indices(true));
        let mk_ib = |d: &[u32], label: &str| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: bytemuck::cast_slice(d), usage: wgpu::BufferUsages::INDEX });
        let ring_ib = [mk_ib(&full, "ring_ib_full"), mk_ib(&holed, "ring_ib_hole")];
        let static_vb = buf_init(&device, "static_vb", vb_usage, STATIC_VERTS * std::mem::size_of::<V3>());
        let static_ib = buf_init(&device, "static_ib", ib_usage, STATIC_IDX * 4);

        let mut mb = MeshBuilder::default();
        let (ac_body, ac_total) = build_a320(&mut mb);
        let ac_vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("a320_vb"), contents: bytemuck::cast_slice(&mb.v), usage: wgpu::BufferUsages::VERTEX });
        let ac_ib = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("a320_ib"), contents: bytemuck::cast_slice(&mb.i), usage: wgpu::BufferUsages::INDEX });
        let small = |f: fn(&mut MeshBuilder), name: &str| {
            let mut m = MeshBuilder::default();
            f(&mut m);
            (
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(name), contents: bytemuck::cast_slice(&m.v), usage: wgpu::BufferUsages::VERTEX }),
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(name), contents: bytemuck::cast_slice(&m.i), usage: wgpu::BufferUsages::INDEX }),
                m.i.len() as u32,
            )
        };
        let tree_mesh = small(build_tree, "tree");
        let bldg_mesh = small(build_unit_box, "bldg");
        let tree_inst = buf_init(&device, "tree_inst", vb_usage, MAX_TREES * std::mem::size_of::<Inst>());
        let bldg_inst = buf_init(&device, "bldg_inst", vb_usage, MAX_BUILDINGS * std::mem::size_of::<Inst>());
        let ui_vb = buf_init(&device, "ui_vb", vb_usage, MAX_UI_VERTS * std::mem::size_of::<ui::UiV>());

        let mut static_mb = MeshBuilder::default();
        static_mb.v.reserve(STATIC_VERTS);
        static_mb.i.reserve(STATIC_IDX);
        let depth_view = depth_view(&device, w, h);
        queue.write_buffer(&screen_buf, 0, bytemuck::bytes_of(&ScreenU { size: [w as f32, h as f32], pad: [0.0; 2] }));
        let fx = fx::Fx::new(&device, &queue, format, &globals_bgl, &model_bgl, &ui_bgl, &atlas_view, &sampler, &depth_view);
        // ---- satellite tiles (INFLIGHT_NO_TILES=1 disables the whole subsystem) ----
        let (tiles, tile_atlas, ground_gpu, globe_gpu) = if std::env::var_os("INFLIGHT_NO_TILES").is_some() {
            (None, None, None, None)
        } else {
            let layers = TileAtlas::layers_for(&device.limits());
            let tile_atlas = TileAtlas::new(&device, layers);
            let hub = TileHub::new(layers as usize);
            let gg = GroundGpu::new(&device, format, &tile_atlas, &globals_bgl, &model_bgl, std::mem::size_of::<TerrainV>());
            let globe = GlobeGpu::new(&device, format, &tile_atlas);
            (Some(hub), Some(tile_atlas), Some(gg), Some(globe))
        };
        let mut ui_state = Ui::new();
        ui_state.tiles = tiles.clone();
        Self {
            device,
            queue,
            format,
            size: (w, h),
            depth_view,
            globals_buf,
            globals_bg,
            model_buf,
            model_bg,
            screen_buf,
            ui_bg,
            sky_pipe,
            terrain_pipe,
            water_pipe,
            mesh_pipe,
            model_pipe,
            inst_pipe,
            ui_pipe,
            ring_vb,
            ring_ib,
            ring_icount: [full.len() as u32, holed.len() as u32],
            ring_origin: [None; LEVELS],
            ring_cpu: Vec::with_capacity(RING_VERTS),
            ring_scratch: Vec::with_capacity((RING_N + 3) * (RING_N + 3)),
            static_vb,
            static_ib,
            static_icount: 0,
            static_key: String::new(),
            static_mb,
            ac_vb,
            ac_ib,
            ac_body,
            ac_total,
            tree_mesh,
            bldg_mesh,
            tree_inst,
            bldg_inst,
            tree_cpu: Vec::with_capacity(MAX_TREES),
            bldg_cpu: Vec::with_capacity(MAX_BUILDINGS),
            scatter_center: None,
            ui: ui_state,
            ui_vb,
            stats: FrameStats::default(),
            fx,
            tiles,
            atlas: tile_atlas,
            ground_gpu,
            ground_plan: GroundPlan::new(),
            globe_gpu,
        }
    }

    /// Tile streaming hub (None when disabled with `INFLIGHT_NO_TILES`).
    pub fn tiles(&self) -> Option<&TileHub> {
        self.tiles.as_ref()
    }

    /// Worst CPU time (ms) one atlas upload burst has taken on the render thread.
    pub fn tile_upload_worst_ms(&self) -> f32 {
        self.atlas.as_ref().map_or(0.0, |a| a.worst_ms)
    }

    /// Upload the downloaded HD flight deck (see `deck::Deck::gpu_mesh`).
    pub fn load_deck(&mut self, mesh: &crate::deck::GpuMesh, images: &[Option<crate::glb::Image>]) {
        self.fx.load_deck(&self.device, &self.queue, mesh, images);
    }

    pub fn unload_deck(&mut self) {
        self.fx.unload_deck();
    }

    pub fn deck_loaded(&self) -> bool {
        self.fx.has_deck()
    }

    pub fn set_deck_screens(&self, verts: &[crate::cockpit::PanelV]) {
        self.fx.set_deck_screens(&self.queue, verts);
    }

    pub fn set_deck_slots(&self, slots: &[crate::deck::Slot]) {
        self.fx.set_deck_slots(&self.queue, slots);
    }


    pub fn resize(&mut self, w: u32, h: u32) {
        let (w, h) = (w.max(1), h.max(1));
        if (w, h) == self.size {
            return;
        }
        self.size = (w, h);
        self.depth_view = depth_view(&self.device, w, h);
        self.fx.rebind_depth(&self.device, &self.depth_view);
        self.queue.write_buffer(&self.screen_buf, 0, bytemuck::bytes_of(&ScreenU { size: [w as f32, h as f32], pad: [0.0; 2] }));
    }

    /// Rebuild the static airport meshes (runways, markings, lights, buildings) when the flight changes.
    pub fn ensure_airports(&mut self, f: &Flight) {
        let key = format!("{}>{}{}", f.dep.icao, f.arr.icao, if f.terrain.flat { "#sat" } else { "" });
        if key == self.static_key {
            return;
        }
        self.static_key = key;
        self.static_mb.clear();
        let mut seen: [&str; 2] = ["", ""];
        for (k, ap) in [&f.dep, &f.arr].into_iter().enumerate() {
            if k == 1 && ap.icao == f.dep.icao {
                break;
            }
            seen[k] = &ap.icao;
            for rw in &ap.runways {
                let [a, b] = rw.ends();
                if self.static_mb.v.len() + 12_000 > STATIC_VERTS {
                    break;
                }
                add_runway(&mut self.static_mb, &f.proj, ap.elev, &a, &b, a.paved, rw.lit);
            }
            if let Some(e) = ap.best_end(f.weather.wind_from_deg) {
                add_airport_buildings(&mut self.static_mb, &f.proj, ap, &e);
            }
        }
        let nv = self.static_mb.v.len().min(STATIC_VERTS);
        let ni = self.static_mb.i.len().min(STATIC_IDX);
        self.queue.write_buffer(&self.static_vb, 0, bytemuck::cast_slice(&self.static_mb.v[..nv]));
        self.queue.write_buffer(&self.static_ib, 0, bytemuck::cast_slice(&self.static_mb.i[..ni]));
        self.static_icount = (ni - ni % 3) as u32;
        // new flight: rings and scatter must be rebuilt for the new terrain
        self.ring_origin = [None; LEVELS];
        self.scatter_center = None;
    }

    fn update_terrain(&mut self, f: &Flight, cam: DVec3, budget: usize) -> u32 {
        let mut pending: [usize; LEVELS] = [0; LEVELS];
        let mut np = 0;
        let mut forced = false;
        for l in 0..LEVELS {
            let org = snapped_origin(l, cam.x, cam.z);
            if self.ring_origin[l] != Some(org) {
                pending[np] = l;
                np += 1;
                if self.ring_origin[l].is_none() {
                    forced = true;
                }
            }
        }
        let n = if forced { np } else { np.min(budget) };
        for &l in &pending[..n] {
            let org = snapped_origin(l, cam.x, cam.z);
            fill_ring(&f.terrain, l, org, &mut self.ring_scratch, &mut self.ring_cpu);
            self.queue.write_buffer(&self.ring_vb[l], 0, bytemuck::cast_slice(&self.ring_cpu));
            self.ring_origin[l] = Some(org);
        }
        n as u32
    }

    fn update_scatter(&mut self, f: &Flight, cam: DVec3, sat: bool) {
        if sat {
            // real imagery already shows the real forests and buildings: no procedural scatter on top of it
            if !self.tree_cpu.is_empty() || !self.bldg_cpu.is_empty() {
                self.tree_cpu.clear();
                self.bldg_cpu.clear();
            }
            self.scatter_center = None;
            return;
        }
        let low = cam.y - f.fm.ground_h < 2500.0;
        let moved = self.scatter_center.map_or(true, |(x, z)| (cam.x - x).hypot(cam.z - z) > 110.0);
        if !moved {
            return;
        }
        self.scatter_center = Some((cam.x, cam.z));
        if low {
            gen_trees(&f.terrain, cam.x, cam.z, 1800.0, &mut self.tree_cpu, MAX_TREES);
            gen_buildings(&f.terrain, cam.x, cam.z, 3200.0, &mut self.bldg_cpu, MAX_BUILDINGS);
        } else {
            self.tree_cpu.clear();
            self.bldg_cpu.clear();
        }
        self.queue.write_buffer(&self.tree_inst, 0, bytemuck::cast_slice(&self.tree_cpu));
        self.queue.write_buffer(&self.bldg_inst, 0, bytemuck::cast_slice(&self.bldg_cpu));
    }

    /// Render one frame into `target`. `build_ui` fills the 2D overlay.
    pub fn render(&mut self, target: &wgpu::TextureView, p: &FrameParams, build_ui: &mut dyn FnMut(&mut Ui)) {
        let mut st = FrameStats::default();
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        // ---- satellite tiles: bounded GPU uploads of whatever the loader threads finished (never blocks) ----
        let t_tiles = Instant::now();
        if let (Some(hub), Some(atlas)) = (&self.tiles, &mut self.atlas) {
            hub.next_frame();
            atlas.pump(&self.queue, hub);
        }
        st.tile_ms = t_tiles.elapsed().as_secs_f32() * 1000.0;
        let sat = self.ground_gpu.is_some() && p.flight.is_some_and(|f| f.terrain.flat);
        let water_y = match (sat, p.flight) {
            (true, Some(f)) => f.terrain.height(p.cam.pos.x, p.cam.pos.z) as f32,
            _ => 0.0,
        };
        // ---- globals ----
        let (el, az) = sun_position(p.utc, p.lat, p.lon);
        let (elr, azr) = ((el as f32).to_radians(), (az as f32).to_radians());
        let sun = Vec3::new(azr.sin() * elr.cos(), elr.sin(), -azr.cos() * elr.cos());
        let moon = crate::atmosphere::moon_illumination(p.utc) as f32;
        let mut sc = sky_colors_ex(el as f32, p.cloud_cover, moon);
        let view = view_matrix(p.cam.fwd, p.cam.up);
        let proj = proj_infinite_reverse(p.cam.fov_deg.to_radians(), w / h, p.cam.near);
        let vp = proj * view;
        let vis = (p.vis_km * 1000.0).max(2000.0);
        // ---- weather: clouds, precipitation, lightning ----
        let (clouds, drift, pr) = match p.flight {
            Some(f) => (Clouds::from_weather(&f.weather), clouds::drift(&f.weather, p.time as f64), precip::state(&f.weather, p.time as f64, p.cam.pos.y)),
            None => (Clouds::default(), (0.0, 0.0), precip::PrecipState::default()),
        };
        // inside a cloud the world fades to the cloud's own grey; rain adds extinction; lightning brightens everything
        let in_cloud = {
            let d = clouds.at(p.cam.pos, drift);
            (d / 0.35).clamp(0.0, 1.0)
        };
        let cloud_grey = (sc.ambient * 1.7 + sc.sun_light * 0.30).min(Vec3::splat(0.95));
        let flash_col = Vec3::new(0.62, 0.68, 1.0);
        sc.ambient += flash_col * pr.flash * 0.35;
        let mut fog_rgb = sc.horizon.lerp(cloud_grey, in_cloud) + flash_col * pr.flash * 0.18;
        fog_rgb = fog_rgb.lerp(fog_rgb * 0.82, (pr.intensity * 0.6).min(0.6));
        let fog_a = (1.0 / (vis * 1.35)) * (1.0 - in_cloud) + in_cloud / 140.0 + pr.extinction;
        let clouds_on = clouds.layers.iter().any(|l| l.cover > 0.0);
        let g = Globals {
            view_proj: vp.to_cols_array_2d(),
            inv_view_proj: vp.inverse().to_cols_array_2d(),
            cam_pos: [p.cam.pos.x as f32, p.cam.pos.y as f32, p.cam.pos.z as f32, p.time],
            sun_dir: [sun.x, sun.y, sun.z, 0.0],
            sun_col: [sc.sun_light.x, sc.sun_light.y, sc.sun_light.z, el as f32],
            amb: [sc.ambient.x, sc.ambient.y, sc.ambient.z, sc.night],
            fog: [fog_rgb.x, fog_rgb.y, fog_rgb.z, fog_a],
            zenith: [sc.zenith.x, sc.zenith.y, sc.zenith.z, 0.0],
            params: [p.cloud_base, p.cloud_cover, pr.flash, w / h],
            cloud0: [clouds.layers[0].base, clouds.layers[0].top, clouds.layers[0].cover, clouds.layers[0].sigma],
            cloud1: [clouds.layers[1].base, clouds.layers[1].top, clouds.layers[1].cover, clouds.layers[1].sigma],
            env: [drift.0, drift.1, pr.intensity, pr.snow as i32 as f32],
            env2: [pr.bolt_az, in_cloud, pr.wet, water_y],
        };
        self.queue.write_buffer(&self.globals_buf, 0, bytemuck::bytes_of(&g));

        // ---- CPU-side world updates ----
        if let Some(f) = p.flight {
            let t0 = Instant::now();
            self.ensure_airports(f);
            st.rings_rebuilt = self.update_terrain(f, p.cam.pos, 2);
            st.terrain_ms = t0.elapsed().as_secs_f32() * 1000.0;
            if let (true, Some(hub), Some(gg)) = (sat, &self.tiles, &self.ground_gpu) {
                let t = Instant::now();
                let changed = self.ground_plan.update(hub, &f.proj, &self.ring_origin, (p.cam.pos.x, p.cam.pos.z), hub.now());
                self.ground_plan.touch(hub);
                gg.upload(&self.queue, &self.ground_plan, changed);
                st.tile_ms += t.elapsed().as_secs_f32() * 1000.0;
            }
            let t1 = Instant::now();
            self.update_scatter(f, p.cam.pos, sat);
            st.scatter_ms = t1.elapsed().as_secs_f32() * 1000.0;
            // aircraft model matrix (camera-relative)
            let q = f.fm.quat;
            let v = f.fm.vel;
            self.fx.set_precip(&self.queue, [v.x as f32, v.y as f32, v.z as f32], pr.intensity, pr.snow);
            let rot = Mat4::from_quat(Quat::from_xyzw(q.x as f32, q.y as f32, q.z as f32, q.w as f32));
            let rel = (f.fm.pos - p.cam.pos).as_vec3();
            let m = Mat4::from_translation(rel) * rot;
            self.queue.write_buffer(&self.model_buf, 0, bytemuck::bytes_of(&ModelU { m: m.to_cols_array_2d(), tint: [1.0; 4] }));
        }
        // ---- UI ----
        let t2 = Instant::now();
        self.ui.begin(w, h);
        build_ui(&mut self.ui);
        if let (true, Some(hub)) = (sat, &self.tiles) {
            // provider attribution (licence requirement) while satellite ground is on screen
            self.ui.text(8.0, h - (h / 60.0).clamp(11.0, 18.0) - 4.0, (h / 60.0).clamp(10.0, 16.0), [1.0, 1.0, 1.0, 0.55], styles::style(hub.style()).attribution);
        }
        self.ui.end();
        if let Some(gg) = &self.globe_gpu {
            if !self.ui.gverts.is_empty() {
                let n = self.ui.gverts.len().min(MAX_GLOBE_VERTS);
                self.queue.write_buffer(&gg.vb, 0, bytemuck::cast_slice(&self.ui.gverts[..n]));
                self.queue.write_buffer(&gg.uniform, 0, bytemuck::bytes_of(&GlobeU { size: [w, h], pad: [0.0; 2], sun: self.ui.globe_sun }));
            }
        }
        self.queue.write_buffer(&self.ui_vb, 0, bytemuck::cast_slice(&self.ui.verts));
        st.ui_ms = t2.elapsed().as_secs_f32() * 1000.0;

        // ---- encode ----
        let t3 = Instant::now();
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        if let (true, Some(f)) = (p.cockpit, p.flight) {
            let dflt;
            let sys = match p.sys {
                Some(s) => s,
                None => {
                    dflt = crate::a320sys::A320Systems::default();
                    &dflt
                }
            };
            self.fx.render_displays(&mut enc, &self.queue, &self.ui_pipe, f, sys, p.time as f64);
        }
        {
            let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            rp.set_pipeline(&self.sky_pipe);
            rp.set_bind_group(0, &self.globals_bg, &[]);
            rp.draw(0..3, 0..1);
            st.draw_calls += 1;
            if let Some(_f) = p.flight {
                rp.set_bind_group(0, &self.globals_bg, &[]);
                rp.set_bind_group(1, &self.model_bg, &[]);
                match (sat, &self.ground_gpu) {
                    (true, Some(gg)) => {
                        rp.set_pipeline(&gg.pipe);
                        rp.set_bind_group(2, &gg.bg, &[]);
                    }
                    _ => rp.set_pipeline(&self.terrain_pipe),
                }
                for l in 0..LEVELS {
                    if self.ring_origin[l].is_some() {
                        let k = if l == 0 { 0 } else { 1 };
                        rp.set_vertex_buffer(0, self.ring_vb[l].slice(..));
                        rp.set_index_buffer(self.ring_ib[k].slice(..), wgpu::IndexFormat::Uint32);
                        // the instance index carries the clipmap level into the satellite shader (page-table row)
                        rp.draw_indexed(0..self.ring_icount[k], 0, l as u32..l as u32 + 1);
                        st.draw_calls += 1;
                        st.triangles += self.ring_icount[k] / 3;
                    }
                }
                rp.set_pipeline(&self.water_pipe);
                rp.draw(0..6, 0..1);
                st.draw_calls += 1;
                if self.static_icount > 0 {
                    rp.set_pipeline(&self.mesh_pipe);
                    rp.set_vertex_buffer(0, self.static_vb.slice(..));
                    rp.set_index_buffer(self.static_ib.slice(..), wgpu::IndexFormat::Uint32);
                    rp.draw_indexed(0..self.static_icount, 0, 0..1);
                    st.draw_calls += 1;
                    st.triangles += self.static_icount / 3;
                }
                rp.set_pipeline(&self.inst_pipe);
                for (mesh, inst, n) in [(&self.tree_mesh, &self.tree_inst, self.tree_cpu.len()), (&self.bldg_mesh, &self.bldg_inst, self.bldg_cpu.len())] {
                    if n > 0 {
                        rp.set_vertex_buffer(0, mesh.0.slice(..));
                        rp.set_vertex_buffer(1, inst.slice(..));
                        rp.set_index_buffer(mesh.1.slice(..), wgpu::IndexFormat::Uint32);
                        rp.draw_indexed(0..mesh.2, 0, 0..n as u32);
                        st.draw_calls += 1;
                        st.triangles += mesh.2 / 3 * n as u32;
                    }
                }
                if p.show_aircraft {
                    rp.set_pipeline(&self.model_pipe);
                    rp.set_vertex_buffer(0, self.ac_vb.slice(..));
                    rp.set_index_buffer(self.ac_ib.slice(..), wgpu::IndexFormat::Uint32);
                    let gear_up = p.flight.is_some_and(|f| f.fm.gear_pos < 0.5);
                    rp.draw_indexed(0..if gear_up { self.ac_body } else { self.ac_total }, 0, 0..1);
                    st.draw_calls += 1;
                    st.triangles += self.ac_total / 3;
                }
                if p.cockpit {
                    st.triangles += self.fx.draw_cockpit(&mut rp, &self.model_pipe);
                    st.draw_calls += 2;
                }
                if self.fx.draw_precip(&mut rp) {
                    st.draw_calls += 1;
                }
            }
        }
        // ---- volumetric clouds (depth-aware full-screen ray-march) ----
        if clouds_on {
            let tc = Instant::now();
            self.fx.draw_clouds(&mut enc, target, &self.globals_bg);
            self.fx.cloud_ms = tc.elapsed().as_secs_f32() * 1000.0;
            st.draw_calls += 1;
        }
        // ---- UI overlay (own pass, no depth) ----
        {
            let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ui"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            rp.set_pipeline(&self.ui_pipe);
            rp.set_bind_group(0, &self.ui_bg, &[]);
            rp.set_vertex_buffer(0, self.ui_vb.slice(..));
            let mut in_globe = false;
            for c in &self.ui.cmds {
                if c.globe {
                    // textured globe tiles: own pipeline / vertex buffer, same scissor, same draw order as the 2D batch
                    let Some(gg) = &self.globe_gpu else { continue };
                    if c.start as usize + c.count as usize > MAX_GLOBE_VERTS {
                        continue;
                    }
                    if let Some([x, y, sw, sh]) = c.scissor {
                        rp.set_scissor_rect(x.min(self.size.0 - 1), y.min(self.size.1 - 1), sw.min(self.size.0 - x.min(self.size.0 - 1)), sh.min(self.size.1 - y.min(self.size.1 - 1)));
                    } else {
                        rp.set_scissor_rect(0, 0, self.size.0, self.size.1);
                    }
                    rp.set_pipeline(&gg.pipe);
                    rp.set_bind_group(0, &gg.bg, &[]);
                    rp.set_vertex_buffer(0, gg.vb.slice(..));
                    rp.draw(c.start..c.start + c.count, 0..1);
                    st.draw_calls += 1;
                    in_globe = true;
                    continue;
                }
                if in_globe {
                    rp.set_pipeline(&self.ui_pipe);
                    rp.set_bind_group(0, &self.ui_bg, &[]);
                    rp.set_vertex_buffer(0, self.ui_vb.slice(..));
                    in_globe = false;
                }
                match c.scissor {
                    Some([x, y, sw, sh]) => rp.set_scissor_rect(x.min(self.size.0 - 1), y.min(self.size.1 - 1), sw.min(self.size.0 - x.min(self.size.0 - 1)), sh.min(self.size.1 - y.min(self.size.1 - 1))),
                    None => rp.set_scissor_rect(0, 0, self.size.0, self.size.1),
                }
                rp.draw(c.start..c.start + c.count, 0..1);
                st.draw_calls += 1;
            }
        }
        self.queue.submit(std::iter::once(enc.finish()));
        st.submit_ms = t3.elapsed().as_secs_f32() * 1000.0;
        self.stats = st;
    }
}

// ---------------------------------------------------------------- headless / offscreen support

/// Offscreen render target with CPU read-back (used by the screenshot tool and the GPU soak test).
pub struct Offscreen {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    readback: wgpu::Buffer,
    pub w: u32,
    pub h: u32,
    bpr: u32,
}

/// Create a renderer without a window (software or hardware adapter, whichever wgpu finds).
pub fn new_headless(w: u32, h: u32) -> Result<(Renderer, Offscreen, String), String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: true,
    }))
    .map_err(|e| format!("no adapter: {e}"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("headless"), required_limits: tile_limits(&adapter), ..Default::default() })).map_err(|e| format!("device: {e}"))?;
    let format = wgpu::TextureFormat::Rgba8UnormSrgb;
    let renderer = Renderer::new(device, queue, format, w, h);
    let off = Offscreen::new(&renderer.device, format, w, h);
    Ok((renderer, off, format!("{} ({:?})", info.name, info.backend)))
}

impl Offscreen {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, w: u32, h: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("offscreen"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bpr = (w * 4).div_ceil(256) * 256;
        let readback = device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (bpr * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        Self { texture, view, readback, w, h, bpr }
    }

    /// Copy the rendered frame back as tightly packed RGBA8 into `out`.
    pub fn read_rgba(&self, r: &Renderer, out: &mut Vec<u8>) {
        let mut enc = r.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &self.readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(self.bpr), rows_per_image: Some(self.h) } },
            wgpu::Extent3d { width: self.w, height: self.h, depth_or_array_layers: 1 },
        );
        r.queue.submit(std::iter::once(enc.finish()));
        let slice = self.readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        let _ = r.device.poll(wgpu::PollType::wait_indefinitely());
        {
            let data = slice.get_mapped_range().expect("buffer is mapped");
            out.clear();
            for y in 0..self.h as usize {
                let row = &data[y * self.bpr as usize..y * self.bpr as usize + self.w as usize * 4];
                out.extend_from_slice(row);
            }
        }
        self.readback.unmap();
    }
}
