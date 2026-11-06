// Rebuilds the runway geometry of every NON-Indonesian airport in src/data/airports.json (Indonesian rows
// were already surveyed from OpenStreetMap by build-indonesia-data.mjs and are kept untouched).
//
//   node scripts/build-world-runways.mjs <dir with airports.csv + runways.csv> <dir with OSM batches b/*.json>
//
// Sources (open data, downloaded fresh — nothing is taken from memory):
//   * OurAirports (public domain)           – idents, surface, lighting, displaced thresholds, threshold coordinates
//   * OpenStreetMap / Overpass (ODbL)       – surveyed `aeroway=runway` centrelines  -> src 'S'
//
// For every airport ALL open runways are kept (the previous build capped at 3 and dropped short / unpaved ones,
// which silently removed runways at big airports such as ORD, DFW, DEN, ATL...). Geometry priority per runway:
//   S  OSM surveyed centreline matched by ident (or by heading + proximity)
//   O  OurAirports threshold coordinates, but ONLY when they pass sanity checks (heading matches the runway number,
//      the runway is near the airport reference point) — wrong coordinates are rejected instead of being trusted
//   H  placed on the airport from declared length + TRUE heading (magnetic runway number converted with the WMM)
//
// The airport set is widened to every large / medium airport and every small airport with scheduled service or an
// IATA code that has at least one usable runway (the old filter required a >=2800 ft hard runway).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const geomagnetism = require('geomagnetism');
const [,, oaDir = '/tmp/oa', osmDir = '/tmp/osm/b'] = process.argv;
const OUT = 'src/data/airports.json';
const R = 6371008.8, d2r = Math.PI / 180, r2d = 180 / Math.PI;
const wrap180 = (a) => ((a % 360 + 540) % 360) - 180, wrap360 = (a) => ((a % 360) + 360) % 360;
const model = geomagnetism.model(new Date(), { allowOutOfBoundsModel: true });
const decl = (lat, lon) => { try { const d = model.point([lat, lon]).decl; return Number.isFinite(d) ? d : 0; } catch { return 0; } };
const magToTrue = (m, lat, lon) => wrap360(m + decl(lat, lon));

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const hav = (a1, o1, a2, o2) => { const p1 = a1 * d2r, p2 = a2 * d2r, dp = p2 - p1, dl = (o2 - o1) * d2r; const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))); };
const brg = (a1, o1, a2, o2) => { const p1 = a1 * d2r, p2 = a2 * d2r, dl = (o2 - o1) * d2r; return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * r2d + 360) % 360; };
const dest = (lat, lon, hdg, dist) => { const p1 = lat * d2r, l1 = lon * d2r, t = hdg * d2r, d = dist / R; const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t)); const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2)); return [+(p2 * r2d).toFixed(6), +((((l2 * r2d) + 540) % 360) - 180).toFixed(6)]; };
const pad = (s) => (/^\d[LRC]?$/.test(s) ? '0' + s : s);
const identNum = (s) => { const n = parseInt(s, 10); return isNaN(n) ? NaN : n * 10; };
const oppIdent = (id) => { const m = /^(\d{2})([LRC]?)$/.exec(id); if (!m) return null; let n = (parseInt(m[1], 10) + 18) % 36; if (n === 0) n = 36; return String(n).padStart(2, '0') + ({ L: 'R', R: 'L', C: 'C', '': '' })[m[2]]; };
const identsFromBearing = (mag) => { let n = Math.round(mag / 10) % 36; if (n === 0) n = 36; const a = String(n).padStart(2, '0'); return [a, oppIdent(a)]; };
const axisDiff = (h1, h2) => Math.min(Math.abs(wrap180(h1 - h2)), Math.abs(wrap180(h1 - h2 - 180)));
const defWidth = (len) => (len >= 2800 ? 45 : len >= 1800 ? 30 : len >= 1000 ? 23 : 18);
function surfaceCode(s) {
  s = (s || '').toLowerCase();
  if (!s) return 'U';
  if (/con/.test(s)) return 'C';
  if (/asp|bit|tar|mac|tac|pav|pem|paved/.test(s)) return 'A';
  if (/gras|grs|gre|turf|grass/.test(s)) return 'G';
  if (/grav|gvl|coral|cor|stone|rock|compact|gravel/.test(s)) return 'V';
  if (/dirt|soil|earth|sand|mud|ground|unpaved|dir|lat|clay|natural/.test(s)) return 'D';
  if (/wat/.test(s)) return 'W';
  return 'U';
}

// ---- inputs --------------------------------------------------------------------------------------
const db = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const csvA = parseCSV(fs.readFileSync(path.join(oaDir, 'airports.csv'), 'utf8'));
const csvR = parseCSV(fs.readFileSync(path.join(oaDir, 'runways.csv'), 'utf8'));
const oaByIdent = new Map(csvA.map((a) => [a.ident, a]));
const rwByAp = new Map();
for (const r of csvR) { if (r.closed === '1') continue; (rwByAp.get(r.airport_ident) || rwByAp.set(r.airport_ident, []).get(r.airport_ident)).push(r); }
const osm = new Map();
if (fs.existsSync(osmDir)) for (const f of fs.readdirSync(osmDir)) if (f.endsWith('.json')) for (const w of JSON.parse(fs.readFileSync(path.join(osmDir, f), 'utf8'))) if (w.g.length >= 2) osm.set(w.id, w);
console.log('OSM runway ways loaded:', osm.size);

// ---- airport set ----------------------------------------------------------------------------------
const idRows = db.filter((r) => r[3] === 'ID');
const oldWorld = new Map(db.filter((r) => r[3] !== 'ID').map((r) => [r[0], r]));
const skipTypes = new Set(['closed', 'heliport', 'seaplane_base', 'balloonport']);
const usable = (r) => !/^H\d*[A-Z]?$/i.test(r.le_ident || '') && !/^H\d*[A-Z]?$/i.test(r.he_ident || '') && (+r.length_ft || 0) * 0.3048 >= 500;
const aps = [];
const seen = new Set(idRows.map((r) => r[0]));
for (const [id, row] of oldWorld) {
  const oa = oaByIdent.get(id);
  aps.push({ id, name: row[1], city: row[2], country: row[3], lat: row[4], lon: row[5], elev: row[6], size: row[7], iata: row[8], oa, old: row });
  seen.add(id);
}
let added = 0;
for (const a of csvA) {
  if (a.iso_country === 'ID' || skipTypes.has(a.type)) continue;
  if (seen.has(a.ident)) continue;
  const qualifies = a.type === 'large_airport' || a.type === 'medium_airport' || (a.type === 'small_airport' && (a.scheduled_service === 'yes' || a.iata_code));
  if (!qualifies) continue;
  if (!(rwByAp.get(a.ident) || []).some(usable)) continue;
  const nm = a.name.replace(/\s*\[.*?\]\s*/g, '').replace(/ (International|Intl)? ?Airport$/i, (m) => (m.trim().startsWith('Int') ? ' Intl' : '')).trim();
  aps.push({ id: a.ident, name: nm, city: a.municipality || '', country: a.iso_country, lat: +(+a.latitude_deg).toFixed(5), lon: +(+a.longitude_deg).toFixed(5), elev: Math.round((+a.elevation_ft || 0) * 0.3048), size: a.type === 'large_airport' ? 0 : a.type === 'medium_airport' ? 1 : 2, iata: a.iata_code || '', oa: a, old: null });
  seen.add(a.ident); added++;
}
console.log('airports:', aps.length, '(new:', added + ')');

// ---- assign OSM runway ways to the nearest airport -----------------------------------------------
const centroid = (g) => [g.reduce((s, p) => s + p[0], 0) / g.length, g.reduce((s, p) => s + p[1], 0) / g.length];
const grid = new Map(); const GK = (la, lo) => `${Math.floor(la / 0.5)},${Math.floor(lo / 0.5)}`;
for (const a of aps) { const k = GK(a.lat, a.lon); (grid.get(k) || grid.set(k, []).get(k)).push(a); }
function nearestAirport(lat, lon, maxM) {
  let best = null, bd = maxM; const la0 = Math.floor(lat / 0.5), lo0 = Math.floor(lon / 0.5);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const a of grid.get(`${la0 + i},${lo0 + j}`) || []) { const d = hav(lat, lon, a.lat, a.lon); if (d < bd) { bd = d; best = a; } }
  return best;
}
for (const w of osm.values()) {
  const c = centroid(w.g); const a = nearestAirport(c[0], c[1], 7000);
  if (a) (a.osmR || (a.osmR = [])).push({ w, pts: w.g, ref: (w.tags.ref || '').toUpperCase().replace(/\s+/g, ''), c });
}
const refIdents = (ref) => ref.split(/[\/;,-]/).map((s) => pad(s.trim())).filter((s) => /^\d{2}[LRC]?$|^[NSEW]{1,2}$/.test(s));
function groupOsm(list) {
  const groups = [];
  for (const r of list) {
    const ids = refIdents(r.ref);
    const g = ids.length ? groups.find((g) => g.ids.length && g.ids.some((i) => ids.includes(i))) : null;
    if (g) g.parts.push(r); else groups.push({ ids, parts: [r] });
  }
  const plen = (p) => hav(p.pts[0][0], p.pts[0][1], p.pts.at(-1)[0], p.pts.at(-1)[1]);
  return groups.map((g) => {
    const pts = g.parts.flatMap((p) => p.pts);
    const lp = g.parts.slice().sort((a, b) => plen(b) - plen(a))[0];
    const ax = brg(lp.pts[0][0], lp.pts[0][1], lp.pts.at(-1)[0], lp.pts.at(-1)[1]) * d2r;
    const [la0, lo0] = pts[0], kx = Math.cos(la0 * d2r);
    const proj = (p) => ((p[1] - lo0) * kx * Math.sin(ax) + (p[0] - la0) * Math.cos(ax));
    let a = pts[0], b = pts[0];
    for (const p of pts) { if (proj(p) < proj(a)) a = p; if (proj(p) > proj(b)) b = p; }
    const tags = Object.assign({}, ...g.parts.map((p) => p.w.tags));
    const ids = [...new Set(g.parts.flatMap((p) => refIdents(p.ref)))];
    return { ids: g.ids.length ? ids : [], a, b, len: hav(a[0], a[1], b[0], b[1]), hdg: brg(a[0], a[1], b[0], b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], tags, used: false };
  }).filter((g) => g.len >= 180);
}

// ---- build ------------------------------------------------------------------------------------------
const stats = { S: 0, O: 0, H: 0, osmAdded: 0, oaRejected: 0, airportsS: 0 };
const outRows = [];
for (const a of aps) {
  const osmG = groupOsm(a.osmR || []);
  const oa = (rwByAp.get(a.id) || []).filter(usable);
  const rws = [];
  const push = (rw) => rws.push(rw);
  for (const r of oa) {
    let le = pad(r.le_ident || ''), he = pad(r.he_ident || '');
    const lenOA = Math.round(+r.length_ft * 0.3048) || 0;
    let wid = Math.round((+r.width_ft || 0) * 0.3048);
    const dispLe = Math.round((+r.le_displaced_threshold_ft || 0) * 0.3048), dispHe = Math.round((+r.he_displaced_threshold_ft || 0) * 0.3048);
    const hasC = r.le_latitude_deg && r.he_latitude_deg && (r.le_latitude_deg !== r.he_latitude_deg || r.le_longitude_deg !== r.he_longitude_deg);
    const ref = hasC ? [(+r.le_latitude_deg + +r.he_latitude_deg) / 2, (+r.le_longitude_deg + +r.he_longitude_deg) / 2] : [a.lat, a.lon];
    const magWant = identNum(le);
    let trueWant = parseFloat(r.le_heading_degT);
    if (isNaN(trueWant)) trueWant = isNaN(magWant) ? NaN : magToTrue(magWant, a.lat, a.lon);
    let tw = osmG.find((g) => !g.used && g.ids.length && (g.ids.includes(le) || g.ids.includes(he)));
    if (!tw) tw = osmG.filter((g) => !g.used && !g.ids.length && hav(g.c[0], g.c[1], ref[0], ref[1]) < 1500 && (isNaN(trueWant) || axisDiff(g.hdg, trueWant) < 15)).sort((p, q) => hav(p.c[0], p.c[1], ref[0], ref[1]) - hav(q.c[0], q.c[1], ref[0], ref[1]))[0];
    let geom, src;
    if (tw && tw.len >= Math.max(300, lenOA * 0.5) && (isNaN(trueWant) || axisDiff(tw.hdg, trueWant) < 35)) {
      tw.used = true; stats.S++;
      let p = tw.a, q = tw.b;
      if (!isNaN(trueWant) && Math.abs(wrap180(tw.hdg - trueWant)) > 90) { p = tw.b; q = tw.a; }
      geom = [p[0], p[1], q[0], q[1]]; src = 'S';
      if (!wid && +tw.tags.width) wid = Math.round(+tw.tags.width);
      if ((!le || !he) && tw.ids.length) { le = tw.ids[0]; he = tw.ids[1] || oppIdent(le); }
    } else if (hasC) {
      const g4 = [+r.le_latitude_deg, +r.le_longitude_deg, +r.he_latitude_deg, +r.he_longitude_deg];
      const gl = hav(...g4), gb = brg(...g4);
      const mid = [(g4[0] + g4[2]) / 2, (g4[1] + g4[3]) / 2];
      const okHdg = isNaN(trueWant) || axisDiff(gb, trueWant) < 30;
      if (okHdg && hav(mid[0], mid[1], a.lat, a.lon) < 8000 && gl >= 150) { geom = g4; src = 'O'; stats.O++; }
      else stats.oaRejected++;
    }
    if (!geom) {
      let hd = trueWant;
      if (isNaN(hd)) { const n = identNum(he); hd = isNaN(n) ? 0 : magToTrue(n + 180, a.lat, a.lon); }
      const L = lenOA || 600;
      const p = dest(a.lat, a.lon, hd + 180, L / 2), q = dest(a.lat, a.lon, hd, L / 2);
      geom = [p[0], p[1], q[0], q[1]]; src = 'H'; stats.H++;
      if (!le && !he) [le, he] = identsFromBearing(wrap360(hd - decl(a.lat, a.lon)));
    }
    if (!le && !he) [le, he] = identsFromBearing(wrap360(brg(...geom) - decl(a.lat, a.lon)));
    if (!he) he = oppIdent(le) || 'XX';
    if (!le) le = oppIdent(he) || 'XX';
    const geoLen = Math.round(hav(...geom));
    push({ le, he, g: geom.map((v) => +(+v).toFixed(6)), w: Math.max(wid || defWidth(geoLen), 12), l: src === 'H' && lenOA ? lenOA : geoLen, s: surfaceCode(r.surface || tw?.tags.surface), li: r.lighted === '1' ? 1 : 0, dl: dispLe, dh: dispHe, src });
  }
  // OSM runways OurAirports does not list (or lists under another ident) — only when clearly at this airfield
  for (const g of osmG) {
    if (g.used || g.len < 400 || hav(g.c[0], g.c[1], a.lat, a.lon) > 3500) continue;
    const [le, he] = g.ids.length >= 2 ? [g.ids[0], g.ids[1]] : g.ids.length === 1 ? [g.ids[0], oppIdent(g.ids[0]) || 'XX'] : identsFromBearing(wrap360(g.hdg - decl(g.c[0], g.c[1])));
    const n = identNum(le); let p = g.a, q = g.b;
    if (!isNaN(n) && Math.abs(wrap180(g.hdg - magToTrue(n, a.lat, a.lon))) > 90) { p = g.b; q = g.a; }
    if (rws.some((r) => r.le === le || r.he === le || r.le === he || r.he === he)) continue;
    stats.osmAdded++; stats.S++;
    push({ le, he, g: [p[0], p[1], q[0], q[1]].map((v) => +v.toFixed(6)), w: Math.max(Math.round(+g.tags.width) || defWidth(g.len), 12), l: Math.round(g.len), s: surfaceCode(g.tags.surface), li: 0, dl: 0, dh: 0, src: 'S' });
  }
  if (!rws.length) { if (a.old) { outRows.push(a.old); } continue; } // never drop an airport we already had
  rws.sort((x, y) => y.l - x.l);
  if (rws.some((r) => r.src === 'S')) stats.airportsS++;
  outRows.push([a.id, a.name, a.city, a.country, a.lat, a.lon, a.elev, a.size, a.iata,
    rws.map((r) => [r.le, r.he, r.g[0], r.g[1], r.g[2], r.g[3], r.w, r.l, r.s, r.li, r.dl, r.dh, r.src]), rws.some((r) => r.src === 'H') ? 1 : 0]);
}
outRows.sort((x, y) => x[0].localeCompare(y[0]));
const merged = outRows.concat(idRows).sort((x, y) => x[0].localeCompare(y[0]));
fs.writeFileSync(OUT, JSON.stringify(merged));
console.log(stats, 'rows', merged.length, (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
