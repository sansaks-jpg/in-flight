import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Airport } from '../data/airports';
import type { Game, HudState } from '../sim/game';
import type { Settings } from '../sim/storage';
import { TILE_STYLES } from '../sim/tiles';
import { FlightIcon } from './FlightIcon';
import { Readout, RunwaySelect } from './FlightWidgets';
import { MapPanel, type NavigationMapView } from './MapPanel';
import { loadMapLayers, type MapLayers } from './mapLayers';
import { formatDistance, formatEte, formatHeading, navigationCue } from './navigation';

export interface MapFocus { lat: number; lon: number; request: number; label?: string }
interface MapProps {
  game: Game; hud: HudState; from: Airport; to: Airport; settings: Settings;
  setSettings: (p: Partial<Settings>) => void;
}

export function NextWaypoint({ hud }: { hud: HudState }) {
  const wp = hud.activeWp;
  const cue = navigationCue(hud);
  return <div className="flight-next-waypoint">
    <div className="flight-next-title"><span className="flight-waypoint-diamond" /><span className="flight-eyebrow">{wp ? 'Next waypoint' : 'Destination'}</span>
      <span className="flight-leg-number">{hud.flightPlan.length ? `${Math.min(hud.activeWpIdx + 1, hud.flightPlan.length)} / ${hud.flightPlan.length}` : 'DIRECT'}</span>
    </div>
    <div className="flight-next-name">{wp?.name ?? hud.destId}<span>{!hud.ap.on ? 'MANUAL' : hud.ap.appr ? 'APPR' : hud.ap.nav ? 'LNAV' : 'HDG'}</span></div>
    <div className="flight-nav-readouts">
      <Readout label="Distance" value={formatDistance(wp?.distNm ?? hud.distNm)} unit="NM" />
      <Readout label="Bearing · true" value={formatHeading(wp?.brg ?? hud.brg)} />
      <Readout label="ETE · hh:mm" value={formatEte(wp?.etaMin ?? hud.eteMin, hud.gsKt > 5)} />
    </div>
    <div className="flight-course-cue"><FlightIcon size={14} name={cue.direction === 'straight' ? 'arrow' : cue.direction === 'right' ? 'turnRight' : 'turnLeft'} />
      <span>{hud.ap.on && hud.ap.nav && !hud.onGround ? (cue.direction === 'straight' ? 'Tracking active leg' : `Course ${cue.direction} ${Math.abs(Math.round(cue.delta))}°`) : cue.text}</span><span className="flight-course-track">TRK {formatHeading(hud.track)}</span>
    </div>
  </div>;
}

export function NavigationMap({ game, hud, from, to, settings, focusTarget, viewStateRef }:
  Omit<MapProps, 'setSettings'> & { focusTarget?: MapFocus; viewStateRef: RefObject<NavigationMapView | null> }) {
  const wp = hud.activeWp;
  const cue = navigationCue(hud);
  const guidance = hud.ap.on && hud.ap.nav && !hud.onGround
    ? (cue.direction === 'straight' ? 'Tracking active leg' : `Course ${cue.direction} ${Math.abs(Math.round(cue.delta))}°`) : cue.text;
  return <>
      <div className="flight-nav-brief">
        <div className="flight-nav-fix"><span className="flight-waypoint-diamond" /><strong title={wp?.name ?? hud.destId}>{wp?.name ?? hud.destId}</strong>
          <span className="flight-nav-mode">{!hud.ap.on ? 'MANUAL' : hud.ap.appr ? 'APPR' : hud.ap.nav ? 'LNAV' : 'HDG'}</span></div>
        <div className="flight-nav-brief-readouts"><Readout label="DIST · NM" value={formatDistance(wp?.distNm ?? hud.distNm)} />
          <Readout label="BRG · °T" value={formatHeading(wp?.brg ?? hud.brg)} />
          <Readout label="ETE" title="Estimated time en route · hours:minutes" value={formatEte(wp?.etaMin ?? hud.eteMin, hud.gsKt > 5)} /></div>
      </div>
      <div className="flight-navigation-chart"><MapPanel mode="flight" game={game} from={from} to={to}
        styleId={settings.mapStyle} onStyle={() => {}} navigation focusTarget={focusTarget} viewStateRef={viewStateRef} className="absolute inset-0" /></div>
      <footer className="flight-navigation-footer"><span className="flight-nav-guidance" title={guidance}><FlightIcon size={12} name={cue.direction === 'straight' ? 'arrow' : cue.direction === 'right' ? 'turnRight' : 'turnLeft'} /><span>{guidance}</span></span>
        <span>GS <b>{Math.round(hud.gsKt)}</b> KT</span><span title="Wind from true north"><FlightIcon name="wind" size={13} />{hud.wind.kt < .5 ? 'CALM' : `${formatHeading(hud.wind.dir)} / ${Math.round(hud.wind.kt)} KT`}</span>
      </footer>
  </>;
}

/** The small chart and full-screen chart share their view, so expanding never resets navigation. */
export function MiniMap({ game, hud, from, to, settings, viewStateRef, onExpand }:
  Omit<MapProps, 'setSettings'> & { viewStateRef: RefObject<NavigationMapView | null>; onExpand: () => void }) {
  return <section className="flight-mini-map" aria-label="Navigation mini map" data-flight-ui>
    <header><span title="Aircraft heading · magnetic">HDG <b>{formatHeading(hud.hdg)}</b></span>
      <span title="Ground track from the flight model">TRK <b>{formatHeading(hud.track)}</b></span><kbd>M</kbd></header>
    <div className="flight-mini-chart"><MapPanel mode="flight" game={game} from={from} to={to} styleId={settings.mapStyle} onStyle={() => {}}
      navigation compact onExpand={onExpand} viewStateRef={viewStateRef} className="absolute inset-0" /></div>
    <footer><span title={hud.activeWp?.name ?? hud.destId}>{hud.activeWp?.name ?? hud.destId}</span><b>{formatDistance(hud.activeWp?.distNm ?? hud.distNm)} NM</b></footer>
  </section>;
}

export function FullMap({ game, hud, from, to, settings, setSettings, viewStateRef, onClose }:
  MapProps & { viewStateRef: RefObject<NavigationMapView | null>; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [layers, setLayers] = useState<MapLayers>(loadMapLayers);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;

  useEffect(() => {
    game.clearInput(); game.mapOnly = true;
    const previousVisibility = game.canvas.style.visibility;
    // Do not composite a hidden WebGL texture underneath the opaque map (particularly on mobile).
    game.canvas.style.visibility = 'hidden';
    root.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) onCloseRef.current();
        return;
      }
      // The map owns keyboard input while open; hidden radio/throttle/camera controls must not fire.
      e.stopImmediatePropagation();
      if (e.key === 'Tab') {
        const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])]
          .filter((element) => element.getClientRects().length > 0);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      game.mapOnly = false; game.canvas.style.visibility = previousVisibility;
      window.removeEventListener('keydown', keydown, true);
      // Returning from a map should restore aircraft input, not trap arrow keys in a toolbar.
      requestAnimationFrame(() => { if (document.querySelector('.flight-full-map')) return; game.clearInput(); game.canvas.focus({ preventScroll: true }); });
    };
  }, [game]);

  return <div ref={root} className={`flight-full-map ${settings.colorblind ? 'flight-high-contrast' : ''}`} role="dialog" aria-modal="true"
    aria-labelledby="full-map-title" data-flight-ui onPointerDown={(e) => e.stopPropagation()}>
    <h1 id="full-map-title" className="sr-only">Full-screen navigation map</h1>
    <div className="flight-full-chart"><MapPanel mode="flight" game={game} from={from} to={to} styleId={settings.mapStyle}
      onStyle={(id) => setSettings({ mapStyle: id })} navigation layers={layers} viewStateRef={viewStateRef} className="absolute inset-0" /></div>
    <button aria-label="Return to flight" aria-keyshortcuts="M Escape" className="flight-return-button" data-autofocus onClick={onClose}>
      <FlightIcon name="close" size={17} /><span>Return to flight</span><kbd>M</kbd>
    </button>
    <details className="flight-map-options">
      <summary><FlightIcon name="layers" size={15} />Map options<FlightIcon name="up" size={13} /></summary>
      <div className="flight-map-options-body">
        <label className="flight-map-style">Map style<select aria-label="Map style" value={settings.mapStyle} onChange={(e) => setSettings({ mapStyle: e.target.value })}>
          {TILE_STYLES.filter((s) => s.id !== 'sat').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <fieldset className="flight-map-layers"><legend>Map layers</legend>
          {([['route', 'Route & trail'], ['airports', 'Airports'], ['labels', 'Place labels'], ['terrain', 'Terrain relief'], ['roads', 'Roads & rail']] as const).map(([key, label]) => <label key={key}>
            <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers((current) => ({ ...current, [key]: e.target.checked }))} />{label}
          </label>)}
        </fieldset>
        <RunwaySelect airport={to} value={hud.apprRwy} onChange={(ident) => game.setArrRunway(ident)} />
      </div>
    </details>
  </div>;
}
