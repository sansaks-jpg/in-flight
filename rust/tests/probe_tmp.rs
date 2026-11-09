use inflight::addons::AddonManager;
use inflight::glb;
#[test]
fn probe() {
    let Some((bytes, _man)) = AddonManager::new().read_installed() else { return eprintln!("no addon") };
    let g = glb::parse(&bytes).unwrap();
    for m in &g.meshes {
        let n = m.name.as_str();
        if n.starts_with("mcdu1") || n.starts_with("mcdu2") || n.starts_with("trim_") || n.starts_with("mcdu") {
            let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
            for p in &m.pos { for k in 0..3 { mn[k] = mn[k].min(p[k]); mx[k] = mx[k].max(p[k]); } }
            println!("NODE {n} verts={} tris={} min={:?} max={:?}", m.pos.len(), m.idx.len()/3, mn, mx);
            if n.starts_with("trim_") {
                // radial distance from candidate axis (x=cx,y=cy), axis along z
                let cx = (mn[0]+mx[0])*0.5; let cy = (mn[1]+mx[1])*0.5;
                let mut hist = [0usize; 10];
                for p in &m.pos { let r = ((p[0]-cx).powi(2)+(p[1]-cy).powi(2)).sqrt(); let b = ((r/0.14)*10.0).min(9.0) as usize; hist[b]+=1; }
                println!("   radial hist (0..0.14m) {:?}", hist);
                let mut zs: Vec<i32> = m.pos.iter().map(|p| (p[2]*100.0).round() as i32).collect(); zs.sort(); zs.dedup(); println!("   z cm values {:?}", zs.iter().take(40).collect::<Vec<_>>());
            }
        }
        if n.contains("mcdu") && !n.contains("screen") && m.pos.len() > 0 && !n.contains('.') { }
    }
    let mut names: Vec<&str> = g.meshes.iter().map(|m| m.name.as_str()).filter(|n| n.contains("mcdu") || n.contains("MCDU") || n.contains("trim") || n.starts_with("thr_") || n.contains("Thr")).collect();
    names.sort(); println!("NAMES {:?}", names);
}
