import { useId } from 'react';

/**
 * Airbus A320-200 plan view (nose to the right) used by the loading screens.
 *
 * Geometry is traced from a published three-view of the A320-200 (Wikimedia Commons "Airbus A320 v1.0",
 * 3 757 x 3 410 x 1 176 cm) and checked against the type's data: length 37.57 m, geometric span 34.10 m,
 * fuselage diameter 3.95 m, 25° quarter-chord sweep, CFM56 / V2500 nacelles under the wings at ≈ 34 % of
 * the semi-span, swept tailplane with the fin visible as a thin spine, tapered tail cone.
 * The coordinates below are the three-view's own pixel grid (nose left, centre-line y = 570) so they can be
 * overlaid on the source drawing 1:1; the group transform mirrors them so the aircraft flies to the right.
 */
export const A320_PLAN = {
  /** x-range of the airframe in drawing pixels (nose tip .. tail cone tip) -> 37.57 m */
  noseX: 30, tailX: 655, centreY: 570,
  fuselageHalf:
    'M30 570 C30 552 56 537 96 537 L500 537 C560 537 620 556 655 565 L655 570 Z',
  wingHalf: 'M235 537 L372 288 L402 290 L346 462 L343 537 Z',
  /** hinge line of flaps / ailerons (a plain offset of the trailing edge) */
  wingHinge: 'M331 537 L334 466 L388 293',
  /** slats on the leading edge */
  wingSlat: 'M244 531 L372 296',
  nacelleHalf:
    'M223 463 Q217 475 223 488 L262 492 Q276 490 277 482 L277 468 Q276 460 262 458 Z',
  tailplaneHalf: 'M566 549 L611 467 L640 467 L622 555 Z',
  tailplaneHinge: 'M600 553 L626 470',
  finSpine: 'M505 570 C520 565 600 564 640 566 L640 570 Z',
  /** cockpit windscreen band + side windows, a few fuselage doors */
  windscreen: 'M52 555 Q68 543 92 541 L92 550 Q74 551 62 560 Z',
  doors: [[105, 537, 16], [513, 537, 16]] as [number, number, number][],
} as const;

const G = A320_PLAN;
const MIRROR = `translate(${G.noseX + G.tailX} 0) scale(-1 1)`; // nose to the right
const FLIP = `translate(0 ${G.centreY * 2}) scale(1 -1)`; // lower half from the upper one

/** Everything that makes up one half of the aircraft (upper half in drawing space). */
function Half({ lit, accent, hull }: { lit: boolean; accent: string; hull: string }) {
  const stroke = lit ? 'rgba(20,34,60,.55)' : 'rgba(150,190,255,.7)';
  const sw = lit ? 0.9 : 1.1;
  const common = { stroke, strokeWidth: sw, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const };
  const wingFill = lit ? '#dfe6ee' : 'none';
  const hullFill = lit ? `url(#${hull})` : 'none';
  return (
    <g>
      {/* wing + pylon + nacelle sit behind the fuselage, tailplane at the rear */}
      <path d={G.wingHalf} fill={wingFill} {...common} />
      <path d={G.wingHinge} fill="none" {...common} strokeWidth={sw * 0.8} opacity={0.7} />
      <path d={G.wingSlat} fill="none" {...common} strokeWidth={sw * 0.8} opacity={0.6} />
      <path d={G.nacelleHalf} fill={lit ? '#eef2f6' : 'none'} {...common} />
      {lit && <path d="M223 465 Q219 475 223 486" fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" opacity=".95" />}
      <path d={G.tailplaneHalf} fill={wingFill} {...common} />
      <path d={G.tailplaneHinge} fill="none" {...common} strokeWidth={sw * 0.8} opacity={0.7} />
      <path d={G.fuselageHalf} fill={hullFill} {...common} />
      <path d={G.windscreen} fill={lit ? '#1b2a44' : 'none'} {...common} strokeWidth={sw * 0.9} />
      {G.doors.map(([x, y, w]) => (
        <rect key={x} x={x} y={y} width={w} height="5" rx="1.5" fill="none" {...common} strokeWidth={sw * 0.7} opacity={0.65} />
      ))}
    </g>
  );
}

function Airframe({ lit, accent, hull }: { lit: boolean; accent: string; hull: string }) {
  return (
    <g transform={MIRROR}>
      <Half lit={lit} accent={accent} hull={hull} />
      <g transform={FLIP}><Half lit={lit} accent={accent} hull={hull} /></g>
      {/* the fin seen from above: a thin spine on the centre-line, carrying the livery accent when lit */}
      <path d={G.finSpine} fill={lit ? accent : 'none'} stroke={lit ? 'rgba(10,30,40,.6)' : 'rgba(150,190,255,.7)'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path d={G.finSpine} transform={FLIP} fill={lit ? accent : 'none'} stroke={lit ? 'rgba(10,30,40,.6)' : 'rgba(150,190,255,.7)'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/**
 * `progress` 0..1 paints the airframe from tail to nose over a blueprint outline, like a scan sweeping in the
 * direction of flight. `accent` is the livery colour (spec.accent of the A320 is 0x0b7a9e).
 */
export function A320Plan({ progress, accent = '#0b7a9e', className = '' }: { progress: number; accent?: string; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const x0 = 20, w = 650; // viewBox x-range
  const p = Math.max(0, Math.min(1, progress));
  const edge = x0 + p * w;
  return (
    <svg viewBox="20 280 650 580" className={className} role="img" aria-label="Airbus A320-200 seen from above" shapeRendering="geometricPrecision">
      <defs>
        <linearGradient id={`hull-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cdd6e0" />
        </linearGradient>
        <clipPath id={`clip-${uid}`}><rect x={x0 - 4} y="270" width={Math.max(0, edge - x0 + 4)} height="600" /></clipPath>
        <linearGradient id={`scan-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5ea2ff" stopOpacity="0" />
          <stop offset="1" stopColor="#8cc2ff" stopOpacity=".55" />
        </linearGradient>
      </defs>
      {/* blueprint layer */}
      <g opacity=".9"><Airframe lit={false} accent={accent} hull={`hull-${uid}`} /></g>
      {/* painted layer revealed by the sweep */}
      <g clipPath={`url(#clip-${uid})`}>
        <Airframe lit accent={accent} hull={`hull-${uid}`} />
      </g>
      {p > 0.002 && p < 0.998 && (
        <g>
          <rect x={edge - 46} y="282" width="46" height="576" fill={`url(#scan-${uid})`} />
          <rect x={edge - 0.75} y="282" width="1.5" height="576" fill="#a9d0ff" />
        </g>
      )}
    </svg>
  );
}
