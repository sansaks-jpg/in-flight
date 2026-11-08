import './kit.css';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { FlightIcon, type FlightIconName } from './FlightIcon';

/** Shared primitives of the in-game UI language (see kit.css). Every pause / settings / reference surface is built from these. */

export function Dialog({ title, subtitle, icon, onClose, size = 'sm', layer, footer, children }: {
  title: string; subtitle?: string; icon?: FlightIconName; onClose: () => void; size?: 'sm' | 'md' | 'lg'; layer?: 'over';
  footer?: ReactNode; children: ReactNode;
}) {
  const id = useId(), ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    // The dialog owns Escape while it is open (the sim would otherwise resume underneath it) and returns focus afterwards.
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); prev?.focus?.({ preventScroll: true }); };
  }, []);
  return (
    <div className="if-scrim" data-layer={layer} onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="if-dialog" data-size={size} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onPointerDown={(e) => e.stopPropagation()}>
        <header className="if-dialog-head">
          {icon && <span className="if-dialog-icon"><FlightIcon name={icon} size={17} /></span>}
          <div style={{ flex: 1, minWidth: 0 }}><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button type="button" className="if-btn if-btn-icon" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} title="Close (Esc)"><FlightIcon name="close" size={16} /></button>
        </header>
        <div className="if-dialog-body">{children}</div>
        {footer && <footer className="if-dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; icon?: FlightIconName; kbd?: string; grow?: boolean };
export function Button({ variant, icon, kbd, grow, className = '', children, ...rest }: BtnProps) {
  return <button type="button" data-variant={variant} className={`if-btn ${grow ? 'if-btn-grow' : ''} ${className}`} {...rest}>
    {icon && <FlightIcon name={icon} size={16} />}{children}{kbd && <kbd>{kbd}</kbd>}
  </button>;
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="if-section">{title && <h4 className="if-eyebrow">{title}</h4>}<div className="if-card">{children}</div></section>;
}

export function Row({ label, hint, disabled, children }: { label: string; hint?: string; disabled?: boolean; children: ReactNode }) {
  return <div className="if-row" data-disabled={disabled || undefined}>
    <div className="if-row-text"><span className="if-row-label">{label}</span>{hint && <span className="if-row-hint">{hint}</span>}</div>
    <div className="if-row-control">{children}</div>
  </div>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="if-switch" onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string | number>({ value, options, onChange, label, block, disabled }: {
  value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string; block?: boolean; disabled?: boolean;
}) {
  return <div className="if-seg" role="radiogroup" aria-label={label} data-block={block} onKeyDown={(e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = options.findIndex(([v]) => v === value), n = options[(i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
    // React clears `currentTarget` once the handler returns, so capture the element first.
    const root = e.currentTarget;
    e.preventDefault(); onChange(n[0]);
    requestAnimationFrame(() => (root.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus());
  }}>
    {options.map(([v, text]) => <button key={String(v)} type="button" role="radio" aria-checked={v === value} tabIndex={v === value ? 0 : -1} disabled={disabled} onClick={() => onChange(v)}>{text}</button>)}
  </div>;
}

export function Slider({ value, min, max, step, onChange, label, format }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return <><input type="range" className="if-range" aria-label={label} min={min} max={max} step={step} value={value} style={{ '--p': `${pct}%` } as CSSProperties} onChange={(e) => onChange(+e.target.value)} />
    <span className="if-range-value">{format ? format(value) : value}</span></>;
}

export function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return <select className="if-select" aria-label={label} value={value} onChange={(e) => {
    const hit = options.find(([v]) => String(v) === e.target.value); if (hit) onChange(hit[0]);
  }}>{options.map(([v, text]) => <option key={String(v)} value={v}>{text}</option>)}</select>;
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="if-kbd">{children}</kbd>;
