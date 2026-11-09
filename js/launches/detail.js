// Detail-panel provider for selection.kind === 'launch'.
import * as state from '../state.js';
import { registerDetailProvider } from '../state.js';
import { getLaunch, loadLaunches, store } from './data.js';
import { statusOf, parts, p2, fmtLocalFull, fmtUtc, hasClock, precisionNote, fmtDay, isDone } from './util.js';
import { isArmed, toggleReminder, LEAD_MIN } from './reminders.js';
import { flyToLatLon } from './globe.js';

export function showPad(l) {
  if (state.get('view') !== 'globe') state.set('view', 'globe');
  setTimeout(() => flyToLatLon(l.lat, l.lon), 60);
}
export function openWebcast(l) {
  if (!l.webcast) return;
  const w = window.open(l.webcast, '_blank', 'noopener,noreferrer');
  if (w) w.opener = null;
}

const COUNTRY = { US: 'USA', CN: 'China', RU: 'Russia', IN: 'India', JP: 'Japan', NZ: 'New Zealand', FR: 'French Guiana', GF: 'French Guiana', KZ: 'Kazakhstan', NO: 'Norway', KR: 'South Korea', IL: 'Israel', IR: 'Iran', KP: 'North Korea', AU: 'Australia', GB: 'UK', BR: 'Brazil' };

function countdown(l, now) {
  const { sign, d, h, m, s } = parts(l.net - now);
  const pre = sign < 0 ? '' : '+';
  return d >= 1 ? `${pre}${d}d ${p2(h)}h ${p2(m)}m` : `${pre}${p2(h)}:${p2(m)}:${p2(s)}`;
}

export function registerLaunchDetail() {
  registerDetailProvider('launch', (sel, nowMs) => {
    if (!store.loaded && !store.loading) loadLaunches();
    const l = getLaunch(sel.id);
    if (!l) return null;                                   // detail panel shows its skeleton
    const st = statusOf(l), armed = isArmed(l.id);
    const clock = hasClock(l);
    const rows = [
      { label: 'Rocket', value: l.rocketFull || l.rocket },
      { label: 'Provider', value: l.provider || '—' },
      { label: 'Pad', value: l.pad || '—' },
      { label: 'Location', value: l.location || COUNTRY[l.country] || '—' },
      { label: clock ? 'Launch (your time)' : 'Launch (NET)', value: l.net == null ? 'TBD' : clock ? fmtLocalFull(l.net) : `${fmtDay(l.net)} · ${precisionNote(l)}` },
      { label: 'Launch (UTC)', value: l.net == null ? 'TBD' : clock ? fmtUtc(l.net) : fmtUtc(l.net).replace(/\s\d\d:\d\d/, '') },
      { label: 'Orbit', value: [l.orbit?.name, l.windowStart && l.windowEnd && l.windowEnd > l.windowStart ? `${windowText(l.windowEnd - l.windowStart)} window` : ''].filter(Boolean).join(' · ') || '—' },
    ];
    const stats = [
      { label: 'T-minus', value: l.net == null ? '—' : isDone(l) ? 'Launched' : countdown(l, nowMs) },
      { label: 'Status', value: st.label },
    ];
    if (l.probability != null) stats.push({ label: 'Go probability', value: String(l.probability), unit: '%' });
    const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t);
    const note = [clip(l.desc || '', 230), l.status.key === 'failure' && l.failReason ? 'Failure: ' + l.failReason : '',
      armed ? 'Reminders only fire while Zenith is open in a tab.' : ''].filter(Boolean).join(' ');
    const actions = [];
    if (l.webcast) actions.push({ label: 'Watch webcast', onClick: () => openWebcast(l) });
    actions.push({ label: 'Show pad', onClick: () => showPad(l) });
    if (!isDone(l) && l.net != null) actions.push({ label: armed ? 'Reminder on · tap to remove' : 'Notify me', onClick: () => toggleReminder(l) });
    return {
      title: l.mission, subtitle: `${l.rocket}${l.provider ? ' · ' + l.provider : ''}`, color: st.color, icon: 'rocket',
      stats, rows, note, actions,
    };
  });
}
function windowText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'Instantaneous';
  if (m < 120) return `${m} min`;
  const h = ms / 3600e3; return h < 48 ? `${h % 1 ? h.toFixed(1) : h} h` : `${Math.round(h / 24)} days`;
}
