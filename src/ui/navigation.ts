import type { FlightPhase, HudState } from '../sim/game';
import type { HudMode } from '../sim/storage';
import { clamp, wrap180 } from '../sim/geo';

/** One mode order for the keyboard, gamepad, and display menu. */
export const HUD_MODES: HudMode[] = ['standard', 'minimal', 'assisted', 'cockpit'];
export const HUD_MODE_LABELS: Record<HudMode, string> = { standard: 'Standard', minimal: 'Minimal', assisted: 'Assisted', cockpit: 'Cockpit' };
export const FLIGHT_PHASE_LABELS: Record<FlightPhase, string> = {
  taxi: 'Taxi', takeoff: 'Takeoff', climb: 'Climb', cruise: 'En route',
  descent: 'Descent', final: 'Final approach', rollout: 'Rollout',
};

export function nextHudMode(current: HudMode): HudMode {
  return HUD_MODES[(HUD_MODES.indexOf(current) + 1) % HUD_MODES.length];
}

/** Display-only conversions; the native flight-model units are unchanged. */
export type FlightUnits = 'aviation' | 'metric';
const AVIATION = { speed: 'KT', altitude: 'FT', verticalSpeed: 'FPM' } as const;
const METRIC = { speed: 'KM/H', altitude: 'M', verticalSpeed: 'M/S' } as const;
export const flightUnits = (units: FlightUnits = 'aviation') => units === 'metric' ? METRIC : AVIATION;
export const speedValue = (knots: number, units: FlightUnits = 'aviation') => knots * (units === 'metric' ? 1.852 : 1);
export const altitudeValue = (feet: number, units: FlightUnits = 'aviation') => feet * (units === 'metric' ? .3048 : 1);
export const verticalSpeedValue = (fpm: number, units: FlightUnits = 'aviation') => fpm * (units === 'metric' ? .00508 : 1);

/** No NaN, negative zero, unbounded precision or locale-dependent decimal separators. */
export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
export const formatSpeed = (knots: number, units: FlightUnits = 'aviation') => formatNumber(speedValue(knots, units));
export const formatAltitude = (feet: number, units: FlightUnits = 'aviation') => formatNumber(altitudeValue(feet, units));
export function formatVerticalSpeed(fpm: number, units: FlightUnits = 'aviation'): string {
  const value = units === 'metric' ? Number((fpm * .00508).toFixed(1)) : Math.round(fpm / 50) * 50;
  return `${value > 0 ? '+' : ''}${formatNumber(value, units === 'metric' ? 1 : 0)}`;
}

/** Rounding must wrap 359.9 back to true north, not display 360. */
export function formatHeading(value: number): string {
  return Number.isFinite(value) ? String(((Math.round(value) % 360) + 360) % 360).padStart(3, '0') + '°' : '---°';
}
export function formatDistance(nm: number): string {
  return Number.isFinite(nm) && nm >= 0 ? nm.toFixed(nm < 100 ? 1 : 0) : '—';
}
export function formatEte(minutes: number, moving = true): string {
  if (!moving || !Number.isFinite(minutes) || minutes < 0 || minutes >= 6000) return '--:--';
  const total = Math.floor(minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}


export function navigationCue(hud: Pick<HudState, 'activeWp' | 'brg' | 'hdg' | 'track' | 'gsKt' | 'onGround' | 'depRwy' | 'parking'>) {
  const bearing = hud.activeWp?.brg ?? hud.brg;
  const course = hud.gsKt > 5 ? hud.track : hud.hdg;
  const delta = wrap180(bearing - course);
  if (hud.onGround) return {
    delta: 0, direction: 'straight' as const,
    text: hud.parking ? 'Release parking brake to taxi' : `Follow runway ${hud.depRwy || 'centerline'}`,
  };
  return {
    delta,
    direction: Math.abs(delta) <= 5 ? 'straight' as const : delta > 0 ? 'right' as const : 'left' as const,
    text: Math.abs(delta) <= 5 ? 'On course' : `Turn ${delta > 0 ? 'right' : 'left'} ${Math.abs(Math.round(delta))}°`,
  };
}

export function primaryAlert(warnings: HudState['warn']) {
  return warnings.find((w) => !w.acked && w.level === 'warning')
    ?? warnings.find((w) => !w.acked)
    ?? warnings.find((w) => w.level === 'warning')
    ?? warnings[0];
}

/** Scale type, never the entire flight workspace. Maps and hit targets retain their proportions. */
export function flightUiScale(preferred: number, width: number, height: number): number {
  // Narrow/short screens have less line length, not a miniature virtual desktop.
  const maximum = width < 600 || height < 400 ? 1.25 : 1.5;
  return clamp(Number.isFinite(preferred) ? preferred : 1, .9, maximum);
}

