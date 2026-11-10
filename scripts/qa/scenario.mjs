// Scenario test of the flight-deck controls through the real Cockpit.press / wheel / drag path (rendering stubbed so the sim loop runs at full speed).
// Asserts state AND pose (pose = how far / which way the 3D control moved). Then takes verification screenshots.
import { connect } from './lib2.mjs';
const { browser, page } = await connect();
await page.setViewportSize({ width: 1280, height: 720 });
const out = await page.evaluate(async () => {
  const G = window.__sky, c = G.cockpit, R = G.raycaster.constructor, V3 = c.group.position.constructor, Q = c.group.quaternion.constructor, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Reflect.set(G, 'render', () => {});
  const T = [], ok = (n, cond, x = '') => T.push((cond ? 'PASS ' : 'FAIL ') + n + (x ? '  [' + x + ']' : ''));
  const rayFor = (id) => { const g = c.groups.get(id), ctr = g.box.getCenter(new V3()), n = c.panelNormal(ctr).clone().normalize(); return { g, n, ray: new R(ctr.clone().addScaledVector(n, 0.3).applyMatrix4(c.root.matrixWorld), n.clone().transformDirection(c.root.matrixWorld).negate(), 0.01, 2) }; };
  const pose = (id) => { const { g, n } = rayFor(id), q = new Q().setFromRotationMatrix(g.xf), p = g.parts[0], cen = p.node.geometry.boundingSphere.center, d = cen.clone().applyMatrix4(p.node.matrix).sub(cen.clone().applyMatrix4(p.m0)); return { ang: 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI, dn: d.dot(n) * 1000 }; };
  const wheel = async (id, dir, k = 1) => { const { ray } = rayFor(id); for (let i = 0; i < k; i++) { c.lastZoomT = 0; c.wheel(ray, dir > 0 ? -100 : 100, false); } await sleep(250); };
  const hold = async (id, ms, btn = 0) => { const { ray } = rayFor(id); const r = c.press(ray, btn, false); await sleep(ms); const p = pose(id); return { r, p }; };
  const rel = async () => { c.release(); await sleep(450); };
  const click = async (id, btn = 0) => { const h = await hold(id, 80, btn); await rel(); return h; };
  const near = (a, b, t) => Math.abs(a - b) <= t;
  c.sys.ext = true; await sleep(500);
  const s = c.sys, ap = G.ap, ctl = G.fm.ctl;
  // ---- picking
  for (const id of ['spd-sel', 'hdg_sel', 'alt-sel', 'vs-sel', 'ap1', 'ap2', 'a-thr', 'loc', 'appr', 'exped', 'fd1', 'nd_mode', 'nd_range', 'qnh_cpt_knb', 'ecam_eng', 'ecam_all', 'C:a', 'C:L3', 'C:clr', 'thr_l_body', 'FlapsLever', 'SpdBrk', 'eng_mode', 'ParkBrk', 'Lcutoff', 'RudderTrim']) { const { ray } = rayFor(id), pk = c.pickGroup(ray); ok('pick ' + id, pk && pk.g.id === id, pk ? pk.g.id : 'none'); }
  ok('ap1 is a glareshield button, not an overhead latch', !c.groups.get('ap1').ovh && !c.groups.get('master_warning').ovh);
  // ---- FCU: HDG encoder
  s.hdgManaged = false; ap.on = false; const h0 = ap.hdg;
  await wheel('hdg_sel', +1, 3); const dh = ((ap.hdg - h0 + 540) % 360) - 180, p1 = pose('hdg_sel');
  ok('HDG +3 clicks -> +3 deg', near(dh, 3, 0.01), 'dh=' + dh.toFixed(2)); ok('HDG knob rotated 3 clicks (33.75 deg)', near(p1.ang, 33.75, 2.5), 'ang=' + p1.ang.toFixed(1));
  await wheel('hdg_sel', -1, 3); ok('HDG knob back to 0', pose('hdg_sel').ang < 2.5, 'ang=' + pose('hdg_sel').ang.toFixed(1));
  let r = await hold('hdg_sel', 120, 0); ok('HDG PUSH: cap moves INTO panel', r.p.dn < -2 && r.p.dn > -6, 'dn=' + r.p.dn.toFixed(2)); ok('HDG push -> managed', s.hdgManaged === true); await rel(); ok('HDG cap springs back', Math.abs(pose('hdg_sel').dn) < 0.4);
  r = await hold('hdg_sel', 120, 2); ok('HDG PULL: cap moves OUT', r.p.dn > 2 && r.p.dn < 6, 'dn=' + r.p.dn.toFixed(2)); ok('HDG pull -> selected', s.hdgManaged === false); await rel();
  // ---- SPD / ALT / ring
  s.spdManaged = true; r = await hold('spd-sel', 100, 2); await rel(); ok('SPD pull -> selected', s.spdManaged === false); const sp0 = ap.spd; await wheel('spd-sel', +1, 5); ok('SPD +5 clicks', ap.spd === sp0 + 5, `${sp0} -> ${ap.spd}`);
  const a0 = ap.altFt; await wheel('alt-sel', +1, 3); ok('ALT +3 clicks (100 ft)', ap.altFt === a0 + 300, `${a0} -> ${ap.altFt}`);
  c.stepKnob(c.groups.get('alt-sel-mode'), 1, false); const a1 = ap.altFt; await wheel('alt-sel', +1, 2); ok('ALT ring 1000 ft', ap.altFt === a1 + 2000 && s.altStep1000, `${a1} -> ${ap.altFt}`); c.stepKnob(c.groups.get('alt-sel-mode'), -1, false); ok('ALT ring back to 100', !s.altStep1000);
  // ---- FCU buttons
  const t0 = s.spdMach; await click('spd-mach'); ok('SPD/MACH toggles', s.spdMach !== t0); await click('spd-mach');
  const tf = s.trkFpa; await click('hdg-vs'); ok('HDG-V/S / TRK-FPA toggles', s.trkFpa !== tf); await click('hdg-vs');
  const m0 = s.metric; await click('metric_alt'); ok('METRIC ALT toggles', s.metric !== m0); await click('metric_alt');
  const l0 = s.locArmed; r = await click('loc'); ok('LOC toggles', s.locArmed !== l0); ok('LOC cap dips ~1.8 mm', r.p.dn < -1 && r.p.dn > -3, 'dn=' + r.p.dn.toFixed(2)); await click('loc');
  const at0 = s.athrArmed; await click('a-thr'); ok('A/THR toggles', s.athrArmed !== at0); await click('a-thr');
  // ---- EFIS / PFD / ND
  const e = s.efis[0]; e.ndMode = 3; const pm = pose('nd_mode').ang; await wheel('nd_mode', +1, 1); ok('ND mode knob -> PLAN', e.ndMode === 4); ok('ND mode knob pose moved', Math.abs(pose('nd_mode').ang - pm) > 20, `${pm.toFixed(0)} -> ${pose('nd_mode').ang.toFixed(0)}`); await wheel('nd_mode', -1, 4); ok('ND mode -> LS (end stop)', e.ndMode === 0); e.ndMode = 3;
  await wheel('nd_range', -1, 1); ok('ND range 80 -> 40 NM', e.ndRange === 2); e.ndRange = 3;
  const fd = e.fd; await click('fd1'); ok('FD pb toggles', e.fd !== fd); await click('fd1');
  e.std = false; const hp = e.hpa; await wheel('qnh_cpt_knb', +1, 2); ok('BARO +2 hPa', e.hpa === hp + 2); r = await hold('qnh_cpt_knb', 100, 2); ok('BARO PULL -> STD, cap out', e.std && r.p.dn > 1.5, 'dn=' + r.p.dn.toFixed(2)); await rel(); r = await hold('qnh_cpt_knb', 100, 0); ok('BARO PUSH -> QNH, cap in', !e.std && r.p.dn < -1.5, 'dn=' + r.p.dn.toFixed(2)); await rel();
  c.stepKnob(c.groups.get('qnh_cpt_sw'), -1, false); ok('BARO ring -> inHg', e.unitInHg); c.stepKnob(c.groups.get('qnh_cpt_sw'), 1, false); ok('BARO ring -> hPa', !e.unitInHg);
  // ---- brightness knobs now visibly turn
  s.bright.uecam = 1; await sleep(200); const b0 = pose('ecam_brt_upper').ang; await wheel('ecam_brt_upper', -1, 3); ok('ECAM BRT upper -3 detents', near(s.bright.uecam, 1 - 3 / 11, 0.01), s.bright.uecam.toFixed(3)); ok('ECAM BRT knob rotated', Math.abs(pose('ecam_brt_upper').ang - b0) > 15, `${b0.toFixed(0)} -> ${pose('ecam_brt_upper').ang.toFixed(0)}`); await wheel('ecam_brt_upper', +1, 3);
  const f0 = pose('fcu_integ_knb1').ang; await wheel('fcu_integ_knb1', -1, 3); ok('FCU integ lt knob rotates', Math.abs(pose('fcu_integ_knb1').ang - f0) > 15); await wheel('fcu_integ_knb1', +1, 3);
  // ---- ECAM control panel
  await click('ecam_eng'); ok('ECAM ENG key -> ENG page', s.ecam.manual === 'ENG'); await click('ecam_eng'); ok('ECAM ENG again -> automatic page', s.ecam.manual === null);
  await click('ecam_hyd'); ok('ECAM HYD key', s.ecam.manual === 'HYD'); const pg = s.ecam.manual; r = await hold('ecam_all', 1400); await rel(); ok('ECAM ALL held steps pages', s.ecam.manual !== pg && s.ecam.manual !== null, pg + ' -> ' + s.ecam.manual); s.ecam.manual = null;
  // ---- MCDU
  const m = c.mcdu[0]; await click('C:init'); ok('MCDU INIT page', m.page === 'INIT');
  r = await hold('C:a', 150); ok('MCDU key stays down while held (1.8 mm)', r.p.dn < -1.2 && r.p.dn > -2.4, 'dn=' + r.p.dn.toFixed(2)); await rel(); ok('MCDU key springs back', Math.abs(pose('C:a').dn) < 0.3);
  await click('C:b'); ok('scratchpad AB', m.scratch === 'AB', m.scratch); await click('C:clr'); ok('CLR deletes last char', m.scratch === 'A', m.scratch);
  await hold('C:clr', 1300); await rel(); ok('CLR held 1 s blanks scratchpad', m.scratch === '', JSON.stringify(m.scratch)); await click('C:clr'); ok('CLR on empty scratchpad -> CLR', m.scratch === 'CLR');
  await click('C:L3'); ok('CLR + LSK clears FLT NBR', m.store.flt === '' && m.scratch === '', JSON.stringify(m.store.flt));
  for (const k of ['C:a', 'C:b', 'C:c', 'C:1']) await click(k); await click('C:L3'); ok('FLT NBR entry', m.store.flt === 'ABC1', m.store.flt);
  await click('C:perf'); for (const k of ['C:1', 'C:3', 'C:5']) await click(k); await click('C:L1'); ok('PERF V1 135', m.store.v1 === 135, String(m.store.v1)); await click('C:9'); await click('C:L1'); ok('V1 9 rejected (range)', m.msg === 'ENTRY OUT OF RANGE' && m.store.v1 === 135, m.msg); await click('C:clr'); ok('CLR clears message', m.msg === '');
  await click('C:right'); ok('PERF slew right -> next phase', m.store.perfPhase === 1, String(m.store.perfPhase));
  await click('C:dir'); ok('DIR page', m.page === 'DIR'); await click('C:mcdu'); ok('MENU key', m.page === 'MENU');
  // ---- pedestal
  let pr = c.press(rayFor('thr_l_body').ray, 0, false); c.drag(0, -60); await sleep(300); ok('THR L drag -> ~0.35', near(ctl.throttle, 0.353, 0.03), ctl.throttle.toFixed(3)); const tp = pose('thr_l_body'); ok('THR L lever rotated ~16 deg', near(tp.ang, 15.9, 3), tp.ang.toFixed(1)); c.release(); ctl.throttle = 0; await sleep(300);
  pr = c.press(rayFor('FlapsLever').ray, 0, false); c.drag(0, 35); await sleep(200); ok('FLAPS drag -> CONF 1', ctl.flapsIdx === 1); ok('FLAPS lever pose moved', pose('FlapsLever').ang > 4, pose('FlapsLever').ang.toFixed(1)); c.release(); ctl.flapsIdx = 0;
  pr = c.press(rayFor('SpdBrk').ray, 0, false); c.drag(0, 50); await sleep(250); ok('SPD BRK drag -> 50 %', near(ctl.speedbrake, 0.5, 0.05), ctl.speedbrake.toFixed(2)); ok('SPD BRK lever pose moved', pose('SpdBrk').ang > 15, pose('SpdBrk').ang.toFixed(1)); c.release(); ctl.speedbrake = 0;
  const em = s.engMode; await wheel('eng_mode', +1, 1); ok('ENG MODE -> IGN/START', s.engMode === 2 && em === 1); ok('ENG MODE knob pose', pose('eng_mode').ang > 30, pose('eng_mode').ang.toFixed(1)); await wheel('eng_mode', -1, 1);
  const pk = ctl.parking; await click('ParkBrk'); ok('PARK BRK toggles', ctl.parking !== pk); await click('ParkBrk');
  const rt = ctl.rudTrim; await wheel('RudderTrim', +1, 3); ok('RUD TRIM +3 clicks', near(ctl.rudTrim, rt + 0.15, 0.01), ctl.rudTrim.toFixed(2)); ok('RUD TRIM pose', pose('RudderTrim').ang > 3, pose('RudderTrim').ang.toFixed(1)); ctl.rudTrim = 0;
  return { T, pass: T.filter((x) => x.startsWith('PASS')).length, fail: T.filter((x) => x.startsWith('FAIL')).length };
});
console.log(out.T.join('\n')); console.log(`\n${out.pass} passed, ${out.fail} failed`);
// ---- verification screenshots (real rendering back on; ~1 fps in software GL, so wait)
const shot = async (name, prep, wait = 7000) => { await page.evaluate(prep); await page.waitForTimeout(wait); await page.screenshot({ path: `/tmp/qa/${name}.png` }); };
await shot('fcu', () => { const G = window.__sky; Reflect.deleteProperty(G, 'render'); G.cockpit.setPreset('fcu', true); });
await shot('mcdu', () => { const G = window.__sky, m = G.cockpit.mcdu[0]; m.key('init'); m.scratch = 'FLT123'; G.cockpit.setPreset('mcdu', true); });
await browser.close();
