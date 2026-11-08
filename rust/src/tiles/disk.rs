//! Persistent on-disk tile cache with size-bounded LRU eviction (oldest-modified first).
//!
//! Layout: `<root>/<style id>/<z>/<x>/<y>.tile` holding the provider's original PNG / JPEG bytes. Reads touch the mtime
//! (at most hourly) so frequently used tiles survive pruning. All I/O happens on loader threads, never on the render thread.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TOUCH_AFTER: Duration = Duration::from_secs(3600);
/// A prune pass is triggered every this many writes.
const PRUNE_EVERY: u32 = 400;

pub struct DiskCache {
    root: PathBuf,
    max_bytes: u64,
    writes: AtomicU32,
    seq: AtomicU64,
}

/// `INFLIGHT_TILE_CACHE`, else the platform cache directory.
pub fn default_root() -> PathBuf {
    if let Some(p) = std::env::var_os("INFLIGHT_TILE_CACHE") {
        return PathBuf::from(p);
    }
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library").join("Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".cache")))
    };
    base.unwrap_or_else(std::env::temp_dir).join("inflight").join("tiles")
}

pub fn default_max_bytes() -> u64 {
    std::env::var("INFLIGHT_TILE_CACHE_MB").ok().and_then(|s| s.parse::<u64>().ok()).map(|mb| mb * 1024 * 1024).unwrap_or(DEFAULT_MAX_BYTES)
}

impl DiskCache {
    pub fn open(root: PathBuf, max_bytes: u64) -> Self {
        let _ = fs::create_dir_all(&root);
        Self { root, max_bytes, writes: AtomicU32::new(0), seq: AtomicU64::new(0) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, style: &str, z: u8, x: u32, y: u32) -> PathBuf {
        self.root.join(style).join(z.to_string()).join(x.to_string()).join(format!("{y}.tile"))
    }

    pub fn contains(&self, p: &Path) -> bool {
        p.is_file()
    }

    pub fn get(&self, p: &Path) -> Option<Vec<u8>> {
        let data = fs::read(p).ok()?;
        if data.is_empty() {
            let _ = fs::remove_file(p);
            return None;
        }
        if let Ok(meta) = fs::metadata(p) {
            let old = meta.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).is_some_and(|d| d > TOUCH_AFTER);
            if old {
                if let Ok(f) = fs::OpenOptions::new().write(true).open(p) {
                    let _ = f.set_modified(SystemTime::now());
                }
            }
        }
        Some(data)
    }

    pub fn remove(&self, p: &Path) {
        let _ = fs::remove_file(p);
    }

    /// Atomic write (temp file + rename) so a crash never leaves a truncated tile behind. Returns true when a prune
    /// pass is due.
    pub fn put(&self, p: &Path, data: &[u8]) -> bool {
        if let Some(dir) = p.parent() {
            if fs::create_dir_all(dir).is_err() {
                return false;
            }
        }
        let tmp = p.with_extension(format!("tmp{}-{}", std::process::id(), self.seq.fetch_add(1, Ordering::Relaxed)));
        let ok = fs::File::create(&tmp).and_then(|mut f| f.write_all(data)).is_ok() && fs::rename(&tmp, p).is_ok();
        if !ok {
            let _ = fs::remove_file(&tmp);
            return false;
        }
        self.writes.fetch_add(1, Ordering::Relaxed) % PRUNE_EVERY == PRUNE_EVERY - 1
    }

    /// Total size of all cached tiles and the listing (mtime, len, path).
    fn scan(&self) -> (u64, Vec<(SystemTime, u64, PathBuf)>) {
        let mut files = Vec::new();
        let mut total = 0u64;
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let Ok(meta) = e.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(e.path());
                } else {
                    total += meta.len();
                    files.push((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len(), e.path()));
                }
            }
        }
        (total, files)
    }

    pub fn size_bytes(&self) -> u64 {
        self.scan().0
    }

    /// Deletes the least recently used tiles until the cache is below 90 % of its limit. Returns bytes freed.
    pub fn prune(&self) -> u64 {
        let (mut total, mut files) = self.scan();
        if total <= self.max_bytes {
            return 0;
        }
        files.sort_by_key(|f| f.0);
        let target = self.max_bytes / 10 * 9;
        let before = total;
        for (_, len, path) in files {
            if total <= target {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(len);
            }
        }
        before - total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("inflight-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn put_get_roundtrip_and_layout() {
        let root = tmp("rt");
        let c = DiskCache::open(root.clone(), 1 << 20);
        let p = c.path("sat", 5, 17, 11);
        assert!(p.ends_with("sat/5/17/11.tile") || p.ends_with("sat\\5\\17\\11.tile"));
        assert!(c.get(&p).is_none());
        c.put(&p, b"hello tile");
        assert_eq!(c.get(&p).unwrap(), b"hello tile");
        assert!(c.contains(&p));
        c.remove(&p);
        assert!(c.get(&p).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prune_evicts_oldest_first_down_to_90_percent() {
        let root = tmp("prune");
        let c = DiskCache::open(root.clone(), 1000);
        for i in 0..20u32 {
            let p = c.path("sat", 3, i, 0);
            c.put(&p, &[7u8; 100]);
            // age files deterministically: lower i = older
            let f = fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 + i as u64 * 100)).unwrap();
        }
        assert_eq!(c.size_bytes(), 2000);
        let freed = c.prune();
        assert!(freed >= 1100, "freed {freed}");
        assert!(c.size_bytes() <= 900);
        assert!(c.get(&c.path("sat", 3, 19, 0)).is_some(), "newest tile must survive");
        assert!(c.get(&c.path("sat", 3, 0, 0)).is_none(), "oldest tile must be gone");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_files_are_treated_as_misses() {
        let root = tmp("empty");
        let c = DiskCache::open(root.clone(), 1000);
        let p = c.path("osm", 1, 0, 0);
        c.put(&p, b"");
        assert!(c.get(&p).is_none());
        assert!(!c.contains(&p));
        let _ = fs::remove_dir_all(root);
    }
}
