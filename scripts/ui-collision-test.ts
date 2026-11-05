// Automated UI/UX Geometry & Collision Verification Suite.
// Measure the real rendered HUD instead of maintaining a second, approximate layout in a test.
// Run against `npm run dev`; install a browser with `npx playwright install chromium` first.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import type { Game } from '../src/sim/game';
import type { HudMode } from '../src/sim/storage';

interface TestWindow extends Window { __sky: Game; __flightUiTimer?: number }
const url = process.env.FLIGHT_UI_URL || 'http://127.0.0.1:5173';
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({ executablePath, headless: true, args: [
  '--no-sandbox', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  ...(executablePath ? ['--no-zygote', '--single-process'] : []),
] });
let scenarios = 0;
let interactionsChecked = false;
const errors: string[] = [];

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function refresh(page: Page) {
  await page.evaluate(() => { const g = (window as TestWindow).__sky; g.hooks.onHud(g.hud()); });
  await settle(page);
}
async function clickTool(page: Page, label: string) {
  // Functional tests below use real mouse/keyboard input. Matrix tests only need the UI's own state transitions.
  await page.locator('.flight-toolbar').getByRole('button', { name: label, exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  await settle(page);
}
async function closeTool(page: Page) {
  if (await page.locator('.flight-window').count()) {
    await page.locator('.flight-window .flight-panel-actions button').last().click();
    await settle(page);
  }
}
async function setMode(page: Page, mode: HudMode) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  for (let i = 0; i < 3 && await page.locator('.flight-shell').getAttribute('data-mode') !== mode; i++) {
    await page.keyboard.press('h'); await settle(page);
  }
  assert.equal(await page.locator('.flight-shell').getAttribute('data-mode'), mode);
}
async function ensureMap(page: Page) {
  if (!await page.locator('.flight-navigation-panel').count()) await clickTool(page, 'Navigation');
  const restore = page.getByRole('button', { name: 'Restore navigation', exact: true });
  if (await restore.count()) { await restore.click(); await settle(page); }
  await page.getByRole('tab', { name: 'Map', exact: true }).click(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1);
}
async function setScale(page: Page, scale: number) {
  await closeTool(page); await clickTool(page, 'Display');
  await page.locator('.flight-disclosure > summary').getByText('Text, units & accessibility', { exact: true }).click();
  await page.getByLabel('Interface size').selectOption(String(scale));
  await closeTool(page); await settle(page);
}
async function setWarnings(page: Page, active: boolean) {
  await page.evaluate((active) => {
    const g = (window as TestWindow).__sky;
    Reflect.set(g, 'warnState', active ? [
      { text: 'LOW FUEL', level: 'caution', sound: 'fuel' },
      { text: 'TERRAIN', level: 'warning', sound: 'terrain' },
    ] : []);
    Reflect.set(g, 'ackedWarnings', new Set<string>());
    g.hooks.onHud(g.hud());
  }, active);
  await settle(page);
}
async function startFlight(page: Page) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  // Navigation must keep working without third-party terrain or raster tiles.
  await page.route('**/*', (route) => {
    const request = new URL(route.request().url());
    return request.origin === new URL(url).origin ? route.continue() : route.abort();
  });
  // Measure actual DOM/physics without submitting the full 3D scene to a software GPU.
  await page.addInitScript({ content: `
    let flightTestGame;
    Object.defineProperty(window, '__sky', { configurable: true,
      get() { return flightTestGame; }, set(game) {
        flightTestGame = game; game.render = () => {}; game.canvas.style.opacity = '0';
      }
    });
  ` });
  await page.addInitScript(({ origin, startMode }) => {
    // An opaque about:blank teardown document has no storage; it is not the app under test.
    if (location.origin !== origin) return;
    localStorage.setItem('skyline.settings.v3', JSON.stringify({
      quality: 'low', muted: true, voice: false, startMode, wind: 'calm', hudMode: 'standard', uiScale: 1,
    }));
  }, { origin: new URL(url).origin, startMode: process.env.UI_START_MODE ?? 'cruise' });
  await page.goto(url);
  await page.getByRole('button', { name: /QUICK FLIGHT/ }).click({ timeout: 60000 });
  await page.waitForFunction(() => (window as TestWindow).__sky?.phase === 'idle', null, { timeout: 60000 });
  // Layout/interaction checks exercise actual physics and DOM, not the software GPU's scene cost.
  await page.evaluate(() => Reflect.set((window as TestWindow).__sky, 'render', () => {}));
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await page.waitForSelector('.flight-shell');
  await page.waitForFunction(() => (window as TestWindow).__sky.hud().gsKt > 5, null, { timeout: 60000 });
}
async function freezeForLayout(page: Page) {
  // Keep a genuine scenario/HUD, but stop expensive 3D rendering and physics during the layout matrix.
  await page.evaluate(() => {
    const w = window as TestWindow, g = w.__sky; g.suspended = true;
    w.__flightUiTimer = window.setInterval(() => g.hooks.onHud(g.hud()), 100);
  });
}
async function checkLayout(page: Page, label: string) {
  const boxes = await page.evaluate(() => {
    const selectors = ['.flight-route-identity', '.flight-header-status', '.flight-toolbar', '.flight-alert',
      '.flight-tool-panel', '.flight-navigation-panel', '.flight-telemetry', '.flight-instruments',
      '[data-touch-left]', '[data-touch-right]', '.flight-instructor', '.flight-mini-map', '.flight-heading-compass', '.flight-edge-left', '.flight-edge-right', '.flight-bottom-right', '.flight-scenery-status'];
    return selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)].flatMap((el) => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.bottom < 0) return [];
      return [{ name: selector, x: rect.x, y: rect.y, w: rect.width, h: rect.height }];
    }));
  });
  const viewport = page.viewportSize()!;
  assert.equal(await page.locator('.flight-shell').evaluate((root) => getComputedStyle(root).transform), 'none', `${label}: never zoom the whole flight workspace`);
  for (const b of boxes) {
    if (b.name === '.flight-toolbar') assert.ok(b.w <= Math.min(520, viewport.width - 4) && b.h <= 54, `${label}: toolbar must stay compact`);
    if (b.name === '.flight-mini-map') assert.ok(b.w <= 193 && b.h <= 229, `${label}: the always-available map stays small`);
    if (b.name === '.flight-instruments') assert.ok(b.w <= 430 && b.h <= 278, `${label}: instruments must not grow with text size`);
    if (b.name === '.flight-navigation-panel' || b.name === '.flight-tool-panel') {
      assert.ok(b.w <= 320, `${label}: side panels must not grow with text size`);
    }
  }
  for (const b of boxes) assert.ok(b.x >= -1 && b.y >= -1 && b.x + b.w <= viewport.width + 1 && b.y + b.h <= viewport.height + 1,
    `${label}: ${b.name} is outside the viewport: ${JSON.stringify(b)}`);
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
    const a = boxes[i];
    const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    assert.ok(overlapX < 2 || overlapY < 2, `${label}: ${a.name} overlaps ${b.name} (${overlapX.toFixed(1)} × ${overlapY.toFixed(1)})`);
  }
  const clippedControls = await page.locator('.flight-navigation-chart').evaluateAll((charts) => charts.flatMap((chart) => {
    const bounds = chart.getBoundingClientRect();
    return [...chart.querySelectorAll<HTMLButtonElement>('button')].flatMap((button) => {
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const inside = rect.x >= bounds.x - 1 && rect.y >= bounds.y - 1 && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1;
      return inside ? [] : [button.getAttribute('aria-label') || button.textContent];
    });
  }));
  assert.deepEqual(clippedControls, [], `${label}: map controls must not be clipped`);
  const clippedChart = await page.locator('.flight-navigation-chart').evaluateAll((charts) => charts.some((chart) => {
    const parent = chart.closest('.flight-panel')!.getBoundingClientRect(), rect = chart.getBoundingClientRect();
    return rect.bottom > parent.bottom + 1 || rect.height < 63;
  }));
  assert.equal(clippedChart, false, `${label}: the chart itself must fit inside its panel`);
  const clippedPfd = await page.locator('.flight-pfd, .flight-telemetry').evaluateAll((instruments) => instruments.some((wrapper) =>
    wrapper.scrollWidth > wrapper.clientWidth + 1 || wrapper.scrollHeight > wrapper.clientHeight + 1));
  assert.equal(clippedPfd, false, `${label}: instrument content must fit its compact frame`);
  scenarios++;
}

async function functionalChecks(page: Page) {
  console.log('Checking real map, keyboard, autopilot and radio interactions…');
  const time = await page.evaluate(() => (window as TestWindow).__sky.time);
  await page.mouse.move(720, 40);
  assert.equal(await page.locator('.flight-window').count(), 0, 'Start with the flight view, not an unsolicited window');
  assert.equal(await page.locator('.flight-mini-map canvas').count(), 1, 'Flight starts with a small live navigation map');
  await page.getByRole('button', { name: 'Open flight plan', exact: true }).click();
  await page.waitForSelector('.flight-navigation-panel');
  assert.equal(await page.getByRole('tab', { name: 'Flight plan', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.phase), 'playing');
  await page.waitForFunction((time) => (window as TestWindow).__sky.time > time, time);
  await closeTool(page);
  await freezeForLayout(page);

  await ensureMap(page);
  const map = page.locator('.flight-navigation-panel');
  await map.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await map.locator('canvas').hover(); await page.mouse.wheel(0, -100); await settle(page);
  assert.equal(await map.getByRole('button', { name: 'Follow aircraft', exact: true }).count(), 0, 'Zoom must not break aircraft-follow');
  const beforeLook = await page.evaluate(() => (window as TestWindow).__sky.lookYaw);
  const box = await map.locator('canvas').boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .6);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .35 + 60, box.y + box.height * .6 + 15, { steps: 3 }); await page.mouse.up();
  await page.waitForSelector('.flight-map-recenter');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.lookYaw), beforeLook, 'Map drag must not move the cockpit camera');
  await map.getByRole('button', { name: 'Follow aircraft', exact: true }).click();
  await map.getByRole('button', { name: 'Switch to north-up', exact: true }).click();
  assert.ok(await map.getByRole('button', { name: 'Switch to track-up', exact: true }).count());
  await map.getByRole('button', { name: 'Fit remaining route', exact: true }).click();
  await map.getByRole('button', { name: 'Follow aircraft', exact: true }).click();

  await page.getByRole('tab', { name: 'Flight plan', exact: true }).click(); await settle(page);
  const active = await page.evaluate(() => (window as TestWindow).__sky.activeWpIdx);
  await page.locator('.flight-waypoint-row').last().click();
  await page.waitForSelector('.flight-map-recenter');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.activeWpIdx), active, 'Locating a waypoint must not skip the flight plan');
  assert.ok(await map.getByRole('button', { name: 'Follow aircraft', exact: true }).count());
  await page.getByRole('tab', { name: 'Flight plan', exact: true }).click(); await settle(page);
  assert.ok(await page.locator('.flight-waypoint-list').evaluate((list) => list.scrollTop > 0), 'The flight log remembers scroll position when returning from its map');
  assert.equal(await page.locator('.flight-waypoint-row[data-selected="true"]').count(), 1, 'The inspected fix stays marked in the flight log');
  await closeTool(page);

  await clickTool(page, 'Autopilot');
  await page.getByRole('button', { name: /Heading HDG/ }).click(); await refresh(page);
  const heading = page.getByRole('spinbutton', { name: 'Target heading' });
  await heading.fill('720'); await heading.press('Enter'); await refresh(page);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.ap.hdg), 0);
  await heading.fill('123'); await heading.press('Escape'); await refresh(page);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.ap.hdg), 0, 'Escape cancels an edit');
  assert.ok(await page.locator('.flight-window').count(), 'First Escape belongs to the editor');
  await page.getByRole('spinbutton', { name: 'Target altitude' }).fill('500000');
  await page.getByRole('spinbutton', { name: 'Target altitude' }).press('Enter'); await refresh(page);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.ap.altFt), 45000);
  await page.getByRole('button', { name: /Route NAV/ }).click(); await refresh(page);
  assert.ok(await page.getByRole('spinbutton', { name: 'Target altitude' }).isDisabled(), 'Managed targets are not editable');
  const runway = await page.evaluate(() => ({ ident: (window as TestWindow).__sky.hud().apprRwy, active: (window as TestWindow).__sky.activeWpIdx }));
  const choice = await page.getByLabel('Arrival runway', { exact: true }).locator('option').evaluateAll((options, current) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value && value !== current), runway.ident);
  assert.ok(choice); await page.getByLabel('Arrival runway', { exact: true }).selectOption(choice); await refresh(page);
  await page.getByLabel('Arrival runway', { exact: true }).focus();
  const afterRunway = await page.evaluate(() => { const g = (window as TestWindow).__sky; return { ident: g.hud().apprRwy, active: g.activeWpIdx, waypoint: g.flightPlan.find((wp) => wp.type === 'touchdown')?.rwyIdent }; });
  assert.notEqual(afterRunway.ident, runway.ident); assert.equal(afterRunway.ident, afterRunway.waypoint); assert.equal(afterRunway.active, runway.active);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.flight-window').count(), 0);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.phase), 'playing', 'Closing a tool must not pause');

  await setWarnings(page, true);
  await page.keyboard.down('a');
  assert.ok(await page.evaluate(() => (window as TestWindow).__sky.keys.has('a')));
  assert.equal(await page.locator('.flight-alert').getAttribute('data-acknowledged'), 'false');
  await page.keyboard.up('a');
  await page.locator('.flight-alert').getByRole('button', { name: 'ACK', exact: true }).click(); await refresh(page);
  assert.match(await page.locator('.flight-alert').innerText(), /LOW FUEL/, 'ACK must acknowledge the displayed warning before the caution');
  await setWarnings(page, false);

  const logCount = await page.evaluate(() => (window as TestWindow).__sky.hud().atcLog.length);
  await page.keyboard.press('1');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.fm.ctl.throttle), .1);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.hud().atcLog.length), logCount);
  await clickTool(page, 'Radio'); await page.keyboard.press('1'); await refresh(page);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.fm.ctl.throttle), .1, 'A radio reply must not change throttle');
  assert.ok(await page.evaluate((count) => (window as TestWindow).__sky.hud().atcLog.length > count, logCount));
  await closeTool(page);

  await ensureMap(page);
  await map.getByRole('button', { name: 'Recenter on aircraft', exact: true }).click();
  if (await map.getByRole('button', { name: 'Switch to north-up', exact: true }).count()) await map.getByRole('button', { name: 'Switch to north-up', exact: true }).click();
  await closeTool(page); await ensureMap(page);
  assert.match(await map.locator('.flight-map-control').first().innerText(), /NORTH UP/, 'Map orientation persists after closing and reopening');
  await page.keyboard.press('m'); await page.waitForSelector('.flight-full-map'); await settle(page);
  assert.equal(await page.locator('.flight-shell').count(), 0, 'Expanded map suppresses duplicate HUD controls');
  assert.equal(await page.locator('.flight-full-map-sidebar, .flight-full-map-header, .flight-full-map-footer, .flight-mini-map, .flight-toolbar, .flight-edge-left, .flight-edge-right').count(), 0, 'M shows only the map, not flight UI or a destination sidebar');
  const viewport = page.viewportSize()!;
  const fullChart = await page.locator('.flight-full-chart').boundingBox();
  assert.deepEqual(fullChart, { x: 0, y: 0, width: viewport.width, height: viewport.height }, 'The chart fills every pixel of the viewport');
  const mapFlightState = await page.evaluate(() => ({ throttle: (window as TestWindow).__sky.fm.ctl.throttle, view: (window as TestWindow).__sky.viewName() }));
  await page.keyboard.press('9'); await page.keyboard.press('c'); await page.keyboard.press('a');
  assert.deepEqual(await page.evaluate(() => ({ throttle: (window as TestWindow).__sky.fm.ctl.throttle, view: (window as TestWindow).__sky.viewName() })), mapFlightState, 'Hidden flight controls do not steal map keyboard input');
  await page.locator('.flight-map-options > summary').click();
  await page.getByLabel('Route & trail', { exact: true }).uncheck(); await settle(page);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('skyline.maplayers.v1') || '{}').route), false);
  await page.getByLabel('Route & trail', { exact: true }).check(); await settle(page);

  await page.locator('[data-autofocus]').focus();
  await page.keyboard.press('Shift+Tab');
  assert.ok(await page.locator('.flight-full-map').evaluate((root) => root.contains(document.activeElement)), 'Expanded map traps keyboard focus');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.flight-full-map').count(), 0);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.phase), 'playing', 'Escape closes the map before pausing');
  await settle(page);
  assert.ok(await page.evaluate(() => document.activeElement === (window as TestWindow).__sky.canvas), 'Closing the expanded map restores aircraft input');
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement instanceof HTMLButtonElement), 'Tab must navigate controls');
  await page.keyboard.press('Escape'); await settle(page);
  assert.equal(await page.locator('.flight-window').count(), 0, 'First Escape closes navigation');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.phase), 'playing');
  await page.keyboard.down('ArrowLeft');
  assert.ok(await page.evaluate(() => (window as TestWindow).__sky.keys.has('ArrowLeft')), 'Arrow keys fly the aircraft after closing a tool');
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.phase), 'paused');
  await page.getByRole('button', { name: 'RESUME FLIGHT', exact: true }).click();

  await clickTool(page, 'Camera'); await page.getByRole('button', { name: /External Follow/ }).click(); await refresh(page);
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.viewName()), 'Chase');
  assert.equal(await page.locator('.flight-window').count(), 0, 'Choosing a camera returns straight to flying');
  await clickTool(page, 'Camera'); await page.getByRole('button', { name: /Cockpit Pilot/ }).click(); await closeTool(page);
  for (const mode of ['standard', 'minimal', 'assisted', 'cockpit'] as const) await setMode(page, mode);
  await clickTool(page, 'Navigation');
  await page.getByRole('button', { name: 'Minimize navigation', exact: true }).click(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 0);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1, 'Clicking the title restores a minimized window');
  await page.getByRole('button', { name: 'Return to flight', exact: true }).click(); await settle(page);
  assert.equal(await page.locator('.flight-window').count(), 0);
  await clickTool(page, 'Display');
  await page.keyboard.press('h'); await settle(page);
  assert.equal(await page.locator('.flight-window').getAttribute('id'), 'flight-panel-display', 'Changing HUD mode never changes the selected tool');
  await page.getByRole('switch', { name: /Full instrument panel/ }).focus(); await page.keyboard.press('Escape'); await settle(page);
  assert.equal(await page.locator('.flight-window').count(), 0, 'Escape works from a focused toggle, not only the window background');
  await setMode(page, 'standard');
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Navigation', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Autopilot');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.keys.has('ArrowRight')), false, 'Toolbar arrows never bank the aircraft');
  await page.evaluate(() => (window as TestWindow).__sky.canvas.focus());
  await ensureMap(page);
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Navigation', exact: true }).focus();
  await page.keyboard.press('m'); await settle(page);
  assert.equal(await page.locator('.flight-full-map').count(), 1, 'M expands the map even from the toolbar');
  assert.equal(await page.locator('.flight-shell').count(), 0);
  await page.locator('.flight-map-options > summary').click();
  await page.getByLabel('Map style', { exact: true }).focus();
  await page.keyboard.press('m'); await settle(page);
  assert.equal(await page.locator('.flight-full-map').count(), 0);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1, 'Returning from M preserves the previous task window');
  assert.ok(await page.evaluate(() => document.activeElement === (window as TestWindow).__sky.canvas), 'M returns aircraft keyboard input');
  await closeTool(page);
  await page.getByRole('button', { name: 'Expand map', exact: true }).click(); await settle(page);
  assert.equal(await page.locator('.flight-full-map').count(), 1, 'The small map also expands with one click');
  await page.keyboard.press('m'); await settle(page);
  assert.equal(await page.locator('.flight-mini-map').count(), 1, 'M returns to the small live map');
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Navigation', exact: true }).focus();
  await page.keyboard.press('Enter'); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1);
  await page.keyboard.press('Enter'); await settle(page);
  assert.equal(await page.locator('.flight-window').count(), 0);
  assert.ok(await page.evaluate(() => document.activeElement === (window as TestWindow).__sky.canvas), 'Toggling a tool closed with Enter returns aircraft input');
  assert.equal(await page.getByRole('button', { name: 'Auto-hide toolbar', exact: true }).getAttribute('aria-pressed'), 'true', 'The restored toolbar starts pinned');
  await page.getByRole('button', { name: 'Auto-hide toolbar', exact: true }).click();
  await page.mouse.move(400, 300); await page.evaluate(() => (window as TestWindow).__sky.canvas.focus());
  await page.waitForFunction(() => document.querySelector('.flight-toolbar-area')?.getAttribute('data-visible') === 'false');
  await page.mouse.move(720, 20);
  await page.waitForFunction(() => document.querySelector('.flight-toolbar-area')?.getAttribute('data-visible') === 'true');
  await page.getByRole('button', { name: 'Keep toolbar visible', exact: true }).click();
  await page.evaluate(() => (window as TestWindow).__sky.canvas.focus());
  await setMode(page, 'standard');
  for (const mode of ['minimal', 'assisted', 'cockpit', 'standard']) {
    await page.keyboard.press('h'); await refresh(page);
    assert.equal(await page.locator('.flight-shell').getAttribute('data-mode'), mode, 'H cycles the previous four HUD layouts');
  }
  await page.evaluate(() => { const g = (window as TestWindow).__sky; g.setView('cockpit'); g.hooks.onHud(g.hud()); }); await settle(page);
  for (const view of ['Chase', 'Spotter', 'Cabin – aisle', 'Cabin – window seat', 'Cockpit']) {
    await page.keyboard.press('c'); await refresh(page);
    assert.equal(await page.evaluate(() => (window as TestWindow).__sky.viewName()), view, 'C restores the prior camera cycle');
  }
  interactionsChecked = true;
  console.log('✓ Flight interaction checks passed.');
}

async function touchChecks(page: Page) {
  assert.equal(await page.locator('.flight-window').count(), 0, 'A phone starts with an unobstructed flight view');
  assert.equal(await page.locator('.flight-mini-map').count(), 1);
  await page.getByRole('button', { name: 'Expand map', exact: true }).tap(); await settle(page);
  assert.equal(await page.locator('.flight-shell').count(), 0, 'Full-screen map hides even the touch controls');
  await page.getByRole('button', { name: 'Return to flight', exact: true }).tap(); await settle(page);
  assert.equal(await page.locator('.flight-mini-map').count(), 1);
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Navigation', exact: true }).tap(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1, 'Navigation opens with one tap');
  assert.equal(await page.locator('.flight-toolbar .flight-tooltip').first().isVisible(), false, 'Touch never leaves a hover tooltip covering the window title');
  await page.getByRole('tab', { name: 'Flight plan', exact: true }).tap(); await settle(page);
  assert.ok(await page.locator('.flight-waypoint-list').evaluate((list) => list.clientHeight >= 140), 'A phone gives the flight log room for multiple waypoints, not repeated route chrome');
  await page.locator('.flight-waypoint-row').last().tap(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1, 'Inspecting a fix switches straight to the map');
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Autopilot', exact: true }).tap(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-panel').count(), 0, 'Switching tools replaces the previous window');
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.phase), 'playing');
  await page.getByRole('button', { name: 'Close autopilot', exact: true }).tap(); await settle(page);
  assert.equal(await page.locator('.flight-window').count(), 0, 'Closing a tool means return to flight, not another window');
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Navigation', exact: true }).tap(); await settle(page);
  await page.getByRole('button', { name: 'Minimize navigation', exact: true }).tap(); await settle(page);
  await page.locator('.flight-toolbar').getByRole('button', { name: 'Navigation', exact: true }).tap(); await settle(page);
  assert.equal(await page.locator('.flight-navigation-chart').count(), 1, 'A minimized tool restores with one toolbar tap');
  await closeTool(page);
  // Real touch events exercise pointer capture and release, not synthetic pointer IDs.
  const stick = await page.locator('.flight-touch-stick').boundingBox(); assert.ok(stick);
  const session = await page.context().newCDPSession(page);
  const center = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [center] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: center.x + stick.width * .25, y: center.y }] });
  assert.ok(await page.evaluate(() => (window as TestWindow).__sky.touch.roll > .3), 'The compact stick retains its full control range');
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await page.evaluate(() => (window as TestWindow).__sky.touch.roll), 0, 'Releasing the stick returns the aircraft input to neutral');
  await session.detach();
  console.log('✓ Phone tap, disclosure and real touch-stick checks passed.');
}

async function layoutMatrix(page: Page, touch: boolean) {
  const selected = process.env.UI_VIEWPORTS?.split(',');
  const viewports = (touch ? [[390, 844], [320, 568], [844, 390], [568, 320], [768, 1024]] : [[1920, 1080], [1366, 768], [1024, 768], [768, 1024], [844, 390], [390, 844]])
    .filter(([width, height]) => !selected || selected.includes(`${width}x${height}`));
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height }); await settle(page);
    for (const scale of touch ? [1, 1.5] : [.75, 1, 1.5]) {
      await setScale(page, scale);
      for (const mode of ['standard', 'minimal', 'assisted', 'cockpit'] as const) {
        await closeTool(page); await setMode(page, mode); await ensureMap(page);
        await page.evaluate(() => { const g = (window as TestWindow).__sky; g.setView('chase'); g.hooks.onHud(g.hud()); }); await settle(page);
        for (const warning of [false, true]) {
          await setWarnings(page, warning);
          for (const tool of [null, 'Autopilot', 'Flight view']) {
            if (tool === 'Flight view') await closeTool(page); else if (tool) await clickTool(page, tool); else await ensureMap(page);
            // Keep the toolbar revealed so it can also be checked for collisions.
            await page.locator('.flight-toolbar-handle').evaluate((b) => (b as HTMLButtonElement).click()); await settle(page);
            await checkLayout(page, `${touch ? 'touch' : 'mouse'} ${width}×${height} scale=${scale} mode=${mode} warning=${warning} tool=${tool}`);
            await closeTool(page);
          }
        }
      }
    }
    await setWarnings(page, false);
    await ensureMap(page); await page.getByRole('tab', { name: 'Flight plan', exact: true }).click(); await settle(page);
    assert.ok(await page.locator('.flight-waypoint-list').evaluate((list) => list.clientHeight >= 40), `Flight log remains usable at ${width}×${height}`);
    await closeTool(page);
    await page.keyboard.press('m'); await page.waitForSelector('.flight-full-map'); await settle(page);
    const chart = await page.locator('.flight-full-chart').boundingBox();
    assert.deepEqual(chart, { x: 0, y: 0, width, height }, `Expanded map fills the screen at ${width}×${height}`);
    assert.equal(await page.locator('.flight-shell').count(), 0);
    await page.keyboard.press('Escape'); await settle(page);
    console.log(`✓ ${touch ? 'Touch' : 'Mouse'} ${width}×${height}`);
  }
  await setWarnings(page, false);
}

let currentPage: Page | undefined;
try {
  if (process.env.UI_MATRIX !== 'touch') {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    currentPage = await desktop.newPage(); await startFlight(currentPage); await functionalChecks(currentPage); await freezeForLayout(currentPage); await layoutMatrix(currentPage, false);
    await currentPage.goto('about:blank');
  }
  if (process.env.UI_MATRIX !== 'desktop') {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    currentPage = await mobile.newPage(); await startFlight(currentPage); await touchChecks(currentPage); await freezeForLayout(currentPage); await layoutMatrix(currentPage, true);
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(`\n✓ ${scenarios} real-DOM layout scenarios passed, ${interactionsChecked ? 'plus map/keyboard/autopilot/radio interaction checks.' : '(layout matrix only).'}`);
} catch (error) {
  await mkdir('.tmp', { recursive: true });
  console.error('Browser errors:', errors);
  await currentPage?.screenshot({ path: '.tmp/flight-ui-failure.png', timeout: 5000 }).catch(() => {});
  throw error;
} finally { await browser.close(); }
