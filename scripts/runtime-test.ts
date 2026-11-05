import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechQueue, type SpeechRequest } from '../src/sim/speech';

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
  const { Game } = await import('../src/sim/game');
  const phase = Reflect.get(Game.prototype, 'computeFlightPhase') as (this: unknown) => string;
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
