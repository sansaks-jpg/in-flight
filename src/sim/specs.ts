// Aircraft definitions (fictional-but-representative GA / turboprop / airliner, tuned from public-domain type data).
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
}

export const AIRCRAFT: AircraftSpec[] = [
  {
    id: 'swift', name: 'Aero Swift RG', role: 'Light single · retractable', kind: 'piston', engines: 1,
    blurb: 'Forgiving four-seat tourer. Short field, slow approach, perfect for learning.',
    emptyMass: 790, payload: 260, fuelCap: 150, fuelFlow: 0.0105,
    S: 15.2, b: 10.9, c: 1.45, Ixx: 1300, Iyy: 1800, Izz: 2700,
    CL0: 0.3, CLa: 5.0, CLmax: 1.55, flapCL: 0.45, CD0: 0.027, e: 0.78, flapCD: 0.05, gearCD: 0.016, sbCD: 0,
    Cma: -1.1, Cm0: 0.07, Cmq: -14, Cmde: 0.95, Clb: -0.09, Clp: -0.5, Clda: 0.22, Cnb: 0.1, Cnr: -0.1, Cndr: 0.09,
    power: 165000, thrust: 0, staticV0: 45, propEff: 0.8, spoolUp: 0.7, spoolDown: 1.0, idle: 0.2, ceiling: 5500,
    flapDetents: 3, vfe: [999, 100, 85], vle: 130, vne: 175, vs1: 56, vs0: 49, vr: 62, vapp: 68,
    maxPitchRate: 0.22, maxRollRate: 1.0, maxSteer: 0.3, propTorque: 0.03,
    gear: [{ pos: [0, -1.2, -1.45], share: 0.14, nose: true }, { pos: [-1.5, -1.2, 0.35], share: 0.43 }, { pos: [1.5, -1.2, 0.35], share: 0.43 }],
    hull: [[0, -0.2, -2.7], [0, 0.4, 5.4], [-5.45, -0.55, 0.2], [5.45, -0.55, 0.2], [0, -0.85, 0.2]], gearTravel: 0.35, maxSink: 3.8,
    pax: 3, cruiseAlt: 2400, cruiseKt: 125, rangeKm: 950, hasSpeedbrake: false, hasReverse: false, hasGlass: false,
    eye: [-0.33, 0.42, -0.55], color: 0xf4f6f8, accent: 0x1c6dd0, length: 8.2,
  },
  {
    id: 'trek', name: 'Aero Trek T2', role: 'Twin turboprop · STOL commuter', kind: 'turboprop', engines: 2,
    blurb: 'Rugged twin with big flaps and reverse thrust. Hauls 12 passengers into short strips.',
    emptyMass: 3700, payload: 1300, fuelCap: 1000, fuelFlow: 0.085,
    S: 39, b: 19.8, c: 2.0, Ixx: 14000, Iyy: 22000, Izz: 33000,
    CL0: 0.32, CLa: 5.2, CLmax: 1.6, flapCL: 0.7, CD0: 0.034, e: 0.8, flapCD: 0.07, gearCD: 0.02, sbCD: 0,
    Cma: -1.3, Cm0: 0.08, Cmq: -17, Cmde: 1.1, Clb: -0.1, Clp: -0.55, Clda: 0.2, Cnb: 0.12, Cnr: -0.12, Cndr: 0.1,
    power: 1300000, thrust: 0, staticV0: 70, propEff: 0.82, spoolUp: 1.4, spoolDown: 1.8, idle: 0.18, ceiling: 8500,
    flapDetents: 3, vfe: [999, 130, 105], vle: 165, vne: 235, vs1: 62, vs0: 50, vr: 70, vapp: 82,
    maxPitchRate: 0.18, maxRollRate: 0.8, maxSteer: 0.4, propTorque: 0.02,
    gear: [{ pos: [0, -1.75, -4.6], share: 0.12, nose: true }, { pos: [-1.9, -1.75, 0.5], share: 0.44 }, { pos: [1.9, -1.75, 0.5], share: 0.44 }],
    hull: [[0, -0.5, -6.6], [0, 1.0, 8.0], [-9.9, 1.4, 0.4], [9.9, 1.4, 0.4], [0, -1.05, 0.5], [-3.6, -1.1, -2.8], [3.6, -1.1, -2.8]], gearTravel: 0.45, maxSink: 4.2,
    pax: 12, cruiseAlt: 4500, cruiseKt: 190, rangeKm: 1300, hasSpeedbrake: false, hasReverse: true, hasGlass: false,
    eye: [-0.45, 0.62, -5.1], color: 0xf2f2ee, accent: 0xd8512a, length: 15.8,
  },
  {
    id: 'sky', name: 'Skyliner 320', role: 'Narrow-body jet airliner', kind: 'jet', engines: 2,
    blurb: '150 passengers, glass cockpit, spoilers, autobrake-style reversers and a real ILS autopilot.',
    emptyMass: 42000, payload: 14500, fuelCap: 19000, fuelFlow: 1.05,
    S: 122.6, b: 34.1, c: 4.29, Ixx: 1400000, Iyy: 3000000, Izz: 4200000,
    CL0: 0.25, CLa: 5.2, CLmax: 1.45, flapCL: 0.95, CD0: 0.022, e: 0.8, flapCD: 0.05, gearCD: 0.02, sbCD: 0.07,
    Cma: -1.5, Cm0: 0.1, Cmq: -22, Cmde: 1.2, Clb: -0.1, Clp: -0.5, Clda: 0.16, Cnb: 0.13, Cnr: -0.14, Cndr: 0.09,
    power: 0, thrust: 225000, staticV0: 0, propEff: 0, spoolUp: 2.6, spoolDown: 3.2, idle: 0.2, ceiling: 12000,
    flapDetents: 5, vfe: [999, 230, 215, 195, 180, 162], vle: 250, vne: 350, vs1: 118, vs0: 103, vr: 142, vapp: 138,
    maxPitchRate: 0.12, maxRollRate: 0.45, maxSteer: 0.5, propTorque: 0,
    gear: [{ pos: [0, -3.3, -12.6], share: 0.09, nose: true }, { pos: [-3.9, -3.3, 1.3], share: 0.455 }, { pos: [3.9, -3.3, 1.3], share: 0.455 }],
    hull: [[0, -1.6, -17.6], [0, -0.4, 19.5], [-17.0, -0.9, 3.0], [17.0, -0.9, 3.0], [0, -2.0, 1.0], [-5.7, -2.5, -4.0], [5.7, -2.5, -4.0]], gearTravel: 0.55, maxSink: 4.6,
    pax: 150, cruiseAlt: 11000, cruiseKt: 450, rangeKm: 4800, hasSpeedbrake: true, hasReverse: true, hasGlass: true,
    eye: [-0.55, 0.45, -16.0], color: 0xf7f8fa, accent: 0x0b7a9e, length: 37.6,
  },
];
export const specById = (id: string) => AIRCRAFT.find((a) => a.id === id) || AIRCRAFT[0];
