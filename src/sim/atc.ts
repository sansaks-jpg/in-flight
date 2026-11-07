// Fully automatic ATC <-> pilot radio. Every controller instruction is preceded by the pilot's call (as in real life:
// the pilot initiates, the controller answers) and followed by the pilot's READBACK of everything that must be read back
// (ICAO Annex 10 Vol. II 5.2.1.7.2 / Doc 4444 / Doc 9432; FAA JO 7110.65 & AIM 4-4-7): route clearances, runway
// entry / crossing / take-off / landing clearances, hold-short instructions, runway in use, altimeter settings,
// SSR codes, level / heading / speed instructions. Information-only messages are acknowledged with the callsign.
// All lines are voiced with the browser's speech synthesis (distinct controller / pilot voices, ICAO number
// pronunciation, squelch click on every key-up) and shown as subtitles; the history is kept by the game.
export interface RadioLine { id: number; who: string; label: string; text: string; speech: string }
export interface RadioCtx {
  callsign: string; fromIcao: string; toIcao: string; fromName: string; toName: string;
  letter: string; spot: string; atDest: boolean; lastCat: string; rwyFallback: string;
}

const DIG = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];
const digits = (s: string) => s.replace(/\d/g, (d) => ` ${DIG[+d]} `).replace(/\./g, ' decimal ').replace(/\s+/g, ' ').trim();
const group = (n: number) => { // 3,500 -> "three thousand five hundred"
  const w = ['', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];
  const th = Math.floor(n / 1000), hu = Math.round((n % 1000) / 100);
  return [th ? `${digits(String(th))} thousand` : '', hu ? `${w[hu]} hundred` : ''].filter(Boolean).join(' ') || 'zero';
};
/** Altitudes are always quoted to the nearest 100 ft; at and above the transition altitude (18,000 ft) as flight levels. */
export function normaliseAltitudes(t: string) {
  return t.replace(/(\d{1,3}(?:,\d{3})+|\d{3,6}) ?(?:ft|feet)\b/gi, (_m, n: string) => {
    const raw = parseInt(n.replace(/,/g, ''), 10), ft = Math.round(raw / 100) * 100;
    // assigned cruise levels are whole thousands of feet (FL360, not FL361)
    return ft >= 18000 ? `flight level ${Math.round(raw / 1000) * 10}` : `${ft.toLocaleString('en-US')} feet`;
  });
}
/** ICAO radiotelephony pronunciation of digits, runways, frequencies, levels, QNH, squawk. */
export function toRadioSpeech(raw: string, ctx?: Pick<RadioCtx, 'fromIcao' | 'toIcao' | 'fromName' | 'toName'>) {
  let t = normaliseAltitudes(raw);
  if (ctx) { t = t.replace(new RegExp(`\\b${ctx.fromIcao}\\b`, 'g'), ctx.fromName).replace(new RegExp(`\\b${ctx.toIcao}\\b`, 'g'), ctx.toName); }
  t = t.replace(/flight level (\d+)/gi, (_m, n) => `flight level ${digits(n)}`)
    .replace(/([\d,]+) feet/gi, (_m, n: string) => `${group(parseInt(n.replace(/,/g, ''), 10))} feet`)
    .replace(/\b(runway|rwy) (\d{1,2})([LRC])?/gi, (_m, w: string, n: string, s?: string) => `${w.toLowerCase() === 'rwy' ? 'runway' : w} ${digits(n.padStart(2, '0'))}${s ? ' ' + { L: 'left', R: 'right', C: 'centre' }[s.toUpperCase() as 'L'] : ''}`)
    .replace(/(\d+)°/g, (_m, n: string) => `${digits(n)} degrees`)
    .replace(/\b(\d+) (?:kt|knots)\b/gi, (_m, n: string) => `${digits(n)} knots`)
    .replace(/\bAero 101\b/g, 'Aero one zero one')
    .replace(/\bkm\b/gi, 'kilometres').replace(/\bILS\b/g, 'I L S').replace(/\bQNH\b/g, 'Q N H').replace(/\bATIS\b/g, 'ATIS')
    .replace(/\b\d+(?:\.\d+)?\b/g, (n) => digits(n))
    .replace(/[()·–—]/g, ', ').replace(/\s+/g, ' ');
  return t.trim();
}

const STATION: Record<string, string> = { CLEARANCE: 'Delivery', GROUND: 'Ground', TOWER: 'Tower', DEPARTURE: 'Departure', APPROACH: 'Approach', ENROUTE: 'Control', ATIS: 'Information' };
const body = (t: string, cs: string) => t.replace(new RegExp(`^${cs},\\s*`), '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const m1 = (re: RegExp, t: string) => re.exec(t)?.[1];

// ---- contextual phrasing ----
// The mandated CONTENT of a transmission (clearance items, runway, QNH, squawk) is fixed by ICAO
// Doc 9432, but the surrounding phrasing rotates through a pool so two flights from the same
// airport — and flights from different airports — do not sound like a replayed tape. The variant
// is picked deterministically from the airport pair + a running counter (the exchange id), so a
// flight still replays identically and the choice is unit-testable.
const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
/** Rotates the pool deterministically: the airport-pair hash gives a stable starting slot per
 *  airport, and the running exchange counter keeps cycling through the variants so consecutive
 *  exchanges on the same frequency can never repeat one phrasing forever. */
const pick = <T,>(pool: T[], seed: string, nonce: number): T => pool[(Math.floor(hashStr(seed) * pool.length) + nonce) % pool.length];
/** Increments by exactly ONE per exchange — a line-id-based step would alias against pool sizes
 *  (an exchange emits 3-5 lines), locking 2-variant pools onto a single phrasing forever. */
let exchangeNonce = 0;
/** Pilot call / readback phrasings per exchange category. ctx: fac = facility airport name. */
const PHRASES: Record<string, { call?: ((k: { fac: string; cs: string; to: string; letter: string; rwy: string; spot: string }) => string)[]; rb?: ((k: { cs: string; to: string; rwy: string; alt: string; sq: string; q: string; via: string; f: string; spot: string }) => string)[] }> = {
  clearance: {
    call: [
      (k) => `${k.fac} Delivery, ${k.cs}, IFR to ${k.to}, request clearance, information ${k.letter}.`,
      (k) => `${k.fac} Delivery, ${k.cs}, IFR to ${k.to} with information ${k.letter}, requesting our clearance.`,
      (k) => `${k.fac} Delivery, ${k.cs}, request IFR clearance to ${k.to}, information ${k.letter} copied.`,
    ],
    rb: [
      (k) => `Cleared to ${k.to} as filed, runway ${k.rwy} departure, initial climb ${k.alt} feet, squawk ${k.sq}, ${k.q}, ${k.cs}.`,
      (k) => `Cleared to ${k.to} via the filed route, departure runway ${k.rwy}, climb initial ${k.alt} feet, transponder ${k.sq}, ${k.q}, ${k.cs}.`,
    ],
  },
  pushback: {
    call: [
      (k) => `${k.fac} Ground, ${k.cs}, at ${k.spot}, request pushback and start-up, information ${k.letter}.`,
      (k) => `${k.fac} Ground, ${k.cs}, ${k.spot}, with information ${k.letter}, request push and start.`,
    ],
    rb: [
      (k) => `Pushback approved, start-up at our discretion, ${k.cs}.`,
      (k) => `Push approved, we'll start when ready, ${k.cs}.`,
    ],
  },
  startup: {
    call: [
      (k) => `${k.fac} Ground, ${k.cs}, at ${k.spot}, request start-up, information ${k.letter}.`,
      (k) => `${k.fac} Ground, ${k.cs}, ${k.spot}, information ${k.letter}, request start-up.`,
    ],
    rb: [(k) => `Start-up approved, ${k.cs}.`, (k) => `Approved to start, ${k.cs}.`],
  },
  taxi: {
    call: [
      (k) => `${k.fac} Ground, ${k.cs}, ready to taxi, information ${k.letter}.`,
      (k) => `${k.fac} Ground, ${k.cs}, ready for taxi with information ${k.letter}.`,
      (k) => `${k.fac} Ground, ${k.cs}, engines started, request taxi, information ${k.letter}.`,
    ],
    rb: [
      (k) => `Taxi to holding point runway ${k.rwy}${k.via}${k.q}, ${k.cs}.`,
      (k) => `Holding point runway ${k.rwy}${k.via}${k.q}, wilco, ${k.cs}.`,
    ],
  },
  luaw: {
    call: [
      (k) => `${k.fac} Tower, ${k.cs}, holding point runway ${k.rwy}, ready for departure.`,
      (k) => `${k.fac} Tower, ${k.cs}, at the holding point runway ${k.rwy}, ready.`,
    ],
    rb: [(k) => `Line up and wait runway ${k.rwy}, ${k.cs}.`, (k) => `Lining up runway ${k.rwy}, ${k.cs}.`],
  },
  takeoff: {
    call: [(k) => `${k.fac} Tower, ${k.cs}, holding point runway ${k.rwy}, ready for departure.`, (k) => `${k.fac} Tower, ${k.cs}, holding short runway ${k.rwy}, ready.`],
    rb: [(k) => `Cleared for take-off runway ${k.rwy}, ${k.cs}.`, (k) => `Cleared for take-off runway ${k.rwy}, wilco, ${k.cs}.`],
  },
  handoff: {
    rb: [
      (k) => `Climb and maintain ${k.alt}${k.f}, ${k.cs}.`,
      (k) => `Climbing to ${k.alt}, switching${k.f}, ${k.cs}.`,
    ],
  },
  descent: {
    call: [
      (k) => `${k.fac} Approach, ${k.cs}, request descent.`,
      (k) => `${k.fac} Approach, ${k.cs}, with you, request descent.`,
      (k) => `${k.fac} Approach, ${k.cs}, ready for descent instructions.`,
    ],
    rb: [
      (k) => `Descend and maintain ${k.alt}${k.q}, expect I L S runway ${k.rwy}, ${k.cs}.`,
      (k) => `Descending ${k.alt}${k.q}, I L S runway ${k.rwy} expected, ${k.cs}.`,
    ],
  },
  land: {
    call: [
      (k) => `${k.fac} Tower, ${k.cs}, I L S runway ${k.rwy}, final, request landing clearance.`,
      (k) => `${k.fac} Tower, ${k.cs}, on final for runway ${k.rwy}, I L S established, request landing.`,
    ],
    rb: [(k) => `Cleared to land runway ${k.rwy}, ${k.cs}.`, (k) => `Runway ${k.rwy}, cleared to land, ${k.cs}.`],
  },
  vacate: {
    rb: [
      (k) => `Vacating runway${k.f}, ${k.cs}.`,
      (k) => `Vacating, switching to Ground${k.f}, ${k.cs}.`,
    ],
  },
};

/** Turn one controller message into a complete, standard exchange: pilot call -> controller -> pilot readback (-> "readback correct"). */
export function buildExchange(sender: string, text: string, ctx: RadioCtx, id: () => number): { lines: RadioLine[]; cat: string } {
  const cs = ctx.callsign, fac = ctx.atDest ? ctx.toName : ctx.fromName, t = normaliseAltitudes(body(text, cs));
  const rwy = m1(/runway (\d{1,2}[LRC]?)/i, t) ?? ctx.rwyFallback;
  const line = (who: string, label: string, s: string): RadioLine => ({ id: id(), who, label, text: normaliseAltitudes(s), speech: toRadioSpeech(s, ctx) });
  const atc = (s = text) => line(sender, `${STATION[sender] ?? cap(sender.toLowerCase())}`, s);
  const pilot = (s: string) => line('PILOT', cs, s);
  // one running nonce per exchange rotates the phrase pools; the airport pair offsets the rotation
  const nonce = ++exchangeNonce, seed = `${ctx.fromIcao}->${ctx.toIcao}`;
  const K = { fac, cs, to: ctx.toName, letter: ctx.letter, rwy, spot: ctx.spot };
  let call = '', rb = '', cat = 'info', ok = false;
  if (sender === 'ATIS') return { lines: [line('ATIS', 'ATIS', text)], cat: 'atis' };
  if (/as filed/i.test(t)) {
    cat = 'clearance'; ok = true;
    const alt = m1(/initial climb ([\d,]+) feet/i, t), sq = m1(/squawk (\d+)/i, t), q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t);
    const P = PHRASES.clearance;
    call = pick(P.call!, seed, nonce)({ ...K, to: ctx.toName });
    rb = pick(P.rb!, seed, nonce + 1)({ cs, to: ctx.toName, rwy, alt: alt ?? '3,000', sq: sq ?? '', q: q ?? '', via: '', f: '', spot: ctx.spot });
  } else if (/pushback approved/i.test(t)) {
    cat = 'pushback';
    call = pick(PHRASES.pushback.call!, seed, nonce)(K);
    rb = pick(PHRASES.pushback.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: '', via: '', f: '', spot: ctx.spot });
  } else if (/start-up approved/i.test(t)) {
    cat = 'startup';
    call = pick(PHRASES.startup.call!, seed, nonce)(K);
    rb = pick(PHRASES.startup.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: '', via: '', f: '', spot: ctx.spot });
  } else if (/pushback complete/i.test(t)) {
    cat = 'pushback-done'; rb = `Pushback complete, parking brake set, ${cs}.`;
  } else if (/taxi to holding point/i.test(t)) {
    cat = 'taxi';
    const via = m1(/via ([^.]+?)\./i, t), q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t);
    const viaTxt = via ? ` via ${via}` : '', qTxt = q ? `, ${q}` : '';
    call = pick(PHRASES.taxi.call!, seed, nonce)(K);
    rb = pick(PHRASES.taxi.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: qTxt, via: viaTxt, f: '', spot: ctx.spot });
  } else if (/line up and wait/i.test(t)) {
    cat = 'luaw';
    call = pick(PHRASES.luaw.call!, seed, nonce)(K);
    rb = pick(PHRASES.luaw.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: '', via: '', f: '', spot: ctx.spot });
  } else if (/cleared for take-?off/i.test(t)) {
    cat = 'takeoff';
    if (ctx.lastCat !== 'luaw') call = pick(PHRASES.takeoff.call!, seed, nonce)(K);
    rb = pick(PHRASES.takeoff.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: '', via: '', f: '', spot: ctx.spot });
  } else if (/contact departure|contact approach/i.test(t) && /climb and maintain/i.test(t)) {
    cat = 'handoff';
    const alt = m1(/maintain (flight level \d+|[\d,]+ feet)/i, t), f = m1(/on (\d+(?:\.\d+)?)/i, t);
    const fTxt = f ? `, contact departure ${f}` : '';
    rb = pick(PHRASES.handoff.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: alt ?? '', sq: '', q: '', via: '', f: fTxt, spot: ctx.spot });
  } else if (/descend and maintain/i.test(t)) {
    cat = 'descent';
    const alt = m1(/maintain (flight level \d+|[\d,]+ feet)/i, t), q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t);
    const qTxt = q ? `, ${q}` : '';
    call = pick(PHRASES.descent.call!, seed, nonce)(K);
    rb = pick(PHRASES.descent.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: alt ?? '', sq: '', q: qTxt, via: '', f: '', spot: ctx.spot });
  } else if (/cleared to land/i.test(t)) {
    cat = 'land';
    call = pick(PHRASES.land.call!, seed, nonce)(K);
    rb = pick(PHRASES.land.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: '', via: '', f: '', spot: ctx.spot });
  } else if (/vacate the runway/i.test(t)) {
    cat = 'vacate';
    const f = m1(/on (\d+(?:\.\d+)?)/i, t);
    const fTxt = f ? `, Ground ${f}` : '';
    rb = pick(PHRASES.vacate.rb!, seed, nonce + 1)({ cs, to: '', rwy, alt: '', sq: '', q: '', via: '', f: fTxt, spot: ctx.spot });
  } else if (/monitor/i.test(t)) { cat = 'monitor'; rb = `Monitor ${m1(/monitor (.+?)\./i, t) ?? 'frequency'}, ${cs}.`; }
  else { cat = 'info'; rb = pick(['Roger, {cs}.', 'Copy, {cs}.', 'Wilco, {cs}.'], seed, nonce).replace('{cs}', cs); }
  const out: RadioLine[] = [];
  if (call) out.push(pilot(call));
  out.push(atc());
  out.push(pilot(rb));
  if (ok) out.push(atc(pick([`${cs}, readback correct.`, `Readback correct, ${cs}.`], seed, nonce + 2)));
  return { lines: out, cat };
}

// ---------------------------------------------------------------------------------------------------------------
export interface RadioHooks {
  onLine: (l: RadioLine) => void;           // line starts: log + subtitle
  onLive: (l: RadioLine | null) => void;    // currently transmitting
  voiceOn: () => boolean; volume: () => number; key: () => void;
}
/** Timer host helper: AtcRadio's pump/say run on plain timeouts independent of the RAF loop, and
 *  must also work headless (node tests) where `window` does not exist. */
const schedule = (fn: () => void, ms: number): number => (typeof window !== 'undefined' ? window.setTimeout(fn, ms) : (setTimeout(fn, ms) as unknown as number));
const unschedule = (t: number) => clearTimeout(t);

export class AtcRadio {
  private queue: RadioLine[][] = []; private busy = false; private gen = 0; private timer = 0; private paused = false;
  live: RadioLine | null = null;
  constructor(private h: RadioHooks) {}
  get pending() { return this.queue.length + (this.busy ? 1 : 0); }
  enqueue(lines: RadioLine[]) {
    // an overloaded frequency (>=5 queued exchanges) drops the OLDEST queued exchange outright —
    // clearances included: the queue carries no category, so this is a blunt, honest overflow rule
    if (this.queue.length >= 5) this.queue.shift();
    this.queue.push(lines); this.pump();
  }
  cancel() {
    this.gen++; this.queue.length = 0; this.busy = false; unschedule(this.timer); this.live = null; this.h.onLive(null);
    // A cancel is a "radio off for good" moment (new flight / menu): also clear a stuck paused
    // state, otherwise flights started straight out of a pause stayed mute forever and the
    // global speechSynthesis stayed frozen for the AudioEngine's GPWS/PA voices too.
    this.paused = false;
    try { if (typeof speechSynthesis !== 'undefined') { speechSynthesis.cancel(); speechSynthesis.resume(); } } catch { /* ignore */ }
  }
  setPaused(p: boolean) {
    this.paused = p;
    try { if (typeof speechSynthesis !== 'undefined') { if (p) speechSynthesis.pause(); else speechSynthesis.resume(); } } catch { /* ignore */ }
    if (!p) this.pump();
  }
  private pump() {
    if (this.busy || this.paused || !this.queue.length) return;
    this.busy = true; const lines = this.queue.shift()!, gen = this.gen; let i = 0;
    const next = () => {
      if (gen !== this.gen) return;
      // Pausing mid-exchange parks the REMAINING lines back at the head of the queue and stops the
      // chain: otherwise the timers kept advancing (subtitles flipping, speak() calls stacking up
      // to burst out of speechSynthesis the moment it resumed) even though the voice was frozen.
      // The line already speaking stays frozen by speechSynthesis.pause() and finishes on resume.
      if (this.paused) {
        if (i < lines.length) this.queue.unshift(lines.slice(i));
        this.busy = false;
        return;
      }
      if (i >= lines.length) { this.live = null; this.h.onLive(null); this.busy = false; this.timer = schedule(() => this.pump(), 900); return; }
      const l = lines[i++]; this.say(l, gen, () => { this.timer = schedule(next, l.who === 'PILOT' ? 550 : 380); });
    };
    next();
  }
  private voices(): SpeechSynthesisVoice[] {
    try { return (speechSynthesis.getVoices() || []).filter((v) => /^en/i.test(v.lang)); } catch { return []; }
  }
  private pick(who: string) {
    const vs = this.voices(); if (!vs.length) return undefined;
    const male = vs.filter((v) => /male|daniel|david|george|alex|fred|mark|guy|ryan|james|google uk english male/i.test(v.name) && !/female/i.test(v.name));
    const fem = vs.filter((v) => /female|samantha|zira|susan|karen|moira|hazel|google uk english female|google us english/i.test(v.name));
    if (who === 'PILOT') return (male[1] ?? male[0] ?? vs[1] ?? vs[0]);
    if (who === 'ATIS') return fem[0] ?? vs[0];
    return (fem.length && ['TOWER', 'ENROUTE'].includes(who) ? fem[0] : male[0]) ?? vs[0];
  }
  private say(l: RadioLine, gen: number, done: () => void) {
    this.live = l; this.h.onLine(l); this.h.onLive(l); this.h.key();
    const words = l.speech.split(/\s+/).length, est = Math.max(1.6, words / 2.7) * 1000 + 300;
    let finished = false;
    const fin = () => { if (finished || gen !== this.gen) return; finished = true; unschedule(guard); this.h.key(); done(); };
    const guard = schedule(fin, est * 2.2 + 2500);
    const speakable = typeof speechSynthesis !== 'undefined' && this.h.voiceOn() && this.h.volume() > 0;
    if (!speakable) { schedule(fin, est); return; }
    try {
      const u = new SpeechSynthesisUtterance(l.speech), v = this.pick(l.who);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
      const pilot = l.who === 'PILOT', atis = l.who === 'ATIS';
      u.rate = atis ? 0.95 : pilot ? 1.08 : 1.14; u.pitch = pilot ? 1.12 : atis ? 0.9 : 0.82; u.volume = Math.min(1, this.h.volume() + 0.15);
      u.onend = fin; u.onerror = fin; speechSynthesis.speak(u);
    } catch { schedule(fin, est); }
  }
}
