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
| 2026-11-08 | **Integrasi Lengkap UI/UX + 3D Simulation** | `rust/src/*`, `rust/assets/*`, `rust/tests/*` | Penggabungan penuh dua branch paralel: UI/UX pra-penerbangan (`ui/`) dan 3D terrain/fisika/kokpit (`atmosphere.rs`, `clouds.rs`, `cockpit.rs`, `fbw.rs`, `precip.rs`). Seluruh 112 tes lulus (90 unit + 5 environment + 6 flight + 11 ui flow). | ✅ Selesai & Teruji |
| 2026-11-08 | **3D World, Atmosfer & Kokpit FBW** | `atmosphere.rs`, `clouds.rs`, `cockpit.rs`, `fbw.rs`, `precip.rs`, `gfx/*` | Implementasi ray-marched volumetric clouds, pencahayaan matahari/bulan twilight, hujan/petir, A320 FBW envelope protections, rig kamera kokpit 3D, dan atlas tekstur PFD/ND/EWD/SD. | ✅ Selesai & Teruji |
| 2026-11-08 | **Pre-Flight UI/UX Suite** | `ui/*`, `clock.rs`, `gfx/ui.rs`, `app.rs`, `assets/land_mask.bin` | Implementasi bootloader A320, bento grid menu MSFS 5-tile, bola dunia 3D siang/malam, pencarian 8.413 bandara, flight briefing & dispatch, serta modal settings/logbook. | ✅ Selesai & Teruji |
