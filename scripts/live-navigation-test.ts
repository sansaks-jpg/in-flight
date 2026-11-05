// Live physics/chart regressions, deliberately separate from the frozen layout matrix.
// Full-world GPU rendering is excluded, including the first frame; the map canvas/physics remain real.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { Game } from '../src/sim/game';

type Frame = { time: number; lat: number; lon: number; centerError: number; angleError: number };
interface QAWindow extends Window {
  __sky: Game;
  __navigationQA: { frames: Frame[]; worldRenders: number; chirps: number; north: boolean };
}
const startedAt = Date.now();
const report = (message: string) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
const url = process.env.FLIGHT_UI_URL || 'http://127.0.0.1:5173';
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({ executablePath, headless: true, args: [
  '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  // Software ANGLE in headless_shell otherwise waits on a nonexistent GPU vsync.
  '--disable-frame-rate-limit', '--disable-gpu-vsync',
  ...(executablePath ? ['--no-zygote', '--single-process'] : []),
] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors: string[] = [], requests = new Map<string, number[]>();
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(20000);
try {
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    const key = route.request().url(), times = requests.get(key) ?? [];
    times.push(Date.now()); requests.set(key, times);
    return route.abort();
  });
  await page.addInitScript({ content: `
    window.__name = (fn) => fn;
    let navigationTestGame;
    Object.defineProperty(window, '__sky', { configurable: true, get() { return navigationTestGame; }, set(game) {
      navigationTestGame = game; game.render = () => {}; game.canvas.style.opacity = '0';
    }});
  ` });
  await page.addInitScript((origin) => {
    if (location.origin === origin) localStorage.setItem('skyline.settings.v3', JSON.stringify({
      quality: 'low', muted: true, voice: false, startMode: 'cruise', wind: 'light', hudMode: 'standard',
    }));
  }, new URL(url).origin);
  await page.goto(url);
  await page.getByRole('button', { name: /QUICK FLIGHT/ }).click({ timeout: 60000 });
  await page.waitForFunction(() => (window as QAWindow).__sky?.phase === 'idle', null, { timeout: 60000 });
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await page.waitForFunction(() => (window as QAWindow).__sky.hud().gsKt > 5);
  await page.evaluate(() => {
    const w = window as QAWindow, g = w.__sky;
    w.__navigationQA = { frames: [], worldRenders: 0, chirps: 0, north: false };
    // Count attempted hidden 3D renders without benchmarking the software GPU's scene cost.
    Reflect.set(g, 'render', () => w.__navigationQA.worldRenders++);
    g.audio.chirp = () => { w.__navigationQA.chirps++; };
    const fill = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill = function (...args: Parameters<typeof fill>) {
      // The aircraft alone has this shadow. Read its actual drawn transform, not a parallel UI model.
      if (this.shadowBlur === 6 && this.canvas.closest('.flight-full-map')) {
        const transform = this.getTransform(), rect = this.canvas.getBoundingClientRect();
        const ratio = this.canvas.width / rect.width;
        const expected = (g.fm.heading - (w.__navigationQA.north ? 0 : g.fm.track)) * Math.PI / 180;
        const difference = Math.atan2(transform.b, transform.a) - expected;
        w.__navigationQA.frames.push({ time: performance.now(), lat: g.lat(), lon: g.lon(),
          centerError: Math.hypot(transform.e / ratio - rect.width / 2, transform.f / ratio - rect.height / 2),
          angleError: Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference))),
        });
      }
      return fill.apply(this, args);
    };
  });

  await page.keyboard.press('m'); await page.waitForSelector('.flight-full-map');
  assert.equal(await page.locator('.flight-shell').count(), 0);
  assert.equal(await page.evaluate(() => (window as QAWindow).__sky.mapOnly), true);
  assert.equal(await page.locator('canvas[aria-label="Flight view"]').evaluate((canvas) => getComputedStyle(canvas).visibility), 'hidden');
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(() => (window as QAWindow).__navigationQA.frames.length > 8);
  const before = await page.evaluate(() => {
    const w = window as QAWindow; w.__navigationQA.frames.length = 0; w.__navigationQA.worldRenders = 0;
    return { time: performance.now(), lat: w.__sky.lat(), lon: w.__sky.lon() };
  });
  await page.waitForTimeout(1300);
  const tracking = await page.evaluate((before) => {
    const w = window as QAWindow, frames = w.__navigationQA.frames;
    return { elapsed: performance.now() - before.time, count: frames.length,
      positions: new Set(frames.map((frame) => `${frame.lat},${frame.lon}`)).size,
      maxCenterError: Math.max(...frames.map((frame) => frame.centerError)),
      maxAngleError: Math.max(...frames.map((frame) => frame.angleError)),
      worldRenders: w.__navigationQA.worldRenders, lat: w.__sky.lat(), lon: w.__sky.lon(),
    };
  }, before);
  assert.ok(tracking.count / tracking.elapsed * 1000 >= 20, `live map draw cadence: ${JSON.stringify(tracking)}`);
  assert.ok(tracking.positions >= 20, 'aircraft pose is live, not a 120 ms follow tick or a frozen screenshot');
  assert.ok(tracking.maxCenterError < .02, 'follow stays centered on the current physical position even at high zoom');
  assert.ok(tracking.maxAngleError < .00001, 'aircraft heading and ground track come from the same current physics frame');
  assert.equal(tracking.worldRenders, 0, 'do not render a hidden 3D scene');
  assert.ok(Math.hypot(tracking.lat - before.lat, tracking.lon - before.lon) > .00005, 'physics continues under the opaque map');
  report(`✓ Live tracking: ${Math.round(tracking.count / tracking.elapsed * 1000)} draws/s, ${tracking.positions} physical poses, <0.02 px follow error; hidden 3D renders: 0.`);

  await page.getByRole('button', { name: 'Switch to north-up' }).click();
  await page.evaluate(() => { const qa = (window as QAWindow).__navigationQA; qa.north = true; qa.frames.length = 0; });
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => (window as QAWindow).__navigationQA.frames.every((frame) => frame.angleError < .00001)));
  await page.locator('.flight-map-options > summary').click();
  const runways = await page.getByRole('combobox', { name: 'Arrival runway' }).locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
  const current = await page.evaluate(() => (window as QAWindow).__sky.hud().apprRwy);
  const selected = runways.find((runway) => runway !== current) ?? current;
  await page.getByRole('combobox', { name: 'Arrival runway' }).selectOption(selected);
  const navigation = await page.evaluate(() => {
    const g = (window as QAWindow).__sky, h = g.hud(), state = g.getMapState(), wp = g.flightPlan[g.activeWpIdx];
    const windX = g.fm.wind.x + g.fm.gust.x, windZ = g.fm.wind.z + g.fm.gust.z;
    const runway = g.cfg.to.runways.find((r) => r.le === h.apprRwy || r.he === h.apprRwy)!;
    const lat = runway.le === h.apprRwy ? runway.leLat : runway.heLat;
    const lon = runway.le === h.apprRwy ? runway.leLon : runway.heLon;
    return {
      realPose: Math.abs(state.lat - g.world!.proj.lat(g.fm.pos.z)) + Math.abs(state.lon - g.world!.proj.lon(g.fm.pos.x)),
      runwayError: Math.abs(state.appr!.lat - lat) + Math.abs(state.appr!.lon - lon),
      runway: h.apprRwy, hdgError: Math.abs(h.hdg - g.fm.heading), trackError: Math.abs(h.track - g.fm.track),
      altError: Math.abs(h.altFt * .3048 - g.fm.pos.y), gsError: Math.abs(h.gsKt * .514444 - g.fm.gs),
      windError: Math.abs(h.wind.kt * .514444 - Math.hypot(windX, windZ)),
      etaError: Math.abs(h.activeWp!.etaMin - h.activeWp!.distNm / h.gsKt * 60),
      active: h.activeWp?.name === wp.name, ilsCourse: g.computeIls()?.course, runwayHeading: h.rwyHdg,
      fuelTimeError: Math.abs(h.fuelTimeMin - Math.round(g.fm.fuel / g.fm.fuelFlow / 60)),
      fdError: Math.abs((h.pitchTarget ?? 0) - Math.round(g.ap.pitchTargetRad! * 180 / Math.PI * 10) / 10),
    };
  });
  assert.equal(navigation.runway, selected); assert.equal(navigation.active, true);
  assert.equal(navigation.ilsCourse, navigation.runwayHeading);
  for (const field of ['realPose', 'runwayError', 'hdgError', 'trackError', 'altError', 'gsError', 'windError', 'etaError', 'fuelTimeError', 'fdError'] as const)
    assert.ok(navigation[field] < .000001, `${field} must use actual simulation state: ${JSON.stringify(navigation)}`);
  report('✓ Real projection, aircraft pose, active waypoint, GS/ETE, local wind, fuel endurance, director and selected ILS threshold agree.');

  const exchange = await page.evaluate(() => {
    const w = window as QAWindow, g = w.__sky;
    const pilots = g.hud().atcLog.filter((message) => message.sender === 'PILOT').length, chirps = w.__navigationQA.chirps;
    for (let i = 0; i < 10; i++) g.respondAtc(3);
    g.setView('chase'); g.pause();
    return { pilots, chirps, time: g.time, text: Reflect.get(g, 'atcReply').text };
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => (window as QAWindow).__sky.time), exchange.time, 'radio exchange and simulation pause together');
  assert.equal(await page.evaluate(() => (window as QAWindow).__sky.atcResponding), true);
  assert.equal(await page.evaluate(() => (window as QAWindow).__navigationQA.chirps), exchange.chirps + 1);
  assert.equal(await page.evaluate(() => (window as QAWindow).__sky.hud().atcLog.filter((m) => m.sender === 'PILOT').length), exchange.pilots + 1);
  await page.evaluate(() => { const g = (window as QAWindow).__sky; g.resume(); g.hooks.onCommand('map'); });
  await page.waitForSelector('.flight-full-map');
  await page.waitForFunction(() => !(window as QAWindow).__sky.atcResponding);
  assert.equal(await page.evaluate((text) => (window as QAWindow).__sky.hud().atcLog.filter((m) => m.text === text).length, exchange.text), 1);
  const readOnly = await page.evaluate(() => {
    const w = window as QAWindow, g = w.__sky, previous = g.currentFlightPhase;
    g.currentFlightPhase = 'taxi'; const count = g.hud().atcLog.length, chirps = w.__navigationQA.chirps;
    for (let i = 0; i < 100; i++) g.hud();
    const changed = g.hud().atcLog.length !== count || w.__navigationQA.chirps !== chirps;
    g.currentFlightPhase = previous; return changed;
  });
  assert.equal(readOnly, false, 'reading navigation/HUD snapshots cannot retransmit phase events');
  const restarted = await page.evaluate(() => { const g = (window as QAWindow).__sky; g.respondAtc(2); g.restart(); return g.time; });
  assert.equal(await page.evaluate(() => (window as QAWindow).__sky.atcResponding), false);
  await page.waitForFunction((time) => (window as QAWindow).__sky.time > time + 1.7, restarted);
  assert.equal(await page.evaluate(() => (window as QAWindow).__sky.hud().atcLog.some((m) => m.text.includes('cleared as filed'))), false, 'restart cannot receive an old controller timeout');
  report('✓ One radio chirp/reply per exchange; pause/resume, read-only snapshots and restart do not replay transmissions.');

  const cache = await page.evaluate(async () => {
    const moduleUrl = '/src/ui/CanvasMap.ts'; const { CanvasMap } = await import(/* @vite-ignore */ moduleUrl);
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'position:absolute;left:-10000px;width:640px;height:480px'; document.body.append(canvas);
    const map = new CanvasMap(canvas); Reflect.set(map, 'drawLayer', () => {}); map.showScale = false; map.resize(); map.setView(-6.2, 106.85, 12);
    map.backgroundOverlay = (g: CanvasRenderingContext2D) => { const [x, y] = map.project(-6.2, 106.85); g.fillStyle = '#ff00ff'; g.fillRect(x - 4, y - 4, 8, 8); };
    map.draw();
    for (let i = 0; i < 20; i++) { map.lat += .000001; map.lon += .000001; map.rot += .0001; map.draw(); }
    const [x, y] = map.project(-6.2, 106.85), color = [...map.g.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
    const builds = map.stats.backgroundBuilds; map.zoomBy(1); map.draw(); const afterZoom = map.stats.backgroundBuilds;
    map.panBy(400, 0); map.draw(); const afterPan = map.stats.backgroundBuilds;
    const frames = map.stats.frames; map.dispose(); canvas.remove();
    return { builds, afterZoom, afterPan, frames, color };
  });
  assert.equal(cache.builds, 1, '20 small real projection/rotation changes reuse one chart surface');
  assert.equal(cache.afterZoom, 2); assert.equal(cache.afterPan, 3); assert.equal(cache.frames, 23);
  assert.ok(cache.color[0] > 220 && cache.color[1] < 80 && cache.color[2] > 220, 'cached artwork stays at its correct geographic position');
  for (const [key, times] of requests) for (let i = 1; i < times.length; i++)
    assert.ok(times[i] - times[i - 1] >= 14000, `failed imagery was retried without backoff: ${key} (${times[i] - times[i - 1]} ms)`);
  assert.deepEqual(errors, []);
  report('✓ Chart cache projection, pan/zoom invalidation and offline imagery backoff regressions passed.');
} catch (error) {
  console.error('Live test state:', await page.evaluate(() => { const g = (window as QAWindow).__sky; return { phase: g.phase, time: g.time, suspended: g.suspended, mapOnly: g.mapOnly, replying: g.atcResponding }; }).catch(() => 'unavailable'));
  await mkdir('.tmp', { recursive: true }); await page.screenshot({ path: '.tmp/live-navigation-failure.png', timeout: 5000 }).catch(() => {});
  throw error;
} finally { await browser.close(); }
