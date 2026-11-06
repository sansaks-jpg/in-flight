import './flight.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Dispatch, type RefObject } from 'react';
import type { Airport } from '../data/airports';
import type { Game, HudState, Phase, Toast, ViewId } from '../sim/game';
import { haversine, M_PER_NM } from '../sim/geo';
import type { Settings } from '../sim/storage';
import { FlightIcon, type FlightIconName } from './FlightIcon';
import { PrimaryFlightDisplay, TouchControls } from './FlightInstruments';
import { FlightEdgeInstruments } from './FlightEdgeInstruments';
import type { NavigationMapView } from './MapPanel';
import type { FlightTool, FlightWorkspace, WorkspaceAction } from './flightWorkspace';
import { MiniMap, NavigationMap, type MapFocus } from './FlightMap';
import { FlightToggle, IconButton, PanelHeader, RunwaySelect } from './FlightWidgets';
import { FLIGHT_PHASE_LABELS, HUD_MODES, HUD_MODE_LABELS, flightUiScale, flightUnits, formatAltitude, formatSpeed, formatNumber, formatDistance, formatEte, formatHeading, primaryAlert } from './navigation';

function useFlightViewport() {
  const measure = () => ({ width: window.innerWidth, height: window.innerHeight, touch: matchMedia('(pointer: coarse)').matches });
  const [viewport, setViewport] = useState(measure);
  useEffect(() => {
    const update = () => setViewport(measure());
    const pointer = matchMedia('(pointer: coarse)');
    window.addEventListener('resize', update); pointer.addEventListener('change', update);
    return () => { window.removeEventListener('resize', update); pointer.removeEventListener('change', update); };
  }, []);
  return viewport;
}

const TOOLS: { id: FlightTool; label: string; icon: FlightIconName; key?: string }[] = [
  { id: 'navigation', label: 'Navigation', icon: 'map', key: 'M' },
  { id: 'autopilot', label: 'Autopilot', icon: 'autopilot', key: 'Y' },
  { id: 'radio', label: 'Radio', icon: 'radio' },
  { id: 'camera', label: 'Camera', icon: 'camera', key: 'C' },
  { id: 'display', label: 'Display', icon: 'display', key: 'H' },
];

function FlightToolbar({ workspace, onTool, pendingRadio, visible, onReveal, pinned, onPin }: {
  workspace: FlightWorkspace; onTool: (tool: FlightTool) => void; pendingRadio: boolean;
  visible: boolean; onReveal: () => void; pinned: boolean; onPin: () => void;
}) {
  const [focus, setFocus] = useState(0);
  return <div className="flight-toolbar-area" data-visible={visible} onPointerEnter={onReveal} onFocusCapture={onReveal}>
    <button className="flight-toolbar-handle" aria-label="Show flight toolbar" aria-expanded={visible} onClick={onReveal} tabIndex={visible ? -1 : 0}>
      <span /><FlightIcon name="down" size={13} /><span />
    </button>
    <div className="flight-toolbar" role="toolbar" aria-label="In-flight tools" data-flight-ui onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      e.preventDefault(); e.stopPropagation(); buttons[next]?.focus();
    }}>
      {TOOLS.map(({ id, label, icon, key }, i) => <button key={id} className="flight-tool" data-active={workspace.tool === id} tabIndex={focus === i ? 0 : -1}
        aria-label={label} aria-expanded={workspace.tool === id && !workspace.minimized} aria-controls={`flight-panel-${id}`} onFocus={() => setFocus(i)}
        onClick={(e) => { onTool(id); if (e.detail) e.currentTarget.blur(); }}>
        <span className="flight-tool-icon"><FlightIcon name={icon} size={18} />{id === 'radio' && pendingRadio && <i className="flight-notification-dot" />}</span>
        <span className="flight-tool-label">{label}</span><span className="flight-tooltip">{label}{key && <kbd>{key}</kbd>}</span>
      </button>)}
      <span className="flight-toolbar-divider" />
      <button className="flight-toolbar-pin" aria-label={pinned ? 'Auto-hide toolbar' : 'Keep toolbar visible'} aria-pressed={pinned} tabIndex={focus === TOOLS.length ? 0 : -1}
        title={pinned ? 'Auto-hide toolbar' : 'Keep toolbar visible'} onFocus={() => setFocus(TOOLS.length)} onClick={(e) => { onPin(); if (e.detail) e.currentTarget.blur(); }}><FlightIcon name="pin" size={15} /></button>
    </div>
  </div>;
}

function FlightPlan({ hud, from, to, onLocate, selected, scrollPosition }: { hud: HudState; from: Airport; to: Airport; onLocate: (lat: number, lon: number, label: string) => void; selected?: string; scrollPosition: RefObject<number | null> }) {
  const list = useRef<HTMLDivElement>(null);
  const legs = useMemo(() => hud.flightPlan.map((wp, i, plan) => i ? haversine(plan[i - 1].lat, plan[i - 1].lon, wp.lat, wp.lon) / M_PER_NM : 0), [hud.flightPlan]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (scrollPosition.current !== null) element.scrollTop = scrollPosition.current;
    else element.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
    return () => { scrollPosition.current = element.scrollTop; };
  }, [scrollPosition]);
  return <>
    <div className="flight-plan-summary"><div><span className="flight-eyebrow">Departure</span><strong>{from.icao}</strong><span>{from.city || from.name}</span></div>
      <FlightIcon name="chevron" size={17} /><div><span className="flight-eyebrow">Arrival</span><strong>{to.icao}</strong><span>{to.city || to.name}</span></div>
    </div>
    <div className="flight-route-progress"><span style={{ width: `${Math.round(hud.progress * 100)}%` }} /></div>
    <div className="flight-plan-overview"><span>{formatDistance(hud.distNm)} NM remaining</span><span>ETE {formatEte(hud.eteMin, hud.gsKt > 5)}</span></div>
    <div className="flight-plan-table-head"><button className="flight-active-leg" onClick={() => list.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' })}>Active leg<FlightIcon name="target" size={12} /></button><span>ALTITUDE · FT</span></div>
    <div ref={list} className="flight-waypoint-list" onScroll={(e) => { scrollPosition.current = e.currentTarget.scrollTop; }}>
      {hud.flightPlan.length === 0 && <div className="flight-empty-state">Direct to {to.icao}. Your destination is shown on the navigation map.</div>}
      {hud.flightPlan.map((wp, i) => <button key={`${wp.id}-${i}`} className="flight-waypoint-row" data-passed={i < hud.activeWpIdx} data-selected={selected === wp.name}
        aria-current={i === hud.activeWpIdx ? 'step' : undefined} onClick={() => { onLocate(wp.lat, wp.lon, wp.name); }} title={`Locate ${wp.name} on the map`}>
        <span className="flight-waypoint-timeline">{i < hud.activeWpIdx ? <FlightIcon name="check" size={13} /> : <span />}</span>
        <span className="flight-waypoint-info"><strong>{wp.name}</strong><small>{i === hud.activeWpIdx ? `${formatDistance(hud.activeWp?.distNm ?? legs[i])} NM · ACTIVE LEG` : i === 0 ? 'DEPARTURE' : `${formatDistance(legs[i])} NM LEG`}</small></span>
        <span className="flight-waypoint-alt">{Math.round(wp.altM / .3048 / 100) * 100}<small>FT</small></span>
      </button>)}
    </div>
    <div className="flight-panel-note"><FlightIcon name="target" size={14} />Select a waypoint to inspect it on the map.</div>
  </>;
}

function TargetSelector({ label, value, unit, step, min, max, disabled, onChange }: {
  label: string; value: number; unit: string; step: number; min: number; max: number; disabled?: boolean; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    if (cancelled.current) { cancelled.current = false; setDraft(String(value)); return; }
    const next = draft.trim() ? Number(draft) : NaN;
    if (Number.isFinite(next)) {
      const selected = label === 'Heading' ? ((Math.round(next) % 360) + 360) % 360 : Math.max(min, Math.min(max, Math.round(next / (label === 'Altitude' && unit !== 'METERS' ? 100 : 1)) * (label === 'Altitude' && unit !== 'METERS' ? 100 : 1)));
      setDraft(String(selected)); onChange(selected);
    } else setDraft(String(value));
  };
  return <div className="flight-target-row" data-disabled={disabled}>
    <label htmlFor={`ap-target-${label}`}>{label}<small>{disabled ? 'MANAGED' : unit}</small></label>
    {!disabled && <button aria-label={`Decrease ${label.toLowerCase()}`} onClick={() => onChange(value - step)}><FlightIcon name="minus" size={15} /></button>}
    <input id={`ap-target-${label}`} aria-label={`Target ${label.toLowerCase()}`} type="number" inputMode="numeric" min={min} max={max} step={step}
      disabled={disabled} value={draft} onFocus={() => { editing.current = true; }} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
      }} />
    {!disabled && <button aria-label={`Increase ${label.toLowerCase()}`} onClick={() => onChange(value + step)}><FlightIcon name="plus" size={15} /></button>}
  </div>;
}

function AutopilotPanel({ game, hud, to }: { game: Game; hud: HudState; to: Airport }) {
  const ap = hud.ap;
  const managed = ap.on && (ap.nav || ap.appr);
  const units: Settings['units'] = 'aviation', labels = flightUnits(units), metric = false;
  return <div className="flight-panel-content">
    <button className="flight-ap-master" aria-label={ap.on ? 'Disengage autopilot' : 'Engage autopilot'} data-active={ap.on} aria-pressed={ap.on} onClick={() => game.action('ap')}>
      <span className="flight-ap-power"><FlightIcon name="autopilot" size={23} /></span><span><strong>{ap.on ? 'Autopilot engaged' : 'Manual flight'}</strong>
        <small>{ap.on ? 'Select to return control to the pilot' : hud.onGround ? 'Engage automatic takeoff' : 'Engage flight guidance'}</small></span>
      <span className="flight-ap-state">{ap.on ? 'ON' : 'OFF'}</span>
    </button>
    <div className="flight-control-section"><span className="flight-eyebrow">Lateral guidance</span><div className="flight-segmented" aria-label="Autopilot guidance mode">
      <button aria-pressed={ap.on && ap.nav} onClick={() => { if (!ap.on || !ap.nav) game.action('apnav'); }}><span>Route</span><small>NAV</small></button>
      <button disabled={hud.onGround} aria-pressed={ap.on && !ap.nav && !ap.appr} onClick={() => game.action('aphdg')}><span>Heading</span><small>HDG</small></button>
      <button disabled={hud.onGround} aria-pressed={ap.on && ap.appr} onClick={() => game.action('appr')} title={hud.ils?.valid ? 'Arm ILS approach' : 'Requires an ILS signal'}><span>Approach</span><small>APPR</small></button>
    </div></div>
    <div className="flight-ap-targets">
      <TargetSelector label="Heading" unit="DEG MAG" value={Math.round(ap.hdg) % 360} step={5} min={0} max={359} disabled={hud.onGround} onChange={(v) => game.setApTarget('hdg', v)} />
      <TargetSelector label="Altitude" unit={metric ? 'METERS' : 'FEET'} value={Number(formatAltitude(ap.alt, units))} step={metric ? 30 : 100} min={0} max={metric ? 13716 : 45000} disabled={managed} onChange={(v) => game.setApTarget('alt', v / (metric ? .3048 : 1))} />
      <TargetSelector label="Airspeed" unit={labels.speed} value={Number(formatSpeed(ap.spd, units))} step={5} min={Number(formatSpeed(hud.vs1 * 1.2, units))} max={Number(formatSpeed(hud.vne * .85, units))} disabled={managed} onChange={(v) => game.setApTarget('spd', v / (metric ? 1.852 : 1))} />
    </div>
    <p className="flight-panel-description">{managed ? 'Altitude and speed follow the route profile. Choose Heading to set your own targets.' : 'Selected targets use aviation units. Turn the heading selector to leave NAV mode.'}</p>
    <RunwaySelect airport={to} value={hud.apprRwy} onChange={(ident) => game.setArrRunway(ident)} />
    <p className="flight-panel-description">{formatHeading(hud.rwyHdg)} magnetic · {hud.ils?.valid ? `ILS ${hud.ils.ident} available` : 'ILS not available / out of range'}</p>
    <div className="flight-rate-row"><span>Simulation rate<small>{hud.canWarp ? 'Autopilot cruise available' : 'Available in safe autopilot cruise'}</small></span>
      <button disabled={!hud.canWarp && hud.timeScale === 1} onClick={() => game.action('warp')} aria-label="Cycle simulation rate">{hud.timeScale}×<FlightIcon name="chevron" size={12} /></button>
    </div>
  </div>;
}

function RadioPanel({ game, hud }: { game: Game; hud: HudState }) {
  const [history, setHistory] = useState(false);
  const messages = hud.atc ? [hud.atc] : [];
  return <>
    <div className="flight-radio-status"><span className="flight-live-dot" />COM 1<span>{game.atcResponding ? 'TRANSMITTING…' : 'SIMULATED ATC'}</span></div>
    <div className="flight-radio-log" aria-live="polite" aria-relevant="additions text">
      {!messages.length && <div className="flight-empty-state"><FlightIcon name="radio" size={26} /><p>Radio standing by</p><span>Request a clearance using the options below.</span></div>}
      {messages.map((m) => <div className="flight-transmission" key={m.id} data-pilot={m.sender === 'PILOT'}>
        <div><strong>{m.sender}</strong><time>{Math.floor(m.time / 60).toString().padStart(2, '0')}:{String(Math.floor(m.time % 60)).padStart(2, '0')}</time></div>
        <p>{m.text}</p>{m.needsAck && <span className="flight-response-needed">Response requested</span>}
      </div>)}
    </div>
    <div className="flight-radio-responses"><span className="flight-eyebrow">Transmit · keys 1–4 while radio is open</span>
      {['Roger / Wilco', 'Request departure', 'Request approach', 'Say again'].map((text, i) => <button key={text} disabled={game.atcResponding} onClick={() => game.action(`atc${i + 1}`)}><kbd>{i + 1}</kbd>{text}<FlightIcon name="chevron" size={13} /></button>)}
    </div>
    <details className="flight-disclosure" open={history} onToggle={(e) => setHistory(e.currentTarget.open)}><summary>Transmission history <span>{hud.atcLog.length}</span></summary>
      <div className="flight-radio-log">{hud.atcLog.slice().reverse().map((m) => <div className="flight-transmission" key={m.id} data-pilot={m.sender === 'PILOT'}><strong>{m.sender}</strong><p>{m.text}</p></div>)}</div>
    </details>
  </>;
}

const CAMERA_VIEWS: { id: ViewId; label: string; description: string; icon: FlightIconName }[] = [
  { id: 'cockpit', label: 'Cockpit', description: 'Pilot seat & working instruments', icon: 'autopilot' },
  { id: 'chase', label: 'External', description: 'Follow your aircraft', icon: 'plane' },
  { id: 'spotter', label: 'Spotter', description: 'Watch from outside', icon: 'camera' },
  { id: 'aisle', label: 'Cabin', description: 'Passenger cabin aisle', icon: 'camera' },
  { id: 'window', label: 'Window', description: 'Passenger window seat', icon: 'camera' },
];

function CameraPanel({ game, hud, onDone }: { game: Game; hud: HudState; onDone: () => void }) {
  return <div className="flight-panel-content"><span className="flight-eyebrow">Camera view <kbd>C</kbd></span><div className="flight-camera-views">
    {CAMERA_VIEWS.slice(0, 2).map((view) => <button key={view.id} aria-pressed={hud.view === view.id} onClick={() => { game.setView(view.id); onDone(); }}><FlightIcon name={view.icon} size={20} />
      <span><strong>{view.label}</strong><small>{view.description}</small></span>{hud.view === view.id && <FlightIcon name="check" size={16} />}</button>)}
    </div><details className="flight-disclosure"><summary>More camera views</summary><div className="flight-camera-views">{CAMERA_VIEWS.slice(2).map((view) => <button key={view.id} data-active={hud.view === view.id} aria-pressed={hud.view === view.id} onClick={() => { game.setView(view.id); onDone(); }}><FlightIcon name={view.icon} size={20} /><span><strong>{view.label}</strong><small>{view.description}</small></span></button>)}</div></details><button className="flight-reset-view" onClick={() => { game.resetView(); onDone(); }}><FlightIcon name="reset" size={15} />Reset camera position<kbd>Home</kbd></button>
    <p className="flight-panel-description">Hold right mouse and drag to look around, including over cockpit controls. Left-click to interact with the cockpit.</p>
  </div>;
}

function DisplayPanel({ settings, setSettings, fullInstruments, setFullInstruments }: { settings: Settings; setSettings: (p: Partial<Settings>) => void; fullInstruments: boolean; setFullInstruments: (v: boolean) => void }) {
  return <div className="flight-panel-content"><div className="flight-control-section"><span className="flight-eyebrow">HUD display <kbd>H</kbd></span>
    <div className="flight-display-modes">{HUD_MODES.map((mode) => <button key={mode} aria-pressed={settings.hudMode === mode} onClick={() => setSettings({ hudMode: mode })}><span>{HUD_MODE_LABELS[mode]}</span>{settings.hudMode === mode && <FlightIcon name="check" size={14} />}</button>)}</div>
    <p className="flight-panel-description">{settings.hudMode === 'minimal' ? 'Essential flight data with an unobstructed view.' : settings.hudMode === 'assisted' ? 'Flight instruments and contextual instructor guidance.' : settings.hudMode === 'cockpit' ? 'Use the aircraft’s working 3D cockpit instruments.' : 'External round gauges and live navigation. The full instrument panel is optional.'}</p></div>
    <FlightToggle label="Full instrument panel" description="Show the glass primary flight display in external view" checked={fullInstruments} onChange={setFullInstruments} />
    <details className="flight-disclosure"><summary>Text, units & accessibility</summary>
      <FlightToggle label="High-contrast symbols" description="Shape and text cues, not color alone" checked={settings.colorblind} onChange={(v) => setSettings({ colorblind: v })} />
      <label className="flight-select-row">Interface size<select aria-label="Interface size" value={settings.uiScale} onChange={(e) => setSettings({ uiScale: Number(e.target.value) })}><option value={0.75}>Compact</option><option value={1}>Default</option><option value={1.25}>Large text</option><option value={1.5}>Extra large text</option></select></label>
      <p className="flight-panel-description">Text size changes without enlarging the map or blocking the view.</p>
      <label className="flight-select-row">Flight data units<select aria-label="Flight data units" value={settings.units} onChange={(e) => setSettings({ units: e.target.value as Settings['units'] })}><option value="aviation">Knots / feet</option><option value="metric">km/h / meters</option></select></label>
    </details>
    <details className="flight-disclosure"><summary>Keyboard shortcuts</summary><div className="flight-shortcut-guide">{[['Full-screen map', 'M'], ['Return from map', 'Esc'], ['Cycle camera', 'C'], ['Cycle HUD', 'H'], ['Autopilot', 'Y'], ['Pause / return to flight', 'Esc']].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div></details>
  </div>;
}

function FlightAlerts({ game, hud }: { game: Game; hud: HudState }) {
  const warning = primaryAlert(hud.warn);
  if (!warning) return null;
  return <div className="flight-alert" data-severity={warning.level} data-acknowledged={!!warning.acked} data-flight-ui role={warning.acked ? 'status' : 'alert'}>
    <FlightIcon name="alert" size={19} /><div><span>{warning.level === 'warning' ? 'WARNING' : 'CAUTION'}{hud.warn.length > 1 && <span className="flight-alert-count">{` · ${hud.warn.length} ACTIVE`}</span>}</span><strong>{warning.text}</strong></div>
    <button onClick={() => game.action('ackWarn')} disabled={warning.acked} title="Acknowledge primary alert">{warning.acked ? <FlightIcon name="check" size={15} /> : 'ACK'}</button>
  </div>;
}

function CompactTelemetry({ hud, metric, minimal }: { hud: HudState; metric: boolean; minimal: boolean }) {
  const units = metric ? 'metric' : 'aviation';
  return <section className="flight-telemetry" data-minimal={minimal} aria-label="Flight telemetry" data-flight-ui>
    <div className="flight-telemetry-primary"><div><span className="flight-eyebrow">IAS · {metric ? 'KM/H' : 'KT'}</span><strong>{formatSpeed(hud.kias, units)}</strong></div><div><span className="flight-eyebrow">HDG · MAG</span><strong>{formatHeading(hud.hdg)}</strong></div><div><span className="flight-eyebrow">ALT · {metric ? 'M' : 'FT'}</span><strong>{formatAltitude(hud.altFt, units)}</strong></div>{!minimal && <div><span className="flight-eyebrow">VS · {metric ? 'M/S' : 'FPM'}</span><strong>{metric ? (hud.vsFpm * .00508).toFixed(1) : Math.round(hud.vsFpm / 50) * 50}</strong></div>}</div>
    {!minimal && <div className="flight-telemetry-systems"><span>ENGINE <b>{Math.round(hud.n1 * 100)}%</b></span><span>FUEL <b>{Math.round(hud.fuelPct)}%</b></span><span>FLAPS <b>{hud.flapsIdx}/{hud.flapsDet}</b></span><span>TRIM <b>{Math.round(hud.trim * 100)}%</b></span><span data-active={hud.parking}>PARK BRAKE <b>{hud.parking ? 'SET' : 'OFF'}</b></span></div>}
  </section>;
}

export function Hud({ game, hud, toasts, settings, setSettings, onMap, mapOpen, mapViewRef, workspace, dispatchWorkspace, from, to, phase }: {
  game: Game; hud: HudState; toasts: Toast[]; settings: Settings; setSettings: (p: Partial<Settings>) => void;
  onMap: () => void; mapOpen: boolean; mapViewRef: RefObject<NavigationMapView | null>; workspace: FlightWorkspace; dispatchWorkspace: Dispatch<WorkspaceAction>; from: Airport; to: Airport; phase?: Phase;
}) {
  const tool = workspace.tool;
  const [mapFocus, setMapFocus] = useState<MapFocus>();
  const planScroll = useRef<number | null>(null);
  // A changed arrival invalidates an inspected fix from the previous approach.
  useEffect(() => { setMapFocus(undefined); planScroll.current = null; }, [hud.apprRwy]);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [toolbarPinned, setToolbarPinned] = useState(true);
  const [fullInstruments, setFullInstruments] = useState(false);
  const [radioNotice, setRadioNotice] = useState<number | null>(null);
  const toolbarTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toolbarHover = useRef(false);
  const revealRef = useRef<() => void>(() => {});
  const closeRef = useRef<() => void>(() => {});
  const toolRef = useRef(tool); toolRef.current = tool;
  const root = useRef<HTMLDivElement>(null);
  const viewport = useFlightViewport();
  const scale = flightUiScale(settings.uiScale, viewport.width, viewport.height);
  const { width, height } = viewport;
  const narrow = width < 800, short = (height < 540 || (viewport.touch && height < 620)) && width > height;
  const compactNav = short || (viewport.touch && height < 740);
  const visible = !mapOpen && (phase ?? hud.phase) === 'playing';
  const interior = ['cockpit', 'aisle', 'window'].includes(hud.view);
  const mode = settings.hudMode;
  const activeTool = TOOLS.find((t) => t.id === tool);
  const pendingRadio = hud.atcLog.some((m) => m.needsAck);
  const metric = settings.units === 'metric';
  const pfd = !interior && !viewport.touch && !narrow && !short && (width >= 940 || height >= 650) && (mode === 'assisted' || (mode === 'standard' && fullInstruments));
  const edgeInstruments = !interior && !viewport.touch && !narrow && !short && mode === 'standard' && !fullInstruments;
  const miniMap = !tool || (workspace.minimized && !compactNav);
  const telemetry = !edgeInstruments && mode !== 'cockpit' && (!interior || viewport.touch) && !compactNav;


  const reveal = () => {
    setToolbarVisible(true); clearTimeout(toolbarTimer.current);
    toolbarTimer.current = setTimeout(() => {
      if (!toolbarHover.current && !root.current?.querySelector('.flight-toolbar')?.contains(document.activeElement)) setToolbarVisible(false);
    }, 6500);
  };
  revealRef.current = reveal;
  const focusFlight = () => { game.clearInput(); requestAnimationFrame(() => game.canvas.focus({ preventScroll: true })); };
  const returnToFlight = () => { dispatchWorkspace({ type: 'close' }); focusFlight(); };
  closeRef.current = returnToFlight;

  useEffect(() => {
    if (!visible) return;
    revealRef.current();
    let nearTop = false;
    const pointer = (e: PointerEvent) => { const near = e.clientY < 85; if (near && !nearTop) revealRef.current(); nearTop = near; };
    window.addEventListener('pointermove', pointer, { passive: true });
    return () => { window.removeEventListener('pointermove', pointer); clearTimeout(toolbarTimer.current); };
  }, [visible]);

  useEffect(() => {
    game.radioMenuOpen = visible && tool === 'radio' && !workspace.minimized;
    return () => { game.radioMenuOpen = false; };
  }, [game, visible, tool, workspace.minimized]);

  useEffect(() => {
    if (!visible) return;
    const keydown = (e: KeyboardEvent) => {
      // Draft editors own their first Escape; committed choices and toggles must not trap it.
      if ((e.target instanceof HTMLInputElement && !['checkbox', 'radio', 'range'].includes(e.target.type)) || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape' && toolRef.current) { e.preventDefault(); e.stopImmediatePropagation(); closeRef.current(); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [visible]);

  useEffect(() => {
    if (!hud.atc || hud.atc.sender === 'PILOT') return;
    setRadioNotice(hud.atc.id);
    const timer = setTimeout(() => setRadioNotice(null), 11000);
    return () => clearTimeout(timer);
  }, [hud.atc?.id]);

  const toggleTool = (next: FlightTool) => {
    reveal();
    if (tool === next && !workspace.minimized) { returnToFlight(); return; }
    game.clearInput(); dispatchWorkspace({ type: 'toggle', tool: next });
  };
  const openNavigation = (tab: 'map' | 'plan') => { reveal(); game.clearInput(); dispatchWorkspace({ type: 'navigation', tab }); };
  const locate = (lat: number, lon: number, label: string) => { setMapFocus({ lat, lon, label, request: Date.now() }); openNavigation('map'); };
  let toolBody: ReactNode;
  switch (tool) {
    case 'autopilot': toolBody = <AutopilotPanel game={game} hud={hud} to={to} />; break;
    case 'radio': toolBody = <RadioPanel game={game} hud={hud} />; break;
    case 'camera': toolBody = <CameraPanel game={game} hud={hud} onDone={returnToFlight} />; break;
    case 'display': toolBody = <DisplayPanel settings={settings} setSettings={setSettings} fullInstruments={fullInstruments} setFullInstruments={setFullInstruments} />; break;
  }

  if (!visible) return null;
  return <div ref={root} className={`flight-shell ${settings.colorblind ? 'flight-high-contrast' : ''}`} data-narrow={narrow} data-short={short} data-tight={width < 1100} data-pfd={pfd} data-alert={hud.warn.length > 0}
    data-touch={viewport.touch} data-compact-nav={compactNav} data-mode={mode} data-interior={interior} data-edge={edgeInstruments} data-tool-open={!!tool} data-mini-map={miniMap}
    style={{ '--flight-text-scale': scale } as CSSProperties}>
    <div className="flight-screen-shade" />
    <header className="flight-header">
      <button className="flight-route-identity" aria-label="Open flight plan" onClick={() => openNavigation('plan')} data-flight-ui>
        <span className="flight-brand-symbol"><FlightIcon name="route" size={18} /></span><span><span className="flight-route-codes">{from.icao}<span>→</span>{to.icao}</span><span className="flight-aircraft-name" title={hud.activeWp?.name ?? hud.destId}>Next: {hud.activeWp?.name ?? hud.destId} · {formatDistance(hud.activeWp?.distNm ?? hud.distNm)} NM</span></span>
      </button>
      <div className="flight-header-status" data-flight-ui>{compactNav && mode !== 'cockpit' && <span className="flight-compact-air-data"><span>{formatSpeed(hud.kias, settings.units)}<small>{metric ? 'KM/H' : 'KT'}</small></span><span>{formatAltitude(hud.altFt, settings.units)}<small>{metric ? 'M' : 'FT'}</small></span></span>}<span className="flight-phase"><span className="flight-live-dot" />{FLIGHT_PHASE_LABELS[hud.flightPhase]}</span>
        <span className="flight-header-divider" /><IconButton icon={settings.muted ? 'muted' : 'volume'} label={settings.muted ? 'Unmute audio' : 'Mute audio'} onClick={() => setSettings({ muted: !settings.muted })} />
        <IconButton icon="pause" label="Pause flight (Esc)" onClick={() => game.pause()} />
      </div>
    </header>
    <div onPointerEnter={() => { toolbarHover.current = true; }} onPointerLeave={() => { toolbarHover.current = false; reveal(); }}>
      <FlightToolbar workspace={workspace} onTool={toggleTool} pendingRadio={pendingRadio} visible={toolbarVisible || toolbarPinned || !!tool} onReveal={reveal}
        pinned={toolbarPinned} onPin={() => { setToolbarPinned((value) => !value); reveal(); }} />
    </div>
    <FlightAlerts game={game} hud={hud} />
    {miniMap && <MiniMap game={game} hud={hud} from={from} to={to} settings={settings} viewStateRef={mapViewRef} onExpand={onMap} />}

    <div className="flight-tool-workspace">
      {activeTool && <section id={`flight-panel-${tool}`} className={`flight-panel flight-window ${tool === 'navigation' ? 'flight-navigation-panel' : 'flight-tool-panel'}`}
        aria-labelledby={`flight-tool-${tool}`} data-flight-ui data-minimized={workspace.minimized}>
        <PanelHeader id={`flight-tool-${tool}`} icon={activeTool.icon} title={activeTool.label} onClose={returnToFlight}
          onRestore={workspace.minimized ? () => dispatchWorkspace({ type: 'restore' }) : undefined}>
          <IconButton icon={workspace.minimized ? 'down' : 'minus'} label={workspace.minimized ? `Restore ${activeTool.label.toLowerCase()}` : `Minimize ${activeTool.label.toLowerCase()}`}
            onClick={() => { dispatchWorkspace({ type: 'minimize' }); focusFlight(); }} aria-expanded={!workspace.minimized} />
        </PanelHeader>
        {!workspace.minimized && <>
          {tool === 'navigation' ? <>
            <div className="flight-nav-tabs-row">
              <div className="flight-nav-tabs" role="tablist" aria-label="Navigation views" onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault(); e.stopPropagation();
                const tab = e.key === 'Home' ? 'map' : e.key === 'End' ? 'plan' : workspace.navigationTab === 'map' ? 'plan' : 'map';
                openNavigation(tab); e.currentTarget.querySelector<HTMLButtonElement>(`#flight-tab-${tab}`)?.focus();
              }}>
                <button id="flight-tab-map" role="tab" aria-selected={workspace.navigationTab === 'map'} aria-controls="flight-view-map" tabIndex={workspace.navigationTab === 'map' ? 0 : -1} onClick={() => openNavigation('map')}><FlightIcon name="map" size={14} />Map</button>
                <button id="flight-tab-plan" role="tab" aria-label="Flight plan" aria-selected={workspace.navigationTab === 'plan'} aria-controls="flight-view-plan" tabIndex={workspace.navigationTab === 'plan' ? 0 : -1} onClick={() => openNavigation('plan')}><FlightIcon name="route" size={14} /><span><span className="flight-tab-qualifier">Flight </span>plan</span></button>
              </div>
              <IconButton icon="expand" label="Expand navigation map (M)" onClick={onMap} />
            </div>
            {workspace.navigationTab === 'map' ? <div key="map" id="flight-view-map" className="flight-nav-content" role="tabpanel" aria-labelledby="flight-tab-map">
              <NavigationMap game={game} hud={hud} from={from} to={to} settings={settings} focusTarget={mapFocus} viewStateRef={mapViewRef} />
            </div> : <div key="plan" id="flight-view-plan" className="flight-tool-body flight-plan-content" role="tabpanel" aria-labelledby="flight-tab-plan"><FlightPlan hud={hud} from={from} to={to} onLocate={locate} selected={mapFocus?.label} scrollPosition={planScroll} /></div>}
          </> : <div className="flight-tool-body">{toolBody}</div>}
          <button aria-label="Return to flight" aria-keyshortcuts="Escape" className="flight-back-to-flight" onClick={returnToFlight}><FlightIcon name="plane" size={14} />Return to flight<kbd>Esc</kbd></button>
        </>}
      </section>}
    </div>
    {hud.freelookActive && <div className="flight-freelook-hint"><FlightIcon name="camera" size={14} />FREE LOOK<span>Release mouse to return to controls</span></div>}
    <div className="flight-bottom-left">
    {mode === 'assisted' && !narrow && !short && !viewport.touch && hud.hint && <div className="flight-instructor" role="status"><FlightIcon name="help" size={17} /><div><strong>FLIGHT ASSISTANT</strong><span>{hud.hint}</span></div></div>}
      {tool !== 'radio' && radioNotice === hud.atc?.id && <button className="flight-radio-notice" onClick={() => toggleTool('radio')} data-flight-ui>
        <FlightIcon name="radio" size={17} /><span><strong>{hud.atc?.sender}<span>{hud.atc?.needsAck ? 'RESPONSE REQUESTED' : 'RADIO TRANSMISSION'}</span></strong><span>{hud.atc?.text}</span></span><FlightIcon name="chevron" size={15} />
      </button>}
      <div className="flight-toasts" role="status" aria-live="polite">{toasts.slice(-2).map((toast) => <div key={toast.id} className="flight-toast" data-level={toast.level}>
        <FlightIcon name={toast.level === 'warn' || toast.level === 'bad' ? 'alert' : 'check'} size={14} /><span>{toast.text}</span>
      </div>)}</div>
    </div>
    {edgeInstruments && <FlightEdgeInstruments hud={hud} metric={metric} showHeading={!miniMap} />}
    {pfd && <div className="flight-instruments" data-flight-ui><PrimaryFlightDisplay hud={hud} metric={metric} assisted={mode === 'assisted'} /></div>}
    {telemetry && <CompactTelemetry hud={hud} metric={metric} minimal={mode === 'minimal'} />}
    <div className="flight-bottom-right"><span>{hud.ap.on ? `AUTOPILOT · ${hud.ap.appr ? 'APPR' : hud.ap.nav ? 'LNAV' : 'HDG'}` : 'MANUAL FLIGHT'}</span><span>{formatNumber(hud.timeScale, 1)}× SIM RATE</span></div>
    {hud.offline && <div className="flight-scenery-status"><span className="flight-status-dot" />Limited scenery<span className="flight-scenery-detail">Navigation available</span></div>}
    {hud.restartHold > 0 && <div className="flight-restart" role="status"><span>Restarting flight</span><div><span style={{ width: `${hud.restartHold * 100}%` }} /></div><small>Release R to cancel</small></div>}
    {viewport.touch && <TouchControls game={game} hud={hud} />}
  </div>;
}
