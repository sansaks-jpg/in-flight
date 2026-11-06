// Aircraft definitions: REAL types at 1:1 real-world scale. Dimensions, weights, speeds and gear geometry come from the
// manufacturers' published data (verified online):
//   C172S  Cessna Skyhawk SP : L 8.28 m, b 11.0 m, S 16.2 m2, MTOW 1157 kg, Vne 163 / Vfe 110 kt, Vs1 53 / Vs0 48 KCAS, wheelbase ~1.66 m, track ~2.52 m
//   ATR 72-600               : L 27.17 m, b 27.05 m, H 7.65 m, S 61 m2, MTOW 23 000 kg, 2x PW127M (2 475 shp), fuel 5 000 kg
//   A320-200 (CFM56-5B)      : L 37.57 m, b 34.10 m, H 11.76 m, S 122.6 m2, MTOW 78 000 kg, OEW ~42 600 kg, wheelbase 12.64 m, track 7.59 m,
//                              Mmo 0.82, 2x 120 kN, fuel 23 860 L (18 730 kg)
// Body frame: +X right, +Y up, -Z forward, origin = centre of gravity. Gear / hull points are CG-relative.
export interface GearSpec { pos: [number, number, number]; share: number; nose?: boolean; }
export interface AircraftSpec {
  id: string; name: string; role: string; blurb: string; kind: 'piston' | 'turboprop' | 'jet'; engines: number;
  emptyMass: number; payload: number; fuelCap: number; fuelFlow: number; // kg, kg, kg, kg/s per engine @ full power
  S: number; b: number; c: number; Ixx: number; Iyy: number; Izz: number;
  CL0: number; CLa: number; CLmax: number; flapCL: number; CD0: number; e: number; flapCD: number; gearCD: number; sbCD: number;
  Cma: number; Cm0: number; Cmq: number; Cmde: number; Clb: number; Clp: number; Clda: number; Cnb: number; Cnr: number; Cndr: number;
  power: number; thrust: number; staticV0: number; propEff: number; // piston/turboprop power (W total) | jet thrust (N total)
  spoolUp: number; spoolDown: number; idle: number; ceiling: number;
  flapDetents: number; vfe: number[]; vle: number; vne: number; vs1: number; vs0: number; vr: number; vapp: number; // knots
  maxPitchRate: number; maxRollRate: number; maxSteer: number; propTorque: number;
  gear: GearSpec[]; hull: [number, number, number][]; gearTravel: number; maxSink: number;
  pax: number; cruiseAlt: number; cruiseKt: number; rangeKm: number; hasSpeedbrake: boolean; hasReverse: boolean; hasGlass: boolean;
  eye: [number, number, number]; color: number; accent: number; length: number;
  /** Real-world type information. */
  icao: string; realName: string; wingspan: number; height: number;
  /** Flap detent used for take-off (CONF 2 / flaps 15 / flaps 10). */
  toFlaps: number;
  /** Non-retractable undercarriage. */
  fixedGear: boolean;
  /** Seconds from starter engage to stabilised idle. */
  startSecs: number;
  /** Wheel radius [main, nose] in metres (real tyre sizes). */
  wheelR: [number, number];
  /** Maximum take-off / landing mass (kg). */
  mtow: number; mlw: number;
}

export const AIRCRAFT: AircraftSpec[] = [
  {
    id: 'swift', name: 'Cessna 172S Skyhawk', role: 'Light single · piston · IO-360-L2A 180 hp', kind: 'piston', engines: 1,
    blurb: 'The world\'s most-built trainer. Fixed gear, 11.0 m wing, Vr 55 kt. Real Lycoming start-up: battery, mixture rich, prime, key.',
    emptyMass: 767, payload: 175, fuelCap: 144, fuelFlow: 0.0105,
    S: 16.2, b: 11.0, c: 1.49, Ixx: 1285, Iyy: 1825, Izz: 2667,
    CL0: 0.31, CLa: 5.0, CLmax: 1.55, flapCL: 0.4, CD0: 0.034, e: 0.75, flapCD: 0.045, gearCD: 0, sbCD: 0,
    Cma: -1.1, Cm0: 0.07, Cmq: -14, Cmde: 0.95, Clb: -0.09, Clp: -0.5, Clda: 0.22, Cnb: 0.1, Cnr: -0.1, Cndr: 0.09,
    power: 134000, thrust: 0, staticV0: 42, propEff: 0.78, spoolUp: 0.7, spoolDown: 1.0, idle: 0.2, ceiling: 4270,
    flapDetents: 3, vfe: [999, 110, 85, 85], vle: 163, vne: 163, vs1: 53, vs0: 48, vr: 55, vapp: 65,
    maxPitchRate: 0.22, maxRollRate: 0.9, maxSteer: 0.3, propTorque: 0.03,
    gear: [{ pos: [0, -1.05, -1.18], share: 0.28, nose: true }, { pos: [-1.26, -1.05, 0.475], share: 0.36 }, { pos: [1.26, -1.05, 0.475], share: 0.36 }],
    hull: [[0, -0.74, -2.3], [0, 0.0, 5.4], [-5.5, 0.9, 0.1], [5.5, 0.9, 0.1], [0, -0.3, 0.6]], gearTravel: 0.22, maxSink: 3.8,
    pax: 3, cruiseAlt: 2400, cruiseKt: 122, rangeKm: 1185, hasSpeedbrake: false, hasReverse: false, hasGlass: false,
    eye: [-0.33, 0.45, -0.55], color: 0xf4f6f8, accent: 0x1c6dd0, length: 8.28,
    icao: 'C172', realName: 'Cessna 172S Skyhawk SP', wingspan: 11.0, height: 2.72, toFlaps: 0, fixedGear: true, startSecs: 4, wheelR: [0.17, 0.15], mtow: 1157, mlw: 1157,
  },
  {
    id: 'trek', name: 'ATR 72-600', role: 'Twin turboprop · regional airliner · PW127M', kind: 'turboprop', engines: 2,
    blurb: '70 seats, 27.05 m high wing, 6-blade Hamilton Standard props. Real turboprop start: battery, bleeds, condition levers, starter.',
    emptyMass: 13010, payload: 5000, fuelCap: 5000, fuelFlow: 0.14,
    S: 61, b: 27.05, c: 2.43, Ixx: 250000, Iyy: 420000, Izz: 600000,
    CL0: 0.32, CLa: 5.4, CLmax: 1.75, flapCL: 1.4, CD0: 0.032, e: 0.82, flapCD: 0.06, gearCD: 0.018, sbCD: 0,
    Cma: -1.3, Cm0: 0.08, Cmq: -17, Cmde: 1.1, Clb: -0.1, Clp: -0.55, Clda: 0.2, Cnb: 0.12, Cnr: -0.12, Cndr: 0.1,
    power: 3690000, thrust: 0, staticV0: 48, propEff: 0.82, spoolUp: 2.2, spoolDown: 2.6, idle: 0.18, ceiling: 7620,
    flapDetents: 2, vfe: [999, 170, 150], vle: 185, vne: 250, vs1: 111, vs0: 90, vr: 105, vapp: 111,
    maxPitchRate: 0.16, maxRollRate: 0.6, maxSteer: 0.45, propTorque: 0.02,
    gear: [{ pos: [0, -2.06, -9.9], share: 0.1, nose: true }, { pos: [-2.05, -2.06, 1.1], share: 0.45 }, { pos: [2.05, -2.06, 1.1], share: 0.45 }],
    hull: [[0, -1.2, -11.0], [0, 0.0, 14.6], [-13.5, 1.2, 1.5], [13.5, 1.2, 1.5], [0, -1.5, 2.0]], gearTravel: 0.4, maxSink: 4.2,
    pax: 70, cruiseAlt: 5200, cruiseKt: 275, rangeKm: 1528, hasSpeedbrake: false, hasReverse: true, hasGlass: true,
    eye: [-0.45, 1.25, -9.7], color: 0xf2f2ee, accent: 0xd8512a, length: 27.17,
    icao: 'AT76', realName: 'ATR 72-600', wingspan: 27.05, height: 7.65, toFlaps: 1, fixedGear: false, startSecs: 22, wheelR: [0.5, 0.35], mtow: 23000, mlw: 22350,
  },
  {
    id: 'sky', name: 'Airbus A320-200', role: 'Narrow-body jet airliner · CFM56-5B', kind: 'jet', engines: 2,
    blurb: '37.57 m long, 34.10 m span, 2 × 120 kN. Real ECAM-style cold-and-dark start: battery, APU, beacon, engine mode, master switches.',
    emptyMass: 42600, payload: 14500, fuelCap: 18730, fuelFlow: 0.75,
    S: 122.6, b: 34.1, c: 4.19, Ixx: 1400000, Iyy: 3000000, Izz: 4200000,
    CL0: 0.25, CLa: 5.2, CLmax: 1.5, flapCL: 1.1, CD0: 0.022, e: 0.8, flapCD: 0.05, gearCD: 0.02, sbCD: 0.07,
    Cma: -1.5, Cm0: 0.1, Cmq: -22, Cmde: 1.2, Clb: -0.1, Clp: -0.5, Clda: 0.16, Cnb: 0.13, Cnr: -0.14, Cndr: 0.09,
    power: 0, thrust: 205000, staticV0: 0, propEff: 0, spoolUp: 3.2, spoolDown: 3.8, idle: 0.2, ceiling: 11900,
    flapDetents: 4, vfe: [999, 230, 215, 195, 190], vle: 280, vne: 350, vs1: 142, vs0: 108, vr: 145, vapp: 135,
    maxPitchRate: 0.12, maxRollRate: 0.45, maxSteer: 0.5, propTorque: 0,
    gear: [{ pos: [0, -3.3, -11.44], share: 0.09, nose: true }, { pos: [-3.795, -3.3, 1.2], share: 0.455 }, { pos: [3.795, -3.3, 1.2], share: 0.455 }],
    hull: [[0, -1.7, -14.0], [0, 0.8, 20.5], [-17.05, 1.2, 5.0], [17.05, 1.2, 5.0], [0, -1.85, 0.5], [-5.75, -2.8, -3.5], [5.75, -2.8, -3.5]], gearTravel: 0.5, maxSink: 4.6,
    pax: 150, cruiseAlt: 11000, cruiseKt: 447, rangeKm: 5700, hasSpeedbrake: true, hasReverse: true, hasGlass: true,
    eye: [-0.55, 1.45, -12.9], color: 0xf7f8fa, accent: 0x0b7a9e, length: 37.57,
    icao: 'A320', realName: 'Airbus A320-200', wingspan: 34.1, height: 11.76, toFlaps: 2, fixedGear: false, startSecs: 28, wheelR: [0.585, 0.38], mtow: 78000, mlw: 66000,
  },
];
export const specById = (id: string) => AIRCRAFT.find((a) => a.id === id) || AIRCRAFT[0];
