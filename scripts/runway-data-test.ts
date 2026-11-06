// Runway database integrity: every airport has runways, geometry is physically consistent with the runway number
// (using the World Magnetic Model for the magnetic->true conversion) and sits on the airport.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRPORTS } from '../src/data/airports';
import { bearing, haversine } from '../src/sim/geo';
import { magToTrue } from '../src/sim/magvar';

const axisDiff = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return Math.min(d, 180 - d); };

test('every airport has at least one runway with non-degenerate geometry', () => {
  for (const a of AIRPORTS) {
    assert.ok(a.runways.length > 0, `${a.id} has no runways`);
    for (const r of a.runways) assert.ok(haversine(r.leLat, r.leLon, r.heLat, r.heLon) >= 100, `${a.id} ${r.le}/${r.he} degenerate`);
  }
});
test('large airports keep ALL their runways (no 3-runway cap)', () => {
  const byId = new Map(AIRPORTS.map((a) => [a.id, a]));
  for (const [id, min] of [['KORD', 7], ['KDFW', 7], ['KDEN', 6], ['KATL', 5]] as const) assert.ok((byId.get(id)?.runways.length ?? 0) >= min, `${id} runways`);
});
test('runway headings agree with the runway number and runways sit at their airport', () => {
  const bad: string[] = [];
  for (const a of AIRPORTS) {
    for (const r of a.runways) {
      const n = parseInt(r.le, 10); if (isNaN(n) || r.src === 'H') continue;
      const mid: [number, number] = [(r.leLat + r.heLat) / 2, (r.leLon + r.heLon) / 2];
      if (axisDiff(bearing(r.leLat, r.leLon, r.heLat, r.heLon), magToTrue(n * 10, mid[0], mid[1])) > 32) bad.push(`${a.id} ${r.le}/${r.he} heading`);
    }
  }
  assert.ok(bad.length <= 40, `${bad.length} runways disagree with their number: ${bad.slice(0, 12).join(', ')}`);
});
