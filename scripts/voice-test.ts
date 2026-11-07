// Voice system regression suite: VoiceBus (pause / priority / failure handling), CommsDirector (state-aware cues) and the
// EN -> ID transcript translation. Headless: no browser speech, no WebGL. Run: npx tsx --test scripts/voice-test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceBus, chunkSpeech, type Caption, type Utterance, type VoiceCallbacks, type VoiceDriver, type VoiceRequest } from '../src/sim/speech';
import { CommsDirector, type CommsSnap } from '../src/sim/comms';
import { buildExchange, type RadioCtx } from '../src/sim/atc';
import { translateId, transcriptText } from '../src/sim/translate';

/** Fake speech engine: records what it was asked to say; the test decides when a line "ends". */
function fakeDriver() {
  const spoken: { req: VoiceRequest; cb: VoiceCallbacks }[] = []; let cancels = 0; let failWith: string | null = null;
  const driver: VoiceDriver = { speak: (req, cb) => { spoken.push({ req, cb }); if (failWith) cb.failed(failWith); else cb.started(); }, cancel: () => { cancels++; } };
  return { driver, spoken, cancels: () => cancels, failNext: (reason: string | null) => { failWith = reason; } };
}
let nextId = 1;
const line = (key: string, priority: Utterance['priority'], extra: Partial<Utterance> = {}): Utterance =>
  ({ key, speech: key, persona: 'controller', priority, caption: { id: nextId++, kind: 'atc', who: 'TOWER', label: 'Tower', text: key }, ...extra });
function harness(audible = true) {
  const d = fakeDriver(); let now = 0; const logged: string[] = []; let live: Caption | null = null;
  const bus = new VoiceBus(d.driver, { audible: () => audible, onLog: (c) => logged.push(c.text), onLive: (c) => { live = c; } }, () => now);
  return { ...d, bus, logged, live: () => live, advance: (s: number) => { now += s; } };
}

test('pause: the active line is cancelled (never pause()d), nothing speaks while held, and it is replayed from the start on resume', () => {
  const h = harness(); h.bus.setRunning(true);
  h.bus.say(line('cleared for take-off', 1));
  assert.equal(h.spoken.length, 1);
  h.bus.setRunning(false);
  assert.equal(h.cancels(), 1, 'speech is cancelled at once');
  assert.equal(h.live(), null, 'caption disappears');
  h.bus.say(line('queued while paused', 1));
  assert.equal(h.spoken.length, 1, 'a held bus speaks nothing');
  h.bus.setRunning(true);
  assert.equal(h.spoken[1].req.text, 'cleared for take-off', 'the interrupted call is repeated from its start');
  h.spoken[1].cb.ended();
  assert.equal(h.spoken[2].req.text, 'queued while paused');
  assert.deepEqual(h.logged, ['cleared for take-off', 'queued while paused'], 'a replay is not logged twice');
});

test('priority: a callout cuts an ATC line, which is replayed afterwards; a warning cuts a callout', () => {
  const h = harness(); h.bus.setRunning(true);
  h.bus.say(line('atc', 1));
  h.bus.say(line('v1', 2, { persona: 'fo' }));
  assert.deepEqual(h.spoken.map((s) => s.req.text), ['atc', 'v1']);
  h.spoken[1].cb.ended();
  assert.equal(h.spoken[2].req.text, 'atc', 'the cut ATC line resumes after the callout');
  h.bus.retainWarning('pu'); h.bus.say(line('pu', 3, { persona: 'machine' }));
  assert.equal(h.spoken[3].req.text, 'pu');
  h.bus.retainWarning(null);
  assert.notEqual(h.live()?.text, 'pu', 'a warning is silenced the moment its condition clears (the cut ATC line resumes)');
});

test('callouts and warnings are dropped across a pause; queued TTLs do not drain while paused', () => {
  const h = harness(); h.bus.setRunning(true);
  h.bus.say(line('active', 1)); h.bus.say(line('stale-callout', 2, { ttl: 3 })); // cuts 'active'; both survive in order
  h.bus.setRunning(false);
  h.advance(600); // ten minutes on the pause screen
  h.bus.setRunning(true);
  const said = h.spoken.map((s) => s.req.text);
  assert.ok(!said.slice(2).includes('stale-callout'), 'an old callout is never spoken after resume');
  assert.equal(said.at(-1), 'active', 'the ATC line (60 s ttl) survives a long pause');
});

test('a silent engine (autoplay block, no voices) cannot stall the flight: the line plays as a timed transcript', async () => {
  const h = harness(); h.bus.setRunning(true); h.failNext('not-allowed');
  let ended = false;
  h.bus.say(line('hello', 1, { onEnd: () => { ended = true; } }));
  assert.equal(h.live()?.text, 'hello', 'the transcript is shown');
  await new Promise((r) => setTimeout(r, 1550));
  assert.equal(ended, true, 'and the exchange still advances');
});

test('voice off / mute: speech stops at once, captioned lines continue as silent transcripts, uncaptioned GPWS words are refused', () => {
  let audible = true; const d = fakeDriver();
  const bus = new VoiceBus(d.driver, { audible: () => audible }, () => 0); bus.setRunning(true);
  bus.say(line('atc', 1)); audible = false; bus.audibilityChanged();
  assert.equal(d.cancels(), 1);
  assert.equal(bus.say(line('sink', 3, { caption: undefined })), false, 'no sound, no GPWS voice');
  assert.equal(bus.say(line('pa', 1)), true, 'a captioned line is still accepted for the transcript');
});

test('long speech is chunked per sentence (Chrome stops utterances after ~15 s)', () => {
  const chunks = chunkSpeech('Ladies and gentlemen, this is your captain speaking. We have reached our cruising altitude. ' + 'Please remain seated, '.repeat(12));
  assert.ok(chunks.length >= 3); assert.ok(chunks.every((c) => c.length <= 170));
});

// ---------------------------------------------------------------------------------------------------------------------
function director(over: Partial<CommsSnap> = {}) {
  const said: string[] = []; const texts: Record<string, string> = {};
  const bus = { say: (u: Utterance) => { said.push(u.key.replace('crew:', '')); texts[u.key.replace('crew:', '')] = u.caption?.text ?? ''; return true; }, cancelWhere() {}, sterile: false, poke() {} } as unknown as VoiceBus;
  const snap: CommsSnap = { kind: 'jet', startMode: 'runway', wow: true, gs: 0, ias: 0, vsFpm: 0, aglFt: 0, altFt: 0, throttle: 0, flapsIdx: 0, flapDetents: 4, gearDown: true, spoilersArmed: false, spoilersOut: false, reverse: false, autobrake: 0,
    parking: true, enginesRunning: 0, enginesStarting: 0, engineCount: 2, landingLight: false, phase: 'taxi', distNm: 300, eteMin: 50, depStage: 0, pushbackActive: false, v1: 140, vr: 145, vapp: 135, paWelcome: false, paLanding: false, ...over };
  const d = new CommsDirector(bus, { snap: (o) => { Object.assign(o, snap); }, ctx: () => ({ callsign: 'Skyline 123', city: 'Surabaya', fromName: 'Bali', spot: 'Gate A3', night: false, rwy: '09' }) });
  return { d, said, texts, snap, bus, step: (n = 1, dt = 0.5) => { for (let i = 0; i < n; i++) d.update(dt); } };
}

test('take-off roll: callouts follow the real speed — thrust set, 100, V1, rotate, positive rate, gear up — and only once', () => {
  const t = director({ depStage: 5, enginesRunning: 2, flapsIdx: 1, spoilersArmed: true }); t.step(6);
  Object.assign(t.snap, { throttle: 0.95, gs: 40, ias: 40 }); t.step();
  for (const ias of [80, 100, 120, 141, 146]) { Object.assign(t.snap, { gs: ias, ias }); t.step(); t.step(); }
  Object.assign(t.snap, { wow: false, aglFt: 30, vsFpm: 1800 }); t.step(); t.step();
  Object.assign(t.snap, { gearDown: false, aglFt: 120 }); t.step();
  const seq = t.said.filter((k) => ['to-thrust', 'to-100', 'to-v1', 'to-rotate', 'posrate', 'gear-up'].includes(k));
  assert.deepEqual(seq, ['to-thrust', 'to-100', 'to-v1', 'to-rotate', 'posrate', 'gear-up']);
});

test('state-aware: cues describe the real configuration (flaps, spoilers, gear) instead of reading a script', () => {
  const bad = director({ depStage: 4, enginesRunning: 2, flapsIdx: 0, spoilersArmed: false }); bad.step(6);
  assert.match(bad.texts['before-to'], /flaps not set.*spoilers not armed/);
  const good = director({ depStage: 4, enginesRunning: 2, flapsIdx: 1, spoilersArmed: true }); good.step(6);
  assert.match(good.texts['before-to'], /Flaps 1, ground spoilers armed/);
  const gate = director({ startMode: 'final', wow: false, aglFt: 1200, altFt: 1500, vsFpm: -700, gs: 140, ias: 140, distNm: 3, gearDown: false, flapsIdx: 2 }); gate.step(4);
  Object.assign(gate.snap, { aglFt: 950 }); gate.step();
  assert.match(gate.texts['gate-1000'], /Gear is not down\. Not stable/);
});

test('sterile cockpit: PA and small talk are held during the take-off roll and released after', () => {
  const t = director({ depStage: 5, enginesRunning: 2 });
  Object.assign(t.snap, { throttle: 0.95, gs: 60 }); t.step();
  assert.equal(t.bus.sterile, true);
  Object.assign(t.snap, { wow: false, aglFt: 3000, vsFpm: 1500, throttle: 0.9 }); t.step();
  assert.equal(t.bus.sterile, false);
});

test('a new flight re-arms every cue', () => {
  const t = director({ enginesRunning: 0 }); t.step(8);
  assert.ok(t.said.includes('start-fo')); const n = t.said.length;
  t.step(4); assert.equal(t.said.length, n, 'cues are not repeated');
  t.d.reset(); t.step(8); assert.ok(t.said.filter((k) => k === 'start-fo').length === 2);
});

// ---------------------------------------------------------------------------------------------------------------------
test('Indonesian transcripts: generated ATC phraseology is translated, numbers / callsigns / names are untouched', () => {
  const ctx: RadioCtx = { callsign: 'Skyline 123', fromIcao: 'WADD', toIcao: 'WARR', fromName: 'Bali', toName: 'Surabaya', letter: 'Alpha', spot: 'Gate A3', atDest: false, lastCat: '', rwyFallback: '09', style: 'ICAO', kind: 'jet', fromTowered: true, toTowered: true,
    wx: { dir: 270, kt: 18, gust: 32, visKm: 3.5, ceilFt: 900, rain: 0.5, snow: 0, thunder: true, night: true, ok: true } };
  let n = 1; const leftovers: string[] = [];
  const LEFT = /\b(cleared|request|climb|descend|runway|expect|vacate|contact|hold|report|maintain|take-?off|landing|squawk|wind|visibility|thank)\b/i;
  for (const [who, text] of [
    ['CLEARANCE', 'Skyline 123, WADD Delivery. Cleared to WARR as filed, runway 09 departure, initial climb 5000 feet, squawk 4215. QNH 1012.'],
    ['GROUND', 'Skyline 123, pushback approved, tail towards the taxiway. Start-up at your discretion.'],
    ['GROUND', 'Skyline 123, taxi to holding point runway 09 via A, B. QNH 1012.'],
    ['TOWER', 'Skyline 123, wind 270° 8 knots, runway 09, cleared for take-off.'],
    ['DEPARTURE', 'Skyline 123, airborne, radar contact. Climb and maintain 36000 ft, contact Departure 119.3.'],
    ['APPROACH', 'Skyline 123, WARR Approach. Descend and maintain 3,500 ft, QNH 1012. Expect ILS runway 09.'],
    ['TOWER', 'Skyline 123, Runway 09, wind 270° 8 knots, cleared to land.'],
    ['TOWER', 'Skyline 123, rollout safe. Vacate the runway when able and contact Ground 121.9.'],
  ] as const) {
    for (let rep = 0; rep < 3; rep++) for (const l of buildExchange(who, text, { ...ctx, atDest: /WARR|rollout/.test(text) }, () => n++).lines) {
      const id = translateId(l.text); if (LEFT.test(id)) leftovers.push(`${l.text}  =>  ${id}`);
      for (const num of l.text.match(/\d{2,}/g) ?? []) assert.ok(id.replace(/\./g, ',').includes(num.replace(/\./g, ',')) || /\d,\d{3}/.test(l.text), `number ${num} kept in: ${id}`);
    }
  }
  assert.deepEqual(leftovers, [], 'no untranslated ATC vocabulary');
  assert.equal(translateId('Skyline 123, runway 27, cleared for take-off.'), 'Skyline 123, landasan pacu 27, diizinkan lepas landas.');
  assert.equal(transcriptText({ text: 'Rotate.', textId: 'Rotasi.' }, 'id'), 'Rotasi.', 'a curated line wins over the rule table');
  assert.equal(transcriptText({ text: 'Rotate.' }, 'en'), 'Rotate.', 'English is the default and is never altered');
});
