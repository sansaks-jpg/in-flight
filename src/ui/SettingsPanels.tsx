import { useState, type ReactNode } from 'react';
import { Settings, ScoreRecord, loadScores, clearScores } from '../sim/storage';
import { QUALITY, QUALITY_ORDER } from '../sim/quality';
import type { QualityPreset } from '../sim/storage';
import { FlightIcon, type FlightIconName } from './FlightIcon';
import { Button, Dialog, Kbd, Row, Section, Segmented, Select, Slider, Switch } from './Kit';
import { CaptionPreview } from './Transcript';

/** Dialog shell used by every menu / pause sub-screen so they all share one frame. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const t = title.toLowerCase();
  const icon: FlightIconName = t.includes('setting') ? 'settings' : t.includes('control') ? 'keyboard' : t.includes('logbook') || t.includes('score') ? 'trophy' : 'info';
  return <Dialog title={title} icon={icon} size={wide ? 'lg' : 'md'} layer="over" onClose={onClose}>{children}</Dialog>;
}

/* ------------------------------------------------------------------------------------------------ settings */
type Category = 'graphics' | 'audio' | 'flight' | 'interface' | 'captions';
const CATEGORIES: { id: Category; label: string; icon: FlightIconName; lead: string }[] = [
  { id: 'graphics', label: 'Graphics', icon: 'layers', lead: 'How much of the 3D world is drawn around the aircraft. Lower tiers stream less and hold frame rate on modest hardware.' },
  { id: 'audio', label: 'Audio & voice', icon: 'volume', lead: 'Engine, aerodynamic and cockpit sound plus the spoken radio, crew callouts and cabin announcements.' },
  { id: 'flight', label: 'Flight & controls', icon: 'autopilot', lead: 'How the aircraft responds to your inputs and how much help you get.' },
  { id: 'interface', label: 'Interface', icon: 'display', lead: 'On-screen instruments, text size and units. These apply to the in-flight overlay.' },
  { id: 'captions', label: 'Captions', icon: 'radio', lead: 'On-screen text for every spoken line, in the style of film subtitles.' },
];

const PRESET_CARDS: { id: QualityPreset | 'auto'; label: string; tag: string; bars: number }[] = [
  { id: 'low', label: 'Low', tag: 'Satellite terrain', bars: 1 },
  { id: 'medium', label: 'Medium', tag: '+ 3D trees', bars: 2 },
  { id: 'high', label: 'High', tag: '+ Buildings', bars: 3 },
  { id: 'ultra', label: 'Ultra', tag: '+ Houses', bars: 4 },
  { id: 'auto', label: 'Auto', tag: 'Best for device', bars: 0 },
];

function GraphicsPane({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  const q = s.quality === 'auto' ? null : QUALITY[s.quality];
  const present = QUALITY_ORDER.length ? PRESET_CARDS.filter((c) => c.id === 'auto' || QUALITY_ORDER.includes(c.id as QualityPreset)) : PRESET_CARDS;
  return <>
    <div className="if-presets" role="radiogroup" aria-label="3D world detail">
      {present.map((c) => <button key={c.id} type="button" role="radio" aria-checked={s.quality === c.id} className="if-preset" onClick={() => set({ quality: c.id })}>
        {c.id === 'auto' ? <FlightIcon name="bolt" size={14} /> : <span className="if-bars" aria-hidden="true">{[5, 8, 11, 14].map((h, i) => <i key={h} style={{ height: h }} data-on={i < c.bars} />)}</span>}
        <strong>{c.label}</strong><small>{c.tag}</small>
      </button>)}
    </div>
    <div className="if-callout">
      <div className="if-callout-head"><span className="if-eyebrow">{q ? `${q.label} detail` : 'Auto detail'}</span><span className="if-fps">60 FPS target</span></div>
      {q ? <>
        <p>{q.summary}</p>
        <div className="if-chips">{([['Buildings', q.buildings !== 'none'], ['Houses', q.buildings === 'all'], ['Trees', q.trees], ['3D roads', q.roads], ['3D airport', q.airportDetail], ['Street lights', q.streetLights]] as const).map(([l, on]) =>
          <span key={l} className="if-chip" data-on={on}>{l}</span>)}</div>
      </> : <p style={{ margin: 0 }}>Picks <b>High</b> on desktop and <b>Low</b> on touch devices, then scales render resolution on the fly to hold 60 FPS.</p>}
    </div>
  </>;
}

function AudioPane({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  return <>
    <Section title="Output">
      <Row label="Master volume"><Slider label="Master volume" min={0} max={1} step={0.05} value={s.volume} onChange={(v) => set({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} /></Row>
      <Row label="Mute all audio"><Switch label="Mute all audio" checked={s.muted} onChange={(v) => set({ muted: v })} /></Row>
    </Section>
    <Section title="Voice">
      <Row label="Spoken voice" hint="ATC, pilot readbacks, crew callouts, cabin PA and GPWS."><Switch label="Spoken voice" checked={s.voice} onChange={(v) => set({ voice: v })} /></Row>
    </Section>
    <p className="if-note">Speech is always English, as on a real frequency. Captions can be translated in the Captions tab.</p>
  </>;
}

function FlightPane({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  return <>
    <Section title="Handling">
      <Row label="Flight assist" hint="Stability and envelope protection."><Switch label="Flight assist" checked={s.assist} onChange={(v) => set({ assist: v })} /></Row>
      <Row label="Invert pitch" hint="Off: pushing forward pitches the nose down."><Switch label="Invert pitch control" checked={s.invertPitch} onChange={(v) => set({ invertPitch: v })} /></Row>
      <Row label="Control sensitivity"><Slider label="Control sensitivity" min={0.5} max={1.8} step={0.1} value={s.sens} onChange={(v) => set({ sens: v })} format={(v) => `${v.toFixed(1)}×`} /></Row>
    </Section>
    <Section title="Camera & guidance">
      <Row label="Cockpit camera shake" hint="Subtle motion from turbulence and ground roll."><Switch label="Cockpit camera shake" checked={s.shake} onChange={(v) => set({ shake: v })} /></Row>
      <Row label="Instructor hints" hint="Coaching tips during take-off, approach and landing."><Switch label="Instructor hints" checked={s.hud} onChange={(v) => set({ hud: v })} /></Row>
    </Section>
  </>;
}

function InterfacePane({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  return <>
    <Section title="Flight display">
      <Row label="HUD mode" hint={({ minimal: 'Essential data, unobstructed view.', standard: 'Flight instruments and live navigation.', assisted: 'Standard plus guidance brackets.', cockpit: 'Only the instruments of the 3D flight deck.' } as const)[s.hudMode]}>
        <Select label="HUD mode" value={s.hudMode} onChange={(v) => set({ hudMode: v })} options={[['minimal', 'Minimal'], ['standard', 'Standard'], ['assisted', 'Assisted'], ['cockpit', 'Cockpit 3D']] as const} />
      </Row>
      <Row label="Top bar" hint="Auto-hide shows it when the pointer reaches the top edge."><Segmented label="Top bar" value={s.uiPinned ? 'pin' : 'auto'} onChange={(v) => set({ uiPinned: v === 'pin' })} options={[['auto', 'Auto-hide'], ['pin', 'Always show']] as const} /></Row>
      <Row label="Units"><Segmented label="Flight data units" value={s.units} onChange={(v) => set({ units: v })} options={[['aviation', 'kt · ft'], ['metric', 'km/h · m']] as const} /></Row>
    </Section>
    <Section title="Readability">
      <Row label="Text size"><Select label="Text size" value={s.uiScale} onChange={(v) => set({ uiScale: v })} options={[[0.75, 'Compact'], [1, 'Default'], [1.25, 'Large'], [1.5, 'Extra large']] as const} /></Row>
      <Row label="High-contrast symbols" hint="Shape and text cues, not colour alone."><Switch label="High-contrast symbols" checked={s.colorblind} onChange={(v) => set({ colorblind: v })} /></Row>
    </Section>
    <Section title="Pilot">
      <Row label="Logbook callsign"><input className="if-input" aria-label="Pilot logbook callsign" value={s.name} maxLength={14} onChange={(e) => set({ name: e.target.value })} /></Row>
    </Section>
  </>;
}

function CaptionsPane({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  return <>
    <Section>
      <Row label="Show captions" hint="Transcribes ATC, pilots, crew and cabin announcements as they are spoken."><Switch label="Show captions" checked={s.transcripts} onChange={(v) => set({ transcripts: v })} /></Row>
      <Row label="Caption language" hint="Indonesian shows the English original beneath the translation." disabled={!s.transcripts}>
        <Segmented label="Caption language" value={s.transcriptLang} onChange={(v) => set({ transcriptLang: v })} options={[['en', 'English'], ['id', 'Indonesia']] as const} />
      </Row>
    </Section>
    <CaptionPreview lang={s.transcriptLang} dimmed={!s.transcripts} />
  </>;
}

export function SettingsPanel({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  const [cat, setCat] = useState<Category>('graphics');
  const meta = CATEGORIES.find((c) => c.id === cat)!;
  const pane = { graphics: GraphicsPane, audio: AudioPane, flight: FlightPane, interface: InterfacePane, captions: CaptionsPane }[cat];
  const Pane = pane;
  return <div className="if-settings">
    <nav className="if-settings-nav" role="tablist" aria-label="Settings categories" aria-orientation="vertical" onKeyDown={(e) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const i = CATEGORIES.findIndex((c) => c.id === cat), d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      e.preventDefault(); setCat(CATEGORIES[(i + d + CATEGORIES.length) % CATEGORIES.length].id);
      requestAnimationFrame(() => (e.currentTarget.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
    }}>
      {CATEGORIES.map((c) => <button key={c.id} type="button" role="tab" id={`tab-${c.id}`} aria-selected={cat === c.id} aria-controls="settings-pane" tabIndex={cat === c.id ? 0 : -1} onClick={() => setCat(c.id)}>
        <FlightIcon name={c.icon} size={17} />{c.label}</button>)}
    </nav>
    <div className="if-settings-pane" id="settings-pane" role="tabpanel" aria-labelledby={`tab-${cat}`}>
      <h3>{meta.label}</h3><p className="if-lead">{meta.lead}</p>
      <Pane s={s} set={set} />
    </div>
  </div>;
}

/* ------------------------------------------------------------------------------------------------ controls reference */
const K = ({ children }: { children: ReactNode }) => <Kbd>{children}</Kbd>;
const KEY_GROUPS: { title: string; rows: [ReactNode, string][] }[] = [
  { title: 'Flying', rows: [
    [<><K>W</K><K>S</K><i>/</i><K>↑</K><K>↓</K></>, 'Pitch down / up'],
    [<><K>A</K><K>D</K><i>/</i><K>←</K><K>→</K></>, 'Roll left / right'],
    [<><K>Q</K><K>E</K></>, 'Rudder and nose-wheel steering'],
    [<><K>Shift</K><K>Ctrl</K><i>/</i><K>PgUp</K><K>PgDn</K></>, 'Throttle up / down'],
    [<><K>X</K></>, 'Throttle idle (F1–F4 set thrust in any view)'],
    [<K>Space</K>, 'Wheel brakes (hold)'],
    [<K>B</K>, 'Parking brake'],
    [<><K>F</K><K>V</K></>, 'Flaps extend / retract'],
    [<K>G</K>, 'Landing gear'],
    [<K>T</K>, 'Reverse thrust'],
    [<K>Z</K>, 'Speedbrake / spoilers'],
  ] },
  { title: 'Systems & autopilot', rows: [
    [<><K>L</K><K>O</K></>, 'Landing lights · strobe and beacon'],
    [<><K>J</K><K>K</K></>, 'Seatbelt chime · cabin announcement'],
    [<K>Y</K>, 'Autopilot engage / disengage'],
    [<><K>N</K><K>U</K></>, 'LNAV route · ILS approach'],
    [<><K>,</K><K>.</K><K>[</K><K>]</K><K>-</K><K>=</K></>, 'Heading · altitude · speed'],
    [<K>\</K>, 'Time acceleration (cruise)'],
  ] },
  { title: 'Camera & interface', rows: [
    [<K>C</K>, 'Cycle camera view'],
    [<><K>0</K>–<K>9</K></>, 'Fly the cockpit camera to a panel'],
    [<><K>Alt</K>+click</>, 'Frame a control without operating it'],
    [<K>Home</K>, 'Reset the view'],
    [<K>M</K>, 'Full-screen map'],
    [<K>H</K>, 'Cycle HUD mode'],
    [<K>Tab</K>, 'Move through on-screen controls'],
  ] },
  { title: 'Session', rows: [
    [<><K>P</K><i>/</i><K>Esc</K></>, 'Pause (Esc closes an open tool first)'],
    [<><K>R</K> hold</>, 'Instant restart'],
    [<>Mouse</>, 'Drag to look · click a control to operate it'],
    [<>Touch</>, 'On-screen stick and throttle'],
  ] },
];

export function ControlsPanel() {
  return <div className="if-keys">
    {KEY_GROUPS.map((g) => <div key={g.title} className="if-key-group"><h4 className="if-eyebrow">{g.title}</h4>
      {g.rows.map(([k, d], i) => <div key={i} className="if-key-row"><span>{k}</span><span>{d}</span></div>)}</div>)}
    <p className="if-key-note"><b>Gamepad</b> — left stick pitch and roll, right stick X rudder, triggers throttle, A gear, B parking brake, bumpers flaps, D-pad ATC replies, Back cycles HUD mode, Start pauses.</p>
  </div>;
}

/* ------------------------------------------------------------------------------------------------ logbook */
export function ScoresPanel() {
  const [list, setList] = useState<ScoreRecord[]>(loadScores());
  if (!list.length) return <div className="if-empty"><FlightIcon name="trophy" size={28} /><strong style={{ color: 'var(--if-text)', fontWeight: 600, fontSize: 14 }}>No flights logged yet</strong>
    <span>Complete a flight to record your first entry in the pilot logbook.</span></div>;
  return <>
    <table className="if-table">
      <thead><tr><th>#</th><th>Pilot</th><th>Route</th><th>Grade</th><th className="num" style={{ textAlign: 'right' }}>Score</th></tr></thead>
      <tbody>{list.map((r, i) => <tr key={i}>
        <td style={{ color: 'var(--if-dim)' }} className="num">{i + 1}</td>
        <td style={{ fontWeight: 600 }}>{r.name}</td>
        <td><span style={{ fontFamily: 'var(--if-mono)' }}>{r.from} → {r.to}</span>
          {r.outcome === 'crashed' && <span className="if-chip" style={{ marginLeft: 8, color: 'var(--if-danger)', borderColor: 'rgba(255,141,128,.3)' }}>Crashed</span>}
          {r.outcome === 'diverted' && <span className="if-chip" style={{ marginLeft: 8, color: 'var(--if-warn)', borderColor: 'rgba(232,191,122,.3)' }}>Diverted</span>}</td>
        <td style={{ color: 'var(--if-accent)', fontWeight: 600 }}>{r.grade}</td>
        <td className="num" style={{ fontWeight: 600 }}>{r.score.toLocaleString()}</td></tr>)}</tbody>
    </table>
    <div style={{ padding: '10px 14px 14px' }}><Button variant="danger" onClick={() => { clearScores(); setList([]); }}>Clear logbook</Button></div>
  </>;
}
