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
  chevronLeft: 'm15 19-7-7 7-7',
  down: 'm6 9 6 6 6-6',
  up: 'm6 15 6-6 6 6',
  arrow: 'M12 20V4m-6 6 6-6 6 6',
  arrowRight: 'M4 12h16m-6-6 6 6-6 6',
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
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  swap: 'M7 16V4m0 0L3 8m4-4 4 4m6 0v12m0 0 4-4m-4 4-4-4',
  swapHoriz: 'M4 9h16m0 0-4-4m4 4-4 4M20 15H4m0 0 4 4m-4-4 4-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-2.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9c0 .7.4 1.3 1.1 1.5H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  trophy: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6m12 5h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16m-10-7.34V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22m7-7.34V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z',
  keyboard: 'M2 6h20v12H2V6Zm4 4h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14h.01M11 12h1v4h1',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z',
  cloud: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-14v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  sunset: 'M12 10V2m-4.93 7.07 1.41 1.41M2 18h20M4 22h16m-1.66-11.52 1.41-1.41M16 18a4 4 0 0 0-8 0',
  heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7 7-7Z',
  star: 'm12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z',
  grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM14 14h7v7h-7v-7ZM3 14h7v7H3v-7Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  sliders: 'M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 13a1.94 1.94 0 0 0 3.4 0',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm4.24-14.24-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12Z',
} as const;
export type FlightIconName = keyof typeof paths;

export function FlightIcon({ name, size = 20, className = '', style }: {
  name: FlightIconName; size?: number; className?: string; style?: CSSProperties;
}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    className={className} style={style}><path d={paths[name]} /></svg>;
}
