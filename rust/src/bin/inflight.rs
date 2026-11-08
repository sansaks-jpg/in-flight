//! In-Flight native desktop game.
//!
//! usage: inflight [--dep KSFO] [--arr KOAK] [--autostart] [--uncapped] [--frames N]
use inflight::app::{run, Options};

fn main() {
    let mut o = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--dep" => o.dep = args.next().unwrap_or_default().to_uppercase(),
            "--arr" => o.arr = args.next().unwrap_or_default().to_uppercase(),
            "--autostart" => o.autostart = true,
            "--uncapped" => o.uncapped = true,
            "--frames" => o.max_frames = args.next().and_then(|v| v.parse().ok()),
            "-h" | "--help" => {
                println!("inflight [--dep ICAO] [--arr ICAO] [--autostart] [--uncapped] [--frames N]");
                return;
            }
            other => eprintln!("ignoring unknown argument {other}"),
        }
    }
    run(o);
}
