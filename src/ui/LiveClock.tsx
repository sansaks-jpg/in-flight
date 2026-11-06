import { useEffect, useState } from 'react';
import { SUN_PHASE_LABEL, SunPhase, formatLocal, formatUtc, formatUtcDate, localLabel, simNowMs, sunPhase, sunPosition } from '../sim/clock';

/** Real-world UTC instant, re-read from the system clock every second. Identical to what the simulator uses. */
export function useUtcNow(intervalMs = 1000): number {
  const [now, setNow] = useState(simNowMs);
  useEffect(() => {
    setNow(simNowMs());
    const id = window.setInterval(() => setNow(simNowMs()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Sun elevation + light condition at a location for the current real-world instant. */
export function useSun(lat: number, lon: number, intervalMs = 15000) {
  const now = useUtcNow(intervalMs);
  const sp = sunPosition(now, lat, lon);
  const phase: SunPhase = sunPhase(sp.elevation);
  return { elevation: sp.elevation, azimuth: sp.azimuth, phase, label: SUN_PHASE_LABEL[phase] };
}

/** Compact "UTC · local · light condition" readout used by the planner and flight windows. */
export function ClockReadout({ lat, lon, className = '' }: { lat: number; lon: number; className?: string }) {
  const now = useUtcNow();
  const sun = useSun(lat, lon);
  return (
    <div className={className}>
      <div className="font-mono text-[15px] font-black text-white tabular-nums">{formatUtc(now)} <span className="text-[10px] text-sky-300">UTC</span></div>
      <div className="text-[10px] text-slate-300 font-mono">{formatUtcDate(now)} · {formatLocal(now, lon)} {localLabel(lon)}</div>
      <div className="text-[10px] text-slate-400">{sun.label} · sun {sun.elevation >= 0 ? '+' : ''}{sun.elevation.toFixed(1)}°</div>
    </div>
  );
}
