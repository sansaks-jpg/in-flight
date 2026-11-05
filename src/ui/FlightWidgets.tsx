import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Airport } from '../data/airports';
import { FlightIcon, type FlightIconName } from './FlightIcon';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: FlightIconName; label: string; active?: boolean };

/** Mouse clicks return control to the aircraft; keyboard focus stays visible and usable. */
export function IconButton({ icon, label, active, className = '', onClick, ...props }: ButtonProps) {
  return <button type="button" className={`flight-icon-button ${className}`} aria-label={label} title={label}
    aria-pressed={active} data-active={active} {...props} onClick={(e) => {
      onClick?.(e);
      if (e.detail > 0) e.currentTarget.blur();
    }}><FlightIcon name={icon} size={17} /></button>;
}

export function PanelHeader({ id, icon, title, subtitle, children, onClose, onRestore }: {
  id: string; icon: FlightIconName; title: string; subtitle?: string; children?: ReactNode; onClose: () => void; onRestore?: () => void;
}) {
  return <header className="flight-panel-header">
    <span className="flight-panel-symbol"><FlightIcon name={icon} size={17} /></span>
    <div className="flight-panel-heading"><h2 id={id}>{onRestore ? <button className="flight-restore-title" onClick={onRestore} aria-label={`Open ${title.toLowerCase()}`}>{title}<span>Click to restore</span></button> : title}</h2>{subtitle && <span title={subtitle}>{subtitle}</span>}</div>
    <div className="flight-panel-actions">{children}<IconButton icon="close" label={`Close ${title.toLowerCase()}`} onClick={onClose} /></div>
  </header>;
}

export function Readout({ label, value, unit, className = '', title }: {
  label: string; value: ReactNode; unit?: string; className?: string; title?: string;
}) {
  return <div className={`flight-readout ${className}`} title={title}>
    <span className="flight-eyebrow">{label}</span>
    <div><strong>{value}</strong>{unit && <span className="flight-unit">{unit}</span>}</div>
  </div>;
}

export function FlightToggle({ label, description, checked, onChange }: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return <label className="flight-toggle-row"><span>{label}{description && <small>{description}</small>}</span>
    <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="flight-toggle-track" aria-hidden="true"><span /></span>
  </label>;
}

/** A real choice list replaces cycling through unseen runway options. */
export function RunwaySelect({ airport, value, onChange }: { airport: Airport; value: string; onChange: (ident: string) => void }) {
  const id = useId();
  const runways = [...new Set(airport.runways.flatMap((runway) => [runway.le, runway.he]))].filter(Boolean);
  return <label className="flight-runway-select" htmlFor={id}><span>Arrival runway<small>{airport.icao}</small></span>
    <select id={id} aria-label="Arrival runway" value={runways.includes(value) ? value : ''} disabled={!runways.length} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>Automatic</option>{runways.map((runway) => <option key={runway} value={runway}>Runway {runway}</option>)}
    </select>
  </label>;
}
