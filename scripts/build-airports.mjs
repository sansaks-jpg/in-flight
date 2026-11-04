// Builds src/data/airports.json from OurAirports (public domain) CSV dumps.
// usage: node scripts/build-airports.mjs airports.csv runways.csv
import fs from 'fs';
const [,, aFile, rFile] = process.argv;
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const R = 6371008.8, d2r = Math.PI / 180;
function dest(lat, lon, hdg, dist) {
  const φ1 = lat * d2r, λ1 = lon * d2r, θ = hdg * d2r, δ = dist / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [+(φ2 / d2r).toFixed(6), +((((λ2 / d2r) + 540) % 360) - 180).toFixed(6)];
}
const airports = parseCSV(fs.readFileSync(aFile, 'utf8'));
const runways = parseCSV(fs.readFileSync(rFile, 'utf8'));
const byAp = new Map();
for (const r of runways) { if (r.closed === '1') continue; (byAp.get(r.airport_ident) || byAp.set(r.airport_ident, []).get(r.airport_ident)).push(r); }
const hard = /ASP|CON|PEM|BIT|TAR|PAV|MAC|TAC|ASPH|CONC/i;
const out = [];
for (const a of airports) {
  if (a.type !== 'large_airport' && a.type !== 'medium_airport' && !(a.type === 'small_airport' && (a.scheduled_service === 'yes' || a.iata_code))) continue;
  const rws = (byAp.get(a.ident) || []).filter(r => +r.length_ft >= 2800 && hard.test(r.surface || 'ASP'));
  if (!rws.length) continue;
  rws.sort((x, y) => +y.length_ft - +x.length_ft);
  const lat = +a.latitude_deg, lon = +a.longitude_deg;
  const rr = [];
  for (const r of rws.slice(0, 3)) {
    const lenM = Math.round(+r.length_ft * 0.3048), wM = Math.max(18, Math.round((+r.width_ft || 100) * 0.3048));
    let a1 = [+r.le_latitude_deg, +r.le_longitude_deg], a2 = [+r.he_latitude_deg, +r.he_longitude_deg];
    if (!(r.le_latitude_deg && r.he_latitude_deg)) {
      let hd = parseFloat(r.le_heading_degT);
      if (isNaN(hd)) { const n = parseInt(r.le_ident); hd = isNaN(n) ? 0 : n * 10; }
      a1 = dest(lat, lon, hd + 180, lenM / 2); a2 = dest(lat, lon, hd, lenM / 2);
    }
    rr.push([r.le_ident, r.he_ident, a1[0], a1[1], a2[0], a2[1], wM, lenM]);
  }
  out.push([a.ident, a.name.replace(/ (International|Intl)? ?Airport$/i, m => m.trim().startsWith('Int') ? ' Intl' : ''), a.municipality, a.iso_country, +lat.toFixed(5), +lon.toFixed(5), Math.round((+a.elevation_ft || 0) * 0.3048), a.type === 'large_airport' ? 0 : a.type === 'medium_airport' ? 1 : 2, a.iata_code || '', rr]);
}
fs.writeFileSync('src/data/airports.json', JSON.stringify(out));
console.log(out.length, 'airports', (fs.statSync('src/data/airports.json').size / 1024).toFixed(0) + ' KB');
