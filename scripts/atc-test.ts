// ATC radio regression: ICAO speech normalisation, exchange structure per category, contextual
// phrase variation (different airports / consecutive exchanges must not be identical), and the
// lifecycle guarantees — cancel() = total silence, setPaused() = silence that resumes.
// Runs headless in node: speechSynthesis is absent, so lines advance on the timer estimate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AtcRadio, buildExchange, toRadioSpeech, RadioCtx, RadioLine } from '../src/sim/atc';

const ctx: RadioCtx = { callsign: 'Aero 101', fromIcao: 'WAHI', toIcao: 'WARR', fromName: 'Yogyakarta', toName: 'Surabaya', letter: 'B', spot: 'Hangar 2', atDest: false, lastCat: '', rwyFallback: '09' };
const exchange = (sender: string, text: string, over: Partial<RadioCtx> = {}, idFrom = 1) =>
  buildExchange(sender, text, { ...ctx, ...over }, () => idFrom++);

test('ICAO radiotelephony pronunciation (runways, squawks, levels, QNH)', () => {
  const ok = toRadioSpeech('Runway 27L, cleared to land, squawk 4215, 3,500 ft QNH 1012', ctx);
  assert.match(ok, /two seven left/);
  assert.match(ok, /four two one fife/);
  assert.match(ok, /tree thousand fife hundred/);
});

test('every category produces the standard exchange shape (pilot call -> ATC -> readback)', () => {
  const cases: [string, string, Partial<RadioCtx>][] = [
    ['CLEARANCE', 'Aero 101, WAHI Delivery. Cleared to WARR as filed, runway 09 departure, initial climb 5000 feet, squawk 4215. QNH 1012.', {}],
    ['GROUND', 'Aero 101, taxi to holding point runway 09 via A, B. QNH 1012.', { lastCat: 'startup' }],
    ['TOWER', 'Aero 101, WAHI Tower on 118.3. Runway 09, line up and wait.', {}],
    ['TOWER', 'Aero 101, wind 270° 12 knots, runway 09, cleared for take-off.', { lastCat: 'luaw' }],
    ['DEPARTURE', 'Aero 101, airborne, radar contact. Climb and maintain 36,000 ft, contact Departure on 119.1.', {}],
    ['APPROACH', 'Aero 101, WARR Approach. Descend and maintain 3,500 ft, QNH 1013. Expect ILS runway 27.', { atDest: true }],
    ['TOWER', 'Aero 101, WARR Tower. Runway 27L, wind 240° 8 knots, cleared to land.', { atDest: true }],
    ['GROUND', 'Aero 101, rollout safe. Vacate the runway when able and contact Ground on 121.9.', { atDest: true }],
  ];
  // these categories begin with the pilot's call (ICAO: the pilot initiates); handoff/vacate/
  // monitor/continue-cruise are controller-initiated, and a take-off right after "line up and wait"
  // skips the repeated call
  const startsWithCall = new Set(['clearance', 'pushback', 'startup', 'taxi', 'luaw', 'descent', 'land', 'takeoff']);
  const cats: string[] = [];
  for (const [sender, text, over] of cases) {
    const r = exchange(sender, text, over);
    cats.push(r.cat);
    if (startsWithCall.has(r.cat) && !(r.cat === 'takeoff' && over.lastCat === 'luaw')) assert.equal(r.lines[0].who, 'PILOT', `${r.cat}: pilot initiates`);
    const atcLine = r.lines.find((l) => l.who === sender);
    assert.ok(atcLine, `${r.cat}: controller line present`);
    // the readback is the pilot's LAST line (clearance also appends the "readback correct" ack)
    const rb = [...r.lines].reverse().find((l) => l.who === 'PILOT')!;
    assert.ok(rb.text.includes('Aero 101'), `${r.cat}: readback carries the callsign`);
  }
  assert.deepEqual(cats, ['clearance', 'taxi', 'luaw', 'takeoff', 'handoff', 'descent', 'land', 'vacate']);
  // clearance is the one mandated 4-line exchange (readback-correct ack)
  const cl = exchange('CLEARANCE', 'Aero 101, WAHI Delivery. Cleared to WARR as filed, runway 09 departure, initial climb 5000 feet, squawk 4215. QNH 1012.');
  assert.equal(cl.lines.length, 4);
  assert.match(cl.lines[3].text, /readback correct/i);
  // ATIS is a single station line, never turned into an exchange
  const atis = exchange('ATIS', 'WAHI information B. Runway 09 in use. QNH 1012.');
  assert.equal(atis.lines.length, 1);
  assert.equal(atis.lines[0].who, 'ATIS');
  assert.equal(atis.cat, 'atis');
});

test('contextual variation: different airports and consecutive exchanges are not identical', () => {
  const airports: [string, string, string, string][] = [
    ['WAHI', 'WARR', 'Yogyakarta', 'Surabaya'], ['WIII', 'WADD', 'Jakarta', 'Bali'],
    ['WIMM', 'WIML', 'Medan', 'Banda Aceh'], ['WICC', 'WAJJ', 'Bandung', 'Jayapura'],
    ['WARR', 'WATC', 'Surabaya', 'Mataram'], ['WIIO', 'WIII', 'Semarang', 'Jakarta'],
    ['WADF', 'WIMM', 'Bandung', 'Medan'], ['WATC', 'WICC', 'Mataram', 'Bandung'],
    ['WIML', 'WIIO', 'Banda Aceh', 'Semarang'], ['WADD', 'WARR', 'Bali', 'Surabaya'],
    ['WIID', 'WIDD', 'Palembang', 'Batam'], ['WIOO', 'WIIT', 'Pontianak', 'Balikpapan'],
  ];
  const clTexts = new Set<string>(), rbTexts = new Set<string>(), infoTexts = new Set<string>();
  let id = 1;
  for (const [fromIcao, toIcao, fromName, toName] of airports) {
    const c = { ...ctx, fromIcao, toIcao, fromName, toName };
    const cl = buildExchange('CLEARANCE', `${fromName} Delivery. Cleared to ${toName} as filed, runway 09 departure, initial climb 5000 feet, squawk 4215. QNH 1012.`, { ...c, rwyFallback: '09' }, () => id++);
    clTexts.add(cl.lines[0].text);
    // lines = [pilot call, ATC, pilot READBACK, ack] — the ATC line (index 1) merely echoes the input
    rbTexts.add(cl.lines[2].text);
    const info = buildExchange('ENROUTE', 'Aero 101, radar contact.', { ...c }, () => id++);
    infoTexts.add(info.lines[info.lines.length - 1].text);
  }
  assert.ok(clTexts.size >= 3, `clearance calls vary across airports (${clTexts.size}/12 distinct)`);
  assert.ok(rbTexts.size >= 2, `clearance readbacks vary across airports (${rbTexts.size}/12 distinct)`);
  assert.ok(infoTexts.size >= 2, `information acknowledgements vary across airports (${infoTexts.size}/12 distinct)`);

  // the same airport still rotates: consecutive exchanges must not repeat one phrasing forever
  const repeats: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = exchange('TOWER', 'Aero 101, wind 270° 12 knots, runway 09, cleared for take-off.', { lastCat: 'luaw' }, i + 1);
    repeats.push(r.lines.find((l) => l.who === 'PILOT')!.text);
  }
  assert.ok(new Set(repeats).size >= 2, `consecutive takeoff readbacks rotate (${new Set(repeats).size}/8 distinct)`);

  // 2-variant pools must rotate too (nonce steps exactly one per exchange): 6 taxi readbacks, 2 phrasings
  const taxiRbs: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = exchange('GROUND', 'Aero 101, taxi to holding point runway 09 via A. QNH 1012.', { lastCat: 'startup' }, i + 1);
    taxiRbs.push(r.lines[r.lines.length - 1].text);
  }
  assert.equal(new Set(taxiRbs).size, 2, `taxi readbacks exhaust their 2-variant pool (${new Set(taxiRbs).size}/2 distinct)`);
  // and the 3-variant information pool cycles through all of its phrasings (info exchanges are
  // ATC line + pilot ack — the ack is the last line)
  const infoCycle: string[] = [];
  for (let i = 0; i < 3; i++) infoCycle.push(exchange('ENROUTE', 'Aero 101, radar contact.', {}, i + 1).lines[1].text);
  assert.equal(new Set(infoCycle).size, 3, `information acks cycle the 3-variant pool (${new Set(infoCycle).size}/3 distinct)`);

  // mandated content never disappears in any variant: runway, squawk, QNH and the destination stay
  const cl = exchange('CLEARANCE', 'Aero 101, WAHI Delivery. Cleared to WARR as filed, runway 09 departure, initial climb 5000 feet, squawk 4215. QNH 1012.');
  const rbAll = cl.lines.filter((l) => l.who === 'PILOT').map((l) => l.text).join(' ');
  assert.match(rbAll, /09/); assert.match(rbAll, /4215/); assert.match(rbAll, /1012/); assert.match(rbAll, /Surabaya/);
});

const radioHarness = () => {
  const lines: RadioLine[] = [];
  let live: RadioLine | null = null;
  const radio = new AtcRadio({
    onLine: (l) => lines.push(l),
    onLive: (l) => { live = l; },
    voiceOn: () => false, volume: () => 1, key: () => {},
  });
  const short = (who: string): RadioLine => ({ id: lines.length + 1, who, label: who, text: 'roger', speech: 'roger' });
  return {
    radio, lines, live: () => live, short,
    wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
};

test('cancel() is total silence: the active line stops and the queue never speaks again', async () => {
  const h = radioHarness();
  h.radio.enqueue([h.short('TOWER'), h.short('PILOT')]);
  h.radio.enqueue([h.short('TOWER'), h.short('PILOT')]);
  await h.wait(20);
  assert.equal(h.lines.length, 1, 'first line is on the air');
  assert.equal(h.radio.pending, 2, 'the second exchange is still queued');
  h.radio.cancel();
  await h.wait(120);
  assert.equal(h.live(), null);
  assert.equal(h.radio.pending, 0);
  const at = h.lines.length;
  await h.wait(300);
  assert.equal(h.lines.length, at, 'no further lines after cancel (menu stays silent)');
  assert.equal(h.radio.live, null);
});

test('setPaused(true) freezes the exchange mid-flow; setPaused(false) plays the parked lines', async () => {
  const h = radioHarness();
  h.radio.enqueue([h.short('TOWER'), h.short('PILOT'), h.short('TOWER')]);
  await h.wait(20);
  assert.equal(h.lines.length, 1);
  // let the first line's headless timer finish (~1.9 s) and the chain advance to line two
  await h.wait(2500);
  assert.equal(h.lines.length, 2, 'second line on the air before the pause');
  h.radio.setPaused(true);
  await h.wait(2500);
  assert.equal(h.lines.length, 2, 'paused radio speaks nothing further — the chain is halted mid-exchange');
  h.radio.setPaused(false);
  await h.wait(200);
  assert.ok(h.lines.length >= 3, 'resuming plays the parked remaining lines');
  // let the last line's headless timer run out: the exchange completes and the radio goes idle
  await h.wait(2200);
  assert.equal(h.radio.pending, 0, 'exchange completes after resume');
  assert.equal(h.live(), null);
});

test('cancel() clears a stuck paused state (flight after pause-out is not mute)', async () => {
  const h = radioHarness();
  h.radio.setPaused(true);
  h.radio.enqueue([h.short('TOWER')]);
  await h.wait(60);
  assert.equal(h.lines.length, 0, 'frozen radio says nothing');
  h.radio.cancel(); // leaving paused -> new flight: the radio must come back up
  h.radio.enqueue([h.short('TOWER')]);
  await h.wait(60);
  assert.equal(h.lines.length, 1, 'a fresh flight gets its ATC audio');
});
