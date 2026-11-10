// Detail-panel provider for selection.kind === 'event' (sky events from js/events). Light on purpose: it is imported
// eagerly by the Tonight panel; the heavy computation only starts when an event is actually selected.
import * as state from '../state.js';
import { registerDetailProvider } from '../state.js';
import { getEvent, ensureEvents } from './index.js';
import { openCalMenu } from './calmenu.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { chip, calSpec, goToEvent, evColor, detailIcon, fmtDate, fmtClock, fmtWhen, TYPE_LABEL } from './ui.js';

const MON = m => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m];
const raText = ra => { const h = ra / 15, hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${hh}h ${String(mm).padStart(2, '0')}m`; };
const dm = ms => { const d = new Date(ms); return `${MON(d.getUTCMonth())} ${d.getUTCDate()}`; };

function rowsFor(ev) {
  const rows = [{ label: `Time (${tzLabel(ev.t)})`, value: fmtWhen(ev.t) }];
  rows.push({ label: 'UTC', value: new Date(ev.t).toISOString().slice(0, 16).replace('T', ' ') });
  if (ev.type === 'meteor') {
    const s = ev.shower;
    rows.push({ label: 'Active', value: `${dm(s.start)} to ${dm(s.end)}` });
    rows.push({ label: 'Best hours here', value: s.bestStart ? `${fmtClock(s.bestStart)} to ${fmtClock(s.bestEnd)} on ${fmtDate(s.bestStart)}` : 'No dark sky from here' });
    rows.push({ label: 'Radiant', value: `RA ${raText(s.ra)} · Dec ${s.dec > 0 ? '+' : '−'}${Math.abs(s.dec)}°` });
    if (s.radiantAlt != null) rows.push({ label: 'Radiant height', value: `${Math.round(s.radiantAlt)}° at best` });
    rows.push({ label: 'Moon', value: `${Math.round(s.moonIllum * 100)}% lit at peak${s.moonAlt != null ? (s.moonAlt > 0 ? `, ${Math.round(s.moonAlt)}° up in the best hours` : ', below the horizon in the best hours') : ''}` });
    rows.push({ label: 'Speed', value: `${s.speed} km/s` });
    rows.push({ label: 'Parent body', value: s.parent });
    rows.push({ label: 'Viewing', value: s.best });
    return rows;
  }
  for (const r of ev.rows || []) {
    if (r.ms != null) rows.push({ label: r.label, value: `${fmtClock(r.ms)}${r.alt != null ? (r.alt > 0 ? ` · ${Math.round(r.alt)}° up` : ' · below horizon') : ''}` });
    else if (r.text != null) rows.push({ label: r.label, value: r.text });
  }
  return rows;
}

export function registerEventDetail() {
  registerDetailProvider('event', sel => {
    const ev = getEvent(sel.id);
    if (!ev) { ensureEvents().catch(() => {}); return null; }
    const stats = [{ label: 'When', value: chip(ev.t) }];
    if (ev.type === 'meteor') {
      stats.push({ label: 'ZHR', value: String(ev.shower.zhr) }, { label: 'Est. rate here', value: String(Math.round(ev.shower.rate)), unit: '/hr' }, { label: 'Viewing', value: ev.shower.rating });
    } else if (ev.type === 'eclipse') stats.push({ label: 'From here', value: ev.vis === 'yes' ? 'Visible' : ev.vis === 'part' ? 'Partly' : 'No' });
    else if (ev.type === 'moon') stats.push({ label: 'Moon', value: ev.sub === 'full' ? '100%' : '0%', unit: 'lit' });
    else if (ev.vis) stats.push({ label: 'From here', value: ev.vis === 'yes' ? 'Visible' : ev.vis === 'part' ? 'Marginal' : 'Poor' });
    return {
      title: ev.title, subtitle: `${TYPE_LABEL[ev.type] || 'Sky event'} · ${fmtDate(ev.t)}`, color: evColor(ev), icon: detailIcon(ev),
      stats, rows: rowsFor(ev), note: [ev.desc, ev.visNote ? `${ev.visNote}.` : '', ev.shower?.note].filter(Boolean).join(' '),
      actions: [
        { label: 'View in sky', onClick: () => goToEvent(ev) },
        { label: 'Add to calendar', onClick: () => {
          const btn = [...document.querySelectorAll('#panel-detail .dp-actions .btn')].find(b => /calendar/i.test(b.textContent)) || document.querySelector('#panel-detail .dp-actions');
          openCalMenu(btn, () => calSpec(ev));
        } },
      ],
    };
  });
}

registerEventDetail();
