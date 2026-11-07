import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlightModel } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
import { SpeechQueue, type SpeechRequest } from '../src/sim/speech';
import { A320Systems, THR_DETENTS, snapThrottle, thrDetentName, type CockpitHost } from '../src/sim/a320/systems';
import { Efb, CHECKLISTS, checklistForPhase, type EfbInfo } from '../src/sim/a320/efb';
import { DEFAULT_CHECKLIST_ITEMS } from '../src/sim/navAssists';
import { AIRPORT_BY_ID } from '../src/data/airports';

const request = (key: string, kind: SpeechRequest['kind'] = 'announcement'): SpeechRequest =>
  ({ key, text: key, cooldown: 3, rate: 1, pitch: 1, volume: 1, kind });
function speechHarness() {
  let now = 0, cancellations = 0;
  const spoken: { request: SpeechRequest; finish: () => void }[] = [];
  const queue = new SpeechQueue({ speak: (request, finish) => spoken.push({ request, finish }), cancel: () => { cancellations++; } }, () => now);
  return { queue, spoken, setTime: (time: number) => { now = time; }, cancellations: () => cancellations };
}

test('voice cannot enqueue the currently speaking or already pending message, including timestamp zero', () => {
  const h = speechHarness();
  assert.equal(h.queue.request(request('radio')), true);
  for (let i = 0; i < 100; i++) assert.equal(h.queue.request(request('radio')), false);
  h.queue.request(request('next'));
  assert.equal(h.queue.request(request('next')), false);
  assert.equal(h.spoken.length, 1);
  h.setTime(5); h.spoken[0].finish();
  assert.equal(h.spoken[1].request.key, 'next');
  assert.equal(h.queue.request(request('radio')), false, 'cooldown starts after playback finishes, not when it was queued');
  h.setTime(8); h.spoken[1].finish();
  assert.equal(h.queue.request(request('radio')), true);
  h.queue.clear();
});

test('voice queue is bounded, expires obsolete announcements, and keeps only the latest pending altitude callout', () => {
  const h = speechHarness(); h.queue.request(request('active'));
  for (let i = 0; i < 100; i++) h.queue.request(request(`message-${i}`));
  h.spoken[0].finish();
  assert.equal(h.spoken[1].request.key, 'message-96', 'only four pending messages survive a burst');
  h.setTime(30); h.spoken[1].finish();
  assert.equal(h.spoken.length, 2, 'expired messages are not read out later');
  h.queue.request(request('active-2'));
  h.queue.request(request('c500', 'callout')); h.queue.request(request('c100', 'callout')); h.queue.request(request('c50', 'callout'));
  h.spoken[2].finish();
  assert.equal(h.spoken[3].request.key, 'c50');
  h.queue.clear();
});

test('obsolete safety speech is canceled when the physical warning clears; an active warning can still repeat safely after its cooldown', () => {
  const h = speechHarness();
  h.queue.retainWarning('stall'); h.queue.request(request('stall', 'warning'));
  h.setTime(10);
  assert.equal(h.queue.request(request('stall', 'warning')), false, 'a long utterance never queues itself');
  h.spoken[0].finish();
  h.setTime(13); assert.equal(h.queue.request(request('stall', 'warning')), true);
  h.queue.retainWarning(null);
  assert.equal(h.cancellations(), 1);
  const count = h.spoken.length; h.spoken[1].finish();
  assert.equal(h.spoken.length, count, 'late browser completion events cannot resurrect a warning');
});

test('silencing/reset discards all pending speech and stale completion events cannot restart old flight audio', () => {
  const h = speechHarness();
  h.queue.request(request('old-flight')); h.queue.request(request('old-response'));
  h.queue.clear(); h.queue.request(request('new-flight'));
  h.spoken[0].finish();
  assert.deepEqual(h.spoken.map((item) => item.request.key), ['old-flight', 'new-flight']);
  h.spoken[1].finish(); assert.equal(h.spoken.length, 2);
});

test('safety speech preempts a cabin announcement instead of sitting in a browser speech backlog', () => {
  const h = speechHarness(); h.queue.request(request('cabin'));
  h.queue.retainWarning('pu'); h.queue.request(request('pu', 'warning'));
  assert.equal(h.cancellations(), 1); assert.equal(h.spoken[1].request.key, 'pu');
  h.queue.clear();
});

test('audio mute, voice-off, pause/reset and zero volume cancel owned speech without replay', async (t) => {
  const spoken: { onend: (() => void) | null }[] = []; let canceled = 0;
  const synth = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const utterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { speak: (u: typeof spoken[number]) => spoken.push(u), cancel: () => canceled++ } });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { onend = null; constructor(public text: string) {} } });
  t.after(() => {
    if (synth) Object.defineProperty(globalThis, 'speechSynthesis', synth); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (utterance) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utterance); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  });
  const { AudioEngine } = await import('../src/sim/audio'); const audio = new AudioEngine();
  audio.speak('Radio', 'radio', 0); audio.speak('Radio', 'radio', 0);
  assert.equal(spoken.length, 1);
  audio.setMuted(true); audio.speak('Muted', 'muted'); assert.equal(spoken.length, 1);
  audio.setMuted(false); audio.speak('Second', 'second'); assert.equal(spoken.length, 2);
  audio.voiceOn = false; audio.speak('Voice off', 'off'); assert.equal(spoken.length, 2);
  audio.voiceOn = true; audio.speak('Third', 'third'); audio.silence();
  spoken[0].onend?.(); assert.equal(spoken.length, 3);
  audio.setVolume(0); audio.speak('Silent volume', 'zero'); assert.equal(spoken.length, 3);
  assert.ok(canceled >= 4);
});

test('failed map/terrain images are shared and use bounded backoff instead of a request/redraw loop', async (t) => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const started: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(value: string) { if (value) started.push(this); }
    crossOrigin = ''; decoding = '';
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Image', original); else Reflect.deleteProperty(globalThis, 'Image'); });
  const { loadImage, peekImage, imageRetryAt, cancelQueued } = await import('../src/sim/tiles');
  const url = 'https://tiles.test/backoff/0/0.png';
  const first = loadImage(url); assert.equal(loadImage(url), first); assert.equal(started.length, 1);
  started[0].onerror!(); assert.equal(await first, null); assert.equal(imageRetryAt(url), 15000);
  await Promise.all(Array.from({ length: 100 }, () => loadImage(url)));
  assert.equal(started.length, 1, 'a frame cannot retry a failed image during backoff');
  // Exercise the real shared LRU: chart zoom + 3D terrain can evict a failed image.
  const oldCount = started.length;
  for (let i = 0; i < 1000; i++) {
    const image = loadImage(`https://tiles.test/lru/${i}.png`); started[started.length - 1].onload!(); await image;
  }
  assert.equal(started.length, oldCount + 1000);
  assert.equal(await loadImage(url), null);
  assert.equal(started.length, oldCount + 1000, 'LRU eviction cannot bypass a failure deadline');
  const retryStart = started.length;
  now = 15000; const second = loadImage(url); assert.equal(started.length, retryStart + 1);
  started[retryStart].onerror!(); await second; assert.equal(imageRetryAt(url), 45000);
  now = 45000; const third = loadImage(url); started[retryStart + 1].onload!();
  assert.equal(await third, started[retryStart + 1]); assert.equal(peekImage(url), started[retryStart + 1]); assert.equal(imageRetryAt(url), 0);
  const start = started.length;
  const batch = Array.from({ length: 20 }, (_, i) => loadImage(`https://tiles.test/cancel/${i}.png`));
  assert.equal(started.length - start, 10, 'keep the shared map/terrain concurrency limit');
  cancelQueued((key) => key.includes('/cancel/'));
  for (const image of started.slice(start)) image.onload!();
  const result = await Promise.all(batch);
  assert.equal(result.filter(Boolean).length, 10); assert.equal(result.filter((image) => image === null).length, 10);
});

test('flight-director pitch reference follows the real autopilot command rather than a fixed climb angle', async () => {
  const { Autopilot } = await import('../src/sim/autopilot');
  const { FlightModel } = await import('../src/sim/physics');
  const { AIRCRAFT } = await import('../src/sim/specs');
  const fm = new FlightModel(AIRCRAFT[0], () => 0); fm.placeAirborne(0, 2000, 0, 90, 120, 0, false);
  const ap = new Autopilot(); ap.engage(fm); ap.nav = false;
  ap.altFt = 12000; ap.step(fm, 1 / 60, null, null); const climb = ap.pitchTargetRad!;
  ap.altFt = 1000; ap.step(fm, 1 / 60, null, null); const descent = ap.pitchTargetRad!;
  assert.ok(Number.isFinite(climb) && Number.isFinite(descent)); assert.ok(climb > descent);
  ap.disengage(); assert.equal(ap.pitchTargetRad, null);
});

test('flight-phase hysteresis prevents repeated radio clearances during go-around, climb and threshold-speed jitter', async () => {
  const { computeFlightPhaseState } = await import('../src/sim/flightPhase');
  const phase = {
    call: (_self: unknown) => computeFlightPhaseState(_self as any),
  };
  const state = {
    fm: { ias: 100 * .514444, agl: 1000 * .3048, vs: 800 / 196.85, wow: false, ctl: { throttle: .9 } },
    spec: { cruiseAlt: 8000 * .3048 }, currentFlightPhase: 'final',
    landing: null as object | null, takeoffDone: true, ap: { appr: false }, distToDest: () => 4 * 1852,
  };
  for (let i = 0; i < 100; i++) {
    state.currentFlightPhase = phase.call(state);
    assert.equal(state.currentFlightPhase, 'climb', 'a climbing go-around cannot oscillate back to final each frame');
  }
  state.fm.vs = 240 / 196.85;
  assert.equal(phase.call(state), 'climb', 'vertical-speed jitter near the go-around threshold cannot reissue final clearance');
  state.fm.vs = 800 / 196.85;
  state.landing = {};
  assert.equal(phase.call(state), 'climb', 'a touch-and-go also remains a climb instead of reissuing landing clearance');
  state.landing = null;
  state.fm.agl = 9000 * .3048; state.distToDest = () => 14.5 * 1852;
  for (let i = 0; i < 100; i++) {
    state.currentFlightPhase = phase.call(state);
    assert.equal(state.currentFlightPhase, 'climb', 'positive climb near arrival cannot alternate climb/descent radio calls');
  }
  state.fm.wow = true; state.fm.ias = 17 * .514444; state.takeoffDone = false; state.currentFlightPhase = 'takeoff';
  assert.equal(phase.call(state), 'takeoff');
  state.fm.ctl.throttle = .54; assert.equal(phase.call(state), 'takeoff', 'small throttle jitter does not retransmit a takeoff clearance');
  state.currentFlightPhase = 'taxi'; assert.equal(phase.call(state), 'taxi');
  state.landing = {}; state.currentFlightPhase = 'rollout'; state.fm.ias = 24 * .514444;
  assert.equal(phase.call(state), 'rollout');
  state.fm.ias = 19 * .514444; assert.equal(phase.call(state), 'taxi');
});


// ---------------------------------------------------------------- A320 flight deck: FADEC detents, system consequences, EFB
test('thrust-lever detents follow the A320 TLA gates (IDLE 0°, CL 25°, FLX/MCT 35°, TOGA 45°) and snap magnetically', () => {
  assert.deepEqual(THR_DETENTS.map((d) => d.name), ['IDLE', 'CL', 'FLX/MCT', 'TOGA']);
  assert.ok(Math.abs(THR_DETENTS[1].v - 25 / 45) < 1e-9 && Math.abs(THR_DETENTS[2].v - 35 / 45) < 1e-9);
  assert.equal(snapThrottle(25 / 45 + 0.02), 25 / 45);
  assert.equal(snapThrottle(0.97), 1);
  assert.equal(snapThrottle(0.4), 0.4);
  assert.equal(thrDetentName(35 / 45), 'FLX/MCT');
  assert.equal(thrDetentName(0.9, true), 'REV');
  assert.match(thrDetentName(0.4), /IDLE–CL/);
});

function deckHarness() {
  const fm = new FlightModel(AIRCRAFT[0], () => 0); fm.placeAirborne(0, 9000, 0, 90, 200, 0, false);
  const toasts: string[] = [];
  const host = { fm, ap: { on: false, nav: false, appr: false, hdg: 0, altFt: 0, spd: 250 }, lights: { nav: false, strobe: false, land: false, beacon: false }, seatbelt: false, action() {}, setApTarget() {}, toast: (m: string) => { toasts.push(m); }, route: () => [], position: () => ({ lat: 0, lon: 0 }), magVar: () => 0 } as unknown as CockpitHost;
  const d = { altFt: 9000, warn: [] as string[] } as never;
  return { fm, host, d, toasts, sys: new A320Systems() };
}

test('hydraulics gate brakes, flaps, gear and spoilers; fuel pumps and anti-ice change engine behaviour', () => {
  const h = deckHarness(), { sys, fm } = h;
  sys.update(0.01, h.host, h.d);
  assert.equal(fm.ctl.brakePress, 0, 'no Yellow pressure and an empty accumulator -> no wheel braking');
  sys.hyd.yellow = 3000; sys.update(0.01, h.host, h.d);
  assert.equal(fm.ctl.brakePress, 1);
  // pressurised once -> the locks are armed; now lose Green + Blue
  sys.hyd.green = 3000; sys.hyd.blue = 3000; sys.update(0.01, h.host, h.d);
  fm.ctl.flapsIdx = 2; sys.update(0.01, h.host, h.d);
  sys.hyd.green = 0; sys.hyd.blue = 0; sys.hyd.yellow = 0; sys.accumPsi = 0; sys.update(0.01, h.host, h.d);
  fm.ctl.flapsIdx = 4; sys.update(0.01, h.host, h.d);
  assert.equal(fm.ctl.flapsIdx, 2, 'flaps cannot move with Green + Blue lost');
  fm.ctl.gearDown = true; sys.update(0.01, h.host, h.d); fm.ctl.gearDown = false; sys.update(0.01, h.host, h.d);
  assert.equal(fm.ctl.gearDown, true, 'gear retraction needs Green hydraulics');
  fm.ctl.speedbrake = 1; sys.update(0.01, h.host, h.d);
  assert.ok(fm.ctl.speedbrake < 0.01, 'no hydraulics -> no speedbrakes');
  // fuel feed
  fm.eng[0].state = 2; sys.master[0] = true; sys.pumps = [false, false, false, false, true, true];
  const hi = { altFt: 30000, warn: [] as string[] } as never;
  for (let i = 0; i < 6; i++) sys.update(1, h.host, hi);
  assert.equal(fm.eng[0].state, 0, 'all feeding pumps OFF above FL250 -> flame-out');
  assert.equal(fm.eng[1].state === 2 || fm.eng[1].state === 0, true);
  // anti-ice thrust penalty
  const g = deckHarness(); g.sys.engAI = [true, true]; g.sys.update(0.01, g.host, g.d);
  assert.ok(g.fm.ctl.thrLimit < 0.99 && g.fm.ctl.thrLimit > 0.9, `thrLimit ${g.fm.ctl.thrLimit}`);
});

test('EFB: four airline checklists, flight-plan / radio pages and hit-testing without a DOM', () => {
  const noop = () => undefined;
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: String(s).length * 8 }) : noop), set: () => true }) as unknown as CanvasRenderingContext2D;
  assert.deepEqual(CHECKLISTS.map((c) => c.label), ['Before Start', 'After Takeoff', 'Approach', 'Landing']);
  assert.equal(checklistForPhase('taxi'), 0); assert.equal(checklistForPhase('cruise'), 1); assert.equal(checklistForPhase('descent'), 2); assert.equal(checklistForPhase('rollout'), 3);
  const toggled: string[] = [];
  const info: EfbInfo = { dep: AIRPORT_BY_ID.get('WIII')!, arr: AIRPORT_BY_ID.get('WADD')!, depRwy: '25R', arrRwy: '09', callsign: 'TST123', phase: 'taxi', wx: null, windFrom: 250, windKt: 8, qnh: 1010, oatC: 30,
    route: [{ name: 'WIII', type: 'airport', distNm: 480 }, { name: 'ABASA', type: 'fix', distNm: 300 }], activeWp: 1, checklist: DEFAULT_CHECKLIST_ITEMS.map((x) => ({ ...x })), toggle: (id) => toggled.push(id), fuelKg: 9000, distNm: 480, eteMin: 75, utcMs: Date.UTC(2026, 0, 1, 12, 30) };
  const efb = new Efb(); efb.draw(ctx, info, 1, 1.5);
  assert.equal(efb.page, 'CHECK');
  assert.ok(efb.click((196 + 300) / Efb.W, (150 + 30) / Efb.H), 'first checklist row is clickable');
  assert.deepEqual(toggled, ['battery_on']);
  assert.match(efb.hover(100 / Efb.W, 104 / Efb.H) ?? '', /Open Checklist/);
  efb.click(60 / Efb.W, (74 + 78 + 30) / Efb.H); efb.draw(ctx, info, 1); assert.equal(efb.page, 'PLAN');
  efb.click(60 / Efb.W, (74 + 3 * 78 + 30) / Efb.H); efb.draw(ctx, info, 1); assert.equal(efb.page, 'RADIO');
  efb.wheel(100); efb.draw(ctx, info, 0.2);
  assert.equal(efb.dirty, false);
});
