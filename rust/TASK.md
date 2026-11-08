# In-Flight (Rust) - Implementation Log & Task Tracker (TASK.md)

Dokumen ini adalah **catatan resmi implementasi aktif (living implementation log & changelog)** untuk proyek Rust di folder `rust/`.

> ⚠️ **ATURAN MUTLAK UNTUK AGENT**:
> Dokumen ini **BUKAN** daftar checklist statis yang diisi oleh orang lain.
> Setiap kali Anda menerima prompt permintaan perubahan atau penambahan fitur dari user, **ANDA WAJIB**:
> 1. Mencatat apa saja yang Anda kerjakan dan ubah langsung ke dalam dokumen ini di bagian **Log Implementasi (Changelog)**.
> 2. Menuliskan file apa saja yang dibuat/dimodifikasi, detail implementasi teknisnya, serta status pengujiannya.

---

## 1. Status Baseline Kode Saat Ini (Fondasi yang Sudah Ada)

Berikut adalah komponen yang telah terimplementasi dan berfungsi di dalam codebase `rust/` saat ini:

* **Fisika Penerbangan & FBW (120 Hz)** (`src/physics.rs`, `src/specs.rs`):
  * Dinamika 6-DOF rigid-body pesawat Airbus A320-200.
  * Normal law Fly-By-Wire (FBW) dengan proteksi sudut bank, pitch, stall, dan overspeed.
  * Model dual mesin CFM56-5B, ground effect, dan kontak roda pendaratan (landing gear spring-damper).
* **Autopilot & Navigasi (60 Hz)** (`src/autopilot.rs`, `src/nav.rs`, `src/geo.rs`):
  * Panduan lateral LNAV (great-circle waypoint tracking, fly-by turn anticipation).
  * Panduan vertikal VNAV (profil climb/descent 3° geometric path).
  * ILS Localizer & Glideslope capture serta logika autoland flare/rollout.
* **Database Bandara & Navigasi** (`src/airports.rs`, `data/airports.json`):
  * 8.413 bandara global real-world terindeks (koordinat WGS84, elevasi, panjang/arah runway).
* **Waktu & Posisi Matahari Real-World** (`src/clock.rs`):
  * Waktu UTC sinkron dan algoritma NOAA Solar Position (azimuth, elevasi matahari, twilight).
* **Renderer Native wgpu 30 & Geometri** (`src/gfx/`):
  * Pipeline rendering `wgpu 30` dengan reversed-Z depth buffer (anti z-fighting).
  * Clipmap terrain 8 concentric LOD rings dengan elevasi prosedural.
  * Mesh eksterior A320 dan garis marka runway.
* **Instrumen HUD 2D Dasar & Menu Teks** (`src/gfx/ui.rs`, `src/app.rs`):
  * Batch renderer 2D teks (`ab_glyph`) dan indikator tape PFD/FCU sederhana.
  * Menu pemilihan ICAO berbasis teks sederhana (placeholder awal).
* **Build & CI/CD** (`.github/workflows/rust-ci.yml`):
  * Kompilasi executable native Windows x86_64 (`inflight.exe`).

---

## 2. Fokus Utama yang Sedang Dikerjakan: UI/UX Pra-Penerbangan (`src/ui/` Port)

Porting rangkaian antarmuka pra-penerbangan dari `src/ui/` (TypeScript) ke dalam Rust native (`rust/src/`):
1. **Bootloader & Loading Screen**: Visual siluet vektor A320 dan checklist inisialisasi sistem (`src/ui/Loaders.tsx`).
2. **Menu Utama Bento Grid MSFS**: 5 tile interaktif (Flight Planner, Free Flight, Settings, Logbook, Controls) (`src/ui/PreGameVisuals.tsx`, `Screens.tsx`).
3. **Globe 3D Interaktif**: Visual bola dunia dengan garis terminator siang/malam sesuai matahari UTC (`src/ui/globeCamera.ts`, `globeTiles.ts`).
4. **Pencarian Bandara & Filter**: Pencarian cepat ICAO/IATA/kota dari 8.413 bandara dan filter runway (`src/ui/Planner.tsx`, `AirportMiniMap.tsx`).
5. **Flight Planner & Briefing Rute**: Perhitungan jarak rute, level jelajah (semi-circular rule), kalkulasi bahan bakar, estimasi waktu (ETE), dan diagram vektor runway (`src/ui/A320Plan.tsx`, `MapPanel.tsx`).
6. **Jendela Modal**: Dialog pengaturan (audio, grafik) dan daftar kontrol keyboard/joystick (`src/ui/MsfsWindows.tsx`, `SettingsPanels.tsx`).

---

## 3. Log Implementasi & Riwayat Perubahan (Changelog per Prompt)

*Setiap kali Anda (Agent A) melakukan perubahan berdasarkan prompt user, tambahkan catatan entri baru di tabel dan bagian bawah ini:*

| Tanggal | Target / Fitur | File Dibuat / Diubah | Ringkasan Perubahan | Status |
|---|---|---|---|---|
| *Contoh: 2026-11-08* | *UI Menu Bento* | *`rust/src/ui/menu.rs`, `rust/src/app.rs`* | *Implementasi 5 tile bento menu MSFS di wgpu* | *Selesai / Teruji* |

### Detail Entri Perubahan Terbaru:
*(Agent A: Tuliskan penjelasan teknis dari perubahan yang baru saja Anda buat di sini pada setiap iterasi prompt)*
