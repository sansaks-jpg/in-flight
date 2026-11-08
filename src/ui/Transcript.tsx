import './transcript.css';
import { useEffect, useRef, useState } from 'react';
import type { AtcMessage, HudState } from '../sim/game';
import type { Settings } from '../sim/storage';
import type { CaptionKind } from '../sim/speech';
import { transcriptText, type TranscriptLang } from '../sim/translate';

/** Short, instrument-style speaker codes (what a flight strip or an ACP label would show). */
const WHO_TAG: Record<string, string> = {
  TOWER: 'TWR', GROUND: 'GND', CLEARANCE: 'DEL', DEPARTURE: 'DEP', APPROACH: 'APP', ENROUTE: 'CTR', ATIS: 'ATIS',
  PILOT: 'PLT', FO: 'F/O', PURSER: 'PURS', CABIN: 'PA', AUTO: 'A/C',
};
const KIND_NAME: Record<CaptionKind, { en: string; id: string }> = {
  atc: { en: 'Air traffic control', id: 'Pengatur lalu lintas udara' },
  pilot: { en: 'Pilot', id: 'Pilot' },
  crew: { en: 'Flight deck', id: 'Kokpit' },
  pa: { en: 'Cabin', id: 'Kabin' },
  auto: { en: 'Aircraft', id: 'Pesawat' },
  warning: { en: 'Warning', id: 'Peringatan' },
};
const kindOf = (m: Pick<AtcMessage, 'kind' | 'sender'>): CaptionKind => m.kind ?? (m.sender === 'PILOT' ? 'pilot' : 'atc');
export const speakerTag = (m: Pick<AtcMessage, 'sender'>) => WHO_TAG[m.sender] ?? m.sender.slice(0, 4).toUpperCase();
export const speakerName = (m: Pick<AtcMessage, 'label' | 'sender'>) => m.label ?? m.sender;

/** Keep the last line on screen briefly after the voice stops so it can actually be read; hide it at once when not flying. */
function useLingering(live: AtcMessage | null, enabled: boolean): AtcMessage | null {
  const [shown, setShown] = useState<AtcMessage | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!enabled) { setShown(null); return; }
    if (live) { setShown(live); return; }
    timer.current = window.setTimeout(() => setShown(null), 1400);
    return () => window.clearTimeout(timer.current);
  }, [live, enabled]);
  return enabled ? shown : null;
}

/** The on-air transcript: whoever is speaking right now, with speaker, channel and (optionally) the Indonesian translation. */
export function LiveTranscript({ hud, settings }: { hud: HudState; settings: Pick<Settings, 'transcripts' | 'transcriptLang'> }) {
  const flying = hud.phase === 'playing' || hud.phase === 'complete';
  const m = useLingering(hud.atcLive, settings.transcripts && flying);
  if (!m) return null;
  const lang: TranscriptLang = settings.transcriptLang, kind = kindOf(m), id = lang === 'id';
  const main = transcriptText(m, lang);
  const compact = kind === 'auto' || kind === 'warning';
  return (
    <figure className="comms-live" data-kind={kind} data-compact={compact} role="status" aria-live="polite" data-flight-ui>
      <figcaption>
        <span className="comms-tag">{speakerTag(m)}</span>
        <span className="comms-name">{speakerName(m)}</span>
        <span className="comms-kind">{KIND_NAME[kind][id ? 'id' : 'en']}</span>
        {id && <span className="comms-lang" title="Indonesian transcript">ID</span>}
      </figcaption>
      <blockquote lang={id ? 'id' : 'en'}>{main}</blockquote>
      {id && !compact && <p className="comms-original" lang="en">{m.text}</p>}
    </figure>
  );
}

/** Static sample used by Settings > Captions so the effect of the switches can be judged before flying. */
export function CaptionPreview({ lang, dimmed }: { lang: TranscriptLang; dimmed?: boolean }) {
  const id = lang === 'id';
  return (
    <div className="if-sub-preview" aria-hidden="true" style={{ opacity: dimmed ? .35 : 1 }}>
      <figure className="comms-live" data-kind="atc">
        <figcaption><span className="comms-tag">TWR</span><span className="comms-name">Jakarta Tower</span></figcaption>
        <blockquote>{id ? 'Skyline 986, angin 060 derajat 11 knot, landasan 07R, diizinkan lepas landas.' : 'Skyline 986, wind 060 degrees 11 knots, runway 07R, cleared for take-off.'}</blockquote>
        {id && <p className="comms-original">Skyline 986, wind 060 degrees 11 knots, runway 07R, cleared for take-off.</p>}
      </figure>
    </div>
  );
}

const fmtT = (t: number) => `${Math.floor(t / 60).toString().padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
/** One row of the transmission history. */
export function TranscriptEntry({ m, lang }: { m: AtcMessage; lang: TranscriptLang }) {
  const kind = kindOf(m);
  return (
    <div className="comms-entry" data-kind={kind}>
      <div><span className="comms-tag">{speakerTag(m)}</span><strong>{speakerName(m)}</strong><time>{fmtT(m.time)}</time></div>
      <p lang={lang}>{transcriptText(m, lang)}</p>
    </div>
  );
}

/** EN | ID segmented switch (same setting as Settings > Audio). */
export function TranscriptLangSwitch({ settings, setSettings }: { settings: Settings; setSettings: (p: Partial<Settings>) => void }) {
  return (
    <div className="comms-switch" role="group" aria-label="Transcript">
      <button aria-pressed={!settings.transcripts} onClick={() => setSettings({ transcripts: false })} title="Hide on-screen transcripts">OFF</button>
      <button aria-pressed={settings.transcripts && settings.transcriptLang === 'en'} onClick={() => setSettings({ transcripts: true, transcriptLang: 'en' })} title="English transcript">EN</button>
      <button aria-pressed={settings.transcripts && settings.transcriptLang === 'id'} onClick={() => setSettings({ transcripts: true, transcriptLang: 'id' })} title="Transkrip Bahasa Indonesia">ID</button>
    </div>
  );
}
