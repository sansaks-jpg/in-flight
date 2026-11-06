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

/** Turn one controller message into a complete, standard exchange: pilot call -> controller -> pilot readback (-> "readback correct"). */
export function buildExchange(sender: string, text: string, ctx: RadioCtx, id: () => number): { lines: RadioLine[]; cat: string } {
  const cs = ctx.callsign, fac = ctx.atDest ? ctx.toName : ctx.fromName, t = normaliseAltitudes(body(text, cs));
  const rwy = m1(/runway (\d{1,2}[LRC]?)/i, t) ?? ctx.rwyFallback;
  const line = (who: string, label: string, s: string): RadioLine => ({ id: id(), who, label, text: normaliseAltitudes(s), speech: toRadioSpeech(s, ctx) });
  const atc = (s = text) => line(sender, `${STATION[sender] ?? cap(sender.toLowerCase())}`, s);
  const pilot = (s: string) => line('PILOT', cs, s);
  let call = '', rb = '', cat = 'info', ok = false;
  if (sender === 'ATIS') return { lines: [line('ATIS', 'ATIS', text)], cat: 'atis' };
  if (/as filed/i.test(t)) {
    cat = 'clearance'; ok = true;
    call = `${fac} Delivery, ${cs}, IFR to ${ctx.toName}, request clearance, information ${ctx.letter}.`;
    const alt = m1(/initial climb ([\d,]+) feet/i, t), sq = m1(/squawk (\d+)/i, t), q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t);
    rb = `Cleared to ${ctx.toName} as filed, runway ${rwy} departure, initial climb ${alt ?? '3,000'} feet, squawk ${sq ?? ''}, ${q ?? ''}, ${cs}.`;
  } else if (/pushback approved/i.test(t)) {
    cat = 'pushback'; call = `${fac} Ground, ${cs}, at ${ctx.spot}, request pushback and start-up, information ${ctx.letter}.`; rb = `Pushback approved, start-up at our discretion, ${cs}.`;
  } else if (/start-up approved/i.test(t)) {
    cat = 'startup'; call = `${fac} Ground, ${cs}, at ${ctx.spot}, request start-up, information ${ctx.letter}.`; rb = `Start-up approved, ${cs}.`;
  } else if (/pushback complete/i.test(t)) {
    cat = 'pushback-done'; rb = `Pushback complete, parking brake set, ${cs}.`;
  } else if (/taxi to holding point/i.test(t)) {
    cat = 'taxi'; call = `${fac} Ground, ${cs}, ready to taxi, information ${ctx.letter}.`;
    const via = m1(/via ([^.]+?)\./i, t), q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t);
    rb = `Taxi to holding point runway ${rwy}${via ? ` via ${via}` : ''}${q ? `, ${q}` : ''}, ${cs}.`;
  } else if (/line up and wait/i.test(t)) {
    cat = 'luaw'; call = `${fac} Tower, ${cs}, holding point runway ${rwy}, ready for departure.`; rb = `Line up and wait runway ${rwy}, ${cs}.`;
  } else if (/cleared for take-?off/i.test(t)) {
    cat = 'takeoff'; if (ctx.lastCat !== 'luaw') call = `${fac} Tower, ${cs}, holding point runway ${rwy}, ready for departure.`;
    rb = `Cleared for take-off runway ${rwy}, ${cs}.`;
  } else if (/contact departure|contact approach/i.test(t) && /climb and maintain/i.test(t)) {
    cat = 'handoff'; const alt = m1(/maintain (flight level \d+|[\d,]+ feet)/i, t), f = m1(/on (\d+(?:\.\d+)?)/i, t);
    rb = `Climb and maintain ${alt ?? ''}${f ? `, contact departure ${f}` : ''}, ${cs}.`;
  } else if (/descend and maintain/i.test(t)) {
    cat = 'descent'; call = `${fac} Approach, ${cs}, request descent.`;
    const alt = m1(/maintain (flight level \d+|[\d,]+ feet)/i, t), q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t);
    rb = `Descend and maintain ${alt ?? ''}${q ? `, ${q}` : ''}, expect I L S runway ${rwy}, ${cs}.`;
  } else if (/cleared to land/i.test(t)) {
    cat = 'land'; call = `${fac} Tower, ${cs}, I L S runway ${rwy}, final, request landing clearance.`; rb = `Cleared to land runway ${rwy}, ${cs}.`;
  } else if (/vacate the runway/i.test(t)) {
    cat = 'vacate'; const f = m1(/on (\d+(?:\.\d+)?)/i, t); rb = `Vacating runway${f ? `, Ground ${f}` : ''}, ${cs}.`;
  } else if (/monitor/i.test(t)) { cat = 'monitor'; rb = `Monitor ${m1(/monitor (.+?)\./i, t) ?? 'frequency'}, ${cs}.`; }
  else { cat = 'info'; rb = `Roger, ${cs}.`; }
  const out: RadioLine[] = [];
  if (call) out.push(pilot(call));
  out.push(atc());
  out.push(pilot(rb));
  if (ok) out.push(atc(`${cs}, readback correct.`));
  return { lines: out, cat };
}

// ---------------------------------------------------------------------------------------------------------------
export interface RadioHooks {
  onLine: (l: RadioLine) => void;           // line starts: log + subtitle
  onLive: (l: RadioLine | null) => void;    // currently transmitting
  voiceOn: () => boolean; volume: () => number; key: () => void;
}
export class AtcRadio {
  private queue: RadioLine[][] = []; private busy = false; private gen = 0; private timer = 0; private paused = false;
  live: RadioLine | null = null;
  constructor(private h: RadioHooks) {}
  get pending() { return this.queue.length + (this.busy ? 1 : 0); }
  enqueue(lines: RadioLine[]) {
    // an overloaded frequency drops stale information-only traffic, never clearances
    if (this.queue.length >= 5) this.queue.shift();
    this.queue.push(lines); this.pump();
  }
  cancel() {
    this.gen++; this.queue.length = 0; this.busy = false; clearTimeout(this.timer); this.live = null; this.h.onLive(null);
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch { /* ignore */ }
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
      if (i >= lines.length) { this.live = null; this.h.onLive(null); this.busy = false; this.timer = window.setTimeout(() => this.pump(), 900); return; }
      const l = lines[i++]; this.say(l, gen, () => { this.timer = window.setTimeout(next, l.who === 'PILOT' ? 550 : 380); });
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
    const fin = () => { if (finished || gen !== this.gen) return; finished = true; clearTimeout(guard); this.h.key(); done(); };
    const guard = window.setTimeout(fin, est * 2.2 + 2500);
    const speakable = typeof speechSynthesis !== 'undefined' && this.h.voiceOn() && this.h.volume() > 0;
    if (!speakable) { window.setTimeout(fin, est); return; }
    try {
      const u = new SpeechSynthesisUtterance(l.speech), v = this.pick(l.who);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
      const pilot = l.who === 'PILOT', atis = l.who === 'ATIS';
      u.rate = atis ? 0.95 : pilot ? 1.08 : 1.14; u.pitch = pilot ? 1.12 : atis ? 0.9 : 0.82; u.volume = Math.min(1, this.h.volume() + 0.15);
      u.onend = fin; u.onerror = fin; speechSynthesis.speak(u);
    } catch { window.setTimeout(fin, est); }
  }
}
