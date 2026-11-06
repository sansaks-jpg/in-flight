// Take-off performance check against real-world published figures (ISA, sea level, no wind, dry paved runway).
import { FlightModel, airState } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
airState.dT = 0; airState.qnh = 1013.25;
const REAL: Record<string, string> = {
  swift: 'POH: ground roll ~293 m, 50 ft ~497 m @1157 kg',
  trek: 'ATR: take-off field length 1315 m @ MTOW (ground roll ~ 900-1000 m)',
  sky: 'Airbus: take-off run 2090 m @ MTOW 77 t (CONF 1+F, TOGA) – ~1500-1900 m typical',
};
for (const spec of AIRCRAFT) {
  const fm = new FlightModel(spec, () => 0, spec.id === 'sky' ? 6000 : undefined);
  fm.placeOnRunway(0, 0, 90, 0);
  fm.ctl.parking = false; fm.ctl.throttle = 1; fm.ctl.flapsIdx = spec.toFlaps; fm.flapsPos = fm.ctl.flapsIdx / spec.flapDetents;
  const dt = 1 / 120; let lifted = -1, t = 0; const log: string[] = [];
  let v50 = -1;
  for (let i = 0; i < 120 * 150; i++) {
    t += dt;
    const kias = fm.ias / 0.5144;
    const tp = kias > spec.vr ? (fm.wow ? 9 : 10) : 0; fm.ctl.pitch = kias > spec.vr ? Math.max(-1, Math.min(1, (tp - fm.pitch * 57.3) * 0.15)) : 0;
    const he = ((fm.heading - 90 + 540) % 360) - 180; fm.ctl.yaw = Math.max(-1, Math.min(1, -he * 0.1));
    fm.step(dt);
    if (lifted < 0 && !fm.wow && t > 2) { lifted = t; log.push(`liftoff t=${t.toFixed(1)} kias=${kias.toFixed(0)} ground roll=${fm.pos.x.toFixed(0)} m pitch=${(fm.pitch * 57.3).toFixed(1)}`); if (!spec.fixedGear) fm.ctl.gearDown = false; }
    if (lifted > 0 && v50 < 0 && fm.pos.y > 15.2 + 3.3 * 0) { v50 = fm.pos.x; log.push(`50ft at ${fm.pos.x.toFixed(0)} m kias=${kias.toFixed(0)}`); }
    if (i % (120 * 25) == 0) log.push(`t=${t.toFixed(0)} kias=${kias.toFixed(0)} alt=${(fm.pos.y / 0.3048).toFixed(0)}ft vs=${(fm.vs * 196.85).toFixed(0)}fpm pitch=${(fm.pitch * 57.3).toFixed(1)} N=${fm.n[0].toFixed(2)} thr=${(fm.thrustN / 1000).toFixed(1)}kN mass=${fm.mass.toFixed(0)}`);
    if (fm.crashed) { log.push('CRASH ' + fm.crashReason); break; }
  }
  console.log('===', spec.name, '| real:', REAL[spec.id]); console.log(log.join('\n'));
}
