import { FlightModel } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
for (const spec of AIRCRAFT) {
  const fm = new FlightModel(spec, () => 0);
  fm.placeOnRunway(0, 0, 90, 0);
  fm.ctl.parking = false; fm.ctl.throttle = 1; fm.ctl.flapsIdx = spec.id==='sky'?2:1; fm.flapsPos = fm.ctl.flapsIdx/spec.flapDetents;
  const dt = 1 / 120; let lifted = -1, t = 0, log: string[] = [];
  for (let i = 0; i < 120 * 200; i++) {
    t += dt;
    const kias = fm.ias / 0.5144;
    const tp = kias > spec.vr ? (fm.wow ? 10 : (fm.pos.y < 120 ? 10 : 7)) : 0; fm.ctl.pitch = kias > spec.vr ? Math.max(-1, Math.min(1, (tp - fm.pitch * 57.3) * 0.15)) : 0;
    // keep runway heading with rudder
    let he = ((fm.heading - 90 + 540) % 360) - 180; fm.ctl.yaw = Math.max(-1, Math.min(1, -he * 0.1));
    fm.step(dt);
    if (lifted < 0 && !fm.wow && t > 2) { lifted = t; log.push(`liftoff t=${t.toFixed(1)} kias=${kias.toFixed(0)} dist=${fm.pos.x.toFixed(0)}m pitch=${(fm.pitch * 57.3).toFixed(1)}`); fm.ctl.gearDown = false; }
    if (i % (120 * 20) == 0) log.push(`t=${t.toFixed(0)} kias=${kias.toFixed(0)} alt=${fm.pos.y.toFixed(0)} vs=${(fm.vs * 196.85).toFixed(0)}fpm pitch=${(fm.pitch * 57.3).toFixed(1)} a=${(fm.alpha * 57.3).toFixed(1)} bank=${(fm.bank * 57.3).toFixed(1)} hdg=${fm.heading.toFixed(0)} N=${fm.n[0].toFixed(2)} thr=${(fm.thrustN / 1000).toFixed(1)}kN`);
    if (fm.crashed) { log.push('CRASH ' + fm.crashReason); break; }
  }
  console.log('===', spec.name); console.log(log.join('\n'));
}
