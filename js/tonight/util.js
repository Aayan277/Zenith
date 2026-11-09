// Shared helpers for the Tonight panel: time formatting in the observer's zone, compass, DOM.
export const $ = (sel, root = document) => root.querySelector(sel);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Fallback IANA-ish zone from longitude when the weather API has not told us yet. */
export function fallbackZone(lon) {
  const h = Math.round(lon / 15);
  if (h === 0) return 'UTC';
  return `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`; // Etc/GMT-5 means UTC+5
}
const fmtCache = new Map();
function dtf(tz, opts, key) {
  const k = tz + '|' + key;
  let f = fmtCache.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }); }
    catch { f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }); }
    fmtCache.set(k, f);
  }
  return f;
}
export const fmtTime = (ms, tz) => ms == null ? '—' : dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 't').format(ms);
export const fmtDay = (ms, tz) => dtf(tz, { weekday: 'short', day: 'numeric', month: 'short' }, 'd').format(ms);
export function zoneAbbr(ms, tz) {
  let f = fmtCache.get(tz + '|abbr');
  if (!f) { try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }); } catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', timeZoneName: 'short' }); } fmtCache.set(tz + '|abbr', f); }
  const parts = f.formatToParts(ms);
  return parts.find(p => p.type === 'timeZoneName')?.value || tz;
}
/** Local calendar-day key (YYYY-MM-DD) in zone. */
export const dayKey = (ms, tz) => dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'k').format(ms);
/** Local hour 0-23 */
export const localHour = (ms, tz) => +dtf(tz, { hour: 'numeric', hourCycle: 'h23' }, 'h').format(ms);

export function relDay(ms, nowMs, tz) {
  const a = dayKey(ms, tz), b = dayKey(nowMs, tz);
  if (a === b) return 'Today';
  if (a === dayKey(nowMs + 86400000, tz)) return 'Tomorrow';
  return fmtDay(ms, tz);
}

/** "2h 14m", "5m 03s", "now" */
export function countdown(deltaMs) {
  if (deltaMs <= 0) return 'now';
  const s = Math.floor(deltaMs / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m >= 10) return `${m}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}
export function dur(ms) {
  const s = Math.round(ms / 1000), m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

const PTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = az => PTS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

/** Brightness: 1-5 dots from apparent magnitude. */
export function magDots(mag) {
  const n = mag == null ? 1 : mag <= -3.5 ? 5 : mag <= -2.5 ? 4 : mag <= -1.5 ? 3 : mag <= -0.5 ? 2 : 1;
  const label = mag == null ? '' : mag <= -3 ? 'Brilliant' : mag <= -1.5 ? 'Very bright' : mag <= 0 ? 'Bright' : mag <= 2 ? 'Moderate' : 'Faint';
  let h = '<span class="tn-dots" title="' + label + (mag != null ? ` (mag ${mag.toFixed(1)})` : '') + '">';
  for (let i = 0; i < 5; i++) h += `<i${i < n ? ' class="on"' : ''}></i>`;
  return h + '</span>';
}
export const magLabel = mag => mag == null ? '' : mag <= -3 ? 'Brilliant' : mag <= -1.5 ? 'Very bright' : mag <= 0 ? 'Bright' : mag <= 2 ? 'Moderate' : 'Faint';

export function skeleton(lines = 3) {
  return Array.from({ length: lines }, (_, i) => `<div class="tn-skel" style="width:${90 - i * 18}%"></div>`).join('');
}

/** Polar sky arc SVG of a pass: centre = zenith, rim = horizon, N up. */
export function polarSvg(track, size = 84) {
  const c = size / 2, R = c - 6;
  const pt = ([az, el]) => { const r = R * (1 - el / 90), a = az * Math.PI / 180; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
  const pts = (track || []).map(pt);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const end = pts[pts.length - 1], start = pts[0];
  return `<svg class="tn-polar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${R}" class="rim"/><circle cx="${c}" cy="${c}" r="${R * 2 / 3}" class="grid"/><circle cx="${c}" cy="${c}" r="${R / 3}" class="grid"/>
    <path d="M${c} ${c - R}V${c + R}M${c - R} ${c}H${c + R}" class="grid"/>
    <text x="${c}" y="9" class="lbl" text-anchor="middle">N</text>
    ${d ? `<path d="${d}" class="arc"/><circle cx="${start[0]}" cy="${start[1]}" r="2.2" class="st"/><circle cx="${end[0]}" cy="${end[1]}" r="3" class="en"/>` : ''}
  </svg>`;
}
