// Fully procedural WebAudio: engines, wind, rolling, warnings (stall / overspeed / GPWS / gear / bank), one-shots and voice callouts.
export type WarnSound = 'stall' | 'overspeed' | 'pullup' | 'terrain' | 'gear' | 'bank' | 'sink' | 'config' | 'fuel' | null;

export interface AudioState {
  kind: 'piston' | 'turboprop' | 'jet'; n: number; thrust: number; ias: number; tas: number; wow: boolean; gs: number; view: 'inside' | 'outside'; cabin: boolean; sound: WarnSound; paused: boolean; mood: number; agl: number; vol: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null; master!: GainNode; sfx!: GainNode;
  private noise!: AudioBuffer;
  private eng: { o1: OscillatorNode; o2: OscillatorNode; g1: GainNode; g2: GainNode; ng: GainNode; nf: BiquadFilterNode; wh: OscillatorNode; whg: GainNode; lp: BiquadFilterNode } | null = null;
  private wind!: { g: GainNode; f: BiquadFilterNode }; private roll!: { g: GainNode; f: BiquadFilterNode }; private murmur!: { g: GainNode };
  private warn!: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode; ng: GainNode; nf: BiquadFilterNode; nG: GainNode };
  muted = false; volume = 0.8; voiceOn = true;
  private lastSpeak: Record<string, number> = {};
  private cur: WarnSound = null; private warnT = 0;

  /** must be called from a user gesture */
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    try { this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volume; this.master.connect(c.destination);
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; comp.connect(this.master);
    this.sfx = c.createGain(); this.sfx.connect(comp);
    const len = c.sampleRate * 2; this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0); let b0 = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.97 * b0 + 0.03 * w; d[i] = w * 0.6 + b0 * 3; }
    const noiseSrc = () => { const s = c.createBufferSource(); s.buffer = this.noise; s.loop = true; s.start(); return s; };
    // engine bed
    const o1 = c.createOscillator(), o2 = c.createOscillator(), wh = c.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square'; wh.type = 'sine';
    const g1 = c.createGain(), g2 = c.createGain(), whg = c.createGain(), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const ng = c.createGain(), nf = c.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 800;
    g1.gain.value = g2.gain.value = whg.gain.value = ng.gain.value = 0;
    o1.connect(g1).connect(lp); o2.connect(g2).connect(lp); wh.connect(whg).connect(lp); noiseSrc().connect(nf).connect(ng).connect(lp); lp.connect(this.sfx);
    o1.start(); o2.start(); wh.start(); this.eng = { o1, o2, g1, g2, ng, nf, wh, whg, lp };
    // wind
    const wg = c.createGain(), wf = c.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 0.6; wg.gain.value = 0; noiseSrc().connect(wf).connect(wg).connect(this.sfx); this.wind = { g: wg, f: wf };
    const rg = c.createGain(), rf = c.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 180; rg.gain.value = 0; noiseSrc().connect(rf).connect(rg).connect(this.sfx); this.roll = { g: rg, f: rf };
    const mg = c.createGain(), mf = c.createBiquadFilter(); mf.type = 'bandpass'; mf.frequency.value = 500; mf.Q.value = 0.8; mg.gain.value = 0; noiseSrc().connect(mf).connect(mg).connect(this.sfx); this.murmur = { g: mg };
    // warning voice bus
    const wo1 = c.createOscillator(), wo2 = c.createOscillator(), wgn = c.createGain(); wo1.type = 'square'; wo2.type = 'sawtooth'; wgn.gain.value = 0;
    const wnf = c.createBiquadFilter(); wnf.type = 'bandpass'; wnf.frequency.value = 2500; wnf.Q.value = 1.2; const nG = c.createGain(); nG.gain.value = 0; const wng = c.createGain(); wng.gain.value = 1;
    wo1.connect(wgn); wo2.connect(wgn); wgn.connect(this.sfx); noiseSrc().connect(wnf).connect(nG).connect(this.sfx); void wng;
    wo1.start(); wo2.start(); this.warn = { o1: wo1, o2: wo2, g: wgn, ng: wgn, nf: wnf, nG };
  }
  setVolume(v: number) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx!.currentTime, 0.05); }
  setMuted(m: boolean) { this.muted = m; if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx!.currentTime, 0.05); if (m) window.speechSynthesis?.cancel(); }

  update(s: AudioState, dt: number) {
    const c = this.ctx; if (!c || !this.eng) return;
    const T = c.currentTime, tc = 0.06;
    const inside = s.view === 'inside', mul = s.paused ? 0 : 1;
    const e = this.eng;
    const n = isFinite(s.n) ? Math.max(0, Math.min(1.5, s.n)) : 0;
    if (s.kind === 'piston') {
      const f = 28 + n * 55; e.o1.frequency.setTargetAtTime(f, T, tc); e.o2.frequency.setTargetAtTime(f * 0.5 + (Math.random() - 0.5) * 0.8, T, tc);
      e.g1.gain.setTargetAtTime((0.16 + 0.12 * n) * mul, T, tc); e.g2.gain.setTargetAtTime(0.11 * mul, T, tc); e.whg.gain.setTargetAtTime(0, T, tc);
      e.lp.frequency.setTargetAtTime((inside ? 700 : 1400) + n * 900, T, tc); e.ng.gain.setTargetAtTime(0.08 * n * mul, T, tc); e.nf.frequency.setTargetAtTime(600 + n * 900, T, tc);
    } else if (s.kind === 'turboprop') {
      const f = 55 + n * 40; e.o1.frequency.setTargetAtTime(f, T, tc); e.o2.frequency.setTargetAtTime(f * 2.01, T, tc);
      e.g1.gain.setTargetAtTime(0.1 * mul, T, tc); e.g2.gain.setTargetAtTime(0.05 * mul, T, tc); e.wh.frequency.setTargetAtTime(700 + n * 1800, T, tc); e.whg.gain.setTargetAtTime(0.025 * n * mul, T, tc);
      e.lp.frequency.setTargetAtTime((inside ? 900 : 2200) + n * 1200, T, tc); e.ng.gain.setTargetAtTime((0.12 * n + 0.04) * mul, T, tc); e.nf.frequency.setTargetAtTime(500 + n * 1500, T, tc);
    } else {
      e.o1.frequency.setTargetAtTime(60 + n * 30, T, tc); e.g1.gain.setTargetAtTime(0.04 * n * mul, T, tc); e.g2.gain.setTargetAtTime(0, T, tc);
      e.wh.frequency.setTargetAtTime(900 + n * 3600, T, tc); e.whg.gain.setTargetAtTime((inside ? 0.01 : 0.05) * n * mul, T, tc);
      e.lp.frequency.setTargetAtTime((inside ? 800 : 3200) + n * 2500, T, tc); e.ng.gain.setTargetAtTime((0.05 + 0.34 * Math.pow(n, 1.6)) * (inside ? 0.45 : 1) * mul, T, tc); e.nf.frequency.setTargetAtTime(300 + n * 1800, T, tc);
    }
    if (s.cabin && s.kind === 'jet') { e.lp.frequency.setTargetAtTime(500, T, 0.2); }
    const tas = isFinite(s.tas) ? Math.max(0, s.tas) : 0;
    const gs = isFinite(s.gs) ? Math.max(0, s.gs) : 0;
    const v = Math.min(1, tas / 150);
    this.wind.g.gain.setTargetAtTime((0.02 + 0.42 * v * v) * (inside ? 0.55 : 0.9) * mul, T, 0.1);
    this.wind.f.frequency.setTargetAtTime(Math.max(20, 350 + tas * 9), T, 0.1);
    this.roll.g.gain.setTargetAtTime(s.wow ? Math.min(0.5, gs / 70) * 0.5 * mul : 0, T, 0.08);
    this.roll.f.frequency.setTargetAtTime(Math.max(20, 120 + gs * 4), T, 0.1);
    this.murmur.g.gain.setTargetAtTime(s.cabin ? (0.05 + 0.1 * (1 - s.mood)) * mul : 0, T, 0.3);
    // ---- warnings ----
    const w = this.warn; this.warnT += dt;
    let g = 0, f1 = 0, f2 = 0, ng = 0;
    const t = this.warnT;
    switch (s.sound) {
      case 'stall': { const on = (t % 0.5) < 0.32; g = on ? 0.2 : 0; f1 = 790; f2 = 1170; break; }
      case 'overspeed': { const on = (t % 0.09) < 0.045; ng = on ? 0.5 : 0; g = 0; break; }
      case 'pullup': { const on = (t % 0.7) < 0.25; g = on ? 0.2 : 0; f1 = 1480; f2 = 1480; break; }
      case 'terrain': { const on = (t % 1.0) < 0.3; g = on ? 0.16 : 0; f1 = 1100; f2 = 1100; break; }
      case 'sink': { const on = (t % 0.9) < 0.25; g = on ? 0.15 : 0; f1 = 740; f2 = 740; break; }
      case 'gear': { const on = (t % 0.6) < 0.35; g = on ? 0.16 : 0; f1 = 420; f2 = 421; break; }
      case 'config': { const on = (t % 0.16) < 0.1; g = on ? 0.14 : 0; f1 = 640; f2 = 645; break; }
      case 'bank': { const on = (t % 1.2) < 0.15; g = on ? 0.14 : 0; f1 = 1320; f2 = 1330; break; }
      case 'fuel': { const on = (t % 2) < 0.3; g = on ? 0.1 : 0; f1 = 900; f2 = 1200; break; }
    }
    if (s.sound !== this.cur) { this.cur = s.sound; this.warnT = 0; }
    if (f1) { w.o1.frequency.setTargetAtTime(f1, T, 0.005); w.o2.frequency.setTargetAtTime(f2, T, 0.005); }
    w.g.gain.setTargetAtTime(g * mul, T, 0.01); w.nG.gain.setTargetAtTime(ng * mul, T, 0.005);
  }

  // ---------- one-shots ----------
  private burst(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number, delay = 0) {
    const c = this.ctx; if (!c) return; const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g).connect(this.sfx); o.start(t); o.stop(t + dur + 0.05);
  }
  private noiseBurst(dur: number, gain: number, f0: number, f1: number, type: BiquadFilterType = 'lowpass') {
    const c = this.ctx; if (!c) return; const t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noise; const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.connect(f).connect(g).connect(this.sfx); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  touchdown(severity: number) { this.noiseBurst(0.35, 0.5 + Math.min(1, severity) * 0.6, 500, 60); this.burst(90, 0.3, 0.5, 'sine', 40); this.noiseBurst(0.5, 0.18, 4200, 1500, 'bandpass'); }
  chirp() { this.noiseBurst(0.3, 0.15, 3800, 1800, 'bandpass'); }
  gearClunk() { this.burst(120, 0.18, 0.4, 'square', 50); this.noiseBurst(0.2, 0.2, 800, 100); }
  click() { this.burst(1800, 0.03, 0.12, 'square'); }
  chime() { this.burst(1318, 0.5, 0.18); this.burst(1046, 0.7, 0.16, 'sine', undefined, 0.2); }
  ding() { this.burst(880, 0.9, 0.2); }
  apOff() { for (let i = 0; i < 4; i++) { this.burst(i % 2 ? 700 : 1000, 0.13, 0.18, 'square', undefined, i * 0.14); } }
  apOn() { this.burst(900, 0.1, 0.12, 'sine'); this.burst(1200, 0.1, 0.12, 'sine', undefined, 0.1); }
  crash() { this.noiseBurst(2.4, 1.0, 1600, 50); this.burst(70, 1.4, 0.9, 'sawtooth', 25); }
  scrape() { this.noiseBurst(0.25, 0.25, 3000, 900, 'bandpass'); }
  applause() { this.noiseBurst(1.8, 0.2, 3000, 2500, 'bandpass'); }
  pa() { this.burst(1000, 0.08, 0.15, 'sine'); this.burst(1500, 0.14, 0.15, 'sine', undefined, 0.1); }
  speak(text: string, key = text, cooldown = 3, rate = 1.05, pitch = 0.9) {
    if (this.muted || !this.voiceOn || typeof speechSynthesis === 'undefined') return;
    const now = performance.now() / 1000;
    if (now - (this.lastSpeak[key] || -99) < cooldown) return;
    this.lastSpeak[key] = now;
    try { const u = new SpeechSynthesisUtterance(text); u.rate = rate; u.pitch = pitch; u.volume = Math.min(1, this.volume + 0.2); speechSynthesis.speak(u); } catch { /* ignore */ }
  }
  silence() { if (this.ctx && this.eng) { const T = this.ctx.currentTime; this.eng.g1.gain.setTargetAtTime(0, T, 0.05); this.eng.g2.gain.setTargetAtTime(0, T, 0.05); this.eng.ng.gain.setTargetAtTime(0, T, 0.05); this.eng.whg.gain.setTargetAtTime(0, T, 0.05); this.warn.g.gain.setTargetAtTime(0, T, 0.02); this.warn.nG.gain.setTargetAtTime(0, T, 0.02); } window.speechSynthesis?.cancel(); }
}
