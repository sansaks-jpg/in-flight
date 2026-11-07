// One owner for every spoken line in the sim (ATC, pilot readbacks, crew callouts, cabin PA, GPWS / aircraft voice).
//
// Why a single bus: the browser has exactly ONE global speechSynthesis queue. The old design let the ATC radio and the
// audio engine each push utterances into it and each call speechSynthesis.cancel()/pause() on their own, so one subsystem
// regularly killed or froze the other's line ("audio sometimes silent", "voice keeps talking while paused").
//
// Browser quirks handled here (verified against Chromium / MDN reports, see AGENTS.md section 7):
//   * An utterance that nothing references can be garbage-collected mid-speech and then never fires `end`   -> we hold refs.
//   * Chrome silently drops an utterance spoken in the same tick as cancel()                                  -> speak >= 90 ms later.
//   * Desktop Chrome stops long utterances after ~15 s with no event                                          -> one utterance per sentence chunk.
//   * pause()/resume() is unreliable (Android Chrome implements pause as cancel; network voices get stuck)    -> never used:
//     suspending cancels the active line and REPLAYS it from the start on resume (a radio call repeated is natural).
//   * No voices / blocked by the autoplay policy (`not-allowed`) / `start` never fires                        -> a watchdog switches
//     the line to timed, silent playback so the transcript, queue order and gameplay triggers never stall.
export type VoicePersona = 'controller' | 'controllerF' | 'pilot' | 'fo' | 'pa' | 'machine' | 'atis';
/** What kind of transmission this is — drives the transcript styling. */
export type CaptionKind = 'atc' | 'pilot' | 'crew' | 'pa' | 'auto' | 'warning';
export interface Caption {
  id: number; kind: CaptionKind;
  /** raw sender code: TOWER, GROUND, PILOT, FO, CABIN, AUTO ... */
  who: string;
  /** speaker label shown in the UI (Tower, Skyline 123, First Officer ...) */
  label: string;
  /** English transcript (what is actually spoken) */
  text: string;
  /** Hand-written Indonesian transcript; ATC lines without one are translated rule-based at display time. */
  textId?: string;
}
export interface Utterance {
  /** de-duplication / cooldown key */
  key: string;
  /** text handed to the TTS engine */
  speech: string;
  persona: VoicePersona;
  /** 0 chatter / 1 ATC, PA, crew talk / 2 callouts / 3 warnings (a higher priority cuts a lower one) */
  priority: 0 | 1 | 2 | 3;
  caption?: Caption;
  rate?: number; pitch?: number; volume?: number;
  /** seconds the line stays relevant while it waits (flight-clock time: does not drain while paused) */
  ttl?: number;
  cooldown?: number;
  /** replay from the start if cut by a pause or by a higher-priority line (default: priority <= 1) */
  replay?: boolean;
  /** never started during a sterile phase (take-off roll, final approach): PA, nudges, small talk */
  holdWhenSterile?: boolean;
  /** may play as a silent, timed transcript when voice is off / muted (default: captioned lines only) */
  silentOk?: boolean;
  /** `first` is true the first time this line goes on air (replays pass false) */
  onStart?: (first: boolean) => void;
  onEnd?: (completed: boolean) => void;
}
export interface VoiceRequest { text: string; persona: VoicePersona; rate: number; pitch: number; volume: number }
export interface VoiceCallbacks { started: () => void; ended: () => void; failed: (reason: string) => void }
export interface VoiceDriver { speak: (req: VoiceRequest, cb: VoiceCallbacks) => void; cancel: () => void }
export interface VoiceHooks {
  /** voice enabled, not muted, volume > 0 */
  audible: () => boolean;
  /** a captioned line is on the air (null = quiet) */
  onLive?: (c: Caption | null) => void;
  /** first time a captioned line goes on air: append to the transcript history */
  onLog?: (c: Caption) => void;
}

interface Item { u: Utterance; expires: number; seq: number; attempts: number; started: boolean }
const defaultTtl = (p: number) => (p >= 3 ? 2.5 : p === 2 ? 3.5 : p === 1 ? 45 : 20);
/** Spoken duration estimate (s) — also the playback time of a silent, transcript-only line. */
export const speechSeconds = (text: string) => Math.max(1.4, text.split(/\s+/).length / 2.6 + 0.5);

const setT = (fn: () => void, ms: number): number => (typeof window !== 'undefined' ? window.setTimeout(fn, ms) : (setTimeout(fn, ms) as unknown as number));
const clearT = (t: number) => { if (t) clearTimeout(t); };

export class VoiceBus {
  private pending: Item[] = []; private active: Item | null = null;
  private lastSpoken = new Map<string, number>();
  private gen = 0; private seq = 0; private simTimer = 0; private warningKey: string | null = null;
  private running = false; private suspendedAt = 0; private pausedTotal = 0;
  private spoke = false; // the active line is currently being voiced by the driver
  private ttsFailures = 0; private ttsBackoffUntil = 0;
  /** Sterile phase (set by the comms director): items flagged holdWhenSterile wait. */
  sterile = false;
  constructor(private driver: VoiceDriver | null, private hooks: VoiceHooks, private rawNow = () => performance.now() / 1000, private capacity = 10) {}

  get isRunning() { return this.running; }
  get pendingCount() { return this.pending.length + (this.active ? 1 : 0); }
  get activeKey() { return this.active?.u.key ?? null; }
  /** flight-clock seconds: stands still while the bus is suspended so queued TTLs do not drain during a pause */
  private clock() { return this.rawNow() - this.pausedTotal - (this.running ? 0 : this.rawNow() - this.suspendedAt); }

  canSay(key: string, cooldown = 0): boolean {
    if (this.active?.u.key === key || this.clock() - (this.lastSpoken.get(key) ?? -Infinity) < cooldown) return false;
    return !this.pending.some((i) => i.u.key === key);
  }

  say(u: Utterance): boolean {
    if (!this.canSay(u.key, u.cooldown ?? 0)) return false;
    if (!this.running && u.priority >= 2) return false; // callouts / warnings are only meaningful while flying
    if (!this.hooks.audible() && !(u.silentOk ?? !!u.caption)) return false; // GPWS words etc. are pointless without sound
    const now = this.clock();
    this.prune(now);
    // a stale altitude callout must never play after a newer one has been crossed
    if (u.priority === 2) this.removePending((i) => i.u.priority === 2);
    if (this.pending.length >= this.capacity) {
      let drop = -1;
      for (let i = 0; i < this.pending.length; i++) if (this.pending[i].u.priority <= u.priority && (drop < 0 || this.pending[i].u.priority < this.pending[drop].u.priority)) drop = i;
      if (drop < 0) return false;
      this.finishDropped(this.pending.splice(drop, 1)[0]);
    }
    this.pending.push({ u, expires: now + (u.ttl ?? defaultTtl(u.priority)), seq: ++this.seq, attempts: 0, started: false });
    // safety speech / callouts cut a lower-priority line that is still talking
    if (this.active && u.priority > this.active.u.priority) this.stopActive(this.active.u.replay ?? this.active.u.priority <= 1);
    this.pump();
    return true;
  }

  /** The flight-model warning that is currently true. Anything older is obsolete the moment the condition clears. */
  retainWarning(key: string | null) {
    if (this.warningKey === key) return;
    this.warningKey = key;
    this.removePending((i) => i.u.priority === 3 && i.u.key !== key);
    if (this.active?.u.priority === 3 && this.active.u.key !== key) this.stopActive(false);
    this.pump();
  }

  /** The flight is running (true) or not (paused / menu / loading / hidden tab / ended). */
  setRunning(run: boolean) {
    if (run === this.running) return; // per-frame callers: a no-op must stay a no-op
    if (run) { this.pausedTotal += this.rawNow() - this.suspendedAt; this.running = true; this.pump(); return; }
    this.suspendedAt = this.rawNow(); this.running = false;
    // Never pause() the synth: cancel and replay. Callouts / warnings are stale after a pause and are dropped.
    if (this.active) this.stopActive((this.active.u.replay ?? true) && this.active.u.priority <= 1);
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].u.priority >= 2) this.finishDropped(this.pending.splice(i, 1)[0]);
  }

  /** Voice turned off / muted / volume 0: stop talking now, but let the active line finish as a silent transcript. */
  audibilityChanged() {
    if (!this.active || !this.spoke || this.hooks.audible()) return;
    const item = this.active, token = ++this.gen; this.spoke = false;
    try { this.driver?.cancel(); } catch { /* ignore */ }
    this.simulate(item, token, speechSeconds(item.u.speech) * 1000);
  }

  /** Drop everything (new flight / menu / crash). */
  clear() { this.cancelWhere(() => true); this.warningKey = null; this.lastSpoken.clear(); }
  cancelWhere(pred: (u: Utterance) => boolean) {
    for (let i = this.pending.length - 1; i >= 0; i--) if (pred(this.pending[i].u)) this.finishDropped(this.pending.splice(i, 1)[0]);
    if (this.active && pred(this.active.u)) this.stopActive(false);
  }
  /** Called when `sterile` flips so held lines are released. */
  poke() { this.pump(); }

  // ---- internals ----
  private removePending(pred: (i: Item) => boolean) {
    for (let i = this.pending.length - 1; i >= 0; i--) if (pred(this.pending[i])) this.finishDropped(this.pending.splice(i, 1)[0]);
  }
  private prune(now: number) { this.removePending((i) => i.expires < now); }
  private finishDropped(i: Item) { try { i.u.onEnd?.(false); } catch { /* listener errors must not break the queue */ } }
  private unlive() { if (this.active?.u.caption) this.hooks.onLive?.(null); }

  private stopActive(requeue: boolean) {
    const item = this.active; if (!item) return;
    this.gen++; clearT(this.simTimer); this.spoke = false; this.unlive(); this.active = null;
    try { this.driver?.cancel(); } catch { /* ignore */ }
    if (requeue && item.attempts < 2) { item.attempts++; item.expires = this.clock() + (item.u.ttl ?? defaultTtl(item.u.priority)); this.pending.unshift(item); }
    else this.finishDropped(item);
  }

  private pump() {
    if (!this.running || this.active) return;
    const now = this.clock(); this.prune(now);
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const it = this.pending[i];
      if (this.sterile && it.u.holdWhenSterile) continue;
      if (best < 0 || it.u.priority > this.pending[best].u.priority) best = i;
    }
    if (best < 0) return;
    this.start(this.pending.splice(best, 1)[0]);
  }

  private start(item: Item) {
    const u = item.u, token = ++this.gen; this.active = item;
    this.lastSpoken.set(u.key, this.clock());
    const first = !item.started; item.started = true;
    if (u.caption) { if (first) this.hooks.onLog?.(u.caption); this.hooks.onLive?.(u.caption); }
    try { u.onStart?.(first); } catch { /* ignore */ }
    const ms = speechSeconds(u.speech) * 1000;
    const canVoice = !!this.driver && this.hooks.audible() && this.clock() >= this.ttsBackoffUntil;
    if (!canVoice) { this.simulate(item, token, ms); return; }
    this.spoke = true;
    // watchdog for an engine that never reports `end` (GC'd utterance, killed synth, 15 s bug)
    this.simTimer = setT(() => { if (token === this.gen) { try { this.driver?.cancel(); } catch { /* ignore */ } this.spoke = false; this.finish(item, token, true); } }, ms * 2.4 + 3500);
    try {
      this.driver!.speak({ text: u.speech, persona: u.persona, rate: u.rate ?? 1.05, pitch: u.pitch ?? 1, volume: Math.min(1, u.volume ?? 1) }, {
        started: () => { if (token === this.gen) this.ttsFailures = 0; },
        ended: () => this.finish(item, token, true),
        failed: () => {
          if (token !== this.gen) return;
          // the engine is mute for this line: keep the exchange moving as a silent, timed transcript
          if (++this.ttsFailures >= 3) this.ttsBackoffUntil = this.clock() + 25;
          this.spoke = false; this.simulate(item, token, ms);
        },
      });
    } catch { this.spoke = false; this.simulate(item, token, ms); }
  }
  private simulate(item: Item, token: number, ms: number) {
    clearT(this.simTimer);
    this.simTimer = setT(() => this.finish(item, token, true), ms);
  }
  private finish(item: Item, token: number, completed: boolean) {
    if (token !== this.gen || this.active !== item) return; // stale event from a cancelled line
    clearT(this.simTimer); this.spoke = false; this.unlive(); this.active = null;
    this.lastSpoken.set(item.u.key, this.clock());
    try { item.u.onEnd?.(completed); } catch { /* ignore */ }
    this.pump();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Web Speech driver
// ---------------------------------------------------------------------------------------------------------------
/** Sentence-sized chunks (<= max chars): keeps every utterance well below Chrome's ~15 s cut-off. */
export function chunkSpeech(text: string, max = 170): string[] {
  const parts = text.match(/[^.!?;]+[.!?;]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= max) { out.push(p); continue; }
    let cur = '';
    for (const w of p.split(/\s+/)) { if ((cur + ' ' + w).length > max && cur) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
    if (cur) out.push(cur);
  }
  return out.length ? out : [text];
}

const MALE = /male|daniel|david|george|alex|fred|mark|guy|ryan|james|thomas|oliver|arthur|google uk english male/i;
const FEMALE = /female|samantha|zira|susan|karen|moira|hazel|serena|libby|sonia|aria|jenny|google uk english female|google us english/i;
export class WebSpeechDriver implements VoiceDriver {
  private held = new Set<SpeechSynthesisUtterance>();
  private timers: number[] = []; private lastCancel = 0; private voiceCache = new Map<VoicePersona, SpeechSynthesisVoice | undefined>();
  constructor() {
    try { speechSynthesis.addEventListener?.('voiceschanged', () => this.voiceCache.clear()); } catch { /* no speech */ }
  }
  static available() { return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'; }
  private voiceFor(p: VoicePersona): SpeechSynthesisVoice | undefined {
    const cached = this.voiceCache.get(p); if (cached) return cached;
    let vs: SpeechSynthesisVoice[] = [];
    try { vs = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)); } catch { /* ignore */ }
    if (!vs.length) return undefined; // voices not loaded yet: do not cache the miss
    const male = vs.filter((v) => MALE.test(v.name) && !/female/i.test(v.name)), fem = vs.filter((v) => FEMALE.test(v.name));
    const v = p === 'pilot' ? (male[1] ?? male[0] ?? vs[1] ?? vs[0])
      : p === 'fo' ? (male[2] ?? male[1] ?? male[0] ?? vs[0])
      : p === 'pa' ? (fem[1] ?? fem[0] ?? vs[0])
      : p === 'machine' || p === 'atis' || p === 'controllerF' ? (fem[0] ?? vs[0])
      : (male[0] ?? vs[0]);
    this.voiceCache.set(p, v); return v;
  }
  speak(req: VoiceRequest, cb: VoiceCallbacks) {
    const synth = speechSynthesis, chunks = chunkSpeech(req.text);
    const go = () => {
      let live = true, begun = false, left = chunks.length;
      try { synth.resume(); } catch { /* ignore */ } // a previous cancel() while paused can leave the synth frozen
      const watchdog = window.setTimeout(() => { if (live && !begun) { live = false; try { synth.cancel(); this.lastCancel = performance.now(); } catch { /* ignore */ } cb.failed('no-start'); } }, 3200);
      this.timers.push(watchdog);
      for (const chunk of chunks) {
        const u = new SpeechSynthesisUtterance(chunk), v = this.voiceFor(req.persona);
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
        u.rate = req.rate; u.pitch = req.pitch; u.volume = req.volume;
        this.held.add(u); // keep a strong reference until it ends (Chromium GC bug)
        u.onstart = () => { if (!begun && live) { begun = true; clearTimeout(watchdog); cb.started(); } };
        u.onend = () => { this.held.delete(u); if (!live) return; if (--left <= 0) { live = false; cb.ended(); } };
        u.onerror = (e) => {
          this.held.delete(u); if (!live) return;
          const err = (e as SpeechSynthesisErrorEvent).error;
          if (err === 'canceled' || err === 'interrupted') return; // our own cancel()
          live = false; clearTimeout(watchdog); cb.failed(String(err ?? 'error'));
        };
        try { synth.speak(u); } catch { live = false; clearTimeout(watchdog); cb.failed('speak-threw'); return; }
      }
    };
    const wait = this.lastCancel + 90 - performance.now(); // Chrome drops a speak() issued in the same tick as cancel()
    if (wait > 0) this.timers.push(window.setTimeout(go, wait)); else go();
  }
  cancel() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0; this.held.clear();
    try { speechSynthesis.cancel(); speechSynthesis.resume(); } catch { /* ignore */ }
    this.lastCancel = performance.now();
  }
}
