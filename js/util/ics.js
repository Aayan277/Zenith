// Calendar export: RFC 5545 (.ics) builder + Google Calendar template link. Dependency-free (no state import).
//
// An "event spec" is { key?, title, start (ms), end? (ms), allDay?, description?, location?, url? }.
//  - key    stable string used to derive the UID (so re-importing the same event updates it instead of duplicating)
//  - end    defaults to start + 1 h (or start + 1 day for all-day events)
//  - url    defaults to the site URL; callers may pass a share link
// Every VEVENT carries a VALARM that fires 15 minutes before it starts (all-day events: 09:00 the day before is
// not used; the alarm is simply 15 minutes before 00:00 local, which calendars display as the evening before).

export const SITE_URL = 'https://aayan277.github.io/Zenith/';
export const ALARM_MIN = 15;

const enc = new TextEncoder();

/** Escape a TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma, newlines. */
export function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold one content line so no physical line exceeds 75 octets (UTF-8 aware; continuation lines start with one space). */
export function foldLine(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {                       // iterates by code point: never splits a surrogate pair
    const n = enc.encode(ch).length;
    if (bytes + n > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

const p2 = n => String(n).padStart(2, '0');
/** 20270806T031500Z */
export function icsUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}
/** 20270806 (UTC calendar date of ms) */
const icsDate = ms => icsUtc(ms).slice(0, 8);

/** Small stable 53-bit string hash (cyrb53). */
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export function uidFor(ev) { return `${hash(ev.key || `${ev.title}|${ev.start}`)}@zenith.aayan277.github.io`; }

export function slug(s) {
  return String(s || 'event').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'event';
}

function span(ev) {
  const start = ev.start;
  let end = ev.end;
  if (ev.allDay) { const s = Date.UTC(...ymd(start)); return { s, e: Math.max(s + 86400e3, end ? Date.UTC(...ymd(end)) + 86400e3 : 0) }; }
  if (!(end > start)) end = start + 3600e3;
  return { s: start, e: end };
}
const ymd = ms => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };

/** Build the lines of a single VEVENT (no folding / CRLF yet). */
function veventLines(ev, stamp, alarmMin) {
  const { s, e } = span(ev);
  const L = ['BEGIN:VEVENT', `UID:${uidFor(ev)}`, `DTSTAMP:${icsUtc(stamp)}`];
  if (ev.allDay) { L.push(`DTSTART;VALUE=DATE:${icsDate(s)}`, `DTEND;VALUE=DATE:${icsDate(e)}`); }
  else { L.push(`DTSTART:${icsUtc(s)}`, `DTEND:${icsUtc(e)}`); }
  L.push(`SUMMARY:${icsEscape(ev.title)}`);
  if (ev.description) L.push(`DESCRIPTION:${icsEscape(ev.description)}`);
  if (ev.location) L.push(`LOCATION:${icsEscape(ev.location)}`);
  L.push(`URL:${ev.url || SITE_URL}`);
  L.push('TRANSP:TRANSPARENT', 'STATUS:CONFIRMED');
  if (alarmMin > 0) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${alarmMin}M`, 'END:VALARM');
  L.push('END:VEVENT');
  return L;
}

/** RFC 5545 text for one event spec or an array of them. CRLF line endings, lines folded at 75 octets. */
export function buildIcs(events, { alarmMin = ALARM_MIN, stamp = Date.now() } = {}) {
  const list = Array.isArray(events) ? events : [events];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Zenith//Sky events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Zenith sky events'];
  for (const ev of list) lines.push(...veventLines(ev, stamp, alarmMin));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function icsFilename(ev) { return `zenith-${slug(Array.isArray(ev) ? ev[0]?.title : ev.title)}.ics`; }

/** Download the event as zenith-<slug>.ics through a Blob. Returns the file name. */
export function downloadIcs(ev, filename = icsFilename(ev)) {
  const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

/** Google Calendar "create event" template URL (Google cannot take a reminder from the link: it uses the calendar's default). */
export function googleUrl(ev) {
  const { s, e } = span(ev);
  const dates = ev.allDay ? `${icsDate(s)}/${icsDate(e)}` : `${icsUtc(s)}/${icsUtc(e)}`;
  const details = [ev.description, ev.url || SITE_URL].filter(Boolean).join('\n\n');
  const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates, details });
  if (ev.location) q.set('location', ev.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
