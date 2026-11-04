// Automated UI/UX Geometry & Collision Verification Suite
// Simulates component bounding box layouts across viewports, modes, scales, and simultaneous popups.

interface Rect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

function intersectionArea(a: Rect, b: Rect): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

interface TestConfig {
  viewportWidth: number;
  viewportHeight: number;
  isPortrait: boolean;
  hudMode: 'standard' | 'minimal' | 'assisted' | 'cockpit';
  uiScale: number;
  isMobile: boolean;
  warningsActive: boolean;
  hintActive: boolean;
  apConsoleOpen: boolean;
  atcPanelOpen: boolean;
  toastsCount: number;
  mapOpen: boolean;
  atcLogOpen: boolean;
  cabinMsgActive: boolean;
}

function computeLayout(cfg: TestConfig): Rect[] {
  const W = cfg.viewportWidth;
  const H = cfg.viewportHeight;
  const rects: Rect[] = [];

  // 1. Full screen overlays suppress in-game HUD completely
  if (cfg.mapOpen) {
    rects.push({ name: 'FullMap', x: 0, y: 0, w: W, h: H });
    return rects;
  }
  if (cfg.atcLogOpen) {
    rects.push({ name: 'AtcHistoryModal', x: 0, y: 0, w: W, h: H });
    return rects;
  }

  // 2. Top Toolbar: compact on mobile (<640: 230px), medium (<1024: 280px), full: 480px
  const toolbarW = W < 640 ? 230 : W < 1024 ? 280 : 480;
  const toolbarH = 38;
  const toolbarX = (W - toolbarW) / 2;
  const toolbarY = W < 640 ? 6 : 10;
  rects.push({ name: 'MsfsToolbar', x: toolbarX, y: toolbarY, w: toolbarW, h: toolbarH });

  // 3. Warnings Banner (Top Center)
  let warnBottomY = toolbarY + toolbarH;
  if (cfg.warningsActive || cfg.hintActive) {
    let warnH = 0;
    if (cfg.warningsActive) warnH += 34;
    if (cfg.hintActive) warnH += 20;
    const warnW = Math.min(300, W * 0.82);
    const warnX = (W - warnW) / 2;
    const warnY = toolbarY + toolbarH + 4;
    rects.push({ name: 'WarningsBanner', x: warnX, y: warnY, w: warnW, h: warnH });
    warnBottomY = warnY + warnH;
  }

  // Vertical offset for side widgets on mobile portrait (stacked below warning banner)
  const sideWidgetsTopY = cfg.isMobile && cfg.isPortrait && (cfg.warningsActive || cfg.hintActive)
    ? warnBottomY + 6
    : (W < 640 ? 48 : 12);

  // 4. Right Navigation Stack (Route Chip + Minimap)
  if (cfg.hudMode !== 'cockpit') {
    const navW = W < 500 ? 165 : W < 640 ? 180 : 210;
    const navX = W - navW - (W < 640 ? 8 : 12);
    let navY = cfg.isMobile ? (cfg.isPortrait ? sideWidgetsTopY : 48) : (W < 640 ? 8 : 12);

    if (!cfg.isMobile && cfg.hudMode !== 'minimal') {
      const mapH = W < 640 ? 170 : 190;
      rects.push({ name: 'Minimap', x: navX, y: navY, w: navW, h: mapH });
      navY += mapH + 8;
    }

    const routeH = 64;
    rects.push({ name: 'RouteChip', x: navX, y: navY, w: navW, h: routeH });
  }

  // 5. Left Side Coordinated Stack (AtcPanel, ApPanel, Toasts)
  if (cfg.hudMode !== 'cockpit' && cfg.hudMode !== 'minimal') {
    const leftW = W < 500 ? 160 : W < 900 ? 220 : 260;
    const leftX = W < 640 ? 8 : 12;
    let leftY = cfg.isMobile ? (cfg.isPortrait ? sideWidgetsTopY : 48) : 56;

    // On mobile, AP console is an on-demand modal; on desktop it opens in the left stack
    if (cfg.apConsoleOpen && !cfg.isMobile) {
      const apH = 290;
      rects.push({ name: 'ApPanel', x: leftX, y: leftY, w: leftW, h: apH });
      leftY += apH + 6;
    }

    if (cfg.atcPanelOpen) {
      const atcH = cfg.isMobile ? (H < 500 ? 32 : (W < 500 ? 32 : 90)) : 140;
      rects.push({ name: 'AtcPanel', x: leftX, y: leftY, w: leftW, h: atcH });
      leftY += atcH + 6;
    }

    if (cfg.toastsCount > 0) {
      const maxToasts = H < 500 ? 1 : W < 500 ? 2 : 3;
      const toastH = Math.min(cfg.toastsCount, maxToasts) * 28;
      rects.push({ name: 'ToastsStack', x: leftX, y: leftY, w: leftW, h: toastH });
    }
  } else if (cfg.hudMode === 'minimal' && cfg.toastsCount > 0) {
    // In minimal mode, only toasts appear on the top-left
    const leftW = Math.min(200, W * 0.4);
    const leftX = W < 640 ? 8 : 12;
    const maxToasts = H < 500 ? 1 : 2;
    const toastH = Math.min(cfg.toastsCount, maxToasts) * 28;
    rects.push({ name: 'ToastsStack', x: leftX, y: sideWidgetsTopY, w: leftW, h: toastH });
  }

  // 6. Mobile TouchControls
  if (cfg.isMobile) {
    const leftTouchW = 115;
    const leftTouchH = 160;
    const leftTouchX = 8;
    const leftTouchY = H - leftTouchH - 8;
    rects.push({ name: 'TouchControlsLeft', x: leftTouchX, y: leftTouchY, w: leftTouchW, h: leftTouchH });

    const rightTouchW = 160;
    const rightTouchH = 200;
    const rightTouchX = W - rightTouchW - 8;
    const rightTouchY = H - rightTouchH - 8;
    rects.push({ name: 'TouchControlsRight', x: rightTouchX, y: rightTouchY, w: rightTouchW, h: rightTouchH });
  }

  // 7. Minimal HUD (unobstructed mode)
  if (cfg.hudMode === 'minimal') {
    // Floating tapes are only shown on desktop/non-touch devices to avoid colliding with touch throttle and stick
    if (!cfg.isMobile) {
      rects.push({ name: 'MinimalAirspeedTape', x: 12, y: H / 2 - 120, w: 55, h: 240 });
      rects.push({ name: 'MinimalAltimeterTape', x: W - 12 - 55, y: H / 2 - 120, w: 55, h: 240 });
    }
    // On mobile portrait, compass ribbon is elevated above touch controls
    const ribbonY = cfg.isMobile && cfg.isPortrait ? H - 260 : H - 32 - 12;
    const ribbonW = Math.min(220, W * 0.5);
    rects.push({ name: 'MinimalCompassRibbon', x: (W - ribbonW) / 2, y: ribbonY, w: ribbonW, h: 32 });
    return rects;
  }

  // 8. Bottom Stack (PFD + Tactical Dock + Assisted Guide)
  if (cfg.hudMode !== 'cockpit') {
    // Scale PFD: on mobile landscape (< 500px height), scale down to 0.58 so it leaves room for warnings
    const pfdScale = H < 500 ? 0.58 : W < 640 ? (cfg.isPortrait ? 0.68 : 0.62) : W < 1024 ? 0.85 : 1.0;
    const pfdW = 360 * pfdScale;
    const pfdH = 302 * pfdScale;

    // Tactical dock only shown on non-touch desktop in standard/assisted modes
    const showTactical = !cfg.isMobile && cfg.hudMode !== 'minimal' && cfg.hudMode !== 'cockpit';
    const dockW = Math.min(480, W * 0.9);
    const dockH = 46;

    let bottomTotalH = pfdH;
    if (showTactical) bottomTotalH += dockH + 6;
    if (cfg.cabinMsgActive && H >= 500) bottomTotalH += 26 + 4;
    if (cfg.hudMode === 'assisted') bottomTotalH += 28 + 4;

    // On mobile portrait, PFD is lifted above touch controls to avoid collision with thumbs
    const bottomOffset = cfg.isMobile && cfg.isPortrait ? 230 : 6;
    let curY = H - bottomTotalH - bottomOffset;

    if (cfg.cabinMsgActive && H >= 500) {
      rects.push({ name: 'CabinMessage', x: (W - 220) / 2, y: curY, w: 220, h: 26 });
      curY += 30;
    }

    if (cfg.hudMode === 'assisted') {
      const guideW = Math.min(360, W * 0.8);
      rects.push({ name: 'AssistedGuideDock', x: (W - guideW) / 2, y: curY, w: guideW, h: 28 });
      curY += 32;
    }

    rects.push({ name: 'PrimaryFlightDisplay', x: (W - pfdW) / 2, y: curY, w: pfdW, h: pfdH });
    curY += pfdH + 6;

    if (showTactical) {
      rects.push({ name: 'TacticalFlightDock', x: (W - dockW) / 2, y: curY, w: dockW, h: dockH });
    }
  }

  return rects;
}

// Run test matrix
const testViewports = [
  { name: 'Mobile Portrait (iPhone 14)', w: 390, h: 844, isMobile: true, isPortrait: true },
  { name: 'Mobile Landscape (iPhone 14)', w: 844, h: 390, isMobile: true, isPortrait: false },
  { name: 'Tablet Portrait (iPad)', w: 768, h: 1024, isMobile: true, isPortrait: true },
  { name: 'Tablet Landscape (iPad)', w: 1024, h: 768, isMobile: false, isPortrait: false },
  { name: 'Standard Laptop (1366x768)', w: 1366, h: 768, isMobile: false, isPortrait: false },
  { name: 'Desktop Full HD (1920x1080)', w: 1920, h: 1080, isMobile: false, isPortrait: false },
];

const testModes: Array<'standard' | 'minimal' | 'assisted' | 'cockpit'> = ['standard', 'minimal', 'assisted', 'cockpit'];

let totalTests = 0;
let passedTests = 0;
const failures: string[] = [];

console.log('=====================================================');
console.log('UI/UX LAYOUT & COLLISION VERIFICATION TEST SUITE');
console.log('=====================================================\n');

for (const vp of testViewports) {
  for (const mode of testModes) {
    for (const warnings of [false, true]) {
      for (const ap of [false, true]) {
        for (const atc of [false, true]) {
          totalTests++;
          const cfg: TestConfig = {
            viewportWidth: vp.w,
            viewportHeight: vp.h,
            isPortrait: vp.isPortrait,
            hudMode: mode,
            uiScale: 1.0,
            isMobile: vp.isMobile,
            warningsActive: warnings,
            hintActive: warnings,
            apConsoleOpen: ap,
            atcPanelOpen: atc,
            toastsCount: 3,
            mapOpen: false,
            atcLogOpen: false,
            cabinMsgActive: true,
          };

          const rects = computeLayout(cfg);

          // Test pairwise intersections
          let hasCollision = false;
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i];
              const b = rects[j];
              if (intersects(a, b)) {
                hasCollision = true;
                failures.push(
                  `[COLLISION] ${vp.name} | mode=${mode} | ${a.name} overlaps with ${b.name} (area: ${intersectionArea(a, b).toFixed(0)}px²)`
                );
              }
            }
          }

          if (!hasCollision) {
            passedTests++;
          }
        }
      }
    }
  }
}

// Test overlay suppression
totalTests++;
const overlayTest = computeLayout({
  viewportWidth: 1366,
  viewportHeight: 768,
  isPortrait: false,
  hudMode: 'standard',
  uiScale: 1.0,
  isMobile: false,
  warningsActive: true,
  hintActive: true,
  apConsoleOpen: true,
  atcPanelOpen: true,
  toastsCount: 3,
  mapOpen: false,
  atcLogOpen: true,
  cabinMsgActive: true,
});

if (overlayTest.length === 1 && overlayTest[0].name === 'AtcHistoryModal') {
  passedTests++;
  console.log('✓ PASS: AtcHistoryModal cleanly suppresses all in-game HUD components.');
} else {
  failures.push('[COLLISION] AtcHistoryModal failed to suppress underlying HUD elements.');
}

console.log(`\nTest Results: ${passedTests} / ${totalTests} scenarios passed.`);
if (failures.length > 0) {
  console.error(`\nFAILED SCENARIOS (${failures.length}):`);
  for (const f of failures.slice(0, 15)) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\n✓ ALL UI/UX COLLISION TESTS PASSED CLEANLY (0 OVERLAPS DETECTED ACROSS ALL MATRIX COMBINATIONS).');
}
