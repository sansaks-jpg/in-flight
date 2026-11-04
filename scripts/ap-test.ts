import { FlightModel } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
import { Autopilot } from '../src/sim/autopilot';
import { D2R } from '../src/sim/geo';
for (const spec of AIRCRAFT) {
  const fm = new FlightModel(spec, () => 0);
  // runway threshold at origin, heading 90 (east). aircraft starts 12 km out, offset 600 m left, 700 m high-ish
  fm.placeAirborne(-12000, 700, -600, 80, spec.vapp * 1.3, 0, true);
  fm.ctl.flapsIdx = 1; fm.flapsPos = 1 / spec.flapDetents;
  const ap = new Autopilot(); ap.engage(fm); ap.appr = true; ap.gsCaptured = false; ap.altFt = 2300; ap.spd = spec.vapp * 1.2;
  let t = 0; const dt = 1 / 120; const log: string[] = []; let td = false;
  for (let i = 0; i < 120 * 600; i++) {
    t += dt;
    const x = fm.pos.x, z = fm.pos.z, dist = -x, cross = z; // course 90: right = +z? heading east -> right is south(+z)
    const gsAngle = Math.atan2(fm.pos.y - 15, Math.max(1, dist)) / D2R;
    const ils = { valid: dist > -1500 && dist < 40000, dist, cross, locDots: -Math.atan2(cross, dist) / D2R / 1.25, gsDots: (3 - gsAngle) / 0.35, course: 90, elev: 0, x: 0, z: 0, ident: 'T', angle: gsAngle };
    if (!td) { const c = ap.step(fm, dt, null, ils as any); fm.ctl.apHold = true; fm.ctl.pitch = c.pitch; fm.ctl.roll = c.roll; fm.ctl.yaw = fm.wow ? 0 : c.yaw; if (c.throttle !== null) fm.ctl.throttle = c.throttle; if (dist < 15000) { fm.ctl.flapsIdx = Math.max(fm.ctl.flapsIdx, spec.flapDetents - 1); } if (dist < 9000) fm.ctl.flapsIdx = spec.flapDetents; }
    fm.ctl.speedbrake = 0;
    fm.step(dt);
    for (const e of fm.events.splice(0)) if (e.kind === 'touchdown') { td = true; log.push(`TD t=${t.toFixed(0)} x=${fm.pos.x.toFixed(0)} z=${fm.pos.z.toFixed(1)} vs=${(e.vs * 196.85).toFixed(0)}fpm kias=${(fm.ias / 0.5144).toFixed(0)}`); }
    if ((i % (120 * 30) == 0 || (dist < 1500 && i % 120 == 0)) && !td) log.push(`t=${t.toFixed(0)} dist=${dist.toFixed(0)} y=${fm.pos.y.toFixed(0)} z=${z.toFixed(0)} kias=${(fm.ias / 0.5144).toFixed(0)} gs=${((3 - gsAngle)).toFixed(2)} thr=${fm.ctl.throttle.toFixed(2)}`);
    if (td) { fm.ctl.throttle = 0; fm.ctl.brake = 0.6; fm.ctl.pitch = 0; let he = ((fm.heading - 90 + 540) % 360) - 180; fm.ctl.yaw = Math.max(-1, Math.min(1, -he * 0.1)); if (fm.gs < 1) { log.push(`STOP x=${fm.pos.x.toFixed(0)} z=${fm.pos.z.toFixed(1)}`); break; } }
    if (fm.crashed) { log.push('CRASH ' + fm.crashReason); break; }
  }
  console.log('===', spec.name); console.log(log.join('\n'));
}
