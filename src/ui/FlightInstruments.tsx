import { formatUtc } from '../sim/clock';
import { useEffect, useId, useRef, useState } from 'react';
import type { Game, HudState } from '../sim/game';
import { clamp } from '../sim/geo';
import { flightUnits, formatAltitude, formatNumber, formatSpeed, formatVerticalSpeed, formatHeading } from './navigation';

function FlightTape({ label, value, unit, step, pixels, target }: { label: string; value: number; unit: string; step: number; pixels: number; target?: number }) {
  const base = Math.floor(value / step) * step;
  return <div className="flight-pfd-tape" aria-label={`${label} ${Math.round(value)} ${unit}`}><span>{label} · {unit}</span><svg viewBox="0 0 70 142" role="img" aria-label={`${label} tape`}>
    <rect width="70" height="142" fill="#13202ded" />
    {Array.from({ length: 11 }, (_, index) => { const tick = base + (index - 5) * step, y = 71 - (tick - value) * pixels; return tick >= 0 ? <g key={tick}><path d={`M55 ${y}h15`} stroke="#c8d6e0" /><text x="49" y={y + 4} textAnchor="end" fill="#e0e8ed" fontSize="11">{tick}</text></g> : null; })}
    {target !== undefined && <path d={`M58 ${clamp(71 - (target - value) * pixels, 6, 136) - 5}h12v10H58l-5 -5Z`} fill="#e5a1e7" />}
    <rect x="1" y="57" width="67" height="28" fill="#07121d" stroke="#e8dda9" /><text x="34" y="77" textAnchor="middle" fill="#f2f4ed" fontSize="18" fontWeight="600">{Math.round(value)}</text>
  </svg></div>;
}
/** External glass instruments for the Standard / Assisted layouts. */
export function PrimaryFlightDisplay({ hud, metric = false, assisted = false }: { hud: HudState; metric?: boolean; assisted?: boolean }) {
  const clip = useId().replace(/:/g, '');
  const units = metric ? 'metric' : 'aviation', labels = flightUnits(units);
  const approach = hud.flightPhase === 'final' || hud.flightPhase === 'descent' || hud.ap.appr;
  const ils = approach && hud.ils?.valid ? hud.ils : null;
  const vertical = Math.abs(hud.vsFpm) >= 50;
  return <section className="flight-pfd" aria-label="Primary flight display" data-flight-ui data-approach={approach} data-assisted={assisted}>
    <header><span data-active={hud.ap.on}>{hud.ap.on ? `AP · ${hud.ap.appr ? 'LOC' : hud.ap.nav ? 'LNAV' : 'HDG'}` : 'MANUAL'}</span>
      <span>{hud.ap.on ? hud.ap.appr ? hud.ap.gsCaptured ? 'GS CAPTURED' : 'GS ARMED' : `ALT ${formatAltitude(hud.ap.alt, units)} ${labels.altitude}` : 'FLIGHT DATA'}</span></header>
    <div className="flight-pfd-core">
      <FlightTape label="IAS" value={hud.kias * (metric ? 1.852 : 1)} unit={labels.speed} step={metric ? 20 : 10} pixels={metric ? 1.1 : 2} target={hud.ap.on ? hud.ap.spd * (metric ? 1.852 : 1) : undefined} />
      <div className="flight-pfd-attitude">
        <svg viewBox="0 0 164 102" role="img" aria-label={`Attitude, pitch ${formatNumber(hud.pitch)} degrees, bank ${formatNumber(hud.bank)} degrees`}>
          <defs><clipPath id={clip}><rect width="164" height="102" rx="3" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <g transform={`translate(82 51) rotate(${-hud.bank}) translate(0 ${clamp(hud.pitch, -60, 60) * 2})`}>
              <rect x="-350" y="-350" width="700" height="350" fill="#48778e" />
              <rect x="-350" y="0" width="700" height="350" fill="#665140" />
              <path d="M-350 0H350" stroke="#ecf4f2" strokeWidth="1.5" />
              {[-30, -20, -10, 10, 20, 30].map((pitch) => <g key={pitch} transform={`translate(0 ${-pitch * 2})`}>
                <path d={`M-22 0H-7M7 0H22`} stroke="#eef5f5" strokeWidth="1" />
                <text x="28" y="3" fill="#eef5f5" fontSize="8">{Math.abs(pitch)}</text>
              </g>)}
            </g>
          </g>
          <path d="M49 52H67L73 57M115 52H97L91 57M79 53H85M82 5l-4 6h8Z" fill="none" stroke="#ffdc87" strokeWidth="2" />
          {hud.ap.on && hud.pitchTarget !== null && <path d="M49 50H115M82 27V75" fill="none" stroke="#e7a0e5" strokeWidth="2" transform={`translate(0 ${clamp((hud.pitch - (hud.pitchTarget ?? 0)) * 2, -25, 25)})`} />}
          {ils && <g aria-label={`Glideslope deviation ${formatNumber(ils.gsDots, 1)} dots`}>
            <path d="M153 27V75M150 27h6M150 39h6M150 63h6M150 75h6" stroke="#e6edef" fill="none" />
            <path d={`M148 ${51 - clamp(ils.gsDots, -2.5, 2.5) * 10}l5 -4 5 4 -5 4Z`} fill="#efa5e9" />
          </g>}
        </svg>
        {ils && <svg className="flight-pfd-localizer" viewBox="0 0 164 14" role="img" aria-label={`Localizer deviation ${formatNumber(ils.locDots, 1)} dots`}>
          <path d="M38 7H126M38 4v6M60 4v6M82 3v8M104 4v6M126 4v6" stroke="#b8c5ce" fill="none" />
          <path d={`M${82 + clamp(ils.locDots, -2.5, 2.5) * 18} 2l5 5 -5 5 -5 -5Z`} fill="#efa5e9" />
        </svg>}
      </div>
      <div className="flight-pfd-altitude"><FlightTape label="ALT" value={hud.altFt * (metric ? .3048 : 1)} unit={labels.altitude} step={metric ? 50 : 100} pixels={metric ? .6 : .18} target={hud.ap.on ? hud.ap.alt * (metric ? .3048 : 1) : undefined} />{vertical && <span className="flight-pfd-vertical">VS {formatVerticalSpeed(hud.vsFpm, units)} {labels.verticalSpeed}</span>}</div>
    </div>
    <div className="flight-pfd-compass"><span>HDG <b>{formatHeading(hud.hdg)}</b></span><span>TRK {formatHeading(hud.track)}</span><span>{hud.activeWp?.name ?? hud.destId}</span></div>
    <footer><span>{hud.aglFt < 2500 || approach ? <>RA <b>{formatAltitude(hud.aglFt, units)}</b> {labels.altitude}</> : <>GS <b>{formatSpeed(hud.gsKt, units)}</b> {labels.speed}</>}</span>
      <span title={approach ? `Arrival runway at ${hud.destId}; independent of the next flight-plan fix` : 'Real-world UTC time (simulation runs 1:1)'}>{approach ? `ARR ${hud.destId} ${hud.apprRwy || '—'}` : `${formatUtc(hud.utcMs, false)}Z`}</span></footer>
    {approach && <div className="flight-pfd-ils"><span>{ils ? `ILS ${ils.ident}` : 'ILS · NO SIGNAL'}</span><span>{ils ? `LOC ${formatNumber(ils.locDots, 1)} · GS ${formatNumber(ils.gsDots, 1)}` : 'Use visual / published guidance'}</span></div>}
  </section>;
}


const Btn = ({
  children,
  on,
  onClick,
  className = '',
  title,
}: {
  children: React.ReactNode;
  on?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
}) => (
  <button
    title={title}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={onClick}
    className={`px-3 py-1.5 rounded-xl text-xs font-bold border backdrop-blur-md transition active:scale-95 ${
      on
        ? 'bg-cyan-400 text-slate-950 border-cyan-300 shadow-[0_0_15px_rgba(34,211,238,0.4)]'
        : 'bg-slate-950/70 text-slate-200 border-white/15 hover:bg-slate-900/90 hover:border-white/30'
    } ${className}`}
  >
    {children}
  </button>
);

function Hold({
  onDown,
  onUp,
  children,
  className = '',
}: {
  onDown: () => void;
  onUp: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
      className={`select-none touch-none rounded-xl bg-slate-950/75 border border-white/20 text-white font-bold backdrop-blur-md active:bg-cyan-500/40 active:border-cyan-400 ${className}`}
    >
      {children}
    </button>
  );
}


export function TouchControls({ game, hud }: { game: Game; hud: HudState }) {
  const stickRef = useRef<HTMLDivElement>(null),
    thrRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  useEffect(() => () => { game.touch.pitch = game.touch.roll = game.touch.yaw = 0; game.touch.brake = false; }, [game]);

  const stick = (e: React.PointerEvent, down = false) => {
    if (down) e.currentTarget.setPointerCapture(e.pointerId);
    else if (!(e.buttons & 1) && e.pointerType === 'mouse') return;
    if (!down && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = stickRef.current!.getBoundingClientRect(),
      R = r.width / 2;
    let dx = (e.clientX - r.left - R) / R,
      dy = (e.clientY - r.top - R) / R;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
    game.touch.roll = dz(dx);
    game.touch.pitch = dz(dy);
    setKnob({ x: dx, y: dy });
  };

  const release = () => {
    game.touch.roll = 0;
    game.touch.pitch = 0;
    setKnob({ x: 0, y: 0 });
  };

  const thr = (e: React.PointerEvent, down = false) => {
    if (down) e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = thrRef.current!.getBoundingClientRect();
    game.fm.ctl.throttle = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
  };

  return (
    <div className="flight-touch-controls absolute inset-0 pointer-events-none" data-flight-ui>
      <div data-touch-left className="absolute left-2 sm:left-3 bottom-3 sm:bottom-4 flex items-end gap-2.5 sm:gap-3 z-20 pointer-events-auto">
        <div
          ref={thrRef}
          onPointerDown={(e) => {
            e.stopPropagation();
            thr(e, true);
          }}
          onPointerMove={thr}
          className="flight-touch-throttle relative w-14 h-44 rounded-xl bg-slate-950/80 border border-white/25 backdrop-blur-md touch-none overflow-hidden"
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-[#9abed7]/50"
            style={{ height: `${hud.throttle * 100}%` }}
          />
          <div className="absolute inset-x-0 text-center text-[10px] font-bold top-1 text-white/80">THR</div>
          <div className="absolute inset-x-0 text-center text-xs font-black bottom-1 text-white">
            {Math.round(hud.throttle * 100)}%
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Hold className="w-14 h-14 text-lg" onDown={() => (game.touch.yaw = -1)} onUp={() => (game.touch.yaw = 0)}>
            ◀
          </Hold>
          <Hold className="w-14 h-14 text-lg" onDown={() => (game.touch.yaw = 1)} onUp={() => (game.touch.yaw = 0)}>
            ▶
          </Hold>
        </div>
      </div>
      <div data-touch-right className="absolute right-2 sm:right-3 bottom-3 sm:bottom-4 z-20 flex flex-col items-end gap-2.5 sm:gap-3 pointer-events-auto">
        <div className="grid grid-cols-3 gap-1.5">
          <Btn on={hud.gearDown} onClick={() => game.action('gear')} className="!py-2.5">
            GEAR
          </Btn>
          <Btn onClick={() => game.action('flaps-')} className="!py-2.5">
            FLAP −
          </Btn>
          <Btn onClick={() => game.action('flaps+')} className="!py-2.5">
            FLAP +
          </Btn>
          <Btn on={hud.ap.on} onClick={() => game.action('ap')} className="!py-2.5">
            AP
          </Btn>
          <Btn on={hud.parking} onClick={() => game.action('park')} className="!py-2.5">
            PARK
          </Btn>
          <Hold
            className="!py-2.5 text-[11px]"
            onDown={() => (game.touch.brake = true)}
            onUp={() => (game.touch.brake = false)}
          >
            BRAKE
          </Hold>
        </div>
        <div
          ref={stickRef}
          onPointerDown={(e) => {
            e.stopPropagation();
            stick(e, true);
          }}
          onPointerMove={stick}
          onPointerUp={release}
          onPointerCancel={release}
          className="flight-touch-stick relative w-36 h-36 rounded-full bg-slate-950/70 border-2 border-white/25 backdrop-blur-md touch-none"
        >
          <div
            className="absolute inset-0 rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(255,255,255,.12), transparent 70%)' }}
          />
          <div
            className="flight-touch-knob absolute left-1/2 top-1/2 w-14 h-14 -ml-7 -mt-7 rounded-full bg-[#b5ccde]/70 border border-white/70 shadow-lg"
            style={{ transform: `translate(calc(${knob.x} * var(--flight-stick-travel, 32px)), calc(${knob.y} * var(--flight-stick-travel, 32px)))` }}
          />
          <div className="absolute inset-x-0 top-1 text-center text-[9px] text-white/60 font-bold">PITCH / ROLL</div>
        </div>
      </div>
    </div>
  );
}

