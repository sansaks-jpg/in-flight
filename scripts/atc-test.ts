import { buildExchange, toRadioSpeech, RadioCtx } from '../src/sim/atc';
let id = 1; const ctx: RadioCtx = { callsign: 'Aero 101', fromIcao: 'WAHI', toIcao: 'WARR', fromName: 'Yogyakarta', toName: 'Surabaya', letter: 'B', spot: 'Hangar 2', atDest: false, lastCat: '', rwyFallback: '09' };
const T = (s: string, t: string, c: Partial<RadioCtx> = {}) => { const r = buildExchange(s, t, { ...ctx, ...c }, () => id++); console.log(`--- ${r.cat}`); for (const l of r.lines) console.log(`${l.who === 'PILOT' ? 'PILOT' : l.label}: ${l.text}\n   say: ${l.speech}`); return r; };
T('CLEARANCE', 'Aero 101, WAHI Delivery. Cleared to WARR as filed, runway 09 departure, initial climb 5000 feet, squawk 4215. QNH 1012.');
T('GROUND', 'Aero 101, taxi to holding point runway 09 via A, B. QNH 1012.', { lastCat: 'startup' });
let r = T('TOWER', 'Aero 101, WAHI Tower on 118.3. Runway 09, line up and wait.');
T('TOWER', 'Aero 101, wind 270° 12 knots, runway 09, cleared for take-off.', { lastCat: r.cat });
T('DEPARTURE', 'Aero 101, airborne, radar contact. Climb and maintain 36089 ft, contact Departure on 119.1.');
T('TOWER', 'Aero 101, WARR Tower. Runway 27L, wind 240° 8 knots, cleared to land.', { atDest: true });
const ok = toRadioSpeech('Runway 27L, cleared to land, squawk 4215, 3,500 ft QNH 1012', ctx);
if (!/two seven left/.test(ok) || !/four two one fife/.test(ok) || !/tree thousand fife hundred/.test(ok)) { console.error('speech FAIL', ok); process.exit(1); }
