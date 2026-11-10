// Shared helpers for cockpit QA: headless Chromium driving the real game (window.__sky).
// The pinned cockpit GLB / manifest are served from local files (QA_GLB / QA_MANIFEST) so the run never depends on GitHub's CDN.
import { chromium } from 'playwright';
import fs from 'node:fs';

export const URL_ = process.env.QA_URL || 'http://127.0.0.1:5173';
export const GLB = process.env.QA_GLB || '/tmp/glb/cockpit.glb';
export const MANIFEST = process.env.QA_MANIFEST || '/tmp/glb/manifest.json';

export async function launch({ width = 1280, height = 720 } = {}) {
  const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=9222', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type().toUpperCase() + ' ' + m.text().slice(0, 300)); });
  const glb = fs.readFileSync(GLB), manifest = fs.readFileSync(MANIFEST);
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(URL_)) return route.continue();
    if (u.endsWith('/cockpit.glb')) return route.fulfill({ status: 200, body: glb, headers: { 'access-control-allow-origin': '*', 'content-type': 'model/gltf-binary' } });
    if (u.endsWith('/cockpit-manifest.json')) return route.fulfill({ status: 200, body: manifest, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } });
    return route.abort();
  });
  await page.addInitScript((origin) => {
    if (location.origin === origin) localStorage.setItem('skyline.settings.v3', JSON.stringify({ quality: 'low', muted: true, voice: false, startMode: 'runway', wind: 'calm', hudMode: 'cockpit', uiScale: 1 }));
  }, new URL(URL_).origin);
  return { browser, page, errors };
}

export async function startFlight(page) {
  await page.goto(URL_);
  await page.getByRole('button', { name: /QUICK FLIGHT/ }).click({ timeout: 90000 });
  await page.waitForFunction(() => window.__sky?.phase === 'idle', null, { timeout: 120000 });
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await page.waitForFunction(() => window.__sky?.cockpit?.loaded === true, null, { timeout: 180000 });
}
