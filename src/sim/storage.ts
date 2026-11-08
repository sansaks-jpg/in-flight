export interface ScoreRecord { score: number; name: string; aircraft: string; from: string; to: string; grade: string; outcome: 'landed' | 'diverted' | 'crashed'; landingFpm: number | null; date: number; distanceKm: number; }
export type QualityPreset = 'ultra' | 'high' | 'medium' | 'low';
export type HudMode = 'minimal' | 'standard' | 'assisted' | 'cockpit';

export interface Settings {
  volume: number; muted: boolean; voice: boolean; assist: boolean; invertPitch: boolean; quality: QualityPreset | 'auto'; mapStyle: string; terrainStyle: string; tod: 'live'; weather: 'clear' | 'scattered' | 'overcast'; wind: 'calm' | 'light' | 'strong'; startMode: 'runway' | 'cruise' | 'final'; name: string; sens: number; shake: boolean; hud: boolean; units: 'aviation' | 'metric';
  hudMode: HudMode; uiScale: number; colorblind: boolean;
  /** Keep the in-flight top bar (route, status, tool buttons) on screen; otherwise it auto-hides after a few idle seconds. */
  uiPinned: boolean;
  /** On-screen transcripts of every spoken line (ATC, pilots, crew, cabin PA) and their language (English is the default). */
  transcripts: boolean; transcriptLang: 'en' | 'id';
}
export const DEFAULT_SETTINGS: Settings = { volume: 0.8, muted: false, voice: true, assist: true, invertPitch: false, quality: 'auto', mapStyle: 'hybrid', terrainStyle: 'hybrid', tod: 'live', weather: 'scattered', wind: 'light', startMode: 'runway', name: 'Pilot', sens: 1, shake: true, hud: true, units: 'aviation', hudMode: 'standard', uiScale: 1.0, colorblind: false, uiPinned: false, transcripts: true, transcriptLang: 'en' };
const SK = 'skyline.settings.v3', HK = 'skyline.scores.v2', LK = 'skyline.lastroute.v2';
export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SK) || '{}');
    const s = { ...DEFAULT_SETTINGS, ...raw };
    s.tod = 'live'; // time of day is always the real UTC clock; older saves stored 'day' / 'sunset'
    // the old default was the plain street map; move returning pilots to the satellite hybrid
    if (!raw.mapStyle) s.mapStyle = DEFAULT_SETTINGS.mapStyle;
    if (!raw.terrainStyle) s.terrainStyle = DEFAULT_SETTINGS.terrainStyle;
    if (s.quality !== 'auto' && s.quality !== 'ultra' && s.quality !== 'high' && s.quality !== 'medium' && s.quality !== 'low') {
      s.quality = DEFAULT_SETTINGS.quality;
    }
    if (s.hudMode !== 'minimal' && s.hudMode !== 'standard' && s.hudMode !== 'assisted' && s.hudMode !== 'cockpit') {
      s.hudMode = DEFAULT_SETTINGS.hudMode;
    }
    if (typeof s.uiScale !== 'number' || s.uiScale < 0.6 || s.uiScale > 1.8) {
      s.uiScale = DEFAULT_SETTINGS.uiScale;
    }
    if (typeof s.colorblind !== 'boolean') {
      s.colorblind = DEFAULT_SETTINGS.colorblind;
    }
    if (typeof s.uiPinned !== 'boolean') s.uiPinned = DEFAULT_SETTINGS.uiPinned;
    if (typeof s.transcripts !== 'boolean') s.transcripts = DEFAULT_SETTINGS.transcripts;
    if (s.transcriptLang !== 'en' && s.transcriptLang !== 'id') s.transcriptLang = DEFAULT_SETTINGS.transcriptLang;
    return s;
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s: Settings) { try { localStorage.setItem(SK, JSON.stringify(s)); } catch { /* storage unavailable */ } }
export function loadScores(): ScoreRecord[] { try { return JSON.parse(localStorage.getItem(HK) || '[]'); } catch { return []; } }
export function addScore(r: ScoreRecord): { rank: number; list: ScoreRecord[] } {
  const list = loadScores(); list.push(r); list.sort((a, b) => b.score - a.score);
  const top = list.slice(0, 20); try { localStorage.setItem(HK, JSON.stringify(top)); } catch { /* ignore */ }
  return { rank: top.indexOf(r) + 1, list: top };
}
export function clearScores() { try { localStorage.removeItem(HK); } catch { /* ignore */ } }
export function loadRoute(): { from: string; to: string; aircraft: string } | null { try { return JSON.parse(localStorage.getItem(LK) || 'null'); } catch { return null; } }
export function saveRoute(r: { from: string; to: string; aircraft: string }) { try { localStorage.setItem(LK, JSON.stringify(r)); } catch { /* ignore */ } }
