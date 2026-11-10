// Generic control audit: for every control of the FCU / EFIS / instrument panel / ECAM / MCDU / pedestal fire a ray at it, press (or wheel) it
// through the real Cockpit.press()/wheel() path and record: pickable?, state text before/after, pose displacement along the panel normal, rotation angle.
import { connect } from './lib2.mjs';
import fs from 'node:fs';
const { browser, page } = await connect();
await page.setViewportSize({ width: 960, height: 540 });
const ids = await page.evaluate(() => {
  const c = window.__sky.cockpit, out = [];
  for (const g of c.groups.values()) {
    const b = g.box.getCenter(new g.box.min.constructor());
    let region = null;
    if (b.x < -0.30 && b.x > -0.44 && b.y > 0.38 && b.y < 0.62) region = 'glare';
    else if (b.x <= -0.44 && b.z < 0.7) region = 'panel';
    else if (Math.abs(b.z) < 0.34 && b.y < 0.2 && b.x > -0.44) region = 'ped';
    if (region) out.push({ id: g.id, region });
  }
  return out;
});
console.log('targets', ids.length);
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const results = [];
const todo = ids.filter((x) => !only || only.test(x.id));
for (let i = 0; i < todo.length; i += 25) {
  const chunk = todo.slice(i, i + 25);
  const r = await page.evaluate(async (chunk) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.__sky, c = G.cockpit, R = G.raycaster.constructor, V3 = c.group.position.constructor, Q = c.group.quaternion.constructor;
    const out = [];
    const poseOf = (g, n) => {
      const q = new Q().setFromRotationMatrix(g.xf), ang = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
      const p = g.parts[0], cen = p.node.geometry.boundingSphere ? p.node.geometry.boundingSphere.center : (p.node.geometry.computeBoundingSphere(), p.node.geometry.boundingSphere.center);
      const a = cen.clone().applyMatrix4(p.node.matrix), b0 = cen.clone().applyMatrix4(p.m0), d = a.sub(b0);
      return { ang: +ang.toFixed(2), mm: +(d.length() * 1000).toFixed(2), dn: +(d.dot(n) * 1000).toFixed(2) };
    };
    for (const { id, region } of chunk) {
      const g = c.groups.get(id); const ctr = g.box.getCenter(new V3()); const n = c.panelNormal(ctr).clone().normalize();
      const org = ctr.clone().addScaledVector(n, 0.3).applyMatrix4(c.root.matrixWorld), dir = n.clone().transformDirection(c.root.matrixWorld).negate();
      const ray = new R(org, dir, 0.01, 2);
      const rec = { id, region, kind: g.kind, ovh: !!g.ovh, steps: g.steps };
      const pk = c.pickGroup(ray); rec.picked = pk ? pk.g.id : null;
      if (g.kind === 'stick' || id === 'tiller' || /^thr_|FlapsLever|SpdBrk|Lcutoff|Rcutoff|rev_|gear_lever|ParkBrk|Rudder(Pedal)/.test(id)) { rec.skip = 'lever'; out.push(rec); continue; }
      rec.s0 = c.stateText(g); rec.rest0 = poseOf(g, n);
      const isKnob = g.kind === 'knob' || /^(spd-sel|hdg_sel|alt-sel|vs-sel)$/.test(id);
      if (isKnob) {
        const wasPos = g.pos;
        for (let k = 0; k < 3; k++) { c.wheel(ray, -100, false); c.lastZoomT = 0; }
        await sleep(260);
        rec.s1 = c.stateText(g); rec.rot3 = poseOf(g, n); rec.pos = [wasPos, g.pos];
        for (let k = 0; k < 3; k++) { c.wheel(ray, 100, false); c.lastZoomT = 0; }
        await sleep(200); rec.s2 = c.stateText(g); rec.rotBack = poseOf(g, n);
        // push / pull for encoders
        if (/^(spd-sel|hdg_sel|alt-sel|vs-sel|qnh_cpt_knb|qnh_fo_knb)$/.test(id)) {
          const r1 = c.press(ray, 0, false); await sleep(160); rec.pushPose = poseOf(g, n); rec.sPush = c.stateText(g); c.release(); await sleep(250);
          const r2 = c.press(ray, 2, false); await sleep(160); rec.pullPose = poseOf(g, n); rec.sPull = c.stateText(g); c.release(); await sleep(250);
          rec.pp = [r1 && r1.id, r2 && r2.id];
        }
      } else {
        const r1 = c.press(ray, 0, false); rec.hit = r1 ? r1.id : null; await sleep(170); rec.pressed = poseOf(g, n); rec.s1 = c.stateText(g); c.release(); await sleep(260);
        rec.after = poseOf(g, n); rec.s1r = c.stateText(g);
        const r2 = c.press(ray, 0, false); await sleep(60); c.release(); await sleep(260); rec.s2 = c.stateText(g); rec.rest2 = poseOf(g, n);
        // guards: a first click only lifts the cover
        if (GUARDED(id)) rec.guarded = true;
      }
      out.push(rec);
    }
    function GUARDED(id) { return false; }
    return out;
  }, chunk);
  results.push(...r);
  process.stdout.write('.');
}
console.log();
fs.writeFileSync('/tmp/qa/audit.json', JSON.stringify(results));
console.log('done', results.length);
await browser.close();
