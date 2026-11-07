// Fully automatic ATC <-> pilot radio. Every controller instruction is preceded by the pilot's call (as in real life:
// the pilot initiates, the controller answers) and followed by the pilot's READBACK of everything that must be read back
// (ICAO Annex 10 Vol. II 5.2.1.7.2 / Doc 4444 / Doc 9432; FAA JO 7110.65 & AIM 4-4-7): route clearances, runway
// entry / crossing / take-off / landing clearances, hold-short instructions, runway in use, altimeter settings,
// SSR codes, level / heading / speed instructions. Information-only messages are acknowledged with the callsign.
//
// Variety (so the radio never sounds like one canned script):
//   * the pilot's callsign is generated per flight (airline telephony or a national registration for light aircraft),
//   * ICAO (QNH, "line up and wait", "take-off") and FAA (altimeter, "position and hold", "takeoff") phraseology is
//     chosen from the airfield's country,
//   * every exchange rotates through a pool of phrasings: the variant is picked deterministically from the airport pair
//     and a running exchange counter (see `pick` below), so a flight still replays identically and the choice is testable,
//   * airfields without a tower frequency are served by "Information" / "Traffic" instead of Delivery/Ground/Tower,
//   * instructions carry the real local weather (wind, gusts, visibility, ceiling, rain, thunderstorms, night),
//   * background traffic (other callsigns) talks on the frequency, matched to the phase of flight.
//
// All lines are voiced with the browser's speech synthesis (distinct controller / pilot voices, ICAO number
// pronunciation, squelch click on every key-up) and shown as subtitles; the history is kept by the game.
import type { VoiceBus } from './speech';
export interface RadioLine { id: number; who: string; label: string; text: string; speech: string }
export interface RadioWx { dir: number; kt: number; gust: number; visKm: number; ceilFt: number | null; rain: number; snow: number; thunder: boolean; night: boolean; ok: boolean }
export interface RadioCtx {
  callsign: string; fromIcao: string; toIcao: string; fromName: string; toName: string;
  letter: string; spot: string; atDest: boolean; lastCat: string; rwyFallback: string;
  /** Spoken form of the callsign (phonetic registration); defaults to the written callsign. */
  spoken?: string;
  /** Phraseology family picked from the airfield's country (ICAO default). */
  style?: 'ICAO' | 'FAA';
  kind?: 'piston' | 'turboprop' | 'jet';
  /** Airfields without a tower frequency are served by Information / Traffic instead of Delivery/Ground/Tower. */
  fromTowered?: boolean; toTowered?: boolean;
  /** Real local weather, woven into instructions where it is genuinely relevant. */
  wx?: RadioWx;
  /** 0..1 random source (seeded per flight); deterministic fallback when absent. */
  rnd?: () => number;
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

// ---------------------------------------------------------------------------------------------------------------
// Callsigns
// ---------------------------------------------------------------------------------------------------------------
const PHON: Record<string, string> = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu' };
/** ATIS information letter as a spoken word ("information Alpha"), I and O skipped per ICAO. */
export const phoneticLetter = (i: number) => PHON[String.fromCharCode(65 + (((i % 26) + 26) % 26)).replace('I', 'H').replace('O', 'N')];
const REG_PREFIX: Record<string, string> = {
  US: 'N', ID: 'PK-', GB: 'G-', DE: 'D-', FR: 'F-', AU: 'VH-', CA: 'C-', JP: 'JA', SG: '9V-', MY: '9M-', NL: 'PH-', NZ: 'ZK-', TH: 'HS-', PH: 'RP-C', IN: 'VT-',
  BR: 'PR-', ZA: 'ZS-', ES: 'EC-', IT: 'I-', CH: 'HB-', SE: 'SE-', NO: 'LN-', AT: 'OE-', IE: 'EI-', MX: 'XA-', BE: 'OO-', DK: 'OY-', FI: 'OH-', PL: 'SP-', TR: 'TC-',
};
const JET_BRANDS = ['Skyline', 'Meridian', 'Horizon', 'Aerolink', 'Pacific Star', 'Northwind', 'Silverjet', 'Orbit'];
const PROP_BRANDS = ['Islander', 'Regional Link', 'Archipelago', 'Coastal', 'Highland', 'Trekair', 'Valley'];
const rint = (r: () => number, n: number) => Math.floor(r() * n);
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Per-flight radio identity: a national registration for light aircraft (spoken phonetically),
 *  or the airline telephony that matches the painted livery for jet / turboprop. */
export function makeCallsign(kind: 'piston' | 'turboprop' | 'jet', country: string, rnd: () => number): { callsign: string; spoken: string } {
  if (kind === 'piston') {
    const pre = REG_PREFIX[country] ?? 'N'; let reg: string;
    if (pre === 'N') reg = `N${100 + rint(rnd, 899)}${LETTERS[rint(rnd, 24)]}${LETTERS[rint(rnd, 24)]}`;
    else reg = `${pre}${Array.from({ length: 3 }, () => LETTERS[rint(rnd, 24)]).join('')}`;
    const chars = reg.replace('-', '').split('');
    const spoken = ['Cessna', ...chars.map((c) => (/\d/.test(c) ? c : PHON[c] ?? c))].join(' ');
    return { callsign: reg, spoken };
  }
  const brand = kind === 'jet' ? 'Skyline' : 'Trekair'; // matches the livery painted on the aircraft
  const n = kind === 'jet' ? 100 + rint(rnd, 899) : 10 + rint(rnd, 489);
  return { callsign: `${brand} ${n}`, spoken: `${brand} ${n}` };
}
/** A different callsign for background traffic. */
export function otherCallsign(rnd: () => number, avoid: string): string {
  for (let i = 0; i < 6; i++) {
    const brand = [...JET_BRANDS, ...PROP_BRANDS][rint(rnd, JET_BRANDS.length + PROP_BRANDS.length)], n = 1 + rint(rnd, 998);
    const cs = `${brand} ${n}`; if (cs !== avoid) return cs;
  }
  return 'Cargo 77';
}

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
/** Free-running 0..1 source for the few genuinely probabilistic touches (wake-turbulence caution).
 *  Seeded from the airport pair + exchange counter, so even these replay identically per flight. */
const prng = (seed: number) => { let s = seed | 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
/** Increments by exactly ONE per exchange — a line-id-based step would alias against pool sizes
 *  (an exchange emits 3-5 lines), locking 2-variant pools onto a single phrasing forever. */
let exchangeNonce = 0;

const STATION: Record<string, string> = { CLEARANCE: 'Delivery', GROUND: 'Ground', TOWER: 'Tower', DEPARTURE: 'Departure', APPROACH: 'Approach', ENROUTE: 'Control', ATIS: 'Information' };
const body = (t: string, cs: string) => t.replace(new RegExp(`^(?:${cs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Aero 101),\\s*`), '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const m1 = (re: RegExp, t: string) => re.exec(t)?.[1];
const pad3 = (n: number) => String(Math.round(n) % 360 || 360).padStart(3, '0');
const km2mi = (km: number) => Math.max(1, Math.round(km / 1.609));

/** Wind in the phrasing of the region: "wind 270° 8 knots" (ICAO) / "wind 270 at 8" (FAA). */
function windText(w: RadioWx | undefined, style: 'ICAO' | 'FAA') {
  if (!w || !w.ok) return '';
  if (w.kt < 1) return 'wind calm';
  const g = w.gust > w.kt + 4 ? (style === 'FAA' ? ` gusting ${Math.round(w.gust)}` : ` gusting ${Math.round(w.gust)} knots`) : '';
  if (w.kt < 3) return `wind variable at ${Math.round(w.kt)} knots`;
  return style === 'FAA' ? `wind ${pad3(w.dir)} at ${Math.round(w.kt)}${g}` : `wind ${pad3(w.dir)}° ${Math.round(w.kt)} knots${g}`;
}
/** Options for one short, genuinely relevant remark about current conditions (empty when the
 *  weather is unremarkable — a clear calm day needs no narration). */
function wxOptions(w: RadioWx | undefined, style: 'ICAO' | 'FAA', rwy: string): string[] {
  if (!w || !w.ok) return [];
  const opts: string[] = [];
  if (w.thunder) opts.push('thunderstorm activity in the vicinity of the field', 'lightning reported within five miles of the airport');
  if (w.snow > 0.05) opts.push('runway covered with compacted snow, braking action medium', 'light snow, braking action reported fair');
  else if (w.rain > 0.35) opts.push('heavy rain, runway wet, expect reduced braking', 'runway wet with standing water reported');
  else if (w.rain > 0.05) opts.push('runway wet', 'light rain in the area');
  if (w.visKm < 5) opts.push(style === 'FAA' ? `visibility ${km2mi(w.visKm)} miles` : `visibility ${w.visKm.toFixed(1)} km`);
  if (w.ceilFt !== null && w.ceilFt < 1800) opts.push(`ceiling ${Math.round(w.ceilFt / 100) * 100} feet`);
  const m = /^(\d{1,2})/.exec(rwy); const hdg = m ? parseInt(m[1], 10) * 10 : w.dir, rel = ((w.dir - hdg + 540) % 360) - 180, xw = Math.abs(Math.sin(rel * Math.PI / 180)) * w.kt;
  if (xw > 14) opts.push(`crosswind ${Math.round(xw)} knots`);
  if (w.gust > w.kt + 9) opts.push('windshear possible on short final');
  if (w.night) opts.push('runway lights on, medium intensity', 'approach and runway lighting available');
  return opts;
}

/** Turn one controller message into a complete, standard exchange: pilot call -> controller -> pilot readback (-> "readback correct"). */
export function buildExchange(sender: string, text: string, ctx: RadioCtx, id: () => number): { lines: RadioLine[]; cat: string } {
  const style = ctx.style ?? 'ICAO', cs = ctx.callsign, spokenCs = ctx.spoken ?? cs;
  const name = ctx.atDest ? ctx.toName : ctx.fromName, towered = ctx.atDest ? ctx.toTowered !== false : ctx.fromTowered !== false;
  const t = normaliseAltitudes(body(text, cs));
  const rwy = m1(/runway (\d{1,2}[LRC]?)/i, t) ?? ctx.rwyFallback;
  const wind = windText(ctx.wx, style);
  const fac = (role: string) => (towered || role === 'Control' || role === 'Approach' || role === 'Departure') ? `${name} ${role === 'Control' && style === 'FAA' ? 'Center' : role}` : `${name} ${style === 'FAA' ? 'Traffic' : 'Information'}`;
  const speak = (s: string) => toRadioSpeech(s.split(cs).join(spokenCs), ctx);
  const line = (who: string, label: string, s: string): RadioLine => ({ id: id(), who, label, text: normaliseAltitudes(s), speech: speak(s) });
  const atc = (s: string) => line(sender, `${STATION[sender] ?? cap(sender.toLowerCase())}`, s);
  const pilot = (s: string) => line('PILOT', cs, s);
  // one running nonce per exchange rotates the phrase pools; the airport pair offsets the rotation
  const nonce = ++exchangeNonce, seed = `${ctx.fromIcao}->${ctx.toIcao}`;
  const P = <T,>(xs: T[]) => pick(xs, seed, nonce);
  const rnd = ctx.rnd ?? prng(Math.floor(hashStr(seed) * 0x7fffffff) ^ (nonce * 2654435761));
  const q = m1(/(QNH \d+|Altimeter [\d.]+)/i, t) ?? '', f = m1(/on (\d+(?:\.\d+)?)/i, t);
  const greet = ctx.wx?.night ? 'good evening' : 'good day';
  const remarkOpts = wxOptions(ctx.wx, style, rwy);
  const remarkTxt = remarkOpts.length ? ` ${cap(pick(remarkOpts, seed, nonce + 4))}.` : '';
  let call = '', ans = '', rb = '', cat = 'info', ok = false;
  if (sender === 'ATIS') return { lines: [line('ATIS', 'ATIS', text)], cat: 'atis' };

  if (/as filed/i.test(t)) {
    cat = 'clearance';
    const alt = `${m1(/initial climb ([\d,]+) feet/i, t) ?? '3,000'} feet`, sq = m1(/squawk (\d+)/i, t) ?? '', dest = ctx.toName;
    if (!towered) {
      call = `${fac('Information')}, ${cs}, ${ctx.kind === 'piston' ? 'VFR' : 'IFR'} departure to ${dest}, request airfield information, ${ctx.spot}.`;
      ans = `${cs}, ${fac('Information')}, runway in use ${rwy}, ${wind || 'wind not available'}, ${q}.${remarkTxt} No clearance required, report ready for departure, squawk ${sq}.`;
      rb = `Runway ${rwy}, ${q}, squawk ${sq}, will report ready, ${cs}.`;
    } else if (style === 'FAA') {
      ok = true;
      call = P([`${fac('Delivery')}, ${cs}, IFR to ${dest}, with information ${ctx.letter}.`, `${fac('Delivery')}, ${cs}, ${ctx.spot}, ready to copy IFR clearance to ${dest}.`, `${fac('Delivery')}, ${cs}, request clearance to ${dest}, information ${ctx.letter}.`]);
      ans = P([
        `${cs}, ${fac('Delivery')}, cleared to the ${dest} airport as filed. Runway ${rwy}, climb and maintain ${alt}, expect higher after departure. Squawk ${sq}.`,
        `${cs}, cleared to ${dest} via radar vectors, then as filed. Maintain ${alt}, departure runway ${rwy}. Squawk ${sq}, ${q}.`,
      ]);
      rb = `Cleared to ${dest} as filed, runway ${rwy}, maintain ${alt}, squawk ${sq}, ${cs}.`;
    } else {
      ok = true;
      call = P([`${fac('Delivery')}, ${cs}, IFR to ${dest}, request start-up and clearance, information ${ctx.letter}.`, `${fac('Delivery')}, ${cs}, ${ctx.spot}, with information ${ctx.letter}, request IFR clearance to ${dest}.`, `${fac('Delivery')}, ${greet}, ${cs}, request clearance to ${dest}.`]);
      ans = P([
        `${cs}, ${fac('Delivery')}, cleared to ${dest} as filed, runway ${rwy} departure, initial climb ${alt}, squawk ${sq}, ${q}.`,
        `${cs}, cleared to ${dest} via the flight planned route. Departure runway ${rwy}, climb to ${alt}, squawk ${sq}. ${q}.`,
        `${cs}, ${fac('Delivery')}, ${greet}. Cleared to ${dest} airport, runway ${rwy}, initial altitude ${alt}, transponder ${sq}, ${q}.`,
      ]);
      rb = P([`Cleared to ${dest} as filed, runway ${rwy}, initial climb ${alt}, squawk ${sq}, ${q}, ${cs}.`, `Cleared ${dest} via flight plan, runway ${rwy}, climb ${alt}, squawk ${sq}, ${q}, ${cs}.`]);
    }
  } else if (/pushback approved/i.test(t)) {
    cat = 'pushback';
    call = P([`${fac('Ground')}, ${cs}, at ${ctx.spot}, request pushback and start-up, information ${ctx.letter}.`, `${fac('Ground')}, ${cs}, ${ctx.spot}, ready for pushback.`]);
    ans = P([`${cs}, pushback approved, ${style === 'FAA' ? 'face' : 'tail towards'} the taxiway${f ? `, Ground ${f}` : ''}. Start-up at your discretion.`, `${cs}, ${fac('Ground')}, push and start approved, report ready to taxi.`]);
    rb = P([`Pushback approved, start-up at our discretion, ${cs}.`, `Push and start approved, will call for taxi, ${cs}.`]);
  } else if (/start-up approved/i.test(t)) {
    cat = 'startup';
    call = P([`${fac('Ground')}, ${cs}, at ${ctx.spot}, request start-up, information ${ctx.letter}.`, `${fac('Ground')}, ${cs}, ${ctx.spot}, ready to start.`]);
    ans = P([`${cs}, start-up approved.`, `${cs}, start-up approved, call ready to taxi.`, `${cs}, ${fac('Ground')}, start-up approved, ${q || 'no delay expected'}.`]);
    rb = `Start-up approved, ${cs}.`;
  } else if (/pushback complete/i.test(t)) {
    cat = 'pushback-done'; ans = P([`${cs}, pushback complete, tug disconnected – set the parking brake.`, `${cs}, you are clear of the tug, set parking brake and start engines.`]);
    rb = P([`Pushback complete, parking brake set, ${cs}.`, `Brakes set, thank you, ${cs}.`]);
  } else if (/taxi to holding point/i.test(t)) {
    cat = 'taxi';
    const via = m1(/via ([^.]+?)\./i, t);
    call = P([`${fac('Ground')}, ${cs}, ready to taxi, information ${ctx.letter}.`, `${fac('Ground')}, ${cs}, ${ctx.spot}, request taxi.`, `${fac('Ground')}, ${cs}, engines running, request taxi for departure.`]);
    const route = style === 'FAA' ? `taxi to runway ${rwy}${via ? ` via ${via}` : ''}` : `taxi to holding point runway ${rwy}${via ? ` via ${via}` : ''}`;
    const qTxt = q ? `, ${q}` : '';
    ans = P([`${cs}, ${route}${qTxt}.${remarkTxt}`, `${cs}, ${fac('Ground')}, ${route}. ${P(['Hold short of the runway.', 'Report holding point.', 'Give way to the aircraft on your left.', 'Watch for crossing traffic.'])}${remarkTxt}`]);
    rb = P([`${cap(route)}${qTxt}, ${cs}.`, `${cap(route)}${qTxt}, wilco, ${cs}.`]);
  } else if (/line up and wait/i.test(t)) {
    cat = 'luaw'; call = P([`${fac('Tower')}, ${cs}, holding point runway ${rwy}, ready for departure.`, `${fac('Tower')}, ${cs}, ready, runway ${rwy}.`]);
    const act = style === 'FAA' ? 'position and hold' : 'line up and wait';
    ans = P([`${cs}, runway ${rwy}, ${act}.`, `${cs}, ${fac('Tower')}, ${act} runway ${rwy}, ${P(['landing traffic on a short final.', 'be ready for immediate departure.', 'departing traffic is rolling ahead.'])}`]);
    rb = `${cap(act)} runway ${rwy}, ${cs}.`;
  } else if (/cleared for take-?off/i.test(t)) {
    cat = 'takeoff'; if (ctx.lastCat !== 'luaw') call = `${fac('Tower')}, ${cs}, holding point runway ${rwy}, ready for departure.`;
    const to = style === 'FAA' ? 'takeoff' : 'take-off';
    const wake = ctx.kind === 'piston' && rnd() < 0.3 ? ' Caution wake turbulence from the departing heavy ahead.' : '';
    if (!towered) { ans = `${cs}, no reported traffic, ${wind || 'wind not available'}, runway ${rwy}, ${to} at your discretion.${remarkTxt}`; rb = `${cap(to)} at our discretion, runway ${rwy}, ${cs}.`; }
    else {
      ans = P([
        `${cs}, ${wind ? wind + ', ' : ''}runway ${rwy}, cleared for ${to}.${remarkTxt}${wake}`,
        `${cs}, ${fac('Tower')}, runway ${rwy}, cleared for ${to}. ${wind ? cap(wind) + '.' : ''}${remarkTxt}${wake}`,
        `${cs}, cleared for ${to} runway ${rwy}, ${wind || 'wind calm'}.${remarkTxt}${wake}`,
      ]);
      rb = P([`Cleared for ${to} runway ${rwy}, ${cs}.`, `Runway ${rwy}, cleared for ${to}, ${cs}.`]);
    }
  } else if (/contact departure|contact approach/i.test(t) && /climb and maintain/i.test(t)) {
    cat = 'handoff'; const alt = m1(/maintain (flight level \d+|[\d,]+ feet)/i, t);
    ans = P([`${cs}, airborne, radar contact. Climb and maintain ${alt ?? ''}${f ? `, contact Departure ${f}` : ''}.`, `${cs}, radar contact, ${ctx.fromName} Departure. Continue climb ${alt ?? ''}, proceed on course.`, `${cs}, identified. Climb to ${alt ?? ''}, direct as filed${f ? `, then contact Departure ${f}` : ''}.`]);
    rb = `Climb and maintain ${alt ?? ''}${f ? `, contact Departure ${f}` : ''}, ${cs}.`;
  } else if (/descend and maintain/i.test(t)) {
    cat = 'descent'; const alt = m1(/maintain (flight level \d+|[\d,]+ feet)/i, t);
    call = P([`${fac('Approach')}, ${cs}, request descent.`, `${fac('Approach')}, ${cs}, with you, ready for descent.`]);
    const app = ctx.kind === 'piston' ? `expect runway ${rwy}` : `expect ILS runway ${rwy}`;
    ans = P([`${cs}, ${fac('Approach')}, descend and maintain ${alt ?? ''}, ${q}. ${cap(app)}.`, `${cs}, descend to ${alt ?? ''}, ${q}. ${cap(app)}${wind ? ', ' + wind : ''}.${remarkTxt}`]);
    rb = `Descend and maintain ${alt ?? ''}, ${q}, ${app}, ${cs}.`;
  } else if (/cleared to land/i.test(t)) {
    cat = 'land';
    call = P([`${fac('Tower')}, ${cs}, ${ctx.kind === 'piston' ? 'final' : 'I L S runway ' + rwy + ', final'}, runway ${rwy}.`, `${fac('Tower')}, ${cs}, established final runway ${rwy}, request landing clearance.`]);
    ans = P([`${cs}, ${wind ? wind + ', ' : ''}runway ${rwy}, cleared to land.${remarkTxt}`, `${cs}, ${fac('Tower')}, runway ${rwy}, cleared to land. ${wind ? cap(wind) + '.' : ''}${remarkTxt}`, `${cs}, cleared to land runway ${rwy}, ${wind || 'wind calm'}.${remarkTxt}`]);
    rb = P([`Cleared to land runway ${rwy}, ${cs}.`, `Runway ${rwy}, cleared to land, ${cs}.`]);
  } else if (/vacate the runway/i.test(t)) {
    cat = 'vacate'; ans = P([`${cs}, welcome to ${ctx.toName}. Vacate the runway when able, contact Ground${f ? ' ' + f : ''}.`, `${cs}, rollout safe, vacate at the next exit and call Ground${f ? ' ' + f : ''}.`, `${cs}, turn off when able, taxi to the apron, ground${f ? ' ' + f : ' frequency'} when clear.`]);
    rb = P([`Vacating the runway${f ? `, Ground ${f}` : ''}, ${cs}.`, `Will vacate and call Ground, ${cs}.`]);
  } else if (/monitor/i.test(t)) {
    cat = 'monitor'; const what = m1(/monitor (.+?)\./i, t) ?? 'frequency';
    ans = P([`${cs}, level at cruise, traffic clear. Monitor ${what}.`, `${cs}, radar service terminated, monitor ${what}, safe flight.`, `${cs}, no reported traffic. Report ${ctx.wx?.thunder ? 'any deviation around thunderstorms' : 'any weather deviation'}, monitor ${what}.`]);
    rb = `Monitor ${what}, ${cs}.`;
  } else { cat = 'info'; ans = text; rb = P([`Roger, ${cs}.`, `Copied, ${cs}.`, `Wilco, ${cs}.`]); }

  const out: RadioLine[] = [];
  if (call) out.push(pilot(call));
  out.push(atc(ans || text));
  out.push(pilot(rb));
  if (ok) out.push(atc(P([`${cs}, readback correct.`, `Readback correct, ${cs}.`, `${cs}, readback correct, have a good flight.`])));
  return { lines: out, cat };
}

// ---------------------------------------------------------------------------------------------------------------
// Background traffic: other aircraft working the same controllers, matched to the phase of flight.
// ---------------------------------------------------------------------------------------------------------------
export type AmbientPhase = 'ground' | 'departure' | 'climb' | 'cruise' | 'descent' | 'arrival';
export function buildAmbient(ph: AmbientPhase, ctx: RadioCtx, id: () => number, altFt: number): { lines: RadioLine[]; label: string } | null {
  const rnd = ctx.rnd ?? Math.random, style = ctx.style ?? 'ICAO', o = otherCallsign(rnd, ctx.callsign);
  const name = ph === 'ground' || ph === 'departure' || ph === 'climb' ? ctx.fromName : ctx.toName;
  const rwy = ctx.rwyFallback || '09', n = 1 + rint(rnd, 4);
  const wind = windText(ctx.wx, style);
  const L = (who: string, label: string, s: string): RadioLine => ({ id: id(), who, label, text: normaliseAltitudes(s), speech: toRadioSpeech(s, ctx) });
  const tw = pick(['A', 'B', 'C', 'D', 'E', 'M', 'N'], ph, Math.floor(rnd() * 7));
  const alt = Math.max(2000, Math.round(altFt / 1000) * 1000 + [-2000, 1000, 2000, 3000][rint(rnd, 4)]);
  const unitName = ph === 'cruise' ? (style === 'FAA' ? `${name} Center` : `${name} Control`) : '';
  let label = '', lines: RadioLine[] = [];
  switch (ph) {
    case 'ground': {
      label = 'Ground'; const st = `${name} Ground`;
      const v = rint(rnd, 4);
      if (v === 0) lines = [L('PILOT', o, `${st}, ${o}, request taxi, information ${ctx.letter}.`), L('GROUND', label, `${o}, taxi to holding point runway ${rwy} via ${tw}.`), L('PILOT', o, `Taxi holding point runway ${rwy} via ${tw}, ${o}.`)];
      else if (v === 1) lines = [L('GROUND', label, `${o}, hold position.`), L('PILOT', o, `Holding position, ${o}.`)];
      else if (v === 2) lines = [L('PILOT', o, `${st}, ${o}, request pushback.`), L('GROUND', label, `${o}, pushback approved.`), L('PILOT', o, `Pushback approved, ${o}.`)];
      else lines = [L('GROUND', label, `${o}, contact Tower when ready, good day.`), L('PILOT', o, `Contact Tower, ${o}.`)];
      break;
    }
    case 'departure': {
      label = 'Tower'; const st = `${name} Tower`;
      const v = rint(rnd, 4);
      if (v === 0) lines = [L('TOWER', label, `${o}, ${wind ? wind + ', ' : ''}runway ${rwy}, cleared for ${style === 'FAA' ? 'takeoff' : 'take-off'}.`), L('PILOT', o, `Cleared for take-off runway ${rwy}, ${o}.`)];
      else if (v === 1) lines = [L('PILOT', o, `${st}, ${o}, holding short runway ${rwy}, ready.`), L('TOWER', label, `${o}, hold short, landing traffic ${n} miles final.`), L('PILOT', o, `Holding short, ${o}.`)];
      else if (v === 2) lines = [L('TOWER', label, `${o}, airborne, contact Departure, good day.`), L('PILOT', o, `Contact Departure, ${o}.`)];
      else lines = [L('TOWER', label, `${o}, runway ${rwy}, ${style === 'FAA' ? 'position and hold' : 'line up and wait'}.`), L('PILOT', o, `${style === 'FAA' ? 'Position and hold' : 'Line up and wait'} runway ${rwy}, ${o}.`)];
      break;
    }
    case 'climb': {
      label = 'Departure'; const st = `${name} Departure`;
      const v = rint(rnd, 3);
      if (v === 0) lines = [L('PILOT', o, `${st}, ${o}, passing ${Math.round(altFt / 1000) * 1000 + 1000} feet climbing ${alt} feet.`), L('DEPARTURE', label, `${o}, radar contact, continue climb ${alt} feet.`), L('PILOT', o, `Climb ${alt} feet, ${o}.`)];
      else if (v === 1) lines = [L('DEPARTURE', label, `${o}, turn right heading ${pad3(rint(rnd, 36) * 10)}, vectors for the departure.`), L('PILOT', o, `Right heading ${pad3(rint(rnd, 36) * 10)}, ${o}.`)];
      else lines = [L('DEPARTURE', label, `${o}, proceed direct as filed, climb flight level ${180 + rint(rnd, 15) * 10}.`), L('PILOT', o, `Direct as filed, climbing, ${o}.`)];
      break;
    }
    case 'cruise': {
      label = 'Control';
      const v = rint(rnd, 4), fl = 200 + rint(rnd, 20) * 10;
      if (v === 0) lines = [L('PILOT', o, `${unitName}, ${o}, flight level ${fl}.`), L('ENROUTE', label, `${o}, ${unitName}, radar contact, maintain flight level ${fl}.`)];
      else if (v === 1) lines = [L('ENROUTE', label, `${o}, ${style === 'FAA' ? 'turn left heading' : 'fly heading'} ${pad3(rint(rnd, 36) * 10)}, ${['weather ahead', 'traffic', 'sequencing'][rint(rnd, 3)]}.`), L('PILOT', o, `Heading ${pad3(rint(rnd, 36) * 10)}, ${o}.`)];
      else if (v === 2) lines = [L('PILOT', o, `${unitName}, ${o}, request direct to the next waypoint.`), L('ENROUTE', label, `${o}, approved direct.`), L('PILOT', o, `Direct, ${o}.`)];
      else lines = [L('ENROUTE', label, `${o}, contact ${['the next sector', 'Control'][rint(rnd, 2)]} on ${(118 + rint(rnd, 18) + rnd()).toFixed(1)}, good day.`), L('PILOT', o, `Frequency change, ${o}.`)];
      break;
    }
    case 'descent': {
      label = 'Approach'; const st = `${name} Approach`;
      const v = rint(rnd, 3);
      if (v === 0) lines = [L('APPROACH', label, `${o}, ${st}, descend and maintain ${Math.max(3000, alt)} feet.`), L('PILOT', o, `Descend ${Math.max(3000, alt)} feet, ${o}.`)];
      else if (v === 1) lines = [L('APPROACH', label, `${o}, turn left heading ${pad3(rint(rnd, 36) * 10)}, vectors for the approach runway ${rwy}.`), L('PILOT', o, `Left heading ${pad3(rint(rnd, 36) * 10)}, ${o}.`)];
      else lines = [L('PILOT', o, `${st}, ${o}, request the approach.`), L('APPROACH', label, `${o}, expect ${ctx.kind === 'piston' ? 'visual' : 'ILS'} approach runway ${rwy}, report established.`), L('PILOT', o, `Expect the approach, ${o}.`)];
      break;
    }
    case 'arrival': {
      label = 'Tower'; const st = `${name} Tower`;
      const v = rint(rnd, 3);
      if (v === 0) lines = [L('TOWER', label, `${o}, ${wind ? wind + ', ' : ''}runway ${rwy}, cleared to land.`), L('PILOT', o, `Cleared to land runway ${rwy}, ${o}.`)];
      else if (v === 1) lines = [L('PILOT', o, `${st}, ${o}, ${n} miles final runway ${rwy}.`), L('TOWER', label, `${o}, continue approach, number two.`), L('PILOT', o, `Continue approach, ${o}.`)];
      else lines = [L('TOWER', label, `${o}, vacate left when able, contact Ground.`), L('PILOT', o, `Vacate left, ${o}.`)];
      break;
    }
  }
  return lines.length ? { lines, label } : null;
}

// ---------------------------------------------------------------------------------------------------------------
export interface RadioHooks {
  /** The shared voice bus: every line is spoken, captioned and logged through it (see speech.ts). */
  bus: VoiceBus;
  /** squelch click on every key-up */
  key: () => void;
}
/** Timer host helper: AtcRadio's gaps run on plain timeouts independent of the RAF loop, and
 *  must also work headless (node tests) where `window` does not exist. */
const schedule = (fn: () => void, ms: number): number => (typeof window !== 'undefined' ? window.setTimeout(fn, ms) : (setTimeout(fn, ms) as unknown as number));
const unschedule = (t: number) => clearTimeout(t);

/**
 * Serial radio channel: sequences exchanges (pilot call -> controller -> readback) and hands every line to the shared
 * VoiceBus, which owns speaking, captions, pausing and priorities. A pause, the main menu, loading, the attract scene and
 * a hidden tab suspend the bus; the line that was cut off is replayed from its start when the radio is released.
 * `cancel()` also forgets everything queued.
 */
export class AtcRadio {
  private queue: { lines: RadioLine[]; ambient: boolean }[] = []; private busy = false; private gen = 0; private timer = 0;
  constructor(private h: RadioHooks) {}
  get pending() { return this.queue.length + (this.busy ? 1 : 0); }
  get isPaused() { return !this.h.bus.isRunning; }
  /** `ambient`: background traffic between other aircraft — lowest priority, held during sterile phases. */
  enqueue(lines: RadioLine[], ambient = false) {
    // an overloaded frequency (>=5 queued exchanges) drops the OLDEST queued exchange outright —
    // clearances included: the queue carries no category, so this is a blunt, honest overflow rule
    if (this.queue.length >= 5) this.queue.shift();
    this.queue.push({ lines, ambient }); this.pump();
  }
  /** Forget every queued / speaking radio line (other voice traffic — GPWS, crew callouts — is untouched). */
  cancel() {
    this.gen++; this.queue.length = 0; this.busy = false; unschedule(this.timer);
    this.h.bus.cancelWhere((u) => u.key.startsWith('atc:'));
  }
  /** Radio released (false) / held (true). The bus owns the actual silence; see VoiceBus.setRunning. */
  setPaused(p: boolean) { this.h.bus.setRunning(!p); if (!p) this.pump(); }
  private pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true; const { lines, ambient } = this.queue.shift()!, gen = this.gen; let i = 0;
    const next = () => {
      if (gen !== this.gen) return;
      if (i >= lines.length) { this.busy = false; this.timer = schedule(() => this.pump(), 900); return; }
      const l = lines[i++]; this.say(l, gen, ambient, () => { this.timer = schedule(next, l.who === 'PILOT' ? 550 : 380); });
    };
    next();
  }
  private say(l: RadioLine, gen: number, ambient: boolean, done: () => void) {
    const pilot = l.who === 'PILOT', atis = l.who === 'ATIS';
    this.h.bus.say({
      key: `atc:${l.id}`, speech: l.speech, priority: ambient ? 0 : 1, ttl: ambient ? 25 : 60, replay: !ambient, holdWhenSterile: ambient,
      persona: pilot ? 'pilot' : atis ? 'atis' : ['TOWER', 'ENROUTE'].includes(l.who) ? 'controllerF' : 'controller',
      rate: atis ? 0.95 : pilot ? 1.08 : 1.14, pitch: pilot ? 1.12 : atis ? 0.9 : 0.82, volume: 1,
      caption: { id: l.id, kind: pilot ? 'pilot' : 'atc', who: l.who, label: l.label, text: l.text },
      onStart: (first) => { if (gen === this.gen) this.h.key(); void first; },
      onEnd: () => { if (gen !== this.gen) return; this.h.key(); done(); },
    });
  }
}
