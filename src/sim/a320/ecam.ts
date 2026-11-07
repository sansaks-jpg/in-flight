// A320 ECAM control panel (ECP) logic - pure state machine, no rendering and no three.js, so the behaviour is easy to reason about.
// Behaviour follows the A320 FCOM DSC-31-30 "ECAM Controls":
//  * system page pb (ENG ... F/CTL): shows the page on the SD and lights white; pushing the lit key again returns to the automatic page.
//    A failure-related page replaces a manually selected one.
//  * ALL: pressed and held, the SD steps through every system page (1 s per page); releasing keeps the page that is shown.
//  * STS: STATUS page, lit while shown; an empty status shows NORMAL for 3 s; pushing STS again or CLR removes the page.
//  * CLR (x2): lit while the E/WD shows a warning / caution or the SD shows STATUS; each push clears the first message.
//  * RCL: recalls messages cleared with CLR (still active) or shows NORMAL for 3 s; held > 3 s it also recalls EMER CANC'd cautions.
//  * EMER CANC: warning -> aural + MASTER WARN cancelled (message stays); caution -> cancelled for the rest of the flight, STATUS page
//    shows CANCELLED CAUTION.
//  * T.O CONFIG: simulates take-off power; E/WD shows the CONFIG warnings or "T.O CONFIG NORMAL" in the T.O MEMO.
import type { EcamPage } from './systems';

/** Pages stepped through by the ALL key (the twelve SD system pages, CRUISE last). */
export const ALL_PAGES: EcamPage[] = ['ENG', 'BLEED', 'PRESS', 'ELEC', 'HYD', 'FUEL', 'APU', 'COND', 'DOOR', 'WHEEL', 'F/CTL', 'CRZ'];
/** ECP control id -> SD page it selects. */
export const PAGE_KEYS: Record<string, EcamPage> = {
  ecam_eng: 'ENG', ecam_bleed: 'BLEED', ecam_press: 'PRESS', ecam_elec: 'ELEC', ecam_hyd: 'HYD', ecam_fuel: 'FUEL',
  ecam_apu: 'APU', ecam_cond: 'COND', ecam_door: 'DOOR', ecam_wheel: 'WHEEL', ecam_fctl: 'F/CTL', ecam_sts: 'STS',
};
export const ALL_STEP_S = 1;      // FCOM: successive pages at 1 s intervals while ALL is held
export const RCL_HOLD_S = 3;      // RCL held longer than 3 s also recalls EMER CANC'd cautions
export const NORMAL_MSG_S = 3;    // "NORMAL" message duration
export const TO_CONFIG_S = 120;   // how long the T.O CONFIG test result stays on the E/WD

export type EwdColour = 'red' | 'amber' | 'green' | 'cyan' | 'white';
export interface EwdLine { t: string; c: EwdColour; }
export interface EcamAlert { text: string; red: boolean; }

/** Inputs sampled from the aircraft every frame (see A320Systems.update). */
export interface EcamEnv {
  warns: string[];               // active alert texts (from the warning computer)
  toCfgIssues: string[];         // CONFIG problems if take-off power were applied now
  wow: boolean; anyEngine: boolean;
  autoPage: EcamPage;            // flight-phase page
  /** Cancels the aural alert / MASTER lights in the game's warning system. */
  ackAural(): void;
  toast(msg: string): void;
}
/** MASTER WARN / MASTER CAUT flags live on the systems object. */
export interface MasterFlags { masterWarn: boolean; masterCaut: boolean; }

const RED = /STALL|FIRE|OVERSPEED|PULL UP|SINK|TERRAIN|TOO LOW|CONFIG|PARK BRAKE|FLAMEOUT/i;
/** Which SD page a failure shows automatically. */
export function alertPage(text: string): EcamPage | null {
  const t = text.toUpperCase();
  if (/ENG|FIRE|FLAMEOUT/.test(t)) return 'ENG';
  if (/GEAR|L\/G|WHEEL|BRAKE|SINK/.test(t)) return 'WHEEL';
  if (/FLAP|SPD BRK|SPLR|STALL|CONFIG|SLAT/.test(t)) return 'F/CTL';
  if (/HYD/.test(t)) return 'HYD';
  if (/FUEL/.test(t)) return 'FUEL';
  if (/ELEC|GEN|BAT/.test(t)) return 'ELEC';
  if (/BLEED|PACK|PRESS|CAB/.test(t)) return 'PRESS';
  if (/APU/.test(t)) return 'APU';
  return null;
}

export class Ecam {
  /** Page selected with an ECP key (null = automatic). 'STS' is the STATUS page. */
  manual: EcamPage | null = null;
  cleared = new Set<string>();      // messages removed with CLR (return with RCL)
  cancelled = new Set<string>();    // cautions cancelled with EMER CANC (return with RCL > 3 s)
  auralCancelled = new Set<string>();
  /** Seconds of simulated time (own clock - keeps this module independent of the game's clock). */
  now = 0;
  normalUntil = 0;                  // E/WD "NORMAL" message (RCL with nothing to recall)
  stsExitAt = 0;                    // STATUS page auto-exit (empty status shows NORMAL for 3 s)
  toCfg: { since: number } | null = null;
  inhibitSuppressed = false;        // RCL > 3 s
  held: string | null = null; heldT = 0; private rclLongDone = false; private allT = 0;
  private env: EcamEnv = { warns: [], toCfgIssues: [], wow: true, anyEngine: false, autoPage: 'DOOR', ackAural() { /* none */ }, toast() { /* none */ } };
  private lastSig = '';
  constructor(private flags: MasterFlags) {}

  // ------------------------------------------------------------------ derived state
  /** Alerts currently displayed on the E/WD (not cleared with CLR, cautions not cancelled with EMER CANC). */
  get alerts(): EcamAlert[] {
    const out: EcamAlert[] = [];
    for (const w of this.env.warns) { if (this.cleared.has(w) || this.cancelled.has(w)) continue; out.push({ text: w, red: RED.test(w) }); }
    return out;
  }
  get toCfgIssues(): string[] { return this.toCfg ? this.env.toCfgIssues : []; }
  /** Things the STATUS page lists. */
  get statusItems(): string[] { return [...this.cancelled]; }
  get statusPending(): boolean { return this.cancelled.size > 0; }
  /** Page the SD displays: ECP selection, else the page of an active failure, else the flight-phase page. */
  shownPage(auto: EcamPage = this.env.autoPage): EcamPage {
    if (this.manual) return this.manual;
    for (const a of this.alerts) { const p = alertPage(a.text); if (p) return p; }
    return auto;
  }
  /** Lamp states of the ECP keys (white bar in the key). */
  lit(id: string): boolean {
    const shown = this.shownPage();
    if (id in PAGE_KEYS) return PAGE_KEYS[id] === shown;
    if (id === 'ecam_clr_l' || id === 'ecam_clr_r') return this.alerts.length > 0 || this.manual === 'STS' || this.toCfgIssues.length > 0;
    if (id === 'ecam_emer_canc') return this.cancelled.size > 0 || this.auralCancelled.size > 0;
    return false;
  }
  /** E/WD message area, top to bottom (memo lines are added by the renderer when this is empty). */
  ewdLines(): EwdLine[] {
    const l: EwdLine[] = [];
    for (const a of this.alerts) l.push({ t: a.text.toUpperCase().slice(0, 34), c: a.red ? 'red' : 'amber' });
    for (const i of this.toCfgIssues) l.push({ t: ('CONFIG ' + i).slice(0, 34), c: 'red' });
    if (this.now < this.normalUntil) l.push({ t: 'NORMAL', c: 'green' });
    return l;
  }
  /** Green "T.O CONFIG NORMAL" line of the T.O MEMO. */
  get toConfigNormal(): boolean { return !!this.toCfg && this.env.toCfgIssues.length === 0; }

  // ------------------------------------------------------------------ per-frame
  update(dt: number, env: EcamEnv) {
    this.env = env; this.now += dt;
    const live = new Set(env.warns);
    // CLR / aural cancel end with the failure; EMER CANC'd cautions stay cancelled for the rest of the flight (only RCL > 3 s restores them)
    for (const s of [this.cleared, this.auralCancelled]) for (const w of [...s]) if (!live.has(w)) s.delete(w);
    // a NEW failure replaces a manually selected page and re-arms the master lights
    const sig = env.warns.join('|'); if (sig !== this.lastSig) { if (env.warns.some((w) => !this.lastSig.split('|').includes(w) && !this.cancelled.has(w) && !this.cleared.has(w))) this.manual = null; this.lastSig = sig; }
    if (this.manual === 'STS' && this.stsExitAt && this.now >= this.stsExitAt) { this.manual = null; this.stsExitAt = 0; }
    if (this.toCfg && (!env.wow || this.now - this.toCfg.since > TO_CONFIG_S)) this.toCfg = null;
    // held keys
    if (this.held) {
      this.heldT += dt;
      if (this.held === 'ecam_all') { this.allT += dt; while (this.allT >= ALL_STEP_S) { this.allT -= ALL_STEP_S; this.stepAll(); } }
      if (this.held === 'ecam_rcl' && !this.rclLongDone && this.heldT >= RCL_HOLD_S) { this.rclLongDone = true; this.recallCancelled(); }
    }
  }

  // ------------------------------------------------------------------ key actions
  down(id: string) {
    this.held = id; this.heldT = 0; this.allT = 0; this.rclLongDone = false;
    if (id in PAGE_KEYS) return this.pageKey(PAGE_KEYS[id]);
    switch (id) {
      case 'ecam_all': this.stepAll(); break;
      case 'ecam_clr_l': case 'ecam_clr_r': this.clr(); break;
      case 'ecam_rcl': this.rcl(); break;
      case 'ecam_emer_canc': this.emerCanc(); break;
      case 'ecam_to_config': this.toConfig(); break;
    }
  }
  up(id: string) { if (this.held === id) this.held = null; }

  /** MASTER WARN pressed: lights out and the aural alert of every displayed red warning is cancelled (the messages stay). */
  acknowledgeMaster() { for (const a of this.alerts) if (a.red) this.auralCancelled.add(a.text); this.flags.masterWarn = false; this.env.ackAural(); }

  private pageKey(p: EcamPage) {
    if (this.manual === p) { this.manual = null; this.stsExitAt = 0; return; }   // second push: back to the automatic page
    this.manual = p; this.stsExitAt = 0;
    if (p === 'STS' && !this.statusPending && this.alerts.length === 0) this.stsExitAt = this.now + NORMAL_MSG_S; // empty status: NORMAL for 3 s
  }
  private stepAll() { const i = ALL_PAGES.indexOf(this.shownPage() as EcamPage); this.manual = ALL_PAGES[(i + 1) % ALL_PAGES.length]; this.stsExitAt = 0; }
  private clr() {
    if (this.manual === 'STS') { this.manual = null; this.stsExitAt = 0; return; }
    const first = this.alerts[0];
    if (first) { this.cleared.add(first.text); if (!this.alerts.some((a) => !a.red)) this.flags.masterCaut = false; return; }
    if (this.toCfg) this.toCfg = null;
  }
  private rcl() {
    if (this.cleared.size) { this.cleared.clear(); return; }
    if (this.manual === null) this.normalUntil = this.now + NORMAL_MSG_S;
  }
  private recallCancelled() {
    this.inhibitSuppressed = true;
    if (this.cancelled.size || this.auralCancelled.size) { this.cancelled.clear(); this.auralCancelled.clear(); this.cleared.clear(); if (this.manual === 'STS') this.manual = null; }
    else this.normalUntil = this.now + NORMAL_MSG_S;
  }
  private emerCanc() {
    const active = this.alerts; let caution = false;
    for (const a of active) { if (a.red) this.auralCancelled.add(a.text); else { this.cancelled.add(a.text); caution = true; } }
    this.flags.masterWarn = false; this.flags.masterCaut = false;
    if (active.length) this.env.ackAural();
    if (caution) { this.manual = 'STS'; this.stsExitAt = 0; }       // CANCELLED CAUTION is listed on the STATUS page
  }
  private toConfig() {
    if (!this.env.wow) return;
    if (!this.env.anyEngine) { this.env.toast('T.O CONFIG test: start an engine first (flight phase 2)'); return; }
    this.toCfg = { since: this.now };
  }
}
