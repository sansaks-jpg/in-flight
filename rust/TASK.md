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


