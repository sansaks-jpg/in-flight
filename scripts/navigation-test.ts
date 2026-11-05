import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flightUiScale, formatDistance, formatEte, formatHeading, navigationCue, nextHudMode, primaryAlert, HUD_MODES } from '../src/ui/navigation';
import type { HudState } from '../src/sim/game';

test('headings are rounded, padded and wrapped at true north', () => {
  assert.equal(formatHeading(359.9), '000°');
  assert.equal(formatHeading(-1), '359°');
  assert.equal(formatHeading(721), '001°');
  assert.equal(formatHeading(5.1), '005°');
  assert.equal(formatHeading(NaN), '---°');
  assert.equal(formatHeading(Infinity), '---°');
  for (let heading = -720; heading < 720; heading += .7) {
    assert.match(formatHeading(heading), /^\d{3}°$/);
    assert.ok(parseInt(formatHeading(heading)) < 360);
  }
});

test('ETE is consistently hours:minutes and unavailable on the ground', () => {
  assert.equal(formatEte(5.9), '00:05');
  assert.equal(formatEte(65), '01:05');
  assert.equal(formatEte(0), '00:00');
  assert.equal(formatEte(5, false), '--:--');
  for (const invalid of [-1, NaN, Infinity, 6000]) assert.equal(formatEte(invalid), '--:--');
});

test('distance never displays invalid telemetry', () => {
  assert.equal(formatDistance(0), '0.0');
  assert.equal(formatDistance(5.52), '5.5');
  assert.equal(formatDistance(230.4), '230');
  assert.equal(formatDistance(NaN), '—');
  assert.equal(formatDistance(-1), '—');
});

test('keyboard, gamepad and menu restore all four HUD layouts', () => {
  for (let i = 0; i < HUD_MODES.length; i++) assert.equal(nextHudMode(HUD_MODES[i]), HUD_MODES[(i + 1) % HUD_MODES.length]);
  assert.deepEqual(HUD_MODES, ['standard', 'minimal', 'assisted', 'cockpit']);
  assert.equal(nextHudMode('cockpit'), 'standard');
});

const base: Parameters<typeof navigationCue>[0] = {
  activeWp: { name: 'TEST', brg: 1, distNm: 5, etaMin: 2 }, brg: 240,
  track: 359, hdg: 20, gsKt: 100, onGround: false, depRwy: '09', parking: false,
};
test('course guidance uses the shortest turn across north and the active waypoint', () => {
  assert.equal(navigationCue(base).text, 'On course');
  assert.equal(navigationCue({ ...base, track: 340 }).direction, 'right');
  assert.equal(navigationCue({ ...base, track: 20 }).direction, 'left');
  assert.equal(navigationCue({ ...base, activeWp: null, brg: 20, track: 0 }).text, 'Turn right 20°');
  assert.equal(navigationCue({ ...base, gsKt: 0, hdg: 1 }).text, 'On course');
  assert.equal(navigationCue({ ...base, onGround: true }).text, 'Follow runway 09');
  assert.equal(navigationCue({ ...base, onGround: true, parking: true }).text, 'Release parking brake to taxi');
});

test('unacknowledged warnings always take priority over cautions and acknowledged alerts', () => {
  const caution: HudState['warn'][number] = { text: 'LOW FUEL', level: 'caution' };
  const warning: HudState['warn'][number] = { text: 'TERRAIN', level: 'warning' };
  const acked: HudState['warn'][number] = { text: 'STALL', level: 'warning', acked: true };
  assert.equal(primaryAlert([caution, acked, warning]), warning);
  assert.equal(primaryAlert([acked, caution]), caution);
  assert.equal(primaryAlert([acked]), acked);
  assert.equal(primaryAlert([]), undefined);
});

test('text sizing stays readable without scaling the flight workspace', () => {
  for (const preferred of [.75, 1, 1.25, 1.5]) {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1366, 768], [1920, 1080], [3840, 2160]]) {
      const scale = flightUiScale(preferred, width, height);
      assert.ok(scale >= .9 && scale <= 1.5);
      if (width < 600 || height < 400) assert.ok(scale <= 1.25);
    }
  }
  assert.equal(flightUiScale(1.5, 3840, 2160), 1.5);
  assert.equal(flightUiScale(1.5, 1366, 768), 1.5);
  assert.equal(flightUiScale(.75, 320, 568), .9);
  assert.equal(flightUiScale(NaN, 1440, 900), 1);
  assert.equal(flightUiScale(Infinity, 1440, 900), 1);
});

test('selecting HDG or NAV releases a captured ILS approach instead of silently continuing autoland', async () => {
  const { Autopilot } = await import('../src/sim/autopilot');
  const ap = new Autopilot(); ap.on = true;
  for (const mode of ['heading', 'nav'] as const) {
    ap.phase = 'approach'; ap.appr = true; ap.gsCaptured = true;
    ap.setLateralMode(mode);
    assert.equal(ap.phase, 'cruise');
    assert.equal(ap.appr, false);
    assert.equal(ap.gsCaptured, false);
    assert.equal(ap.nav, mode === 'nav');
    assert.equal(ap.on, true);
  }
});

import { flightWorkspaceReducer as workspace, INITIAL_WORKSPACE } from '../src/ui/flightWorkspace';

test('one labeled tool replaces the previous window instead of stacking panels', () => {
  const nav = workspace(INITIAL_WORKSPACE, { type: 'navigation', tab: 'plan' });
  const radio = workspace(nav, { type: 'toggle', tool: 'radio' });
  assert.equal(radio.tool, 'radio'); assert.equal(radio.navigationTab, 'plan');
  assert.equal(workspace(radio, { type: 'toggle', tool: 'radio' }).tool, null);
  assert.deepEqual(INITIAL_WORKSPACE, { tool: null, navigationTab: 'map', minimized: false });
});

test('navigation tabs open directly from any tool without changing other workspace behavior', () => {
  const ap = workspace(INITIAL_WORKSPACE, { type: 'toggle', tool: 'autopilot' });
  const nav = workspace(ap, { type: 'navigation', tab: 'map' });
  assert.equal(nav.tool, 'navigation'); assert.equal(nav.navigationTab, 'map');
  const plan = workspace(nav, { type: 'navigation', tab: 'plan' });
  assert.equal(plan.tool, 'navigation'); assert.equal(plan.navigationTab, 'plan');
  assert.equal(workspace(plan, { type: 'close' }).navigationTab, 'plan');
});

test('minimized tools restore in one action and close without losing the navigation tab', () => {
  const plan = workspace(INITIAL_WORKSPACE, { type: 'navigation', tab: 'plan' });
  const minimized = workspace(plan, { type: 'minimize' });
  assert.equal(minimized.minimized, true);
  assert.deepEqual(workspace(minimized, { type: 'toggle', tool: 'navigation' }), plan);
  assert.equal(workspace(minimized, { type: 'restore' }).minimized, false);
  const closed = workspace(minimized, { type: 'close' });
  assert.equal(closed.tool, null); assert.equal(closed.navigationTab, 'plan');
  assert.deepEqual(workspace(INITIAL_WORKSPACE, { type: 'minimize' }), INITIAL_WORKSPACE);
});

test('the four-HUD instrument layouts render genuine flight data without scaling their geometry', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { PrimaryFlightDisplay } = await import('../src/ui/FlightInstruments');
  const { FlightEdgeInstruments } = await import('../src/ui/FlightEdgeInstruments');
  const hud = { kias: 100, altFt: 10000, vsFpm: -500, aglFt: 700, n1: .72, throttle: .3, fuelPct: 32, alphaFrac: .2, flapsIdx: 1, flapsDet: 4, trim: .1, pitch: 4, bank: -6, timeScale: 1, flightPhase: 'final', pitchTarget: 3, ap: { on: false }, ils: { valid: true, locDots: .32, gsDots: -.63, ident: 'ILS07R' }, apprRwy: '07R', destId: 'WIII', hdg: 359.9, track: 1, activeWp: { name: 'RWY06', distNm: 0 }, onGround: false } as HudState;
  const aviation = renderToStaticMarkup(createElement(PrimaryFlightDisplay, { hud, metric: false }));
  const metric = renderToStaticMarkup(createElement(PrimaryFlightDisplay, { hud, metric: true }));
  for (const text of ['IAS 100 KT', 'ALT 10000 FT', '000°', 'ILS07R']) assert.ok(aviation.includes(text), text);
  for (const text of ['IAS 185 KM/H', 'ALT 3048 M']) assert.ok(metric.includes(text), text);
  const edge = renderToStaticMarkup(createElement(FlightEdgeInstruments, { hud, metric: false, showHeading: false }));
  for (const text of ['AIRSPEED', 'ALTITUDE', 'ENGINE', 'FUEL', 'AOA', 'FLAPS', 'TRIM', 'V. SPEED', '72%', '32%']) assert.ok(edge.includes(text), text);
  assert.doesNotMatch(edge, /Heading compass/);
  assert.doesNotMatch(aviation + metric + edge, /NaN|Infinity|scale\(/);
});
