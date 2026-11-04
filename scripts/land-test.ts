import { FlightModel } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
for (const spec of AIRCRAFT) {
  const fm = new FlightModel(spec, () => 0);
  const dist = 6000; // metres before threshold at x=0, flying east (hdg 90)
  fm.placeAirborne(-dist, Math.tan(3 * Math.PI / 180) * dist + 15, 0, 90, spec.vapp + 10, spec.flapDetents, true);
  fm.ctl.throttle = 0.3;
  const dt = 1 / 120; let t = 0, td = false; const log: string[] = [];
  for (let i = 0; i < 120 * 400; i++) {
    t += dt;
    const kias = fm.ias / 0.5144;
    // speed control
    fm.ctl.throttle = Math.max(0, Math.min(1, fm.ctl.throttle + (spec.vapp - kias) * 0.004 * dt * 10));
    const gsAlt = Math.max(0, (-fm.pos.x) * Math.tan(3 * Math.PI / 180)) + 15;
    let vsT = (gsAlt - fm.pos.y) * 0.25 - fm.gs * Math.tan(3 * Math.PI / 180);
    if (fm.agl < 12 && !fm.wow) { vsT = -0.6; if (fm.ctl.throttle > 0.0) fm.ctl.throttle = Math.max(0, fm.ctl.throttle - dt * 0.5); }
    if (fm.wow) { vsT = -1; }
    const gamma = Math.asin(Math.max(-1, Math.min(1, fm.vel.y / Math.max(10, fm.vel.length()))));
    const gT = Math.asin(Math.max(-0.2, Math.min(0.2, vsT / Math.max(30, fm.vel.length()))));
    fm.ctl.pitch = fm.wow ? (fm.gs > 20 ? 0.0 : 0) : Math.max(-1, Math.min(1, (gT - gamma) * 8));
    if (fm.wow) { fm.ctl.throttle = 0; fm.ctl.brake = fm.gs > 5 ? 0.6 : 0.2; fm.ctl.reverse = spec.hasReverse && fm.gs > 20; if (spec.hasReverse && fm.gs>20) fm.ctl.throttle = 0.5; fm.ctl.speedbrake = spec.hasSpeedbrake ? 1 : 0; }
    let he = ((fm.heading - 90 + 540) % 360) - 180; fm.ctl.yaw = Math.max(-1, Math.min(1, -he * 0.1 - fm.pos.z * 0.01));
    fm.step(dt);
    for (const e of fm.events.splice(0)) if (e.kind === 'touchdown') { td = true; log.push(`TOUCHDOWN t=${t.toFixed(1)} x=${fm.pos.x.toFixed(0)} vs=${(e.vs * 196.85).toFixed(0)}fpm kias=${kias.toFixed(0)} pitch=${(e.pitch * 57.3).toFixed(1)}`); }
    if (i % 120 * 1 == 0 && (i % (120 * 20) == 0 || (td && i % (120 * 4) == 0 && fm.gs > 1))) log.push(`t=${t.toFixed(0)} x=${fm.pos.x.toFixed(0)} y=${fm.pos.y.toFixed(1)} kias=${kias.toFixed(0)} vs=${(fm.vs * 196.85).toFixed(0)} pitch=${(fm.pitch * 57.3).toFixed(1)} thr=${fm.ctl.throttle.toFixed(2)} z=${fm.pos.z.toFixed(1)}`);
    if (fm.crashed) { log.push('CRASH ' + fm.crashReason + ` t=${t.toFixed(1)}`); break; }
    if (td && fm.gs < 0.5) { log.push(`STOPPED t=${t.toFixed(1)} x=${fm.pos.x.toFixed(0)} z=${fm.pos.z.toFixed(1)}`); break; }
  }
  console.log('===', spec.name); console.log(log.join('\n'));
}
