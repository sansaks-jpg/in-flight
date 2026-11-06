import * as THREE from 'three';
import { haversine, clamp, D2R, R2D, M_PER_NM, type FlightWaypoint } from './geo';
import type { Threshold, World } from './world';
import type { ChecklistItem, WorldScreenMarker } from './game';

export const DEFAULT_CHECKLIST_ITEMS: ChecklistItem[] = [
  { id: 'battery_on', label: 'BATTERY MASTER ON', detail: 'Power up the aircraft (I)', done: false, phase: 'taxi' },
  { id: 'lights_taxi', label: 'BEACON & NAV LIGHTS', detail: 'Anti-collision beacon ON before start (I)', done: false, phase: 'taxi' },
  { id: 'engines_start', label: 'ENGINE START', detail: 'Start each engine, wait for idle (I)', done: false, phase: 'taxi' },
  { id: 'flaps_takeoff', label: 'TAKE-OFF FLAPS', detail: 'Set the take-off flap detent (F)', done: false, phase: 'taxi' },
  { id: 'park_brake', label: 'PARKING BRAKE', detail: 'Release after start, before taxi (B)', done: false, phase: 'taxi' },
  { id: 'atc_ground', label: 'TAXI CLEARANCE', detail: 'Acknowledge Ground taxi clearance', done: false, phase: 'taxi' },

  { id: 'throttle_takeoff', label: 'TAKEOFF THRUST', detail: 'Advance throttle to 100% N1 (F4)', done: false, phase: 'takeoff' },
  { id: 'centerline', label: 'CENTERLINE ALIGNMENT', detail: 'Keep nose wheel on runway line', done: false, phase: 'takeoff' },
  { id: 'rotate_vr', label: 'ROTATE AT Vr', detail: 'Pitch up smoothly to +12° attitude', done: false, phase: 'takeoff' },

  { id: 'gear_retract', label: 'LANDING GEAR RETRACT', detail: 'Positive climb rate: Gear UP (G)', done: false, phase: 'climb' },
  { id: 'flaps_retract', label: 'FLAPS RETRACT', detail: 'Accelerate through clean speed (V)', done: false, phase: 'climb' },
  { id: 'autopilot_arm', label: 'AUTOPILOT ENGAGE', detail: 'Arm LNAV and climb mode (Y)', done: false, phase: 'climb' },

  { id: 'cruise_level', label: 'LEVEL OFF AT CRUISE', detail: 'Establish level cruise flight', done: false, phase: 'cruise' },
  { id: 'cruise_power', label: 'CRUISE POWER 75%', detail: 'Set fuel-efficient cruise thrust', done: false, phase: 'cruise' },
  { id: 'monitor_fuel', label: 'FUEL CROSSCHECK', detail: 'Verify fuel endurance vs distance', done: false, phase: 'cruise' },

  { id: 'descent_power', label: 'DESCENT POWER', detail: 'Reduce thrust to establish 3° descent', done: false, phase: 'descent' },
  { id: 'seatbelt_on', label: 'SEATBELT SIGN ON', detail: 'Notify passengers for approach (J)', done: false, phase: 'descent' },
  { id: 'approach_prep', label: 'APPROACH BRIEFING', detail: 'Verify landing runway and ILS', done: false, phase: 'descent' },

  { id: 'gear_down', label: 'LANDING GEAR 3-GREEN', detail: 'Extend gear and verify locked (G)', done: false, phase: 'final' },
  { id: 'flaps_full', label: 'FULL LANDING FLAPS', detail: 'Extend full flaps for landing (F)', done: false, phase: 'final' },
  { id: 'glideslope', label: 'GLIDESLOPE TRACKING', detail: 'Fly 3D approach gates or ILS', done: false, phase: 'final' },
  { id: 'flare', label: 'TOUCHDOWN FLARE', detail: 'Retard throttle to IDLE, pitch +4°', done: false, phase: 'final' },

  { id: 'reverse_thrust', label: 'REVERSE THRUST', detail: 'Deploy reverse thrust on touchdown', done: false, phase: 'rollout' },
  { id: 'wheel_brakes', label: 'WHEEL BRAKES', detail: 'Decelerate smoothly to taxi speed', done: false, phase: 'rollout' },
  { id: 'vacate_runway', label: 'RUNWAY VACATED', detail: 'Turn onto exit taxiway to apron', done: false, phase: 'rollout' },
];

export function buildApproachGates(th: Threshold, elev: number): THREE.Line[] {
  const gates: THREE.Line[] = [];
  const dirX = -Math.sin(th.hdg * D2R);
  const dirZ = -Math.cos(th.hdg * D2R);
  const glideSlope = Math.tan(3 * D2R);
  const distances = [450, 900, 1600, 2600, 4200, 6500, 9800, 14000, 20000];

  for (const d of distances) {
    const gx = th.x + dirX * d;
    const gy = elev + 2.5 + d * glideSlope;
    const gz = th.z + dirZ * d;
    const w = 40 + d * 0.0025;
    const h = 24 + d * 0.0015;

    const pts = [
      new THREE.Vector3(-w / 2, -h / 2, 0),
      new THREE.Vector3(w / 2, -h / 2, 0),
      new THREE.Vector3(w / 2, h / 2, 0),
      new THREE.Vector3(0, h / 2 + 5, 0),
      new THREE.Vector3(-w / 2, h / 2, 0),
      new THREE.Vector3(-w / 2, -h / 2, 0),
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: 0x06b6d4,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const gate = new THREE.Line(geo, mat);
    gate.position.set(gx, gy, gz);
    gate.rotation.y = -th.hdg * D2R;
    gate.userData = { distM: d, gx, gy, gz };
    gates.push(gate);
  }
  return gates;
}

/** Chevrons along the taxi route (world x/z points), oriented along each leg and ending with the runway heading. */
export function buildTaxiRibbon(
  path: [number, number][],
  endHdgDeg: number,
  heightAt: (x: number, z: number) => number | undefined,
  elev: number
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const shape = new THREE.Shape();
  shape.moveTo(-3, -2);
  shape.lineTo(0, 3);
  shape.lineTo(3, -2);
  shape.lineTo(1.5, -1.2);
  shape.lineTo(0, 1.6);
  shape.lineTo(-1.5, -1.2);
  shape.closePath();
  const arrowGeo = new THREE.ShapeGeometry(shape);
  arrowGeo.rotateX(-Math.PI / 2);
  const arrowMat = new THREE.MeshBasicMaterial({
    color: 0x06b6d4,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });
  if (path.length < 2) return meshes;
  const STEP = 22, MAX = 140;
  let carry = 0;
  for (let i = 0; i + 1 < path.length && meshes.length < MAX; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 0.5) continue;
    const hdg = Math.atan2(dx, -dz);
    for (let d = STEP - carry; d <= L && meshes.length < MAX; d += STEP) {
      const x = ax + (dx / L) * d, z = az + (dz / L) * d;
      const m = new THREE.Mesh(arrowGeo, arrowMat);
      m.position.set(x, (heightAt(x, z) ?? elev) + 0.18, z);
      m.rotation.y = -hdg;
      meshes.push(m);
      carry = L - d;
    }
    carry = (carry + 0) % STEP;
  }
  void endHdgDeg;
  return meshes;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();

export function computeWorldScreenMarkers(
  camera: THREE.PerspectiveCamera,
  world: World | null,
  planeLat: number,
  planeLon: number,
  fmPos: THREE.Vector3,
  flightPlan: FlightWaypoint[],
  activeWpIdx: number,
  approachTh: Threshold | null,
  toElev: number,
  toIcao: string
): WorldScreenMarker[] {
  if (!world) return [];
  const markers: WorldScreenMarker[] = [];
  camera.getWorldDirection(tmpV3);

  const projectPos = (
    pos: THREE.Vector3,
    id: string,
    label: string,
    distNm: number,
    altFt: number,
    type: 'waypoint' | 'airport' | 'runway'
  ) => {
    const toPos = tmpV.copy(pos).sub(camera.position);
    const dot = toPos.dot(tmpV3);
    const inFront = dot > 1.0;
    const proj = tmpV2.copy(pos).project(camera);
    const rawX = proj.x * 0.5 + 0.5;
    const rawY = -proj.y * 0.5 + 0.5;
    const inView = inFront && rawX >= 0.05 && rawX <= 0.95 && rawY >= 0.05 && rawY <= 0.95;
    let x = rawX;
    let y = rawY;
    const angleDeg = Math.round(Math.atan2(rawY - 0.5, rawX - 0.5) * R2D);
    if (!inFront) {
      x = rawX > 0.5 ? 0.06 : 0.94;
      y = 0.92;
    } else {
      x = clamp(rawX, 0.06, 0.94);
      y = clamp(rawY, 0.06, 0.94);
    }
    markers.push({ id, label, distNm, altFt, type, x, y, inView, angleDeg });
  };

  // 1. Active Waypoint
  if (flightPlan.length > 0 && activeWpIdx < flightPlan.length) {
    const wp = flightPlan[activeWpIdx];
    const wx = world.proj.x(wp.lon);
    const wz = world.proj.z(wp.lat);
    const wy = (world.terrain.heightAt(wx, wz) ?? 0) + (wp.altM || 1000);
    const distNm = haversine(planeLat, planeLon, wp.lat, wp.lon) / M_PER_NM;
    projectPos(new THREE.Vector3(wx, wy, wz), 'wp_' + wp.name, wp.name, distNm, Math.round(wy / 0.3048), 'waypoint');
  }

  // 2. Destination Runway or Airport
  if (approachTh) {
    const distNm = Math.hypot(fmPos.x - approachTh.x, fmPos.z - approachTh.z) / M_PER_NM;
    projectPos(
      new THREE.Vector3(approachTh.x, toElev + 5, approachTh.z),
      'dest_rwy',
      `RWY ${approachTh.ident} · ${toIcao}`,
      distNm,
      Math.round(toElev / 0.3048),
      'runway'
    );
  }

  return markers;
}
