import type { HudState } from '../sim/game';
import { clamp } from '../sim/geo';
import { formatHeading } from './navigation';

function RoundGauge({ label, unit, value, display, max, step }: { label: string; unit: string; value: number; display: string; max: number; step: number }) {
  const ticks = Array.from({ length: 61 }, (_, index) => index);
  return <div className="flight-edge-dial"><span className="flight-edge-dial-title">{label}</span><svg viewBox="0 0 128 128" aria-label={`${label} ${display} ${unit}`} role="img">
    <circle cx="64" cy="64" r="61" fill="#6c877d26" stroke="#eef3e68c" strokeWidth="1" />
    {ticks.map((index) => <path key={index} d={`M64 5V${index % 5 ? 9 : 13}`} stroke="#f3f5e7" strokeWidth={index % 5 ? 1 : 2} transform={`rotate(${index * 6} 64 64)`} />)}
    {Array.from({ length: Math.ceil(max / step) }, (_, index) => {
      const angle = index * step / max * Math.PI * 2;
      return <text key={index} x={64 + Math.sin(angle) * 44} y={67 - Math.cos(angle) * 44} textAnchor="middle" fill="#f4f5e8" fontSize="10" fontWeight="600">{index * step}</text>;
    })}
    <text x="64" y="43" textAnchor="middle" fill="#f4f5e8" fontSize="9" fontWeight="600">{unit}</text>
    <path d="M64 74V17M61 24L64 15L67 24" fill="none" stroke="#f4f5e8" strokeWidth="3" strokeLinecap="round" transform={`rotate(${clamp(value / max, 0, 1) * 360} 64 64)`} />
    <circle cx="64" cy="64" r="5" fill="#f5f5e7" />
  </svg><b className="flight-edge-dial-value">{display}</b></div>;
}
function BarGauge({ label, value, display, unit, bipolar = false }: { label: string; value: number; display: string; unit?: string; bipolar?: boolean }) {
  const fill = clamp(bipolar ? .5 + value * .5 : value, 0, 1);
  return <div className="flight-edge-bar"><span>{label}</span><div className="flight-edge-bar-track"><i style={{ height: `${fill * 100}%` }} /><b style={{ bottom: `${fill * 100}%` }} /></div><strong>{display}</strong>{unit && <small>{unit}</small>}</div>;
}
export function HeadingCompass({ hud }: { hud: HudState }) {
  return <div className="flight-heading-compass" aria-label="Heading compass"><span>HDG <b>{formatHeading(hud.hdg)}</b></span><span>TRK <b>{formatHeading(hud.track)}</b></span></div>;
}
/** Standard external-view instruments. All readings come from the live flight-model HUD snapshot. */
export function FlightEdgeInstruments({ hud, metric, showHeading = true }: { hud: HudState; metric: boolean; showHeading?: boolean }) {
  const speed = hud.kias * (metric ? 1.852 : 1), altitude = hud.altFt * (metric ? .3048 : 1);
  return <div className="flight-edge-instruments" data-flight-ui>
    {showHeading && <HeadingCompass hud={hud} />}
    <div className="flight-edge-left">
      <RoundGauge label="AIRSPEED" unit={metric ? 'KM/H' : 'KTS'} value={speed} display={String(Math.round(speed))} max={metric ? 660 : 330} step={metric ? 60 : 30} />
      <div className="flight-edge-bars"><BarGauge label="ENGINE" value={hud.n1} display={`${Math.round(hud.n1 * 100)}%`} /><BarGauge label="FUEL" value={hud.fuelPct / 100} display={`${Math.round(hud.fuelPct)}%`} /><BarGauge label="AOA" value={hud.alphaFrac} display={`${Math.round(hud.alphaFrac * 100)}%`} /></div>
    </div>
    <div className="flight-edge-right"><div className="flight-edge-bars"><BarGauge label="FLAPS" value={hud.flapsIdx / Math.max(1, hud.flapsDet)} display={`${hud.flapsIdx}/${hud.flapsDet}`} /><BarGauge label="TRIM" value={hud.trim} display={`${Math.round(hud.trim * 100)}%`} bipolar /><BarGauge label="V. SPEED" value={hud.vsFpm / 2000} display={metric ? (hud.vsFpm * .00508).toFixed(1) : String(Math.round(hud.vsFpm))} unit={metric ? 'M/S' : 'FPM'} bipolar /></div>
      <RoundGauge label="ALTITUDE" unit={metric ? 'METERS' : 'FEET'} value={((altitude % 1000) + 1000) % 1000} display={Math.round(altitude).toLocaleString('en-US')} max={1000} step={100} />
    </div>
  </div>;
}
