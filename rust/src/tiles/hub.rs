//! Asynchronous tile streaming hub.
//!
//! ```text
//!  render thread                      worker threads (N)                       GPU
//!  ─────────────                      ──────────────────                       ───
//!  ensure()/request()  ──► view lane ─► pop best priority ─► disk cache hit? ─┐
//!  (O(1), never blocks                                     └► HTTP GET ───────┤ write to disk cache
//!   on I/O or decode)                                                         ▼
//!                                       decode PNG/JPEG + mip chain ──► `ready` queue (bounded, back-pressure)
//!  take_uploads(budget) ◄──────────────────────────────────────────────────┘
//!  └► assign a texture-array layer (free list / LRU eviction) ─► queue.write_texture (bounded bytes per frame)
//! ```
//!
//! The render thread only ever touches two short, uncontended mutexes (queue bookkeeping and the resident table); all
//! network, disk and decode work – the sources of frame-time spikes – is on worker threads. GPU uploads are rationed per
//! frame ([`TileHub::take_uploads`]) so a burst of arriving tiles is spread over several frames instead of stalling one.

use super::decode::{decode_tile, TILE_BYTES};
use super::disk::{self, DiskCache};
use super::math::TileKey;
use super::styles::{self, DEFAULT_STYLE};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Tiles with `z <= PIN_Z` of the active style are never evicted: the whole globe stays covered at ~16 km/px.
pub const PIN_Z: u8 = 3;
/// Decoded tiles waiting for upload (back-pressure: workers pause when full).
const READY_CAP: usize = 48;
/// Seconds a freshly uploaded tile takes to cross-fade over its parent.
pub const FADE_S: f64 = 0.35;
const NOT_FOUND_RETRY: Duration = Duration::from_secs(600);
const NET_RETRY_BASE: Duration = Duration::from_secs(15);
const NET_RETRY_MAX: Duration = Duration::from_secs(120);
const MAX_PREFETCH: usize = 30_000;

#[derive(Debug)]
pub enum FetchError {
    NotFound,
    Other(String),
}

/// Network abstraction (real HTTP in the app, a synthetic generator in tests).
pub trait Fetcher: Send + Sync {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, FetchError>;
}

pub struct HttpFetcher {
    agent: ureq::Agent,
    offline: bool,
}

impl HttpFetcher {
    pub fn new() -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(12)))
            .user_agent("InFlightSim/0.1 (native tile loader; github.com/sansaks-jpg/in-flight)")
            .build()
            .into();
        Self { agent, offline: std::env::var_os("INFLIGHT_OFFLINE").is_some() }
    }
}

impl Default for HttpFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetcher for HttpFetcher {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, FetchError> {
        if self.offline {
            return Err(FetchError::Other("offline mode".into()));
        }
        match self.agent.get(url).call() {
            Ok(mut resp) => resp.body_mut().with_config().limit(8 * 1024 * 1024).read_to_vec().map_err(|e| FetchError::Other(e.to_string())),
            Err(ureq::Error::StatusCode(404 | 400 | 403)) => Err(FetchError::NotFound),
            Err(e) => Err(FetchError::Other(e.to_string())),
        }
    }
}

/// A tile that has been decoded and is waiting for its GPU upload.
pub struct Decoded {
    pub key: TileKey,
    /// 256x256 RGBA8 + mips, `TILE_BYTES` long
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub layer: u16,
    /// hub-clock time of the GPU upload (drives the cross-fade)
    pub born: f64,
}

impl Slot {
    /// Cross-fade opacity 0..1.
    pub fn alpha(&self, now: f64) -> f32 {
        (((now - self.born) / FADE_S) as f32).clamp(0.0, 1.0)
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct TileStats {
    pub queued: usize,
    pub inflight: usize,
    pub ready: usize,
    pub resident: usize,
    pub layers: usize,
    pub net_ok: u64,
    pub net_fail: u64,
    pub disk_hits: u64,
    pub decoded: u64,
    pub uploaded: u64,
    pub evicted: u64,
    pub net_bytes: u64,
}

#[derive(Default)]
struct Counters {
    net_ok: AtomicU64,
    net_fail: AtomicU64,
    disk_hits: AtomicU64,
    decoded: AtomicU64,
    uploaded: AtomicU64,
    evicted: AtomicU64,
    net_bytes: AtomicU64,
}

struct Fail {
    until: Instant,
    n: u32,
}

#[derive(Default)]
struct Work {
    /// latest wanted set from the renderer (cleared by `begin_view`): key -> priority (lower = sooner)
    view: HashMap<TileKey, f32>,
    /// low-priority warm-up requests (disk cache only, never decoded / uploaded)
    prefetch: VecDeque<TileKey>,
    inflight: HashSet<TileKey>,
    failed: HashMap<TileKey, Fail>,
    ready: Vec<Decoded>,
}

struct Main {
    resident: HashMap<TileKey, Slot>,
    layer_key: Vec<Option<TileKey>>,
    layer_used: Vec<u64>,
    free: Vec<u16>,
    stamp: u64,
    version: u64,
}

struct Inner {
    work: Mutex<Work>,
    cv: Condvar,
    main: Mutex<Main>,
    cache: Option<DiskCache>,
    fetcher: Arc<dyn Fetcher>,
    style: AtomicU8,
    shutdown: AtomicBool,
    t0: Instant,
    st: Counters,
    layers: usize,
    config: Option<PathBuf>,
}

struct Guard(Arc<Inner>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.shutdown.store(true, Ordering::Relaxed);
        self.0.cv.notify_all();
    }
}

/// Cheap-to-clone handle shared by the renderer, the globe and the ground planner.
#[derive(Clone)]
pub struct TileHub {
    inner: Arc<Inner>,
    _guard: Arc<Guard>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl TileHub {
    /// Production hub: HTTP fetcher, platform disk cache, 10 loader threads.
    pub fn new(layers: usize) -> Self {
        let cache = DiskCache::open(disk::default_root(), disk::default_max_bytes());
        Self::with_parts(layers, Arc::new(HttpFetcher::new()), Some(cache), 10)
    }

    pub fn with_parts(layers: usize, fetcher: Arc<dyn Fetcher>, cache: Option<DiskCache>, workers: usize) -> Self {
        let layers = layers.clamp(8, u16::MAX as usize);
        let config = cache.as_ref().map(|c| c.root().join("style.txt"));
        let style = config
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| styles::style_index(s.trim()))
            .unwrap_or(DEFAULT_STYLE);
        let inner = Arc::new(Inner {
            work: Mutex::new(Work::default()),
            cv: Condvar::new(),
            main: Mutex::new(Main {
                resident: HashMap::with_capacity(layers * 2),
                layer_key: vec![None; layers],
                layer_used: vec![0; layers],
                free: (0..layers as u16).rev().collect(),
                stamp: 1,
                version: 1,
            }),
            cache,
            fetcher,
            style: AtomicU8::new(style),
            shutdown: AtomicBool::new(false),
            t0: Instant::now(),
            st: Counters::default(),
            layers,
            config,
        });
        for i in 0..workers {
            let w = inner.clone();
            let _ = std::thread::Builder::new().name(format!("tile-worker-{i}")).spawn(move || worker(w));
        }
        // keep the on-disk cache bounded without ever blocking start-up
        if inner.cache.is_some() {
            let w = inner.clone();
            let _ = std::thread::Builder::new().name("tile-janitor".into()).spawn(move || {
                if let Some(c) = &w.cache {
                    c.prune();
                }
            });
        }
        Self { _guard: Arc::new(Guard(inner.clone())), inner }
    }

    // ------------------------------------------------------------------ style / clock

    pub fn style(&self) -> u8 {
        self.inner.style.load(Ordering::Relaxed)
    }

    pub fn set_style(&self, id: u8) {
        let id = id.min(styles::STYLES.len() as u8 - 1);
        if self.inner.style.swap(id, Ordering::Relaxed) == id {
            return;
        }
        lock(&self.inner.work).view.clear();
        lock(&self.inner.main).version += 1;
        if let Some(p) = self.inner.config.clone() {
            let name = styles::style(id).id;
            let _ = std::thread::spawn(move || {
                let _ = std::fs::write(p, name);
            });
        }
    }

    pub fn cycle_style(&self, dir: i32) {
        let n = styles::STYLES.len() as i32;
        self.set_style(((self.style() as i32 + dir).rem_euclid(n)) as u8);
    }

    /// Seconds since the hub was created (monotonic; the clock all fades use).
    pub fn now(&self) -> f64 {
        self.inner.t0.elapsed().as_secs_f64()
    }

    pub fn layers(&self) -> usize {
        self.inner.layers
    }

    // ------------------------------------------------------------------ requests (render thread, non-blocking)

    /// Advances the "used this frame" stamp (layers untouched for two frames become evictable).
    pub fn next_frame(&self) {
        lock(&self.inner.main).stamp += 1;
    }

    /// Drops all not-yet-started view requests; the caller re-requests what it still needs (fast pans cancel stale tiles).
    pub fn begin_view(&self) {
        lock(&self.inner.work).view.clear();
    }

    pub fn is_failed(&self, key: TileKey) -> bool {
        lock(&self.inner.work).failed.get(&key).is_some_and(|f| Instant::now() < f.until)
    }

    pub fn request(&self, key: TileKey, prio: f32) {
        let mut w = lock(&self.inner.work);
        if w.inflight.contains(&key) || w.failed.get(&key).is_some_and(|f| Instant::now() < f.until) {
            return;
        }
        let e = w.view.entry(key).or_insert(prio);
        if prio < *e {
            *e = prio;
        }
        drop(w);
        self.inner.cv.notify_one();
    }

    /// Resident slot of `key` (marks it used this frame so it is not evicted).
    pub fn lookup(&self, key: TileKey) -> Option<Slot> {
        let mut m = lock(&self.inner.main);
        let stamp = m.stamp;
        let s = m.resident.get(&key).copied()?;
        m.layer_used[s.layer as usize] = stamp;
        Some(s)
    }

    /// Marks many tiles as used this frame with a single lock.
    pub fn touch_all(&self, keys: &[TileKey]) {
        let mut m = lock(&self.inner.main);
        let stamp = m.stamp;
        for k in keys {
            if let Some(s) = m.resident.get(k).copied() {
                m.layer_used[s.layer as usize] = stamp;
            }
        }
    }

    /// Like `lookup` without touching the LRU stamp.
    pub fn peek(&self, key: TileKey) -> Option<Slot> {
        lock(&self.inner.main).resident.get(&key).copied()
    }

    /// Returns the best resident tile covering `key` (itself or the nearest ancestor) and schedules whatever is missing:
    /// the tile itself (or its nearest non-failed ancestor when the provider has no coverage), plus a mid-level stepping
    /// stone and the z=3 base so deep views never wait on a long chain of intermediate levels.
    pub fn ensure(&self, key: TileKey, prio: f32) -> Option<(TileKey, Slot)> {
        let style = styles::style(key.style);
        let key = if key.z > style.max_zoom { key.ancestor(key.z - style.max_zoom) } else { key };
        let mut best = None;
        let mut k = key;
        loop {
            if let Some(s) = self.lookup(k) {
                best = Some((k, s));
                break;
            }
            match k.parent() {
                Some(p) => k = p,
                None => break,
            }
        }
        let best_z = best.map_or(-1, |b| b.0.z as i32);
        if best_z == key.z as i32 {
            return best;
        }
        let mut t = key;
        while t.z as i32 > best_z && self.is_failed(t) {
            match t.parent() {
                Some(p) => t = p,
                None => break,
            }
        }
        if t.z as i32 > best_z {
            self.request(t, prio);
            let gap = t.z as i32 - best_z.max(PIN_Z as i32);
            if gap >= 4 {
                self.request(t.ancestor((gap / 2) as u8), prio - 40.0);
            }
            if best_z < PIN_Z as i32 && t.z > PIN_Z {
                self.request(t.ancestor(t.z - PIN_Z), prio - 100.0);
            }
        }
        best
    }

    /// Queues tiles to be fetched into the disk cache only (no decode, no GPU memory): used to warm up the area around
    /// the planned departure / arrival airport while the user is still in the menus.
    pub fn prefetch(&self, keys: impl IntoIterator<Item = TileKey>) {
        let mut w = lock(&self.inner.work);
        for k in keys {
            if w.prefetch.len() >= MAX_PREFETCH {
                break;
            }
            w.prefetch.push_back(k);
        }
        drop(w);
        self.inner.cv.notify_all();
    }

    // ------------------------------------------------------------------ GPU upload scheduling (render thread)

    /// Moves decoded tiles into free (or LRU-evicted) texture layers, at most `max_bytes` worth per call. The caller then
    /// issues the matching `write_texture`s. Bounded work => bounded frame time no matter how many tiles are waiting.
    pub fn take_uploads(&self, max_bytes: usize, out: &mut Vec<(u16, Decoded)>) {
        out.clear();
        let take = {
            let mut w = lock(&self.inner.work);
            if w.ready.is_empty() {
                return;
            }
            let n = (max_bytes / TILE_BYTES).clamp(1, w.ready.len());
            w.ready.drain(..n).collect::<Vec<_>>()
        };
        self.inner.cv.notify_all();
        let now = self.now();
        let cur = self.style();
        let mut m = lock(&self.inner.main);
        for d in take {
            if m.resident.contains_key(&d.key) {
                continue;
            }
            let layer = match m.free.pop() {
                Some(l) => l,
                None => {
                    let stamp = m.stamp;
                    let victim = (0..m.layer_key.len())
                        .filter_map(|l| m.layer_key[l].map(|k| (l, k)))
                        .filter(|(l, k)| !(k.style == cur && k.z <= PIN_Z) && m.layer_used[*l] + 2 <= stamp)
                        .min_by_key(|(l, _)| m.layer_used[*l]);
                    match victim {
                        Some((l, k)) => {
                            m.resident.remove(&k);
                            self.inner.st.evicted.fetch_add(1, Ordering::Relaxed);
                            l as u16
                        }
                        None => continue, // every layer is in use this frame: drop; it will be requested again
                    }
                }
            };
            let stamp = m.stamp;
            m.layer_key[layer as usize] = Some(d.key);
            m.layer_used[layer as usize] = stamp;
            m.resident.insert(d.key, Slot { layer, born: now });
            m.version += 1;
            self.inner.st.uploaded.fetch_add(1, Ordering::Relaxed);
            out.push((layer, d));
        }
    }

    /// Bumps whenever a tile became resident / was evicted / the style changed (lets planners skip idle frames).
    pub fn version(&self) -> u64 {
        lock(&self.inner.main).version
    }

    pub fn stats(&self) -> TileStats {
        let (queued, inflight, ready) = {
            let w = lock(&self.inner.work);
            (w.view.len(), w.inflight.len(), w.ready.len())
        };
        let resident = lock(&self.inner.main).resident.len();
        let c = &self.inner.st;
        TileStats {
            queued,
            inflight,
            ready,
            resident,
            layers: self.inner.layers,
            net_ok: c.net_ok.load(Ordering::Relaxed),
            net_fail: c.net_fail.load(Ordering::Relaxed),
            disk_hits: c.disk_hits.load(Ordering::Relaxed),
            decoded: c.decoded.load(Ordering::Relaxed),
            uploaded: c.uploaded.load(Ordering::Relaxed),
            evicted: c.evicted.load(Ordering::Relaxed),
            net_bytes: c.net_bytes.load(Ordering::Relaxed),
        }
    }

    /// True while anything is queued, downloading or waiting for upload.
    pub fn busy(&self) -> bool {
        let s = self.stats();
        s.queued + s.inflight + s.ready > 0
    }
}

// ---------------------------------------------------------------------- worker threads

enum Job {
    View(TileKey),
    Prefetch(TileKey),
}

fn next_job(inner: &Inner) -> Option<Job> {
    let mut w = lock(&inner.work);
    loop {
        if inner.shutdown.load(Ordering::Relaxed) {
            return None;
        }
        if w.ready.len() < READY_CAP {
            let best = w.view.iter().min_by(|a, b| a.1.total_cmp(b.1)).map(|(k, _)| *k);
            if let Some(k) = best {
                w.view.remove(&k);
                w.inflight.insert(k);
                return Some(Job::View(k));
            }
            // idle: low-priority prefetch
            while let Some(k) = w.prefetch.pop_front() {
                if w.inflight.contains(&k) {
                    continue;
                }
                w.inflight.insert(k);
                return Some(Job::Prefetch(k));
            }
        }
        w = inner.cv.wait_timeout(w, Duration::from_millis(250)).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
    }
}

fn worker(inner: Arc<Inner>) {
    while let Some(job) = next_job(&inner) {
        let (key, decode) = match job {
            Job::View(k) => (k, true),
            Job::Prefetch(k) => (k, false),
        };
        let res = process(&inner, key, decode);
        let mut w = lock(&inner.work);
        w.inflight.remove(&key);
        match res {
            Ok(Some(d)) => w.ready.push(d),
            Ok(None) => {}
            Err(f) => {
                let (retry, n) = match f {
                    Failure::NotFound => (NOT_FOUND_RETRY, 0),
                    Failure::Transient => {
                        let n = w.failed.get(&key).map_or(0, |f| f.n) + 1;
                        (NET_RETRY_BASE.saturating_mul(1 << (n - 1).min(3)).min(NET_RETRY_MAX), n)
                    }
                };
                if w.failed.len() > 4096 {
                    let now = Instant::now();
                    w.failed.retain(|_, f| f.until > now);
                }
                w.failed.insert(key, Fail { until: Instant::now() + retry, n });
            }
        }
    }
}

enum Failure {
    NotFound,
    Transient,
}

fn process(inner: &Inner, key: TileKey, decode: bool) -> Result<Option<Decoded>, Failure> {
    let style = styles::style(key.style);
    let path = inner.cache.as_ref().map(|c| c.path(style.id, key.z, key.x, key.y));
    let mut bytes = None;
    if let (Some(c), Some(p)) = (&inner.cache, &path) {
        if !decode && c.contains(p) {
            return Ok(None); // prefetch of something already cached
        }
        if let Some(b) = c.get(p) {
            inner.st.disk_hits.fetch_add(1, Ordering::Relaxed);
            bytes = Some(b);
        }
    }
    let from_net = bytes.is_none();
    let bytes = match bytes {
        Some(b) => b,
        None => match inner.fetcher.fetch(&style.tile_url(key.z, key.x, key.y)) {
            Ok(b) => {
                inner.st.net_ok.fetch_add(1, Ordering::Relaxed);
                inner.st.net_bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                b
            }
            Err(FetchError::NotFound) => {
                inner.st.net_fail.fetch_add(1, Ordering::Relaxed);
                return Err(Failure::NotFound);
            }
            Err(FetchError::Other(_)) => {
                inner.st.net_fail.fetch_add(1, Ordering::Relaxed);
                return Err(Failure::Transient);
            }
        },
    };
    if !decode {
        // prefetch: validate cheaply (magic bytes) and store; decoding happens when the tile is really needed
        if from_net && (bytes.starts_with(&[0x89, b'P', b'N', b'G']) || bytes.starts_with(&[0xFF, 0xD8])) {
            if let (Some(c), Some(p)) = (&inner.cache, &path) {
                c.put(p, &bytes);
            }
        }
        return Ok(None);
    }
    match decode_tile(&bytes) {
        Ok(data) => {
            inner.st.decoded.fetch_add(1, Ordering::Relaxed);
            if from_net {
                if let (Some(c), Some(p)) = (&inner.cache, &path) {
                    if c.put(p, &bytes) {
                        c.prune();
                    }
                }
            }
            Ok(Some(Decoded { key, data }))
        }
        Err(_) => {
            // corrupt cache entry or an HTML error page: never keep it
            if let (Some(c), Some(p)) = (&inner.cache, &path) {
                c.remove(p);
            }
            Err(Failure::Transient)
        }
    }
}

// ---------------------------------------------------------------------- tests

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::tiles::decode::encode_test_png;

    /// Synthetic provider: every tile is a flat colour derived from its coordinates.
    pub struct FakeFetcher {
        pub delay: Duration,
        pub calls: Mutex<Vec<String>>,
        pub missing: Mutex<Vec<String>>,
        pub gate: Mutex<bool>,
        pub gate_cv: Condvar,
    }

    impl FakeFetcher {
        pub fn new(delay_ms: u64) -> Arc<Self> {
            Arc::new(Self { delay: Duration::from_millis(delay_ms), calls: Mutex::new(vec![]), missing: Mutex::new(vec![]), gate: Mutex::new(true), gate_cv: Condvar::new() })
        }
        pub fn close_gate(&self) {
            *self.gate.lock().unwrap() = false;
        }
        pub fn open_gate(&self) {
            *self.gate.lock().unwrap() = true;
            self.gate_cv.notify_all();
        }
    }

    impl Fetcher for FakeFetcher {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, FetchError> {
            let mut g = self.gate.lock().unwrap();
            while !*g {
                g = self.gate_cv.wait(g).unwrap();
            }
            drop(g);
            self.calls.lock().unwrap().push(url.to_string());
            std::thread::sleep(self.delay);
            if self.missing.lock().unwrap().iter().any(|m| url.contains(m.as_str())) {
                return Err(FetchError::NotFound);
            }
            let h = url.bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
            Ok(encode_test_png(256, 256, |_, _| [(h >> 8) as u8, (h >> 16) as u8, h as u8, 255]))
        }
    }

    pub fn wait_for(mut cond: impl FnMut() -> bool, ms: u64) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(ms) {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        cond()
    }

    pub fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("inflight-hub-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn pump_all(hub: &TileHub, want: usize, ms: u64) -> bool {
        let mut out = Vec::new();
        wait_for(
            || {
                hub.take_uploads(TILE_BYTES * 8, &mut out);
                hub.stats().resident >= want
            },
            ms,
        )
    }

    #[test]
    fn tiles_stream_in_and_become_resident() {
        let f = FakeFetcher::new(2);
        let hub = TileHub::with_parts(64, f.clone(), None, 4);
        let k = TileKey::new(0, 3, 2, 3);
        assert!(hub.ensure(k, 1.0).is_none(), "nothing resident yet");
        assert!(pump_all(&hub, 1, 3000));
        let (rk, slot) = hub.ensure(k, 1.0).unwrap();
        assert_eq!(rk, k);
        assert!(slot.layer < 64);
        assert!(!hub.busy() || hub.stats().resident >= 1);
    }

    #[test]
    fn render_thread_calls_never_wait_for_the_network() {
        // a fetcher that blocks completely: request/ensure/lookup/take_uploads must still return immediately
        let f = FakeFetcher::new(0);
        f.close_gate();
        let hub = TileHub::with_parts(64, f.clone(), None, 4);
        let t = Instant::now();
        let mut out = Vec::new();
        for i in 0..20_000u32 {
            hub.request(TileKey::new(0, 10, i % 512, i / 512), (i % 97) as f32);
            hub.lookup(TileKey::new(0, 10, i % 512, 0));
            if i % 100 == 0 {
                hub.take_uploads(TILE_BYTES * 4, &mut out);
                hub.begin_view();
            }
        }
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert!(ms < 400.0, "render-thread hub calls took {ms:.1} ms with a stalled network");
        f.open_gate();
    }

    #[test]
    fn highest_priority_is_fetched_first() {
        let f = FakeFetcher::new(0);
        f.close_gate();
        let hub = TileHub::with_parts(64, f.clone(), None, 1);
        // the single worker grabs one job and blocks on the gate; the rest queue up
        hub.request(TileKey::new(0, 5, 0, 0), 50.0);
        assert!(wait_for(|| hub.stats().inflight == 1, 1000));
        hub.request(TileKey::new(0, 5, 1, 1), 30.0);
        hub.request(TileKey::new(0, 5, 2, 2), 1.0);
        hub.request(TileKey::new(0, 5, 3, 3), 10.0);
        f.open_gate();
        assert!(wait_for(|| f.calls.lock().unwrap().len() == 4, 3000));
        let calls = f.calls.lock().unwrap().clone();
        let order: Vec<&str> = calls.iter().map(|u| u.rsplit('/').nth(1).unwrap()).collect();
        // gate released: remaining jobs run strictly by priority (x of tiles = 2, 3, 1 after the first)
        assert!(order[1].ends_with('2') || calls[1].contains("/2/2"), "{calls:?}");
        assert!(calls[2].contains("/3/3"), "{calls:?}");
        assert!(calls[3].contains("/1/1"), "{calls:?}");
    }

    #[test]
    fn begin_view_cancels_stale_requests() {
        let f = FakeFetcher::new(0);
        f.close_gate();
        let hub = TileHub::with_parts(64, f.clone(), None, 1);
        hub.request(TileKey::new(0, 6, 0, 0), 0.0);
        assert!(wait_for(|| hub.stats().inflight == 1, 1000));
        for i in 1..50 {
            hub.request(TileKey::new(0, 6, i, 0), i as f32);
        }
        assert_eq!(hub.stats().queued, 49);
        hub.begin_view();
        assert_eq!(hub.stats().queued, 0);
        f.open_gate();
        assert!(wait_for(|| hub.stats().inflight == 0 && hub.stats().queued == 0 && hub.stats().ready == 1, 2000));
        assert_eq!(f.calls.lock().unwrap().len(), 1, "stale tiles must not be downloaded");
    }

    #[test]
    fn missing_coverage_falls_back_to_parent_and_is_not_hammered() {
        let f = FakeFetcher::new(0);
        f.missing.lock().unwrap().push("/9/".into()); // provider has nothing at z9
        let hub = TileHub::with_parts(64, f.clone(), None, 2);
        let parent = TileKey::new(0, 8, 10, 10);
        let child = TileKey::new(0, 9, 20, 20);
        hub.ensure(parent, 0.0);
        // wait for the parent tile itself (ensure() also queues its ancestors, which may arrive first)
        let mut up = Vec::new();
        assert!(wait_for(
            || {
                hub.take_uploads(TILE_BYTES * 8, &mut up);
                hub.ensure(parent, 0.0).map_or(false, |b| b.0 == parent)
            },
            3000
        ));
        hub.ensure(child, 0.0); // first attempt: z9 -> 404
        assert!(wait_for(|| hub.is_failed(child), 3000));
        let n = f.calls.lock().unwrap().len();
        let best = hub.ensure(child, 0.0).expect("parent covers the child");
        assert_eq!(best.0, parent);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(f.calls.lock().unwrap().len(), n, "a 404 tile must not be re-requested during back-off");
    }

    #[test]
    fn disk_cache_serves_second_run_without_network() {
        let dir = tmp_dir("persist");
        let k = TileKey::new(0, 4, 5, 6);
        {
            let f = FakeFetcher::new(0);
            let hub = TileHub::with_parts(32, f.clone(), Some(DiskCache::open(dir.clone(), 1 << 28)), 2);
            hub.request(k, 0.0);
            assert!(pump_all(&hub, 1, 3000));
            assert_eq!(f.calls.lock().unwrap().len(), 1);
        }
        let f2 = FakeFetcher::new(0);
        let hub2 = TileHub::with_parts(32, f2.clone(), Some(DiskCache::open(dir.clone(), 1 << 28)), 2);
        hub2.request(k, 0.0);
        assert!(pump_all(&hub2, 1, 3000));
        assert!(f2.calls.lock().unwrap().is_empty(), "tile must come from the disk cache");
        assert_eq!(hub2.stats().disk_hits, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lru_eviction_never_removes_used_or_pinned_tiles() {
        let f = FakeFetcher::new(0);
        let hub = TileHub::with_parts(8, f.clone(), None, 4);
        let pinned = TileKey::new(0, 2, 1, 1);
        hub.ensure(pinned, 0.0);
        assert!(pump_all(&hub, 1, 3000));
        // fill and overflow the 8 layers with z10 tiles, advancing frames so older ones become evictable
        for round in 0..6u32 {
            for i in 0..4u32 {
                hub.ensure(TileKey::new(0, 10, round * 4 + i, 0), 0.0);
            }
            hub.next_frame();
            hub.next_frame();
            hub.next_frame();
        }
        let mut out = Vec::new();
        assert!(
            wait_for(
                || {
                    hub.next_frame();
                    hub.take_uploads(TILE_BYTES * 8, &mut out);
                    hub.stats().evicted > 0
                },
                4000,
            ),
            "no eviction happened: {:?}",
            hub.stats()
        );
        let s = hub.stats();
        assert!(s.resident <= 8, "{s:?}");
        assert!(hub.peek(pinned).is_some(), "pinned base tile evicted");
        assert!(s.evicted > 0, "no eviction happened: {s:?}");
    }


    #[test]
    fn corrupt_responses_are_rejected_and_retried_later() {
        struct Html;
        impl Fetcher for Html {
            fn fetch(&self, _: &str) -> Result<Vec<u8>, FetchError> {
                Ok(b"<html>429 Too Many Requests</html>".to_vec())
            }
        }
        let hub = TileHub::with_parts(16, Arc::new(Html), None, 2);
        let k = TileKey::new(0, 5, 1, 1);
        hub.ensure(k, 0.0);
        assert!(wait_for(|| hub.is_failed(k), 2000));
        assert_eq!(hub.stats().resident, 0);
    }
}
