// Builds the Indonesian aeronautical dataset used by the simulator.
//
//   node scripts/build-indonesia-data.mjs <dir with airports.csv runways.csv navaids.csv airport-frequencies.csv ways.json nodes.json>
//
// Sources (all open data):
//   * OurAirports (public domain)  – airports, runways (idents, surface, lighting, displaced thresholds), navaids, frequencies
//   * OpenStreetMap (ODbL, Overpass) – survey-grade runway geometry + taxiways, aprons, hangars, terminals, stands, holding points
//
// Outputs (src/data):
//   airports.json     – world database. Non-Indonesian rows are kept untouched, Indonesian rows are REBUILT:
//                       every non-closed airfield with any runway (paved, grass, gravel, dirt; any length; every runway).
//   airfields-id.json – ground layout per Indonesian airfield (taxiways, aprons, hangars, terminals, stands, holds, helipads)
//   navaids.json      – VOR / DME / NDB / TACAN for the region
//   frequencies.json  – published radio frequencies per airport
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] || '/tmp';
const OUT = 'src/data';
const R = 6371008.8, d2r = Math.PI / 180, r2d = 180 / Math.PI;

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const hav = (a1, o1, a2, o2) => {
  const p1 = a1 * d2r, p2 = a2 * d2r, dp = p2 - p1, dl = (o2 - o1) * d2r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};
const brg = (a1, o1, a2, o2) => {
  const p1 = a1 * d2r, p2 = a2 * d2r, dl = (o2 - o1) * d2r;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * r2d + 360) % 360;
};
const dest = (lat, lon, hdg, dist) => {
  const p1 = lat * d2r, l1 = lon * d2r, t = hdg * d2r, d = dist / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [+(p2 * r2d).toFixed(6), +((((l2 * r2d) + 540) % 360) - 180).toFixed(6)];
};
const wrap180 = (a) => ((a + 540) % 360) - 180;
const pad = (s) => (/^\d[LRC]?$/.test(s) ? '0' + s : s);

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

// ---------------------------------------------------------------------------------------------
const oldDb = JSON.parse(fs.readFileSync(path.join(OUT, 'airports.json'), 'utf8'));
const keepWorld = oldDb.filter((r) => r[3] !== 'ID');
const takenIds = new Set(keepWorld.map((r) => r[0]));

const csvAirports = parseCSV(fs.readFileSync(path.join(dir, 'airports.csv'), 'utf8'));
const csvRunways = parseCSV(fs.readFileSync(path.join(dir, 'runways.csv'), 'utf8'));
const osmWays = JSON.parse(fs.readFileSync(path.join(dir, 'ways.json'), 'utf8')).elements;
const osmNodes = JSON.parse(fs.readFileSync(path.join(dir, 'nodes.json'), 'utf8')).elements;

const skipTypes = new Set(['closed', 'heliport', 'seaplane_base', 'balloonport']);
const idAirports = csvAirports.filter((a) => a.iso_country === 'ID' && !skipTypes.has(a.type));
const rwByAp = new Map();
for (const r of csvRunways) { if (r.closed === '1') continue; (rwByAp.get(r.airport_ident) || rwByAp.set(r.airport_ident, []).get(r.airport_ident)).push(r); }

const centroid = (pts) => [pts.reduce((s, p) => s + p.lat, 0) / pts.length, pts.reduce((s, p) => s + p.lon, 0) / pts.length];

// ---- build airport records (OurAirports) ----------------------------------------------------
const aps = idAirports.map((a) => {
  const lat = +a.latitude_deg, lon = +a.longitude_deg;
  const code = [a.icao_code, a.gps_code].find((c) => /^[A-Z]{4}$/.test(c || '') && !takenIds.has(c)) || a.ident;
  return {
    oa: a, id: code, name: a.name.replace(/\s*\[.*?\]\s*/g, '').replace(/ (International|Intl)? ?Airport$/i, (m) => (m.trim().startsWith('Int') ? ' Intl' : '')).trim(),
    city: a.municipality || '', lat, lon, elevM: Math.round((+a.elevation_ft || 0) * 0.3048),
    size: a.type === 'large_airport' ? 0 : a.type === 'medium_airport' ? 1 : 2, iata: a.iata_code || '', rws: [], osm: false, approx: false,
  };
});
const seen = new Set();
for (const a of aps) { if (seen.has(a.id)) a.id = a.oa.ident; seen.add(a.id); }

// ---- OSM runways -> assign to nearest airfield ---------------------------------------------
const osmRunways = osmWays.filter((w) => w.tags.aeroway === 'runway' && w.geometry && w.geometry.length >= 2)
  .map((w) => ({ w, pts: w.geometry, ref: (w.tags.ref || '').toUpperCase().replace(/\s+/g, ''), c: centroid(w.geometry) }));

function nearestAirport(lat, lon, maxM) {
  let best = null, bd = maxM;
  for (const a of aps) { const d = hav(lat, lon, a.lat, a.lon); if (d < bd) { bd = d; best = a; } }
  return best;
}
const orphan = [];
for (const r of osmRunways) {
  const a = nearestAirport(r.c[0], r.c[1], 7000);
  if (a) (a.osmR || (a.osmR = [])).push(r); else orphan.push(r);
}

// OSM-only airfields (a runway exists in OSM, but not in OurAirports)
const osmAerodromes = osmWays.filter((w) => w.tags.aeroway === 'aerodrome' && w.geometry).map((w) => ({ t: w.tags, c: centroid(w.geometry) }))
  .concat(osmNodes.filter((n) => n.tags.aeroway === 'aerodrome').map((n) => ({ t: n.tags, c: [n.lat ?? n.center?.lat, n.lon ?? n.center?.lon] })));
const clusters = [];
for (const r of orphan) {
  let cl = clusters.find((c) => hav(c.lat, c.lon, r.c[0], r.c[1]) < 4000);
  if (!cl) clusters.push(cl = { lat: r.c[0], lon: r.c[1], runs: [] });
  cl.runs.push(r);
}
let osmOnly = 0;
for (const cl of clusters) {
  const ad = osmAerodromes.map((x) => ({ x, d: hav(cl.lat, cl.lon, x.c[0], x.c[1]) })).filter((x) => x.d < 4000).sort((p, q) => p.d - q.d)[0]?.x.t;
  let id = ad?.icao && /^[A-Z0-9]{3,4}$/.test(ad.icao) && !takenIds.has(ad.icao) && !seen.has(ad.icao) ? ad.icao : `ID-OSM${++osmOnly}`;
  seen.add(id);
  const name = ad?.['name:en'] || ad?.int_name || ad?.name || 'Airstrip';
  aps.push({
    oa: null, id, name: name.replace(/^Bandar Udara /i, '').trim() || 'Airstrip', city: ad?.['addr:city'] || '', lat: cl.lat, lon: cl.lon,
    elevM: +ad?.ele || 0, size: 2, iata: ad?.iata || '', rws: [], osm: true, approx: false, osmR: cl.runs,
  });
}

// ---- merge runways ---------------------------------------------------------------------------
function refIdents(ref) {
  return ref.split(/[\/;,-]/).map((s) => pad(s.trim())).filter((s) => /^\d{2}[LRC]?$|^[NSEW]{1,2}$/.test(s));
}
/** Group OSM runway ways of one airfield by ref (a single runway is often split in several ways). */
function groupOsm(list) {
  const groups = [];
  for (const r of list) {
    const ids = refIdents(r.ref);
    const g = ids.length ? groups.find((g) => g.ids.length && g.ids.some((i) => ids.includes(i))) : null;
    if (g) g.parts.push(r); else groups.push({ ids, parts: [r] });
  }
  const plen = (p) => hav(p.pts[0].lat, p.pts[0].lon, p.pts.at(-1).lat, p.pts.at(-1).lon);
  return groups.map((g) => {
    const pts = g.parts.flatMap((p) => p.pts);
    const lp = g.parts.slice().sort((a, b) => plen(b) - plen(a))[0];
    const ax = brg(lp.pts[0].lat, lp.pts[0].lon, lp.pts.at(-1).lat, lp.pts.at(-1).lon) * d2r;
    const [la0, lo0] = [pts[0].lat, pts[0].lon], kx = Math.cos(la0 * d2r);
    const proj = (p) => ((p.lon - lo0) * kx * Math.sin(ax) + (p.lat - la0) * Math.cos(ax));
    let a = pts[0], b = pts[0];
    for (const p of pts) { if (proj(p) < proj(a)) a = p; if (proj(p) > proj(b)) b = p; }
    const tags = Object.assign({}, ...g.parts.map((p) => p.w.tags));
    return { ids: g.ids, a, b, len: hav(a.lat, a.lon, b.lat, b.lon), hdg: brg(a.lat, a.lon, b.lat, b.lon), c: [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], tags, used: false };
  }).filter((g) => g.len >= 180);
}
const identNum = (s) => { const n = parseInt(s, 10); return isNaN(n) ? NaN : n * 10; };
function oppIdent(id) {
  const m = /^(\d{2})([LRC]?)$/.exec(id); if (!m) return null;
  let n = (parseInt(m[1], 10) + 18) % 36; if (n === 0) n = 36;
  return String(n).padStart(2, '0') + ({ L: 'R', R: 'L', C: 'C', '': '' })[m[2]];
}
function identsFromBearing(h) {
  let n = Math.round(h / 10) % 36; if (n === 0) n = 36;
  const a = String(n).padStart(2, '0');
  return [a, oppIdent(a)];
}
const defWidth = (len) => (len >= 2800 ? 45 : len >= 1800 ? 30 : len >= 1000 ? 23 : 18);
const axisDiff = (h1, h2) => Math.min(Math.abs(wrap180(h1 - h2)), Math.abs(wrap180(h1 - h2 - 180)));

let stats = { oaRunways: 0, osmMatched: 0, osmAdded: 0, headingSynth: 0, noRunways: 0 };
for (const a of aps) {
  const osmG = groupOsm(a.osmR || []);
  const oa = a.oa ? (rwByAp.get(a.oa.ident) || []) : [];
  const oaUse = oa.filter((r) => !/^H\d*[A-Z]?$/i.test(r.le_ident || '') && !/^H\d*[A-Z]?$/i.test(r.he_ident || '') && ((+r.length_ft || 0) * 0.3048 >= 180 || oa.length === 1));
  for (const r of oaUse) {
    stats.oaRunways++;
    let le = pad(r.le_ident || ''), he = pad(r.he_ident || '');
    const lenOA = Math.round(+r.length_ft * 0.3048) || 0;
    let wid = Math.round((+r.width_ft || 0) * 0.3048);
    const dispLe = Math.round((+r.le_displaced_threshold_ft || 0) * 0.3048), dispHe = Math.round((+r.he_displaced_threshold_ft || 0) * 0.3048);
    let tw = osmG.find((g) => !g.used && g.ids.length && (g.ids.includes(le) || g.ids.includes(he)));
    let hOA = parseFloat(r.le_heading_degT);
    if (isNaN(hOA)) hOA = identNum(le);
    if (!tw) {
      const ref = (r.le_latitude_deg && r.he_latitude_deg) ? [(+r.le_latitude_deg + +r.he_latitude_deg) / 2, (+r.le_longitude_deg + +r.he_longitude_deg) / 2] : [a.lat, a.lon];
      tw = osmG.filter((g) => !g.used && !g.ids.length && hav(g.c[0], g.c[1], ref[0], ref[1]) < 2000 && (isNaN(hOA) || axisDiff(g.hdg, hOA) < 15))
        .sort((p, q) => hav(p.c[0], p.c[1], ref[0], ref[1]) - hav(q.c[0], q.c[1], ref[0], ref[1]))[0];
    }
    let geom, src;
    if (tw && tw.len >= Math.max(300, lenOA * 0.5)) {
      tw.used = true; a.osm = true; stats.osmMatched++;
      const want = identNum(le);
      let p = tw.a, q = tw.b;
      if (!isNaN(want) && Math.abs(wrap180(tw.hdg - want)) > 90) { p = tw.b; q = tw.a; }
      geom = [p.lat, p.lon, q.lat, q.lon]; src = 'S';
      if (!wid && +tw.tags.width) wid = Math.round(+tw.tags.width);
      if ((!le || !he) && tw.ids.length) { le = tw.ids[0]; he = tw.ids[1] || oppIdent(le); }
    } else if (r.le_latitude_deg && r.he_latitude_deg && (r.le_latitude_deg !== r.he_latitude_deg || r.le_longitude_deg !== r.he_longitude_deg)) {
      geom = [+r.le_latitude_deg, +r.le_longitude_deg, +r.he_latitude_deg, +r.he_longitude_deg]; src = 'O';
    } else {
      let hd = parseFloat(r.le_heading_degT);
      if (isNaN(hd)) hd = identNum(le);
      if (isNaN(hd)) { const n = identNum(he); hd = isNaN(n) ? 0 : n + 180; }
      const L = lenOA || 600;
      const p = dest(a.lat, a.lon, hd + 180, L / 2), q = dest(a.lat, a.lon, hd, L / 2);
      geom = [p[0], p[1], q[0], q[1]]; src = 'H'; a.approx = true; stats.headingSynth++;
      if (!le && !he) [le, he] = identsFromBearing(hd);
    }
    if (!le && !he) [le, he] = identsFromBearing(brg(geom[0], geom[1], geom[2], geom[3]));
    if (!he) he = oppIdent(le) || 'XX';
    if (!le) le = oppIdent(he) || 'XX';
    const geoLen = Math.round(hav(geom[0], geom[1], geom[2], geom[3]));
    a.rws.push({
      le, he, g: geom.map((v) => +(+v).toFixed(6)), w: Math.max(wid || defWidth(geoLen), 12), l: lenOA && (src !== 'S' || Math.abs(geoLen - lenOA) / lenOA < 0.12) ? lenOA : geoLen,
      s: surfaceCode(r.surface || tw?.tags.surface), li: r.lighted === '1' ? 1 : 0, dl: dispLe, dh: dispHe, src,
    });
  }
  for (const g of osmG) {
    if (g.used) continue;
    const [le, he] = g.ids.length >= 2 ? [g.ids[0], g.ids[1]] : g.ids.length === 1 ? [g.ids[0], oppIdent(g.ids[0]) || 'XX'] : identsFromBearing(g.hdg);
    const n = identNum(le);
    let p = g.a, q = g.b;
    if (!isNaN(n) && Math.abs(wrap180(g.hdg - n)) > 90) { p = g.b; q = g.a; }
    if (a.rws.some((r) => r.le === le || r.he === le || r.le === he)) continue;
    a.osm = true; stats.osmAdded++;
    a.rws.push({ le, he, g: [p.lat, p.lon, q.lat, q.lon].map((v) => +v.toFixed(6)), w: Math.max(+g.tags.width || defWidth(g.len), 12), l: Math.round(g.len), s: surfaceCode(g.tags.surface), li: g.tags.lit === 'yes' ? 1 : 0, dl: 0, dh: 0, src: 'S' });
  }
  if (!a.rws.length) stats.noRunways++;
}
// Idents that cannot be right for the surveyed geometry (typos in the source data) are re-derived from the geometry.
for (const a of aps) for (const r of a.rws) {
  const h = brg(r.g[0], r.g[1], r.g[2], r.g[3]), n = identNum(r.le);
  if (!isNaN(n) && Math.abs(wrap180(h - n)) > 20) { const [x, y] = identsFromBearing(h); r.le = x; r.he = y; r.fixedIdent = true; stats.fixedIdent = (stats.fixedIdent || 0) + 1; }
}
const finalAps = aps.filter((a) => a.rws.length);

// ---- ground layout (OSM) ---------------------------------------------------------------------
const apMeta = finalAps.map((a) => {
  const pts = a.rws.flatMap((r) => [[r.g[0], r.g[1]], [r.g[2], r.g[3]]]);
  const cLat = pts.reduce((s, p) => s + p[0], 0) / pts.length, cLon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const ext = Math.max(...pts.map((p) => hav(cLat, cLon, p[0], p[1])));
  return { a, cLat, cLon, rad: ext + (a.size === 0 ? 2800 : 1800) };
});
function owner(lat, lon) {
  let best = null, bs = 1;
  for (const m of apMeta) { const s = hav(lat, lon, m.cLat, m.cLon) / m.rad; if (s < bs) { bs = s; best = m; } }
  return best;
}
const layout = {};
const lay = (m) => (layout[m.a.id] ||= { tw: [], ap: [], hg: [], tm: [], st: [], hp: [], hl: [] });
const enc = (m, lat, lon) => [Math.round((lat - m.a.lat) * 1e5), Math.round((lon - m.a.lon) * 1e5)];

function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const k = Math.cos(pts[0].lat * d2r);
  const X = (p) => p.lon * 111320 * k, Y = (p) => p.lat * 110574;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [s, e] = st.pop(); let md = 0, mi = -1;
    const ax = X(pts[s]), ay = Y(pts[s]), bx = X(pts[e]), by = Y(pts[e]), dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let i = s + 1; i < e; i++) { const d = Math.abs((X(pts[i]) - ax) * dy - (Y(pts[i]) - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol && mi > 0) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const flat = (m, pts) => pts.flatMap((p) => enc(m, p.lat, p.lon));

const counts = { taxiway: 0, apron: 0, hangar: 0, terminal: 0, stand: 0, hold: 0, helipad: 0 };
for (const w of osmWays) {
  const t = w.tags.aeroway, g = w.geometry;
  if (!g || g.length < 2 || !['taxiway', 'taxilane', 'apron', 'hangar', 'terminal', 'helipad'].includes(t)) continue;
  const [cl, co] = centroid(g); const m = owner(cl, co); if (!m) continue;
  const L = lay(m);
  if (t === 'taxiway' || t === 'taxilane') {
    L.tw.push([(w.tags.ref || w.tags.name || '').slice(0, 6), Math.round(+w.tags.width || (t === 'taxilane' ? 10 : m.a.size === 0 ? 23 : 15)), flat(m, simplify(g, 1.2))]); counts.taxiway++;
  } else if (t === 'apron') { L.ap.push([(w.tags.name || w.tags.ref || '').slice(0, 20), flat(m, simplify(g, 1.5))]); counts.apron++; }
  else if (t === 'hangar') { L.hg.push([(w.tags.name || w.tags.ref || '').slice(0, 20), flat(m, simplify(g, 1.0))]); counts.hangar++; }
  else if (t === 'terminal') { L.tm.push([(w.tags.name || '').slice(0, 24), flat(m, simplify(g, 1.0))]); counts.terminal++; }
  else if (t === 'helipad') { L.hl.push(enc(m, cl, co)); counts.helipad++; }
}
for (const n of osmNodes) {
  const t = n.tags.aeroway, lat = n.lat ?? n.center?.lat, lon = n.lon ?? n.center?.lon;
  if (lat == null) continue;
  if (!['parking_position', 'gate', 'holding_position', 'helipad'].includes(t)) continue;
  const m = owner(lat, lon); if (!m) continue;
  const L = lay(m), e = enc(m, lat, lon);
  if (t === 'parking_position' || t === 'gate') { L.st.push([(n.tags.ref || n.tags.name || '').slice(0, 8), e[0], e[1], t === 'gate' ? 1 : 0]); counts.stand++; }
  else if (t === 'holding_position') { L.hp.push([(n.tags.ref || '').slice(0, 8), e[0], e[1]]); counts.hold++; }
  else { L.hl.push(e); counts.helipad++; }
}
for (const k of Object.keys(layout)) { const L = layout[k]; if (Object.values(L).every((v) => !v.length)) delete layout[k]; }

// ---- write airports.json -----------------------------------------------------------------------
// runway tuple: [le, he, leLat, leLon, heLat, heLon, width, length, surf, lit, dispLeM, dispHeM, src]
const idRows = finalAps.map((a) => [
  a.id, a.name, a.city, 'ID', +a.lat.toFixed(5), +a.lon.toFixed(5), a.elevM, a.size, a.iata,
  a.rws.map((r) => [r.le, r.he, r.g[0], r.g[1], r.g[2], r.g[3], r.w, r.l, r.s, r.li, r.dl, r.dh, r.src]), a.approx ? 1 : 0,
]);
idRows.sort((x, y) => x[0].localeCompare(y[0]));
const merged = keepWorld.concat(idRows);
fs.writeFileSync(path.join(OUT, 'airports.json'), JSON.stringify(merged));
fs.writeFileSync(path.join(OUT, 'airfields-id.json'), JSON.stringify(layout));

// ---- legacy id aliases (older builds used different codes for some airfields) ----------------
const aliases = {};
for (const r of oldDb) {
  if (r[3] !== 'ID' || idRows.some((x) => x[0] === r[0])) continue;
  let best = null, bd = 3500;
  for (const x of idRows) { const d = hav(r[4], r[5], x[4], x[5]); if (d < bd) { bd = d; best = x[0]; } }
  if (best) aliases[r[0]] = best;
}
fs.writeFileSync(path.join(OUT, 'airport-aliases.json'), JSON.stringify(aliases, null, 0));
console.log('aliases', JSON.stringify(aliases));

// ---- navaids ------------------------------------------------------------------------------------
const navCsv = parseCSV(fs.readFileSync(path.join(dir, 'navaids.csv'), 'utf8'));
const navs = navCsv.filter((n) => +n.latitude_deg > -16 && +n.latitude_deg < 12 && +n.longitude_deg > 92 && +n.longitude_deg < 142 && ['NDB', 'VOR', 'VOR-DME', 'VORTAC', 'TACAN', 'DME', 'NDB-DME'].includes(n.type))
  .map((n) => [n.ident, n.name, n.type, Math.round(+n.frequency_khz || 0), +(+n.latitude_deg).toFixed(5), +(+n.longitude_deg).toFixed(5), Math.round((+n.elevation_ft || 0) * 0.3048), n.associated_airport || '']);
fs.writeFileSync(path.join(OUT, 'navaids.json'), JSON.stringify(navs));

// ---- frequencies --------------------------------------------------------------------------------
const freqCsv = parseCSV(fs.readFileSync(path.join(dir, 'airport-frequencies.csv'), 'utf8'));
const idByOa = new Map(); for (const a of finalAps) if (a.oa) idByOa.set(a.oa.ident, a.id);
const dbIds = new Set(merged.map((r) => r[0]));
const keepTypes = new Set(['TWR', 'GND', 'ATIS', 'APP', 'DEP', 'CTAF', 'UNICOM', 'AFIS', 'A/D', 'RDO', 'CLD', 'APRON', 'CNTR', 'TML']);
const freqs = {};
for (const f of freqCsv) {
  const id = idByOa.get(f.airport_ident) || f.airport_ident;
  if (!dbIds.has(id) || !keepTypes.has(f.type)) continue;
  const mhz = +f.frequency_mhz; if (!mhz) continue;
  (freqs[id] ||= []).push([f.type, mhz]);
}
fs.writeFileSync(path.join(OUT, 'frequencies.json'), JSON.stringify(freqs));

console.log(JSON.stringify({
  worldKept: keepWorld.length, indonesiaAirfields: idRows.length, osmOnlyAirfields: osmOnly, withoutAnyRunwayData: stats.noRunways,
  oaRunways: stats.oaRunways, osmMatched: stats.osmMatched, osmAddedRunways: stats.osmAdded, headingSynthesised: stats.headingSynth, identsRederived: stats.fixedIdent || 0,
  airfieldsWithLayout: Object.keys(layout).length, layoutCounts: counts, navaids: navs.length, freqAirports: Object.keys(freqs).length,
  files: Object.fromEntries(['airports', 'airfields-id', 'navaids', 'frequencies'].map((f) => [f, (fs.statSync(path.join(OUT, f + '.json')).size / 1024).toFixed(0) + ' KB'])),
}, null, 1));
