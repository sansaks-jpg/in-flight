//! Marketplace / add-on manager: downloads the HD A320 flight-deck model at run time instead of bundling it in the binary.
//!
//! Reference: `src/sim/a320/assets.ts`. The 50.6 MB GLB and its control manifest live in a pinned, immutable commit of the upstream
//! conversion project (`radebit/flight-simulator`). Because the commit SHA is pinned the bytes can never change, so a verified copy is
//! kept forever in a persistent per-user cache directory (the native equivalent of the browser's Cache Storage API).
//!
//! * Downloads run on a background thread (`std::thread`) and never block the render loop; progress is published through a
//!   lock-protected [`Progress`] snapshot that the Marketplace UI polls once per frame.
//! * Every file has an ordered list of mirrors (same order as `COCKPIT_GLB_URLS` / `COCKPIT_MANIFEST_URLS` in `assets.ts`);
//!   the next mirror is tried when one fails.
//! * Files are streamed to `<name>.part`, validated (size, glTF header, JSON syntax) and only then atomically renamed, so a crash or a
//!   cancelled download can never leave a corrupt model behind.
//! * If the add-on is not installed (or fails to load) the simulator keeps using the procedural cockpit (`cockpit::build_cockpit`).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// radebit/flight-simulator, pinned commit (identical to `SHA` in `src/sim/a320/assets.ts`).
pub const SHA: &str = "b2afd173081aea5db00031baa1003aa7c46a789a";
/// Size of the pinned GLB (Content-Length verified upstream with a HEAD request).
pub const GLB_SIZE: u64 = 50_576_144;
pub const COCKPIT_ID: &str = "a320-cockpit-hd";
pub const GLB_NAME: &str = "cockpit.glb";
pub const MANIFEST_NAME: &str = "cockpit-manifest.json";

/// One downloadable file of an add-on with its ordered mirror list.
#[derive(Clone, Debug)]
pub struct AddonFile {
    pub name: String,
    pub urls: Vec<String>,
    /// Exact size in bytes when known (0 = unknown, only a hint is used for progress).
    pub size: u64,
    /// The add-on is unusable without this file.
    pub required: bool,
}

/// Marketplace catalogue entry.
#[derive(Clone, Debug)]
pub struct Addon {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub license: String,
    pub description: String,
    pub files: Vec<AddonFile>,
}

impl Addon {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// Same URLs and mirror order as `assets.ts`.
pub fn cockpit_addon() -> Addon {
    let raw = format!("https://raw.githubusercontent.com/radebit/flight-simulator/{SHA}/public/models/a320");
    Addon {
        id: COCKPIT_ID.into(),
        name: "A320 HD Flight Deck".into(),
        version: "1.0 (pinned b2afd17)".into(),
        author: "FlightGear A320-family contributors".into(),
        license: "GPL-2.0".into(),
        description: "Fully interactive 3D Airbus A320 cockpit (~1,200 named parts, 439k triangles). Every switch, knob, lever and key is animated and clickable; PFD / ND / E-WD / SD are mapped onto the real screen meshes.".into(),
        files: vec![
            AddonFile {
                name: GLB_NAME.into(),
                urls: vec![
                    format!("{raw}/cockpit.glb"),
                    // 302 -> raw.githubusercontent.com
                    format!("https://github.com/radebit/flight-simulator/raw/{SHA}/public/models/a320/cockpit.glb"),
                ],
                size: GLB_SIZE,
                required: true,
            },
            AddonFile {
                name: MANIFEST_NAME.into(),
                urls: vec![format!("https://cdn.jsdelivr.net/gh/radebit/flight-simulator@{SHA}/public/models/a320/cockpit-manifest.json"), format!("{raw}/cockpit-manifest.json")],
                size: 0,
                // `assets.ts` falls back to an empty axis table when the manifest is unavailable (axes are then derived from bounding boxes)
                required: false,
            },
        ],
    }
}

/// Persistent add-on directory. Override with `INFLIGHT_ADDON_DIR`; otherwise the platform cache dir:
/// Windows `%LOCALAPPDATA%\InFlight\addons`, macOS `~/Library/Caches/InFlight/addons`, Linux `$XDG_CACHE_HOME|~/.cache/inflight/addons`.
pub fn cache_root() -> PathBuf {
    if let Some(p) = std::env::var_os("INFLIGHT_ADDON_DIR") {
        return PathBuf::from(p);
    }
    let home = || std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(home).join("InFlight").join("addons")
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Caches").join("InFlight").join("addons")
    } else {
        std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".cache")).join("inflight").join("addons")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    NotInstalled,
    Downloading,
    Installed,
    Failed(String),
}

/// Snapshot polled by the UI every frame.
#[derive(Clone, Debug)]
pub struct Progress {
    pub state: State,
    pub file: String,
    pub loaded: u64,
    pub total: u64,
    pub mirror: usize,
}

impl Progress {
    pub fn fraction(&self) -> f32 {
        if self.total == 0 {
            0.0
        } else {
            (self.loaded as f64 / self.total as f64).clamp(0.0, 1.0) as f32
        }
    }
}

struct Shared {
    p: Progress,
}

/// Owns the cache directory and the (at most one) running download per add-on.
pub struct AddonManager {
    root: PathBuf,
    pub addon: Addon,
    shared: Arc<Mutex<Shared>>,
    cancel: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

fn validate_glb(path: &Path, expect: u64) -> Result<(), String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut h = [0u8; 12];
    f.read_exact(&mut h).map_err(|_| "file too short".to_string())?;
    if &h[0..4] != b"glTF" {
        return Err("not a binary glTF (bad magic)".into());
    }
    let declared = u32::from_le_bytes([h[8], h[9], h[10], h[11]]) as u64;
    if declared != len {
        return Err(format!("glTF length mismatch (header {declared}, file {len})"));
    }
    if expect != 0 && len != expect {
        return Err(format!("unexpected size {len} (expected {expect})"));
    }
    Ok(())
}

fn validate_file(file: &AddonFile, path: &Path) -> Result<(), String> {
    if file.name.ends_with(".glb") {
        validate_glb(path, file.size)
    } else if file.name.ends_with(".json") {
        let s = fs::read(path).map_err(|e| e.to_string())?;
        serde_json::from_slice::<serde_json::Value>(&s).map(|_| ()).map_err(|e| format!("invalid JSON: {e}"))
    } else if file.size != 0 && fs::metadata(path).map_err(|e| e.to_string())?.len() != file.size {
        Err("size mismatch".into())
    } else {
        Ok(())
    }
}

/// Streams `url` into `part`, publishing progress. Returns the byte count.
fn fetch_to(url: &str, part: &Path, hint: u64, sh: &Arc<Mutex<Shared>>, cancel: &AtomicBool) -> Result<u64, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .user_agent("in-flight-rust/0.1")
        .build()
        .into();
    let resp = agent.get(url).call().map_err(|e| e.to_string())?;
    let header: u64 = resp.headers().get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    // a compressed response reports the encoded length: never let the bar claim more than 99 % until the stream ends (same as assets.ts)
    let total = if header > 0 { header } else { hint };
    if let Ok(mut g) = sh.lock() {
        g.p.total = total;
        g.p.loaded = 0;
    }
    let mut rd = resp.into_body().into_with_config().reader();
    let mut out = fs::File::create(part).map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 256 * 1024];
    let mut loaded = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let n = rd.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        loaded += n as u64;
        if let Ok(mut g) = sh.lock() {
            g.p.loaded = if total > 0 { loaded.min((total as f64 * 0.99) as u64) } else { loaded };
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    if loaded == 0 {
        return Err("empty response".into());
    }
    if let Ok(mut g) = sh.lock() {
        g.p.loaded = loaded;
        g.p.total = loaded;
    }
    Ok(loaded)
}

impl AddonManager {
    pub fn new() -> Self {
        Self::with_root(cache_root(), cockpit_addon())
    }

    pub fn with_root(root: PathBuf, addon: Addon) -> Self {
        let m = Self { root, addon, shared: Arc::new(Mutex::new(Shared { p: Progress { state: State::NotInstalled, file: String::new(), loaded: 0, total: 0, mirror: 0 } })), cancel: Arc::new(AtomicBool::new(false)), worker: None };
        m.refresh();
        m
    }

    pub fn dir(&self) -> PathBuf {
        self.root.join(&self.addon.id)
    }

    pub fn file_path(&self, name: &str) -> PathBuf {
        self.dir().join(name)
    }

    /// Are all required files present and valid? (cheap header checks only - no 50 MB re-read)
    pub fn is_installed(&self) -> bool {
        self.addon.files.iter().filter(|f| f.required).all(|f| validate_file(f, &self.file_path(&f.name)).is_ok())
    }

    fn refresh(&self) {
        let installed = self.is_installed();
        if let Ok(mut g) = self.shared.lock() {
            if g.p.state != State::Downloading {
                g.p.state = if installed {
                    State::Installed
                } else if matches!(g.p.state, State::Failed(_)) {
                    g.p.state.clone()
                } else {
                    State::NotInstalled
                };
            }
        }
    }

    pub fn progress(&self) -> Progress {
        self.shared.lock().map(|g| g.p.clone()).unwrap_or(Progress { state: State::Failed("lock poisoned".into()), file: String::new(), loaded: 0, total: 0, mirror: 0 })
    }

    pub fn state(&self) -> State {
        self.progress().state
    }

    /// Enabled by default once installed; a `disabled` marker file records an explicit opt-out ('use HD cockpit' toggle).
    pub fn enabled(&self) -> bool {
        self.is_installed() && !self.dir().join("disabled").exists()
    }

    pub fn set_enabled(&self, on: bool) {
        let _ = fs::create_dir_all(self.dir());
        let off = self.dir().join("disabled");
        if on {
            let _ = fs::remove_file(off);
        } else {
            let _ = fs::write(off, b"1");
        }
    }

    /// Start (or retry after a failure) the background download. No-op while one is already running.
    pub fn start_download(&mut self) {
        if self.state() == State::Downloading {
            return;
        }
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
        self.cancel.store(false, Ordering::Relaxed);
        if let Ok(mut g) = self.shared.lock() {
            g.p = Progress { state: State::Downloading, file: String::new(), loaded: 0, total: self.addon.total_size(), mirror: 0 };
        }
        let (addon, dir, sh, cancel) = (self.addon.clone(), self.dir(), self.shared.clone(), self.cancel.clone());
        self.worker = Some(std::thread::spawn(move || {
            let res = download_all(&addon, &dir, &sh, &cancel);
            if let Ok(mut g) = sh.lock() {
                g.p.state = match res {
                    Ok(()) => State::Installed,
                    Err(e) => State::Failed(e),
                };
            }
        }));
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Blocks until the worker thread has finished (tests / headless tools).
    pub fn wait(&mut self) {
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }

    /// Delete the downloaded files (Marketplace "Remove" button).
    pub fn uninstall(&mut self) {
        self.cancel();
        self.wait();
        let _ = fs::remove_dir_all(self.dir());
        if let Ok(mut g) = self.shared.lock() {
            g.p = Progress { state: State::NotInstalled, file: String::new(), loaded: 0, total: 0, mirror: 0 };
        }
    }

    /// Bytes of the GLB (+ optional manifest) when installed and enabled - what `deck` consumes.
    pub fn read_installed(&self) -> Option<(Vec<u8>, Option<Vec<u8>>)> {
        if !self.enabled() {
            return None;
        }
        let glb = fs::read(self.file_path(GLB_NAME)).ok()?;
        let man = fs::read(self.file_path(MANIFEST_NAME)).ok();
        Some((glb, man))
    }
}

impl Default for AddonManager {
    fn default() -> Self {
        Self::new()
    }
}

fn download_all(addon: &Addon, dir: &Path, sh: &Arc<Mutex<Shared>>, cancel: &AtomicBool) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for f in &addon.files {
        let dest = dir.join(&f.name);
        if validate_file(f, &dest).is_ok() {
            continue; // already cached (pinned SHA => bytes can never change)
        }
        if let Ok(mut g) = sh.lock() {
            g.p.file = f.name.clone();
            g.p.loaded = 0;
            g.p.total = f.size;
        }
        let part = dir.join(format!("{}.part", f.name));
        let mut last = String::from("no URL");
        let mut ok = false;
        for (i, url) in f.urls.iter().enumerate() {
            if let Ok(mut g) = sh.lock() {
                g.p.mirror = i;
            }
            match fetch_to(url, &part, f.size, sh, cancel).and_then(|_| validate_file(f, &part)) {
                Ok(()) => {
                    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
                    ok = true;
                    break;
                }
                Err(e) => {
                    let _ = fs::remove_file(&part);
                    if e == "cancelled" {
                        return Err(e);
                    }
                    last = format!("{url}: {e}");
                }
            }
        }
        if !ok && f.required {
            return Err(format!("{}: {last}", f.name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    /// Minimal HTTP/1.1 server: path -> (status, body). Serves exactly `n` requests.
    fn serve(routes: Vec<(&'static str, u16, Vec<u8>)>, n: usize) -> (String, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            for _ in 0..n {
                let (mut s, _) = l.accept().unwrap();
                let mut rd = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                rd.read_line(&mut line).unwrap();
                loop {
                    let mut h = String::new();
                    rd.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (code, body) = routes.iter().find(|r| r.0 == path).map(|r| (r.1, r.2.clone())).unwrap_or((404, b"nope".to_vec()));
                let _ = write!(s, "HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        (base, h)
    }

    fn tiny_glb() -> Vec<u8> {
        let json = br#"{"asset":{"version":"2.0"}}   "#; // padded to a multiple of 4
        let total = 12 + 8 + json.len();
        let mut v = Vec::new();
        v.extend_from_slice(b"glTF");
        v.extend_from_slice(&2u32.to_le_bytes());
        v.extend_from_slice(&(total as u32).to_le_bytes());
        v.extend_from_slice(&(json.len() as u32).to_le_bytes());
        v.extend_from_slice(b"JSON");
        v.extend_from_slice(json);
        v
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("inflight-addon-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn empty_addon(id: &str, files: Vec<AddonFile>) -> Addon {
        Addon { id: id.into(), name: String::new(), version: String::new(), author: String::new(), license: String::new(), description: String::new(), files }
    }

    #[test]
    fn urls_match_assets_ts() {
        let a = cockpit_addon();
        assert_eq!(a.files[0].urls[0], "https://raw.githubusercontent.com/radebit/flight-simulator/b2afd173081aea5db00031baa1003aa7c46a789a/public/models/a320/cockpit.glb");
        assert!(a.files[0].urls[1].starts_with("https://github.com/radebit/flight-simulator/raw/b2afd17"));
        assert!(a.files[1].urls[0].starts_with("https://cdn.jsdelivr.net/gh/radebit/flight-simulator@b2afd17"));
        assert_eq!(a.files[0].size, 50_576_144);
        assert!(a.files[0].required && !a.files[1].required);
    }

    #[test]
    fn cache_dir_is_persistent_location() {
        let r = cache_root();
        assert!(r.is_absolute() || std::env::var_os("HOME").is_none() || std::env::var_os("INFLIGHT_ADDON_DIR").is_some());
        assert!(r.to_string_lossy().to_lowercase().contains("addons") || std::env::var_os("INFLIGHT_ADDON_DIR").is_some());
    }

    #[test]
    fn download_with_mirror_failover_and_verification() {
        let glb = tiny_glb();
        let (base, h) = serve(vec![("/b/cockpit.glb", 200, glb.clone()), ("/man.json", 200, b"{\"axes\":{}}".to_vec())], 3);
        let addon = empty_addon(
            "t",
            vec![
                AddonFile { name: "cockpit.glb".into(), urls: vec![format!("{base}/a/cockpit.glb"), format!("{base}/b/cockpit.glb")], size: glb.len() as u64, required: true },
                AddonFile { name: "cockpit-manifest.json".into(), urls: vec![format!("{base}/man.json")], size: 0, required: false },
            ],
        );
        let root = tmp("ok");
        let mut m = AddonManager::with_root(root.clone(), addon);
        assert_eq!(m.state(), State::NotInstalled);
        assert!(m.read_installed().is_none());
        m.start_download();
        m.wait();
        assert_eq!(m.state(), State::Installed, "{:?}", m.progress());
        let (g, man) = m.read_installed().unwrap();
        assert_eq!(g, glb);
        assert!(man.is_some());
        assert!(!m.dir().join("cockpit.glb.part").exists());
        m.set_enabled(false);
        assert!(m.read_installed().is_none());
        m.set_enabled(true);
        assert!(m.read_installed().is_some());
        // a second manager over the same directory sees the persistent cache without downloading
        let m2 = AddonManager::with_root(root.clone(), m.addon.clone());
        assert_eq!(m2.state(), State::Installed);
        m.uninstall();
        assert_eq!(m.state(), State::NotInstalled);
        h.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_download_is_rejected() {
        let (base, h) = serve(vec![("/x.glb", 200, b"this is not a glb file at all".to_vec())], 1);
        let addon = empty_addon("c", vec![AddonFile { name: "cockpit.glb".into(), urls: vec![format!("{base}/x.glb")], size: 0, required: true }]);
        let root = tmp("bad");
        let mut m = AddonManager::with_root(root.clone(), addon);
        m.start_download();
        m.wait();
        assert!(matches!(m.state(), State::Failed(_)), "{:?}", m.state());
        assert!(!m.is_installed());
        assert!(!m.dir().join("cockpit.glb").exists(), "corrupt data must never reach the final path");
        h.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
