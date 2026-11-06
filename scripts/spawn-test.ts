// Headless check of the hangar spawn: for every surveyed airfield (and a sample of the world) and every aircraft type the
// aircraft must start outside all buildings, off every runway, and with ICAO 4.5 m clearance around the footprint.
import { AIRPORTS, getAirfield } from '../src/data/airports';
import { AIRCRAFT } from '../src/sim/specs';
import { Projection, haversine } from '../src/sim/geo';
import { chooseGroundSpawn, rectHitsRing, XZ, distToSeg, synthGround } from '../src/sim/airportGround';

const badSet = new Set<string>();
let n = 0, bad = 0, hang = 0, synth = 0, fallback = 0;
const sample = AIRPORTS.filter((a) => a.runways.length && (getAirfield(a) || a.size < 2 || Math.random() < 0.02));
for (const ap of sample) {
  const proj = new Projection(ap.lat, ap.lon), L = getAirfield(ap);
  const rws = ap.runways.map((r) => ({ ax: proj.x(r.leLon), az: proj.z(r.leLat), bx: proj.x(r.heLon), bz: proj.z(r.heLat), wid: r.width }));
  const r0 = ap.runways[0], hdg = (Math.atan2(rws[0].bx - rws[0].ax, -(rws[0].bz - rws[0].az)) * 180 / Math.PI + 360) % 360;
  for (const spec of AIRCRAFT) {
    const sp = chooseGroundSpawn({ ap, spec, proj, runways: rws, thr: { startX: rws[0].ax, startZ: rws[0].az, hdg, wid: r0.width, fullLen: 1000 } });
    n++;
    const rings: XZ[][] = L ? [...L.hangars, ...L.terminals].filter((b) => b.ring.length >= 3).map((b) => b.ring.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ)) : [];
    const fp = { ...sp.footprint, hl: sp.footprint.hl - 4.5, hw: sp.footprint.hw - 4.5 };
    let why = '';
    if (rings.some((r) => rectHitsRing({ ...fp, hl: fp.hl + 4.4, hw: fp.hw + 4.4 }, r))) why = 'overlaps building';
    for (const g of rws) if (distToSeg(sp.x, sp.z, g.ax, g.az, g.bx, g.bz) < g.wid / 2 + 30) why = 'on runway';
    if (!isFinite(sp.x) || haversine(ap.lat, ap.lon, proj.lat(sp.z), proj.lon(sp.x)) > 6000) why = 'too far from airport';
    if (sp.kind === 'hangar') hang++; else fallback++;
    if (sp.synthetic) synth++;
    if (why) { bad++; badSet.add(ap.icao + ":" + ap.runways.length + ":" + why); }
  }
}
const g = synthGround(AIRPORTS.find((a) => a.icao === 'KJFK')!, new Projection(40.64, -73.78));
console.log(`checked ${n} spawns · hangar ${hang} · other ${fallback} · synthetic ${synth} · bad ${bad}`, g ? `KJFK taxiway sep ${g.taxiLat} m, hold ${g.holdLat} m` : '');
console.log([...badSet].slice(0, 40).join(" | "), badSet.size, "airports");
process.exit(badSet.size > 5 ? 1 : 0);
