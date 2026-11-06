import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { AIRPORTS, Airport, Runway, getAirfield } from '../data/airports';
import { AIRCRAFT, specById } from '../sim/specs';
import { bearing, destination, haversine } from '../sim/geo';
import { Settings } from '../sim/storage';
import { FlightIcon } from './FlightIcon';
import {
  AIRCRAFT_VARIANTS,
  AircraftVariantInfo,
  computeGlobeEulerForLatLon,
  computeMenuContinentalTarget,
  computeRouteDispatch,
  computeRouteFocusView,
  filterAircraftVariants,
  getAircraftStatsComparison,
  HangarCategory,
  latDegToEquirectangularY,
  latLonToMercatorTile,
  latLonToUnitSphere,
  mercatorTileYToLatDeg,
  REPO_FACTS,
} from './flightDispatch';

/* =========================================================================
   1. MSFS 2024 TOP-RIGHT PILOT & SYSTEM BAR (USED ACROSS ALL PRE-GAME SCREENS)
   ========================================================================= */

export function MsfsTopRightBar({
  pilotName,
  onOpenModal,
}: {
  pilotName: string;
  onOpenModal?: (m: 'scores' | 'settings' | 'controls' | 'credits') => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5 select-none pointer-events-auto">
      {/* Device Input Indicator */}
      <div className="hidden sm:flex items-center gap-1.5 bg-[#0f141d]/95 border border-white/15 px-2.5 h-8 text-[10px] font-mono tracking-wider text-slate-300 uppercase">
        <span>JOYSTICK / KBD</span>
      </div>

      {/* Pilot Callsign Banner (Matches MSFS 2024 top-right callsign strip) */}
      <div
        className="flex items-center gap-2.5 pl-2.5 pr-4 h-8 bg-[#1e56b8] border border-sky-300/35 shadow-md"
        style={{
          clipPath: 'polygon(6px 0, 100% 0, 100% 100%, 0 100%)',
        }}
      >
        <div className="w-5 h-5 bg-[#0c1526] border border-white/30 grid place-items-center text-sky-200">
          <FlightIcon name="user" size={12} />
        </div>
        <span className="text-xs font-extrabold tracking-wide text-white">
          {pilotName || 'EasyjetSim'}
        </span>
      </div>

      {/* Action Icon Cluster */}
      <div className="flex items-center gap-0.5 bg-[#0f141d]/95 border border-white/15 px-1.5 h-8">
        {onOpenModal && (
          <>
            <button
              type="button"
              onClick={() => onOpenModal('scores')}
              className="w-7 h-7 grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition"
              title="Pilot Logbook & High Scores"
              aria-label="Pilot Logbook"
            >
              <FlightIcon name="trophy" size={14} />
            </button>
            <button
              type="button"
              onClick={() => onOpenModal('controls')}
              className="w-7 h-7 grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition"
              title="Keyboard & Controller Bindings"
              aria-label="Flight Controls"
            >
              <FlightIcon name="keyboard" size={14} />
            </button>
            <button
              type="button"
              onClick={() => onOpenModal('credits')}
              className="w-7 h-7 grid place-items-center text-white bg-[#15803d] hover:bg-[#16a34a] transition mx-0.5"
              title={`Verified Scenery Data (${REPO_FACTS.totalAirports.toLocaleString()} Airports)`}
              aria-label="Aeronautical Data"
            >
              <FlightIcon name="globe" size={14} />
            </button>
            <button
              type="button"
              onClick={() => onOpenModal('settings')}
              className="w-7 h-7 grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition"
              title="Simulation Settings"
              aria-label="Simulation Settings"
            >
              <FlightIcon name="settings" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   2. STUDIO AIRCRAFT RENDER VISUAL + SVG FALLBACK
   ========================================================================= */

export function AircraftArtworkSvg({
  aircraftId,
  accentColor = '#2572eb',
  bellyColor = '#1e3a8a',
  className = 'w-full h-full',
}: {
  aircraftId: string;
  accentColor?: string;
  bellyColor?: string;
  className?: string;
}) {
  if (aircraftId === 'sky') {
    return (
      <svg viewBox="0 0 320 150" className={className} fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={`fuselage-${accentColor}`} x1="60" y1="45" x2="245" y2="105" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="65%" stopColor="#e2e8f0" />
            <stop offset="100%" stopColor="#94a3b8" />
          </linearGradient>
        </defs>
        <ellipse cx="165" cy="128" rx="95" ry="7" fill="rgba(0,0,0,0.35)" />
        <path d="M168 78 L296 63 L304 59 L299 67 L186 86 Z" fill="#cbd5e1" stroke="#64748b" strokeWidth="0.8" />
        <path d="M296 63 L305 49 L301 66 Z" fill={accentColor} />
        <path d="M74 64 L46 18 L66 18 L102 64 Z" fill={accentColor} />
        <path d="M54 30 L76 30 L90 52 L64 52 Z" fill="rgba(255,255,255,0.22)" />
        <path d="M62 64 L32 69 L44 72 L78 68 Z" fill="#94a3b8" />
        <path d="M142 78 L16 60 L22 57 L156 72 Z" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="0.8" />
        <path d="M16 60 L10 46 L21 58 Z" fill={accentColor} />
        <path
          d="M58 63 C95 57, 175 56, 224 64 C244 68, 255 76, 252 84 C248 92, 225 95, 182 94 C130 93, 82 84, 58 72 Z"
          fill={`url(#fuselage-${accentColor})`}
        />
        <path
          d="M72 67 C115 64, 185 65, 244 74 C240 82, 218 85, 176 84 C128 82, 90 76, 72 67 Z"
          fill={accentColor}
          opacity="0.88"
        />
        <path
          d="M95 82 C135 86, 195 88, 246 84 C238 91, 212 94, 172 93 C135 92, 108 87, 95 82 Z"
          fill={bellyColor}
          opacity="0.7"
        />
        <path d="M222 67 L239 70 L243 75 L226 74 L217 71 Z" fill="#0f172a" stroke="#38bdf8" strokeWidth="0.7" />
        <path d="M100 69 L204 71" stroke="#1e293b" strokeWidth="2.2" strokeDasharray="2.5 3.5" strokeLinecap="round" />
        <line x1="226" y1="91" x2="226" y2="112" stroke="#94a3b8" strokeWidth="2" />
        <circle cx="226" cy="114" r="3.5" fill="#0f172a" stroke="#475569" strokeWidth="1" />
        <line x1="154" y1="90" x2="154" y2="109" stroke="#94a3b8" strokeWidth="2.2" />
        <circle cx="152" cy="111" r="4" fill="#0f172a" stroke="#475569" strokeWidth="1" />
        <circle cx="157" cy="111" r="4" fill="#0f172a" stroke="#475569" strokeWidth="1" />
        <ellipse cx="116" cy="83" rx="13" ry="9" fill={accentColor} />
        <ellipse cx="119" cy="83" rx="8" ry="6.5" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />
        <ellipse cx="212" cy="86" rx="14" ry="9.5" fill={accentColor} />
        <ellipse cx="215" cy="86" rx="8.5" ry="7" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />
      </svg>
    );
  }

  if (aircraftId === 'trek') {
    return (
      <svg viewBox="0 0 320 150" className={className} fill="none" aria-hidden="true">
        <ellipse cx="160" cy="126" rx="85" ry="6" fill="rgba(0,0,0,0.35)" />
        <path d="M62 66 L42 22 L64 22 L88 66 Z" fill={accentColor} />
        <path d="M22 54 L298 54 L292 61 L28 61 Z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
        <path d="M22 54 L46 54 L44 61 L28 61 Z" fill={accentColor} />
        <path d="M274 54 L298 54 L292 61 L276 61 Z" fill={accentColor} />
        <path
          d="M54 64 L216 62 C238 64, 248 72, 246 82 C243 90, 224 92, 185 92 L58 76 Z"
          fill="#f8fafc"
          stroke="#cbd5e1"
          strokeWidth="0.8"
        />
        <path d="M62 74 L242 76 L238 83 L66 80 Z" fill={accentColor} />
        <path d="M74 82 L232 84 L224 91 L82 88 Z" fill={bellyColor} opacity="0.75" />
        <path d="M208 65 L230 68 L234 74 L212 73 Z" fill="#0f172a" stroke="#38bdf8" strokeWidth="0.7" />
        <path d="M104 70 L192 70" stroke="#0f172a" strokeWidth="4" strokeDasharray="6 5" />
        <rect x="102" y="55" width="22" height="12" rx="5" fill={accentColor} />
        <ellipse cx="126" cy="61" rx="3" ry="18" fill="rgba(226,232,240,0.35)" stroke="#cbd5e1" strokeWidth="0.8" />
        <rect x="198" y="55" width="22" height="12" rx="5" fill={accentColor} />
        <ellipse cx="222" cy="61" rx="3" ry="18" fill="rgba(226,232,240,0.35)" stroke="#cbd5e1" strokeWidth="0.8" />
        <line x1="224" y1="90" x2="224" y2="110" stroke="#94a3b8" strokeWidth="2.2" />
        <circle cx="224" cy="112" r="4" fill="#0f172a" stroke="#64748b" strokeWidth="1.2" />
        <line x1="152" y1="90" x2="146" y2="110" stroke="#94a3b8" strokeWidth="2.5" />
        <circle cx="146" cy="112" r="5" fill="#0f172a" stroke="#64748b" strokeWidth="1.2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 320 150" className={className} fill="none" aria-hidden="true">
      <ellipse cx="160" cy="126" rx="75" ry="6" fill="rgba(0,0,0,0.35)" />
      <path d="M68 68 L48 28 L68 28 L92 68 Z" fill={accentColor} />
      <path d="M30 80 L144 74 L162 82 L36 86 Z" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="0.9" />
      <path d="M168 76 L292 72 L286 79 L176 84 Z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.9" />
      <path
        d="M62 67 C108 62, 178 60, 228 69 C242 72, 248 77, 246 83 C242 89, 216 91, 168 90 C118 89, 82 81, 62 74 Z"
        fill="#f8fafc"
      />
      <path d="M66 72 C122 70, 188 72, 244 78 L238 84 C184 79, 120 78, 70 77 Z" fill={accentColor} />
      <path d="M142 63 C162 55, 194 56, 212 67 L146 69 Z" fill="#0f172a" stroke="#38bdf8" strokeWidth="0.9" />
      <path d="M244 73 L256 77 L244 82 Z" fill={accentColor} />
      <ellipse cx="255" cy="77" rx="3.5" ry="22" fill="rgba(226,232,240,0.38)" stroke="#e2e8f0" strokeWidth="0.9" />
      <line x1="224" y1="88" x2="226" y2="109" stroke="#94a3b8" strokeWidth="2" />
      <circle cx="226" cy="111" r="3.8" fill="#0f172a" stroke="#64748b" strokeWidth="1" />
      <line x1="158" y1="88" x2="155" y2="109" stroke="#94a3b8" strokeWidth="2.2" />
      <circle cx="155" cy="111" r="4.2" fill="#0f172a" stroke="#64748b" strokeWidth="1" />
    </svg>
  );
}

export function AircraftStudioCardVisual({
  variant,
  className = 'w-full h-full',
  imgClassName = 'w-full h-full object-cover',
  showLiveryStripe = true,
}: {
  variant: AircraftVariantInfo;
  className?: string;
  imgClassName?: string;
  showLiveryStripe?: boolean;
}) {
  const [imgError, setImgError] = useState(false);

  return (
    <div className={`relative overflow-hidden bg-[#1e2633] ${className}`}>
      {!imgError && variant.imageUrl ? (
        <img
          src={variant.imageUrl}
          alt={variant.title}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className={imgClassName}
        />
      ) : (
        <AircraftArtworkSvg
          aircraftId={variant.aircraftId}
          accentColor={variant.accentColor}
          bellyColor={variant.bellyColor}
          className="w-full h-full p-2"
        />
      )}
      {showLiveryStripe && (
        <span
          className="absolute bottom-0 inset-x-0 h-1 pointer-events-none"
          style={{ backgroundColor: variant.accentColor }}
        />
      )}
    </div>
  );
}

/* =========================================================================
   3. AUTHENTIC 3D SATELLITE EARTH GLOBE (SOLID GLOSSY PBR, MULTI-ZOOM TILES)
   ========================================================================= */

// Detailed continental & island polygons [lat, lon][] used to paint the initial Blue Marble
// satellite base before/underneath live Esri World Imagery satellite tiles.
const SATELLITE_LAND_POLYS: { coords: [number, number][]; color: string; highland?: string }[] = [
  // North America
  {
    coords: [
      [71, -162], [70, -128], [62, -110], [64, -76], [49, -54], [43, -69], [31, -81], [25, -80],
      [19, -96], [8, -78], [14, -91], [22, -106], [33, -118], [48, -124], [60, -146], [64, -166],
    ],
    color: '#2c4f38',
    highland: '#5c5346',
  },
  // South America
  {
    coords: [
      [11, -75], [10, -61], [4, -50], [-6, -35], [-18, -39], [-24, -46], [-35, -54],
      [-54, -68], [-50, -75], [-33, -71], [-18, -71], [-5, -81], [4, -77],
    ],
    color: '#244a32',
    highland: '#4d473d',
  },
  // Eurasia
  {
    coords: [
      [36, -9], [43, -9], [48, -4], [54, 8], [70, 22], [72, 80], [71, 145], [64, 175],
      [52, 140], [38, 121], [22, 114], [8, 104], [2, 103], [16, 96], [22, 88], [8, 77],
      [25, 66], [26, 56], [13, 44], [32, 34], [38, 24], [41, 15], [43, 5],
    ],
    color: '#345339',
    highland: '#7a6a53',
  },
  // Africa & Arabian Peninsula
  {
    coords: [
      [35, -6], [37, 10], [32, 32], [28, 48], [13, 45], [11, 51], [-2, 41], [-15, 40],
      [-26, 33], [-34, 18], [-18, 12], [-5, 12], [4, 9], [5, -8], [15, -17], [28, -13],
    ],
    color: '#7c684b',
    highland: '#2a4d34',
  },
  // Indonesia Archipelago (Sumatra, Java, Kalimantan, Sulawesi, Papua)
  {
    coords: [[5.6, 95.2], [1.6, 102.6], [-5.9, 105.9], [-3.2, 100.1]],
    color: '#1f4d32',
  },
  {
    coords: [[-6.0, 106.0], [-6.8, 112.9], [-8.5, 114.6], [-7.8, 109.0]],
    color: '#235337',
  },
  {
    coords: [[4.3, 117.6], [1.0, 118.9], [-3.5, 116.3], [-3.1, 110.1], [1.2, 109.1]],
    color: '#1e4b30',
  },
  {
    coords: [[1.6, 125.1], [-2.0, 121.6], [-5.5, 120.2], [-4.1, 122.9]],
    color: '#225034',
  },
  {
    coords: [[-0.8, 131.2], [-2.5, 140.9], [-8.5, 140.5], [-4.8, 136.0]],
    color: '#1f4e31',
  },
  // Australia
  {
    coords: [
      [-12, 131], [-12, 142], [-20, 149], [-28, 153], [-38, 146],
      [-35, 136], [-32, 125], [-34, 115], [-22, 114], [-15, 124],
    ],
    color: '#75543e',
    highland: '#355139',
  },
  // Greenland
  {
    coords: [[60, -44], [68, -54], [81, -56], [82, -22], [70, -22]],
    color: '#cbd5e1',
  },
];

function paintInitialSatelliteBase(ctx: CanvasRenderingContext2D, W: number, H: number) {
  // 1. Deep bathymetric ocean gradient
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, H);
  oceanGrad.addColorStop(0, '#071936');
  oceanGrad.addColorStop(0.22, '#08244b');
  oceanGrad.addColorStop(0.5, '#0b3166');
  oceanGrad.addColorStop(0.78, '#08244b');
  oceanGrad.addColorStop(1, '#071936');
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, W, H);

  // Subtle polar ice caps
  const northCap = ctx.createLinearGradient(0, 0, 0, H * 0.075);
  northCap.addColorStop(0, 'rgba(226, 232, 240, 0.88)');
  northCap.addColorStop(1, 'rgba(226, 232, 240, 0)');
  ctx.fillStyle = northCap;
  ctx.fillRect(0, 0, W, H * 0.075);

  const southCap = ctx.createLinearGradient(0, H * 0.915, 0, H);
  southCap.addColorStop(0, 'rgba(226, 232, 240, 0)');
  southCap.addColorStop(1, 'rgba(241, 245, 249, 0.92)');
  ctx.fillStyle = southCap;
  ctx.fillRect(0, H * 0.915, W, H * 0.085);

  const projectEqui = (lat: number, lon: number): [number, number] => [
    ((lon + 180) / 360) * W,
    latDegToEquirectangularY(lat, H),
  ];

  // 2. Continental shelves & landmasses (smooth fallback before satellite tiles finish streaming)
  for (const poly of SATELLITE_LAND_POLYS) {
    ctx.beginPath();
    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    for (let i = 0; i < poly.coords.length; i++) {
      const [x, y] = projectEqui(poly.coords[i][0], poly.coords[i][1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const landGrad = ctx.createLinearGradient(minX, minY, maxX, maxY);
    landGrad.addColorStop(0, poly.color);
    landGrad.addColorStop(0.6, poly.highland || poly.color);
    landGrad.addColorStop(1, poly.color);
    ctx.fillStyle = landGrad;
    ctx.fill();
  }
}

function loadGlobeTile(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Projects a 256x256 Web Mercator satellite tile onto an equirectangular canvas in horizontal sub-strips. */
function drawMercatorTileToEquirectangular(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  z: number,
  tx: number,
  ty: number,
  W: number,
  H: number
) {
  const nTiles = Math.pow(2, z);
  const dstX = (tx / nTiles) * W;
  const dstW = W / nTiles + 0.85; // slight overlap avoids subpixel seams
  const strips = 8;

  for (let s = 0; s < strips; s++) {
    const tyTop = ty + s / strips;
    const tyBot = ty + (s + 1) / strips;
    const latTop = mercatorTileYToLatDeg(tyTop, z);
    const latBot = mercatorTileYToLatDeg(tyBot, z);
    const dstYTop = latDegToEquirectangularY(latTop, H);
    const dstYBot = latDegToEquirectangularY(latBot, H);

    const srcY = (s / strips) * img.height;
    const srcH = img.height / strips;
    const dstH = Math.max(1, dstYBot - dstYTop + 0.75);

    ctx.drawImage(img, 0, srcY, img.width, srcH, dstX, dstYTop, dstW, dstH);
  }
}

/**
 * Builds a curved 3D spherical patch BufferGeometry on the unit sphere for a Web Mercator tile (z, tx, ty).
 * Allows native 256x256 Esri World Imagery satellite tiles at z = 4..19 to render with full crispness on the 3D globe.
 *
 * Vertices are stored relative to the patch center (RTC) and the mesh is positioned at that center, so float32
 * vertex precision stays sub-centimetre even when the camera hovers a few hundred metres above an airport.
 * All patches lie exactly on the unit sphere; layering is resolved by draw order (coarse → fine), not by
 * per-level radius offsets (those offsets caused visible parallax "squares" and z-fighting seams).
 */
function createSphericalTileGeometry(
  z: number,
  tx: number,
  ty: number
): { geo: THREE.BufferGeometry; center: THREE.Vector3 } {
  const grid = z <= 6 ? 16 : 8;
  const nTiles = Math.pow(2, z);
  const vertCount = (grid + 1) * (grid + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  const centerLat = mercatorTileYToLatDeg(ty + 0.5, z);
  const centerLon = ((tx + 0.5) / nTiles) * 360 - 180;
  const [cx, cy, cz] = latLonToUnitSphere(centerLat, centerLon);

  let ptr3 = 0;
  let ptr2 = 0;
  for (let iy = 0; iy <= grid; iy++) {
    const v = iy / grid;
    const latDeg = mercatorTileYToLatDeg(ty + v, z);
    for (let ix = 0; ix <= grid; ix++) {
      const u = ix / grid;
      const lonDeg = ((tx + u) / nTiles) * 360 - 180;
      const [ux, uy, uz] = latLonToUnitSphere(latDeg, lonDeg);
      positions[ptr3] = ux - cx;
      positions[ptr3 + 1] = uy - cy;
      positions[ptr3 + 2] = uz - cz;
      normals[ptr3] = ux;
      normals[ptr3 + 1] = uy;
      normals[ptr3 + 2] = uz;
      ptr3 += 3;
      uvs[ptr2] = u;
      uvs[ptr2 + 1] = 1 - v;
      ptr2 += 2;
    }
  }

  for (let iy = 0; iy < grid; iy++) {
    for (let ix = 0; ix < grid; ix++) {
      const a = iy * (grid + 1) + ix;
      const b = a + 1;
      const c = (iy + 1) * (grid + 1) + ix;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return { geo, center: new THREE.Vector3(cx, cy, cz) };
}

/* ---------- Globe camera model (fixed FOV, altitude-based zoom like standard map apps) ---------- */

const EARTH_RADIUS_KM = 6371;
const GLOBE_FOV_DEG = 35;
const GLOBE_TAN_HALF_FOV = Math.tan((GLOBE_FOV_DEG * Math.PI) / 360);
/** Camera altitude above the surface, in Earth radii, at zoom 1 (whole globe framed in the planner). */
const GLOBE_BASE_ALT = 1.819;
/** Closest camera altitude (≈ 550 m) — runways, taxiways and aprons are clearly visible at this height. */
const GLOBE_MIN_ALT_KM = 0.55;
export const MAX_GLOBE_ZOOM = (GLOBE_BASE_ALT * EARTH_RADIUS_KM) / GLOBE_MIN_ALT_KM; // ≈ 21 000x
/** Zoom used when an airport is selected (≈ 45 km of terrain visible vertically, airport + surroundings). */
export const GLOBE_AIRPORT_FOCUS_ZOOM = 160;
/** Zoom used by "Zoom to Airport" (≈ 4 km visible, runway/apron detail). */
export const GLOBE_AIRPORT_DETAIL_ZOOM = 1800;
/** Zoom of the slowly spinning main-menu globe (slightly closer than the planner overview). */
const GLOBE_MENU_ZOOM = 1.16;
const MAX_TILE_Z = 19;
const GLOBE_PLANNER_SCALE = 0.94;
const GLOBE_MENU_SCALE = 1.06;

/** Camera altitude above the surface (Earth radii) for a zoom factor. */
function globeAltitudeForZoom(zoom: number): number {
  return GLOBE_BASE_ALT / Math.max(1, zoom);
}

/** Ground kilometres per screen pixel at the view center. */
function globeKmPerPixel(zoom: number, viewH: number): number {
  return (2 * globeAltitudeForZoom(zoom) * EARTH_RADIUS_KM * GLOBE_TAN_HALF_FOV) / Math.max(200, viewH);
}

/** Picks a "nice" scale-bar distance (1 / 2 / 5 × 10ⁿ km) whose bar is dynamically sized to match reality 1:1. */
function computeNiceScaleBar(kmPerPx: number): { km: number; px: number } {
  const targetPx = 80;
  const raw = kmPerPx * targetPx;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, raw))));
  const norm = raw / pow;
  let nice = pow;
  if (norm >= 7.0) nice = 10 * pow;
  else if (norm >= 3.5) nice = 5 * pow;
  else if (norm >= 1.6) nice = 2 * pow;
  const px = Math.max(35, Math.min(130, nice / Math.max(1e-6, kmPerPx)));
  return { km: nice, px };
}

/** Best Web Mercator tile level so a tile pixel roughly matches a screen pixel at the view center. */
function globeTileLevelFor(zoom: number, latDeg: number, viewH: number): number {
  const metersPerPx = globeKmPerPixel(zoom, viewH) * 1000;
  const equatorM = 40075016.686 * Math.max(0.05, Math.cos((latDeg * Math.PI) / 180));
  const z = Math.round(Math.log2(equatorM / (256 * metersPerPx)) + 0.25);
  return Math.max(2, Math.min(MAX_TILE_Z, z));
}

export interface GlobeControlHandle {
  focusLocation: (lat: number, lon: number, targetZoom?: number) => void;
  focusRoute: (dep: Airport, arr: Airport) => void;
  /** Centre the map on a specific runway (not the airport centre) and zoom so the whole runway is framed. */
  focusRunway: (airport: Airport, ident: string) => void;
  zoomBy: (delta: number) => void;
  resetGlobeView: () => void;
}

interface GlobeAirportMarker {
  airport: Airport;
  ux: number;
  uy: number;
  uz: number;
  isStar: boolean;
}

interface GlobeSettlementDot {
  ux: number;
  uy: number;
  uz: number;
  size: number;
}

const PRIMARY_INDONESIA_HUBS = new Set([
  'WIII', 'WIHH', 'WADD', 'WARR', 'WAAA', 'WIMM', 'WAHI', 'WALL', 'WAJJ', 'WICC', 'WIBB', 'WIPP', 'WABP', 'WAML',
]);

// Precompute 3D unit-sphere coordinates once at module load (Zero-GC render loop rule)
// Sort starred hubs first so spatial decluttering always preserves major hubs.
const GLOBE_AIRPORT_MARKERS: GlobeAirportMarker[] = AIRPORTS.filter(
  (a) => a.country === 'ID' || a.size === 0 || a.size === 1
)
  .map((airport) => {
    const [ux, uy, uz] = latLonToUnitSphere(airport.lat, airport.lon);
    const isStar =
      airport.country === 'ID'
        ? PRIMARY_INDONESIA_HUBS.has(airport.icao)
        : airport.size === 0 && airport.runways.length >= 2;
    return {
      airport,
      ux,
      uy,
      uz,
      isStar,
    };
  })
  .sort((a, b) => Number(b.isStar) - Number(a.isStar) || a.airport.size - b.airport.size);

// Deterministic settlement light dots clustered around populated airfields
const GLOBE_SETTLEMENT_DOTS: GlobeSettlementDot[] = (() => {
  const dots: GlobeSettlementDot[] = [];
  let s = 9137;
  const nextRand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  for (let i = 0; i < GLOBE_AIRPORT_MARKERS.length; i++) {
    const a = GLOBE_AIRPORT_MARKERS[i].airport;
    const count = a.country === 'ID' ? 5 : 2;
    for (let k = 0; k < count; k++) {
      const spread = a.country === 'ID' ? 1.8 : 2.3;
      const dLat = (nextRand() - 0.5) * spread;
      const dLon = (nextRand() - 0.5) * spread;
      const [ux, uy, uz] = latLonToUnitSphere(a.lat + dLat, a.lon + dLon);
      dots.push({ ux, uy, uz, size: nextRand() > 0.72 ? 1.6 : 1.1 });
    }
  }
  return dots;
})();

const ScratchVec = new THREE.Vector3();
const ScratchVecB = new THREE.Vector3();

/**
 * Runway-anchored marker target. When a runway is chosen in the planner the DEP/ARR marker must end up
 * on THAT runway (not on the airport reference point) once the map is zoomed in. The anchor is the
 * threshold the aircraft actually uses: the physical runway end for take-off, the (displaced) landing
 * threshold for arrival.
 */
export interface RunwayAnchor {
  airportId: string; ident: string; lat: number; lon: number; ux: number; uy: number; uz: number;
  /** Midpoint of the whole runway (camera focus) */
  midLat: number; midLon: number; lengthM: number; rw: Runway; end: 'le' | 'he';
}
const anchorCache = new Map<string, RunwayAnchor | null>();
/** Call after runway geometry changed (live survey upgrade) so markers re-anchor on the corrected runway. */
export function clearRunwayAnchors() { anchorCache.clear(); }
export function runwayEndAnchor(airport: Airport | null | undefined, ident: string | undefined, role: 'dep' | 'arr'): RunwayAnchor | null {
  if (!airport || !ident) return null;
  const key = `${airport.id}|${ident}|${role}|${airport.runways.length}`;
  const hit = anchorCache.get(key);
  if (hit !== undefined) return hit;
  let out: RunwayAnchor | null = null;
  for (const rw of airport.runways) {
    const end: 'le' | 'he' | null = rw.le === ident ? 'le' : rw.he === ident ? 'he' : null;
    if (!end) continue;
    const le = end === 'le';
    let lat = le ? rw.leLat : rw.heLat, lon = le ? rw.leLon : rw.heLon;
    if (role === 'arr') {
      const disp = Math.max(0, Math.min(le ? rw.dispLe : rw.dispHe, haversine(rw.leLat, rw.leLon, rw.heLat, rw.heLon) * 0.5));
      if (disp > 0) [lat, lon] = destination(lat, lon, bearing(lat, lon, le ? rw.heLat : rw.leLat, le ? rw.heLon : rw.leLon), disp);
    }
    const [ux, uy, uz] = latLonToUnitSphere(lat, lon);
    out = {
      airportId: airport.id, ident, lat, lon, ux, uy, uz,
      midLat: (rw.leLat + rw.heLat) / 2, midLon: (rw.leLon + rw.heLon) / 2,
      lengthM: haversine(rw.leLat, rw.leLon, rw.heLat, rw.heLon), rw, end,
    };
    break;
  }
  anchorCache.set(key, out);
  return out;
}

/** Resolves an anchor for an explicit runway ident, or automatically picks the best runway towards/from the opposite airport. */
export function resolveRunwayAnchor(
  airport: Airport | null | undefined,
  ident: string | undefined,
  role: 'dep' | 'arr',
  oppositeAirport?: Airport | null
): RunwayAnchor | null {
  if (!airport || !airport.runways || !airport.runways.length) return null;
  if (ident) {
    const direct = runwayEndAnchor(airport, ident, role);
    if (direct) return direct;
  }
  let bestIdent = airport.runways[0].le;
  if (oppositeAirport && oppositeAirport.id !== airport.id) {
    if (role === 'dep') {
      const targetBrg = bearing(airport.lat, airport.lon, oppositeAirport.lat, oppositeAirport.lon);
      let bestScore = -1e9;
      for (const rw of airport.runways) {
        const leHdg = bearing(rw.leLat, rw.leLon, rw.heLat, rw.heLon);
        const heHdg = bearing(rw.heLat, rw.heLon, rw.leLat, rw.leLon);
        const len = haversine(rw.leLat, rw.leLon, rw.heLat, rw.heLon);
        const leAlign = Math.cos(((targetBrg - leHdg) * Math.PI) / 180);
        const heAlign = Math.cos(((targetBrg - heHdg) * Math.PI) / 180);
        const leScore = leAlign * 10 + len / 1000;
        const heScore = heAlign * 10 + len / 1000;
        if (leScore > bestScore) { bestScore = leScore; bestIdent = rw.le; }
        if (heScore > bestScore) { bestScore = heScore; bestIdent = rw.he; }
      }
    } else {
      const incomingBrg = bearing(oppositeAirport.lat, oppositeAirport.lon, airport.lat, airport.lon);
      let bestScore = -1e9;
      for (const rw of airport.runways) {
        const leHdg = bearing(rw.leLat, rw.leLon, rw.heLat, rw.heLon);
        const heHdg = bearing(rw.heLat, rw.heLon, rw.leLat, rw.heLon);
        const len = haversine(rw.leLat, rw.leLon, rw.heLat, rw.heLon);
        const leAlign = Math.cos(((incomingBrg - leHdg) * Math.PI) / 180);
        const heAlign = Math.cos(((incomingBrg - heHdg) * Math.PI) / 180);
        const leScore = leAlign * 10 + len / 1000;
        const heScore = heAlign * 10 + len / 1000;
        if (leScore > bestScore) { bestScore = leScore; bestIdent = rw.le; }
        if (heScore > bestScore) { bestScore = heScore; bestIdent = rw.he; }
      }
    }
  } else {
    let maxLen = -1;
    for (const rw of airport.runways) {
      const len = haversine(rw.leLat, rw.leLon, rw.heLat, rw.heLon);
      if (len > maxLen) { maxLen = len; bestIdent = rw.le; }
    }
  }
  return runwayEndAnchor(airport, bestIdent, role);
}

export interface ScreenRunway {
  airport: Airport;
  rw: Runway;
  le: string;
  he: string;
  rx1: number;
  ry1: number;
  rx2: number;
  ry2: number;
  widthPx: number;
}

/** Marker blend: 0 = airport reference point (zoomed out) … 1 = selected runway threshold (zoomed in). */
function anchorBlend(scaleKm: number): number {
  const t = Math.max(0, Math.min(1, (60 - scaleKm) / 35)); // fully snaps to the runway threshold by ~25 km scale bar
  return t * t * (3 - 2 * t);
}

function drawFivePointStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number, innerR: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI * 0.5 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function InteractiveEarthGlobe({
  focusLat = -2.5,
  focusLon = 115.0,
  mode = 'menu',
  paused = false,
  selectedDep = null,
  selectedArr = null,
  depRunway = '',
  arrRunway = '',
  onSelectAirport,
  onSelectRunway,
  onFlyNow,
  onInspectAirport,
  onScaleKmChange,
  controlRef,
  className = '',
}: {
  focusLat?: number;
  focusLon?: number;
  mode?: 'menu' | 'planner';
  paused?: boolean;
  selectedDep?: Airport | null;
  selectedArr?: Airport | null;
  /** Runway ident chosen for departure / arrival ('' = automatic). The DEP / ARR marker snaps to it when zoomed in. */
  depRunway?: string;
  arrRunway?: string;
  onSelectAirport?: (airport: Airport, role: 'from' | 'to') => void;
  onSelectRunway?: (airport: Airport, ident: string, role?: 'dep' | 'arr') => void;
  onFlyNow?: (airport: Airport) => void;
  onInspectAirport?: (airport: Airport) => void;
  onScaleKmChange?: (scaleKm: number, scalePx: number) => void;
  controlRef?: MutableRefObject<GlobeControlHandle | null>;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const glMountRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const popupDomRef = useRef<HTMLDivElement>(null);

  const [activeAirport, setActiveAirport] = useState<{
    airport: Airport;
    x: number;
    y: number;
  } | null>(null);
  const activeAirportRef = useRef(activeAirport);
  activeAirportRef.current = activeAirport;

  const modeRef = useRef<'menu' | 'planner'>(mode);
  const prevModeRef = useRef<'menu' | 'planner'>(mode);
  modeRef.current = mode;

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const selectedDepRef = useRef<Airport | null>(selectedDep);
  selectedDepRef.current = selectedDep;
  const selectedArrRef = useRef<Airport | null>(selectedArr);
  selectedArrRef.current = selectedArr;
  const depRunwayRef = useRef(depRunway); depRunwayRef.current = depRunway;
  const arrRunwayRef = useRef(arrRunway); arrRunwayRef.current = arrRunway;
  const onScaleKmChangeRef = useRef(onScaleKmChange);
  onScaleKmChangeRef.current = onScaleKmChange;
  const onSelectRunwayRef = useRef(onSelectRunway);
  onSelectRunwayRef.current = onSelectRunway;
  const screenRunwaysRef = useRef<ScreenRunway[]>([]);
  const hoveredRunwayRef = useRef<{
    airport: Airport;
    ident: string;
    x: number;
    y: number;
    lengthM: number;
  } | null>(null);

  const rotRef = useRef({
    lat: focusLat * (Math.PI / 180),
    lon: focusLon * (Math.PI / 180),
    targetLat: focusLat * (Math.PI / 180),
    targetLon: focusLon * (Math.PI / 180),
    zoom: mode === 'menu' ? GLOBE_MENU_ZOOM : 1.0,
    targetZoom: 1.0,
    plannerAlpha: mode === 'planner' ? 1.0 : 0.0,
    menuElapsed: 0,
  });

  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    x: number;
    y: number;
  }>({ active: false, moved: false, startX: 0, startY: 0, x: 0, y: 0 });

  const pointerPosRef = useRef<{ x: number; y: number }>({ x: -9999, y: -9999 });
  const hoveredAirportRef = useRef<Airport | null>(null);
  const screenPinsRef = useRef<{ airport: Airport; x: number; y: number; isStar: boolean }[]>([]);
  const requestHighResTilesRef = useRef<((latDeg: number, lonDeg: number, zoomLevel: number) => void) | null>(null);
  const cameraStateRef = useRef<{ fov: number; camZ: number; scale: number; viewH: number }>({
    fov: GLOBE_FOV_DEG,
    camZ: 2.65,
    scale: GLOBE_PLANNER_SCALE,
    viewH: 900,
  });

  // Smoothly set target (lat, lon) along the shortest longitude arc without discontinuous jumps
  const setShortestTargetLatLon = (latDeg: number, lonDeg: number, nextZoom?: number) => {
    const dstLat = Math.max(-1.42, Math.min(1.42, latDeg * (Math.PI / 180)));
    const dstLon = lonDeg * (Math.PI / 180);
    const twoPi = Math.PI * 2;
    const diff = (((dstLon - rotRef.current.lon) % twoPi) + twoPi * 1.5) % twoPi - Math.PI;
    rotRef.current.targetLat = dstLat;
    rotRef.current.targetLon = rotRef.current.lon + diff;
    if (nextZoom !== undefined) {
      rotRef.current.targetZoom = Math.max(1.0, Math.min(MAX_GLOBE_ZOOM, nextZoom));
    }
  };

  // When transitioning from Main Menu ('menu') to Route Selection ('planner'), smoothly rotate along shortest arc to Indonesia at full-globe view
  useEffect(() => {
    if (prevModeRef.current !== mode) {
      prevModeRef.current = mode;
      if (mode === 'planner') {
        setShortestTargetLatLon(focusLat, focusLon, 1.0);
        setActiveAirport(null);
      } else {
        const cont = computeMenuContinentalTarget(rotRef.current.menuElapsed);
        setShortestTargetLatLon(cont.latDeg, cont.lonDeg, 1.0);
        setActiveAirport(null);
      }
    }
  }, [mode, focusLat, focusLon]);

  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      focusLocation: (lat: number, lon: number, targetZoom = GLOBE_AIRPORT_FOCUS_ZOOM) => {
        const clampedZoom = Math.max(1.0, Math.min(MAX_GLOBE_ZOOM, targetZoom));
        setShortestTargetLatLon(lat, lon, clampedZoom);
        requestHighResTilesRef.current?.(lat, lon, clampedZoom);
      },
      focusRoute: (dep: Airport, arr: Airport) => {
        const view = computeRouteFocusView(dep, arr);
        setShortestTargetLatLon(view.lat, view.lon, view.zoom);
        requestHighResTilesRef.current?.(view.lat, view.lon, view.zoom);
        requestHighResTilesRef.current?.(dep.lat, dep.lon, Math.max(view.zoom, 12));
        requestHighResTilesRef.current?.(arr.lat, arr.lon, Math.max(view.zoom, 12));
      },
      focusRunway: (airport: Airport, ident: string) => {
        const a = resolveRunwayAnchor(airport, ident, 'dep');
        if (!a) {
          setShortestTargetLatLon(airport.lat, airport.lon, GLOBE_AIRPORT_FOCUS_ZOOM);
          requestHighResTilesRef.current?.(airport.lat, airport.lon, GLOBE_AIRPORT_FOCUS_ZOOM);
          return;
        }
        // Visible vertical span ≈ 7308 km / zoom (35° FOV): frame the runway in ~45% of the view height.
        const visibleKm = Math.max(1.2, (a.lengthM / 1000) / 0.45);
        const z = Math.max(GLOBE_AIRPORT_FOCUS_ZOOM, Math.min(MAX_GLOBE_ZOOM, (2 * GLOBE_BASE_ALT * EARTH_RADIUS_KM * GLOBE_TAN_HALF_FOV) / visibleKm));
        setShortestTargetLatLon(a.midLat, a.midLon, z);
        requestHighResTilesRef.current?.(a.midLat, a.midLon, z);
      },
      zoomBy: (delta: number) => {
        const factor = delta > 0 ? 1.55 : 1 / 1.55;
        const nextZoom = Math.max(1.0, Math.min(MAX_GLOBE_ZOOM, rotRef.current.targetZoom * factor));
        rotRef.current.targetZoom = nextZoom;
        if (nextZoom > 1.2) {
          requestHighResTilesRef.current?.(
            rotRef.current.targetLat * (180 / Math.PI),
            rotRef.current.targetLon * (180 / Math.PI),
            nextZoom
          );
        }
      },
      resetGlobeView: () => {
        setShortestTargetLatLon(-2.5, 115.0, 1.0);
        setActiveAirport(null);
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef]);

  useEffect(() => {
    const container = containerRef.current;
    const glMount = glMountRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!container || !glMount || !overlayCanvas) return;

    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      renderer = null;
    }

    if (!renderer) return;

    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererStr = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : '';
    const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software/i.test(rendererStr);

    // High-resolution global equirectangular canvas for base satellite levels (z = 2, 3, 4)
    const texCanvas = document.createElement('canvas');
    texCanvas.width = isSoftwareGl ? 2048 : 4096;
    texCanvas.height = isSoftwareGl ? 1024 : 2048;
    const texCtx = texCanvas.getContext('2d');
    if (texCtx) {
      paintInitialSatelliteBase(texCtx, texCanvas.width, texCanvas.height);
    }

    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    const domCanvas = renderer.domElement;
    domCanvas.setAttribute('aria-label', 'Interactive 3D Earth Globe');
    domCanvas.className = 'w-full h-full block';
    glMount.innerHTML = '';
    glMount.appendChild(domCanvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(GLOBE_FOV_DEG, 1, 0.0001, 50);
    camera.position.set(0, 0, 2.65);

    // Balanced 3-point studio lighting rig for a solid, glossy globe (zero edge transparency or holes, locked 60 FPS)
    const hemiLight = new THREE.HemisphereLight(0xf1f5f9, 0x102347, 1.65);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfffbeb, 1.45);
    sunLight.position.set(-2.0, 1.8, 3.4);
    scene.add(sunLight);

    const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
    rimLight.position.set(2.4, -1.2, 2.2);
    scene.add(rimLight);

    // Root group positioned on the right in 'menu' mode and centered in 'planner' mode
    const earthGroup = new THREE.Group();
    earthGroup.position.set(modeRef.current === 'menu' ? 0.56 : 0.0, 0.0, 0);
    const initialScale = modeRef.current === 'menu' ? GLOBE_MENU_SCALE : GLOBE_PLANNER_SCALE;
    earthGroup.scale.setScalar(initialScale);
    scene.add(earthGroup);

    // CRITICAL: Euler order MUST be 'XYZ' (R = R_x(lat) * R_y(-lon - PI/2)) so that:
    // 1. First, R_y rotates the chosen meridian lon to face +Z
    // 2. Second, R_x tilts the chosen latitude lat to [0, 0, +1] (exact screen center) with North [0, +1, 0]
    const spinGroup = new THREE.Group();
    const initEuler = computeGlobeEulerForLatLon(rotRef.current.lat, rotRef.current.lon);
    spinGroup.rotation.order = initEuler.order;
    spinGroup.rotation.x = initEuler.rx;
    spinGroup.rotation.y = initEuler.ry;
    earthGroup.add(spinGroup);

    const maxAniso = renderer.capabilities.getMaxAnisotropy() || 4;
    const earthTexture = new THREE.CanvasTexture(texCanvas);
    earthTexture.colorSpace = THREE.SRGBColorSpace;
    earthTexture.wrapS = THREE.RepeatWrapping;
    earthTexture.wrapT = THREE.ClampToEdgeWrapping;
    earthTexture.minFilter = THREE.LinearFilter;
    earthTexture.magFilter = THREE.LinearFilter;
    earthTexture.anisotropy = isSoftwareGl ? 1 : maxAniso;

    const segs = isSoftwareGl ? 64 : 112;
    const earthGeo = new THREE.SphereGeometry(1.0, segs, segs);
    // 100% solid, opaque, high-gloss material (zero transparency, zero holes on the edges, 60 FPS)
    const earthMat = new THREE.MeshPhongMaterial({
      map: earthTexture,
      transparent: false,
      opacity: 1.0,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      specular: new THREE.Color(0x4a6b94),
      shininess: 38,
    });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    earthMesh.renderOrder = 0;
    spinGroup.add(earthMesh);

    // Group holding native 256x256 curved 3D spherical tile patches for sharp multi-zoom (z = 4..19)
    const highResTileGroup = new THREE.Group();
    spinGroup.add(highResTileGroup);

    interface SphericalTileEntry {
      key: string;
      z: number;
      mesh: THREE.Mesh;
      geo: THREE.BufferGeometry;
      mat: THREE.MeshPhongMaterial;
      tex: THREE.Texture;
      lastUsed: number;
    }
    const sphericalTiles = new Map<string, SphericalTileEntry>();

    const addSphericalPatchTile = (img: HTMLImageElement, z: number, tx: number, ty: number) => {
      const key = `${z}/${tx}/${ty}`;
      if (sphericalTiles.has(key)) return;

      // Evict oldest unused patches if cache exceeds 240 tiles to maintain 60 FPS and bounded VRAM
      if (sphericalTiles.size >= 240) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of sphericalTiles) {
          if (v.lastUsed < oldestTime) {
            oldestTime = v.lastUsed;
            oldestKey = k;
          }
        }
        if (oldestKey) {
          const old = sphericalTiles.get(oldestKey)!;
          highResTileGroup.remove(old.mesh);
          old.geo.dispose();
          old.mat.dispose();
          old.tex.dispose();
          sphericalTiles.delete(oldestKey);
        }
      }

      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = isSoftwareGl ? 1 : maxAniso;
      tex.needsUpdate = true;

      const { geo, center } = createSphericalTileGeometry(z, tx, ty);
      // Patches lie on the front hemisphere and are sorted coarse→fine via renderOrder = z.
      // Disabling depthTest/depthWrite between coplanar spherical layers completely eliminates
      // depth-buffer z-fighting squares and parallax seams while backface culling hides the far side.
      const mat = new THREE.MeshPhongMaterial({
        map: tex,
        transparent: false,
        opacity: 1.0,
        depthWrite: false,
        depthTest: false,
        side: THREE.FrontSide,
        specular: new THREE.Color(0x4a6b94),
        shininess: 38,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(center);
      mesh.renderOrder = z;
      highResTileGroup.add(mesh);
      sphericalTiles.set(key, { key, z, mesh, geo, mat, tex, lastUsed: performance.now() });
    };

    // Stream authentic Esri World Imagery satellite tiles
    const esriUrl = (z: number, x: number, y: number) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

    const loadedTiles = new Set<string>();
    let texNeedsUpload = false;

    if (texCtx) {
      // Level 2: 16 tiles covering the entire globe loaded directly in parallel
      for (let ty = 0; ty < 4; ty++) {
        for (let tx = 0; tx < 4; tx++) {
          const key = `2/${tx}/${ty}`;
          loadedTiles.add(key);
          loadGlobeTile(esriUrl(2, tx, ty)).then((img) => {
            if (disposed || !img) return;
            drawMercatorTileToEquirectangular(texCtx, img, 2, tx, ty, texCanvas.width, texCanvas.height);
            texNeedsUpload = true;
          });
        }
      }

      // Level 3: higher-resolution satellite tiles prioritizing Indonesia (115°E) and neighboring regions
      const z3Queue: { tx: number; ty: number; dist: number }[] = [];
      for (let ty = 1; ty < 7; ty++) {
        for (let tx = 0; tx < 8; tx++) {
          const tileLon = (tx / 8) * 360 - 180 + 22.5;
          const dIndo = Math.abs(tileLon - 115);
          z3Queue.push({ tx, ty, dist: dIndo });
        }
      }
      z3Queue.sort((a, b) => a.dist - b.dist);

      let idx = 0;
      const pumpZ3 = () => {
        if (disposed || idx >= z3Queue.length) return;
        const batch = z3Queue.slice(idx, idx + 4);
        idx += 4;
        Promise.all(
          batch.map(({ tx, ty }) => {
            const key = `3/${tx}/${ty}`;
            loadedTiles.add(key);
            return loadGlobeTile(esriUrl(3, tx, ty)).then((img) => {
              if (disposed || !img) return;
              drawMercatorTileToEquirectangular(texCtx, img, 3, tx, ty, texCanvas.width, texCanvas.height);
              texNeedsUpload = true;
            });
          })
        ).then(() => {
          if (!disposed) setTimeout(pumpZ3, 35);
        });
      };
      setTimeout(pumpZ3, 120);

      // Multi-resolution spherical tile streaming (z = 4 up to z = 19) so zooming in to runways/taxiways is sharp
      requestHighResTilesRef.current = (latDeg: number, lonDeg: number, zoomLevel: number) => {
        if (disposed || !texCtx) return;
        const targetZ = Math.max(4, globeTileLevelFor(zoomLevel, latDeg, cameraStateRef.current.viewH));
        // Progressive ancestor pyramid so lower-zoom patches always cover the area while finer tiles stream in
        const levels = new Set<number>([4]);
        if (targetZ >= 6) levels.add(6);
        if (targetZ >= 9) levels.add(9);
        if (targetZ >= 12) levels.add(12);
        if (targetZ >= 15) levels.add(15);
        if (targetZ >= 5) levels.add(targetZ - 1);
        levels.add(targetZ);

        const nowPerf = performance.now();
        for (const z of levels) {
          const { tx: centerTx, ty: centerTy, n } = latLonToMercatorTile(latDeg, lonDeg, z);
          const radius = z === targetZ ? 2 : 1;
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const tx = (centerTx + dx + n) % n;
              const ty = Math.max(0, Math.min(n - 1, centerTy + dy));
              const key = `${z}/${tx}/${ty}`;
              const existing = sphericalTiles.get(key);
              if (existing) {
                existing.lastUsed = nowPerf;
                continue;
              }
              if (loadedTiles.has(key)) continue;
              loadedTiles.add(key);
              loadGlobeTile(esriUrl(z, tx, ty)).then((img) => {
                if (disposed || !img) return;
                // Only z=2 and z=3 are painted onto the shared equirectangular base canvas.
                // Drawing sparse z=4/5 tiles onto the base canvas left sharp rectangular patch borders at low zoom.
                addSphericalPatchTile(img, z, tx, ty);
              });
            }
          }
        }
      };
    }

    let viewW = 1280;
    let viewH = 800;

    const resize = () => {
      if (!renderer || !container) return;
      const rect = container.getBoundingClientRect();
      viewW = Math.max(200, Math.round(rect.width));
      viewH = Math.max(200, Math.round(rect.height));
      cameraStateRef.current.viewH = viewH;
      renderer.setSize(viewW, viewH, false);
      overlayCanvas.width = viewW;
      overlayCanvas.height = viewH;
      camera.aspect = viewW / viewH;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let rafId = 0;
    let timeoutId = 0;
    let lastTime = performance.now();
    let lastTexUploadTime = 0;
    let lastAutoStreamTime = 0;
    let lastStreamKey = '';
    let lastReportedScale = -1;
    let lastReportedScalePx = -1;

    const afterDraw = isSoftwareGl
      ? (cb: FrameRequestCallback) => {
          timeoutId = window.setTimeout(() => {
            rafId = requestAnimationFrame(cb);
          }, 80);
        }
      : (cb: FrameRequestCallback) => {
          rafId = requestAnimationFrame(cb);
        };

    const drawOverlay = () => {
      const ctx = overlayCanvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, viewW, viewH);

      const alpha = rotRef.current.plannerAlpha;
      const zoom = rotRef.current.zoom;
      const scale = earthGroup.scale.x;
      const kmPerPx = globeKmPerPixel(zoom, viewH);
      const scaleKm = computeNiceScaleBar(kmPerPx).km;

      if (alpha <= 0.02) {
        screenPinsRef.current = [];
        return;
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      spinGroup.updateMatrixWorld();

      // Geometric horizon dot-product cos(θ_horizon) = R / camZ, plus a small margin near the limb
      const cosHorizon = Math.min(0.999999, scale / Math.max(scale + 1e-5, camera.position.z));
      const minLimbNz = zoom < 1.8 ? Math.max(cosHorizon, 0.44) : Math.min(0.99999, cosHorizon + 0.02 / zoom);

      // Camera view direction in local unit-sphere space for ultra-fast dot-product culling (Zero-GC)
      const viewLat = rotRef.current.lat;
      const viewLon = rotRef.current.lon;
      const [camUx, camUy, camUz] = latLonToUnitSphere(
        viewLat * (180 / Math.PI),
        viewLon * (180 / Math.PI)
      );

      // 1. Subtle warm night-light dots across landmasses at planetary overview scales
      if (scaleKm >= 80) {
        ctx.fillStyle = 'rgba(254, 243, 199, 0.55)';
        for (let i = 0; i < GLOBE_SETTLEMENT_DOTS.length; i++) {
          const dot = GLOBE_SETTLEMENT_DOTS[i];
          const dotNz = dot.ux * camUx + dot.uy * camUy + dot.uz * camUz;
          if (dotNz <= minLimbNz) continue;
          ScratchVec.set(dot.ux, dot.uy, dot.uz).applyMatrix4(spinGroup.matrixWorld).project(camera);
          const sx = (ScratchVec.x * 0.5 + 0.5) * viewW;
          const sy = (-ScratchVec.y * 0.5 + 0.5) * viewH;
          if (sx < 12 || sx > viewW - 12 || sy < 154 || sy > viewH - 48) continue;
          ctx.fillRect(sx, sy, dot.size, dot.size);
        }
      }

      // 2. Navigation route line between selectedDep and selectedArr if both are selected
      const dep = selectedDepRef.current;
      const arr = selectedArrRef.current;
      const depAnchor = resolveRunwayAnchor(dep, depRunwayRef.current, 'dep', arr);
      const arrAnchor = resolveRunwayAnchor(arr, arrRunwayRef.current, 'arr', dep);

      if (dep && arr && dep.id !== arr.id) {
        const totalDist = haversine(dep.lat, dep.lon, arr.lat, arr.lon);
        const geoPoints: [number, number, number][] = [];

        // 1. Departure runway: start at threshold, follow runway heading through climb-out
        let climbLat = dep.lat, climbLon = dep.lon;
        if (depAnchor) {
          geoPoints.push(latLonToUnitSphere(depAnchor.lat, depAnchor.lon));
          const depHdg = depAnchor.end === 'le'
            ? bearing(depAnchor.rw.leLat, depAnchor.rw.leLon, depAnchor.rw.heLat, depAnchor.rw.heLon)
            : bearing(depAnchor.rw.heLat, depAnchor.rw.heLon, depAnchor.rw.leLat, depAnchor.rw.leLon);
          // Rollout along the runway
          const [depEndLat, depEndLon] = destination(depAnchor.lat, depAnchor.lon, depHdg, depAnchor.lengthM);
          geoPoints.push(latLonToUnitSphere(depEndLat, depEndLon));
          // Straight departure climb-out extension along runway heading
          const climbExt = Math.min(totalDist * 0.1, 7500);
          const [cLat, cLon] = destination(depAnchor.lat, depAnchor.lon, depHdg, depAnchor.lengthM + climbExt);
          climbLat = cLat;
          climbLon = cLon;
          geoPoints.push(latLonToUnitSphere(climbLat, climbLon));
        } else {
          geoPoints.push(latLonToUnitSphere(dep.lat, dep.lon));
        }

        // 2. Arrival runway: final approach fix, threshold touchdown, rollout
        const arrGeoPoints: [number, number, number][] = [];
        let fafLat = arr.lat, fafLon = arr.lon;
        if (arrAnchor) {
          const arrHdg = arrAnchor.end === 'le'
            ? bearing(arrAnchor.rw.leLat, arrAnchor.rw.leLon, arrAnchor.rw.heLat, arrAnchor.rw.heLon)
            : bearing(arrAnchor.rw.heLat, arrAnchor.rw.heLon, arrAnchor.rw.leLat, arrAnchor.rw.leLon);
          const fafDist = Math.min(totalDist * 0.12, 10000);
          const [fLat, fLon] = destination(arrAnchor.lat, arrAnchor.lon, (arrHdg + 180) % 360, fafDist);
          fafLat = fLat;
          fafLon = fLon;
          arrGeoPoints.push(latLonToUnitSphere(fafLat, fafLon));
          arrGeoPoints.push(latLonToUnitSphere(arrAnchor.lat, arrAnchor.lon));
          const [arrRollLat, arrRollLon] = destination(arrAnchor.lat, arrAnchor.lon, arrHdg, Math.min(1500, arrAnchor.lengthM * 0.7));
          arrGeoPoints.push(latLonToUnitSphere(arrRollLat, arrRollLon));
        } else {
          arrGeoPoints.push(latLonToUnitSphere(arr.lat, arr.lon));
        }

        // 3. Great-circle interpolation between climb-out fix and final approach fix
        const [ux1, uy1, uz1] = latLonToUnitSphere(climbLat, climbLon);
        const [ux2, uy2, uz2] = latLonToUnitSphere(fafLat, fafLon);
        const steps = 48;
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          let ix = ux1 * (1 - t) + ux2 * t;
          let iy = uy1 * (1 - t) + uy2 * t;
          let iz = uz1 * (1 - t) + uz2 * t;
          const len = Math.hypot(ix, iy, iz) || 1;
          geoPoints.push([ix / len, iy / len, iz / len]);
        }
        for (let i = 0; i < arrGeoPoints.length; i++) {
          geoPoints.push(arrGeoPoints[i]);
        }

        const routePts: { x: number; y: number }[] = [];
        for (let i = 0; i < geoPoints.length; i++) {
          const pt = geoPoints[i];
          ScratchVec.set(pt[0], pt[1], pt[2]).applyMatrix4(spinGroup.matrixWorld);
          if (ScratchVec.z / scale <= cosHorizon * 0.98) continue;
          ScratchVec.project(camera);
          const sx = (ScratchVec.x * 0.5 + 0.5) * viewW;
          const sy = (-ScratchVec.y * 0.5 + 0.5) * viewH;
          routePts.push({ x: sx, y: sy });
        }

        if (routePts.length >= 2) {
          ctx.save();
          // Outer dark contrast casing
          ctx.beginPath();
          for (let i = 0; i < routePts.length; i++) {
            if (i === 0) ctx.moveTo(routePts[i].x, routePts[i].y);
            else ctx.lineTo(routePts[i].x, routePts[i].y);
          }
          ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
          ctx.lineWidth = 6.0;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();

          // Soft cyan glow line
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.38)';
          ctx.lineWidth = 4.2;
          ctx.stroke();

          // Crisp dashed MSFS flight path line
          ctx.beginPath();
          for (let i = 0; i < routePts.length; i++) {
            if (i === 0) ctx.moveTo(routePts[i].x, routePts[i].y);
            else ctx.lineTo(routePts[i].x, routePts[i].y);
          }
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.6;
          ctx.setLineDash([9, 5]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Midpoint distance callout badge ("229 NM · 424 KM")
          const midIdx = Math.floor(routePts.length * 0.5);
          const midPt = routePts[midIdx];
          if (
            midPt &&
            midPt.x > 60 &&
            midPt.x < viewW - 60 &&
            midPt.y > 165 &&
            midPt.y < viewH - 65
          ) {
            const summary = computeRouteDispatch(dep, arr, specById('sky'));
            const distLabel = `${summary.distanceNm.toLocaleString()} NM · ${summary.distanceKm.toLocaleString()} KM`;
            ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
            const tw = ctx.measureText(distLabel).width;
            const bw = tw + 14;
            const bh = 20;
            const bx = midPt.x - bw * 0.5;
            const by = midPt.y - bh * 0.5;
            ctx.fillStyle = 'rgba(11, 18, 30, 0.92)';
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.fillStyle = '#e0f2fe';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(distLabel, midPt.x, midPt.y + 0.5);
          }
          ctx.restore();
        }
      }

      // 3. Project & spatially declutter 3D airport pins
      const blendT = anchorBlend(scaleKm);
      const visiblePins: { airport: Airport; x: number; y: number; isStar: boolean; nz: number }[] = [];
      const minSpacingPx = scaleKm > 300 ? 55 : scaleKm > 80 ? 38 : scaleKm > 20 ? 24 : 8;
      const minSpacingSq = minSpacingPx * minSpacingPx;

      const allMarkers = [...GLOBE_AIRPORT_MARKERS];
      const presentIds = new Set(allMarkers.map((m) => m.airport.id));
      for (const a of [dep, arr, activeAirportRef.current?.airport]) {
        if (a && !presentIds.has(a.id)) {
          presentIds.add(a.id);
          const [ux, uy, uz] = latLonToUnitSphere(a.lat, a.lon);
          allMarkers.push({ airport: a, ux, uy, uz, isStar: false });
        }
      }

      for (let i = 0; i < allMarkers.length; i++) {
        const m = allMarkers[i];
        const isSelected =
          dep?.id === m.airport.id ||
          arr?.id === m.airport.id ||
          activeAirportRef.current?.airport.id === m.airport.id;

        // When zoom hasn't approached 20 km (scaleKm > 20):
        // Keep the map clean by showing only selected endpoints and primary international star hubs.
        // Minor domestic/regional airfields (size 1 and 2) only reveal themselves once zoomed in to <= 20 km.
        if (!isSelected && scaleKm > 20) {
          if (m.airport.size === 2) continue;
          if (m.airport.size === 1 && !m.isStar) continue;
          if (scaleKm > 100 && !m.isStar) continue;
        }

        // When zoomed in very close to an airfield (scaleKm <= 15), hide other unselected nearby pins (< 14 km)
        // so the runway strips and taxiways of the airport are never obscured by marker clutter.
        if (!isSelected && scaleKm <= 15) {
          const targetAp = dep || arr || activeAirportRef.current?.airport;
          if (targetAp && haversine(targetAp.lat, targetAp.lon, m.airport.lat, m.airport.lon) < 14000) {
            continue;
          }
        }

        // Selected DEP / ARR endpoints slide from the airport reference point to the chosen runway as the map zooms in.
        let pux = m.ux, puy = m.uy, puz = m.uz;
        if (isSelected && blendT > 0) {
          const an = dep?.id === m.airport.id ? depAnchor : arr?.id === m.airport.id ? arrAnchor : null;
          if (an) {
            pux = m.ux + (an.ux - m.ux) * blendT; puy = m.uy + (an.uy - m.uy) * blendT; puz = m.uz + (an.uz - m.uz) * blendT;
            const inv = 1 / Math.hypot(pux, puy, puz); pux *= inv; puy *= inv; puz *= inv;
          }
        }
        const approxNz = pux * camUx + puy * camUy + puz * camUz;
        if (!isSelected && approxNz <= minLimbNz) continue;
        if (isSelected && approxNz <= cosHorizon * 0.95) continue;

        ScratchVec.set(pux, puy, puz).applyMatrix4(spinGroup.matrixWorld);
        const nz = ScratchVec.z / scale;
        if (!isSelected && nz <= minLimbNz) continue;

        ScratchVec.project(camera);
        const sx = (ScratchVec.x * 0.5 + 0.5) * viewW;
        const sy = (-ScratchVec.y * 0.5 + 0.5) * viewH;

        // Viewport clipping — keep selected/active pins and zoomed-in pins visible across the whole map canvas
        if (!isSelected && scaleKm > 120) {
          if (sx < 18 || sx > viewW - 18 || sy < 148 || sy > viewH - 48) continue;
          if (sx < 280 && sy < 195) continue;
          if (sx > viewW - 295 && sy > viewH - 135) continue;
        } else {
          if (sx < -24 || sx > viewW + 24 || sy < -24 || sy > viewH + 24) continue;
        }

        if (!isSelected) {
          let tooClose = false;
          for (let j = 0; j < visiblePins.length; j++) {
            const dx = visiblePins[j].x - sx;
            const dy = visiblePins[j].y - sy;
            if (dx * dx + dy * dy < minSpacingSq) {
              tooClose = true;
              break;
            }
          }
          if (tooClose) continue;
        }

        visiblePins.push({ airport: m.airport, x: sx, y: sy, isStar: m.isStar, nz });
      }

      screenPinsRef.current = visiblePins;

      // Keep the context menu anchored to the active airport's live projected screen coordinates
      if (activeAirportRef.current && popupDomRef.current) {
        const act = activeAirportRef.current.airport;
        const [aux, auy, auz] = latLonToUnitSphere(act.lat, act.lon);
        ScratchVec.set(aux, auy, auz).applyMatrix4(spinGroup.matrixWorld);
        if (ScratchVec.z / scale > cosHorizon * 0.95) {
          ScratchVec.project(camera);
          const ax = (ScratchVec.x * 0.5 + 0.5) * viewW;
          const ay = (-ScratchVec.y * 0.5 + 0.5) * viewH;
          const leftPx = Math.max(16, Math.min(viewW - 224, ax + 14));
          const topPx = Math.max(150, Math.min(viewH - 165, ay - 28));
          popupDomRef.current.style.left = `${Math.round(leftPx)}px`;
          popupDomRef.current.style.top = `${Math.round(topPx)}px`;

          // Draw target focus ring around the active airport
          ctx.save();
          ctx.beginPath();
          ctx.arc(ax, ay, 13, 0, Math.PI * 2);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }
      }

      // Helper to project a geographic coordinate onto the 2D overlay canvas (Zero GC)
      const projectGeo = (lat: number, lon: number): [number, number] | null => {
        const [ux, uy, uz] = latLonToUnitSphere(lat, lon);
        ScratchVec.set(ux, uy, uz).applyMatrix4(spinGroup.matrixWorld);
        if (ScratchVec.z / scale <= cosHorizon * 0.95) return null;
        ScratchVec.project(camera);
        return [(ScratchVec.x * 0.5 + 0.5) * viewW, (-ScratchVec.y * 0.5 + 0.5) * viewH];
      };

      // Reset live screen runways for pointer hit detection
      screenRunwaysRef.current = [];

      // 4. Draw surveyed airport ground layouts (OSM aprons, taxiways, terminals, stands) matching in-flight 'M' map
      if (scaleKm <= 45) {
        ctx.save();
        const drawnAirfieldIds = new Set<string>();
        const airfieldsToDraw: Airport[] = [];
        for (const a of [dep, arr, activeAirportRef.current?.airport]) {
          if (a && !drawnAirfieldIds.has(a.id)) {
            drawnAirfieldIds.add(a.id);
            airfieldsToDraw.push(a);
          }
        }
        if (scaleKm <= 22) {
          for (let i = 0; i < visiblePins.length; i++) {
            const a = visiblePins[i].airport;
            if (!drawnAirfieldIds.has(a.id)) {
              drawnAirfieldIds.add(a.id);
              airfieldsToDraw.push(a);
            }
          }
        }

        for (const a of airfieldsToDraw) {
          const L = getAirfield(a);
          if (!L) continue;

          // A. Aprons
          ctx.fillStyle = 'rgba(148, 163, 184, 0.32)';
          ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
          ctx.lineWidth = 1.0;
          for (let k = 0; k < L.aprons.length; k++) {
            const ap = L.aprons[k];
            ctx.beginPath();
            let first = true;
            for (let j = 0; j < ap.ring.length; j++) {
              const pt = projectGeo(ap.ring[j][0], ap.ring[j][1]);
              if (!pt) continue;
              if (first) { ctx.moveTo(pt[0], pt[1]); first = false; }
              else { ctx.lineTo(pt[0], pt[1]); }
            }
            if (!first) { ctx.closePath(); ctx.fill(); ctx.stroke(); }
          }

          // B. Taxiways with realistic dark asphalt casing & centerline
          for (let k = 0; k < L.taxiways.length; k++) {
            const tw = L.taxiways[k];
            if (tw.pts.length < 2) continue;
            const twWidth = Math.max(2.2, Math.min(18, (tw.width / 1000) / kmPerPx));
            ctx.beginPath();
            let first = true;
            for (let j = 0; j < tw.pts.length; j++) {
              const pt = projectGeo(tw.pts[j][0], tw.pts[j][1]);
              if (!pt) continue;
              if (first) { ctx.moveTo(pt[0], pt[1]); first = false; }
              else { ctx.lineTo(pt[0], pt[1]); }
            }
            if (!first) {
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              // Dark shoulder casing
              ctx.strokeStyle = 'rgba(4, 10, 16, 0.88)';
              ctx.lineWidth = twWidth + 2.4;
              ctx.stroke();

              // Asphalt surface
              ctx.strokeStyle = '#64748b';
              ctx.lineWidth = twWidth;
              ctx.stroke();

              // Taxiway yellow centerline when zoomed in
              if (scaleKm <= 8) {
                ctx.strokeStyle = '#eab308';
                ctx.lineWidth = Math.max(1, twWidth * 0.16);
                ctx.stroke();
              }
            }
          }

          // C. Hangars & Terminals (3D building footprints)
          ctx.fillStyle = 'rgba(226, 232, 240, 0.58)';
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.88)';
          ctx.lineWidth = 1.4;
          const buildings = L.hangars.concat(L.terminals);
          for (let k = 0; k < buildings.length; k++) {
            const bld = buildings[k];
            ctx.beginPath();
            let first = true;
            for (let j = 0; j < bld.ring.length; j++) {
              const pt = projectGeo(bld.ring[j][0], bld.ring[j][1]);
              if (!pt) continue;
              if (first) { ctx.moveTo(pt[0], pt[1]); first = false; }
              else { ctx.lineTo(pt[0], pt[1]); }
            }
            if (!first) { ctx.closePath(); ctx.fill(); ctx.stroke(); }
          }

          // D. Stands / Parking Gates
          if (scaleKm <= 12) {
            for (let k = 0; k < L.stands.length; k++) {
              const st = L.stands[k];
              const pt = projectGeo(st.lat, st.lon);
              if (!pt || pt[0] < -10 || pt[0] > viewW + 10 || pt[1] < -10 || pt[1] > viewH + 10) continue;
              ctx.beginPath();
              ctx.arc(pt[0], pt[1], st.gate ? 4.0 : 3.0, 0, Math.PI * 2);
              ctx.fillStyle = '#ffe08a';
              ctx.fill();
              ctx.strokeStyle = '#0f172a';
              ctx.lineWidth = 1.2;
              ctx.stroke();
              if (scaleKm <= 4 && st.ref) {
                ctx.font = '700 9px ui-monospace, SFMono-Regular, monospace';
                ctx.fillStyle = '#ffe9a8';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(st.ref, pt[0] + 5, pt[1]);
              }
            }
          }

          // E. Hold-short points
          if (scaleKm <= 10) {
            ctx.fillStyle = '#f59e0b';
            for (let k = 0; k < L.holds.length; k++) {
              const hp = L.holds[k];
              const pt = projectGeo(hp.lat, hp.lon);
              if (!pt || pt[0] < -10 || pt[0] > viewW + 10 || pt[1] < -10 || pt[1] > viewH + 10) continue;
              ctx.fillRect(pt[0] - 2.5, pt[1] - 2.5, 5, 5);
            }
          }
        }
        ctx.restore();
      }

      // 5. Draw actual oriented runway strips with threshold markings (zoomed in <= 40 km scale)
      if (scaleKm <= 40) {
        ctx.save();
        for (let i = 0; i < visiblePins.length; i++) {
          const p = visiblePins[i];
          for (const rwy of p.airport.runways) {
            const [lx1, ly1, lz1] = latLonToUnitSphere(rwy.leLat, rwy.leLon);
            const [lx2, ly2, lz2] = latLonToUnitSphere(rwy.heLat, rwy.heLon);
            ScratchVec.set(lx1, ly1, lz1).applyMatrix4(spinGroup.matrixWorld).project(camera);
            ScratchVecB.set(lx2, ly2, lz2).applyMatrix4(spinGroup.matrixWorld).project(camera);
            const rx1 = (ScratchVec.x * 0.5 + 0.5) * viewW;
            const ry1 = (-ScratchVec.y * 0.5 + 0.5) * viewH;
            const rx2 = (ScratchVecB.x * 0.5 + 0.5) * viewW;
            const ry2 = (-ScratchVecB.y * 0.5 + 0.5) * viewH;
            const rLenPx = Math.hypot(rx2 - rx1, ry2 - ry1);
            if (rLenPx < 5) continue;
            const widthM = Math.max(25, rwy.width || 45);
            const rWidthPx = Math.max(4, Math.min(28, (widthM / 1000) / kmPerPx));

            // Record screen runway segment for mouse click & hover selection
            screenRunwaysRef.current.push({
              airport: p.airport,
              rw: rwy,
              le: rwy.le,
              he: rwy.he,
              rx1,
              ry1,
              rx2,
              ry2,
              widthPx: rWidthPx,
            });

            // Selected departure / arrival runway: coloured halo + direction chevron so it reads as THE chosen runway
            const selDep = depAnchor && depAnchor.rw === rwy && dep?.id === p.airport.id;
            const selArr = arrAnchor && arrAnchor.rw === rwy && arr?.id === p.airport.id;
            if (selDep || selArr) {
              ctx.beginPath();
              ctx.moveTo(rx1, ry1);
              ctx.lineTo(rx2, ry2);
              ctx.strokeStyle = selDep ? 'rgba(34, 197, 94, 0.65)' : 'rgba(245, 158, 11, 0.65)';
              ctx.lineWidth = rWidthPx + 10;
              ctx.lineCap = 'round';
              ctx.stroke();
              ctx.lineCap = 'butt';
            }

            // Runway shoulder / asphalt casing
            ctx.beginPath();
            ctx.moveTo(rx1, ry1);
            ctx.lineTo(rx2, ry2);
            ctx.strokeStyle = 'rgba(15, 23, 42, 0.95)';
            ctx.lineWidth = rWidthPx + 3.2;
            ctx.lineCap = 'butt';
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(rx1, ry1);
            ctx.lineTo(rx2, ry2);
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = rWidthPx;
            ctx.stroke();

            // Centerline dashes
            ctx.beginPath();
            ctx.moveTo(rx1, ry1);
            ctx.lineTo(rx2, ry2);
            ctx.strokeStyle = '#f8fafc';
            ctx.lineWidth = Math.max(1.2, rWidthPx * 0.18);
            ctx.setLineDash([Math.max(4, rWidthPx * 0.9), Math.max(3, rWidthPx * 0.65)]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Runway threshold numbers when zoomed in close (<= 6 km scale)
            if (scaleKm <= 6 && rLenPx >= 45) {
              const ux = (rx2 - rx1) / rLenPx;
              const uy = (ry2 - ry1) / rLenPx;
              ctx.font = '800 10px ui-monospace, SFMono-Regular, monospace';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              const leX = rx1 - ux * 14;
              const leY = ry1 - uy * 14;
              const heX = rx2 + ux * 14;
              const heY = ry2 + uy * 14;
              ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
              ctx.fillRect(leX - 13, leY - 7, 26, 14);
              ctx.fillRect(heX - 13, heY - 7, 26, 14);
              ctx.fillStyle = '#38bdf8';
              ctx.fillText(rwy.le, leX, leY + 0.5);
              ctx.fillText(rwy.he, heX, heY + 0.5);
            }
            if ((selDep || selArr) && rLenPx >= 25) {
              // Chevron on the selected threshold pointing along the runway direction of use
              const an = selDep ? depAnchor! : arrAnchor!;
              const fromLe = an.end === 'le';
              const sx = fromLe ? rx1 : rx2, sy = fromLe ? ry1 : ry2;
              const dx = (fromLe ? rx2 - rx1 : rx1 - rx2) / rLenPx, dy = (fromLe ? ry2 - ry1 : ry1 - ry2) / rLenPx;
              const cx = sx + dx * 12, cy = sy + dy * 12;
              ctx.beginPath();
              ctx.moveTo(cx + dx * 9, cy + dy * 9);
              ctx.lineTo(cx - dx * 5 - dy * 7, cy - dy * 5 + dx * 7);
              ctx.lineTo(cx - dx * 5 + dy * 7, cy - dy * 5 - dx * 7);
              ctx.closePath();
              ctx.fillStyle = selDep ? '#22c55e' : '#f59e0b';
              ctx.fill();
              ctx.strokeStyle = '#0b1220';
              ctx.lineWidth = 1.2;
              ctx.stroke();
            }
          }
        }
        ctx.restore();
      }

      // Draw hovered runway tooltip tag if cursor is over a runway
      if (hoveredRunwayRef.current) {
        const hr = hoveredRunwayRef.current;
        const tipText = `RWY ${hr.ident} · ${Math.round(hr.lengthM).toLocaleString()}m · Click to select`;
        ctx.font = '700 11px ui-monospace, SFMono-Regular, monospace';
        const tw = ctx.measureText(tipText).width;
        const bw = tw + 14;
        const bh = 22;
        const bx = Math.max(8, Math.min(viewW - bw - 8, hr.x - bw * 0.5));
        const by = Math.max(8, hr.y - 28);
        ctx.fillStyle = 'rgba(2, 6, 23, 0.94)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tipText, bx + bw * 0.5, by + bh * 0.5 + 0.5);
      }

      // Determine hovered airport from pointer position
      const px = pointerPosRef.current.x;
      const py = pointerPosRef.current.y;
      let hovered: { airport: Airport; x: number; y: number } | null = null;
      let bestDistSq = 18 * 18;
      for (let i = 0; i < visiblePins.length; i++) {
        const p = visiblePins[i];
        const dSq = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          hovered = p;
        }
      }
      hoveredAirportRef.current = hovered ? hovered.airport : null;

      // Draw city / airport names when zoomed in (with spatial decluttering so labels never overlap)
      if (scaleKm <= 400) {
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        const drawnCityBoxes: { x: number; y: number }[] = [];
        for (let i = 0; i < visiblePins.length; i++) {
          const p = visiblePins[i];
          if (dep?.id === p.airport.id || arr?.id === p.airport.id) {
            drawnCityBoxes.push({ x: p.x, y: p.y });
          }
        }
        for (let i = 0; i < visiblePins.length; i++) {
          const p = visiblePins[i];
          if (dep?.id === p.airport.id || arr?.id === p.airport.id) continue;
          const labelText =
            scaleKm <= 60
              ? `${p.airport.icao} · ${p.airport.city || p.airport.name}`
              : p.airport.city;
          if (!labelText || (!p.isStar && scaleKm > 180)) continue;
          let overlaps = false;
          for (let j = 0; j < drawnCityBoxes.length; j++) {
            if (
              Math.abs(drawnCityBoxes[j].x - p.x) < 92 &&
              Math.abs(drawnCityBoxes[j].y - p.y) < 26
            ) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) continue;
          drawnCityBoxes.push({ x: p.x, y: p.y });
          if (drawnCityBoxes.length > 28) break;
          ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
          ctx.fillText(labelText, p.x + 1, p.y - 12);
          ctx.fillStyle = 'rgba(241, 245, 249, 0.95)';
          ctx.fillText(labelText, p.x, p.y - 13);
        }
      }

      // Draw each airport marker icon
      for (let i = 0; i < visiblePins.length; i++) {
        const p = visiblePins[i];
        const isDep = dep?.id === p.airport.id;
        const isArr = arr?.id === p.airport.id;
        const isAct = activeAirportRef.current?.airport.id === p.airport.id;
        const isHov = hovered?.airport.id === p.airport.id;
        const r = isDep || isArr || isAct || isHov ? 8.2 : p.isStar ? 6.8 : 6.2;

        // Outer dark drop shadow ring
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(2, 6, 18, 0.85)';
        ctx.fill();

        // Main circular badge
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isDep
          ? '#22c55e'
          : isArr
          ? '#f59e0b'
          : isAct
          ? '#38bdf8'
          : p.isStar
          ? '#facc15'
          : '#f8fafc';
        ctx.fill();

        // Inner dark center glyph
        if (p.isStar) {
          drawFivePointStar(ctx, p.x, p.y, r * 0.62, r * 0.28);
          ctx.fillStyle = '#0f172a';
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - r * 0.56);
          ctx.lineTo(p.x + r * 0.56, p.y);
          ctx.lineTo(p.x, p.y + r * 0.56);
          ctx.lineTo(p.x - r * 0.56, p.y);
          ctx.closePath();
          ctx.fillStyle = '#1e293b';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 0.2, 0, Math.PI * 2);
          ctx.fillStyle = '#f8fafc';
          ctx.fill();
        }

        // Draw DEP / ARR callout tag directly above selected endpoints
        if (isDep || isArr) {
          const selRwy = isDep ? depAnchor : arrAnchor;
          const tagText = `${isDep ? 'DEP' : 'ARR'} ${p.airport.icao}${selRwy && blendT > 0.5 ? ` · RWY ${selRwy.ident}` : ''}`;
          ctx.font = '800 10px ui-monospace, SFMono-Regular, monospace';
          const tw = ctx.measureText(tagText).width;
          const bw = tw + 10;
          const bh = 17;
          const bx = p.x - bw * 0.5;
          const by = p.y - r - bh - 5;
          ctx.fillStyle = isDep ? '#15803d' : '#b45309';
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tagText, p.x, by + bh * 0.5 + 0.5);
        }
      }

      // Draw crisp white hover callout tag
      if (hovered) {
        const label = `${hovered.airport.icao} - ${hovered.airport.city || hovered.airport.name}`;
        ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
        const textW = ctx.measureText(label).width;
        const boxW = textW + 14;
        const boxH = 22;
        const bx = Math.max(8, Math.min(viewW - boxW - 8, hovered.x - boxW * 0.5));
        const by = Math.max(8, hovered.y - 32);

        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, boxW, boxH);

        ctx.beginPath();
        ctx.moveTo(hovered.x - 5, by + boxH);
        ctx.lineTo(hovered.x + 5, by + boxH);
        ctx.lineTo(hovered.x, by + boxH + 5);
        ctx.closePath();
        ctx.fillStyle = '#f8fafc';
        ctx.fill();

        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + 7, by + boxH * 0.5);
      }

      ctx.restore();
    };

    const animate = (now: number) => {
      if (disposed || !renderer) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) * 0.001));
      lastTime = now;

      // Coalesce base canvas GPU uploads to at most ~8 Hz to eliminate upload micro-stutters
      if (texNeedsUpload && now - lastTexUploadTime > 120) {
        earthTexture.needsUpdate = true;
        texNeedsUpload = false;
        lastTexUploadTime = now;
      }

      if (!pausedRef.current && !(window as any).__hangarModalOpen) {
        const isMenu = modeRef.current === 'menu';
        const targetX = isMenu ? 0.56 : 0.0;
        const targetPlannerAlpha = isMenu ? 0.0 : 1.0;

        rotRef.current.plannerAlpha = THREE.MathUtils.damp(
          rotRef.current.plannerAlpha,
          targetPlannerAlpha,
          6.5,
          dt
        );
        // Interpolate zoom in log-space so zooming from 1x to 20 000x feels uniform at every scale
        const desiredZoom = isMenu ? GLOBE_MENU_ZOOM : rotRef.current.targetZoom;
        const nextLogZoom = THREE.MathUtils.damp(
          Math.log(Math.max(1, rotRef.current.zoom)),
          Math.log(Math.max(1, desiredZoom)),
          8.5,
          dt
        );
        rotRef.current.zoom = Math.exp(nextLogZoom);

        const zoom = rotRef.current.zoom;
        const targetScale = isMenu ? GLOBE_MENU_SCALE : GLOBE_PLANNER_SCALE;
        earthGroup.position.x = THREE.MathUtils.damp(earthGroup.position.x, targetX, 7.0, dt);
        const nextScale = THREE.MathUtils.damp(earthGroup.scale.x, targetScale, 7.0, dt);
        earthGroup.scale.setScalar(nextScale);

        // Fixed 35° FOV — zoom is achieved purely by bringing the camera closer to the surface
        // along the exact screen-center ray [0, 0, +Z], down to ~550 m above the runway.
        const altRadii = globeAltitudeForZoom(zoom);
        camera.position.set(0, 0, nextScale * (1 + altRadii));
        const nearPlane = Math.max(0.00002, Math.min(0.1, nextScale * altRadii * 0.25));
        if (Math.abs(camera.near - nearPlane) / nearPlane > 0.15) {
          camera.near = nearPlane;
          camera.updateProjectionMatrix();
        }

        cameraStateRef.current.fov = GLOBE_FOV_DEG;
        cameraStateRef.current.camZ = camera.position.z;
        cameraStateRef.current.scale = nextScale;

        // Report dynamic scale-bar distance in km and 1:1 true geodesic pixel width
        const kmPerPx = globeKmPerPixel(zoom, viewH);
        const { km: scaleKm, px: scalePx } = computeNiceScaleBar(kmPerPx);
        if (scaleKm !== lastReportedScale || Math.abs(scalePx - lastReportedScalePx) >= 1) {
          lastReportedScale = scaleKm;
          lastReportedScalePx = scalePx;
          onScaleKmChangeRef.current?.(scaleKm, scalePx);
        }

        if (!dragRef.current.active) {
          if (isMenu) {
            // Standard, continuous global rotation starting over Indonesia (not locked to a single continent)
            rotRef.current.menuElapsed += dt;
            const cont = computeMenuContinentalTarget(rotRef.current.menuElapsed);
            setShortestTargetLatLon(cont.latDeg, cont.lonDeg);
            rotRef.current.lat = THREE.MathUtils.damp(
              rotRef.current.lat,
              rotRef.current.targetLat,
              2.5,
              dt
            );
            rotRef.current.lon = THREE.MathUtils.damp(
              rotRef.current.lon,
              rotRef.current.targetLon,
              2.5,
              dt
            );
          } else {
            rotRef.current.lat = THREE.MathUtils.damp(
              rotRef.current.lat,
              rotRef.current.targetLat,
              9.0,
              dt
            );
            rotRef.current.lon = THREE.MathUtils.damp(
              rotRef.current.lon,
              rotRef.current.targetLon,
              9.0,
              dt
            );
          }
        }

        // Apply exact XYZ Euler angles directly from (rotRef.current.lat, rotRef.current.lon)
        const euler = computeGlobeEulerForLatLon(rotRef.current.lat, rotRef.current.lon);
        spinGroup.rotation.x = euler.rx;
        spinGroup.rotation.y = euler.ry;

        const curLatDeg = rotRef.current.lat * (180 / Math.PI);
        const curLonDeg = rotRef.current.lon * (180 / Math.PI);
        const activeTargetZ = globeTileLevelFor(zoom, curLatDeg, viewH);

        // Automatically stream high-resolution satellite tiles for the active view center as the user pans/zooms
        if (!isMenu && zoom > 1.2 && now - lastAutoStreamTime > 160) {
          lastAutoStreamTime = now;
          const bucketDeg = Math.max(0.002, 45 / Math.pow(2, Math.max(0, activeTargetZ - 3)));
          const latBucket = Math.round(curLatDeg / bucketDeg);
          const lonBucket = Math.round(curLonDeg / bucketDeg);
          const streamKey = `${activeTargetZ}:${latBucket}:${lonBucket}`;
          if (streamKey !== lastStreamKey) {
            lastStreamKey = streamKey;
            requestHighResTilesRef.current?.(curLatDeg, curLonDeg, Math.max(zoom, rotRef.current.targetZoom));
          }
        }

        // Only display spherical patch levels up to activeTargetZ + 1 and lying on the visible hemisphere
        const [camUx, camUy, camUz] = latLonToUnitSphere(curLatDeg, curLonDeg);
        const showPatches = !isMenu && zoom >= 1.35;
        highResTileGroup.visible = showPatches;
        if (showPatches) {
          for (const [, entry] of sphericalTiles) {
            if (entry.z > activeTargetZ + 1) {
              entry.mesh.visible = false;
              continue;
            }
            const c = entry.mesh.position;
            const dot = c.x * camUx + c.y * camUy + c.z * camUz;
            // Patch angular half-diagonal is ~π / 2^z; keep visible if any corner can face the camera
            const minDot = -Math.min(0.85, 4.5 / Math.pow(2, entry.z));
            entry.mesh.visible = dot > minDot;
          }
        }
        renderer.render(scene, camera);
        drawOverlay();
      }
      afterDraw(animate);
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
      ro.disconnect();
      for (const [, entry] of sphericalTiles) {
        entry.geo.dispose();
        entry.mat.dispose();
        entry.tex.dispose();
      }
      sphericalTiles.clear();
      earthGeo.dispose();
      earthMat.dispose();
      earthTexture.dispose();
      renderer?.dispose();
    };
  }, []);

  // Raycasts the mouse cursor onto the unit sphere and returns exact geographical coordinates (lat, lon) in radians
  const raycastGlobePoint = (
    clientX: number,
    clientY: number
  ): { lat: number; lon: number } | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const viewW = rect.width;
    const viewH = rect.height;
    if (viewW <= 0 || viewH <= 0) return null;

    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    const ndcX = (mouseX / viewW) * 2 - 1;
    const ndcY = -(mouseY / viewH) * 2 + 1;

    const fovRad = (cameraStateRef.current.fov * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad * 0.5);
    const aspect = viewW / viewH;

    const camZ = cameraStateRef.current.camZ;
    const scale = cameraStateRef.current.scale;

    // Ray direction in camera space (camera looks along -Z)
    const dirX = ndcX * tanHalfFov * aspect;
    const dirY = ndcY * tanHalfFov;
    const dirZ = -1.0;
    const len = Math.hypot(dirX, dirY, dirZ);
    const dx = dirX / len;
    const dy = dirY / len;
    const dz = dirZ / len;

    // Ray-Sphere intersection with sphere of radius `scale` at (0, 0, 0)
    const b = camZ * dz;
    const c = camZ * camZ - scale * scale;
    const disc = b * b - c;
    if (disc < 0) return null; // Ray missed the globe

    const t = -b - Math.sqrt(disc);
    const px = t * dx;
    const py = t * dy;
    const pz = camZ + t * dz;

    // Point on unit sphere in world space
    const uxWorld = px / scale;
    const uyWorld = py / scale;
    const uzWorld = pz / scale;

    // Inverse rotation of spinGroup (order 'XYZ', R = R_x(lat) * R_y(-lon - PI/2)):
    // R_inv = R_y(lon + PI/2) * R_x(-lat)
    const curLat = rotRef.current.lat;
    const curLon = rotRef.current.lon;

    // 1. Rotate by -curLat around X axis
    const cosLat = Math.cos(-curLat);
    const sinLat = Math.sin(-curLat);
    const x1 = uxWorld;
    const y1 = uyWorld * cosLat - uzWorld * sinLat;
    const z1 = uyWorld * sinLat + uzWorld * cosLat;

    // 2. Rotate by (curLon + PI/2) around Y axis
    const angleY = curLon + Math.PI * 0.5;
    const cosY = Math.cos(angleY);
    const sinY = Math.sin(angleY);
    const x2 = x1 * cosY + z1 * sinY;
    const y2 = y1;
    const z2 = -x1 * sinY + z1 * cosY;

    const clampedY = Math.max(-0.999999, Math.min(0.999999, y2));
    const geoLat = Math.asin(clampedY);
    const geoLon = Math.atan2(-z2, x2);

    return { lat: geoLat, lon: geoLon };
  };

  return (
    <div
      ref={containerRef}
      aria-label="Interactive 3D Earth Globe"
      onPointerDown={(e) => {
        dragRef.current = {
          active: true,
          moved: false,
          startX: e.clientX,
          startY: e.clientY,
          x: e.clientX,
          y: e.clientY,
        };
      }}
      onPointerMove={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          pointerPosRef.current = { x: px, y: py };

          // Check if hovering near a runway on the map
          let hitRwy: { airport: Airport; ident: string; x: number; y: number; lengthM: number } | null = null;
          for (let k = 0; k < screenRunwaysRef.current.length; k++) {
            const sr = screenRunwaysRef.current[k];
            const dx = sr.rx2 - sr.rx1, dy = sr.ry2 - sr.ry1;
            const lenSq = dx * dx + dy * dy;
            if (lenSq < 16) continue;
            let t = ((px - sr.rx1) * dx + (py - sr.ry1) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const cx = sr.rx1 + t * dx, cy = sr.ry1 + t * dy;
            const distSq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
            const hitDist = Math.max(16, sr.widthPx * 0.5 + 8);
            if (distSq <= hitDist * hitDist) {
              const ident = t <= 0.5 ? sr.le : sr.he;
              hitRwy = { airport: sr.airport, ident, x: cx, y: cy, lengthM: sr.rw.length };
              break;
            }
          }
          hoveredRunwayRef.current = hitRwy;
        }
        if (!dragRef.current.active) return;
        const dx = e.clientX - dragRef.current.x;
        const dy = e.clientY - dragRef.current.y;
        if (
          Math.hypot(e.clientX - dragRef.current.startX, e.clientY - dragRef.current.startY) > 6
        ) {
          dragRef.current.moved = true;
        }
        dragRef.current.x = e.clientX;
        dragRef.current.y = e.clientY;

        // Exact 1:1 projective surface-locked drag sensitivity across all zoom levels (1x .. 21 000x)
        const { fov, camZ, scale, viewH } = cameraStateRef.current;
        const fovRad = (fov * Math.PI) / 180;
        const surfDist = Math.max(0.00005, camZ - scale);
        const radPerPixel =
          (2 * surfDist * Math.tan(fovRad * 0.5)) / (Math.max(300, viewH) * scale);
        const cosLat = Math.max(0.25, Math.cos(rotRef.current.lat));

        rotRef.current.lon -= (dx * radPerPixel) / cosLat;
        rotRef.current.lat = Math.max(-1.42, Math.min(1.42, rotRef.current.lat + dy * radPerPixel));
        rotRef.current.targetLon = rotRef.current.lon;
        rotRef.current.targetLat = rotRef.current.lat;
      }}
      onPointerUp={(e) => {
        if (!dragRef.current.active) return;
        const wasClick = !dragRef.current.moved;
        dragRef.current.active = false;
        if (wasClick && modeRef.current === 'planner') {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;

          // 1. First priority: Check if user clicked directly on a runway
          let clickedRunway: { airport: Airport; ident: string; rw: Runway } | null = null;
          let bestRwyDistSq = Infinity;
          for (let k = 0; k < screenRunwaysRef.current.length; k++) {
            const sr = screenRunwaysRef.current[k];
            const dx = sr.rx2 - sr.rx1, dy = sr.ry2 - sr.ry1;
            const lenSq = dx * dx + dy * dy;
            if (lenSq < 16) continue;
            let t = ((x - sr.rx1) * dx + (y - sr.ry1) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const cx = sr.rx1 + t * dx, cy = sr.ry1 + t * dy;
            const distSq = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            const hitDist = Math.max(20, sr.widthPx * 0.5 + 10);
            if (distSq <= hitDist * hitDist && distSq < bestRwyDistSq) {
              bestRwyDistSq = distSq;
              const ident = t <= 0.5 ? sr.le : sr.he;
              clickedRunway = { airport: sr.airport, ident, rw: sr.rw };
            }
          }

          if (clickedRunway) {
            const { airport, ident } = clickedRunway;
            let role: 'dep' | 'arr' = 'dep';
            if (selectedArrRef.current?.id === airport.id && selectedDepRef.current?.id !== airport.id) {
              role = 'arr';
            } else if (selectedDepRef.current?.id === airport.id) {
              role = 'dep';
            } else if (selectedDepRef.current && !selectedArrRef.current) {
              role = 'arr';
            }

            onSelectRunwayRef.current?.(airport, ident, role);
            onInspectAirport?.(airport);
            setActiveAirport({ airport, x, y });

            const a = resolveRunwayAnchor(airport, ident, role);
            if (a) {
              const visibleKm = Math.max(1.2, (a.lengthM / 1000) / 0.45);
              const z = Math.max(GLOBE_AIRPORT_FOCUS_ZOOM, Math.min(MAX_GLOBE_ZOOM, (2 * GLOBE_BASE_ALT * EARTH_RADIUS_KM * GLOBE_TAN_HALF_FOV) / visibleKm));
              setShortestTargetLatLon(a.midLat, a.midLon, z);
              requestHighResTilesRef.current?.(a.midLat, a.midLon, z);
            }
            return;
          }

          // 2. Second priority: Airport center markers
          let picked: { airport: Airport; x: number; y: number } | null = null;
          let bestDistSq = 22 * 22;
          for (const pin of screenPinsRef.current) {
            const dSq = (pin.x - x) * (pin.x - x) + (pin.y - y) * (pin.y - y);
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              picked = pin;
            }
          }
          if (picked) {
            setActiveAirport(picked);
            const nextZoom = Math.max(rotRef.current.targetZoom, GLOBE_AIRPORT_FOCUS_ZOOM);
            setShortestTargetLatLon(picked.airport.lat, picked.airport.lon, nextZoom);
            requestHighResTilesRef.current?.(picked.airport.lat, picked.airport.lon, nextZoom);
            onInspectAirport?.(picked.airport);
          } else {
            setActiveAirport(null);
          }
        }
      }}
      onPointerCancel={() => {
        dragRef.current.active = false;
      }}
      onWheel={(e) => {
        if (modeRef.current !== 'planner') return;
        const factor = e.deltaY < 0 ? 1.38 : 1 / 1.38;
        const nextZoom = Math.max(1.0, Math.min(MAX_GLOBE_ZOOM, rotRef.current.targetZoom * factor));
        rotRef.current.targetZoom = nextZoom;

        // Zoom directed towards the mouse cursor position on the globe
        const hit = raycastGlobePoint(e.clientX, e.clientY);
        if (hit) {
          const twoPi = Math.PI * 2;
          const dLon = (((hit.lon - rotRef.current.lon) % twoPi) + twoPi * 1.5) % twoPi - Math.PI;
          const dLat = hit.lat - rotRef.current.lat;

          if (factor > 1) {
            // Zooming IN: pull target center towards the cursor point on the globe
            const moveFrac = Math.min(0.5, 1 - 1 / factor);
            rotRef.current.targetLat = Math.max(-1.42, Math.min(1.42, rotRef.current.targetLat + dLat * moveFrac));
            rotRef.current.targetLon = rotRef.current.targetLon + dLon * moveFrac;
          } else {
            // Zooming OUT: gently center back to keep overview stable
            const moveFrac = Math.min(0.2, 1 - factor);
            rotRef.current.targetLat = Math.max(-1.42, Math.min(1.42, rotRef.current.targetLat - dLat * moveFrac));
            rotRef.current.targetLon = rotRef.current.targetLon - dLon * moveFrac;
          }
        } else {
          rotRef.current.targetLat = rotRef.current.lat;
          rotRef.current.targetLon = rotRef.current.lon;
        }

        if (nextZoom > 1.2) {
          requestHighResTilesRef.current?.(
            rotRef.current.targetLat * (180 / Math.PI),
            rotRef.current.targetLon * (180 / Math.PI),
            nextZoom
          );
        }
      }}
      className={`relative ${hoveredRunwayRef.current ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${className}`}
    >
      <div ref={glMountRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas
        ref={overlayCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* Interactive MSFS 2024 Airport Context Menu on the 3D Globe */}
      {mode === 'planner' && activeAirport && (
        <div
          ref={popupDomRef}
          className="absolute z-30 pointer-events-auto select-none shadow-2xl"
          style={{
            left: Math.max(16, Math.min((containerRef.current?.clientWidth || 900) - 224, activeAirport.x + 14)),
            top: Math.max(150, Math.min((containerRef.current?.clientHeight || 700) - 165, activeAirport.y - 28)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="bg-white text-slate-950 px-2.5 py-1 text-[11px] font-extrabold tracking-tight border border-slate-300 shadow mb-1 flex items-center justify-between gap-2">
            <span className="truncate">
              {activeAirport.airport.icao} — {activeAirport.airport.name}
            </span>
            <button
              type="button"
              onClick={() => setActiveAirport(null)}
              className="text-slate-500 hover:text-slate-950 shrink-0"
              aria-label="Close airport menu"
            >
              <FlightIcon name="close" size={10} />
            </button>
          </div>
          <div className="w-56 bg-[#18202c]/98 border border-white/25 flex flex-col divide-y divide-white/10 shadow-2xl">
            <button
              type="button"
              onClick={() => {
                const chosen = activeAirport.airport;
                onSelectAirport?.(chosen, 'from');
                setActiveAirport(null);
              }}
              className="px-3 py-1.5 text-left text-xs font-bold bg-white text-slate-950 hover:bg-sky-100 transition flex items-center justify-between"
            >
              <span>Set as departure</span>
              <span className="text-[10px] font-mono font-extrabold text-emerald-700">DEP</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const chosen = activeAirport.airport;
                onSelectAirport?.(chosen, 'to');
                setActiveAirport(null);
              }}
              className="px-3 py-1.5 text-left text-xs font-bold bg-[#1d6ae5] text-white hover:bg-[#2572eb] transition flex items-center justify-between"
            >
              <span>Set as arrival</span>
              <span className="text-[10px] font-mono font-extrabold text-sky-100">ARR</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const chosen = activeAirport.airport;
                setShortestTargetLatLon(chosen.lat, chosen.lon, GLOBE_AIRPORT_DETAIL_ZOOM);
                requestHighResTilesRef.current?.(chosen.lat, chosen.lon, GLOBE_AIRPORT_DETAIL_ZOOM);
                onInspectAirport?.(chosen);
              }}
              className="px-3 py-1.5 text-left text-xs font-bold bg-[#1e293b] text-slate-100 hover:bg-[#334155] transition flex items-center justify-between"
            >
              <span>Zoom to Airport</span>
              <span className="text-[10px] font-mono text-sky-300">RWY</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const chosen = activeAirport.airport;
                onFlyNow?.(chosen);
                setActiveAirport(null);
              }}
              className="px-3 py-1.5 text-left text-xs font-extrabold bg-[#eab308] text-slate-950 hover:bg-[#facc15] transition flex items-center justify-between"
            >
              <span>Fly Now</span>
              <FlightIcon name="plane" size={12} />
            </button>
            {activeAirport.airport.runways.length > 0 && (
              <div className="bg-[#0b1220] px-2.5 py-1.5 text-slate-300">
                <div className="text-[9px] uppercase tracking-wider text-slate-400 font-extrabold mb-1">
                  Select Runway ({activeAirport.airport.runways.length})
                </div>
                <div className="flex flex-col gap-1 max-h-36 overflow-y-auto pr-0.5">
                  {activeAirport.airport.runways.map((rw) => (
                    <div
                      key={`${rw.le}-${rw.he}`}
                      className="flex items-center justify-between text-[10px] font-mono bg-white/5 px-1.5 py-1 rounded border border-white/5"
                    >
                      <span className="font-bold text-slate-200">
                        {rw.le}/{rw.he} <span className="text-slate-400 font-normal">({Math.round(rw.length)}m)</span>
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectRunwayRef.current?.(activeAirport.airport, rw.le, 'dep');
                            setActiveAirport(null);
                          }}
                          className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold rounded text-[9px] shadow"
                        >
                          {rw.le} DEP
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectRunwayRef.current?.(activeAirport.airport, rw.he, 'dep');
                            setActiveAirport(null);
                          }}
                          className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold rounded text-[9px] shadow"
                        >
                          {rw.he} DEP
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectRunwayRef.current?.(activeAirport.airport, rw.le, 'arr');
                            setActiveAirport(null);
                          }}
                          className="px-1.5 py-0.5 bg-amber-700 hover:bg-amber-600 text-white font-extrabold rounded text-[9px] shadow"
                        >
                          {rw.le} ARR
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectRunwayRef.current?.(activeAirport.airport, rw.he, 'arr');
                            setActiveAirport(null);
                          }}
                          className="px-1.5 py-0.5 bg-amber-700 hover:bg-amber-600 text-white font-extrabold rounded text-[9px] shadow"
                        >
                          {rw.he} ARR
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   4. MSFS 2024 FULL-SCREEN CHANGE AIRCRAFT HANGAR MODAL (IMAGES 5 & 6)
   ========================================================================= */

export function AircraftHangarModal({
  aircraftId,
  selectedVariantId,
  onSelectAircraftAndVariant,
  settings,
  onUpdateSettings,
  onClose,
}: {
  aircraftId: string;
  selectedVariantId: string;
  onSelectAircraftAndVariant: (aircraftId: string, variant: AircraftVariantInfo) => void;
  settings: Settings;
  onUpdateSettings: (p: Partial<Settings>) => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<HangarCategory>('all');
  const [viewMode, setViewMode] = useState<'gallery' | 'list' | 'configure'>('gallery');
  const [search, setSearch] = useState('');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [favourites, setFavourites] = useState<string[]>(['sky-cfm-std', 'trek-pt6-stol', 'swift-io360-std']);
  const [hoveredVariantId, setHoveredVariantId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [ tailNum, setTailNum ] = useState(() => {
    const v = AIRCRAFT_VARIANTS.find((x) => x.variantId === selectedVariantId);
    return v?.tailNumber || 'PK-SKY';
  });
  const [flightNum, setFlightNum] = useState('SKY-104');
  const [fuelPct, setFuelPct] = useState(75);
  const [payloadPct, setPayloadPct] = useState(80);

  useEffect(() => {
    (window as any).__hangarModalOpen = true;
    return () => {
      (window as any).__hangarModalOpen = false;
    };
  }, []);

  const activeVariant =
    AIRCRAFT_VARIANTS.find((v) => v.variantId === selectedVariantId) ||
    AIRCRAFT_VARIANTS.find((v) => v.aircraftId === aircraftId) ||
    AIRCRAFT_VARIANTS[0];

  const inspectedVariant =
    (hoveredVariantId ? AIRCRAFT_VARIANTS.find((v) => v.variantId === hoveredVariantId) : null) ||
    activeVariant;
  const inspectedAircraftId = inspectedVariant.aircraftId;
  const inspectedSpec = specById(inspectedAircraftId);
  const activeSpec = specById(activeVariant.aircraftId);
  const stats = getAircraftStatsComparison(inspectedAircraftId, activeVariant.aircraftId);
  const filteredVariants = filterAircraftVariants(category, search, favouritesOnly, favourites);

  const toggleFav = (vId: string) => {
    setFavourites((prev) => (prev.includes(vId) ? prev.filter((x) => x !== vId) : [...prev, vId]));
  };

  const categories: [HangarCategory, string][] = [
    ['all', 'All'],
    ['piston', 'Piston Trainer'],
    ['turboprop', 'Turboprop STOL'],
    ['jet', 'Jet Airliner'],
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#222a35] text-white select-none font-sans overflow-hidden animate-[fadein_.18s_ease-out]">
      {/* Top Banner Header (Matches Reference Screenshots 5 & 6) */}
      <div className="flex items-start justify-between px-6 pt-4 pb-2 shrink-0 bg-[#192029] border-b border-white/10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-white hover:text-sky-300 transition flex items-center"
            aria-label="Back to Free Flight"
          >
            <svg width="28" height="38" viewBox="0 0 32 44" fill="none" aria-hidden="true">
              <path d="M4 4L24 22L4 40" stroke="currentColor" strokeWidth="6" strokeLinecap="square" />
            </svg>
          </button>
          <div>
            <div className="text-xs font-bold tracking-wide text-sky-200 leading-none">Change Aircraft</div>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white leading-tight">Aircraft</h1>
          </div>
        </div>

        <MsfsTopRightBar pilotName={settings.name} />
      </div>

      {/* Category Filter Bar */}
      <div className="px-6 sm:px-12 pt-3 pb-3 grid grid-cols-2 sm:grid-cols-5 gap-2 shrink-0">
        {categories.map(([catId, label]) => {
          const active = category === catId;
          return (
            <button
              key={catId}
              type="button"
              onClick={() => setCategory(catId)}
              className={`h-10 px-4 text-left text-xs font-bold relative overflow-hidden transition border ${
                active
                  ? 'bg-[#2572eb] border-sky-300 text-white shadow-md'
                  : 'bg-[#173a70] border-white/10 text-slate-200 hover:bg-[#1e4b8f]'
              }`}
            >
              <span>{label}</span>
              {active && (
                <span
                  className="absolute bottom-0 right-0 w-6 h-6 bg-[#0d1624] flex items-end justify-end p-0.5"
                  style={{ clipPath: 'polygon(100% 0, 0 100%, 100% 100%)' }}
                >
                  <FlightIcon name="check" size={11} className="text-white" />
                </span>
              )}
            </button>
          );
        })}
        <div className="hidden sm:flex h-10 px-4 items-center justify-between bg-[#156828] border border-emerald-400/30 text-xs font-bold text-white">
          <span>Verified Repo Fleet (3 Types)</span>
          <FlightIcon name="check" size={14} />
        </div>
      </div>

      {/* Main Content Split: Left Inspector + Right Gallery/List */}
      <div className="flex-1 min-h-0 px-6 sm:px-12 pb-3 flex flex-col lg:flex-row gap-4 overflow-hidden">
        {/* LEFT INSPECTOR PANEL */}
        <aside className="w-full lg:w-[310px] xl:w-[340px] shrink-0 bg-[#323b48] border border-white/20 flex flex-col justify-between overflow-y-auto">
          {viewMode === 'gallery' ? (
            /* GALLERY MODE LEFT PANEL: Statistics & Comparison */
            <div className="p-4 space-y-4">
              <div>
                <div className="text-lg font-bold text-white leading-snug">{inspectedVariant.title}</div>
                <div className="text-xs text-slate-300 mt-0.5">{inspectedVariant.maker}</div>
                <div className="text-xs text-slate-300">{inspectedVariant.density}</div>
              </div>

              <div className="border-t border-white/15 pt-2">
                <div className="bg-[#1e242d] px-3 py-1.5 text-xs font-bold text-white flex items-center justify-between">
                  <span>Statistics</span>
                  {inspectedVariant.variantId !== activeVariant.variantId && (
                    <span className="text-[10px] font-mono text-sky-300">vs {activeVariant.tailNumber}</span>
                  )}
                </div>
                <div className="divide-y divide-white/10 text-xs mt-1">
                  <div className="py-2 flex items-center justify-between gap-2">
                    <span className="text-slate-300">Landing Surface</span>
                    <span className="font-semibold text-white text-right">{inspectedVariant.surface.split('(')[0].trim()}</span>
                  </div>
                  <div className="py-2 flex items-center justify-between gap-2">
                    <span className="text-slate-300">Fuel Capacity</span>
                    <span className="font-mono font-bold text-white">{stats.fuelCapKg.toLocaleString()} kg</span>
                  </div>
                  <div className="py-2 flex items-center justify-between gap-2">
                    <span className="text-slate-300">Cruise Speed</span>
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-slate-400">{stats.cruiseKmh} km/h</span>
                      {stats.cruiseDeltaKt !== 0 && (
                        <span className={stats.cruiseDeltaKt > 0 ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                          {stats.cruiseDeltaKt > 0 ? '+' : ''}
                          {stats.cruiseDeltaKt} kt
                        </span>
                      )}
                      <span className="font-bold text-white">{stats.cruiseKt} kt</span>
                    </div>
                  </div>
                  <div className="py-2 flex items-center justify-between gap-2">
                    <span className="text-slate-300">Max Altitude</span>
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-slate-400">{Math.round(inspectedSpec.ceiling).toLocaleString()} m</span>
                      <span className="font-bold text-white">{stats.ceilingFt.toLocaleString()} ft</span>
                    </div>
                  </div>
                  <div className="py-2 flex items-center justify-between gap-2">
                    <span className="text-slate-300">Max Range</span>
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-slate-400">{stats.rangeNm.toLocaleString()} nm</span>
                      <span className="font-bold text-emerald-300">{stats.rangeKm.toLocaleString()} km</span>
                    </div>
                  </div>
                  <div className="py-2 flex items-center justify-between gap-2">
                    <span className="text-slate-300">Avionics &amp; Systems</span>
                    <span className="font-semibold text-sky-300">
                      {inspectedSpec.hasGlass ? 'Glass PFD + CAT-III ILS' : 'Analog 6-Pack + Autopilot'}
                    </span>
                  </div>
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed bg-[#232a35] p-3 border border-white/10">
                {inspectedSpec.blurb}
              </p>
            </div>
          ) : (
            /* LIST / CONFIGURE MODE LEFT PANEL: Livery, Identification, Fuel & Payload */
            <div className="p-4 space-y-3.5 text-xs">
              <div>
                <div className="text-lg font-bold text-white leading-snug">{activeVariant.title}</div>
                <div className="text-xs text-slate-300">{activeVariant.maker} · {activeVariant.variantLabel}</div>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-300 font-bold mb-1">
                  VARIANT
                </label>
                <select
                  aria-label="Aircraft Variant"
                  value={activeVariant.aircraftId}
                  onChange={(e) => {
                    const nextV = AIRCRAFT_VARIANTS.find((v) => v.aircraftId === e.target.value) || AIRCRAFT_VARIANTS[0];
                    onSelectAircraftAndVariant(nextV.aircraftId, nextV);
                    setTailNum(nextV.tailNumber);
                  }}
                  className="w-full bg-[#1e2530] border border-white/15 px-2.5 py-2 text-white font-semibold outline-none"
                >
                  {AIRCRAFT.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {a.role}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-300 font-bold mb-1">
                  <span>LIVERY</span>
                  <span>{AIRCRAFT_VARIANTS.filter((v) => v.aircraftId === activeVariant.aircraftId).length}</span>
                </div>
                <div className="flex gap-1">
                  <select
                    aria-label="Aircraft Livery"
                    value={activeVariant.variantId}
                    onChange={(e) => {
                      const nextV = AIRCRAFT_VARIANTS.find((v) => v.variantId === e.target.value);
                      if (nextV) {
                        onSelectAircraftAndVariant(nextV.aircraftId, nextV);
                        setTailNum(nextV.tailNumber);
                      }
                    }}
                    className="flex-1 bg-[#2572eb] border border-sky-300 px-2.5 py-1.5 text-white font-bold outline-none truncate"
                  >
                    {AIRCRAFT_VARIANTS.filter((v) => v.aircraftId === activeVariant.aircraftId).map((v) => (
                      <option key={v.variantId} value={v.variantId}>
                        {v.liveryName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => toggleFav(activeVariant.variantId)}
                    className={`w-8 grid place-items-center border border-white/15 ${
                      favourites.includes(activeVariant.variantId) ? 'bg-amber-500 text-slate-950' : 'bg-[#1e2530] text-white'
                    }`}
                    aria-label="Toggle Favourite Livery"
                  >
                    <FlightIcon name="heart" size={14} />
                  </button>
                </div>

                <div className="mt-2 h-28 shrink-0 border border-white/15 relative overflow-hidden">
                  <AircraftStudioCardVisual variant={activeVariant} />
                </div>
              </div>

              <div className="space-y-1.5 pt-1 border-t border-white/15">
                <div className="text-[10px] uppercase tracking-wider text-slate-300 font-bold">IDENTIFICATION</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-300">Tail number</span>
                  <input
                    aria-label="Tail number"
                    value={tailNum}
                    onChange={(e) => setTailNum(e.target.value.toUpperCase())}
                    maxLength={10}
                    className="w-36 bg-[#1e2530] border border-white/10 px-2 py-1 text-right font-mono text-white outline-none"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-300">Call sign</span>
                  <input
                    aria-label="Call sign"
                    value={settings.name}
                    onChange={(e) => onUpdateSettings({ name: e.target.value })}
                    maxLength={14}
                    className="w-36 bg-[#1e2530] border border-white/10 px-2 py-1 text-right font-mono text-white outline-none"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-300">Flight number</span>
                  <input
                    aria-label="Flight number"
                    value={flightNum}
                    onChange={(e) => setFlightNum(e.target.value.toUpperCase())}
                    maxLength={10}
                    className="w-36 bg-[#1e2530] border border-white/10 px-2 py-1 text-right font-mono text-white outline-none"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-white/15 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Fuel Load ({fuelPct}%)</span>
                  <span className="font-mono font-bold text-sky-300">
                    {Math.round((activeSpec.fuelCap * fuelPct) / 100).toLocaleString()} kg
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Fuel Load Percentage"
                  min={20}
                  max={100}
                  value={fuelPct}
                  onChange={(e) => setFuelPct(+e.target.value)}
                  className="w-full accent-sky-400"
                />
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Payload ({payloadPct}%)</span>
                  <span className="font-mono font-bold text-emerald-300">
                    {Math.round((activeSpec.payload * payloadPct) / 100).toLocaleString()} kg ({activeSpec.pax} pax)
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Payload Percentage"
                  min={10}
                  max={100}
                  value={payloadPct}
                  onChange={(e) => setPayloadPct(+e.target.value)}
                  className="w-full accent-emerald-400"
                />
              </div>
            </div>
          )}

          {/* Bottom Blue Configure Button inside Left Panel */}
          <div className="p-3 pt-0 shrink-0">
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'gallery' ? 'configure' : 'gallery')}
              className="w-full h-20 px-4 py-3 bg-[#2572eb] hover:bg-[#1d64d6] text-left relative overflow-hidden border border-sky-300/40 transition flex flex-col justify-between"
            >
              <span className="text-xs font-bold text-white relative z-10">
                {viewMode === 'gallery' ? 'Configure your aircraft' : 'Return to Statistics'}
              </span>
              <span className="text-[11px] text-sky-100/90 relative z-10">
                {viewMode === 'gallery' ? 'Livery · Callsign · Fuel & Mass' : 'Compare performance metrics'}
              </span>
              <svg
                viewBox="0 0 100 100"
                className="w-24 h-24 absolute -right-2 -bottom-3 opacity-25 text-white"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="50" cy="55" r="36" />
                <ellipse cx="50" cy="55" rx="22" ry="36" />
                <path d="M22 42 H78 M16 58 H84 M30 74 H70" />
              </svg>
            </button>
          </div>
        </aside>

        {/* RIGHT MAIN AREA: Search Toolbar + Gallery Grid OR Grouped List */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Top Search & View Mode Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0">
            <div className="flex items-center bg-[#182029] border border-white/15 px-3 py-1.5 w-full sm:w-80">
              <FlightIcon name="search" size={14} className="text-slate-400 mr-2 shrink-0" />
              <input
                aria-label="Search aircraft"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search aircraft, maker, variant..."
                className="w-full bg-transparent text-xs text-white placeholder:text-slate-400 outline-none"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} className="text-slate-400 hover:text-white">
                  <FlightIcon name="close" size={13} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-300 mr-2 font-mono">
                {filteredVariants.length} variants ({AIRCRAFT.length} core models)
              </span>
              <button
                type="button"
                onClick={() => setFavouritesOnly((f) => !f)}
                className={`px-3 py-1.5 font-bold flex items-center gap-1.5 border transition ${
                  favouritesOnly
                    ? 'bg-[#2572eb] border-sky-300 text-white'
                    : 'bg-[#2c3542] border-white/10 text-slate-200 hover:bg-[#384354]'
                }`}
              >
                <FlightIcon name="heart" size={13} />
                <span>Favourites</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('gallery')}
                className={`px-3 py-1.5 font-bold flex items-center gap-1.5 border transition ${
                  viewMode === 'gallery'
                    ? 'bg-[#2572eb] border-sky-300 text-white'
                    : 'bg-[#2c3542] border-white/10 text-slate-200 hover:bg-[#384354]'
                }`}
              >
                <FlightIcon name="grid" size={13} />
                <span>Gallery</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`px-3 py-1.5 font-bold flex items-center gap-1.5 border transition ${
                  viewMode === 'list' || viewMode === 'configure'
                    ? 'bg-[#2572eb] border-sky-300 text-white'
                    : 'bg-[#2c3542] border-white/10 text-slate-200 hover:bg-[#384354]'
                }`}
              >
                <FlightIcon name="list" size={13} />
                <span>List</span>
              </button>
            </div>
          </div>

          {/* GALLERY VIEW: Dedicated scroll wrapper + fixed-height non-shrinking image area so text boxes NEVER obscure aircraft images in "All" or any other tab */}
          {viewMode === 'gallery' ? (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5 pb-4">
                {filteredVariants.map((v) => {
                  const isSelected = v.variantId === activeVariant.variantId;
                  const spec = specById(v.aircraftId);
                  return (
                    <button
                      key={v.variantId}
                      type="button"
                      onMouseEnter={() => setHoveredVariantId(v.variantId)}
                      onMouseLeave={() => setHoveredVariantId(null)}
                      onClick={() => {
                        onSelectAircraftAndVariant(v.aircraftId, v);
                        setTailNum(v.tailNumber);
                      }}
                      className={`text-left flex flex-col h-[264px] shrink-0 border transition relative overflow-hidden group ${
                        isSelected
                          ? 'border-sky-300 shadow-[0_0_24px_rgba(37,114,235,0.45)]'
                          : 'border-white/15 hover:border-white/40'
                      }`}
                    >
                      {/* Upper Studio Render Area with Real Aircraft Image (strictly shrink-0 so text box below never covers it) */}
                      <div className="h-[152px] min-h-[152px] w-full shrink-0 relative overflow-hidden bg-[#1b222c]">
                        <AircraftStudioCardVisual
                          variant={v}
                          className="w-full h-full"
                          imgClassName="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
                        />
                        <span className="absolute bottom-2 right-2 text-[9px] font-mono font-bold tracking-wider uppercase px-1.5 py-0.5 bg-slate-950/75 border border-white/10 text-slate-200">
                          {v.maker}
                        </span>
                      </div>

                      {/* Lower Info Area */}
                      <div
                        className={`p-3.5 flex-1 min-h-0 flex flex-col justify-between relative ${
                          isSelected ? 'bg-[#2572eb] text-white' : 'bg-[#364457] text-slate-100 group-hover:bg-[#405168]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-bold text-sm leading-snug truncate">{v.title}</div>
                          <div className={`text-xs mt-0.5 truncate ${isSelected ? 'text-sky-100' : 'text-slate-300'}`}>
                            {v.variantLabel} · {v.tailNumber}
                          </div>
                        </div>
                        <div
                          className={`pt-2 border-t text-[11px] font-mono flex items-center justify-between ${
                            isSelected ? 'border-white/20 text-sky-100' : 'border-white/10 text-slate-300'
                          }`}
                        >
                          <span>{spec.cruiseKt} kt</span>
                          <span>{spec.rangeKm.toLocaleString()} km</span>
                          <span>{spec.pax} pax</span>
                        </div>

                        {isSelected && (
                          <span
                            className="absolute bottom-0 right-0 w-8 h-8 bg-[#0d1624] flex items-end justify-end p-1"
                            style={{ clipPath: 'polygon(100% 0, 0 100%, 100% 100%)' }}
                          >
                            <FlightIcon name="check" size={13} className="text-white" />
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* LIST VIEW */
            <div className="flex-1 overflow-y-auto bg-[#121822]/95 border border-white/15">
              <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/10 bg-[#18202c]">
                <div className="col-span-6">AIRCRAFT</div>
                <div className="col-span-3">VARIANT</div>
                <div className="col-span-3">MAKER</div>
              </div>

              {AIRCRAFT.map((aircraft) => {
                const groupVariants = filteredVariants.filter((v) => v.aircraftId === aircraft.id);
                if (groupVariants.length === 0) return null;
                const isCollapsed = !!collapsedGroups[aircraft.id];
                return (
                  <div key={aircraft.id} className="border-b border-white/10">
                    <button
                      type="button"
                      onClick={() => setCollapsedGroups((prev) => ({ ...prev, [aircraft.id]: !prev[aircraft.id] }))}
                      className="w-full px-4 py-2.5 bg-[#1b2432] hover:bg-[#222d3e] flex items-center justify-between text-left"
                    >
                      <div className="flex items-center gap-2">
                        <FlightIcon name={isCollapsed ? 'chevron' : 'down'} size={13} className="text-slate-400" />
                        <span className="font-bold text-sm text-white">{aircraft.name}</span>
                        <span className="text-xs text-slate-400">
                          {groupVariants.length} · {groupVariants[0].maker}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-400">
                        {aircraft.cruiseKt} kt · {aircraft.rangeKm.toLocaleString()} km
                      </span>
                    </button>

                    {!isCollapsed &&
                      groupVariants.map((v) => {
                        const isSelected = v.variantId === activeVariant.variantId;
                        const isFav = favourites.includes(v.variantId);
                        return (
                          <div
                            key={v.variantId}
                            onClick={() => {
                              onSelectAircraftAndVariant(v.aircraftId, v);
                              setTailNum(v.tailNumber);
                            }}
                            className={`grid grid-cols-12 items-center px-4 py-2 text-xs cursor-pointer border-t border-white/5 transition ${
                              isSelected ? 'bg-[#2572eb] text-white font-semibold' : 'hover:bg-white/5 text-slate-200'
                            }`}
                          >
                            <div className="col-span-6 flex items-center gap-2.5">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFav(v.variantId);
                                }}
                                className={isFav ? 'text-sky-300' : 'text-slate-500 hover:text-slate-300'}
                                aria-label={`Favourite ${v.title}`}
                              >
                                <FlightIcon name="heart" size={13} />
                              </button>
                              <span>{v.title}</span>
                              <span className="text-[11px] opacity-75 font-mono">({v.tailNumber})</span>
                            </div>
                            <div className="col-span-3 text-slate-300">{v.variantLabel}</div>
                            <div className="col-span-3 flex items-center justify-between text-slate-300">
                              <span>{v.maker}</span>
                              <span className="font-mono text-sm">+</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Bar: Save and Back + Switch View */}
      <div className="px-6 sm:px-12 py-3 flex items-center justify-between shrink-0 bg-[#192029] border-t border-white/10">
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 bg-[#141a22] hover:bg-[#2572eb] border border-white/20 text-xs font-bold text-white transition"
        >
          Save and Back
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode(viewMode === 'gallery' ? 'list' : 'gallery')}
            className="px-4 py-2 bg-[#141a22] hover:bg-white/10 border border-white/15 text-xs font-bold text-slate-200 transition"
          >
            {viewMode === 'gallery' ? 'Switch to List' : 'Switch to Gallery'}
          </button>
        </div>
      </div>
    </div>
  );
}

