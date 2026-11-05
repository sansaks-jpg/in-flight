export type FlightPhase = 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'final' | 'rollout';

export interface FlightPhaseContext {
  fm?: {
    ias: number;
    agl: number;
    vs: number;
    wow: boolean;
    ctl: { throttle: number };
  } | null;
  spec: { cruiseAlt: number };
  landing?: object | null;
  takeoffDone: boolean;
  currentFlightPhase: FlightPhase;
  ap?: { appr?: boolean } | null;
  distToDest: () => number;
}

const M_PER_NM = 1852;

export function computeFlightPhaseState(ctx: FlightPhaseContext): FlightPhase {
  const fm = ctx.fm;
  if (!fm) return 'taxi';
  const kias = fm.ias / 0.514444;
  const aglFt = fm.agl / 0.3048;
  const vsFpm = fm.vs * 196.85;
  const remNm = ctx.distToDest() / M_PER_NM;
  const c = fm.ctl;
  const prev = ctx.currentFlightPhase;

  // 1. On ground logic
  if (fm.wow) {
    const rolloutThreshold = prev === 'rollout' ? 20 : 25;
    if (ctx.landing || (ctx.takeoffDone && kias > rolloutThreshold)) {
      return kias > rolloutThreshold ? 'rollout' : 'taxi';
    }
    if (prev === 'rollout') {
      return kias > 20 ? 'rollout' : 'taxi';
    }
    // Hysteresis prevents gusts around 18 kt from repeatedly reissuing taxi/takeoff calls.
    if (c.throttle > (prev === 'takeoff' ? 0.45 : 0.55) && kias > (prev === 'takeoff' ? 12 : 18)) {
      return 'takeoff';
    }
    return 'taxi';
  }

  // 2. In flight logic
  // Go-around: high throttle and positive rate of climb in landing/final
  if ((prev === 'final' || prev === 'rollout') && c.throttle > 0.75 && vsFpm > 250) {
    return 'climb';
  }

  // Final Approach: close to runway with landing geometry, or flagged landing
  if (vsFpm < (prev === 'climb' ? 100 : 250) && (ctx.landing || (remNm <= 5.5 && aglFt < 2200) || (aglFt < 850 && remNm <= 9))) {
    return 'final';
  }

  // Takeoff roll transition to climb upon becoming airborne
  if (prev === 'takeoff' || prev === 'taxi') {
    return 'climb';
  }

  // Climb phase: maintain climb until reaching safe altitude and level-off, or reaching cruise
  if (prev === 'climb') {
    // A genuine positive climb (especially a go-around) is not a new landing clearance.
    // Use a lower hold threshold than descent's 500 fpm climb-entry threshold.
    if (vsFpm > 350) return 'climb';
    const cruiseAltFt = ctx.spec.cruiseAlt / 0.3048;
    const reachedCruise = aglFt > cruiseAltFt * 0.85 || (aglFt > 2000 && vsFpm < 150);
    if (reachedCruise && remNm > 15) {
      return 'cruise';
    }
    if (reachedCruise && remNm <= 15) {
      return 'descent';
    }
    return 'climb';
  }

  // Descent phase: approaching destination or actively descending towards airport
  const descentGateNm = Math.max(12, Math.min(45, (aglFt / 1000) * 3 + 6));
  if (ctx.ap?.appr || (remNm <= descentGateNm && (vsFpm < -250 || remNm <= 14))) {
    return 'descent';
  }

  if (prev === 'descent') {
    if (vsFpm > 500 && aglFt > 4000) {
      return 'climb';
    }
    return 'descent';
  }

  return 'cruise';
}
