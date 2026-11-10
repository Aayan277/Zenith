// Shared presentation helpers for sky events: icons, colours, relative-time chips, local-time text, calendar specs, "go to".
import * as state from '../state.js';
import * as clock from '../clock.js';
import { fmtLocal, tzLabel, tzOffsetMinutes } from '../util/time.js';
import { PLANET_COLOR } from './compute.js';
import { SITE_URL } from '../util/ics.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400e3;

const S = (inner, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  meteor: '<path d="M20.5 3.5L9 15"/><path d="M17 3.2L7.5 12.6M20.8 7L11.4 16.4" opacity=".45"/><circle cx="7" cy="17" r="3.2" fill="currentColor" fill-opacity=".25"/><path d="M3 21l2-2" opacity=".6"/>',
  lunar: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16c3.6-1.4 5-4.6 5-8s-1.4-6.6-5-8z" fill="currentColor" fill-opacity=".35"/>',
  solar: '<circle cx="12" cy="12" r="5.2" fill="currentColor" fill-opacity=".85"/><circle cx="14" cy="11" r="4.6" fill="#0a0f1c" stroke="none"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" opacity=".7"/>',
  full: '<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".9"/><circle cx="9.3" cy="9.8" r="1.4" fill="#0a0f1c" fill-opacity=".25" stroke="none"/><circle cx="14.6" cy="14.2" r="1.9" fill="#0a0f1c" fill-opacity=".2" stroke="none"/>',
  new: '<circle cx="12" cy="12" r="8" stroke-dasharray="2.2 2.4"/><circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".08" stroke="none"/>',
  planet: '<circle cx="12" cy="12" r="4.8" fill="currentColor" fill-opacity=".85"/><ellipse cx="12" cy="12" rx="10" ry="3.1" transform="rotate(-20 12 12)" opacity=".8"/>',
  opposition: '<circle cx="5" cy="12" r="2.2" fill="currentColor" fill-opacity=".9"/><circle cx="12" cy="12" r="3.2" fill="currentColor" fill-opacity=".8"/><circle cx="19.5" cy="12" r="1.6" fill="currentColor" fill-opacity=".5"/><path d="M5 12h14" opacity=".35" stroke-dasharray="1.5 2.5"/>',
  elongation: '<circle cx="5.5" cy="16.5" r="3" fill="currentColor" fill-opacity=".85" stroke="none"/><circle cx="17.5" cy="7.5" r="2" fill="currentColor"/><path d="M5.5 16.5A13 13 0 0 1 17 7.5" stroke-dasharray="1.8 2.6" opacity=".6"/>',
  conj: '<circle cx="8.5" cy="12.5" r="3.6" fill="currentColor" fill-opacity=".85"/><circle cx="16.5" cy="10.5" r="2.2" fill="currentColor"/><path d="M3 20h18" opacity=".3"/>',
  season: '<circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity=".85"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" opacity=".8"/>',
  rocket: '<path d="M12 2.5c3 2 4.5 5.2 4.5 9V15h-9v-3.5c0-3.8 1.5-7 4.5-9z"/><circle cx="12" cy="9.5" r="1.6"/><path d="M7.5 13.5L5 16.5V19l2.5-1.5M16.5 13.5l2.5 3V19l-2.5-1.5M10 18.5l2 3 2-3"/>',
  sat: '<rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M4 7l4 4M6 5l4 4M16 15l4 4M14 17l4 4M12 12l-5.5 5.5M12 12l5.5-5.5"/>',
  aurora: '<path d="M3 17c3-1 4-7 7-9s4 4 7 2 3-5 4-6" /><path d="M3 21c4-1 6-5 9-6s5 1 9-1" opacity=".55"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" fill="currentColor" fill-opacity=".3"/>',
};
export const icon = (name, size) => S(ICONS[name] || ICONS.planet, size);

export function iconName(ev) {
  if (ev.type === 'meteor') return 'meteor';
  if (ev.type === 'eclipse') return ev.sub.startsWith('lunar') ? 'lunar' : 'solar';
  if (ev.type === 'moon') return ev.sub === 'new' ? 'new' : 'full';
  switch (ev.sub) {
    case 'season': return 'season'; case 'opposition': return 'opposition'; case 'elongation': return 'elongation';
    case 'conjunction': case 'moon-conjunction': return 'conj'; default: return 'planet';
  }
}
export function evColor(ev) {
  if (ev.type === 'meteor') return '#b79cff';
  if (ev.type === 'eclipse') return ev.sub.startsWith('lunar') ? '#ff8f6b' : '#ffc14d';
  if (ev.type === 'moon') return ev.sub === 'new' ? '#8da2c8' : '#f4eec8';
  if (ev.sub === 'season') return '#ffb347';
  const b = ev.body || (ev.bodies || []).find(x => x !== 'Moon');
  return PLANET_COLOR[b] || '#5ce1ff';
}
export const evIcon = (ev, size = 20) => icon(iconName(ev), size);
export const detailIcon = ev => ev.type === 'meteor' ? 'star' : ev.type === 'eclipse' ? (ev.sub.startsWith('lunar') ? 'moon' : 'sun') : ev.type === 'moon' ? 'moon' : ev.sub === 'season' ? 'sun' : 'planet';

export const TYPE_LABEL = { meteor: 'Meteor shower', eclipse: 'Eclipse', moon: 'Moon', planet: 'Planets' };

// ---------- times (always the observer's zone) ----------
const localDay = ms => Math.floor((ms + tzOffsetMinutes(ms) * 60e3) / DAY);
export const fmtDate = ms => fmtLocal(ms, { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtDateLong = ms => fmtLocal(ms, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
export const fmtClock = ms => fmtLocal(ms, { hour: 'numeric', minute: '2-digit' });
export const fmtWhen = ms => `${fmtDate(ms)} · ${fmtClock(ms)} ${tzLabel(ms)}`;

/** "in 3 days", "tomorrow", "today", "in 5 hr", "in 4 wk", "in 7 mo" */
export function chip(ms, now = Date.now()) {
  const d = ms - now;
  if (d < -3600e3) { const days = localDay(now) - localDay(ms); return days <= 0 ? `${Math.max(1, Math.round(-d / 3600e3))} hr ago` : `${days} d ago`; }
  if (d < 0) return 'now';
  if (d < 3600e3) return `in ${Math.max(1, Math.round(d / 60e3))} min`;
  const days = localDay(ms) - localDay(now);
  if (days === 0) return d < 6 * 3600e3 ? `in ${Math.round(d / 3600e3)} hr` : 'today';
  if (days === 1) return 'tomorrow';
  if (days < 70) return `in ${days} days`;
  if (days < 150) return `in ${Math.round(days / 7)} wk`;
  return `in ${Math.round(days / 30.4)} mo`;
}
export function chipTone(ms, now = Date.now()) { const d = ms - now; return d < 0 ? 'past' : d < 2 * DAY ? 'soon' : d < 14 * DAY ? 'near' : 'far'; }

// ---------- calendar spec ----------
export function calSpec(ev) {
  const loc = state.get('location'), place = loc?.name || '';
  let start = ev.ics?.start ?? ev.t, end = ev.ics?.end;
  if (ev.type === 'meteor') {
    const s = ev.shower;
    if (s?.bestStart) { start = s.bestStart; end = s.bestEnd; } else { start = ev.t - 1800e3; end = ev.t + 1800e3 * 3; }
  } else if (ev.type === 'planet' && ev.sub !== 'season') { start = ev.viewMs ?? ev.t; end = start + 3600e3; }
  else if (!end) end = start + 3600e3;
  const lines = [ev.desc, ev.shower?.note, ev.visNote && `${ev.visNote}.`, '', `Event time: ${fmtWhen(ev.t)}`];
  if (ev.type === 'meteor' && ev.shower?.bestStart) lines.push(`Best viewing: ${fmtClock(ev.shower.bestStart)} to ${fmtClock(ev.shower.bestEnd)} (${fmtDate(ev.shower.bestStart)})`, `Estimated rate here: about ${Math.round(ev.shower.rate)} per hour (${ev.shower.rating})`);
  lines.push(`Times are in ${tzLabel(ev.t)}, the time zone of ${place || 'your location'}.`);
  return { key: ev.id, title: ev.title, start, end, description: lines.filter(l => l != null).join('\n'), location: place, url: SITE_URL,
    link: { view: 'sky', t: ev.viewMs ?? ev.t, sel: ev.focus?.kind === 'body' ? ev.focus : null } };
}

// ---------- open an event in the Sky view ----------
/** Select the event, jump the clock to the time it is best seen, switch to the Sky view and focus the object / radiant. */
export function goToEvent(ev) {
  const at = ev.viewMs ?? ev.t;
  state.set('selection', { kind: 'event', id: ev.id });
  clock.setTime(at);
  if (state.get('view') !== 'sky') state.set('view', 'sky');
  const f = ev.focus;
  if (f) { setTimeout(() => state.emit('focus', f), 350); setTimeout(() => state.emit('focus', f), 1600); }
  state.emit('toast', `Sky set to ${fmtDate(at)} ${fmtClock(at)} ${tzLabel(at)}. Press LIVE to come back.`);
}
