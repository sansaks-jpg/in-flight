import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';

// Minimal DOM Image so the loader can run in Node; tiles "load" only when the test says so.
const started: { src: string; onload: (() => void) | null; onerror: (() => void) | null }[] = [];
class FakeImage {
  onload: (() => void) | null = null; onerror: (() => void) | null = null; crossOrigin = ''; decoding = '';
  set src(v: string) { if (v) started.push({ src: v, get onload() { return self.onload; }, get onerror() { return self.onerror; } } as never); const self = this; }
  decode() { return Promise.resolve(); }
}
(globalThis as unknown as { Image: unknown }).Image = FakeImage;

const view = (lat: number, lon: number, alt: number) => {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return { dirX: Math.cos(la) * Math.cos(lo), dirY: Math.sin(la), dirZ: -Math.cos(la) * Math.sin(lo), dist: 1 + alt, viewW: 1400, viewH: 850, tanHalfFov: Math.tan((35 * Math.PI) / 360) };
};

test('requests ancestors first and goes deeper as the camera descends, with a bounded request count', async () => {
  const { GlobeTiles } = await import('../src/ui/globeTiles');
  const tiles = new GlobeTiles(new THREE.Group(), 4, () => {});
  tiles.update(view(-6.1, 106.6, 1.819 / 160), 0);
  const z = started.map((s) => Number(/\/tile\/(\d+)\//.exec(s.src)![1]));
  assert.ok(z.length > 0 && z.length <= 8, 'concurrency limit');
  assert.equal(Math.min(...z), 4, 'coarse tiles are requested first');
  assert.ok(started.every((s) => s.src.includes('blankTile=false')), 'Esri placeholder tiles are disabled');
  tiles.dispose();
});

test('a failed (404) tile is never subdivided: no deeper requests below missing coverage', async () => {
  started.length = 0;
  const { GlobeTiles } = await import('../src/ui/globeTiles');
  const tiles = new GlobeTiles(new THREE.Group(), 4, () => {});
  const v = view(-14.69, -75.15, 1.819 / 6000);
  let late = 0, first = 0;
  for (let round = 0; round < 20; round++) {
    tiles.update(v, round * 1000);
    const batch = started.splice(0);
    if (round === 0) first = batch.length; else if (round > 1) late += batch.length;
    // every request fails (as Esri does beyond its coverage with blankTile=false)
    for (const s of batch) s.onerror?.();
    await Promise.resolve();
  }
  assert.ok(first <= 8, 'first burst is bounded by the concurrency limit');
  assert.equal(late, 0, `kept re-requesting missing tiles (${late} requests after the failure was recorded)`);
  tiles.dispose();
});

test('selection stays cheap and bounded at maximum zoom', async () => {
  started.length = 0;
  const { GlobeTiles } = await import('../src/ui/globeTiles');
  const tiles = new GlobeTiles(new THREE.Group(), 4, () => {});
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) tiles.update(view(1.35, 103.99, 0.55 / 6371), i * 100);
  const per = (performance.now() - t0) / 200;
  assert.ok(per < 3, `tile selection took ${per.toFixed(2)} ms per update`);
  tiles.dispose();
});

test('fly-to: arrives exactly, eases in/out, pulls back on long hops and stays within a comfortable duration', async () => {
  const { GlobeFlight, decayVelocity, wheelToLogZoom } = await import('../src/ui/globeCamera');
  const f = new GlobeFlight();
  const D = Math.PI / 180;
  f.start(0, { lat: 51.5 * D, lon: -0.1 * D, zoom: 1.2 }, { lat: -6.1 * D, lon: 106.6 * D, zoom: 600 });
  const out = { lat: 0, lon: 0, zoom: 1 };
  const dur = f.endsAt;
  assert.ok(dur >= 1200 && dur <= 3800, `duration ${dur} ms`);
  let prevLat = 51.5 * D, maxStep = 0;
  for (let t = 0; t <= dur + 16; t += 16) {
    f.sample(t, out);
    maxStep = Math.max(maxStep, Math.abs(out.lat - prevLat)); prevLat = out.lat;
    assert.ok(out.zoom >= 1 && Number.isFinite(out.lat) && Number.isFinite(out.lon));
  }
  assert.ok(Math.abs(out.lat - -6.1 * D) < 1e-9 && Math.abs(out.zoom - 600) < 1e-6, 'final state is exact');
  assert.ok(!f.active);
  assert.ok(maxStep < 0.03, 'no teleporting steps between frames');
  const g = new GlobeFlight();
  g.start(0, { lat: 0, lon: 0, zoom: 500 }, { lat: 0.0002, lon: 0.0002, zoom: 500 });
  let z = Infinity; for (let t = 0; t <= g.endsAt; t += 16) { g.sample(t, out); z = Math.min(z, out.zoom); }
  assert.ok(z > 470, 'short hops stay put in zoom');
  const notch = Math.exp(wheelToLogZoom({ deltaY: -100, deltaMode: 0 }));
  assert.ok(notch > 1.1 && notch < 1.3);
  let v = 2; for (let i = 0; i < 600; i++) v = decayVelocity(v, 1 / 60); assert.equal(v, 0);
});

test('multi-level cross-fade keeps an opaque base visible beneath fading descendants (never solid-color bleed-through)', async () => {
  started.length = 0;
  const { GlobeTiles } = await import('../src/ui/globeTiles');
  const group = new THREE.Group();
  const tiles = new GlobeTiles(group, 4, () => {});
  const vClose = view(-6.12, 106.65, 1.819 / 1800);

  // 1. Load z=4 base first
  tiles.update(view(-6.12, 106.65, 1.819 / 2), 0);
  for (const s of started.splice(0)) s.onload?.();
  await Promise.resolve();
  tiles.tick(0.016);

  // 2. Zoom in deeply: midpoint and leaf tiles arrive across multiple levels
  tiles.update(vClose, 100);
  const batch1 = started.splice(0);
  assert.ok(batch1.some((b) => /\/tile\/1[456]\//.test(b.src)), 'requests target high-zoom tiles immediately without waiting on 10 intermediate levels');
  for (const s of batch1) s.onload?.();
  await Promise.resolve();
  tiles.tick(0.016); // creates mid + leaf textures with fade < 1
  tiles.update(vClose, 120);
  tiles.tick(0.016); // advances fade slightly (still < 1)

  // Every visible stack must have at least one fully opaque (opacity === 1) tile at the bottom so the base sphere never bleeds through
  const visibleMeshes = group.children.filter((c) => c.visible) as THREE.Mesh[];
  assert.ok(visibleMeshes.length > 0);
  const maxOpacity = Math.max(...visibleMeshes.map((m) => (m.material as THREE.MeshBasicMaterial).opacity));
  assert.equal(maxOpacity, 1, 'an opaque underlay tile remains visible while finer tiles fade in');
  tiles.dispose();
});

test('fast panning aborts stale off-screen requests and pins base z=4 tiles against eviction', async () => {
  started.length = 0;
  const { GlobeTiles } = await import('../src/ui/globeTiles');
  const group = new THREE.Group();
  const tiles = new GlobeTiles(group, 4, () => {});
  tiles.maxTextures = 24;

  // Pan to Jakarta and start loading high-zoom tiles (leave them in-flight)
  tiles.update(view(-6.12, 106.65, 1.819 / 1800), 0);
  const jakartaReqs = started.splice(0);
  assert.ok(jakartaReqs.length > 0);

  // Immediately pan across the world to London before Jakarta's high-zoom requests finish
  tiles.update(view(51.47, -0.45, 1.819 / 1800), 100);
  const londonReqs = started.splice(0);
  assert.ok(londonReqs.some((r) => /\/tile\/1[456]\//.test(r.src)), 'aborting stale off-screen requests frees sockets for the new viewport');

  // Complete London tiles and verify z=4 base tiles survive eviction
  for (let i = 0; i < 6; i++) {
    for (const r of londonReqs.splice(0)) r.onload?.();
    await Promise.resolve();
    tiles.tick(0.5);
    tiles.update(view(51.47 + i * 0.05, -0.45 + i * 0.05, 1.819 / 1800), 200 + i * 100);
    londonReqs.push(...started.splice(0));
  }
  const hasZ4 = group.children.some((c) => (c as THREE.Mesh).renderOrder === 14);
  assert.ok(hasZ4, 'base z=4 tiles remain pinned in cache under eviction');
  tiles.dispose();
});

test('CanvasMap: deep zoom (>4 levels past cached parent) renders full ancestor instead of solid uniform color and scales smoothly', async (t) => {
  const drawCalls: { img: unknown; args: number[] }[] = [];
  const makeCtx = () => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, globalCompositeOperation: 'source-over',
    setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
    translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    arc() {}, fill() {}, stroke() {}, strokeText() {}, fillText() {}, clip() {},
    createRadialGradient() { return { addColorStop() {} }; },
    drawImage(img: unknown, ...args: number[]) { drawCalls.push({ img, args }); },
  });
  const makeCanvas = () => ({
    width: 1200, height: 800,
    style: { touchAction: '' },
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { width: 1200, height: 800, left: 0, top: 0 }; },
    getContext() { return makeCtx(); },
  });
  const origDoc = (globalThis as Record<string, unknown>).document;
  const origWin = (globalThis as Record<string, unknown>).window;
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  (globalThis as Record<string, unknown>).document = { createElement: () => makeCanvas() };
  (globalThis as Record<string, unknown>).window = { devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  t.after(() => {
    (globalThis as Record<string, unknown>).document = origDoc;
    (globalThis as Record<string, unknown>).window = origWin;
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  });

  started.length = 0;
  const { loadImage, tileUrl, styleById } = await import('../src/sim/tiles');
  const { CanvasMap } = await import('../src/ui/CanvasMap');

  // Pre-populate a z=5 satellite tile over Jakarta (-6.12, 106.65)
  const st = styleById('sat');
  const z5Url = tileUrl(st.url, 5, 25, 16);
  const p5 = loadImage(z5Url);
  const z5Img = started.find((s) => s.src === z5Url)!;
  assert.ok(z5Img);
  z5Img.onload?.();
  const loadedZ5 = await p5;
  assert.ok(loadedZ5);

  const canvas = makeCanvas() as unknown as HTMLCanvasElement;
  const map = new CanvasMap(canvas);
  map.setStyle('sat');
  map.showHillshade = false;
  map.showRoads = false;
  map.showLabels = false;
  map.resize();

  // Jump 11.5 zoom levels deeper (z=5 -> zoom=16.5) where z=17 tiles are not loaded yet
  drawCalls.length = 0;
  map.setView(-6.12, 106.65, 16.5);
  map.draw();

  // The cached z=5 ancestor must be drawn using its full 256x256 source (5-arg drawImage, not 9-arg <1px crop!)
  const ancestorDraw = drawCalls.find((c) => c.img === loadedZ5);
  assert.ok(ancestorDraw, 'z=5 ancestor must be drawn even when zoomed 11+ levels deeper');
  assert.equal(ancestorDraw.args.length, 4, 'draws full ancestor image rather than sub-pixel crop');
  assert.ok(ancestorDraw.args[2] > 1000 && ancestorDraw.args[3] > 1000);

  // Fractional zoom changes must reuse and scale the cached background instead of rebuilding on every step
  const buildsBefore = map.stats.backgroundBuilds;
  map.zoomBy(0.2);
  map.draw();
  map.zoomBy(0.2);
  map.draw();
  assert.equal(map.stats.backgroundBuilds, buildsBefore, 'fractional zoom scales cached background without synchronous rebuilds');

  map.dispose();
  for (const s of started.splice(0)) s.onerror?.();
});
