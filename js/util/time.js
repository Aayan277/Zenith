// Observer-local time formatting. Everything user-facing about "tonight" or
// "your sky" must be shown in the OBSERVER's time zone, not the browser's.
//
// state.location.tz is an IANA zone (e.g. 'America/New_York') when known
// (from city search or the weather API). If missing, we fall back to a
// longitude-based offset (lon/15 hours), labelled like "UTC−5".
import { get, patch } from '../state.js';

function validZone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** Format ms in the observer's zone. opts = Intl.DateTimeFormat options. */
export function fmtLocal(ms, opts = { hour: '2-digit', minute: '2-digit' }, loc = get('location')) {
  if (validZone(loc?.tz)) {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: loc.tz }).format(ms);
  }
  const offH = Math.round((loc?.lon ?? 0) / 15);
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(ms + offH * 3600e3);
}

/** Short zone label for display, e.g. "EST", "GMT", "CET", or "UTC+5". */
export function tzLabel(ms = Date.now(), loc = get('location')) {
  if (validZone(loc?.tz)) {
    for (const locale of [undefined, 'en-US', 'en-GB']) {
      const part = new Intl.DateTimeFormat(locale, { timeZone: loc.tz, timeZoneName: 'short' })
        .formatToParts(ms).find(p => p.type === 'timeZoneName')?.value;
      if (part && !/^GMT[+-]/.test(part)) return part;
    }
    const off = tzOffsetMinutes(ms, loc);
    return off === 0 ? 'UTC' : `UTC${off > 0 ? '+' : '−'}${fmtOff(Math.abs(off))}`;
  }
  const offH = Math.round((loc?.lon ?? 0) / 15);
  return offH === 0 ? 'UTC' : `UTC${offH > 0 ? '+' : '−'}${Math.abs(offH)}`;
}

/** Observer's UTC offset in minutes at time ms (positive = east). */
export function tzOffsetMinutes(ms = Date.now(), loc = get('location')) {
  if (!validZone(loc?.tz)) return Math.round((loc?.lon ?? 0) / 15) * 60;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: loc.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

function fmtOff(min) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`; }

/** Set the observer's zone if it is not known yet (e.g. from a weather API response). */
export function learnZone(tz) {
  const loc = get('location');
  if (validZone(tz) && loc.tz !== tz) patch('location', { tz });
}
