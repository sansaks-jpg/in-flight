// Real-time weather for the aircraft's position – no presets.
//   * METAR (metar.vatsim.net – raw ICAO METAR, CORS-enabled) for the reporting airfield: surface wind, gusts, temperature, dew point, QNH, visibility, cloud layers, present weather.
//   * Open-Meteo model data (api.open-meteo.com, no key): precipitation / WMO weather code, cloud cover by level, 10-180 m winds,
//     and winds + temperature + geopotential height on pressure levels 1000…200 hPa (winds aloft for the whole flight).
// Both endpoints send CORS headers (METAR text is parsed here), so this runs directly in the browser. Everything degrades gracefully if offline (ISA, calm).
import { Vector3 } from 'three';

export interface WindLayer { h: number; dir: number; kt: number; tempC: number }
export interface LiveWx {
  ok: boolean;
  source: string;
  fetchedAt: number; lat: number; lon: number; elevM: number;
  tempC: number; dewC: number; qnh: number; windDir: number; windKt: number; gustKt: number; visM: number;
  /** cloud cover fractions 0..1 for low (<3 km) / mid (3-8 km) / high (>8 km) */
  cover: [number, number, number];
  /** lowest broken/overcast (or estimated) cloud base, metres above ground; null = none below 3 km */
  baseAglM: number | null;
  rain: number; snow: number; fog: number; thunder: boolean; code: number; wxString: string;
  metar: string; icao: string; obsAgeMin: number;
  layers: WindLayer[]; // MSL heights ascending
  condition: string;
}

export const OFFLINE_WX: LiveWx = {
  ok: false, source: 'offline (ISA, calm)', fetchedAt: 0, lat: 0, lon: 0, elevM: 0, tempC: 15, dewC: 8, qnh: 1013.25, windDir: 0, windKt: 0, gustKt: 0, visM: 30000,
  cover: [0.1, 0, 0.1], baseAglM: null, rain: 0, snow: 0, fog: 0, thunder: false, code: 0, wxString: '', metar: '', icao: '', obsAgeMin: 0, layers: [], condition: 'Weather offline – ISA, calm',
};

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};
const RAIN_BY_CODE: Record<number, number> = { 51: 0.15, 53: 0.3, 55: 0.45, 56: 0.25, 57: 0.4, 61: 0.35, 63: 0.65, 65: 0.95, 66: 0.5, 67: 0.8, 80: 0.45, 81: 0.75, 82: 1, 95: 0.8, 96: 0.95, 99: 1 };
const SNOW_BY_CODE: Record<number, number> = { 71: 0.3, 73: 0.6, 75: 0.95, 77: 0.3, 85: 0.5, 86: 0.9 };

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
async function getJson(url: string, ms = 6000): Promise<any> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); } finally { clearTimeout(t); }
}

const LEVELS = [1000, 925, 850, 700, 500, 300, 250, 200];

function parseMetarWx(wx: string) {
  // present weather groups: [-+]?(VC)?(MI|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|HZ|DU|SA|SQ|FC|SS|DS)+
  let rain = 0, snow = 0, fog = 0, thunder = false;
  for (const tok of (wx || '').split(/\s+/)) {
    if (!tok) continue; const heavy = tok.startsWith('+') ? 1.0 : tok.startsWith('-') ? 0.3 : 0.6;
    if (/TS/.test(tok)) thunder = true;
    if (/(RA|DZ)/.test(tok)) rain = Math.max(rain, /DZ/.test(tok) ? heavy * 0.6 : heavy);
    if (/(SN|SG|PL|GS|GR)/.test(tok)) snow = Math.max(snow, heavy);
    if (/FG/.test(tok)) fog = Math.max(fog, 1); else if (/BR/.test(tok)) fog = Math.max(fog, 0.35);
  }
  return { rain, snow, fog, thunder };
}


/** Parse a raw ICAO METAR into the fields the simulator needs. */
function parseRawMetar(raw: string): any | null {
  const t = raw.trim().split(/\s+/); if (t.length < 3) return null;
  const m: any = { rawOb: raw.trim(), icaoId: t[0] === 'METAR' || t[0] === 'SPECI' ? t[1] : t[0], clouds: [], wxString: '' };
  const wx: string[] = [];
  for (const k of t) {
    let r: RegExpMatchArray | null;
    if ((r = k.match(/^(\d{2})(\d{2})(\d{2})Z$/))) {
      const now = new Date(); let d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +r[1], +r[2], +r[3]);
      if (d > now.getTime() + 3600000) d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, +r[1], +r[2], +r[3]);
      m.obsTime = d / 1000;
    } else if ((r = k.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/))) {
      const f = r[4] === 'MPS' ? 1.94384 : r[4] === 'KMH' ? 0.539957 : 1;
      m.wdir = r[1] === 'VRB' ? 'VRB' : +r[1]; m.wspd = Math.round(+r[2] * f); m.wgst = r[3] ? Math.round(+r[3] * f) : 0;
    } else if (/^(CAVOK)$/.test(k)) { m.visM = 10000; m.cavok = true; }
    else if ((r = k.match(/^(\d{4})$/)) && m.visM === undefined && m.wspd !== undefined) m.visM = +r[1] >= 9999 ? 10000 : +r[1];
    else if ((r = k.match(/^(\d+)(?:\/(\d+))?SM$/))) m.visM = (r[2] ? +r[1] / +r[2] : +r[1]) * 1609.34;
    else if ((r = k.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})/))) m.clouds.push({ cover: r[1], base: +r[2] * 100 });
    else if (/^(SKC|CLR|NSC|NCD)$/.test(k)) m.clouds = [];
    else if ((r = k.match(/^(M?\d{2})\/(M?\d{2})?$/))) { const n = (x: string) => (x.startsWith('M') ? -1 : 1) * +x.replace('M', ''); m.temp = n(r[1]); if (r[2]) m.dewp = n(r[2]); }
    else if ((r = k.match(/^Q(\d{4})$/))) m.altim = +r[1];
    else if ((r = k.match(/^A(\d{4})$/))) m.altim = +r[1] / 100 * 33.8639;
    else if (/^[-+]?(VC)?(MI|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|HZ|DU|SA|SQ|FC|SS|DS)+$/.test(k)) wx.push(k);
    else if (k === 'RMK') break;
  }
  m.wxString = wx.join(' ');
  m.visib = m.visM === undefined ? 99 : m.visM >= 9999 ? 99 : m.visM / 1609.34;
  return m;
}

export async function fetchLiveWeather(lat: number, lon: number, icao?: string): Promise<LiveWx> {
  const lv = (k: string) => LEVELS.map((l) => `${k}_${l}hPa`).join(',');
  const om = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&current=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,is_day`
    + `&hourly=wind_speed_80m,wind_direction_80m,wind_speed_180m,wind_direction_180m,temperature_80m,${lv('wind_speed')},${lv('wind_direction')},${lv('temperature')},${lv('geopotential_height')}`
    + `&forecast_hours=1&wind_speed_unit=kn&timezone=GMT`;
  const metarTxt = async (): Promise<any[] | null> => {
    if (!icao || !/^[A-Z]{4}$/.test(icao)) return null;
    const r = await fetch(`https://metar.vatsim.net/${icao}`); if (!r.ok) return null; const m = parseRawMetar(await r.text()); return m ? [m] : null;
  };
  const [omR, mR] = await Promise.allSettled([getJson(om), metarTxt()]);
  if (omR.status !== 'fulfilled' && !(mR.status === 'fulfilled' && Array.isArray(mR.value) && mR.value.length)) throw new Error('weather unavailable');

  const wx: LiveWx = { ...OFFLINE_WX, ok: true, fetchedAt: Date.now(), lat, lon, layers: [], cover: [0, 0, 0] };
  const srcs: string[] = [];
  let spread = 99;
  if (omR.status === 'fulfilled') {
    const d = omR.value, c = d.current || {}, h = d.hourly || {}; const elev = num(d.elevation);
    srcs.push('Open-Meteo'); wx.elevM = elev;
    wx.tempC = num(c.temperature_2m, 15); wx.dewC = num(c.dew_point_2m, wx.tempC - 5);
    wx.qnh = num(c.pressure_msl, 1013.25); wx.windDir = num(c.wind_direction_10m); wx.windKt = num(c.wind_speed_10m); wx.gustKt = Math.max(wx.windKt, num(c.wind_gusts_10m));
    wx.visM = num(c.visibility, 30000);
    wx.cover = [num(c.cloud_cover_low) / 100, num(c.cloud_cover_mid) / 100, num(c.cloud_cover_high) / 100];
    wx.code = num(c.weather_code); const mmh = (num(c.rain) + num(c.showers) + num(c.precipitation)) * 4 / 2; // 15-min sums -> mm/h-ish
    wx.rain = Math.max(RAIN_BY_CODE[wx.code] ?? 0, Math.min(1, mmh / 8)); wx.snow = SNOW_BY_CODE[wx.code] ?? Math.min(1, num(c.snowfall) * 2);
    wx.thunder = wx.code >= 95; wx.fog = wx.code === 45 || wx.code === 48 ? 1 : 0;
    // wind profile (MSL): surface, 80, 180 m AGL, then pressure levels
    const L: WindLayer[] = [];
    L.push({ h: elev + 10, dir: wx.windDir, kt: wx.windKt, tempC: wx.tempC });
    for (const a of [80, 180]) { const sp = h[`wind_speed_${a}m`]?.[0], dr = h[`wind_direction_${a}m`]?.[0]; if (sp != null && dr != null) L.push({ h: elev + a, dir: dr, kt: sp, tempC: h[`temperature_80m`]?.[0] ?? wx.tempC - a * 0.0065 }); }
    for (const p of LEVELS) {
      const sp = h[`wind_speed_${p}hPa`]?.[0], dr = h[`wind_direction_${p}hPa`]?.[0], gz = h[`geopotential_height_${p}hPa`]?.[0], tt = h[`temperature_${p}hPa`]?.[0];
      if (sp != null && dr != null && gz != null && gz > elev + 250) L.push({ h: gz, dir: dr, kt: sp, tempC: tt ?? -20 });
    }
    wx.layers = L.sort((a, b) => a.h - b.h);
    spread = wx.tempC - wx.dewC;
  }
  if (mR.status === 'fulfilled' && Array.isArray(mR.value) && mR.value.length) {
    const m = mR.value[0]; const ageMin = (Date.now() / 1000 - num(m.obsTime)) / 60;
    wx.metar = String(m.rawOb || ''); wx.icao = String(m.icaoId || icao || ''); wx.obsAgeMin = Math.round(ageMin);
    if (ageMin < 100) {
      srcs.unshift(`METAR ${wx.icao}`);
      if (typeof m.temp === 'number') wx.tempC = m.temp; if (typeof m.dewp === 'number') wx.dewC = m.dewp; if (typeof m.altim === 'number') wx.qnh = m.altim;
      const ws = num(m.wspd), wg = num(m.wgst); wx.windKt = ws; wx.gustKt = Math.max(ws, wg, ws > 3 ? ws : 0); if (typeof m.wdir === 'number') wx.windDir = m.wdir; // VRB -> keep model direction
      const vis = num(m.visib, 99); // statute miles (99 = 10 km or more)
      if (vis < 6.2) wx.visM = vis * 1609.34;
      // clouds -> low-level cover and ceiling
      let ceil: number | null = null; let lowCover = wx.cover[0];
      if (Array.isArray(m.clouds) && m.clouds.length) {
        const frac: Record<string, number> = { SKC: 0, CLR: 0, NSC: 0, CAVOK: 0, FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 1, VV: 1 };
        let low = 0; let ceilFt = 1e9;
        for (const cl of m.clouds) { const f = frac[cl.cover] ?? 0; if (cl.base && cl.base < 10000) low = Math.max(low, f); if (cl.base && (cl.cover === 'BKN' || cl.cover === 'OVC' || cl.cover === 'VV')) ceilFt = Math.min(ceilFt, cl.base); }
        lowCover = low; wx.baseAglM = (m.clouds.find((c: any) => c.base && c.cover !== 'FEW')?.base ?? m.clouds[0].base ?? 2500) * 0.3048;
        if (ceilFt < 1e9) ceil = ceilFt * 0.3048;
      } else { lowCover = 0; }
      wx.cover = [lowCover, wx.cover[1], wx.cover[2]]; void ceil;
      const pw = parseMetarWx(String(m.wxString || '')); wx.wxString = String(m.wxString || '');
      if (pw.rain || pw.snow || pw.fog || pw.thunder || (!wx.wxString && ageMin < 100)) {
        // a METAR with no present-weather group means no precipitation at the station; keep model precip only if the model is heavy
        wx.rain = pw.rain || (wx.rain > 0.6 ? wx.rain * 0.5 : 0); wx.snow = pw.snow || (wx.snow > 0.6 ? wx.snow * 0.5 : 0); wx.fog = Math.max(pw.fog, wx.code === 45 ? 0 : 0); wx.thunder = pw.thunder;
      }
      spread = wx.tempC - wx.dewC;
      if (wx.layers.length) wx.layers[0] = { ...wx.layers[0], dir: wx.windDir, kt: wx.windKt, tempC: wx.tempC }; // the station observation is the 10 m wind
    }
  }
  // cloud base: METAR ceiling, else estimate from the temperature / dew-point spread (~125 m per °C)
  if (wx.baseAglM == null && wx.cover[0] > 0.15) wx.baseAglM = Math.max(150, Math.min(3000, spread * 125));
  if (wx.fog > 0.5 && wx.visM > 1500) wx.visM = 900;
  wx.source = srcs.join(' + ') || 'Open-Meteo';
  const cloudWord = (c: number) => (c < 0.1 ? 'Clear' : c < 0.3 ? 'Few clouds' : c < 0.6 ? 'Scattered clouds' : c < 0.85 ? 'Broken clouds' : 'Overcast');
  const cov = Math.max(wx.cover[0], wx.cover[1] * 0.9, wx.cover[2] * 0.6);
  wx.condition = wx.thunder ? 'Thunderstorm' : wx.snow > 0 ? (WMO[wx.code] && wx.code >= 71 ? WMO[wx.code] : 'Snow') : wx.rain > 0 ? (WMO[wx.code] && wx.code >= 51 ? WMO[wx.code] : wx.rain > 0.6 ? 'Heavy rain' : wx.rain > 0.3 ? 'Rain' : 'Light rain') : wx.fog > 0.5 ? 'Fog' : wx.fog > 0 ? 'Mist' : cloudWord(cov);
  return wx;
}

/** Interpolated wind (FROM direction deg, speed kt) and OAT (°C) at a given MSL altitude and height above ground. */
export function windProfile(wx: LiveWx | null, mslM: number, aglM: number, out: { dir: number; kt: number; tempC: number }) {
  if (!wx || !wx.layers.length) { out.dir = wx?.windDir ?? 0; out.kt = wx?.windKt ?? 0; out.tempC = wx?.tempC ?? 15; return out; }
  const L = wx.layers; const n = L.length;
  if (mslM <= L[0].h) {
    // below the 10 m observation: logarithmic boundary-layer decay to 0 at the surface (a real windsock sees the 10 m wind)
    const k = Math.min(1, Math.log(1 + Math.max(0, aglM) / 0.3) / Math.log(1 + 10 / 0.3));
    out.dir = L[0].dir; out.kt = L[0].kt * (aglM >= 10 ? 1 : k); out.tempC = L[0].tempC; return out;
  }
  if (mslM >= L[n - 1].h) { out.dir = L[n - 1].dir; out.kt = L[n - 1].kt; out.tempC = L[n - 1].tempC; return out; }
  let i = 0; while (i < n - 2 && mslM > L[i + 1].h) i++;
  const a = L[i], b = L[i + 1], t = (mslM - a.h) / Math.max(1, b.h - a.h);
  const ra = a.dir * Math.PI / 180, rb = b.dir * Math.PI / 180;
  const ue = Math.sin(ra) * a.kt * (1 - t) + Math.sin(rb) * b.kt * t, un = Math.cos(ra) * a.kt * (1 - t) + Math.cos(rb) * b.kt * t;
  out.kt = Math.hypot(ue, un); out.dir = (Math.atan2(ue, un) * 180 / Math.PI + 360) % 360; out.tempC = a.tempC + (b.tempC - a.tempC) * t;
  return out;
}

const _o = { dir: 0, kt: 0, tempC: 15 };
/** Velocity of the air mass (m/s) in world axes (+X east, -Z north) at the given altitude. */
export function windVector(wx: LiveWx | null, mslM: number, aglM: number, out: Vector3): Vector3 {
  windProfile(wx, mslM, aglM, _o);
  const toward = (_o.dir + 180) * Math.PI / 180, v = _o.kt * 0.514444;
  return out.set(Math.sin(toward) * v, 0, -Math.cos(toward) * v);
}

/** ISA deviation (K) at the surface for the real temperature (used for density altitude). */
export function isaDeviation(wx: LiveWx | null, elevM: number): number {
  if (!wx) return 0; const isa = 15 - 0.0065 * elevM; return wx.tempC - isa;
}

/** Compact METAR-style line when no raw METAR is available (model data). */
export function wxSummary(wx: LiveWx | null): string {
  if (!wx) return 'No weather data';
  const w = wx.windKt < 1 ? 'CALM' : `${String(Math.round(wx.windDir / 10) * 10 % 360 || 360).padStart(3, '0')}/${Math.round(wx.windKt)}${wx.gustKt > wx.windKt + 4 ? 'G' + Math.round(wx.gustKt) : ''}KT`;
  return `${w} · ${wx.condition} · ${Math.round(wx.tempC)}°C · QNH ${Math.round(wx.qnh)} · VIS ${wx.visM >= 10000 ? '10 km+' : (wx.visM / 1000).toFixed(1) + ' km'}`;
}
