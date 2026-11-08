// Tiny observable store describing what the simulator is doing while a flight is being prepared.
//
// The loading screen (src/ui/Loaders.tsx) subscribes through useSyncExternalStore. The producers are
// `App.startFlight` (airfield survey), `Game.load` (scenery / flight deck / weather / terrain) and the
// flight-deck asset loader (byte progress of the 50 MB GLB). Snapshots are immutable and replaced on every
// change, which is what useSyncExternalStore requires; byte progress is throttled so React is never flooded.

export type LoadStage = 'idle' | 'dispatch' | 'scenery' | 'deck' | 'weather' | 'terrain' | 'done';

export interface LoadSnap {
  stage: LoadStage;
  /** Bytes of the flight-deck model received / expected (0 while unknown). */
  deckLoaded: number;
  deckTotal: number;
  /** The flight-deck model came out of the Cache Storage (no network). */
  deckCached: boolean;
  /** Set when the scenario could not be built; the loader then offers a way back. */
  error: string | null;
}

const IDLE: LoadSnap = { stage: 'idle', deckLoaded: 0, deckTotal: 0, deckCached: false, error: null };
let snap: LoadSnap = IDLE;
const subs = new Set<() => void>();
let lastBytesEmit = 0;

function emit(next: LoadSnap) { snap = next; subs.forEach((f) => f()); }

export const loadState = {
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  get(): LoadSnap { return snap; },
  /** A new launch starts: forget everything about the previous one. */
  begin(stage: LoadStage = 'dispatch') { lastBytesEmit = 0; emit({ ...IDLE, stage }); },
  stage(stage: LoadStage) { if (snap.stage !== stage || snap.error) emit({ ...snap, stage, error: null }); },
  fail(message: string) { emit({ ...snap, error: message }); },
  deckBytes(loaded: number, total: number, cached = false) {
    const now = performance.now();
    const final = total > 0 && loaded >= total;
    if (!final && now - lastBytesEmit < 90) return; // ≈ 11 Hz is plenty for a progress bar
    lastBytesEmit = now;
    emit({ ...snap, deckLoaded: loaded, deckTotal: total, deckCached: cached });
  },
};
