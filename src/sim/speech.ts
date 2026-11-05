export type SpeechKind = 'warning' | 'callout' | 'announcement';
export interface SpeechRequest {
  text: string; key: string; cooldown: number; rate: number; pitch: number; volume: number; kind: SpeechKind;
}
export interface SpeechDriver {
  speak: (request: SpeechRequest, finished: () => void) => void;
  cancel: () => void;
}
interface QueuedSpeech { request: SpeechRequest; expires: number }
const priority = (kind: SpeechKind) => kind === 'warning' ? 2 : kind === 'callout' ? 1 : 0;

/** Own the queue instead of filling the browser's unbounded, uninspectable speech queue. */
export class SpeechQueue {
  private pending: QueuedSpeech[] = [];
  private active: SpeechRequest | null = null;
  private lastSpoken = new Map<string, number>();
  private generation = 0;
  private warningKey: string | null = null;
  constructor(private driver: SpeechDriver, private now = () => performance.now() / 1000, private capacity = 4) {}

  canRequest(key: string, cooldown: number): boolean {
    if (this.active?.key === key || this.now() - (this.lastSpoken.get(key) ?? -Infinity) < cooldown) return false;
    for (let i = 0; i < this.pending.length; i++) if (this.pending[i].request.key === key) return false;
    return true;
  }

  request(request: SpeechRequest): boolean {
    if (!this.canRequest(request.key, request.cooldown)) return false;
    const now = this.now();
    // An old altitude callout must not play after a newer threshold has been crossed.
    if (request.kind === 'callout') this.removePending('callout');
    this.prune(now);
    if (this.pending.length >= this.capacity) {
      const index = this.pending.findIndex((item) => priority(item.request.kind) <= priority(request.kind));
      if (index < 0) return false;
      this.pending.splice(index, 1);
    }
    this.pending.push({ request, expires: now + (request.kind === 'announcement' ? 20 : 3) });
    // Safety speech can interrupt a long cabin announcement, but never another active callout.
    if (request.kind === 'warning' && this.active?.kind === 'announcement') this.stopActive();
    this.pump();
    return true;
  }

  /** Stop obsolete warnings as soon as the actual flight-model condition clears/changes. */
  retainWarning(key: string | null) {
    if (this.warningKey === key) return;
    this.warningKey = key;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const request = this.pending[i].request;
      if (request.kind === 'warning' && request.key !== key) this.pending.splice(i, 1);
    }
    if (this.active?.kind === 'warning' && this.active.key !== key) this.stopActive();
    this.pump();
  }

  clear() {
    this.pending.length = 0; this.warningKey = null;
    this.stopActive(); this.lastSpoken.clear();
  }

  private removePending(kind: SpeechKind) {
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].request.kind === kind) this.pending.splice(i, 1);
  }
  private prune(now: number) {
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].expires < now) this.pending.splice(i, 1);
  }
  private stopActive() {
    this.generation++;
    if (this.active) this.lastSpoken.set(this.active.key, this.now());
    this.active = null;
    this.driver.cancel();
  }
  private pump() {
    if (this.active) return;
    this.prune(this.now());
    if (!this.pending.length) return;
    this.pending.sort((a, b) => priority(b.request.kind) - priority(a.request.kind));
    const request = this.pending.shift()!.request, generation = ++this.generation;
    this.active = request;
    this.lastSpoken.set(request.key, this.now());
    const finished = () => {
      if (generation !== this.generation || this.active !== request) return;
      this.lastSpoken.set(request.key, this.now());
      this.active = null;
      this.pump();
    };
    try { this.driver.speak(request, finished); } catch { finished(); }
  }
}
