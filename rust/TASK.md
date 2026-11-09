# In-Flight (Rust) - Implementation Log & Task Tracker (TASK.md)

Dokumen ini adalah **catatan resmi implementasi aktif (living implementation log & changelog)** untuk proyek Rust di folder `rust/`.

---

## 1. Status Baseline & Implementasi Terintegrasi (Current Architecture)

Setelah penggabungan paralel antara modul **UI/UX Pra-Penerbangan** dan modul **3D Terrain, Environment & Cockpit Simulation**, berikut status lengkap komponen di `rust/`:

* **Fisika Penerbangan 6-DOF & A320 FBW (120 Hz)** (`src/physics.rs`, `src/fbw.rs`, `src/specs.rs`):
  * Dinamika 6-DOF rigid body lengkap dengan model dual CFM56-5B.
  * Normal Law Fly-By-Wire: pembatasan sudut bank (33°/67°), pitch limit (+30°/-15°), dan proteksi overload $n_z$.
  * Perhitungan envelope kecepatan Airbus: $V_{LS}, V_{\alpha\text{ prot}}, V_{\alpha\text{ max}}, V_{SW}, V_{MAX}$.
  * Alpha-Floor protection: pemicu otomatis tenaga TOGA saat mendekati sudut stall.
  * Wetness runway dinamis: efek pengereman berkurang pada landasan basah/bersalju.
* **Autopilot & Navigasi (60 Hz)** (`src/autopilot.rs`, `src/nav.rs`, `src/geo.rs`):
  * LNAV lateral guidance (great-circle waypoint sequencing, fly-by turn anticipation).
  * VNAV 3° geometric path descent dan konfigurasi pendekatan bertahap (CONF 1, 2, 3, FULL).
  * ILS Localizer & Glideslope capture serta autoland flare & rollout.
* **Lingkungan 3D, Atmosfer & Cuaca Volumetrik** (`src/atmosphere.rs`, `src/clouds.rs`, `src/precip.rs`, `src/weather.rs`):
  * Siklus twilight fotorealistik (Day, Golden, Civil, Nautical, Astronomical, Night) berdasarkan elevasi matahari NOAA.
  * Hamburan Rayleigh & aerosol (matahari rendah berwarna jingga/merah) dan pencahayaan malam fase bulan sinodik.
  * Ray-marching awan volumetrik 26-langkah pada buffer depth dengan self-shadowing dan in-cloud fogging.
  * Sistem presipitasi GPU: 9.000 partikel hujan/salju, simulasi petir, dan pengurangan jarak pandang.
* **Kokpit 3D & Display EFIS Airbus** (`src/cockpit.rs`, `src/gfx/displays.rs`, `src/gfx/fx.rs`):
  * Rig multi-kamera: Captain (dengan simulasi g-load dan head-look), Panel, Wing, Chase orbit, dan Tower spotter.
  * Geometri 3D interior kokpit (glareshield, main panel, pedestal, tiang jendela, overhead, lantai).
  * Render-to-texture atlas 1024x1024 untuk 6 layar kaca Airbus:
    * **PFD**: Artificial horizon, speed tape lengkap dengan bug proteksi FBW, altitude tape + VSI, FMA annunciator strip.
    * **ND**: Heading-up ARC mode, rute penerbangan, waypoints, kompas mawar, panah angin.
    * **E/WD**: Dual N1 dial, EGT, N2, fuel flow, memo status, dan peringatan GPWS/stall.
    * **SD**: Status permukaan kontrol, landing gear, dan bahan bakar.
* **Rangkaian Lengkap UI/UX Pra-Penerbangan** (`src/ui/`):
  * **Bootloader**: Visual animasi siluet A320 dan checklist inisialisasi sistem (`ui/screens.rs`).
  * **Menu Utama Bento MSFS**: 5 tile interaktif (Flight Planner, Free Flight, Settings, Logbook, Controls) (`ui/screens.rs`).
  * **Bola Dunia 3D**: Sphere tessellated dengan land mask Natural Earth 110m (`assets/land_mask.bin`), garis terminator siang/malam UTC, titik lampu kota malam, dan fly-to camera easing (`ui/globe.rs`).
  * **Pencarian Bandara & Filter**: Pencarian instan 8.413 bandara terindeks dengan filter runway $\ge$ 5.000 ft, permukaan keras, dan region quick-pick (`ui/planner.rs`).
  * **Flight Dispatch & Briefing**: Perhitungan jarak great-circle, level jelajah semicircular (ODD/EVEN FL), auto-runway pemilihan arah angin, ETE, kalkulasi block fuel, dan diagram vektor runway (`ui/planner.rs`, `ui/dispatch.rs`, `ui/map.rs`, `ui/a320.rs`).
  * **Modal Pengaturan & Logbook**: Dialog pengaturan FOV kokpit, audio, kontrol input, dan pencatatan touchdown pendaratan otomatis (`ui/modals.rs`).
* **CI/CD Build**:
  * Alur GitHub Actions `.github/workflows/rust-ci.yml` untuk build otomatis release executable Windows x86_64 (`inflight.exe`).

---

## 2. Log Implementasi & Riwayat Perubahan (Changelog)

| Tanggal | Fitur / Subsystem | File Terlibat | Ringkasan Pekerjaan | Status |
|---|---|---|---|---|
| 2026-11-09 | **Citra Satelit & Peta Nyata (OSM / Esri / Sentinel-2)** | `tiles/*`, `bin/tilecache.rs`, `gfx/*`, `ui/globe.rs`, `terrain.rs`, `app.rs`, `Cargo.toml` | Streaming asinkron peta satelit nyata 60 FPS (Esri, Sentinel-2, OSM, Topo, Night Lights, Dark) dengan disk cache LRU 2 GiB, page table clipmap datar, dan pemilih layer interaktif di bola dunia menu awal. Lihat §4. | ✅ Selesai & Teruji |
| 2026-11-09 | **Kokpit 3D HD interaktif + Marketplace add-on** | `addons.rs`, `glb.rs`, `deck.rs`, `deckhost.rs`, `a320sys.rs`, `gfx/deck_gpu.rs`, `gfx/deck.wgsl`, `gfx/fx.rs`, `gfx/mod.rs`, `ui/market.rs`, `ui/mod.rs`, `ui/screens.rs`, `app.rs`, `tests/deck.rs`, `Cargo.toml` | Model GLB A320 yang sama persis dengan proyek TS (pinned SHA `b2afd17`) diunduh in-game lewat Marketplace (F2 / tombol ADD-ONS) ke cache persisten, di-parse di thread latar, lalu dirender dengan 596 kontrol interaktif (picking sinar + klik/drag/scroll) dan 6 layar PFD/ND/E-WD/SD terpetakan ke mesh kaca model. Fallback: kokpit prosedural bila belum diunduh. Lihat §3. | ✅ Selesai & Teruji (CPU/shader); ⚠️ render GPU belum diverifikasi visual di sandbox tanpa GPU |
| 2026-11-08 | **Integrasi Lengkap UI/UX + 3D Simulation** | `rust/src/*`, `rust/assets/*`, `rust/tests/*` | Penggabungan penuh dua branch paralel: UI/UX pra-penerbangan (`ui/`) dan 3D terrain/fisika/kokpit (`atmosphere.rs`, `clouds.rs`, `cockpit.rs`, `fbw.rs`, `precip.rs`). Seluruh 112 tes lulus (90 unit + 5 environment + 6 flight + 11 ui flow). | ✅ Selesai & Teruji |
| 2026-11-08 | **3D World, Atmosfer & Kokpit FBW** | `atmosphere.rs`, `clouds.rs`, `cockpit.rs`, `fbw.rs`, `precip.rs`, `gfx/*` | Implementasi ray-marched volumetric clouds, pencahayaan matahari/bulan twilight, hujan/petir, A320 FBW envelope protections, rig kamera kokpit 3D, dan atlas tekstur PFD/ND/EWD/SD. | ✅ Selesai & Teruji |
| 2026-11-08 | **Pre-Flight UI/UX Suite** | `ui/*`, `clock.rs`, `gfx/ui.rs`, `app.rs`, `assets/land_mask.bin` | Implementasi bootloader A320, bento grid menu MSFS 5-tile, bola dunia 3D siang/malam, pencarian 8.413 bandara, flight briefing & dispatch, serta modal settings/logbook. | ✅ Selesai & Teruji |


---

## 3. Kokpit 3D HD Interaktif + Marketplace Add-on (2026-11-09)

### 3.1 Tujuan
1. Model kokpit **tidak di-bundle** di binary. Pengguna mengunduhnya lewat **Marketplace** (menu utama → tombol `ADD-ONS (F2)`, atau tekan **F2** di menu).
2. Model yang dipakai **identik** dengan proyek TypeScript: `cockpit.glb` (50.576.144 byte) + `cockpit-manifest.json` dari commit ter-pin `radebit/flight-simulator@b2afd173…` (URL & urutan mirror sama persis dengan `src/sim/a320/assets.ts`).
3. Semua tombol / saklar / tuas / knob berfungsi lewat mouse picking, drag, dan scroll; layar kaca PFD/ND/E-WD/SD dipetakan ke permukaan layar di model.
4. Fallback otomatis ke kokpit prosedural (`cockpit::build_cockpit`) bila add-on belum diunduh / dinonaktifkan / gagal dimuat.

### 3.2 Arsitektur & strategi (hasil analisis `cockpit.ts`, `assets.ts`, `systems.ts`)
| Lapisan | Modul | Tanggung jawab |
|---|---|---|
| Distribusi | `addons.rs` | `AddonManager`: katalog add-on, direktori cache persisten (`INFLIGHT_ADDON_DIR` → `%LOCALAPPDATA%\InFlight\addons` / `~/Library/Caches/InFlight/addons` / `$XDG_CACHE_HOME/inflight/addons`), unduhan asinkron `std::thread` + `ureq` dengan progres (`Progress`), failover mirror, tulis ke `*.part` → validasi (ukuran persis, header glTF, JSON) → `rename` atomik, cancel, uninstall, flag enable/disable (`disabled` marker). |
| UI | `ui/market.rs` + `ui/mod.rs` | Jendela Marketplace: kartu add-on, status, progress bar (MB / %), DOWNLOAD / CANCEL / RETRY, switch "Use HD flight deck", REMOVE FILES. Dibuka via tile menu atau F2. |
| Aset | `glb.rs` | Parser GLB 2.0 (JSON+BIN, accessor float/u32, material `OPAQUE/MASK/BLEND`, PNG via `png`, JPEG via `jpeg-decoder`, transform node dibake). Nama node asli dipertahankan (`extras.sourceName`) karena semua id kontrol memakainya. |
| Logika kokpit | `deck.rs` | Klasifikasi 1.223 node → **596 grup kontrol** (317 push, 146 key MCDU, 70 knob, 34 switch, 22 guard, 6 lever, 1 stick) dengan aturan penamaan yang sama dengan `cockpit.ts` (regex, `FCU_TOGGLES`, `KNOB_STEPS`, `GUARD_OF`, `MOMENTARY`, …); legenda & LED (`1F/2O/…`, `_led`) → lampu berstatus; animasi pose di sekitar sumbu manifest (fallback sumbu dari bounding-box + normal panel); **picking** sinar (AABB + segitiga pada pose saat ini, guard terangkat "tembus" ke tombol di bawahnya); `press / drag / release / wheel`; transform model→body (`body = (-z+tx, y+ty, x+tz)`, mata desain model `(0.22,0.66,0.52)` → `spec.eye`). |
| Sistem pesawat | `a320sys.rs` | Port ringkas `A320Systems`: elektrik (BAT/EXT/APU GEN/GEN), APU (spool 28 s), bleed/pack, hidrolik (tekanan orde-1, PTU, RAT), pompa fuel, FIRE pb + agent, ENG MODE + ENG MASTER → `FlightModel::start_engine/stop_engine`, FCU (managed/selected, SPD/HDG/ALT/V/S), dua panel EFIS (baro hPa/inHg/STD, ND mode/range, CSTR/WPT/VOR.D/NDB/ARPT eksklusif, ADF/VOR), kecerahan layar, lampu eksterior, chrono, master warn/caution. |
| Glue | `deckhost.rs` | Loader di thread latar (parse + decode tekstur ≤2048 px + bake mesh), ray kursor→body-frame (`body_ray`), hover tooltip, overlay angka FCU (jendela SPD/HDG/ALT/VS mesh asli disembunyikan, angka digambar pada posisinya), toast. |
| GPU | `gfx/deck_gpu.rs`, `gfx/deck.wgsl`, `gfx/fx.rs` | Satu vertex/index buffer (≈439k segitiga) terurut per material; **storage buffer pose per-kontrol** (`Slot`: matriks, pengali warna/alpha, emissive) sehingga knob/saklar dianimasikan tanpa mengubah vertex; bind-group per material (mip-map CPU, anisotropic 8×); pass opaque/alpha-test → quad layar atlas → pass blend (kaca). `Renderer::load_deck / unload_deck / set_deck_slots`. |
| Layar | `deck.rs::bake_screen` | `pfd1/pfd2.screen`→sel PFD, `ND/ND_R.screen`→ND, `uecam.screen(2)`→E/WD, `lecam.screen`→SD pada atlas 1024² yang sudah ada (`gfx/displays.rs`); UV diproyeksikan pada bidang mesh kaca asli (kanan = −Z model, atas = +Y), diangkat 1,5 mm ke depan kaca. |
| App | `app.rs` | `service_addons()` (preload saat terpasang, upload GPU, unload saat removal/disable), picking per frame, klik kiri = tekan/drag, klik kanan = pull / mundur (atau free-look bila tidak di atas kontrol), scroll = putar knob / geser tuas / zoom kepala, tooltip hover. |

### 3.3 Mekanik kontrol (ringkas, mengikuti `cockpit.ts`)
* **Push-button**: klik = toggle/latching (overhead: IN = ON/AUTO, OUT = OFF; momentary: tes/call/…); klik kanan / Shift = arah sebaliknya. Tombol berpelindung: klik pertama mengangkat guard, klik kedua menekan tombol.
* **Switch** 2/3-posisi (lampu eksterior, seat belt, ADF/OFF/VOR, …) berputar siklus; lampu mengikuti (`StrobeLtSwtch` → `lights.strobe`, dst.).
* **Knob**: scroll / drag vertikal = putar per klik; FCU `spd-sel/hdg_sel/alt-sel/vs-sel` (klik = push/managed, klik kanan/Shift = pull/selected, scroll = ±1 / ±100 ft / ±100 fpm, Shift = ×10) menulis langsung ke `Autopilot`; EFIS BARO (1 hPa per klik, STD), ND MODE (LS/VOR/NAV/ARC/PLAN), ND RANGE (10–320 NM), kecerahan, ENG MODE, RUDDER TRIM.
* **Lever**: thrust lever kiri/kanan (drag 170 px = rentang penuh, detent IDLE/CL/FLX-MCT/TOGA magnetik, scroll 5%/notch), FLAPS (drag/scroll per detent), SPEED BRAKE (ARM ↔ 0–100%), ENG MASTER 1/2 (klik = start/stop mesin nyata), gear & parking brake (klik = aksi), reverser.
* **Key MCDU / ECAM control panel**: tekan visual + pemilihan halaman ECAM (disimpan di `Deck::ecam_page`).

### 3.4 Pengujian (semua lulus: `cargo check`, `cargo test --release`)
* `addons::tests` (server HTTP lokal): URL = `assets.ts`, failover mirror 404→OK, validasi + rename atomik, cache persisten antar-instance, file korup ditolak & tidak pernah mencapai path final, enable/disable, uninstall.
* `glb::tests`: GLB mini sintetis (transform dibake, nama asli), input rusak ditolak, dan **model asli** (1.223 mesh, 438.982 segitiga = angka manifest upstream, 35 material, 21 gambar, semua node kunci ada).
* `a320sys::tests`: baro/unit/STD, opsi ND eksklusif, syarat start APU, aturan agent pemadam.
* `tests/deck.rs` (model asli, dilewati bila add-on belum terpasang): klasifikasi (≥400 grup, id kunci bertipe benar, sumbu manifest), pemetaan layar (6 layar, urutan kiri-kanan/atas-bawah, UV ∈ [0,1]), picking (≥7/9 kontrol terkena sinar dari mata kapten), mekanik (thrust drag → TOGA, flaps scroll, gear klik, FCU ALT +100 / SPD +1 / HDG +1, BARO +1 hPa, BAT toggle, pose bergerak), guard harus diangkat dulu.
* `deckhost::tests`: ray kursor → arah kamera/kanan/atas, loader asinkron (gagal pada sampah, sukses pada model asli).
* `gfx::deck_gpu::tests`: mip-chain; **validasi `naga` terhadap `globals.wgsl + deck.wgsl`** (parse + validate penuh) sebagai pengganti uji GPU.
* Seluruh suite: 108 unit + 5 deck + 5 environment + 6 flight + 11 ui_flow = **135 tes lulus**.

### 3.5 Cara memakai
1. Jalankan `cargo run --release` → menu utama → **ADD-ONS (F2)** → **DOWNLOAD** (≈50,6 MB; progres tampil). Berkas disimpan di cache persisten (lihat jalur di jendela), model dimuat otomatis di latar.
2. Mulai penerbangan → tampilan **CAPTAIN/PANEL** (`C`). Arahkan kursor ke kontrol (tooltip nama/status/petunjuk), klik / drag / scroll. Klik kanan + geser di area kosong = lihat sekeliling; scroll di area kosong = zoom.
3. Untuk uji tanpa internet: `INFLIGHT_ADDON_DIR=/path` berisi `a320-cockpit-hd/cockpit.glb` (+ manifest).

### 3.6 Keterbatasan jujur & langkah lanjutan
* **Render GPU tidak diverifikasi visual** di lingkungan pengembangan ini (tidak ada GPU/Vulkan). Yang terverifikasi: kompilasi `wgpu 30`, validasi WGSL via `naga`, seluruh logika CPU (parse, klasifikasi, picking, pose, UV layar) terhadap model asli. Lakukan smoke-test visual pertama di mesin ber-GPU (`cargo run --release`, unduh add-on, `C` ke tampilan kokpit).
* Belum di-port: kamera preset fokus (0–9) dan tablet EFB, MCDU interaktif penuh (tombol hanya animasi + tooltip), halaman SD per-ECP (state tersimpan, `displays.rs` masih menampilkan satu halaman), jam/baro canvas, sidestick mengikuti input, indikator FCU hanya overlay teks.
* `A320Systems` adalah port ringkas; mesin ECAM penuh (`ecam.ts`, alert/CLR/RCL) belum ada.

---




## 6. Windows glitch + camera-control audit (fix log)

> **Append this section to `rust/TASK.md`.** It was written as a separate file because the existing `TASK.md` (sections 3 and 4
> are referenced from `README.md`) must not be overwritten.
>
> **Verification status - read this first.** The audit was done by reading the sources of `app.rs`, `cockpit.rs`, `deckhost.rs`,
> `gfx/mod.rs`, `gfx/fx.rs`, `gfx/ui.rs`, `gfx/ui.wgsl`, `tiles/gpu.rs`, `tiles/*.wgsl`, `ui/mod.rs`, `ui/globe.rs`.
> The environment had **no shell**: nothing was cloned, compiled or run. `cargo check --all-targets` and `cargo test --release`
> have **not** been run, and none of the fixes has been tried on Windows (DX12 / Vulkan). Section 6.3 (patches in other
> files) is **not applied**.

### 6.1 Root causes

| # | Area | Root cause | File |
|---|------|------------|------|
| G1 | Glitch (menu + game) | `Ui::line()` builds its quad with `a[0]` / `b[0]` where the **y** coordinate should be (`[a[0]+nx, a[0]+ny]`, `[b[0]+nx, b[0]+ny]`, `[b[0]-nx, b[0]-ny]`). Three of the four corners lie on the line `y = x`, so every line is drawn as a long skewed sliver. Lines are used by the globe graticule, terminator, route arc, PFD tapes / attitude ticks, the moving map and the ND, so the artefacts start on the boot / menu globe and continue into the cockpit displays. | `gfx/ui.rs` (patch 6.3-A) |
| G2 | Glitch (Windows) | The swap-chain used `caps.alpha_modes[0]`. On Windows this can be a pre- or post-multiplied mode. The sky, globe-tile (`ALPHA_BLENDING`) and cloud passes write alpha < 1, so the window is composited with the desktop. | `app.rs` |
| G3 | Glitch (resize / maximise / DPI) | The surface and depth buffer were only reconfigured from `WindowEvent::Resized`. `Suboptimal` frames were presented as if fine and never reconfigured, so the frame was stretched until the next resize. | `app.rs` |
| G4 | Glitch (menu text) | In the pre-flight screens `event.text` was pushed to `Input::typed` unfiltered. Enter / Tab / Esc / Backspace carry a control character, which the glyph batcher draws as `?`. | `app.rs` |
| G5 | Stutter / jump | Early returns on `Outdated` / `Lost` / `Occluded` skipped `Input::end_frame()`, so pointer delta and wheel accumulated and were applied as one burst on the next frame (globe jump). A minimised window also spun the redraw loop at 100 % CPU. | `app.rs` |
| C1 | Camera (exterior) | **Exterior views had no mouse handling at all.** The drag code ran only when `view.is_interior()`, and the chase `orbit_yaw` is driven by `cam.head.yaw`, which nothing ever changed outside the cockpit. Wing / Tower look and orbit were dead. | `app.rs` |
| C2 | Camera (interior) | Free-look worked only on the **right** button, and was blocked while the deck had `captured` a control. Dragging also stalled at the window / screen edge because only `CursorMoved` deltas were used. | `app.rs` |
| C3 | Camera (lag) | Head-look was applied **after** `make_camera()`, so the view lagged the mouse by one frame and the deck pick ray used the stale camera. | `app.rs` |
| C4 | Camera (zoom) | The wheel always scaled `cam.dist` (chase only), even in the cockpit. This corrupted the chase distance later. Wing and Tower never zoomed. Chase yaw was clamped to +-150 deg by `HeadLook::apply`, leaving a 60 deg blind spot. | `app.rs` |
| C5 | Camera (stuck input) | There was no `Focused(false)` handling. After alt-tab, keys and mouse buttons stayed "down" (throttle / roll stuck, camera drag stuck). | `app.rs` |
| C6 | Camera (documented but missing) | F1 advertises `Num 4 6 8 2` / `Num 5` / `Num + -`, but nothing handled them. | `app.rs` |

### 6.2 Fixes applied (all in `rust/src/app.rs`)

* **Surface:** opaque `alpha_mode` when offered (G2). `sync_surface()` compares `window.inner_size()` with the surface config every
  frame and reconfigures the surface, the depth buffer (`Renderer::resize`) and the UI screen uniform (G3). `Suboptimal`
  reconfigures after `present`. A minimised window sleeps instead of spinning. Skipped frames clear the pointer delta and wheel
  (G5).
* **Text input:** control characters are filtered out of `Input::typed`, and both Ctrl keys suppress text (G4).
* **Camera gestures (`App::update_look`, runs before the rig):**
  * Left **or** right drag starts a look / orbit. On the flight deck a press on a control still belongs to the control
    (`over_ctl` / `host.captured`); a press anywhere else looks around.
  * Cockpit / Panel / Wing: head-look with the neck limits, as before. Chase: a free 360 deg orbit (`yaw` wraps, pitch +-70,
    drag down raises the camera). Tower: look-around offset plus zoom, applied on top of the rig in `redraw`.
  * Drag deltas come from raw `DeviceEvent::MouseMotion`, with a fallback to the cursor delta when no raw input is present
    (RDP / VMs). The cursor is confined and hidden during a drag, so it never stalls at an edge.
  * The look is applied before `make_camera()`, so there is no one-frame lag (C3). The tooltip is hidden while looking.
* **Zoom (`zoom_view`):** the wheel zooms by view. Chase changes the distance. Wing and Tower change the FOV. The cockpit
  first offers the wheel to the control under the cursor and the remainder zooms the head view. `cam.dist` is no longer
  touched in the cockpit (C4).
* **Input hygiene:** `Focused(false)` clears keys, buttons, drag state and the cursor grab (C5). Numpad 4 6 8 2 look, 5 centres,
  + / - zoom (C6). `KeyCode::KeyC` and leaving the flight cancel any active drag.

### 6.3 Patches still to apply in other files (not applied)

**A. `rust/src/gfx/ui.rs` - `Ui::line` (root cause G1, the main visual glitch)**

```rust
// find
self.quad([[a[0] + nx, a[0] + ny], [b[0] + nx, b[0] + ny], [b[0] - nx, b[0] - ny], [a[0] - nx, a[1] - ny]], col);
// replace with
self.quad([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], col);
```

Suggested regression test in the `gfx/ui.rs` tests (or a new `#[cfg(test)]` block): draw `line([10.0, 10.0], [110.0, 10.0], 4.0, C_WHITE)`
and assert that every vertex has `y` in `8.0..=12.0`.

**B. Items found while reading, not changed (check on a Windows machine)**

* `gfx/mod.rs` was truncated in the middle of the audit (`Renderer::resize`, `ensure_airports`, `new_flight`). Confirm that `resize`
  recreates `depth_view`, calls `fx.rebind_depth(...)` (the cloud pass samples it) and rewrites `screen_buf`.
* `tiles/hub.rs` / `tiles/ground.rs` were not read. Check that a page-table entry is only marked valid (`e2.w`) after its
  `write_texture` was queued in `TileAtlas::pump`. Otherwise the ground shows the previous tile of a recycled atlas layer for a
  frame. `ground.wgsl` falls back to a neutral colour only when `e2.w < 0.5`.
* `globe.rs`: `g.inp.pressed` starts a drag without checking `Gui::mute_click`. If a bento tile overlaps `view.clip`, a click on
  it also starts a drag. This needs a look at `ui/screens.rs`.
* `ground.wgsl` uses `@builtin(instance_index)` as the clipmap level (`draw_indexed(.., l..l+1)`). That is fine on wgpu / DX12
  (first-instance is added by wgpu), but a per-ring uniform or vertex attribute would be more robust across backends.

### 6.4 Manual test plan

1. Menu / boot: the globe graticule, terminator and route arc are thin lines (no diagonal slivers). Drag spins the globe, the
   wheel zooms, clicking the map-layer chips does not start a globe drag.
2. Cockpit (`C` cycles): drag with either button looks around, the wheel zooms, a press on a deck control still operates it,
   and no hover tooltip appears while looking.
3. Chase: drag orbits a full 360 deg, the wheel changes the distance. Wing: drag looks, the wheel zooms. Tower: drag looks,
   the wheel zooms.
4. Alt-tab while holding W / the mouse button: nothing is stuck after coming back. Maximise / restore: no stretched frame.
5. `cargo check --all-targets && cargo test --release` (not yet run, see the status note at the top).
