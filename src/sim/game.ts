import * as THREE from 'three';
import { Airport, airportsNear, frequenciesFor } from '../data/airports';
import { taxiRoute, TaxiRoute } from './airfield';
import { magVar } from './magvar';
import { AircraftSpec, specById } from './specs';
import { FlightModel, G, atmosphere, airState } from './physics';
import { LiveWx, OFFLINE_WX, fetchLiveWeather, windProfile, windVector, isaDeviation, wxSummary } from './liveWeather';
import { Precip } from './precip';
import { chooseSpawn, Spawn } from './departure';
import { AtcRadio, buildAmbient, buildExchange, makeCallsign, phoneticLetter, AmbientPhase, RadioLine, RadioCtx } from './atc';
import { Projection, haversine, bearing, wrap180, wrap360, D2R, R2D, clamp, M_PER_NM, MS_TO_KT, destination, greatCircle, FlightWaypoint } from './geo';
import { World, Threshold, TimeOfDay } from './world';
import { AircraftVisual, loadAircraftVisual } from './aircraftModel';
import { Cockpit, CockpitPreset, CockpitHost, COCKPIT_FOCUS } from './cockpit';
import type { EfbInfo } from './a320/efb';
import { PanelData } from './instruments';
import { Autopilot, IlsData } from './autopilot';
import { advanceWaypoint } from './lnav';
import { AudioEngine, WarnSound } from './audio';
import { Effects } from './effects';
import { Settings, addScore, QualityPreset } from './storage';
import { QUALITY, resolveAutoQuality } from './quality';
import { DEFAULT_CHECKLIST_ITEMS, buildApproachGates, buildTaxiRibbon, computeWorldScreenMarkers } from './navAssists';
import { computeFlightPhaseState, FlightPhaseContext } from './flightPhase';
import { simNowMs, sunPhase } from './clock';

export type Phase = 'idle' | 'loading' | 'playing' | 'paused' | 'crashed' | 'complete';
export type ViewId = 'cockpit' | 'chase' | 'spotter' | 'aisle' | 'window';
const VIEWS: ViewId[] = ['cockpit', 'chase', 'spotter']; // A320 flight deck is the primary view; cabin views were removed
export interface ScenarioConfig {
  aircraftId: string; from: Airport; to: Airport; settings: Settings;
  /** Runway ident chosen in the planner (otherwise the best runway for wind/route is picked). */
  depRwy?: string; arrRwy?: string;
  /** Parking / start position id from `startSpots()` (gate, stand, apron, hangar). Only used with the runway start mode. */
  startSpot?: string;
}
export type FlightPhase = 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'final' | 'rollout';
export interface AtcMessage { id: number; sender: string; text: string; time: number; needsAck?: boolean; /** speaking station label (Tower, Ground, callsign…) */ label?: string; }
export interface Toast { id: number; text: string; level: 'info' | 'good' | 'warn' | 'bad'; }
export interface Breakdown { label: string; pts: number; }
export interface LandingInfo { vsFpm: number; kias: number; offset: number; dist: number; bank: number; pitch: number; onRunway: boolean; airportId: string; rwy: string; }
export interface Result { outcome: 'landed' | 'diverted' | 'crashed'; score: number; grade: string; items: Breakdown[]; landing: LandingInfo | null; rank: number; reason: string; distanceKm: number; flightTime: number; comfort: number; newBest: boolean; }
export interface CockpitTooltip {
  id: string;
  /** Real-world function of the control (from a320/controlInfo.ts). */
  description?: string;
  label: string;
  value: string;
  actionHint: string;
  x: number;
  y: number;
}

export interface WorldScreenMarker {
  id: string;
  label: string;
  distNm: number;
  altFt: number;
  type: 'waypoint' | 'airport' | 'runway';
  x: number;
  y: number;
  inView: boolean;
  angleDeg: number;
}

export interface ChecklistItem {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  phase: FlightPhase;
}

export interface HudState {
  phase: Phase; view: ViewId; kias: number; altFt: number; vsFpm: number; hdg: number; gsKt: number; mach: number; pitch: number; bank: number; throttle: number; n1: number; flapsIdx: number; flapsDet: number; gear: number; gearDown: boolean; brake: boolean; parking: boolean; reverse: boolean; spoilers: number;
  fuelPct: number; fuelKg: number; aglFt: number; distNm: number; brg: number; eteMin: number; warn: { text: string; level: 'caution' | 'warning'; acked?: boolean }[]; score: number; comfort: number; ap: { on: boolean; nav: boolean; appr: boolean; gsCaptured: boolean; hdg: number; alt: number; spd: number };
  ils: { valid: boolean; locDots: number; gsDots: number; ident: string; dist: number } | null; timeScale: number; lat: number; lon: number; utcMs: number; sunEl: number; sunPhase: string; lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean }; seatbelt: boolean; assist: boolean; hint: string; loadProgress: number; restartHold: number;
  wind: { dir: number; kt: number }; destId: string; fromId: string; aircraft: string; progress: number; onGround: boolean; stall: boolean; nz: number; depRwy: string; apprRwy: string; rwyHdg: number; rwyDistNm: number; vr: number; vapp: number; alphaFrac: number; offline: boolean; paxCount: number; cabinMsg: string; canWarp: boolean;
  flightPlan: FlightWaypoint[]; activeWpIdx: number; apPhase: string;
  // UI/UX Enhanced fields
  flightPhase: FlightPhase;
  track: number;
  fpaDeg: number;
  speedTrendKt: number;
  vs0: number; vs1: number; v1: number; v2: number; vne: number;
  fuelTimeMin: number;
  relWindDir: number; crosswindKt: number; headwindKt: number;
  qnhInHg: number; oatC: number;
  /** live weather */
  wxText: string; wxMetar: string; wxSource: string; wxCondition: string; wxRain: number; wxQnhHpa: number; wxVisKm: number; wxObsAge: number;
  runwayRemM: number;
  pitchTarget: number | null;
  trim: number;
  atc: AtcMessage | null;
  atcLog: AtcMessage[];
  /** the transmission currently on the air (subtitle), null when the frequency is quiet */
  atcLive: AtcMessage | null;
  activeWp: { name: string; distNm: number; brg: number; etaMin: number } | null;
  // Optional presentation extensions are populated only when their simulation feature exists.
  cockpitTooltip?: CockpitTooltip | null;
  freelookActive: boolean;
  worldMarkers?: WorldScreenMarker[];
  show3dGates?: boolean;
  showTaxiRibbon?: boolean;
  activeChecklist?: {
    items: ChecklistItem[];
    currentPhase: FlightPhase;
    completedCount: number;
    totalCount: number;
  };
  fov: number;
}
export interface MapState { lat: number; lon: number; hdg: number; track: number; from: Airport; to: Airport; trail: [number, number][]; altFt: number; depRwy: string; apprRwy: string; appr: { lat: number; lon: number; hdg: number; ident: string; ils?: boolean } | null; navPath: [number, number][]; flightPlan: FlightWaypoint[]; activeWpIdx: number; }
interface Hooks { onHud(h: HudState): void; onToast(t: Toast): void; onPhase(p: Phase): void; onResult(r: Result): void; onCommand(cmd: string): void; }

const gLimits = { piston: { p: 5.2, n: -2.4 }, turboprop: { p: 4.4, n: -1.8 }, jet: { p: 3.6, n: -1.4 } };
const TAU = Math.PI * 2;
const FINAL_GATE_M = 18000; // join final 18 km (9.7 nm) before the threshold
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpV3 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpE2 = new THREE.Euler();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export function buildFlightPlan(
  from: Airport,
  depTh: Threshold | null,
  to: Airport,
  arrTh: Threshold | null,
  cruiseAltM: number,
  cruiseSpeedKt: number,
  vappKt: number,
  precision = true
): FlightWaypoint[] {
  const wps: FlightWaypoint[] = [];

  // 1. Departure Runway Threshold & Climb Leg
  if (depTh) {
    wps.push({
      id: 'DEP',
      name: `RWY ${depTh.ident}`,
      type: 'takeoff',
      lat: depTh.startLat,
      lon: depTh.startLon,
      altM: from.elev,
      speedKt: 0,
      rwyIdent: depTh.ident,
      hdg: depTh.hdg,
    });

    const [climbLat, climbLon] = destination(depTh.startLat, depTh.startLon, depTh.hdg, 5500);
    wps.push({
      id: 'CLIMB',
      name: `CLIMB ${depTh.ident}`,
      type: 'climb',
      lat: climbLat,
      lon: climbLon,
      altM: from.elev + 550,
      speedKt: Math.round(cruiseSpeedKt * 0.72),
      hdg: depTh.hdg,
    });
  } else {
    wps.push({
      id: 'DEP',
      name: from.icao,
      type: 'takeoff',
      lat: from.lat,
      lon: from.lon,
      altM: from.elev,
      speedKt: 0,
    });
  }

  // 2. Arrival Runway & Approach Waypoints (IAF, FAF, Touchdown)
  let iafLat = to.lat, iafLon = to.lon;
  let fafLat = to.lat, fafLon = to.lon;
  let arrLat = to.lat, arrLon = to.lon;
  let arrHdg = 0;

  if (arrTh) {
    arrLat = arrTh.lat;
    arrLon = arrTh.lon;
    arrHdg = arrTh.hdg;
    // Precision (ILS) approach: FAF ~4.6 nm / IAF ~10 nm out. Runways without an ILS get a shorter visual final.
    [fafLat, fafLon] = destination(arrTh.lat, arrTh.lon, arrTh.hdg + 180, precision ? 8500 : 4500);
    [iafLat, iafLon] = destination(arrTh.lat, arrTh.lon, arrTh.hdg + 180, precision ? 18500 : 10000);
  } else {
    const oppBrg = wrap360(bearing(from.lat, from.lon, to.lat, to.lon) + 180);
    [fafLat, fafLon] = destination(to.lat, to.lon, oppBrg, 8500);
    [iafLat, iafLon] = destination(to.lat, to.lon, oppBrg, 18500);
  }

  // 3. Cruise Leg & Top of Descent (TOD)
  const lastDep = wps[wps.length - 1];
  const enrouteDist = haversine(lastDep.lat, lastDep.lon, iafLat, iafLon);
  const descentDistM = Math.max(12000, (cruiseAltM - (to.elev + 900)) / Math.tan(3 * D2R));

  if (enrouteDist > descentDistM + 12000) {
    const gcPoints = greatCircle(lastDep.lat, lastDep.lon, iafLat, iafLon, 8);
    const midPoint = gcPoints[Math.floor(gcPoints.length / 2)];
    wps.push({
      id: 'CRZ',
      name: 'CRUISE',
      type: 'cruise',
      lat: midPoint[0],
      lon: midPoint[1],
      altM: cruiseAltM,
      speedKt: cruiseSpeedKt,
    });

    const todRatio = 1 - (descentDistM / enrouteDist);
    const todIdx = Math.min(gcPoints.length - 1, Math.max(0, Math.round(todRatio * (gcPoints.length - 1))));
    const todPt = gcPoints[todIdx];
    wps.push({
      id: 'TOD',
      name: 'TOP OF DESCENT',
      type: 'tod',
      lat: todPt[0],
      lon: todPt[1],
      altM: cruiseAltM,
      speedKt: Math.round(cruiseSpeedKt * 0.88),
    });
  }

  // 4. IAF (Initial Approach Fix)
  wps.push({
    id: 'IAF',
    name: `${precision ? 'IAF' : 'FINAL 10 KM'} ${arrTh?.ident ?? ''}`.trim(),
    type: 'iaf',
    lat: iafLat,
    lon: iafLon,
    altM: to.elev + (precision ? 900 : 560),
    speedKt: 160,
    rwyIdent: arrTh?.ident,
    hdg: arrHdg,
  });

  // 5. FAF (Final Approach Fix)
  wps.push({
    id: 'FAF',
    name: `${precision ? 'FAF' : 'FINAL 4.5 KM'} ${arrTh?.ident ?? ''}`.trim(),
    type: 'faf',
    lat: fafLat,
    lon: fafLon,
    altM: to.elev + (precision ? 450 : 255),
    speedKt: 140,
    rwyIdent: arrTh?.ident,
    hdg: arrHdg,
  });

  // 6. Touchdown Threshold
  wps.push({
    id: 'ARR',
    name: `RWY ${arrTh?.ident ?? to.icao}`,
    type: 'touchdown',
    lat: arrLat,
    lon: arrLon,
    altM: to.elev + 15,
    speedKt: vappKt,
    rwyIdent: arrTh?.ident,
    hdg: arrHdg,
  });

  // 7. Rollout / Stop Point
  if (arrTh) {
    const [rollLat, rollLon] = destination(arrTh.lat, arrTh.lon, arrTh.hdg, Math.min(1800, arrTh.len * 0.75));
    wps.push({
      id: 'ROLLOUT',
      name: 'STOP',
      type: 'rollout',
      lat: rollLat,
      lon: rollLon,
      altM: to.elev,
      speedKt: 0,
      rwyIdent: arrTh.ident,
      hdg: arrHdg,
    });
  }

  return wps;
}

export class Game {
  renderer: THREE.WebGLRenderer; camera = new THREE.PerspectiveCamera(65, 1, 2, 220000);
  audio = new AudioEngine();
  world: World | null = null; fm!: FlightModel; spec!: AircraftSpec; visual: AircraftVisual | null = null; cockpit: Cockpit | null = null; effects: Effects | null = null;
  ap = new Autopilot();
  phase: Phase = 'idle'; mode: 'attract' | 'play' = 'attract';
  private _suspended = false;
  /**
   * Suspending the sim (planner / globe background menu) must ALSO kill the radio and the audio
   * engine: AtcRadio's pump/say timers are independent `setTimeout`s that never look at the RAF
   * gate (the game loop bails on `suspended` before any audio update), so queued exchanges would
   * otherwise keep being voiced over the menu. Setters outside this class (App.tsx) flip this
   * flag directly — the kill happens here, at the source of truth.
   */
  get suspended() { return this._suspended; }
  set suspended(v: boolean) {
    if (v && !this._suspended) { this.radio.cancel(); this.audio.silence(); }
    this._suspended = v;
  }
  cfg!: ScenarioConfig; hooks: Hooks;
  viewIdx = 0; lookYaw = 0; lookPitch = 0; orbitYaw = 0; orbitPitch = 0.1; zoom = 1; chaseQ = new THREE.Quaternion(); chaseInit = false;
  private raf = 0; private last = 0; private acc = 0; time = 0; private hudT = 0; private slowT = 0; timeScale = 1; private toastId = 1;
  private emaFrameMs = 16.6; private dprScale = 1.0; private dprCooldown = 0;
  // input
  radioMenuOpen = false;
  keys = new Set<string>(); private axes = { pitch: 0, roll: 0, yaw: 0 }; touch = { pitch: 0, roll: 0, yaw: 0, brake: false }; yokeDrag: { pitch: number; roll: number } | null = null; private pad = { pitch: 0, roll: 0, yaw: 0 };
  private brakeAxis = 0; private restartHold = 0; private apOverride = 0;
  private panning = false;
  private drag: { id: string; sx: number; sy: number; v: number; look?: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  // game state
  private score = 0; private items: Breakdown[] = []; private comfort = 100; private bestRem = 0; private flightTime = 0; private flownKm = 0; private lastLL: [number, number] = [0, 0];
  trail: [number, number][] = []; private trailT = 0;
  private lights = { nav: true, strobe: false, land: false, beacon: true }; seatbelt = true;
  /** Real-time weather at the aircraft (METAR + model data); see liveWeather.ts. */
  liveWx: LiveWx | null = null; private wxFetchedAt = 0; private wxBusy = false; private wxPoint: [number, number] = [0, 0]; precip: Precip | null = null;
  /** Where the aircraft is parked (stand / gate / apron) and the departure procedure state. */
  spawn: Spawn | null = null; depStage = 0; pushback = { active: false, t: 0, done: false }; private depT = 0;
  private windTmp = new THREE.Vector3(); private relAir = new THREE.Vector3(); private wxTmp = { dir: 0, kt: 0, tempC: 15 };
  /** Live wind (m/s, world axes) at the cloud decks — refreshed with the weather, drives cloud advection. */
  private cloudWind = new THREE.Vector3();
  private windFrom = 270; private windKt = 0; private turb = 0; private gustPhase = Math.random() * 100; private gust = new THREE.Vector3();
  private warnState: { text: string; level: 'caution' | 'warning'; sound: WarnSound }[] = []; private warnPenalty: Record<string, number> = {};
  private landing: LandingInfo | null = null; private takeoffDone = false; private stoppedT = 0; private endT = 0; private result: Result | null = null; private crashTimer = 0;
  private paEvents = { welcome: false, landing: false }; private cabinMsg = ''; private cabinMsgT = 0; private nextChat = 20; private shakeImpulse = 0;
  /** Magnetic variation (deg E) at the aircraft – HUD/AP headings are magnetic, physics is true. */
  magv = 0; taxiPlan: TaxiRoute | null = null;
  apprKey = ''; private apprLocked = false; depTh!: Threshold | null; depRwy = ''; flightPlan: FlightWaypoint[] = []; activeWpIdx = 0; private loadStart = 0; private usedAp = false; private ticks = 0;
  private prevAgl = 0; private fuelWarned = false; private wasStalled = false; private overspeedT = 0; private todShown = false;
  private raycaster = new THREE.Raycaster();
  currentFlightPhase: FlightPhase = 'taxi';
  private speedTrendSmoothed = 0;
  private prevKias = 0;
  private atcMessages: AtcMessage[] = [];
  private nextAtcId = 1;
  /** Automatic, voiced ATC <-> pilot radio (see atc.ts). */
  atcLive: AtcMessage | null = null; private atcLastCat = ''; private atisLetter = 'A';
  /** Per-flight radio identity (see atc.ts): generated callsign, a seeded PRNG so exchanges and
   *  ambient chatter replay identically for a flight, and the background-traffic timer. */
  private callsignFlight = ''; private callsign = { callsign: 'Aero 101', spoken: 'Aero 101' };
  private atcRng: () => number = Math.random; private ambientT = 40; private ambientLast = '';
  radio = new AtcRadio({
    onLine: (l) => this.logRadioLine(l),
    onLive: (l) => { this.atcLive = l ? { id: l.id, sender: l.who, text: l.text, time: this.time, label: l.label } : null; },
    voiceOn: () => this.audio.voiceOn && !this.audio.muted, volume: () => this.audio.volume, key: () => this.audio.chirp(),
  });
  private atcReply: { due: number; text: string; sender: string } | null = null;
  private ackedWarnings = new Set<string>();

  // 3D Navigation Assists
  private navAssistsGroup = new THREE.Group();
  private approachGatesGroup = new THREE.Group();
  private taxiRibbonGroup = new THREE.Group();
  show3dGates = true;
  showTaxiRibbon = true;

  // Cockpit Tooltip & Freelook
  cockpitTooltip: CockpitTooltip | null = null;
  freelookActive = false;

  // Checklist state
  checklistItems: ChecklistItem[] = DEFAULT_CHECKLIST_ITEMS.map((item) => ({ ...item }));

  constructor(public canvas: HTMLCanvasElement, hooks: Hooks) {
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false }); // stencil: flight-deck occlusion mask (see render())
    this.renderer.autoClear = false; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown); window.addEventListener('keyup', this.onKeyUp); window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointerdown', this.onPointerDown); window.addEventListener('pointermove', this.onPointerMove); window.addEventListener('pointerup', this.onPointerUp); window.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: true }); canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.phase === 'playing') this.pause(); });
    this.last = performance.now(); this.raf = requestAnimationFrame(this.loop);
    // A hidden tab stops the RAF loop, so the per-frame radio gate would never run again: pause the
    // frequency the moment the tab is hidden, and re-gate it when the tab comes back.
    document.addEventListener('visibilitychange', () => { if (typeof document !== 'undefined') this.radio.setPaused(!this.radioMayTransmit()); });
    (window as any).sim = this;
  }
  get isMobile() { return matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700; }
  get quality(): QualityPreset { const q = this.cfg?.settings.quality ?? 'auto'; return q === 'auto' ? resolveAutoQuality(this.isMobile) : q; }
  get qualityProfile() { return QUALITY[this.quality]; }
  private basePixelRatio() {
    const p = this.qualityProfile;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    // A 4K panel at DPR 2 would otherwise render 33 MP every frame. The pixel budget caps the
    // back buffer independently of the preset so even Ultra stays inside a 60 FPS fill rate.
    const budgetRatio = Math.sqrt(p.maxPixels / Math.max(1, w * h));
    return Math.min(dpr, p.pixelRatioCap, budgetRatio);
  }
  resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.max(0.5, this.basePixelRatio() * this.dprScale);
    this.renderer.setPixelRatio(pr); this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.cockpit) { this.cockpit.vpH = h; this.cockpit.dpr = pr; }
    if (this.cockpit) { for (const cam of [this.cockpit.camera, this.cockpit.activeCamera]) { cam.aspect = w / h; cam.updateProjectionMatrix(); } }
  };
  private fovFor(base: number) { return this.camera.aspect < 1 ? base + 22 : base; }

  // =====================================================================================
  //  Scenario management
  // =====================================================================================
  async load(cfg: ScenarioConfig, mode: 'attract' | 'play', startMode: 'runway' | 'cruise' | 'final' = 'runway') {
    this.disposeScenario();
    this.cfg = cfg; this.mode = mode; this.spec = specById(cfg.aircraftId);
    this.dprScale = 1; this.emaFrameMs = 16.6; this.dprCooldown = 1.0;
    const s = cfg.settings, from = cfg.from;
    // Via setPhase, not a bare field write: leaving a PAUSED flight straight into a new load would
    // otherwise leave AtcRadio paused and speechSynthesis globally frozen (ATC/GPWS voice dead for
    // the whole next flight). setPhase un-pauses the radio on the way out of 'paused'.
    this.setPhase('loading'); this.loadStart = performance.now();
    const proj = new Projection(from.lat, from.lon);
    const anisoMap: Record<QualityPreset, number> = {
      ultra: this.renderer.capabilities.getMaxAnisotropy(),
      high: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      medium: 4,
      low: 1,
    };
    this.world = new World(proj, {
      quality: this.quality,
      style: s.terrainStyle,
      tod: s.tod as TimeOfDay,
      maxAniso: anisoMap[this.quality] ?? 4,
    });
    this.world.terrain.fallbackH = from.elev;
    this.effects = new Effects(this.world.scene);
    // precipitation arrays are allocated ONCE for the largest preset so a mid-flight quality raise
    // gets its full budget; the active preset then sets the per-frame cap
    this.precip = new Precip(this.world.scene, QUALITY.ultra.precipMax);
    this.precip.setQuality(this.qualityProfile.precipMax);
    // lightning → procedural thunder with the real speed-of-sound delay (~343 m/s) and distance
    // falloff; only in play mode so the airport-background menu never rumbles
    if (mode === 'play') this.world.lightning.onStrike = (distM) => this.audio.thunder(clamp(1 - distM / 15000, 0.06, 1), distM / 343);
    this.visual = await loadAircraftVisual(this.spec); this.world.scene.add(this.visual.root);
    this.cockpit = new Cockpit(this.spec, this.quality); this.cockpit.host = this.makeCockpitHost(); await this.cockpit.ready;
    for (const cam of [this.cockpit.camera, this.cockpit.activeCamera]) { cam.aspect = this.camera.aspect; cam.updateProjectionMatrix(); }
    this.audio.voiceOn = s.voice; this.audio.setVolume(s.volume); this.audio.setMuted(s.muted);
    // REAL weather: METAR + model data for the departure airfield (no presets). Never blocks the sim for more than a few seconds.
    let wx: LiveWx = OFFLINE_WX;
    try { wx = await Promise.race([fetchLiveWeather(from.lat, from.lon, from.icao), new Promise<LiveWx>((_, rej) => setTimeout(() => rej(new Error('timeout')), 7000))]); } catch { wx = { ...OFFLINE_WX, lat: from.lat, lon: from.lon, elevM: from.elev }; }
    this.wxPoint = [from.lat, from.lon];
    this.applyLiveWx(wx, from.elev);
    this.world.rebuildAirports(from.lat, from.lon);

    // 3D Navigation Assists in World Scene
    this.navAssistsGroup.clear();
    this.approachGatesGroup.clear();
    this.taxiRibbonGroup.clear();
    this.navAssistsGroup.add(this.approachGatesGroup, this.taxiRibbonGroup);
    this.world.scene.add(this.navAssistsGroup);

    this.resetFlight(startMode);
    this.camera.fov = 65; this.setView(mode === 'attract' ? 'chase' : s.startMode === 'runway' ? 'cockpit' : 'cockpit');
    this.world.update(this.camera, this.fm.pos, 1, 0);
    this.resize();
  }

  /** Push a weather report into wind, turbulence, air density, runway friction, clouds, fog and precipitation. */
  private applyLiveWx(wx: LiveWx, groundM: number) {
    this.liveWx = wx; this.wxFetchedAt = performance.now();
    windProfile(wx, groundM + 10, 10, this.wxTmp);
    this.windFrom = Math.round(this.wxTmp.dir) % 360; this.windKt = Math.round(this.wxTmp.kt);
    // turbulence from the real gust spread (+ convective weather)
    const spreadMs = Math.max(0, wx.gustKt - wx.windKt) * 0.514444;
    this.turb = clamp(0.03 + spreadMs / 3.2 * 0.9 + (wx.thunder ? 0.6 : 0) + wx.rain * 0.08 + wx.windKt / 80 * 0.1, 0.02, 2.2);
    airState.dT = isaDeviation(wx, groundM); airState.qnh = wx.qnh;
    this.applyAirToFm();
    this.world?.setLiveWeather(wx.cover, wx.baseAglM, groundM, wx.rain, wx.snow, wx.visM, wx.thunder, wx.midBaseMsl, wx.highBaseMsl);
    this.precip?.set(wx.rain, wx.snow);
    // clouds advect with the live wind at their own altitude (the mid deck), not the surface wind
    windVector(wx, wx.midBaseMsl, 0, this.cloudWind);
    this.world?.setCloudWind(this.cloudWind.x, this.cloudWind.z);
  }
  private applyAirToFm() {
    const wx = this.liveWx; if (!wx || !this.fm) return;
    this.fm.friction = wx.snow > 0.05 ? 0.35 : wx.rain > 0.05 ? Math.max(0.38, 0.62 - 0.22 * wx.rain) : wx.fog > 0.5 ? 0.85 : 1;
    this.fm.wetness = Math.min(1, wx.rain * 1.2 + wx.snow);
  }
  private async refreshWx() {
    if (this.wxBusy || !this.world) return; this.wxBusy = true;
    const lat = this.lat(), lon = this.lon();
    const near = (a: Airport) => haversine(lat, lon, a.lat, a.lon) < 40000 ? a.icao : undefined;
    try {
      const wx = await fetchLiveWeather(lat, lon, near(this.cfg.from) || near(this.cfg.to));
      if (this.world) { this.wxPoint = [lat, lon]; this.applyLiveWx(wx, this.fm.groundH); if (this.phase === 'playing') this.toast(`Weather updated – ${wxSummary(wx)}`, 'info'); }
    } catch { /* keep the previous report */ }
    this.wxBusy = false;
  }

  /** Re-spawn the aircraft (instant restart – terrain stays loaded). */
  resetFlight(startMode: 'runway' | 'cruise' | 'final') {
    const w = this.world!, cfg = this.cfg, spec = this.spec, from = cfg.from, to = cfg.to;
    if (Math.abs(w.proj.lat0 - from.lat) > 1e-6 || Math.abs(w.proj.lon0 - from.lon) > 1e-6) this.rebaseTo(from.lat, from.lon);
    const dist = haversine(from.lat, from.lon, to.lat, to.lon);
    const cruiseT = (dist / (spec.cruiseKt * 0.514)) / 3600;
    const need = Math.min(spec.fuelCap, (spec.fuelFlow * spec.engines * 0.62 * 3600) * cruiseT * 1.25 + spec.fuelFlow * spec.engines * 0.35 * 3600 * 0.5 + 20);
    this.fm = new FlightModel(spec, (x, z) => this.world!.terrain.heightAt(x, z), Math.max(need, spec.fuelCap * 0.25));
    this.fm.ctl.assist = cfg.settings.assist; this.applyAirToFm();
    this.ap = new Autopilot(); this.ap.vsLimit = spec.kind === 'jet' ? 12 : spec.kind === 'turboprop' ? 7 : 4.5;
    const dep = this.pickDepRunway(from);
    this.depTh = dep;
    this.magv = magVar(from.lat, from.lon);
    this.depRwy = dep ? dep.ident : '';
    this.world!.rebuildAirports(from.lat, from.lon);
    const arr = this.bestApproach(to, from);
    const wantArr = cfg.arrRwy && w.thresholds(to).find((t) => t.ident === cfg.arrRwy);
    if (wantArr) { this.apprKey = wantArr.ident; this.apprLocked = true; }
    else if (!this.apprLocked) this.apprKey = arr ? arr.ident : '';
    this.rebuildFlightPlan();
    const brg = bearing(from.lat, from.lon, to.lat, to.lon);
    if (startMode === 'runway' && dep) {
      // REAL start: cold & dark on a stand / gate / apron (never on the runway); engines are started by the pilot.
      this.placeAtStand(dep);
      this.fm.ctl.flapsIdx = 0; this.fm.flapsPos = 0;
    } else if (startMode === 'cruise') {
      const alt = Math.max(spec.cruiseAlt * (dist < 120000 ? 0.55 : 1), from.elev + 1500, to.elev + 1500, 1500);
      const d0 = Math.min(dist * 0.12, 18000) + 3000;
      const [la, lo] = destination(from.lat, from.lon, brg, d0);
      this.fm.placeAirborne(w.proj.x(lo), alt, w.proj.z(la), brg, spec.cruiseKt * 0.9, 0, false);
      this.fm.ctl.throttle = 0.6; this.ap.engage(this.fm); this.ap.nav = true; this.fm.ctl.apHold = true; this.usedAp = true;
    } else {
      const th = this.bestApproach(to, from) ;
      const d0 = 14000, h = th.hdg * D2R;
      const x = th.x - Math.sin(h) * d0, z = th.z + Math.cos(h) * d0, alt = to.elev + 15 + Math.tan(3 * D2R) * d0 + 60;
      this.fm.placeAirborne(x, alt, z, th.hdg, spec.vapp * 1.35, 0, false);
      this.fm.ctl.throttle = 0.4; this.ap.hdg = Math.round(th.hdg); this.ap.altFt = Math.round(alt / 0.3048 / 100) * 100; this.ap.spd = Math.round(spec.vapp * 1.3);
      this.apprKey = th.ident; this.apprLocked = true;
    }
    this.fm.wind.copy(this.windVec(0));
    this.score = 0; this.items = []; this.comfort = 100; this.landing = null; this.takeoffDone = startMode !== 'runway'; this.stoppedT = 0; this.result = null; this.endT = 0; this.crashTimer = 0;
    this.visual?.setVisible(true); this.effects?.clear(); this.paEvents = { welcome: false, landing: false }; this.flightTime = 0; this.flownKm = 0; this.trail = []; this.fuelWarned = false; this.warnPenalty = {}; this.timeScale = 1; this.todShown = false;
    this.seatbelt = true; if (startMode !== 'runway') this.lights = { nav: true, strobe: true, land: false, beacon: true };
    if (startMode !== 'final' && !cfg.arrRwy) { this.apprKey = ''; this.apprLocked = false; }
    this.currentFlightPhase = startMode === 'runway' ? 'taxi' : startMode === 'final' ? 'final' : 'cruise';
    this.speedTrendSmoothed = 0;
    this.prevKias = this.fm ? this.fm.ias / 0.514444 : 0;
    this.radio.cancel(); this.atcMessages = []; this.atcReply = null; this.atcLastCat = '';
    this.reseedRadio();
    const rwyInit = this.depRwy || '09';
    if (startMode === 'runway') {
      this.addAtc('ATIS', this.atisText(from, rwyInit), false);
    } else if (startMode === 'final') {
      this.addAtc('TOWER', `${this.callsign.callsign}, ${to.icao} Tower. Established final approach runway ${this.apprKey || '27'}, cleared to land.`, true);
    } else {
      this.addAtc('ENROUTE', `${this.callsign.callsign}, radar contact at ${Math.round(spec.cruiseAlt / 0.3048)} ft, cleared enroute ${to.icao}.`, false);
    }
    this.lastLL = [this.lat(), this.lon()]; this.bestRem = dist; this.chaseInit = false; this.shakeImpulse = 0; this.lookYaw = this.lookPitch = 0; this.zoom = 1;
    this.effects?.update(0);
    this.audio.silence();
    this.rebuild3dNavAssists();
  }

  rebuildFlightPlan(preserveActive = false) {
    if (!this.world || !this.cfg) return;
    const activeId = preserveActive ? this.flightPlan[this.activeWpIdx]?.id : null;
    const previousIdx = this.activeWpIdx;
    const from = this.cfg.from, to = this.cfg.to;
    const arr = this.approachTh();
    const cruiseAltM = Math.max(this.spec.cruiseAlt * (haversine(from.lat, from.lon, to.lat, to.lon) < 120000 ? 0.55 : 1), from.elev + 1500, to.elev + 1500, 1500);
    this.flightPlan = buildFlightPlan(from, this.depTh, to, arr, cruiseAltM, this.spec.cruiseKt, this.spec.vapp, arr ? this.ilsCapable(arr) : true);
    if (activeId) {
      const idx = this.flightPlan.findIndex((wp) => wp.id === activeId);
      this.activeWpIdx = idx >= 0 ? idx : Math.min(previousIdx, this.flightPlan.length - 1);
    } else if (this.cfg.settings.startMode === 'runway' && !this.takeoffDone) {
      this.activeWpIdx = 0;
    } else if (this.cfg.settings.startMode === 'final') {
      const fafIdx = this.flightPlan.findIndex((w) => w.type === 'faf');
      this.activeWpIdx = fafIdx >= 0 ? fafIdx : Math.max(0, this.flightPlan.length - 2);
    } else {
      this.activeWpIdx = Math.min(1, this.flightPlan.length - 1);
    }
    this.rebuild3dNavAssists();
  }

  /** Park the aircraft at the chosen / best start position for the departure runway. */
  private placeAtStand(dep: Threshold) {
    const w = this.world!, from = this.cfg.from;
    const sp = chooseSpawn(from, dep, this.spec, w.proj, w.runways, this.cfg.startSpot);
    this.spawn = sp; this.depStage = 0; this.depT = 0; this.pushback = { active: false, t: 0, done: false };
    // no trees / mapped buildings may overlap the parked aircraft (ICAO 4.5 m stand clearance + margin)
    w.setSpawnClear(sp.footprint);
    this.fm.placeOnRunway(sp.x, sp.z, sp.hdg, from.elev, true);
    this.lights = { nav: false, strobe: false, land: false, beacon: false };
    this.fm.ctl.parking = true;
  }

  setDepRunway(ident: string) {
    if (!this.world) return;
    const ths = this.world.thresholds(this.cfg.from);
    const th = ths.find((t) => t.ident === ident);
    if (!th) return;
    this.depTh = th;
    this.depRwy = th.ident;
    if (this.cfg.settings.startMode === 'runway' && !this.takeoffDone && this.fm) {
      const h = th.hdg * D2R;
      void h; if (!this.fm.anyEngineRunning && this.fm.gs < 0.5 && !this.pushback.active) { this.placeAtStand(th); this.depStage = 0; }
      this.ap.takeoffHdg = th.hdg;
      this.toast(`Departure runway ${th.ident} selected`, 'info');
    }
    this.rebuildFlightPlan();
  }

  setArrRunway(ident: string) {
    if (!this.world) return;
    const ths = this.world.thresholds(this.cfg.to);
    const th = ths.find((t) => t.ident === ident);
    if (!th) return;
    this.apprKey = th.ident;
    this.apprLocked = true; this.ap.gsCaptured = false;
    this.toast(`Approach runway ${th.ident} selected`, 'info');
    this.rebuildFlightPlan(true);
  }
  /** Heavier aircraft avoid unpaved / very short strips when anything better exists. */
  private surfaceScore(t: Threshold) {
    const paved = t.surface === 'A' || t.surface === 'C' || t.surface === 'U';
    if (this.spec.kind === 'jet') return (paved ? 40 : -400) + (t.fullLen < 1500 ? -300 : 0);
    if (this.spec.kind === 'turboprop') return (paved ? 25 : -30) + (t.fullLen < 700 ? -200 : 0);
    return paved ? 8 : 0;
  }
  magHdg(trueDeg: number) { return wrap360(trueDeg - this.magv); }
  /** ' on 121.900' when a published frequency of that type exists for the airfield. */
  private atcFreq(ap: Airport, type: string) {
    const f = frequenciesFor(ap.id).find((x) => x.type === type);
    return f ? ` on ${f.mhz.toFixed(3).replace(/0$/, '')}` : '';
  }
  private atisText(ap: Airport, rwy: string) {
    const wx = this.liveWx, hour = Math.floor(simNowMs() / 3600000), letter = phoneticLetter(hour);
    this.atisLetter = letter; const faa = /^(K|P[AFGHJKMW]|C[A-Z])/.test(ap.id), r = this.atcRng;
    const name = (ap.city || ap.name || ap.icao).replace(/\s*(international|intl|airport|airfield|regional|domestic).*$/i, '').trim() || ap.icao;
    const head = faa ? `${name} airport information ${letter}` : `${name} information ${letter}`;
    if (!wx || !wx.ok) return `${head}. Weather unavailable. Runway ${rwy} in use. ${this.qnh(ap)}. Advise on initial contact you have information ${letter}.`;
    const gust = wx.gustKt > wx.windKt + 4 ? `, gusting ${Math.round(wx.gustKt)}` : '';
    const windS = wx.windKt < 1 ? 'Wind calm' : faa ? `Wind ${String(this.windFrom).padStart(3, '0')} at ${this.windKt}${gust}` : `Wind ${String(this.windFrom).padStart(3, '0')}° ${this.windKt} knots${gust}`;
    const vis = wx.visM >= 9999 ? (faa ? 'visibility one zero' : 'visibility 10 kilometres or more') : (faa ? `visibility ${Math.max(1, Math.round(wx.visM / 1609))}` : `visibility ${(wx.visM / 1000).toFixed(1)} kilometres`);
    const sky = wx.baseAglM !== null ? `${wx.cover[0] > 0.75 ? 'overcast' : wx.cover[0] > 0.45 ? 'broken' : 'scattered'} clouds ${Math.round(wx.baseAglM / 0.3048 / 100) * 100} feet` : wx.cover[1] + wx.cover[2] > 0.5 ? 'few clouds at altitude' : 'sky clear';
    const phen = wx.thunder ? 'Thunderstorms in the vicinity' : wx.snow > 0.05 ? 'Snow' : wx.rain > 0.6 ? 'Heavy rain' : wx.rain > 0.05 ? 'Light rain' : wx.fog > 0.5 ? 'Fog' : wx.fog > 0.2 ? 'Mist' : '';
    const temp = `temperature ${Math.round(wx.tempC)}, dew point ${Math.round(wx.dewC)}`;
    const use = faa ? `Landing and departing runway ${rwy}` : `Runway ${rwy} in use`;
    const tail = r() < 0.5 ? `Advise on initial contact you have information ${letter}` : `Read back all hold short instructions. Advise you have ${letter}`;
    return `${head}${wx.metar ? ' (METAR ' + wx.icao + ')' : ''}. ${windS}. ${vis}. ${phen ? phen + '. ' : ''}${sky}. ${temp}. ${this.qnh(ap)}. ${use}. ${tail}.`;
  }
  private depFreq() { return this.atcFreq(this.cfg.from, 'GND'); }
  /** Pilot start-up sequence, one real step per press: battery → (mixture) → beacon → starter, engine by engine. */
  startSequence() {
    if (!this.fm || this.phase !== 'playing' || !this.fm.wow) return;
    const fm = this.fm, c = fm.ctl, s = this.spec, a = this.audio;
    if (!c.battery) { c.battery = true; a.click(); this.lights.nav = true; this.toast('BATTERY MASTER ON – avionics powered, NAV lights ON', 'good'); return; }
    if (s.kind === 'piston' && c.mixture < 1) { c.mixture = 1; a.click(); this.toast('MIXTURE RICH · fuel selector BOTH · fuel pump ON', 'good'); return; }
    if (!this.lights.beacon) { this.lights.beacon = true; a.click(); this.toast(s.kind === 'piston' ? 'BEACON ON – "CLEAR PROP!"' : 'BEACON (anti-collision) ON – ground crew clear', 'good'); return; }
    if (fm.gs > 1.5 && !c.parking) { this.toast('Stop the aircraft before engine start', 'warn'); return; }
    const engs = fm.eng.slice(0, s.engines);
    const st = engs.findIndex((e) => e.state === 1);
    if (st >= 0) { this.toast(`Engine ${st + 1} starting – wait for stabilised idle`, 'info'); return; }
    const nxt = engs.findIndex((e) => e.state === 0);
    if (nxt < 0) { this.toast('Engines running – after start: set take-off flaps, release the parking brake [B], taxi', 'info'); return; }
    const err = fm.startEngine(nxt);
    if (err) { this.toast(err, 'warn'); return; }
    a.chirp(); this.toast(`Engine ${nxt + 1} START – ${s.kind === 'jet' ? 'N2 rising, light-off at 15%' : s.kind === 'turboprop' ? 'Np / ITT rising' : 'turning the key'}`, 'info');
  }
  shutdownEngines() {
    if (!this.fm || this.phase !== 'playing') return; const fm = this.fm;
    if (!fm.wow || fm.gs > 1.5 || !fm.ctl.parking) { this.toast('Set the parking brake and stop before shutdown', 'warn'); return; }
    for (let i = 0; i < this.spec.engines; i++) fm.stopEngine(i);
    this.toast('Engines SHUTDOWN', 'info');
  }
  startPushback() {
    if (!this.fm || this.phase !== 'playing') return; const c = this.fm.ctl, sp = this.spawn;
    if (!sp?.pushback) { this.toast('This stand is a drive-out position – no pushback needed, taxi forward', 'info'); return; }
    if (this.pushback.active || this.pushback.done) { this.toast(this.pushback.active ? 'Pushback in progress' : 'Pushback already completed', 'info'); return; }
    if (!c.battery || !this.lights.beacon) { this.toast('Battery and BEACON must be ON before pushback', 'warn'); return; }
    this.pushback = { active: true, t: 0, done: false }; c.parking = false;
    this.addAtc('GROUND', `${this.callsign.callsign}, pushback approved, tail towards the taxiway${this.depFreq()}. Start-up at your discretion.`, false);
    this.toast('PUSHBACK – tug connected, parking brake released', 'good');
  }
  /** ATC departure flow driven by what the pilot actually does (clearance → start → taxi → line-up → take-off). */
  private updateDeparture(dt: number) {
    if (this.takeoffDone || this.cfg.settings.startMode !== 'runway' || !this.depTh || !this.fm.wow) return;
    this.depT += dt; const fm = this.fm, th = this.depTh, c = fm.ctl, s = this.spec, rwy = this.depRwy || th.ident, w = this.world!;
    const ev = fm.eng.slice(0, s.engines);
    switch (this.depStage) {
      case 0:
        if (this.depT > 4) { this.addAtc('CLEARANCE', `${this.callsign.callsign}, ${this.cfg.from.icao} Delivery. Cleared to ${this.cfg.to.icao} as filed, runway ${rwy} departure, initial climb ${s.kind === 'piston' ? '3000' : '5000'} feet, squawk ${1000 + Math.floor(Math.abs(Math.sin(this.cfg.from.lat * 91.7 + this.cfg.from.lon * 13.3)) * 6999)}. ${this.qnh(this.cfg.from)}.`, true); this.depStage = 1; }
        break;
      case 1:
        if (ev.some((e) => e.state > 0) || this.pushback.active) {
          this.addAtc('GROUND', this.spawn?.pushback && !this.pushback.done ? `${this.callsign.callsign}, start-up approved.` : `${this.callsign.callsign}, ${this.cfg.from.icao} Ground. Start-up approved${this.depFreq()}.`, false); this.depStage = 2;
        }
        break;
      case 2:
        if (ev.every((e) => e.state === 2) && !c.parking && !this.pushback.active) {
          this.addAtc('GROUND', `${this.callsign.callsign}, taxi to holding point runway ${rwy}${this.taxiVia()}. ${this.qnh(this.cfg.from)}.`, true); this.depStage = 3;
          const it = this.checklistItems.find((x) => x.id === 'atc_ground'); if (it) it.done = true;
        }
        break;
      case 3: {
        const d = Math.hypot(fm.pos.x - th.startX, fm.pos.z - th.startZ);
        if (d < 160 && fm.gs < 8) { this.addAtc('TOWER', `${this.callsign.callsign}, ${this.cfg.from.icao} Tower${this.atcFreq(this.cfg.from, 'TWR')}. Runway ${rwy}, line up and wait.`, true); this.depStage = 4; }
        break;
      }
      case 4: {
        const r = w.runwayAt(fm.pos.x, fm.pos.z, 0), hd = Math.abs(wrap180(fm.heading - th.hdg));
        if (r && hd < 14 && Math.abs(r.across) < th.wid / 2 && fm.gs < 20) {
          const gust = this.liveWx && this.liveWx.gustKt > this.liveWx.windKt + 4 ? ` gusting ${Math.round(this.liveWx.gustKt)}` : '';
          this.addAtc('TOWER', `${this.callsign.callsign}, wind ${String(this.windFrom).padStart(3, '0')}° ${this.windKt} knots${gust}, runway ${rwy}, cleared for take-off.`, true); this.audio.chirp(); this.depStage = 5;
        }
        break;
      }
    }
  }
  private qnh(ap: Airport) {
    const hpa = this.liveWx?.ok ? this.liveWx.qnh : 1013.25;
    return ap.id.startsWith('K') ? `Altimeter ${(hpa / 33.8639).toFixed(2)}` : `QNH ${Math.round(hpa)}`;
  }
  private taxiVia() { return this.taxiPlan && this.taxiPlan.via.length ? ` via ${this.taxiPlan.via.join(', ')}` : ''; }
  /** Real taxi route (surveyed taxiways) from the aircraft to the physical start of the departure runway. */
  private computeTaxiRoute(): TaxiRoute | null {
    if (!this.depTh || !this.fm || !this.world) return null;
    const w = this.world, th = this.depTh;
    const d = Math.hypot(this.fm.pos.x - th.startX, this.fm.pos.z - th.startZ);
    if (d < 120) return null;
    return taxiRoute(this.cfg.from, [w.proj.lat(this.fm.pos.z), w.proj.lon(this.fm.pos.x)], [th.startLat, th.startLon], `${th.rw.le}/${th.rw.he}`);
  }
  /** Departure runway: longest, with the best headwind. */
  private pickDepRunway(ap: Airport): Threshold | null {
    const ths = this.world!.thresholds(ap); if (!ths.length) return null;
    const chosen = this.cfg.depRwy ? ths.find((t) => t.ident === this.cfg.depRwy) : null;
    if (chosen) return chosen;
    const maxLen = Math.max(...ths.map((t) => t.len));
    // Favour the active runway (headwind + length), but also prefer the end that
    // leaves toward the destination so the departure heading is not 180° off route.
    const routeBrg = bearing(ap.lat, ap.lon, this.cfg.to.lat, this.cfg.to.lon);
    let best = ths[0], bs = -1e9;
    for (const t of ths) {
      const head = Math.cos((this.windFrom - t.hdg) * D2R) * this.windKt;
      const align = Math.cos((routeBrg - t.hdg) * D2R);
      const sc = head * 0.6 + align * 9 + (t.len >= maxLen * 0.7 ? 20 : 0) + t.len / 1000 + this.surfaceScore(t);
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }
  private bestApproach(to: Airport, from: Airport): Threshold {
    const ths = this.world!.thresholds(to), p = this.world!.proj;
    const fx = p.x(from.lon), fz = p.z(from.lat);
    const maxLen = Math.max(...ths.map((t) => t.len));
    let best = ths[0], bs = -1e9;
    for (const t of ths) {
      const h = t.hdg * D2R, ax = t.x - Math.sin(h) * 12000, az = t.z + Math.cos(h) * 12000;
      const away = Math.hypot(ax - fx, az - fz);
      const head = Math.cos((this.windFrom - t.hdg) * D2R) * this.windKt;
      const sc = head * 0.4 + (t.len >= maxLen * 0.7 ? 10 : 0) - away / 8000 + this.surfaceScore(t);
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }
  private disposeScenario() {
    this.radio?.cancel(); this.atcReply = null; this.mapOnly = false;
    this.navAssistsGroup.clear();
    this.approachGatesGroup.clear();
    this.taxiRibbonGroup.clear();
    this.precip?.dispose(); this.precip = null; this.world?.dispose(); this.effects?.dispose(); this.cockpit?.dispose(); this.world = null; this.effects = null; this.cockpit = null; this.visual = null;
  }

  rebuild3dNavAssists() {
    this.approachGatesGroup.clear();
    this.taxiRibbonGroup.clear();
    if (!this.world || !this.cfg) return;

    // 1. Approach Corridor 3D Gates
    const th = this.approachTh() || (this.cfg.to ? this.world.thresholds(this.cfg.to)[0] : null);
    if (th) {
      const gates = buildApproachGates(th, this.cfg.to.elev);
      for (const g of gates) this.approachGatesGroup.add(g);
    }
    this.approachGatesGroup.visible = this.show3dGates;

    // 2. Taxi Ribbon Chevrons
    if (this.depTh && this.fm) {
      const w = this.world;
      this.taxiPlan = this.computeTaxiRoute();
      const path: [number, number][] = this.taxiPlan
        ? this.taxiPlan.pts.map(([la, lo]) => [w.proj.x(lo), w.proj.z(la)] as [number, number])
        : (this.spawn?.path ?? [[this.fm.pos.x, this.fm.pos.z], [this.depTh.startX, this.depTh.startZ]]);
      const ribbons = buildTaxiRibbon(path, this.depTh.hdg, (x, z) => this.world?.terrain.heightAt(x, z), this.cfg.from.elev);
      for (const r of ribbons) this.taxiRibbonGroup.add(r);
    }
    this.taxiRibbonGroup.visible = this.showTaxiRibbon && this.currentFlightPhase === 'taxi' && this.fm?.wow;
  }

  /** Smooth, damped camera move to one of the named flight-deck presets (see COCKPIT_PRESETS). */
  setCockpitSubview(sub: CockpitPreset) {
    if (!this.cockpit) return;
    this.setView('cockpit');
    this.cockpit.setPreset(sub);
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.toast(`Cockpit Camera: ${sub.toUpperCase()}`, 'info');
  }

  /** Bridge between the 3D flight deck and the simulation (cockpit switches act on the real flight model). */
  private makeCockpitHost(): CockpitHost {
    const g = this;
    return {
      get fm() { return g.fm; }, get ap() { return g.ap; }, get lights() { return g.lights; }, get seatbelt() { return g.seatbelt; },
      action: (id: string) => g.action(id), setApTarget: (t, v) => g.setApTarget(t, v), toast: (m, k) => g.toast(m, k ?? 'info'),
      route: () => g.flightPlan.slice(Math.max(0, g.activeWpIdx)).map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })),
      position: () => ({ lat: g.lat(), lon: g.lon() }), magVar: (h: number) => g.magHdg(h) - h,
      efbInfo: () => g.efbInfo(),
    };
  }

  /** Live data for the captain's EFB tablet in the 3D flight deck (flight plan, checklist, airports, weather). */
  efbInfo(): EfbInfo | null {
    if (!this.cfg || !this.fm || !this.world) return null;
    const h = this.hud(), la = this.lat(), lo = this.lon();
    return {
      dep: this.cfg.from, arr: this.cfg.to, depRwy: this.depRwy, arrRwy: h.apprRwy, callsign: this.callsign?.callsign ?? 'FLIGHT', phase: this.currentFlightPhase,
      wx: this.liveWx, windFrom: this.windFrom, windKt: this.windKt, qnh: this.liveWx?.qnh ?? 1013, oatC: this.oat(),
      route: this.flightPlan.map((w) => ({ name: w.name, type: w.type, distNm: haversine(la, lo, w.lat, w.lon) / M_PER_NM })), activeWp: this.activeWpIdx,
      checklist: this.checklistItems, toggle: (id) => this.toggleChecklistItem(id), fuelKg: this.fm.fuel, distNm: h.distNm, eteMin: h.distNm / Math.max(h.gsKt, 250) * 60, utcMs: simNowMs(),
    };
  }

  setFov(fov: number) {
    this.camera.fov = clamp(fov, 35, 95);
    this.camera.updateProjectionMatrix();
  }

  /** Time of day is not adjustable: the simulator is locked to the real-world UTC clock (see clock.ts). */
  setTimeOfDay(_tod?: TimeOfDay) {
    this.world?.updateSunFromClock(true);
    this.toast('Time is synchronised with the real world (UTC) and cannot be changed', 'info');
  }

  /** Weather is always the real thing – the old presets only report what is live. */
  setWeather(_w?: 'clear' | 'scattered' | 'overcast') { this.toast(`Live weather: ${wxSummary(this.liveWx)}`, 'info'); void this.refreshWx(); }
  setWindPreset(_preset?: 'calm' | 'light' | 'strong') { this.toast(`Live wind: ${this.windFrom}° / ${this.windKt} kt (${this.liveWx?.source ?? 'offline'})`, 'info'); }

  setAssistGates(v: boolean) {
    this.show3dGates = v;
    this.approachGatesGroup.visible = v;
    this.toast(`3D Flight Path Gates: ${v ? 'ON' : 'OFF'}`, 'info');
  }

  setAssistTaxi(v: boolean) {
    this.showTaxiRibbon = v;
    this.taxiRibbonGroup.visible = v;
    this.toast(`3D Taxi Ribbon: ${v ? 'ON' : 'OFF'}`, 'info');
  }


  private updateChecklist() {
    if (!this.fm) return;
    const c = this.fm.ctl, phase = this.currentFlightPhase;
    for (const it of this.checklistItems) {
      if (it.done) continue;
      switch (it.id) {
        case 'battery_on':
          if (c.battery) it.done = true;
          break;
        case 'engines_start':
          if (this.fm.enginesRunning) it.done = true;
          break;
        case 'park_brake':
          if (!c.parking && this.fm.enginesRunning) it.done = true;
          break;
        case 'flaps_takeoff':
          if (c.flapsIdx === this.spec.toFlaps && this.fm.enginesRunning) it.done = true;
          break;
        case 'lights_taxi':
          if (this.lights.beacon) it.done = true;
          break;
        case 'throttle_takeoff':
          if (c.throttle > 0.92) it.done = true;
          break;
        case 'rotate_vr':
          if (!this.fm.wow && phase !== 'taxi') it.done = true;
          break;
        case 'gear_retract':
          if (!c.gearDown && !this.fm.wow) it.done = true;
          break;
        case 'flaps_retract':
          if (c.flapsIdx === 0 && !this.fm.wow) it.done = true;
          break;
        case 'autopilot_arm':
          if (this.ap.on) it.done = true;
          break;
        case 'cruise_level':
          if (phase === 'cruise') it.done = true;
          break;
        case 'seatbelt_on':
          if (this.seatbelt) it.done = true;
          break;
        case 'gear_down':
          if (c.gearDown && (phase === 'final' || phase === 'rollout')) it.done = true;
          break;
        case 'flaps_full':
          if (c.flapsIdx >= this.spec.flapDetents - 1 && phase === 'final') it.done = true;
          break;
        case 'reverse_thrust':
          if (c.reverse && phase === 'rollout') it.done = true;
          break;
        case 'wheel_brakes':
          if (c.brake > 0.25 && phase === 'rollout') it.done = true;
          break;
      }
    }
  }

  toggleChecklistItem(id: string) {
    const it = this.checklistItems.find((x) => x.id === id);
    if (it) {
      it.done = !it.done;
      if (it.done) {
        this.audio.chirp();
        this.toast(`Checklist: ${it.label} COMPLETED +25`, 'good');
        this.addScore('Checklist item', 25);
      }
    }
  }

  autoCompletePhaseChecklist(phase?: FlightPhase) {
    const p = phase || this.currentFlightPhase;
    const items = this.checklistItems.filter((x) => x.phase === p);
    let newlyDone = 0;
    for (const it of items) {
      if (!it.done) {
        it.done = true;
        newlyDone++;
      }
    }
    if (newlyDone > 0) {
      this.audio.chirp();
      this.toast(`Checklist: ${p.toUpperCase()} PHASE COMPLETED +${newlyDone * 25}`, 'good');
      this.addScore(`${p.toUpperCase()} checklist completed`, newlyDone * 25);
    }
  }
  dispose() {
    cancelAnimationFrame(this.raf); this.disposeScenario(); this.stopRadio();
    window.removeEventListener('resize', this.resize); window.removeEventListener('keydown', this.onKeyDown); window.removeEventListener('keyup', this.onKeyUp); window.removeEventListener('blur', this.onBlur);
    this.renderer.dispose();
    if ((window as any).sim === this) delete (window as any).sim;
  }

  // ---- helpers ----
  lat() { return this.world!.proj.lat(this.fm.pos.z); }
  lon() { return this.world!.proj.lon(this.fm.pos.x); }
  /** Air-mass velocity at `alt` metres above ground: real winds aloft interpolated through the METAR / pressure-level profile. */
  private oat() { const fm = this.fm; if (this.liveWx?.ok && this.liveWx.layers.length) return Math.round(windProfile(this.liveWx, fm.pos.y, fm.agl, this.wxTmp).tempC); return Math.round(atmosphere(fm.pos.y).T - 273.15); }
  private windVec(alt: number) {
    if (this.liveWx && this.liveWx.ok) return windVector(this.liveWx, (this.fm ? this.fm.groundH : 0) + alt, alt, this.windTmp);
    const k = 1 + clamp(alt / 2500, 0, 1.6), toward = (this.windFrom + 180) * D2R, v = this.windKt * 0.514444 * k;
    return this.windTmp.set(Math.sin(toward) * v, 0, -Math.cos(toward) * v);
  }
  private rebaseTo(lat: number, lon: number) {
    const w = this.world!, oldP = w.proj, np = new Projection(lat, lon);
    const dx = this.fm ? np.x(oldP.lon(this.fm.pos.x)) - this.fm.pos.x : 0, dz = this.fm ? np.z(oldP.lat(this.fm.pos.z)) - this.fm.pos.z : 0;
    if (this.fm) { const la = oldP.lat(this.fm.pos.z), lo = oldP.lon(this.fm.pos.x); this.fm.pos.x = np.x(lo); this.fm.pos.z = np.z(la); }
    w.rebase(np, lat, lon); this.effects?.shift(dx, dz); this.chaseInit = false;
    if (this.depTh) this.depTh = null;
  }
  setView(v: ViewId) {
    this.viewIdx = VIEWS.indexOf(v); this.lookYaw = 0; this.lookPitch = 0; this.orbitYaw = 0; this.orbitPitch = 0.12; this.cockpit?.resetLook();
    this.visual?.setInterior(this.isInterior());
  }
  resetView() {
    this.lookYaw = this.lookPitch = this.orbitYaw = 0;
    this.orbitPitch = 0.12;
    this.zoom = 1;
    this.chaseInit = false;
    if (this.cockpit) {
      this.cockpit.setPreset('pilot'); this.cockpit.resetZoom();
    }
  }
  cycleView() { this.setView(VIEWS[(this.viewIdx + 1) % VIEWS.length]); this.audio.click(); this.toast(`Camera: ${this.viewName()}`, 'info'); }
  viewName() { return { cockpit: 'Cockpit', chase: 'Chase', spotter: 'Spotter', aisle: 'Cabin – aisle', window: 'Cabin – window seat' }[VIEWS[this.viewIdx]]; }
  isInterior() { const v = VIEWS[this.viewIdx]; return v === 'cockpit' || v === 'aisle' || v === 'window'; }
  toast(text: string, level: Toast['level'] = 'info') { this.hooks.onToast({ id: this.toastId++, text, level }); }
  private addScore(label: string, pts: number, silent = false) { this.score += pts; if (!silent) this.items.push({ label, pts }); }
  private penalize(key: string, label: string, pts: number, cooldown = 6) {
    const t = this.time; if (t - (this.warnPenalty[key] ?? -99) < cooldown) return;
    this.warnPenalty[key] = t; this.score -= pts; this.items.push({ label, pts: -pts });
  }

  // =====================================================================================
  //  Flow control
  // =====================================================================================
  begin() { // after loading screen
    this.audio.start(); this.setPhase('playing'); this.last = performance.now();
    if (this.mode === 'play') {
      this.toast(`${this.cfg.from.icao} → ${this.cfg.to.icao}  ·  ${this.spec.name}`, 'info');
      if (this.cfg.settings.startMode === 'runway' && this.spawn) {
        this.toast(`Parked at ${this.spawn.label} · cold & dark. Press [I] to power up: battery → ${this.spec.kind === 'piston' ? 'mixture → ' : ''}beacon → engines${this.spawn.pushback ? ' · [F5] pushback' : ''}`, 'info');
        this.toast(`Live weather: ${wxSummary(this.liveWx)}`, 'info');
      }
    }
  }
  setPhase(p: Phase) {
    if (this.phase === p) return; this.phase = p;
    // flight over / reloading: nothing on the frequency is relevant any more
    if (p === 'crashed' || p === 'complete' || p === 'loading') this.radio.cancel();
    this.radio.setPaused(!this.radioMayTransmit());
    this.hooks.onPhase(p);
  }
  /** True only while the player is actually flying (not paused, in a menu, loading or in a hidden tab). */
  private radioMayTransmit() { return this.mode === 'play' && this.phase === 'playing' && !this.suspended && !document.hidden && !!this.world; }
  pause() { if (this.phase !== 'playing') return; this.clearInput(); this.setPhase('paused'); this.audio.silence(); }
  /** Hard stop of all voice traffic and sound: back to the menu / planner / a new scenario. */
  stopRadio() { this.radio.cancel(); this.audio.silence(); this.radio.setPaused(true); }
  resume() { if (this.phase !== 'paused') return; this.setPhase('playing'); this.last = performance.now(); }
  restart() {
    if (!this.world) return;
    const sm = this.cfg.settings.startMode;
    this.resetFlight(sm); this.setView(this.cfg.settings.startMode === 'final' ? 'cockpit' : 'cockpit');
    this.effects?.update(0.1); this.setPhase('playing'); this.last = performance.now(); this.audio.start();
    this.toast('Flight restarted', 'info');
  }
  applySettings(s: Settings) {
    if (!this.cfg) return;
    const prevQuality = this.quality;
    this.cfg.settings = s;
    const qualityChanged = this.quality !== prevQuality;
    this.audio.voiceOn = s.voice; this.audio.setVolume(s.volume); this.audio.setMuted(s.muted);
    if (this.fm && !this.ap.on) this.fm.ctl.assist = s.assist;
    this.world?.setStyle(s.terrainStyle);
    this.world?.setQuality(this.quality);
    this.cockpit?.setQuality(this.quality);
    this.precip?.setQuality(this.qualityProfile.precipMax);
    if (qualityChanged) {
      // Start the new tier at full (already budget-limited) resolution, then let the
      // adaptive scaler settle it instead of inheriting a previous Low scale.
      this.dprScale = 1;
      this.dprCooldown = 1.2;
      this.emaFrameMs = 16.6;
    }
    this.resize();
  }
  setMuted(m: boolean) { this.audio.setMuted(m); this.cfg.settings.muted = m; }

  // =====================================================================================
  //  Input
  // =====================================================================================
  clearInput() {
    this.keys.clear(); this.axes.pitch = this.axes.roll = this.axes.yaw = 0; this.brakeAxis = 0;
    this.touch.pitch = this.touch.roll = this.touch.yaw = 0; this.touch.brake = false;
    this.yokeDrag = null; this.drag = null; this.pointers.clear(); this.restartHold = 0;
  }
  private onBlur = () => { this.clearInput(); };
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || (e.ctrlKey && e.key !== 'Control') || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    // Native keyboard navigation belongs to the focused UI, not to the flight controls.
    if (e.target instanceof HTMLElement && e.target.closest('[data-flight-ui]') && [' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return;
    if (/^Numpad[0-9]$/.test(e.code) && this.phase === 'playing' && this.mode === 'play' && this.cockpit && this.isInterior()) {
      const f = COCKPIT_FOCUS.find((x) => x.key === e.code.slice(6)); if (f) { e.preventDefault(); this.setCockpitSubview(f.id); return; } // keypad 0-9 = camera focus shortcuts
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'F1', 'F2', 'F3', 'F4', 'F5'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(k);
    if (this.mode === 'play' && (this.phase === 'paused' || this.phase === 'crashed' || this.phase === 'complete')) { if (k === 'r') this.restart(); else if ((k === 'p' || k === 'Escape') && this.phase === 'paused') this.resume(); return; }
    if (this.phase !== 'playing' || this.mode !== 'play') return;
    const c = this.fm.ctl;
    switch (k) {
      case 'p': case 'Escape': this.pause(); break;
      case 'g': this.action('gear'); break;
      case 'f': this.action('flaps+'); break; case 'v': this.action('flaps-'); break;
      case 'b': this.action('park'); break;
      case 't': this.action('rev'); break;
      case 'z': this.action('sb'); break;
      case 'l': this.action('land'); break; case 'o': this.action('strb'); break;
      case 'j': this.action('belt'); break; case 'k': this.action('pa'); break;
      case 'y': this.action('ap'); break; case 'n': this.action('apnav'); break; case 'u': this.action('appr'); break;
      case ',': this.action('hdg-'); break; case '.': this.action('hdg+'); break;
      case '[': this.action(e.shiftKey ? 'alt-big' : 'alt-'); break; case ']': this.action(e.shiftKey ? 'alt+big' : 'alt+'); break;
      case '-': this.action('spd-'); break; case '=': case '+': this.action('spd+'); break;
      case 'c': this.cycleView(); break; case 'm': this.hooks.onCommand(e.shiftKey ? 'fullMap' : 'map'); break;
      case 'h': this.hooks.onCommand('cycleHudMode'); break;
      case 'x': c.throttle = 0; break; case 'Home': this.resetView(); break;
      case 'i': if (e.shiftKey) this.shutdownEngines(); else this.startSequence(); break;
      case 'F1': c.throttle = 0; break; case 'F2': c.throttle = clamp(c.throttle - 0.1, 0, 1); break; case 'F3': c.throttle = clamp(c.throttle + 0.1, 0, 1); break; case 'F4': c.throttle = 1; break;
      case 'F5': this.startPushback(); break;
      case '\\': this.cycleWarp(); break;
      case 'r': this.restartHold = 0.0001; break;
      default:
        if (this.radioMenuOpen && ['1', '2', '3', '4'].includes(k)) {
          this.respondAtc(Number(k));
          break;
        }
        if (/^[0-9]$/.test(k)) { c.throttle = k === '0' ? 1 : Number(k) / 10; this.ap.on && this.syncAp(); }
    }
  };
  private onKeyUp = (e: KeyboardEvent) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; this.keys.delete(k); if (k === 'r') this.restartHold = 0; };
  private syncAp() { /* manual throttle while AP: autothrottle will track again */ }

  /** Central action dispatcher (keys, cockpit buttons, HUD / touch buttons). */
  action(id: string) {
    if (!this.fm || this.mode !== 'play' || this.phase !== 'playing') return;
    const c = this.fm.ctl, s = this.spec, a = this.audio;
    switch (id) {
      case 'start': this.startSequence(); break;
      case 'stop': this.shutdownEngines(); break;
      case 'pushback': this.startPushback(); break;
      case 'gear': if (s.fixedGear) { this.toast('Fixed undercarriage – the Skyhawk has no retractable gear', 'info'); break; } c.gearDown = !c.gearDown; a.gearClunk(); this.toast(c.gearDown ? 'Gear DOWN' : 'Gear UP', 'info'); if (!c.gearDown && this.fm.wow) { c.gearDown = true; this.toast('Gear cannot retract on the ground', 'warn'); } break;
      case 'flaps+': if (c.flapsIdx < s.flapDetents) { c.flapsIdx++; a.click(); this.toast(`Flaps ${c.flapsIdx}`, 'info'); } break;
      case 'flaps-': if (c.flapsIdx > 0) { c.flapsIdx--; a.click(); this.toast(`Flaps ${c.flapsIdx}`, 'info'); } break;
      case 'park': c.parking = !c.parking; a.click(); this.toast(c.parking ? 'Parking brake ON' : 'Parking brake released', 'info'); break;
      case 'rev': if (s.hasReverse) { c.reverse = !c.reverse; a.click(); this.toast(c.reverse ? 'Reverse thrust armed' : 'Reverse thrust off', 'info'); } break;
      case 'sb': if (s.hasSpeedbrake) { c.speedbrake = c.speedbrake > 0.5 ? 0 : 1; a.click(); this.toast(c.speedbrake > 0.5 ? 'Spoilers deployed' : 'Spoilers retracted', 'info'); } break;
      case 'land': this.lights.land = !this.lights.land; a.click(); break;
      case 'nav': this.lights.nav = !this.lights.nav; a.click(); break;
      case 'bcn': this.lights.beacon = !this.lights.beacon; a.click(); break;
      case 'strb': this.lights.strobe = !this.lights.strobe; this.lights.beacon = this.lights.strobe || this.lights.beacon; a.click(); break;
      case 'belt': this.seatbelt = !this.seatbelt; a.chime(); this.toast(this.seatbelt ? 'Seat belt sign ON' : 'Seat belt sign OFF', 'info'); break;
      case 'pa': this.announce(); break;
      case 'ap': this.toggleAp(); break;
      case 'apnav':
        if (!this.ap.on) this.toggleAp(); // engaging already selects NAV
        else { this.ap.setLateralMode(this.ap.nav ? 'heading' : 'nav'); a.click(); this.toast(this.ap.nav ? 'NAV: tracking route to destination' : 'HDG mode', 'info'); }
        break;
      case 'aphdg':
        if (!this.ap.on) this.toggleAp();
        this.ap.setLateralMode('heading'); a.click();
        break;
      case 'appr': this.toggleAppr(); break;
      case 'hdg-': this.ap.hdg = wrap360(this.ap.hdg - 5); this.ap.setLateralMode('heading'); a.click(); break;
      case 'hdg+': this.ap.hdg = wrap360(this.ap.hdg + 5); this.ap.setLateralMode('heading'); a.click(); break;
      case 'alt-': this.ap.altFt = Math.max(0, this.ap.altFt - 100); a.click(); break;
      case 'alt+': this.ap.altFt = Math.min(45000, this.ap.altFt + 100); a.click(); break;
      case 'alt-big': this.ap.altFt = Math.max(0, this.ap.altFt - 1000); a.click(); break;
      case 'alt+big': this.ap.altFt = Math.min(45000, this.ap.altFt + 1000); a.click(); break;
      case 'spd-': this.ap.spd = Math.max(Math.round(s.vs1 * 1.2), this.ap.spd - 5); a.click(); break;
      case 'spd+': this.ap.spd = Math.min(Math.round(s.vne * 0.85), this.ap.spd + 5); a.click(); break;
      case 'warp': this.cycleWarp(); break;
      case 'rwy': this.cycleRunway(); break;
      case 'atc1': this.respondAtc(1); break;
      case 'atc2': this.respondAtc(2); break;
      case 'atc3': this.respondAtc(3); break;
      case 'atc4': this.respondAtc(4); break;
      case 'ackWarn': {
        // Acknowledge the same priority alert that the HUD presents.
        const top = this.warnState.find((w) => w.level === 'warning' && !this.ackedWarnings.has(w.text))
          ?? this.warnState.find((w) => !this.ackedWarnings.has(w.text));
        if (top) {
          this.ackedWarnings.add(top.text);
          this.toast(`Acknowledged: ${top.text}`, 'info');
        }
        break;
      }
      case 'hudMode': this.hooks.onCommand('cycleHudMode'); break;
      case 'pause': this.pause(); break;
    }
  }
  /** UI target edits use the same units and limits as the keyboard/cockpit selectors. */
  setApTarget(target: 'hdg' | 'alt' | 'spd', value: number) {
    if (!Number.isFinite(value) || this.mode !== 'play' || this.phase !== 'playing') return;
    if (target === 'hdg') {
      this.ap.hdg = wrap360(Math.round(value) + this.magv); this.ap.setLateralMode('heading');
    } else if (!(this.ap.on && (this.ap.nav || this.ap.appr))) {
      if (target === 'alt') this.ap.altFt = clamp(Math.round(value / 100) * 100, 0, 45000);
      else this.ap.spd = clamp(Math.round(value), Math.round(this.spec.vs1 * 1.2), Math.round(this.spec.vne * .85));
    }
    this.audio.click();
  }
  private toggleAp() {
    if (this.ap.on) {
      this.ap.disengage();
      this.fm.ctl.apHold = false;
      this.fm.ctl.assist = this.cfg.settings.assist;
      this.audio.apOff();
      this.toast('Autopilot OFF', 'warn');
      this.timeScale = 1;
    } else if (this.fm.wow) {
      const rwyHdg = this.depTh ? this.depTh.hdg : this.fm.heading;
      this.ap.armTakeoff(this.fm, rwyHdg, this.spec.vr, Math.max(1500, this.spec.cruiseAlt * 0.35));
      this.fm.ctl.assist = true;
      this.fm.ctl.apHold = true;
      this.usedAp = true;
      this.audio.apOn();
      this.toast(`Autopilot ENGAGED – AUTO-TAKEOFF RWY ${this.depRwy || Math.round(rwyHdg) + '°'}`, 'good');
    } else {
      this.ap.engage(this.fm);
      this.fm.ctl.assist = true;
      this.fm.ctl.apHold = true;
      this.usedAp = true;
      this.ap.nav = this.cfg.from.id !== this.cfg.to.id;
      this.audio.apOn();
      this.toast(this.ap.nav ? `Autopilot ENGAGED – LNAV tracking ${this.cfg.to.icao}` : 'Autopilot ENGAGED – holding heading, altitude and speed', 'good');
    }
  }
  private toggleAppr() {
    if (!this.ap.on) { if (this.fm.wow) return; this.toggleAp(); }
    const ils = this.computeIls();
    if (!this.ap.appr && !(ils && ils.valid)) { const t = this.approachTh(); this.toast(t && !this.ilsCapable(t) ? `Runway ${t.ident} has no ILS – visual approach only` : 'No ILS signal – fly within 30 nm of the destination runway', 'warn'); return; }
    this.ap.appr = !this.ap.appr; this.ap.nav = false; this.ap.gsCaptured = false;
    if (!this.ap.appr) this.ap.setLateralMode('heading');
    this.audio.click();
    this.toast(this.ap.appr ? `APPR armed – ILS ${ils?.ident}` : 'Approach mode off', this.ap.appr ? 'good' : 'info');
  }
  /** 1:1 real-time simulation: the simulation rate is fixed at 1x so in-game time always equals real time. */
  cycleWarp() {
    this.timeScale = 1;
    this.toast('Time compression is disabled – the simulation runs 1:1 with real time', 'info');
  }
  cycleRunway() {
    if (this.cfg.from === this.cfg.to) return;
    const ths = this.world!.thresholds(this.cfg.to); if (!ths.length) return;
    const current = this.apprKey || this.approachTh()?.ident;
    const i = ths.findIndex((t) => t.ident === current);
    this.setArrRunway(ths[(i + 1) % ths.length].ident);
  }
  private announce() {
    const fm = this.fm, a = this.audio, city = this.cfg.to.city || this.cfg.to.name;
    a.pa();
    if (!this.takeoffDone && !this.paEvents.welcome) {
      this.paEvents.welcome = true; this.seatbelt = true;
      a.speak(`Ladies and gentlemen, welcome aboard. Our flight to ${city}. Please fasten your seat belts for take off.`, 'pa', 1, 1, 1);
      this.toast('Cabin: welcome announcement made  +50', 'good'); this.addScore('Welcome announcement', 50);
      this.comfort = Math.min(100, this.comfort + 2);
    } else if (this.takeoffDone && !this.paEvents.landing && this.distToDest() < 60000 && fm.agl > 300) {
      this.paEvents.landing = true; this.seatbelt = true;
      a.speak('Cabin crew, prepare for landing. Passengers, please return to your seats and fasten your seat belts.', 'pa', 1, 1, 1);
      this.toast('Cabin: landing preparation announced  +100', 'good'); this.addScore('Landing announcement', 100);
      this.comfort = Math.min(100, this.comfort + 3);
    } else {
      a.speak(this.fm.nz > 1.3 || this.turb > 0.3 ? 'Ladies and gentlemen, we are experiencing some turbulence. Please remain seated.' : 'Ladies and gentlemen, this is your captain. We are cruising smoothly. Please enjoy the flight.', 'pa', 4, 1, 1);
      this.toast('Cabin: announcement made', 'info');
    }
  }

  // ---- pointer ----
  private lastHoverT = 0; private lastDX = 0; private lastDY = 0;
  private ndc(e: PointerEvent) { const r = this.canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();
    this.audio.start();
    if (this.phase !== 'playing') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture?.(e.pointerId);
    this.panning = e.button === 1 || (e.shiftKey && e.button === 0 && this.isInterior());
    if (!this.panning && (e.button === 0 || e.button === 2) && this.mode === 'play' && this.isInterior() && this.cockpit) {
      // Camera and controls are strictly separated: a click ALWAYS operates the control under the cursor (no double-click gesture any more),
      // dragging empty space looks around, and Alt + click only frames the control's panel without touching it. Dedicated focus buttons / keypad keys
      // (COCKPIT_FOCUS) fly to the panels.
      const cam = this.cockpit.activeCamera; cam.updateMatrixWorld(); this.raycaster.setFromCamera(this.ndc(e), cam);
      if (e.altKey && e.button === 0) { if (this.cockpit.focusAt(this.raycaster)) { this.audio.click(); return; } }
      const hit = this.cockpit.press(this.raycaster, e.button, e.shiftKey);
      if (hit) {
        const c = this.fm.ctl;
        if (hit.handled) { this.audio.click(); this.drag = { id: 'cockpit', sx: e.clientX, sy: e.clientY, v: 0 }; return; }
        switch (hit.id) {
          case 'throttle': this.drag = { id: 'throttle', sx: e.clientX, sy: e.clientY, v: c.throttle }; return;
          case 'flaps': this.drag = { id: 'flaps', sx: e.clientX, sy: e.clientY, v: c.flapsIdx }; return;
          case 'speedbrake': this.drag = { id: 'speedbrake', sx: e.clientX, sy: e.clientY, v: c.speedbrake }; return;
          case 'yoke': this.drag = { id: 'yoke', sx: e.clientX, sy: e.clientY, v: 0 }; this.yokeDrag = { pitch: 0, roll: 0 }; return;
          case 'pax': this.chatWithPassenger(); return;
          default: this.action(hit.id); return;
        }
      }
    }
    this.drag = { id: 'look', sx: e.clientX, sy: e.clientY, v: 0, look: true };
    this.freelookActive = true;
  };
  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) {
      if (this.mode === 'play' && this.isInterior() && this.cockpit && this.phase === 'playing') {
        const nowH = performance.now();
        if (nowH - this.lastHoverT > 30) {
          this.lastHoverT = nowH;
          const cam = this.cockpit.activeCamera; cam.updateMatrixWorld(); this.raycaster.setFromCamera(this.ndc(e), cam);
          const hv = this.cockpit.hover(this.raycaster);
          this.cockpitTooltip = hv ? { id: hv.id, label: hv.label, value: hv.value, actionHint: hv.hint, description: hv.desc, x: e.clientX, y: e.clientY } : null;
        }
      } else {
        this.cockpitTooltip = null;
      }
      return;
    }
    this.cockpitTooltip = null; // no hover badge while a drag / look gesture is in progress
    const c = this.fm?.ctl; const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    switch (d.id) {
      case 'cockpit': { const p = this.pointers.get(e.pointerId); const mx = p ? e.clientX - p.x : dx - (this.lastDX ?? 0), my = p ? e.clientY - p.y : dy - (this.lastDY ?? 0); if (p) { p.x = e.clientX; p.y = e.clientY; } this.cockpit?.drag(mx, my); break; }
      case 'throttle': c.throttle = clamp(d.v - dy / 170, 0, 1); break;
      case 'flaps': c.flapsIdx = clamp(Math.round(d.v + dy / 34), 0, this.spec.flapDetents); break;
      case 'speedbrake': c.speedbrake = clamp(d.v - dy / 110, 0, 1); break;
      case 'yoke': this.yokeDrag = { pitch: clamp(dy / 80, -1, 1), roll: clamp(dx / 80, -1, 1) }; break;
      case 'look': {
        this.freelookActive = true;
        const p = this.pointers.get(e.pointerId); const mx = p ? e.clientX - p.x : 0, my = p ? e.clientY - p.y : 0;
        if (p) { p.x = e.clientX; p.y = e.clientY; }
        if (this.isInterior()) { if (this.panning) this.cockpit?.panBy(mx, my); else this.cockpit?.lookBy(mx, my); }
        else { this.orbitYaw -= mx * 0.006; this.orbitPitch = clamp(this.orbitPitch + my * 0.005, -0.3, 1.3); }
      }
    }
  };
  private onPointerUp = (e: PointerEvent) => {
    if (this.drag?.id === 'look' && this.isInterior()) this.cockpit?.endLook();
    this.cockpit?.release();
    this.pointers.delete(e.pointerId);
    this.drag = null;
    this.yokeDrag = null;
    this.freelookActive = false;
  };
  private onWheel = (e: WheelEvent) => {
    if (this.mode === 'play' && this.isInterior() && this.cockpit) {
      const cam = this.cockpit.activeCamera; cam.updateMatrixWorld(); const r = this.canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
      if (e.ctrlKey || !this.cockpit.wheel(this.raycaster, e.deltaY, e.shiftKey)) this.cockpit.zoomBy(e.deltaY); // knob under the cursor turns it (not mid-zoom, not with Ctrl), otherwise smooth zoom
      return;
    }
    this.zoom = clamp(this.zoom * (1 + e.deltaY * 0.0012), 0.4, 3);
  };
  private chatWithPassenger() {
    const m = this.comfort / 100;
    const good = ['“Smooth flight, Captain – thank you!”', '“The view is incredible up here!”', '“Best landing I ever felt… so far!”', '“Can I visit the cockpit later?”'];
    const bad = ['“Could you please be a bit gentler?”', '“I think I left my stomach back at the airport…”', '“Is this normal?!”', '“We would like to land. Now.”'];
    const msg = (m > 0.55 ? good : bad)[(Math.random() * 4) | 0]; this.setCabinMsg(msg); this.audio.chirp(); this.toast(`Passenger: ${msg}`, m > 0.55 ? 'good' : 'warn');
    if (m > 0.55) this.comfort = Math.min(100, this.comfort + 0.5);
  }
  private setCabinMsg(m: string) { this.cabinMsg = m; this.cabinMsgT = 6; }

  // =====================================================================================
  //  Navigation helpers
  // =====================================================================================
  distToDest() { return haversine(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon); }
  /**
   * Two-leg approach path: current position → gate on the extended centreline → threshold.
   * This is what makes NAV (and the magenta line on the map) turn onto final instead
   * of driving diagonally into the runway end from any direction.
   */
  private navWaypoints(th: Threshold): [number, number][] {
    const w = this.world!;
    const thr: [number, number] = [w.proj.lat(th.z), w.proj.lon(th.x)];
    const cur: [number, number] = [this.lat(), this.lon()];
    const h = th.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h);
    // Distance still to run before the threshold along the landing direction.
    const along = -((this.fm.pos.x - th.x) * fx + (this.fm.pos.z - th.z) * fz);
    if (along > 0) {
      // Join final progressively: far out the intercept is capped at 18 km;
      // closer in it is halfway to the threshold. NAV therefore keeps turning
      // onto the centreline even when the aircraft is already inside 18 km,
      // instead of pointing straight at the runway end again.
      const intercept = clamp(along * 0.5, 1200, FINAL_GATE_M);
      if (along > intercept + 500) {
        const point = destination(thr[0], thr[1], th.hdg + 180, intercept);
        if (haversine(cur[0], cur[1], point[0], point[1]) > 700) return [point, thr];
      }
    }
    return [thr];
  }
  /** NAV aims at active flight plan waypoint, or approach gate, then runway threshold. */
  private navBearing() {
    if (this.flightPlan.length > 0 && this.activeWpIdx < this.flightPlan.length) {
      const targetWp = this.flightPlan[this.activeWpIdx];
      return bearing(this.lat(), this.lon(), targetWp.lat, targetWp.lon);
    }
    const th = this.approachTh();
    if (!th) return bearing(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon);
    const wps = this.navWaypoints(th);
    let target = wps[0];
    if (wps.length > 1 && haversine(this.lat(), this.lon(), target[0], target[1]) < 700) target = wps[1];
    return bearing(this.lat(), this.lon(), target[0], target[1]);
  }
  private approachTh(): Threshold | null {
    const w = this.world!, ths = w.thresholds(this.cfg.to); if (!ths.length) return null;
    if (this.apprKey) { const t = ths.find((x) => x.ident === this.apprKey); if (t) return t; }
    return this.bestApproach(this.cfg.to, this.cfg.from);
  }
  /**
   * Instrument approach availability. Open data does not list ILS installations, so a precision approach is only offered
   * on runways that could realistically carry one: paved, lit and at least 1,200 m. Strips, grass and dirt are visual only.
   */
  ilsCapable(th: Threshold) { return (th.surface === 'A' || th.surface === 'C') && th.lit && th.fullLen >= 1200; }
  computeIls(): (IlsData & { valid: boolean }) | null {
    const th = this.approachTh(); if (!th) return null; const fm = this.fm;
    const h = th.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const rx0 = fm.pos.x - th.x, rz0 = fm.pos.z - th.z;
    const along = rx0 * fx + rz0 * fz, dist = -along, cross = rx0 * rx + rz0 * rz;
    const angle = Math.atan2(fm.pos.y - (th.elev + 15), Math.max(1, dist)) * R2D;
    const locAngle = Math.atan2(cross, Math.max(80, Math.abs(dist))) * R2D;
    const aligned = Math.abs(wrap180(fm.heading - th.hdg)) < 100;
    const valid = this.ilsCapable(th) && dist > -1500 && dist < 55500 && (dist < 0 || Math.abs(locAngle) < 35) && aligned;
    return { valid, dist, cross, locDots: -locAngle / 1.25, gsDots: dist > 0 ? (3 - angle) / 0.35 : 0, course: th.hdg, elev: th.elev, x: th.x, z: th.z, ident: `${this.cfg.to.icao} ${th.ident}`, angle };
  }
  /** Write only the live physics pose into reusable chart storage; no route/ILS allocations. */
  readMapPose(out: Pick<MapState, 'lat' | 'lon' | 'hdg' | 'track' | 'altFt'>): boolean {
    if (!this.world || !this.fm) return false;
    out.lat = this.lat(); out.lon = this.lon(); out.hdg = this.fm.heading;
    out.track = this.fm.track; out.altFt = this.fm.pos.y / 0.3048;
    return true;
  }
  /** An opaque chart hides 3D, never the flight model, streaming, radio or warning systems. */
  mapOnly = false;

  getMapState(): MapState {
    const th = this.approachTh();
    const appr = th ? { lat: this.world!.proj.lat(th.z), lon: this.world!.proj.lon(th.x), hdg: th.hdg, ident: th.ident, ils: this.ilsCapable(th) } : null;
    const navPath = th ? this.navWaypoints(th) : [];
    return {
      lat: this.lat(),
      lon: this.lon(),
      hdg: this.fm.heading,
      track: this.fm.track,
      from: this.cfg.from,
      to: this.cfg.to,
      trail: this.trail,
      altFt: this.fm.pos.y / 0.3048,
      depRwy: this.depRwy,
      apprRwy: this.apprKey,
      appr,
      navPath,
      flightPlan: this.flightPlan,
      activeWpIdx: this.activeWpIdx,
    };
  }

  // =====================================================================================
  //  Main loop
  // =====================================================================================
  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const frameMs = now - this.last;
    const rdt = Math.min(0.05, Math.max(0.0001, frameMs / 1000)); this.last = now;
    this.ticks++;
    if (!this.world || this.suspended) return;
    // Auto-60FPS adaptive resolution. Runs in the attract/loading views too, because a slow
    // first impression is just as bad as a slow flight. Frame gaps from tab switches are ignored.
    const perfActive = !this.mapOnly && !document.hidden && (this.phase === 'playing' || this.phase === 'loading' || this.mode === 'attract');
    if (perfActive && frameMs > 4 && frameMs < 90) {
      this.emaFrameMs = this.emaFrameMs * 0.90 + frameMs * 0.10;
      this.dprCooldown -= rdt;
      if (this.dprCooldown <= 0) {
        const floor = QUALITY[this.quality].minPixelScale;
        if (this.emaFrameMs > 17.6 && this.dprScale > floor + 0.001) {
          const step = this.emaFrameMs > 24 ? 0.15 : 0.08;
          this.dprScale = Math.max(floor, +(this.dprScale - step).toFixed(2));
          this.dprCooldown = this.emaFrameMs > 24 ? 0.75 : 1.3;
          this.resize();
        } else if (this.emaFrameMs < 14.2 && this.dprScale < 1) {
          this.dprScale = Math.min(1, +(this.dprScale + 0.05).toFixed(2));
          this.dprCooldown = 3.0;
          this.resize();
        }
      }
    }
    // Init is async: until the flight model and visual exist (e.g. while a failed/hot-reloading
    // init is still pending) the phase branches below cannot run — render the frame and wait.
    if (!this.fm || !this.visual) { this.render(); return; }
    if (this.phase === 'loading') {
      const t = this.world.terrain, waited = (now - this.loadStart) / 1000;
      this.world.update(this.camera, this.fm.pos, 1, this.time);
      this.attractCamera(rdt); this.render();
      if ((t.nearReady() && waited > 1.2) || waited > (t.offline ? 4 : 11)) { this.setPhase('idle'); this.hooks.onHud(this.hud()); }
      else if (this.ticks % 6 === 0) this.hooks.onHud(this.hud());
      return;
    }
    if (this.mode === 'attract') { this.time += rdt; this.attractCamera(rdt); this.world.update(this.camera, this.fm.pos, 1, this.time); this.visual?.update(this.fm, rdt, this.time, this.lights); this.visual!.root.position.copy(this.fm.pos); this.visual!.root.quaternion.copy(this.fm.quat); this.effects?.update(rdt); this.render(); return; }
    // The radio may only transmit while a real flight is running (not paused, in a menu, loading,
    // in the attract scene or in a hidden tab). Checked per frame — covers every state change for free.
    this.radio.setPaused(!this.radioMayTransmit());
    if (this.phase === 'playing') { this.simulate(rdt); this.tickAmbient(rdt); }
    else if (this.phase === 'crashed' || this.phase === 'complete') this.postEnd(rdt);
    else if (this.phase === 'paused') { this.audio.update(this.audioState(true), rdt); }
    // While the full-screen chart covers the cockpit the HUD is invisible: 4 Hz is plenty and spares React ~7 re-renders/s.
    this.hudT += rdt; if (this.hudT > (this.mapOnly ? 0.25 : 0.09)) { this.hudT = 0; this.hooks.onHud(this.hud()); }
    if (this.mapOnly) {
      this.updateCamera(rdt);
      if (this.phase === 'playing') this.audio.update(this.audioState(false), rdt);
    } else {
      this.updateVisuals(rdt);
      this.render();
    }
  };
  private render() {
    const r = this.renderer;
    r.clear();
    if (!this.world) return;
    const deck = this.mode === 'play' && this.isInterior() && this.cockpit && this.phase !== 'loading' ? this.cockpit : null;
    if (deck && deck.canMask && this.emaFrameMs > 9.5) {
      // Flight-deck occlusion: stamp the opaque deck into the stencil buffer, then draw the world only where the stencil is still 0 (through the windows).
      // The stencil state is LOCKED so every world material – streamed tiles included – obeys it without touching any material.
      deck.renderMask(r);
      const st = r.state.buffers.stencil, gl = r.getContext();
      r.clearDepth(); st.setTest(true); st.setMask(0); st.setFunc(gl.NOTEQUAL, 1, 0xff); st.setOp(gl.KEEP, gl.KEEP, gl.KEEP); st.setLocked(true);
      try { r.render(this.world.scene, this.camera); } finally { st.setLocked(false); st.setTest(false); st.setMask(0xff); }
    } else r.render(this.world.scene, this.camera);
    if (deck) { r.clearDepth(); r.render(deck.activeScene, deck.activeCamera); }
  }

  private attractCamera(dt: number) {
    this.time += dt * 0.0; const t = performance.now() / 1000;
    const fm = this.fm, L = this.spec.length;
    const ang = t * 0.12 + 0.6, r = L * 1.5 + 12, hgt = 3 + L * 0.12 + Math.sin(t * 0.2) * 1.2;
    this.camera.position.set(fm.pos.x + Math.cos(ang) * r, fm.pos.y + hgt - 1.2, fm.pos.z + Math.sin(ang) * r);
    this.camera.lookAt(fm.pos.x, fm.pos.y + L * 0.05, fm.pos.z); this.camera.fov = 50; this.camera.updateProjectionMatrix();
    this.visual!.root.position.copy(fm.pos); this.visual!.root.quaternion.copy(fm.quat); this.visual!.setInterior(false); this.visual!.update(fm, dt, t, { ...this.lights, land: true, strobe: true });
  }

  private applyControls(dt: number) {
    const fm = this.fm, c = fm.ctl, s = this.spec, set = this.cfg.settings;
    const k = this.keys; const inv = set.invertPitch ? -1 : 1;
    const raw = {
      pitch: ((k.has('s') || k.has('ArrowDown') ? 1 : 0) - (k.has('w') || k.has('ArrowUp') ? 1 : 0)) * inv,
      roll: (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0),
      yaw: (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0),
    };
    // Gentler, finer keyboard slews (full deflection in ~0.55 s, centre in ~0.2 s) – the old 0.3 s ramp made precise flying impossible.
    const upBase = 1.8 * set.sens, down = 5;
    for (const ax of ['pitch', 'roll', 'yaw'] as const) {
      const up = ax === 'yaw' ? upBase * 1.5 : upBase;
      const cur = this.axes[ax], tgt = raw[ax]; const rate = Math.abs(tgt) > Math.abs(cur) || Math.sign(tgt) !== Math.sign(cur) ? up : down;
      this.axes[ax] = cur + clamp(tgt - cur, -rate * dt, rate * dt);
    }
    // gamepad
    const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
    if (gp) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      this.pad = { roll: dz(gp.axes[0] || 0), pitch: dz(gp.axes[1] || 0) * inv, yaw: dz(gp.axes[2] || 0) };
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0; c.throttle = clamp(c.throttle + (rt - lt) * 0.5 * dt, 0, 1);
      const edge = (i: number, id: string) => { const p = !!gp.buttons[i]?.pressed; if (p && !(this as any)['_gp' + i]) this.action(id); (this as any)['_gp' + i] = p; };
      edge(0, 'gear'); edge(1, 'park'); edge(4, 'flaps-'); edge(5, 'flaps+'); edge(3, 'pa'); edge(2, 'ap');
      // D-pad for ATC quick responses: 12: Up -> atc1, 13: Down -> atc2, 14: Left -> atc3, 15: Right -> atc4
      edge(12, 'atc1'); edge(13, 'atc2'); edge(14, 'atc3'); edge(15, 'atc4');
      edge(8, 'hudMode'); edge(9, 'pause');
    }
    const expo = (x: number) => x * 0.65 + x * x * x * 0.35;
    let pitch = clamp(expo(this.axes.pitch) + this.touch.pitch * inv + this.pad.pitch + (this.yokeDrag ? this.yokeDrag.pitch : 0), -1, 1);
    let roll = clamp(expo(this.axes.roll) + this.touch.roll + this.pad.roll + (this.yokeDrag ? this.yokeDrag.roll : 0), -1, 1);
    let yaw = clamp(this.axes.yaw + this.touch.yaw + this.pad.yaw, -1, 1);
    // On the ground the left/right keys are the nose-wheel tiller (A/D, arrows, stick) below ~30 kt, blending into ailerons + rudder by ~55 kt
    if (fm.wow && !this.ap.on) {
      const tl = clamp(1 - (fm.gs * MS_TO_KT - 30) / 25, 0, 1);
      yaw = clamp(yaw + roll * tl, -1, 1); roll *= 1 - tl;
    }
    // throttle keys
    const thrUp = k.has('Shift') || k.has('PageUp'), thrDn = k.has('Control') || k.has('PageDown');
    if (thrUp) c.throttle = clamp(c.throttle + 0.5 * dt, 0, 1); if (thrDn) c.throttle = clamp(c.throttle - 0.5 * dt, 0, 1);
    if (k.has('Insert')) c.trim = clamp(c.trim + 0.3 * dt, -1, 1); if (k.has('Delete')) c.trim = clamp(c.trim - 0.3 * dt, -1, 1);
    // brakes
    const brakeTgt = k.has(' ') || this.touch.brake ? 1 : 0; this.brakeAxis += clamp(brakeTgt - this.brakeAxis, -dt * 8, dt * 5); c.brake = this.brakeAxis;
    // differential braking: hard tiller input while braking at taxi speed tightens the turn
    c.brakeL = fm.wow && fm.gs < 12 && c.brake > 0.1 ? Math.max(0, -yaw) * 0.7 : 0; c.brakeR = fm.wow && fm.gs < 12 && c.brake > 0.1 ? Math.max(0, yaw) * 0.7 : 0;
    // FMS waypoint sequencing (geometric fly-by logic, see lnav.ts). It runs whenever the aircraft is flying - with or
    // without the autopilot - and never targets a fix behind the aircraft (the old capture-radius rule did, which sent the
    // aircraft back to the departure runway when the autopilot was engaged after a manual take-off).
    if (this.flightPlan.length > 0 && (!fm.wow || this.ap.on)) {
      const next = advanceWaypoint(this.flightPlan, this.activeWpIdx, this.lat(), this.lon(), Math.max(20, fm.gs), !fm.wow);
      if (next !== this.activeWpIdx) {
        this.activeWpIdx = next;
        if (this.ap.on && this.flightPlan[next]) this.toast(`WPT SEQ: ${this.flightPlan[next].name}`, 'info');
      }
    }
    // autopilot
    const manual = Math.abs(pitch) > 0.55 || Math.abs(roll) > 0.55;
    if (this.ap.on) {
      this.apOverride = manual ? this.apOverride + dt : 0;
      if (this.apOverride > 0.35) {
        this.toggleAp();
      } else if (this.ap.on) {
        const ils = this.computeIls();
        const brg = this.navBearing();
        const cmd = this.ap.step(fm, dt, brg, ils, this.flightPlan, this.activeWpIdx, this.lat(), this.lon());
        pitch = isFinite(cmd.pitch) ? cmd.pitch : 0;
        roll = isFinite(cmd.roll) ? cmd.roll : 0;
        if (cmd.throttle !== null && isFinite(cmd.throttle)) c.throttle = cmd.throttle;
        if (cmd.yaw !== undefined && isFinite(cmd.yaw)) c.yaw = cmd.yaw;
        if (cmd.gearDown !== undefined) c.gearDown = cmd.gearDown;
        if (cmd.flapsIdx !== undefined) c.flapsIdx = cmd.flapsIdx;
        if (cmd.brake !== undefined && cmd.brake > 0) c.brake = Math.max(c.brake, cmd.brake);
        if (cmd.parking) c.parking = true;
        if (cmd.reverse !== undefined) c.reverse = cmd.reverse;
        if (cmd.speedbrake !== undefined) c.speedbrake = cmd.speedbrake;

        if (this.ap.phase === 'stopped') {
          c.apHold = false;
          c.assist = set.assist;
          this.toast('Autoland complete – Aircraft stopped & parked', 'good');
        }
      }
    }
    if (!this.ap.on) c.yaw = yaw;
    c.pitch = pitch; c.roll = roll;
    if (!fm.wow && !this.ap.on) c.assist = set.assist;
    if (this.ap.on) c.assist = true;
    // reverse thrust only on ground
    if (!fm.wow && c.reverse) c.reverse = false;
    void s;
  }

  private simulate(rdt: number) {
    const fm = this.fm, w = this.world!; const dt = rdt;
    this.time += dt;
    const kias = fm.ias / 0.514444;
    if (dt > 0.001) {
      const accel = (kias - this.prevKias) / dt;
      this.speedTrendSmoothed = this.speedTrendSmoothed * 0.88 + accel * 6 * 0.12;
      this.prevKias = kias;
    }
    this.applyControls(dt);
    // time warp safety
    if (this.timeScale > 1 && (!this.ap.on || fm.agl < 300 || this.distToDest() < 30000)) { this.timeScale = 1; this.toast('Time warp ended', 'info'); }
    // atmosphere / gusts
    const alt = Math.max(0, fm.agl);
    const gustScale = this.turb * (alt < 800 ? 1 + (800 - alt) / 800 * 0.8 : 1) * (this.spec.kind === 'jet' ? 0.75 : 1);
    this.gustPhase += dt;
    const gp = this.gustPhase;
    this.gust.set((Math.sin(gp * 0.9) + Math.sin(gp * 2.3 + 1)) * 1.6, (Math.sin(gp * 1.3 + 2) + Math.sin(gp * 3.1)) * 1.8, (Math.sin(gp * 1.1 + 4) + Math.sin(gp * 2.7)) * 1.6).multiplyScalar(gustScale);
    fm.gust.copy(this.gust); fm.turb = gustScale;
    fm.wind.copy(this.windVec(fm.pos.y - fm.groundH));
    // physics
    // pushback tug: pulls the aircraft straight back along the stand lead-out line (parking brake released, ~1.6 m/s, ~40 m)
    if (this.pushback.active && this.spawn) {
      this.pushback.t += dt; const v = Math.min(1.6, this.pushback.t * 0.9) * (this.pushback.t > 24 ? Math.max(0, 1 - (this.pushback.t - 24) * 0.9) : 1), pd = this.spawn.pushDir * D2R;
      fm.ctl.parking = false; fm.ctl.brake = 0; fm.ctl.throttle = 0;
      fm.vel.x = Math.sin(pd) * v; fm.vel.z = -Math.cos(pd) * v; fm.w.y = 0;
      if (this.pushback.t > 25) { this.pushback = { active: false, t: 0, done: true }; fm.ctl.parking = true; fm.vel.set(0, 0, 0); this.addAtc('GROUND', `${this.callsign.callsign}, pushback complete, tug disconnected – set parking brake. Report ready to taxi.`, false); this.toast('Pushback complete – set parking brake [B] and start engines [I]', 'good'); }
    }
    const h = 1 / 120; this.acc += dt * this.timeScale; let steps = 0;
    while (this.acc >= h && steps < 140) { fm.step(h); this.acc -= h; steps++; if (fm.events.length) this.handleEvents(); if (fm.crashed) break; }
    if (this.acc > h * 8) this.acc = 0;
    this.flightTime += dt * this.timeScale;
    if (fm.crashed) { this.crash(fm.crashReason); return; }
    // structural limits
    const gl = gLimits[this.spec.kind];
    if (fm.nz > gl.p * 1.3 || fm.nz < gl.n * 1.4) { this.crash('Structural failure – airframe overstressed'); return; }
    if (fm.ias / 0.514444 > this.spec.vne * 1.3) { this.crash('Structural failure – extreme overspeed'); return; }
    // terrain at world edges: nothing. Rebase / airports every second
    this.slowT += dt;
    if (this.slowT > 1) { this.slowT = 0; this.slowTick(); }
    if (this.atcReply && this.time >= this.atcReply.due) {
      const reply = this.atcReply; this.atcReply = null; this.addAtc(reply.sender, reply.text);
    }
    const nextFlightPhase = this.computeFlightPhase();
    if (nextFlightPhase !== this.currentFlightPhase) {
      this.onFlightPhaseChange(this.currentFlightPhase, nextFlightPhase);
      this.currentFlightPhase = nextFlightPhase;
    }
    this.score_and_systems(dt);
    this.updateWarnings(dt);
    this.passengers(dt);
    this.checkCompletion(dt);
    if (this.restartHold > 0) { this.restartHold += dt; if (this.restartHold > 0.7) { this.restartHold = 0; this.restart(); return; } }
    w.update(this.camera, fm.pos, fm.agl, this.time);
  }

  private slowTick() {
    const fm = this.fm, w = this.world!;
    const lat = this.lat(), lon = this.lon();
    if (Math.hypot(fm.pos.x, fm.pos.z) > 80000) { this.rebaseTo(lat, lon); this.lastLL = [lat, lon]; return; }
    w.rebuildAirports(lat, lon);
    this.magv = magVar(lat, lon);
    this.updateDeparture(1);
    // live weather: refresh every 10 min, or when 60 km from the last sample point
    if (!this.wxBusy && (performance.now() - this.wxFetchedAt > 600000 || haversine(lat, lon, this.wxPoint[0], this.wxPoint[1]) > 60000)) void this.refreshWx();
    if (this.liveWx) {
      windProfile(this.liveWx, fm.groundH + 10, 10, this.wxTmp); this.windFrom = Math.round(this.wxTmp.dir) % 360; this.windKt = Math.round(this.wxTmp.kt);
      // refresh the cloud-deck wind (mid-layer altitude) for the impostor advection
      windVector(this.liveWx, this.liveWx.midBaseMsl, 0, this.cloudWind);
      w.setCloudWind(this.cloudWind.x, this.cloudWind.z);
    }
    // auto approach-runway selection while far away
    if (!this.apprLocked) {
      const th = this.bestApproachFor(lat, lon); if (th && th.ident !== this.apprKey) this.apprKey = th.ident;
      if (this.distToDest() < 30000) this.apprLocked = true;
    } else if (!this.apprKey) { this.apprKey = this.approachTh()?.ident || ''; }
    // top of descent hint
    const rem = this.distToDest(); const altFt = fm.pos.y / 0.3048;
    const todNm = Math.max(8, ((altFt - this.cfg.to.elev / 0.3048) / 1000) * 3 + 8);
    if (!this.todShown && this.takeoffDone && rem / M_PER_NM < todNm && altFt > this.cfg.to.elev / 0.3048 + 3000) { this.todShown = true; this.toast(`Top of descent – ${Math.round(rem / M_PER_NM)} nm to go. Set a lower altitude and slow down.`, 'info'); }
  }
  private bestApproachFor(lat: number, lon: number): Threshold | null {
    const w = this.world!, ths = w.thresholds(this.cfg.to); if (!ths.length) return null;
    const px = w.proj.x(lon), pz = w.proj.z(lat); let best = ths[0], bs = -1e9; const maxLen = Math.max(...ths.map((t) => t.len));
    for (const t of ths) {
      const h = t.hdg * D2R, ax = t.x - Math.sin(h) * 12000, az = t.z + Math.cos(h) * 12000;
      const head = Math.cos((this.windFrom - t.hdg) * D2R) * this.windKt;
      const sc = head * 0.4 + (t.len >= maxLen * 0.7 ? 10 : 0) - Math.hypot(ax - px, az - pz) / 8000;
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }

  private handleEvents() {
    const fm = this.fm, evs = fm.events.splice(0); const fx = this.effects!;
    for (const e of evs) {
      if (e.kind === 'touchdown') {
        const fpm = Math.round(-e.vs * 196.85);
        const r = this.world!.runwayAt(fm.pos.x, fm.pos.z, 10);
        let dist = 0, off = 0, rwy = '', ap = '';
        if (r) {
          const fwd = Math.abs(wrap180(fm.heading - r.g.hdg)) < 90; dist = fwd ? r.along : r.g.len - r.along; off = Math.abs(r.across); rwy = fwd ? r.g.rw.le : r.g.rw.he; ap = r.g.ap.id;
        }
        if (!this.landing) this.landing = { vsFpm: fpm, kias: fm.ias / 0.514444, offset: off, dist, bank: Math.abs(fm.bank * R2D), pitch: fm.pitch * R2D, onRunway: !!r, airportId: ap, rwy };
        this.audio.touchdown(e.severity); this.shakeImpulse = Math.min(1, 0.25 + e.severity * 0.9);
        for (let i = 0; i < 14; i++) fx.tyreSmoke(e.point.clone(), fm.vel, 1);
        const q = fpm < 180 ? 'BUTTER!' : fpm < 350 ? 'Smooth touchdown' : fpm < 600 ? 'Firm touchdown' : 'HARD LANDING';
        this.toast(`${q}  ${fpm} fpm${r ? ` · ${rwy} · ${Math.round(off)} m off centre` : ' · off runway!'}`, fpm < 350 ? 'good' : fpm < 600 ? 'info' : 'bad');
        if (e.severity > 1) { this.comfort -= 18 + e.severity * 8; this.audio.speak('Hard landing', 'hl', 5); }
        else if (e.severity > 0.7) this.comfort -= 6;
      } else if (e.kind === 'gearbreak') { this.crash('Landing gear collapsed on impact'); }
      else if (e.kind === 'hull') {
        if (this.ticks % 4 === 0) { fx.sparks(e.point.clone(), 6, fm.vel); this.audio.scrape(); this.shakeImpulse = Math.max(this.shakeImpulse, 0.3); }
        if (fm.damage > 5) this.penalize('scrape', 'Aircraft scraped the ground', 100, 4);
      }
    }
  }

  private score_and_systems(dt: number) {
    const fm = this.fm, spec = this.spec, c = fm.ctl;
    // progress points
    const rem = this.distToDest();
    if (rem < this.bestRem) { const d = this.bestRem - rem; if (this.takeoffDone) this.score += d / 250; this.bestRem = rem; }
    if (this.takeoffDone) { const [la, lo] = [this.lat(), this.lon()]; this.flownKm += haversine(this.lastLL[0], this.lastLL[1], la, lo) / 1000; this.lastLL = [la, lo]; }
    else this.lastLL = [this.lat(), this.lon()];
    // takeoff detection
    if (!this.takeoffDone && !fm.wow && fm.agl > 4 && fm.vs > 0.5) {
      this.takeoffDone = true; this.addScore('Successful takeoff', 300); this.toast('Airborne!  +300', 'good'); this.audio.chirp();
      if (!this.paEvents.welcome) { this.comfort -= 3; }
      if (this.seatbelt === false) this.comfort -= 2;
    }
    // trail for map
    this.trailT += dt; if (this.trailT > 2 && this.takeoffDone) { this.trailT = 0; this.trail.push([this.lat(), this.lon()]); if (this.trail.length > 600) this.trail.shift(); }
    // fuel
    if (fm.fuelFrac < 0.1 && !this.fuelWarned) { this.fuelWarned = true; this.toast('LOW FUEL', 'bad'); this.audio.chime(); }
    if (fm.fuel <= 0 && !fm.engineOut) { /* engineOut flag set in model */ }
    // gear: wheels leave ground event, auto-lower? no. retract protect
    if (fm.gearPos > 0.02 && fm.gearPos < 0.98 && ((fm.ias / 0.514444) > spec.vle + 5)) { fm.damage += dt * 6; }
    void c;
  }

  // =====================================================================================
  //  Warnings (audible + visual): stall, overspeed, GPWS (terrain/sink/pull-up), gear, bank, config, fuel
  // =====================================================================================
  private updateWarnings(dt: number) {
    const fm = this.fm, s = this.spec, c = fm.ctl, L = fm.limits(), list: { text: string; level: 'caution' | 'warning'; sound: WarnSound }[] = [];
    const kias = L.kias; const aglM = fm.agl, vs = fm.vs;
    const inFlight = !fm.wow && fm.airborneTime > 1;
    let voice: [string, string, number] | null = null;
    if (inFlight && (fm.stalled || (fm.stallWarn && fm.alpha > fm.alphaStall * 0.97))) { list.push({ text: 'STALL', level: 'warning', sound: 'stall' }); voice = ['Stall', 'stall', 2.4]; if (!this.wasStalled) { this.penalize('stall', 'Stall', 60, 10); this.comfort -= 6; this.shakeImpulse = 0.4; } this.wasStalled = true; } else this.wasStalled = false;
    if (L.overspeed) { list.push({ text: 'OVERSPEED', level: 'warning', sound: 'overspeed' }); this.overspeedT += dt; this.penalize('os', 'Overspeed', 40, 5); voice = voice || ['Overspeed', 'os', 3]; } else this.overspeedT = 0;
    // terrain look-ahead (GPWS)
    if (inFlight) {
      const w = this.world!, v = fm.vel; let danger = 0;
      const landingCfg = c.gearDown && fm.gearPos > 0.9 && c.flapsIdx >= 1;
      const nearRwy = this.nearAirport(9000) && landingCfg;
      for (let t = 2; t <= 12 && !danger; t += 1.5) {
        const px = fm.pos.x + v.x * t, pz = fm.pos.z + v.z * t, py = fm.pos.y + v.y * t - (this.spec.gear[1].pos[1] * -1);
        const clear = py - w.terrain.heightAt(px, pz);
        if (clear < 35 && t <= 6) danger = 2; else if (clear < 110 && t <= 12) danger = 1;
      }
      if (danger && !nearRwy && aglM < 1500) { if (danger === 2) { list.push({ text: 'PULL UP', level: 'warning', sound: 'pullup' }); voice = ['Terrain. Pull up!', 'pu', 1.6]; this.penalize('gpws', 'Terrain warning (GPWS)', 75, 8); this.comfort -= 0.05; } else { list.push({ text: 'TERRAIN', level: 'caution', sound: 'terrain' }); voice = voice || ['Terrain, terrain', 'tr', 4]; } }
      if (aglM < 450 && vs < -(2.6 + aglM / 55) && !(nearRwy && aglM < 60)) { list.push({ text: 'SINK RATE', level: 'warning', sound: 'sink' }); voice = voice || ['Sink rate', 'sr', 3]; this.penalize('sink', 'Excessive sink rate', 30, 8); }
      if (!c.gearDown && fm.gearPos < 0.9 && aglM < 120 && vs < -0.5 && c.throttle < 0.7 && kias < s.vle * 1.6) { list.push({ text: 'TOO LOW – GEAR', level: 'warning', sound: 'gear' }); voice = ['Too low, gear', 'tlg', 2.5]; this.penalize('gear', 'Gear-up approach warning', 60, 10); }
      else if (!c.gearDown && c.flapsIdx >= Math.max(1, s.flapDetents - 1) && aglM < 450 && fm.gearPos < 0.9) { list.push({ text: 'CHECK GEAR', level: 'caution', sound: 'gear' }); }
      if (Math.abs(fm.bank * R2D) > 45) { list.push({ text: 'BANK ANGLE', level: 'caution', sound: 'bank' }); voice = voice || ['Bank angle', 'ba', 3]; this.penalize('bank', 'Excessive bank', 10, 8); this.comfort -= dt * 1.5; }
    }
    if (L.gearOver) { list.push({ text: 'GEAR OVERSPEED', level: 'caution', sound: 'overspeed' }); this.penalize('go', 'Gear overspeed', 20, 6); }
    if (L.flapOver && fm.flapsPos > 0.05) { list.push({ text: 'FLAPS OVERSPEED', level: 'caution', sound: 'overspeed' }); this.penalize('fo', 'Flap overspeed', 20, 6); fm.damage += dt * 2; }
    if (fm.wow && c.throttle > 0.82 && c.parking) { list.push({ text: 'PARK BRAKE', level: 'warning', sound: 'config' }); voice = voice || ['Parking brake', 'pb', 3]; }
    else if (fm.wow && c.throttle > 0.85 && fm.gs < 40 && s.kind !== 'piston' && c.flapsIdx === 0) { list.push({ text: 'CONFIG FLAPS', level: 'warning', sound: 'config' }); voice = voice || ['Flaps. Takeoff configuration', 'cf', 4]; }
    if (fm.fuelFrac < 0.1 && fm.fuel > 0) list.push({ text: 'LOW FUEL', level: 'caution', sound: 'fuel' });
    if (fm.fuel <= 0) { list.push({ text: 'ENGINE FLAMEOUT', level: 'warning', sound: 'fuel' }); voice = voice || ['Engine failure', 'ef', 8]; }
    if (!this.seatbelt && this.turb > 0.3 && this.takeoffDone) list.push({ text: 'SEATBELT SIGN', level: 'caution', sound: null });
    // altitude callouts on approach
    if (inFlight && c.gearDown && vs < -1 && !this.ap.on || (inFlight && c.gearDown && vs < -1)) {
      const ft = aglM / 0.3048; const calls: [number, string][] = [[500, 'Five hundred'], [100, 'One hundred'], [50, 'Fifty'], [30, 'Thirty'], [20, 'Twenty'], [10, 'Ten']];
      for (const [h, t] of calls) if (this.prevAgl / 0.3048 > h && ft <= h && (h >= 100 || s.kind === 'jet' || h === 50)) this.audio.speak(t, 'c' + h, 0.5, 1.15, 0.85);
      if (this.ap.appr && this.prevAgl / 0.3048 > 20 && ft <= 20 && s.kind === 'jet') this.audio.speak('Retard', 'ret', 3);
    }
    this.prevAgl = aglM;
    this.warnState = list;
    const top = list.find((x) => x.sound) || null;
    this.curSound = top ? top.sound : null;
    this.audio.setWarningVoice(voice?.[1] ?? null);
    if (voice) this.audio.speak(voice[0], voice[1], voice[2]);
    // new warning chirps
    const sig = list.map((l) => l.text).join('|'); if (sig !== this.warnSig) { if (list.some((l) => l.level === 'caution') && !list.some((l) => l.level === 'warning') && list.length > this.warnLen) this.audio.chime(); this.warnSig = sig; this.warnLen = list.length; }
  }
  private curSound: WarnSound = null; private warnSig = ''; private warnLen = 0;
  private nearAirport(r: number) { return airportsNear(this.lat(), this.lon(), r).some((a) => a.runways.length > 0); }

  // =====================================================================================
  //  Passengers
  // =====================================================================================
  private passengers(dt: number) {
    const fm = this.fm; let drain = 0;
    const dn = Math.abs(fm.nz - 1);
    if (dn > 0.4) drain += (dn - 0.4) * 14;
    const bank = Math.abs(fm.bank * R2D); if (bank > 32) drain += (bank - 32) * 0.08;
    const p = fm.pitch * R2D; if (p > 14 || p < -9) drain += 1.5;
    if (this.turb > 0.25 && !this.seatbelt && this.takeoffDone) drain += this.turb * 2;
    else if (this.turb > 0.3) drain += this.turb * 0.5;
    if (fm.stalled) drain += 8;
    if (Math.abs(fm.ny) > 0.25) drain += 4;
    if (this.takeoffDone && this.world && !this.seatbelt && fm.agl < 400 && !fm.wow) drain += 0.3;
    this.comfort = clamp(this.comfort - drain * dt, 0, 100);
    if (drain < 0.05 && this.takeoffDone) this.comfort = Math.min(100, this.comfort + dt * 0.25);
    this.cabinMsgT -= dt; if (this.cabinMsgT <= 0) this.cabinMsg = '';
    this.nextChat -= dt;
    if (this.nextChat <= 0 && this.spec.pax > 3) {
      this.nextChat = 30 + Math.random() * 30;
      const m = this.comfort / 100;
      const lines = m > 0.7 ? ['“Wow, look at that view!”', '“Smooth ride today.”', '“Are we there yet? Kidding!”'] : m > 0.4 ? ['“It’s a bit bumpy…”', '“Could be smoother.”'] : ['“I don’t feel so good…”', '“Please, Captain, gently!”'];
      this.setCabinMsg(lines[(Math.random() * lines.length) | 0]);
    }
    if (this.comfort < 25 && !this.warnPenalty['pax']) { this.warnPenalty['pax'] = 1; this.toast('Passengers are very unhappy!', 'bad'); }
  }

  // =====================================================================================
  //  Landing / completion / crash
  // =====================================================================================
  private checkCompletion(dt: number) {
    const fm = this.fm;
    if (!this.landing || !fm.wow) { this.stoppedT = 0; return; }
    if (fm.gs < 1.2 && !this.endT) {
      this.stoppedT += dt;
      if (this.stoppedT > 2.2) {
        const near = airportsNear(this.lat(), this.lon(), 2500).find((a) => a.runways.length > 0);
        const onRwy = this.world!.runwayAt(fm.pos.x, fm.pos.z, 120);
        if (onRwy || near) this.finish(near && near.id !== this.cfg.to.id && !(onRwy && onRwy.g.ap.id === this.cfg.to.id) ? 'diverted' : 'landed');
        else if (this.stoppedT > 8) { this.toast('Stopped off-airport – take off again or restart (R)', 'warn'); this.stoppedT = -999; }
      }
    }
  }
  private finish(outcome: 'landed' | 'diverted') {
    const fm = this.fm, l = this.landing!; const items: Breakdown[] = [...this.items];
    const addI = (label: string, pts: number) => { items.push({ label, pts }); };
    let total = this.score;
    const dest = this.cfg.to.id;
    const atDest = l.airportId === dest || outcome === 'landed';
    const base = atDest ? 1000 : 400; addI(atDest ? 'Flight completed at destination' : 'Diverted landing', base); total += base;
    const vsq = l.vsFpm < 120 ? [1000, 'Butter landing'] : l.vsFpm < 250 ? [800, 'Smooth touchdown'] : l.vsFpm < 400 ? [550, 'Good touchdown'] : l.vsFpm < 600 ? [300, 'Firm touchdown'] : l.vsFpm < 800 ? [100, 'Hard touchdown'] : [0, 'Very hard touchdown'];
    addI(`${vsq[1]} (${l.vsFpm} fpm)`, vsq[0] as number); total += vsq[0] as number;
    if (l.onRunway) { const cl = Math.max(0, Math.round(300 - l.offset * 12)); addI(`Centreline (${Math.round(l.offset)} m off)`, cl); total += cl; const tz = l.dist >= 100 && l.dist <= 700 ? 200 : l.dist < 100 ? 80 : 60; addI(`Touchdown zone (${Math.round(l.dist)} m)`, tz); total += tz; }
    else { addI('Touchdown off the runway', -250); total -= 250; }
    const sp = Math.abs(l.kias - this.spec.vapp); const spp = sp < 6 ? 120 : sp < 12 ? 60 : 0; if (spp) { addI(`Approach speed (${Math.round(l.kias)} kt)`, spp); total += spp; }
    const cm = Math.round(this.comfort * 5); addI(`Passenger comfort ${Math.round(this.comfort)}%`, cm); total += cm;
    const fu = Math.round(fm.fuelFrac * 200); addI('Fuel remaining', fu); total += fu;
    if (this.usedAp) { /* flying on autopilot is fine; no penalty */ }
    const km = Math.round(this.flownKm * 0.4); addI(`Distance flown ${Math.round(this.flownKm)} km`, km); total += km;
    const skill = vsq[0] as number + (l.onRunway ? 200 : 0) + cm + (total - this.score) * 0 + items.filter((i) => i.pts < 0).reduce((a, b) => a + b.pts, 0);
    const grade = skill >= 1700 ? 'S' : skill >= 1350 ? 'A' : skill >= 950 ? 'B' : skill >= 550 ? 'C' : skill >= 200 ? 'D' : 'F';
    this.endGame({ outcome, score: Math.max(0, Math.round(total)), grade, items, landing: l, reason: '' });
  }
  crash(reason: string) {
    if (this.phase !== 'playing') return; const fm = this.fm;
    this.setPhase('crashed'); this.crashTimer = 0;
    this.effects!.explosion(fm.pos.clone(), fm.vel.clone(), Math.max(1, this.spec.length / 9));
    this.audio.silence(); this.audio.crash(); this.shakeImpulse = 1.5;
    this.visual?.setVisible(false); this.crashReason = reason;
    this.crashPos = fm.pos.clone(); fm.vel.set(0, 0, 0); fm.w.set(0, 0, 0);
    this.setView('chase'); this.zoom = 3;
    this.toast(reason, 'bad');
  }
  private crashReason = ''; private crashPos = new THREE.Vector3();
  private endGame(r: Omit<Result, 'rank' | 'distanceKm' | 'flightTime' | 'comfort' | 'newBest'>) {
    const items = r.items.slice();
    const crashed = r.outcome === 'crashed';
    const rec = addScore({ score: r.score, name: this.cfg.settings.name || 'Pilot', aircraft: this.spec.name, from: this.cfg.from.icao, to: this.cfg.to.icao, grade: r.grade, outcome: r.outcome, landingFpm: r.landing ? r.landing.vsFpm : null, date: Date.now(), distanceKm: Math.round(this.flownKm) });
    this.result = { ...r, items, rank: rec.rank, distanceKm: Math.round(this.flownKm), flightTime: this.flightTime, comfort: this.comfort, newBest: rec.rank === 1 && r.score > 0 };
    this.endT = 0.001;
    if (!crashed) { this.setPhase('complete'); this.audio.silence(); this.audio.applause(); this.audio.speak(r.grade === 'F' ? 'Flight complete.' : `Welcome to ${this.cfg.to.city || this.cfg.to.name}. Thank you for flying with us.`, 'end', 1, 1, 1); this.setView('chase'); }
    // result delivered after short delay in postEnd
  }
  private postEnd(dt: number) {
    this.endT += dt; this.crashTimer += dt;
    this.time += dt;
    if (this.phase === 'crashed') {
      if (this.crashTimer < 8 && this.ticks % 2 === 0) this.effects!.fire(this.crashPos.clone(), Math.max(1, this.spec.length / 10));
      if (!this.result && this.crashTimer > 2.2) {
        const items = [...this.items]; const pen = Math.round(this.score * 0.7); items.push({ label: 'Crash penalty (−70%)', pts: -pen });
        this.endGame({ outcome: 'crashed', score: Math.max(0, Math.round(this.score - pen)), grade: 'F', items, landing: null, reason: this.crashReason });
      }
    }
    if (this.result && this.endT > (this.phase === 'crashed' ? 0.4 : 2.0) && this.result) { const r = this.result; this.result = null; this.hooks.onResult(r); }
    this.audio.update(this.audioState(true), dt);
  }

  // =====================================================================================
  //  Visuals, camera, audio
  // =====================================================================================
  private updateVisuals(dt: number) {
    const fm = this.fm, w = this.world!, v = this.visual!, fx = this.effects!;
    if (this.phase !== 'crashed') { v.root.position.copy(fm.pos); v.root.quaternion.copy(fm.quat); v.update(fm, this.phase === 'paused' ? 0 : dt, this.time, this.lights); }
    // contact effects
    if (this.phase === 'playing') {
      for (let i = 0; i < fm.gear.length; i++) {
        const g = fm.gear[i];
        if (g.contact && fm.gs > 8 && g.skid && this.ticks % 3 === 0) fx.tyreSmoke(tmpV.set(this.spec.gear[i].pos[0], this.spec.gear[i].pos[1], this.spec.gear[i].pos[2]).applyQuaternion(fm.quat).add(fm.pos), fm.vel, 1);
      }
      if (fm.thrustN < -1000 && fm.wow && fm.gs > 15 && this.ticks % 4 === 0) fx.dust(fm.pos.clone().add(new THREE.Vector3(0, -2, 0)), 2);
      if (fm.damage > 30 && this.ticks % 5 === 0) fx.fire(fm.pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.3);
    }
    fx.update(dt);
    // camera
    this.updateCamera(dt);
    if (this.precip) { this.relAir.copy(fm.wind).add(fm.gust).sub(fm.vel); this.precip.update(this.phase === 'paused' ? 0 : dt, this.camera.position, this.relAir, w.wx.baseMsl, clamp((w.sunElevation + 8) / 20, 0.12, 1)); }
    // sim → cockpit instruments
    const interior = this.isInterior() && this.mode === 'play';
    if (this.cockpit) this.cockpit.daylight = clamp((w.sunElevation + 8) / 20, 0.12, 1);
    if (interior && this.cockpit) this.cockpit.perfLoad = this.emaFrameMs > 22 ? 1.8 : this.emaFrameMs > 18 ? 1.35 : 1;
    if (interior && this.cockpit) this.cockpit.update(dt, this.time, this.panelDataCached(), { pitch: fm.ctl.pitch, roll: fm.ctl.roll, yaw: fm.ctl.yaw, throttle: fm.ctl.throttle, flapsIdx: fm.ctl.flapsIdx, gearDown: fm.ctl.gearDown, speedbrake: fm.ctl.speedbrake }, { battery: fm.ctl.battery, lights: this.lights, seatbelt: this.seatbelt, parking: fm.ctl.parking, reverse: fm.ctl.reverse, apOn: this.ap.on, apNav: this.ap.nav, apAppr: this.ap.appr, apHdg: this.magHdg(this.ap.hdg), apAlt: this.ap.altFt, apSpd: this.ap.spd, mood: this.comfort / 100, shake: clamp(this.turb * 1.6 + this.shakeImpulse, 0, 1.6) }, true);
    v.setInterior(interior);
    if (this.phase === 'playing') {
      this.updateChecklist();
      if (this.showTaxiRibbon && this.taxiRibbonGroup.visible) {
        if (!fm.wow || this.currentFlightPhase !== 'taxi') {
          this.taxiRibbonGroup.visible = false;
        }
      }
      this.audio.update(this.audioState(false), dt);
    }
    w.sunLight.visible = true;
  }
  private audioState(paused: boolean) {
    const fm = this.fm; const interior = this.isInterior();
    return { kind: this.spec.kind, n: fm.n[0], thrust: fm.thrustN, ias: fm.ias, tas: fm.tas, wow: fm.wow, gs: fm.gs, view: interior ? 'inside' as const : 'outside' as const, cabin: VIEWS[this.viewIdx] === 'aisle' || VIEWS[this.viewIdx] === 'window', sound: this.phase === 'playing' ? this.curSound : null, paused: paused || this.phase !== 'playing', mood: this.comfort / 100, agl: fm.agl, vol: 1 };
  }
  private updateCamera(dt: number) {
    const fm = this.fm, cam = this.camera, L = this.spec.length, view = VIEWS[this.viewIdx], t = this.time;
    // Dynamic far plane preserves distant horizon view across altitudes
    cam.far = clamp(180000 + fm.agl * 12, 180000, 350000);
    // shake
    const set = this.cfg.settings;
    const flying = this.phase === 'playing';
    let amp = set.shake && flying ? this.turb * 0.0018 * clamp(1.5 - fm.agl / 1500, 0.6, 1.5) + (fm.stalled ? 0.006 : fm.stallWarn ? 0.0025 : 0) + (fm.wow ? clamp(fm.gs / 70, 0, 1) * 0.0009 : 0) + fm.n[0] * 0.0004 : 0;
    if (set.shake) amp += this.shakeImpulse * 0.02;
    this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 1.8);
    if (this.phase === 'crashed') amp += Math.max(0, 1 - this.crashTimer / 3) * 0.02;
    const sx = amp * (Math.sin(t * 23.1) + Math.sin(t * 41.7 + 1.3)), sy = amp * (Math.sin(t * 19.3 + 2) + Math.sin(t * 37.9)), sr = amp * 0.6 * Math.sin(t * 29.1);
    const gOff = flying ? clamp(-(fm.nz - 1) * 0.025, -0.06, 0.06) : 0;
    this.world?.setInterior(this.isInterior() && this.mode === 'play');
    if (this.isInterior() && this.mode === 'play') {
      cam.near = 0.25; // world camera: nothing exists inside 25 cm of the eye point – a 12x larger near plane gives the 24-bit depth buffer far more range (less z-fighting, cheaper rasterisation)
      const vw = this.cockpit!.smooth(dt);
      const lk = 1 / this.cockpit!.zoom; // camera shake is scaled with the zoom so magnified details stay steady
      tmpE.set(vw.pitch + sx * lk, vw.yaw + sy * lk, sr, 'YXZ');
      const local = tmpQ.setFromEuler(tmpE); // scratch — no per-frame clone
      tmpV3.copy(vw.pos); tmpV3.y += gOff;  // head position in body frame (scratch)
      for (const cq of [this.cockpit!.camera, this.cockpit!.activeCamera]) { cq.position.copy(tmpV3); cq.quaternion.copy(local); cq.fov = this.fovFor(vw.fov); cq.updateProjectionMatrix(); } const cq = this.cockpit!.camera;
      tmpV3.applyQuaternion(fm.quat);
      cam.position.copy(fm.pos).add(tmpV3); cam.quaternion.copy(fm.quat).multiply(local); cam.fov = cq.fov; cam.updateProjectionMatrix();
    } else if (view === 'spotter' && this.mode === 'play') {
      const toAc = tmpV.copy(fm.pos).sub(cam.position); const d = toAc.length();
      if (!this.spotAnchor || d > 1800 || (d > 300 && toAc.dot(fm.vel) < 0 && fm.gs > 20)) {
        const vdir = tmpV2.copy(fm.vel).setY(0); if (vdir.lengthSq() < 4) vdir.set(0, 0, -1); vdir.normalize();
        const side = new THREE.Vector3(-vdir.z, 0, vdir.x);
        this.spotAnchor = fm.pos.clone().addScaledVector(vdir, 700 + fm.gs * 4).addScaledVector(side, 70 + L * 2);
        const gh = this.world!.terrain.heightAt(this.spotAnchor.x, this.spotAnchor.z); this.spotAnchor.y = Math.max(gh + 6, Math.min(fm.pos.y, gh + 150));
      }
      cam.near = clamp(d * 0.02, 0.5, 10);
      cam.position.copy(this.spotAnchor); cam.lookAt(fm.pos); cam.fov = clamp(2 * Math.atan(L * 1.6 / Math.max(60, d)) * R2D, 8, 50); cam.updateProjectionMatrix();
    } else {
      // chase (all scratch — the per-frame loop may not allocate)
      if (!this.chaseInit) { this.chaseQ.copy(fm.quat); this.chaseInit = true; }
      this.chaseQ.slerp(fm.quat, 1 - Math.exp(-dt * 3.2));
      const e = tmpE2.setFromQuaternion(this.chaseQ, 'YXZ');
      e.z *= 0.35;
      const ezz = e.z * 0.6; // needed after tmpE2 is reused for the orbit yaw below
      const q = tmpQ2.setFromEuler(e);
      const off = tmpV3.set(0, L * 0.16 + 1.5, L * 0.95 + 5).multiplyScalar(this.zoom);
      const orb = tmpQ.setFromEuler(tmpE.set(0, this.orbitYaw, 0, 'YXZ'));
      off.applyAxisAngle(AXIS_X, -(this.orbitPitch - 0.12) * 1.2).applyQuaternion(orb).applyQuaternion(q);
      cam.position.copy(fm.pos).add(off);
      const gh = this.world!.terrain.heightAt(cam.position.x, cam.position.z); if (cam.position.y < gh + 2.5) cam.position.y = gh + 2.5;
      const camDist = off.length();
      cam.near = clamp(Math.min(0.5, (camDist - L * 0.4) * 0.4), 0.1, 1.5);
      cam.up.set(0, 1, 0).applyQuaternion(tmpQ2.setFromEuler(tmpE2.set(0, 0, ezz)));
      cam.lookAt(fm.pos.x, fm.pos.y + L * 0.03, fm.pos.z);
      cam.rotateX(sx); cam.rotateY(sy); cam.fov = this.fovFor(60 + Math.min(10, fm.gs / 40)); cam.updateProjectionMatrix();
    }
    if (this.phase === 'crashed') { cam.lookAt(this.crashPos); }
    cam.updateMatrixWorld();
  }
  private spotAnchor: THREE.Vector3 | null = null;

  /** Telemetry snapshot for the displays, rebuilt at ≈ 40 Hz (it allocates and runs the ILS solver – no need to do that every rendered frame). */
  private pdCache: PanelData | null = null; private pdT = 0;
  private panelDataCached(): PanelData { const now = performance.now(); if (!this.pdCache || now - this.pdT > 25) { this.pdCache = this.panelData(); this.pdT = now; } return this.pdCache; }
  private panelData(): PanelData {
    const fm = this.fm, s = this.spec, ils = this.computeIls(), rem = this.distToDest();
    const brg = bearing(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon);
    const wp = this.flightPlan[this.activeWpIdx];
    let activeWp: { name: string; distNm: number; etaMin: number } | null = null;
    if (wp) {
      const d = haversine(this.lat(), this.lon(), wp.lat, wp.lon);
      const wpDistNm = d / M_PER_NM;
      const etaMin = wpDistNm / Math.max(30, fm.gs * MS_TO_KT) * 60;
      activeWp = { name: wp.name, distNm: wpDistNm, etaMin };
    }
    const relWind = wrap180(this.windFrom - fm.heading);
    const crosswind = Math.round(this.windKt * Math.sin(relWind * D2R));
    return {
      battery: fm.ctl.battery,
      kias: fm.ias / 0.514444, altFt: fm.pos.y / 0.3048, vsFpm: fm.vs * 196.85, hdg: this.magHdg(fm.heading), trk: this.magHdg(fm.track), pitch: fm.pitch * R2D, bank: fm.bank, slip: fm.beta, mach: fm.mach, gsKt: fm.gs * MS_TO_KT,
      n1: fm.n.slice(0, s.engines), fuelKg: fm.fuel, fuelFrac: fm.fuelFrac, flapsIdx: fm.ctl.flapsIdx, flapsDet: s.flapDetents, gear: fm.gearPos, throttle: fm.ctl.throttle, parking: fm.ctl.parking, reverse: fm.ctl.reverse, spoilers: fm.sbPos,
      apOn: this.ap.on, apHdg: this.magHdg(this.ap.hdg), apAlt: this.ap.altFt, apSpd: this.ap.spd, apNav: this.ap.nav, apAppr: this.ap.appr, apVsMode: false,
      dest: { id: this.cfg.to.icao, name: this.cfg.to.name, brg: wrap180(this.magHdg(brg)), distNm: rem / M_PER_NM, eteMin: (rem / Math.max(30, fm.gs)) / 60 },
      ils: ils ? { valid: ils.valid, loc: ils.locDots, gs: ils.gsDots, ident: ils.ident, distNm: ils.dist / M_PER_NM } : null,
      warn: this.warnState.map((w) => w.text), aglFt: fm.agl / 0.3048, alphaFrac: fm.alpha / fm.alphaStall, time: this.time, thrustPct: (Math.abs(fm.thrustN) / ((s.thrust || s.power / 60) * (s.kind === 'jet' ? 1 : 1))) * 100, fuelFlowKgH: fm.fuelFlow * 3600,
      wind: { dir: this.windFrom, kt: this.windKt, cross: crosswind },
      activeWp,
      flightPhase: this.currentFlightPhase,
      vSpeeds: { v1: Math.max(20, Math.round(s.vr - 5)), vr: s.vr, v2: Math.round(s.vr + 10), vapp: s.vapp },
      qnhInHg: +((this.liveWx?.ok ? this.liveWx.qnh : 1013.25) / 33.8639).toFixed(2),
      oatC: this.oat(),
    };
  }

  private coach(): string {
    if (this.mode !== 'play' || !this.cfg.settings.hud) return '';
    const fm = this.fm, c = fm.ctl, s = this.spec, kias = fm.ias / 0.514444;
    if (this.phase !== 'playing') return '';
    if (this.ap.on) {
      const wpName = this.flightPlan[this.activeWpIdx]?.name || this.cfg.to.icao;
      return `Autopilot [${this.ap.phase.toUpperCase()}] · Next: ${wpName} · Press [Y] to disengage`;
    }
    if (fm.wow && !this.landing && !this.takeoffDone) {
      if (c.parking) return 'Release parking brake [B] or engage Autopilot [Y] for Auto-Takeoff';
      if (s.kind !== 'piston' && c.flapsIdx === 0) return `Set takeoff flaps [F] or engage [Y] for Auto-Takeoff`;
      if (c.throttle < 0.6) return 'Advance throttle [Shift / 0] or engage [Y] for Auto-Takeoff';
      if (kias < s.vr - 3) return `Accelerating… keep nose straight with [Q]/[E] – rotate at ${s.vr} kt`;
      return 'ROTATE – ease nose up with [S] / ↓';
    }
    if (!fm.wow && !this.landing) {
      if (c.gearDown && fm.agl > 15 && fm.vs > 1 && this.takeoffDone && fm.agl < 800 && this.distToDest() > 20000) return 'Positive climb – retract landing gear [G]';
      if (!this.usedAp && fm.agl > 500 && this.distToDest() > 25000) return 'Level off, then press [Y] for autopilot – tracks full flight route';
      const rem = this.distToDest() / M_PER_NM;
      if (rem < 12 && !c.gearDown && fm.agl < 1500) return 'Approach – lower gear [G] and set flaps [F]';
      if (rem < 25 && !this.ap.appr && this.computeIls()?.valid) return `ILS ${this.computeIls()!.ident} available – press [U] for autoland`;
    }
    if (this.landing && fm.wow && fm.gs > 8) return `Rollout – brake with [Space]${s.hasReverse ? ', reverse thrust [T]' : ''}${s.hasSpeedbrake ? ', spoilers [Z]' : ''}`;
    return '';
  }

  computeFlightPhase(): FlightPhase {
    return computeFlightPhaseState(this as unknown as FlightPhaseContext);
  }

  private onFlightPhaseChange(prev: FlightPhase, next: FlightPhase) {
    void prev;
    if (this.mode !== 'play') return;
    const depRwy = this.depRwy || '09';
    const arrRwy = this.apprKey || '27';
    const fromIcao = this.cfg.from.icao;
    const toIcao = this.cfg.to.icao;
    const wind = `${this.windFrom}° at ${this.windKt} kt`;

    switch (next) {
      case 'taxi':
        if (this.landing || this.depStage < 5) {
          if (!this.landing) break;
          this.addAtc('GROUND', `${this.callsign.callsign}, welcome to ${toIcao}. Taxi to the apron, vacate the runway and contact Ground${this.atcFreq(this.cfg.to, 'GND')}.`, true);
        } else {
          this.addAtc('GROUND', `${this.callsign.callsign}, ${fromIcao} Ground. Taxi to holding point runway ${depRwy}${this.taxiVia()}.`, true);
        }
        break;
      case 'takeoff':
        if (this.depStage < 5) { this.addAtc('TOWER', `${this.callsign.callsign}, ${fromIcao} Tower${this.atcFreq(this.cfg.from, 'TWR')}. Runway ${depRwy}, wind ${wind}, cleared for takeoff.`, true); this.audio.chirp(); this.depStage = 5; }
        break;
      case 'climb':
        this.addAtc('DEPARTURE', `${this.callsign.callsign}, airborne, radar contact. Climb and maintain ${Math.round(this.spec.cruiseAlt / 0.3048)} ft, contact Departure${this.atcFreq(this.cfg.from, 'DEP') || this.atcFreq(this.cfg.from, 'APP')}.`, false);
        break;
      case 'cruise':
        this.addAtc('ENROUTE', `${this.callsign.callsign}, reaching cruise altitude. Traffic clear, monitor ${this.atcFreq(this.cfg.to, 'APP').trim() || 'enroute frequency'}.`, false);
        break;
      case 'descent':
        this.addAtc('APPROACH', `${this.callsign.callsign}, ${toIcao} Approach. Descend and maintain 3,500 ft, ${this.qnh(this.cfg.to)}. Expect ILS runway ${arrRwy}.`, true);
        this.audio.chime();
        break;
      case 'final':
        this.addAtc('TOWER', `${this.callsign.callsign}, ${toIcao} Tower${this.atcFreq(this.cfg.to, 'TWR')}. Runway ${arrRwy}, wind ${wind}, cleared to land.`, true);
        this.audio.chime();
        break;
      case 'rollout':
        this.addAtc('TOWER', `${this.callsign.callsign}, rollout safe. Vacate the runway when able and contact Ground${this.atcFreq(this.cfg.to, 'GND')}.`, false);
        break;
    }
  }

  /** New radio identity per flight (airport pair + aircraft kind), seeded for deterministic replay. */
  private reseedRadio() {
    const key = `${this.cfg.from.id}>${this.cfg.to.id}>${this.spec.id}`;
    if (this.callsignFlight === key) return;
    this.callsignFlight = key;
    let st = (Math.random() * 0xffffffff) >>> 0;
    this.atcRng = () => { st = (st + 0x6d2b79f5) | 0; let x = Math.imul(st ^ (st >>> 15), 1 | st); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    this.callsign = makeCallsign(this.spec.kind, this.cfg.from.country, this.atcRng);
    this.ambientT = 40; this.ambientLast = '';
  }
  /** Everything the radio needs to word a message for *this* flight, airport and weather. */
  private radioCtx(atDest: boolean): RadioCtx {
    const from = this.cfg.from, to = this.cfg.to, wx = this.liveWx;
    const nm = (a: Airport) => (a.city || a.name || a.icao).replace(/\s*(international|intl|airport|airfield|regional|domestic).*$/i, '').trim() || a.icao;
    const towered = (a: Airport) => frequenciesFor(a.id).some((f) => f.type === 'TWR');
    const ap = atDest ? to : from, sunEl = this.world?.sunElevation ?? 45;
    const ceil = wx && wx.baseAglM !== null ? wx.baseAglM / 0.3048 : null;
    return {
      callsign: this.callsign.callsign, spoken: this.callsign.spoken, fromIcao: from.icao, toIcao: to.icao, fromName: nm(from), toName: nm(to), letter: this.atisLetter,
      spot: this.spawn?.label ?? 'the apron', atDest, lastCat: this.atcLastCat, rwyFallback: (atDest ? this.apprKey : this.depRwy) || '',
      style: /^(K|P[AFGHJKMW]|C[A-Z])/.test(ap.id) ? 'FAA' : 'ICAO', kind: this.spec.kind, fromTowered: towered(from), toTowered: towered(to),
      wx: { dir: this.windFrom, kt: this.windKt, gust: wx?.gustKt ?? 0, visKm: (wx?.visM ?? 30000) / 1000, ceilFt: ceil, rain: wx?.rain ?? 0, snow: wx?.snow ?? 0, thunder: !!wx?.thunder, night: sunEl < -3, ok: !!wx?.ok },
      rnd: this.atcRng,
    };
  }
  /** Queue a controller message: it is voiced as a complete standard exchange (pilot call, instruction, readback). */
  addAtc(sender: string, text: string, _needsAck = false) {
    if (!this.cfg) return;
    const m = /information ([A-Z])\b/.exec(text); if (sender === 'ATIS' && m) this.atisLetter = m[1];
    const atDest = !!this.landing || /welcome to|cleared to land|descend and maintain|rollout safe|expect ils|approach/i.test(text) || (this.currentFlightPhase !== 'taxi' && this.takeoffDone && this.distToDest() < this.distToOrigin());
    const ctx = this.radioCtx(atDest);
    const { lines, cat } = buildExchange(sender, text, ctx, () => this.nextAtcId++);
    this.atcLastCat = cat;
    // Airport-background attract mode must never SPEAK (or queue) over the menu: the exchange is
    // dropped entirely before it reaches the radio — nothing is logged and nothing is voiced.
    if (this.mode === 'attract') return;
    this.radio.enqueue(lines);
  }
  /** Background traffic: other aircraft on the same frequencies, matched to where the player is in the flight. */
  private tickAmbient(dt: number) {
    if (!this.cfg || this.radio.isPaused) return;
    this.ambientT -= dt; if (this.ambientT > 0 || this.radio.pending > 0) return;
    this.ambientT = 38 + this.atcRng() * 55;
    const fp = this.currentFlightPhase, fm = this.fm;
    const ph: AmbientPhase | null = fp === 'taxi' ? (this.depStage >= 4 || this.landing ? 'departure' : 'ground') : fp === 'takeoff' ? 'departure' : fp === 'climb' ? 'climb' : fp === 'cruise' ? 'cruise' : fp === 'descent' ? 'descent' : (fp === 'final' || fp === 'rollout') ? 'arrival' : null;
    if (!ph || (ph === this.ambientLast && this.atcRng() < 0.35)) return;
    const atDest = ph === 'descent' || ph === 'arrival' || (ph === 'ground' && !!this.landing);
    const amb = buildAmbient(ph, this.radioCtx(atDest), () => this.nextAtcId++, fm.pos.y / 0.3048);
    if (!amb) return; this.ambientLast = ph; this.radio.enqueue(amb.lines);
  }
  /** A line goes on the air: it enters the transmission history (and the subtitle) exactly when it is spoken. */
  private logRadioLine(l: RadioLine) {
    const msg: AtcMessage = { id: l.id, sender: l.who, text: l.text, time: this.time, label: l.label };
    this.atcMessages.push(msg);
    if (this.atcMessages.length > 120) this.atcMessages.shift();
  }
  private distToOrigin() { return haversine(this.lat(), this.lon(), this.cfg.from.lat, this.cfg.from.lon); }

  /** True while the aircraft is still on its way from the hangar to the departure runway. */
  get depStageActive() { return !!this.cfg && this.cfg.settings.startMode === 'runway' && !this.takeoffDone; }
  get atcResponding() { return this.radio.pending > 0; }
  /** Radio is fully automatic: there is nothing to answer manually. Kept so old key bindings are harmless. */
  respondAtc(_option: number) { void _option; }

  private computeWorldMarkers(): WorldScreenMarker[] {
    if (!this.world || !this.fm) return [];
    return computeWorldScreenMarkers(
      this.camera,
      this.world,
      this.lat(),
      this.lon(),
      this.fm.pos,
      this.flightPlan,
      this.activeWpIdx,
      this.approachTh(),
      this.cfg.to.elev,
      this.cfg.to.icao
    );
  }

  hud(): HudState {
    const fm = this.fm, s = this.spec, ils = this.computeIls(), rem = this.distToDest();
    const brg = bearing(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon);
    const th = this.approachTh();
    const rwyHdg = th ? this.magHdg(th.hdg) : 0;
    const rwyIdent = this.apprKey || (th ? th.ident : '');
    const rwyDistNm = th ? Math.hypot(fm.pos.x - th.x, fm.pos.z - th.z) / M_PER_NM : 0;
    const total = haversine(this.cfg.from.lat, this.cfg.from.lon, this.cfg.to.lat, this.cfg.to.lon) || 1;
    const loadP = this.world ? this.world.terrain.progress() : 0;

    // Reading the HUD is side-effect free. Phase announcements are emitted by simulation,
    // not by React/map consumers requesting another navigation snapshot.
    const flightPhase = this.currentFlightPhase;

    // Use the same local wind + gust vector that the flight model subtracts from velocity.
    // The configured surface wind is not the aircraft's wind at altitude.
    const windX = fm.wind.x + fm.gust.x, windZ = fm.wind.z + fm.gust.z;
    const windSpeedKt = Math.hypot(windX, windZ) * MS_TO_KT;
    const windDirection = windSpeedKt < 0.05 ? this.windFrom : (Math.atan2(-windX, windZ) * R2D + 360) % 360;
    const relWind = wrap180(windDirection - fm.heading);
    const relWindRad = relWind * D2R;
    const crosswindKt = Math.round(windSpeedKt * Math.sin(relWindRad));
    const headwindKt = Math.round(windSpeedKt * Math.cos(relWindRad));
    const fuelTimeMin = fm.fuelFlow > 0.0001 ? Math.round((fm.fuel / fm.fuelFlow) / 60) : 999;

    let runwayRemM = 0;
    if (this.depTh && !this.takeoffDone && fm.wow) {
      const d = Math.hypot(fm.pos.x - this.depTh.startX, fm.pos.z - this.depTh.startZ);
      runwayRemM = Math.max(0, Math.round(this.depTh.fullLen - d));
    } else if (th && (this.landing || flightPhase === 'final' || flightPhase === 'rollout')) {
      const d = Math.hypot(fm.pos.x - th.x, fm.pos.z - th.z);
      runwayRemM = Math.max(0, Math.round(th.len - d));
    }

    const pitchTarget = this.ap.on && this.ap.pitchTargetRad !== null ? Math.round(this.ap.pitchTargetRad * R2D * 10) / 10 : null;
    const latestAtc = this.atcMessages.length > 0 ? this.atcMessages[this.atcMessages.length - 1] : null;

    // Flight Path Angle (gamma) in degrees: atan2(vertical speed, ground speed)
    const fpaDeg = Math.atan2(fm.vs, Math.max(0.5, fm.gs)) * R2D;
    const track = this.magHdg(fm.track);

    // Active flight plan waypoint telemetry
    let activeWp: { name: string; distNm: number; brg: number; etaMin: number } | null = null;
    if (this.flightPlan.length > 0 && this.activeWpIdx < this.flightPlan.length) {
      const wp = this.flightPlan[this.activeWpIdx];
      const d = haversine(this.lat(), this.lon(), wp.lat, wp.lon);
      const b = bearing(this.lat(), this.lon(), wp.lat, wp.lon);
      const wpDistNm = d / M_PER_NM;
      const etaMin = wpDistNm / Math.max(1, fm.gs * MS_TO_KT) * 60;
      activeWp = {
        name: wp.name,
        distNm: wpDistNm,
        brg: Math.round(this.magHdg(b)),
        etaMin,
      };
    }

    // Clean up acknowledged warnings that are no longer active
    const activeWarnTexts = new Set(this.warnState.map((w) => w.text));
    for (const acked of this.ackedWarnings) {
      if (!activeWarnTexts.has(acked)) {
        this.ackedWarnings.delete(acked);
      }
    }

    const warnList = this.warnState.map((w) => ({
      text: w.text,
      level: w.level,
      acked: this.ackedWarnings.has(w.text),
    }));

    return {
      phase: this.phase, view: VIEWS[this.viewIdx], kias: fm.ias / 0.514444, altFt: fm.pos.y / 0.3048, vsFpm: fm.vs * 196.85, hdg: this.magHdg(fm.heading), gsKt: fm.gs * MS_TO_KT, mach: fm.mach, pitch: fm.pitch * R2D, bank: fm.bank * R2D,
      throttle: fm.ctl.throttle, n1: fm.n[0], flapsIdx: fm.ctl.flapsIdx, flapsDet: s.flapDetents, gear: fm.gearPos, gearDown: fm.ctl.gearDown, brake: fm.ctl.brake > 0.1, parking: fm.ctl.parking, reverse: fm.ctl.reverse, spoilers: fm.sbPos,
      fuelPct: fm.fuelFrac * 100, fuelKg: fm.fuel, aglFt: fm.agl / 0.3048, distNm: rem / M_PER_NM, brg: this.magHdg(brg), eteMin: rem / Math.max(0.5, fm.gs) / 60, warn: warnList,
      score: Math.round(this.score), comfort: this.comfort, ap: { on: this.ap.on, nav: this.ap.nav, appr: this.ap.appr, gsCaptured: this.ap.gsCaptured, hdg: this.magHdg(this.ap.hdg), alt: this.ap.altFt, spd: this.ap.spd },
      ils: ils ? { valid: ils.valid, locDots: ils.locDots, gsDots: ils.gsDots, ident: ils.ident, dist: ils.dist / M_PER_NM } : null,
      timeScale: this.timeScale, lat: this.world ? this.world.proj.lat(fm.pos.z) : this.cfg.from.lat, lon: this.world ? this.world.proj.lon(fm.pos.x) : this.cfg.from.lon, utcMs: simNowMs(), sunEl: this.world?.sunElevation ?? 45, sunPhase: sunPhase(this.world?.sunElevation ?? 45), lights: { ...this.lights }, seatbelt: this.seatbelt, assist: fm.ctl.assist, hint: this.coach(), loadProgress: loadP, restartHold: clamp(this.restartHold / 0.7, 0, 1),
      wind: { dir: windDirection, kt: windSpeedKt }, destId: this.cfg.to.icao, fromId: this.cfg.from.icao, aircraft: s.name, progress: clamp(1 - rem / total, 0, 1), onGround: fm.wow, stall: fm.stalled || fm.stallWarn, nz: fm.nz,
      depRwy: this.depRwy, apprRwy: rwyIdent, rwyHdg, rwyDistNm, vr: s.vr, vapp: s.vapp, alphaFrac: fm.alpha / fm.alphaStall,
      offline: !!this.world?.terrain.offline, paxCount: s.pax, cabinMsg: this.cabinMsg, canWarp: false,
      flightPlan: this.flightPlan, activeWpIdx: this.activeWpIdx, apPhase: this.ap.phase,
      flightPhase,
      track,
      fpaDeg,
      speedTrendKt: clamp(this.speedTrendSmoothed, -40, 40),
      vs0: s.vs0,
      vs1: s.vs1,
      v1: Math.max(20, Math.round(s.vr - 5)),
      v2: Math.round(s.vr + 10),
      vne: s.vne,
      fuelTimeMin,
      relWindDir: relWind,
      crosswindKt,
      headwindKt,
      qnhInHg: +((this.liveWx?.ok ? this.liveWx.qnh : 1013.25) / 33.8639).toFixed(2),
      oatC: this.oat(),
      wxText: wxSummary(this.liveWx), wxMetar: this.liveWx?.metar || '', wxSource: this.liveWx?.source || 'offline', wxCondition: this.liveWx?.condition || '', wxRain: this.liveWx?.rain ?? 0, wxQnhHpa: this.liveWx?.qnh ?? 1013.25, wxVisKm: (this.liveWx?.visM ?? 30000) / 1000, wxObsAge: this.liveWx?.obsAgeMin ?? 0,
      runwayRemM,
      pitchTarget,
      trim: fm.ctl.trim,
      atc: latestAtc,
      atcLive: this.atcLive,
      atcLog: this.atcMessages,
      activeWp,
      cockpitTooltip: this.cockpitTooltip,
      freelookActive: this.freelookActive || this.drag?.look === true,
      worldMarkers: this.computeWorldMarkers(),
      show3dGates: this.show3dGates,
      showTaxiRibbon: this.showTaxiRibbon,
      activeChecklist: {
        items: this.checklistItems,
        currentPhase: flightPhase,
        completedCount: this.checklistItems.filter((x) => x.done).length,
        totalCount: this.checklistItems.length,
      },
      fov: Math.round(this.camera.fov),
    };
  }
}
void TAU; void G;
