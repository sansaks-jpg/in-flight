import { useEffect, useRef, useState } from 'react';
import { AIRCRAFT, specById } from '../sim/specs';
import { AIRPORTS } from '../data/airports';
import { Settings } from '../sim/storage';
import { FlightIcon } from './FlightIcon';
import {
  AIRCRAFT_VARIANTS,
  AircraftVariantInfo,
  filterAircraftVariants,
  getAircraftStatsComparison,
  HangarCategory,
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
    <div className="flex items-center justify-end gap-2 select-none pointer-events-auto">
      {/* Device Input Indicator */}
      <div className="hidden sm:flex items-center gap-1.5 bg-[#12161f]/90 border border-white/15 px-2.5 py-1 text-[10px] font-mono tracking-wider text-slate-300 uppercase">
        <span>KBD / MOUSE</span>
      </div>

      {/* Pilot Callsign Banner */}
      <div
        className="flex items-center gap-2.5 pl-2 pr-3.5 py-1 border border-sky-400/30 shadow-lg"
        style={{
          background: 'linear-gradient(115deg, #1b4b9c 0%, #2572eb 50%, #163b7a 100%)',
          clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 0 100%)',
        }}
      >
        <div className="w-5 h-5 rounded-sm bg-slate-950/60 border border-white/30 grid place-items-center text-sky-200">
          <FlightIcon name="user" size={13} />
        </div>
        <span className="text-xs font-extrabold tracking-wide text-white drop-shadow">
          {pilotName || 'Pilot'}
        </span>
      </div>

      {/* Action Icon Cluster */}
      <div className="flex items-center gap-1 bg-[#12161f]/90 border border-white/15 px-1.5 py-1">
        {onOpenModal && (
          <>
            <button
              type="button"
              onClick={() => onOpenModal('scores')}
              className="w-6 h-6 grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition"
              title="Pilot Logbook & High Scores"
              aria-label="Pilot Logbook"
            >
              <FlightIcon name="trophy" size={14} />
            </button>
            <button
              type="button"
              onClick={() => onOpenModal('controls')}
              className="w-6 h-6 grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition"
              title="Keyboard & Controller Bindings"
              aria-label="Flight Controls"
            >
              <FlightIcon name="keyboard" size={14} />
            </button>
            <button
              type="button"
              onClick={() => onOpenModal('credits')}
              className="w-6 h-6 grid place-items-center text-emerald-400 hover:text-emerald-300 hover:bg-white/10 transition"
              title={`Verified Scenery Data (${REPO_FACTS.totalAirports.toLocaleString()} Airports)`}
              aria-label="Aeronautical Data"
            >
              <FlightIcon name="globe" size={14} />
            </button>
            <button
              type="button"
              onClick={() => onOpenModal('settings')}
              className="w-6 h-6 grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition"
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
   2. CUSTOM MULTI-LAYERED AIRCRAFT SILHOUETTE / STUDIO ARTWORK SVG
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
    // Twin-turbofan narrowbody airliner (3/4 front studio angle matching Images 2 & 5)
    return (
      <svg viewBox="0 0 320 150" className={className} fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={`fuselage-${accentColor}`} x1="60" y1="45" x2="245" y2="105" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="65%" stopColor="#e2e8f0" />
            <stop offset="100%" stopColor="#94a3b8" />
          </linearGradient>
        </defs>
        {/* Soft shadow */}
        <ellipse cx="165" cy="128" rx="95" ry="7" fill="rgba(0,0,0,0.35)" />
        {/* Starboard (right-side screen) wing + winglet */}
        <path d="M168 78 L296 63 L304 59 L299 67 L186 86 Z" fill="#cbd5e1" stroke="#64748b" strokeWidth="0.8" />
        <path d="M296 63 L305 49 L301 66 Z" fill={accentColor} />
        {/* Vertical Tail Fin */}
        <path d="M74 64 L46 18 L66 18 L102 64 Z" fill={accentColor} />
        <path d="M54 30 L76 30 L90 52 L64 52 Z" fill="rgba(255,255,255,0.22)" />
        {/* Horizontal Tailplane */}
        <path d="M62 64 L32 69 L44 72 L78 68 Z" fill="#94a3b8" />
        {/* Port (left-side screen) wing + winglet */}
        <path d="M142 78 L16 60 L22 57 L156 72 Z" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="0.8" />
        <path d="M16 60 L10 46 L21 58 Z" fill={accentColor} />
        {/* Main Fuselage */}
        <path
          d="M58 63 C95 57, 175 56, 224 64 C244 68, 255 76, 252 84 C248 92, 225 95, 182 94 C130 93, 82 84, 58 72 Z"
          fill={`url(#fuselage-${accentColor})`}
        />
        {/* Livery Stripe & Belly */}
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
        {/* Cockpit Windshield */}
        <path d="M222 67 L239 70 L243 75 L226 74 L217 71 Z" fill="#0f172a" stroke="#38bdf8" strokeWidth="0.7" />
        {/* Cabin Window Line */}
        <path
          d="M100 69 L204 71"
          stroke="#1e293b"
          strokeWidth="2.2"
          strokeDasharray="2.5 3.5"
          strokeLinecap="round"
        />
        {/* Nose Gear & Main Landing Gear */}
        <line x1="226" y1="91" x2="226" y2="112" stroke="#94a3b8" strokeWidth="2" />
        <circle cx="226" cy="114" r="3.5" fill="#0f172a" stroke="#475569" strokeWidth="1" />
        <line x1="154" y1="90" x2="154" y2="109" stroke="#94a3b8" strokeWidth="2.2" />
        <circle cx="152" cy="111" r="4" fill="#0f172a" stroke="#475569" strokeWidth="1" />
        <circle cx="157" cy="111" r="4" fill="#0f172a" stroke="#475569" strokeWidth="1" />
        {/* CFM Turbofan Nacelles (Port & Starboard) */}
        <ellipse cx="116" cy="83" rx="13" ry="9" fill={accentColor} />
        <ellipse cx="119" cy="83" rx="8" ry="6.5" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />
        <ellipse cx="212" cy="86" rx="14" ry="9.5" fill={accentColor} />
        <ellipse cx="215" cy="86" rx="8.5" ry="7" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />
      </svg>
    );
  }

  if (aircraftId === 'trek') {
    // High-wing twin turboprop STOL commuter
    return (
      <svg viewBox="0 0 320 150" className={className} fill="none" aria-hidden="true">
        <ellipse cx="160" cy="126" rx="85" ry="6" fill="rgba(0,0,0,0.35)" />
        {/* Vertical Tail Fin */}
        <path d="M62 66 L42 22 L64 22 L88 66 Z" fill={accentColor} />
        {/* High Wing */}
        <path d="M22 54 L298 54 L292 61 L28 61 Z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
        <path d="M22 54 L46 54 L44 61 L28 61 Z" fill={accentColor} />
        <path d="M274 54 L298 54 L292 61 L276 61 Z" fill={accentColor} />
        {/* Fuselage */}
        <path
          d="M54 64 L216 62 C238 64, 248 72, 246 82 C243 90, 224 92, 185 92 L58 76 Z"
          fill="#f8fafc"
          stroke="#cbd5e1"
          strokeWidth="0.8"
        />
        {/* Accent stripe */}
        <path d="M62 74 L242 76 L238 83 L66 80 Z" fill={accentColor} />
        <path d="M74 82 L232 84 L224 91 L82 88 Z" fill={bellyColor} opacity="0.75" />
        {/* Cockpit & Cabin windows */}
        <path d="M208 65 L230 68 L234 74 L212 73 Z" fill="#0f172a" stroke="#38bdf8" strokeWidth="0.7" />
        <path d="M104 70 L192 70" stroke="#0f172a" strokeWidth="4" strokeDasharray="6 5" />
        {/* Twin Turboprop Nacelles + Prop Discs */}
        <rect x="102" y="55" width="22" height="12" rx="5" fill={accentColor} />
        <ellipse cx="126" cy="61" rx="3" ry="18" fill="rgba(226,232,240,0.35)" stroke="#cbd5e1" strokeWidth="0.8" />
        <rect x="198" y="55" width="22" height="12" rx="5" fill={accentColor} />
        <ellipse cx="222" cy="61" rx="3" ry="18" fill="rgba(226,232,240,0.35)" stroke="#cbd5e1" strokeWidth="0.8" />
        {/* Fixed/Rugged STOL Gear */}
        <line x1="224" y1="90" x2="224" y2="110" stroke="#94a3b8" strokeWidth="2.2" />
        <circle cx="224" cy="112" r="4" fill="#0f172a" stroke="#64748b" strokeWidth="1.2" />
        <line x1="152" y1="90" x2="146" y2="110" stroke="#94a3b8" strokeWidth="2.5" />
        <circle cx="146" cy="112" r="5" fill="#0f172a" stroke="#64748b" strokeWidth="1.2" />
      </svg>
    );
  }

  // Default: Aero Swift RG (Single-engine piston tourer)
  return (
    <svg viewBox="0 0 320 150" className={className} fill="none" aria-hidden="true">
      <ellipse cx="160" cy="126" rx="75" ry="6" fill="rgba(0,0,0,0.35)" />
      {/* Tail Fin */}
      <path d="M68 68 L48 28 L68 28 L92 68 Z" fill={accentColor} />
      {/* Low/Mid Swept Wings */}
      <path d="M30 80 L144 74 L162 82 L36 86 Z" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="0.9" />
      <path d="M168 76 L292 72 L286 79 L176 84 Z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.9" />
      {/* Fuselage */}
      <path
        d="M62 67 C108 62, 178 60, 228 69 C242 72, 248 77, 246 83 C242 89, 216 91, 168 90 C118 89, 82 81, 62 74 Z"
        fill="#f8fafc"
      />
      {/* Dynamic Livery Sweep */}
      <path d="M66 72 C122 70, 188 72, 244 78 L238 84 C184 79, 120 78, 70 77 Z" fill={accentColor} />
      {/* Canopy Glass */}
      <path
        d="M142 63 C162 55, 194 56, 212 67 L146 69 Z"
        fill="#0f172a"
        stroke="#38bdf8"
        strokeWidth="0.9"
      />
      {/* Nose Spinner & Propeller Disc */}
      <path d="M244 73 L256 77 L244 82 Z" fill={accentColor} />
      <ellipse cx="255" cy="77" rx="3.5" ry="22" fill="rgba(226,232,240,0.38)" stroke="#e2e8f0" strokeWidth="0.9" />
      {/* Retractable Tricycle Gear */}
      <line x1="224" y1="88" x2="226" y2="109" stroke="#94a3b8" strokeWidth="2" />
      <circle cx="226" cy="111" r="3.8" fill="#0f172a" stroke="#64748b" strokeWidth="1" />
      <line x1="158" y1="88" x2="155" y2="109" stroke="#94a3b8" strokeWidth="2.2" />
      <circle cx="155" cy="111" r="4.2" fill="#0f172a" stroke="#64748b" strokeWidth="1" />
    </svg>
  );
}

/* =========================================================================
   3. INTERACTIVE 3D EARTH GLOBE CANVAS (MAIN MENU HUB BACKDROP)
   ========================================================================= */

// Simplified continental land polygons [lat, lon][] for crisp, instant offline globe rendering
const CONTINENT_POLYS: [number, number][][] = [
  // North America
  [
    [70, -160], [72, -130], [60, -110], [62, -75], [48, -55], [42, -70], [30, -81], [25, -80],
    [18, -95], [8, -78], [15, -92], [22, -106], [32, -117], [48, -124], [60, -145], [64, -165],
  ],
  // South America
  [
    [11, -75], [10, -62], [4, -51], [-6, -35], [-18, -39], [-24, -46], [-35, -53],
    [-54, -68], [-50, -75], [-33, -71], [-18, -71], [-5, -81], [4, -77],
  ],
  // Europe
  [
    [36, -9], [43, -9], [48, -4], [52, 4], [58, 8], [70, 20], [70, 40],
    [55, 40], [45, 35], [41, 28], [38, 23], [40, 15], [37, 15], [43, 5], [36, -5],
  ],
  // Africa
  [
    [35, -6], [37, 10], [32, 32], [12, 44], [11, 51], [-2, 41], [-15, 40],
    [-26, 33], [-34, 18], [-18, 12], [-5, 12], [4, 9], [5, -8], [15, -17], [28, -13],
  ],
  // Asia
  [
    [35, 36], [42, 45], [55, 60], [70, 80], [72, 130], [65, 170], [52, 140], [38, 122],
    [22, 114], [9, 105], [2, 103], [16, 96], [22, 88], [8, 77], [24, 67], [26, 56], [13, 45],
  ],
  // Indonesia Archipelago (Sumatra, Java, Kalimantan, Sulawesi, Papua)
  [[5.5, 95.3], [1.5, 102.5], [-5.8, 105.8], [-3.2, 100.2]],
  [[-6.0, 106.0], [-6.8, 112.8], [-8.4, 114.5], [-7.8, 109.0]],
  [[4.2, 117.5], [1.0, 118.8], [-3.4, 116.2], [-3.0, 110.2], [1.2, 109.2]],
  [[1.5, 125.0], [-2.0, 121.5], [-5.5, 120.2], [-4.0, 122.8]],
  [[-0.8, 131.2], [-2.5, 140.8], [-8.5, 140.5], [-4.8, 136.0]],
  // Australia
  [
    [-12, 131], [-12, 142], [-20, 149], [-28, 153], [-38, 146],
    [-35, 136], [-32, 125], [-34, 115], [-22, 114], [-15, 124],
  ],
  // Japan & UK
  [[31, 130], [35, 140], [43, 144], [38, 136]],
  [[50, -5], [52, 1], [58, -3], [54, -5]],
];

export function InteractiveEarthGlobe({
  focusLat = -2.5,
  focusLon = 115,
  className = '',
}: {
  focusLat?: number;
  focusLon?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotRef = useRef({ lat: focusLat * (Math.PI / 180), lon: focusLon * (Math.PI / 180), velLon: 0.0012 });
  const dragRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.max(200, Math.round(rect.width * dpr));
      canvas.height = Math.max(200, Math.round(rect.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Pre-sample major airports for zero-allocation render loop
    const majorAirports = AIRPORTS.filter((a) => a.size === 0).slice(0, 320);

    const draw = () => {
      rafId = requestAnimationFrame(draw);
      const W = canvas.width;
      const H = canvas.height;
      if (W < 50 || H < 50) return;

      if (!dragRef.current.active) {
        rotRef.current.lon += rotRef.current.velLon;
      }

      const cx = W * 0.63;
      const cy = H * 0.52;
      const R = Math.min(W * 0.45, H * 0.56);

      ctx.clearRect(0, 0, W, H);

      // 1. Outer atmospheric blue glow in deep space
      const halo = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.18);
      halo.addColorStop(0, 'rgba(30, 90, 210, 0)');
      halo.addColorStop(0.5, 'rgba(45, 135, 255, 0.35)');
      halo.addColorStop(0.76, 'rgba(110, 195, 255, 0.62)');
      halo.addColorStop(1, 'rgba(2, 6, 15, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2);
      ctx.fill();

      // 2. Ocean Sphere Base
      const ocean = ctx.createRadialGradient(cx - R * 0.28, cy - R * 0.25, R * 0.1, cx, cy, R);
      ocean.addColorStop(0, '#1d5fa8');
      ocean.addColorStop(0.55, '#0e366e');
      ocean.addColorStop(0.88, '#071d42');
      ocean.addColorStop(1, '#041026');
      ctx.fillStyle = ocean;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      const lat0 = rotRef.current.lat;
      const lon0 = rotRef.current.lon;
      const sinLat0 = Math.sin(lat0);
      const cosLat0 = Math.cos(lat0);

      // Orthographic projection helper
      const projectOrtho = (latDeg: number, lonDeg: number): [number, number, number] => {
        const phi = latDeg * (Math.PI / 180);
        const lam = lonDeg * (Math.PI / 180) - lon0;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const cosLam = Math.cos(lam);
        const cosC = sinLat0 * sinPhi + cosLat0 * cosPhi * cosLam;
        const x = cx + R * (cosPhi * Math.sin(lam));
        const y = cy - R * (cosLat0 * sinPhi - sinLat0 * cosPhi * cosLam);
        return [x, y, cosC];
      };

      // 3. Subtle Graticule Lines
      ctx.strokeStyle = 'rgba(148, 197, 255, 0.08)';
      ctx.lineWidth = 1;
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let started = false;
        for (let lon = -180; lon <= 180; lon += 10) {
          const [x, y, z] = projectOrtho(lat, lon);
          if (z > 0) {
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
          } else {
            started = false;
          }
        }
        ctx.stroke();
      }

      // 4. Continents & Archipelagos with Coastal Shelf & Biome Relief
      for (let i = 0; i < CONTINENT_POLYS.length; i++) {
        const poly = CONTINENT_POLYS[i];
        ctx.beginPath();
        let visibleCount = 0;
        let sumX = 0;
        let sumY = 0;
        for (let j = 0; j < poly.length; j++) {
          const [x, y, z] = projectOrtho(poly[j][0], poly[j][1]);
          if (z > -0.15) visibleCount++;
          sumX += x;
          sumY += y;
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (visibleCount > 1) {
          ctx.closePath();
          // Coastal turquoise continental shelf glow
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
          ctx.lineWidth = 5;
          ctx.stroke();

          // Biome gradient fill (lush tropical emerald to warm highland olive/ochre)
          const mx = sumX / poly.length;
          const my = sumY / poly.length;
          const biome = ctx.createLinearGradient(mx - R * 0.25, my - R * 0.25, mx + R * 0.25, my + R * 0.25);
          biome.addColorStop(0, '#2d6a4f');
          biome.addColorStop(0.55, '#3a5a40');
          biome.addColorStop(1, '#6c584c');
          ctx.fillStyle = biome;
          ctx.fill();

          ctx.strokeStyle = 'rgba(167, 216, 178, 0.42)';
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }
      }

      // 5. Real Major Airport Nodes on Visible Hemisphere
      ctx.fillStyle = 'rgba(250, 204, 21, 0.78)';
      for (let i = 0; i < majorAirports.length; i++) {
        const a = majorAirports[i];
        const [x, y, z] = projectOrtho(a.lat, a.lon);
        if (z > 0.12) {
          ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        }
      }

      // 6. Soft Organic Atmospheric Cloud Formations
      for (let band = -48; band <= 48; band += 16) {
        for (let lon = -165; lon <= 165; lon += 18) {
          const shift = Math.sin((lon + band * 3) * 0.05) * 9;
          const [x, y, z] = projectOrtho(band + shift, lon + lon0 * 18);
          if (z > 0.12) {
            const puffR = R * (0.075 + ((Math.abs(lon * 7 + band * 13) % 5) * 0.015)) * z;
            const cloudGrad = ctx.createRadialGradient(x, y, puffR * 0.1, x, y, puffR);
            cloudGrad.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
            cloudGrad.addColorStop(0.5, 'rgba(241, 245, 249, 0.11)');
            cloudGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = cloudGrad;
            ctx.beginPath();
            ctx.arc(x, y, puffR, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // 7. Inner Rayleigh Atmospheric Rim Highlight
      const rim = ctx.createRadialGradient(cx - R * 0.15, cy - R * 0.15, R * 0.4, cx, cy, R);
      rim.addColorStop(0, 'rgba(255, 255, 255, 0)');
      rim.addColorStop(0.78, 'rgba(30, 110, 230, 0.15)');
      rim.addColorStop(0.94, 'rgba(85, 175, 255, 0.5)');
      rim.addColorStop(1, 'rgba(180, 228, 255, 0.85)');
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Interactive 3D Earth Globe"
      onPointerDown={(e) => {
        dragRef.current = { active: true, x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!dragRef.current.active) return;
        const dx = e.clientX - dragRef.current.x;
        const dy = e.clientY - dragRef.current.y;
        dragRef.current.x = e.clientX;
        dragRef.current.y = e.clientY;
        rotRef.current.lon -= dx * 0.005;
        rotRef.current.lat = Math.max(-1.1, Math.min(1.1, rotRef.current.lat + dy * 0.005));
      }}
      onPointerUp={() => {
        dragRef.current.active = false;
      }}
      onPointerCancel={() => {
        dragRef.current.active = false;
      }}
      className={`cursor-grab active:cursor-grabbing ${className}`}
    />
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
  const [tailNum, setTailNum] = useState(() => {
    const v = AIRCRAFT_VARIANTS.find((x) => x.variantId === selectedVariantId);
    return v?.tailNumber || 'PK-SKY';
  });
  const [flightNum, setFlightNum] = useState('SKY-104');
  const [fuelPct, setFuelPct] = useState(75);
  const [payloadPct, setPayloadPct] = useState(80);

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
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#2b323c] text-white select-none font-sans overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, #1b2838 0%, #2a3441 42%, #323b47 100%)',
      }}
    >
      {/* Top Banner Header (Matches Images 5 & 6) */}
      <div className="flex items-start justify-between px-6 pt-4 pb-2 shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-white hover:text-sky-300 transition flex items-center"
            aria-label="Back to Free Flight"
          >
            <svg width="32" height="44" viewBox="0 0 32 44" fill="none" aria-hidden="true">
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

      {/* Category Filter Bar (Matches Images 5 & 6) */}
      <div className="px-6 sm:px-12 pt-2 pb-3 grid grid-cols-2 sm:grid-cols-5 gap-2 shrink-0">
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
                  : 'bg-[#19417d]/80 border-white/10 text-slate-200 hover:bg-[#1e4f99]'
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
        <aside className="w-full lg:w-[310px] xl:w-[340px] shrink-0 bg-[#3a4452]/90 border border-white/20 flex flex-col justify-between overflow-y-auto">
          {viewMode === 'gallery' ? (
            /* GALLERY MODE LEFT PANEL: Statistics & Comparison (Matches Image 5) */
            <div className="p-4 space-y-4">
              <div>
                <div className="text-lg font-bold text-white leading-snug">{inspectedVariant.title}</div>
                <div className="text-xs text-slate-300 mt-0.5">{inspectedVariant.maker}</div>
                <div className="text-xs text-slate-300">{inspectedVariant.density}</div>
              </div>

              <div className="border-t border-white/15 pt-2">
                <div className="bg-[#202731] px-3 py-1.5 text-xs font-bold text-white flex items-center justify-between">
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

              <p className="text-xs text-slate-300 leading-relaxed bg-[#242c37] p-3 border border-white/10">
                {inspectedSpec.blurb}
              </p>
            </div>
          ) : (
            /* LIST / CONFIGURE MODE LEFT PANEL: Livery, Identification, Fuel & Payload (Matches Image 6) */
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

                <div
                  className="mt-2 h-28 border border-white/15 relative overflow-hidden flex items-center justify-center p-2"
                  style={{
                    background: 'linear-gradient(160deg, #64748b 0%, #94a3b8 55%, #475569 100%)',
                  }}
                >
                  <AircraftArtworkSvg
                    aircraftId={activeVariant.aircraftId}
                    accentColor={activeVariant.accentColor}
                    bellyColor={activeVariant.bellyColor}
                  />
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

          {/* Bottom Blue Configure Button inside Left Panel (Matches Image 5) */}
          <div className="p-3 pt-0">
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'gallery' ? 'configure' : 'gallery')}
              className="w-full h-20 px-4 py-3 text-left relative overflow-hidden border border-sky-300/40 hover:brightness-110 transition flex flex-col justify-between"
              style={{
                background: 'linear-gradient(135deg, #2572eb 0%, #1d4ed8 100%)',
              }}
            >
              <span className="text-xs font-bold text-white relative z-10">
                {viewMode === 'gallery' ? 'Configure your aircraft' : 'Return to Statistics'}
              </span>
              <span className="text-[11px] text-sky-100/90 relative z-10">
                {viewMode === 'gallery' ? 'Livery · Callsign · Fuel & Mass' : 'Compare performance metrics'}
              </span>
              {/* Subtle nose wireframe graphic on right side */}
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
          {/* Top Search & View Mode Bar (Matches Images 5 & 6) */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0">
            <div className="flex items-center bg-[#1c232d] border border-white/15 px-3 py-1.5 w-full sm:w-80">
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
                    : 'bg-[#323c4a] border-white/10 text-slate-200 hover:bg-[#3d4959]'
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
                    : 'bg-[#323c4a] border-white/10 text-slate-200 hover:bg-[#3d4959]'
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
                    : 'bg-[#323c4a] border-white/10 text-slate-200 hover:bg-[#3d4959]'
                }`}
              >
                <FlightIcon name="list" size={13} />
                <span>List</span>
              </button>
            </div>
          </div>

          {/* GALLERY VIEW (Matches Image 5) */}
          {viewMode === 'gallery' ? (
            <div className="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5 pr-1 content-start">
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
                    className={`text-left flex flex-col border transition relative overflow-hidden group ${
                      isSelected
                        ? 'border-sky-300 shadow-[0_0_25px_rgba(37,114,235,0.45)]'
                        : 'border-white/15 hover:border-white/40'
                    }`}
                  >
                    {/* Upper Studio Render Area */}
                    <div
                      className="h-36 w-full relative flex items-center justify-center p-3"
                      style={{
                        background:
                          'linear-gradient(170deg, #5b697c 0%, #8392a7 52%, #475569 100%)',
                      }}
                    >
                      <AircraftArtworkSvg
                        aircraftId={v.aircraftId}
                        accentColor={v.accentColor}
                        bellyColor={v.bellyColor}
                        className="w-full h-full group-hover:scale-105 transition-transform duration-200"
                      />
                      <span className="absolute bottom-1.5 right-2 text-[9px] font-mono font-bold tracking-wider uppercase px-1.5 py-0.5 bg-slate-950/65 text-slate-200">
                        {v.maker}
                      </span>
                    </div>

                    {/* Lower Info Area (Matches Image 5 blue selected card) */}
                    <div
                      className={`p-3.5 flex-1 flex flex-col justify-between relative ${
                        isSelected ? 'bg-[#2572eb] text-white' : 'bg-[#3c4d63] text-slate-100 group-hover:bg-[#465973]'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-sm leading-snug">{v.title}</div>
                        <div className={`text-xs mt-0.5 ${isSelected ? 'text-sky-100' : 'text-slate-300'}`}>
                          {v.variantLabel} · {v.tailNumber}
                        </div>
                      </div>
                      <div className={`mt-3 pt-2 border-t text-[11px] font-mono flex items-center justify-between ${
                        isSelected ? 'border-white/20 text-sky-100' : 'border-white/10 text-slate-300'
                      }`}>
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
          ) : (
            /* LIST VIEW (Matches Image 6) */
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

      {/* Bottom Bar (Matches Images 5 & 6: Save and Back + Help) */}
      <div className="px-6 sm:px-12 py-3 flex items-center justify-between shrink-0 bg-[#1a2029]/90 border-t border-white/10">
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 bg-[#161c24] hover:bg-[#2572eb] border border-white/20 text-xs font-bold text-white transition"
        >
          Save and Back
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode(viewMode === 'gallery' ? 'list' : 'gallery')}
            className="px-4 py-2 bg-[#161c24] hover:bg-white/10 border border-white/15 text-xs font-bold text-slate-200 transition"
          >
            {viewMode === 'gallery' ? 'Switch to List' : 'Switch to Gallery'}
          </button>
        </div>
      </div>
    </div>
  );
}
