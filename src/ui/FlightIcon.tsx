import type { CSSProperties } from 'react';

const paths = {
  plane: 'm12 3 2 7 7 4v2l-7-2-1 5 3 2H8l3-2-1-5-7 2v-2l7-4 2-7Z',
  map: 'm3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16',
  route: 'M7 5h10M7 12h7M7 19h10M3 5h.01M3 12h.01M3 19h.01m14-10 3 3-3 3',
  autopilot: 'M12 3v4m0 10v4M3 12h4m10 0h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm-2 7 2-5 2 5m-3-2h2',
  radio: 'M8 21h8m-4-4v4m-4-9a4 4 0 0 0 8 0V7a4 4 0 0 0-8 0v5ZM5 10v2a7 7 0 0 0 14 0v-2',
  camera: 'M8 5 6 8H3v12h18V8h-3l-2-3H8Zm4 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  display: 'M3 4h18v13H3V4Zm5 17h8m-4-4v4M7 8h4m-4 4h7m3-4h.01',
  volume: 'm11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  muted: 'm11 4-6 5H2v6h3l6 5V4Zm5 5 5 6m0-6-5 6',
  pause: 'M8 5v14M16 5v14',
  play: 'm8 4 12 8-12 8V4Z',
  close: 'm6 6 12 12M6 18 18 6',
  minus: 'M5 12h14',
  plus: 'M5 12h14m-7-7v14',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6',
  target: 'M12 2v4m0 12v4M2 12h4m12 0h4M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  chevron: 'm8 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  up: 'm6 15 6-6 6 6',
  arrow: 'M12 20V4m-6 6 6-6 6 6',
  turnRight: 'M6 20V9h14m-5-5 5 5-5 5',
  turnLeft: 'M18 20V9H4m5-5-5 5 5 5',
  check: 'm5 12 4 4L19 6',
  wind: 'M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h5a3 3 0 1 1-3 3',
  alert: 'm12 3 10 18H2L12 3Zm0 6v5m0 3h.01',
  pin: 'm8 3 8 0-1 6 4 4H5l4-4-1-6Zm4 10v8',
  reset: 'M4 10a8 8 0 1 1 1 8M4 4v6h6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  layers: 'm12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01',
  fuel: 'M4 21V4h10v17M2 21h14M4 9h10m0 4h2v4a2 2 0 0 0 4 0V8l-3-3m2 2v4h2',
} as const;
export type FlightIconName = keyof typeof paths;

export function FlightIcon({ name, size = 20, className = '', style }: {
  name: FlightIconName; size?: number; className?: string; style?: CSSProperties;
}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    className={className} style={style}><path d={paths[name]} /></svg>;
}
