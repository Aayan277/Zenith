// Formatting + status helpers for the launches feature.
import { fmtLocal, tzLabel } from '../util/time.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const p2 = n => String(n).padStart(2, '0');

export const STATUS = {
  go:      { label: 'Go',         color: '#5ce1a5' },
  tbc:     { label: 'TBC',        color: '#ffd166' },
  tbd:     { label: 'TBD',        color: '#8da2c8' },
  hold:    { label: 'Hold',       color: '#ff9f5c' },
  flight:  { label: 'In flight',  color: '#5ce1ff' },
  success: { label: 'Success',    color: '#5ce1a5' },
  failure: { label: 'Failure',    color: '#ff5c7a' },
};
export const statusOf = l => STATUS[l.status?.key] || STATUS.tbd;

/** True when the launch has a trustworthy time of day (not just a date / month placeholder). */
export const hasClock = l => ['SEC', 'MIN', 'HR'].includes(l.precision);
export const precisionNote = l => ({ SEC: '', MIN: '', HR: 'time approximate', DAY: 'date only, time TBD', WEEK: 'week only', MONTH: 'month only', QRTR: 'quarter only', HALF: 'half-year only', YEAR: 'year only', DEC: 'decade only' }[l.precision] || '');
export const isDone = l => l.status?.key === 'success' || l.status?.key === 'failure';

/** Parts of a countdown: { sign: -1 before T-0, +1 after, d, h, m, s }. */
export function parts(deltaMs) {
  const sign = deltaMs >= 0 ? -1 : 1;           // delta = net - now; positive means still in the future
  let s = Math.floor(Math.abs(deltaMs) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return { sign, d, h, m, s };
}
/** "2d 4h" / "4h 12m" / "12m 05s" for compact rows and the globe label. */
export function short(deltaMs) {
  const { d, h, m, s } = parts(deltaMs);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${p2(m)}m`;
  return `${m}m ${p2(s)}s`;
}
/** "T−2d 04h 12m" / "T−03:12:44" / "T+00:41". */
export function tminus(deltaMs) {
  const { sign, d, h, m, s } = parts(deltaMs);
  const pre = sign < 0 ? 'T−' : 'T+';
  if (d >= 1) return `${pre}${d}d ${p2(h)}h ${p2(m)}m`;
  return `${pre}${p2(h)}:${p2(m)}:${p2(s)}`;
}

const DAY = { weekday: 'short', day: 'numeric', month: 'short' };
const TIME = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
export const fmtDay = ms => fmtLocal(ms, DAY);
export const fmtClock = ms => fmtLocal(ms, TIME);
export const fmtLocalFull = ms => `${fmtLocal(ms, { ...DAY, ...TIME })} ${tzLabel(ms)}`;
export const fmtUtc = (ms, withDay = true) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...(withDay ? { day: 'numeric', month: 'short' } : {}), ...TIME }).format(ms) + ' UTC';
export const fmtAgo = ms => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

export const ICON = {
  rocket: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c3 2 4.5 5.2 4.5 9v3.5h-9V11.5c0-3.8 1.500-7 4.500-9z"/><circle cx="12" cy="9.500" r="1.600"/><path d="M7.500 13.500L5 16.500v2.500l2.500-1.500M16.500 13.500l2.500 3v2.500l-2.500-1.500M10 18.500l2 3 2-3"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.500V11a6 6 0 1112 0v5.500l1.500 2h-15z"/><path d="M10 21h4"/></svg>',
  bellOn: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.500V11a6 6 0 1112 0v5.500l1.500 2h-15z"/><path d="M10 21h4" fill="none"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.500v13l11-6.500z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.200 7-12a7 7 0 10-14 0c0 5.800 7 12 7 12z"/><circle cx="12" cy="10" r="2.500"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 10-2.300 6.300M20 4v7h-7"/></svg>',
};
