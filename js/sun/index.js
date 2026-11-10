// Sun feature entry. Used by:
//   js/sky/details.js  -> mergeSunDetail(base, nowMs)   decorates the observer-centric Sun detail with live data
//   js/aurora/panel.js -> ./card.js                       "Sun now" card
//   anyone             -> openSunDashboard()
import { FILTERS, sdoUrl, getFilter, setFilter, sun, ensure, probeSdo, status, summaryText, FULL } from './data.js';
import { hm, hmz, ensureSunCss } from './util.js';

export { openSunDashboard } from './card.js';
const num = (x, d = 0) => Number(x).toFixed(d);

/** base = the existing observer-centric Sun detail from sky/details.js (or null). Returns the merged detail. */
export function mergeSunDetail(base, nowMs) {
  ensure(FULL); probeSdo();
  const f = FILTERS[getFilter()], next = FILTERS[(getFilter() + 1) % FILTERS.length], st = status();
  const b = base || { title: 'Sun', color: '#ffb347', icon: 'sun', stats: [], rows: [], subtitle: 'Our star' };
  const stat = l => (b.stats || []).find(s => s.label === l);
  const alt = stat('Altitude'), az = stat('Azimuth'), dist = stat('Distance');
  const below = /Below/.test(b.subtitle || '');
  const dash = '…';
  const stats = [
    { label: 'Flare class', value: st.cur ? st.cur.label : dash, unit: st.cur ? st.word : '' },
    { label: 'Sunspot no.', value: st.ssn != null ? String(st.ssn) : dash, unit: '' },
    { label: 'Active regions', value: sun.regions ? String(st.live.length) : dash, unit: '' },
    { label: 'Solar wind', value: st.wind != null ? String(Math.round(st.wind)) : dash, unit: st.wind != null ? 'km/s' : '' },
  ];
  const rows = [
    { label: 'Largest flare · 24 h', value: !sun.flares ? dash : st.big ? `${st.big.c} · ${hmz(st.big.m)}` : 'None recorded' },
  ];
  if (alt && az) rows.push({ label: 'Altitude · azimuth', value: `${alt.value}° · ${az.value}${az.unit || ''}` });
  if (dist) rows.push({ label: 'Distance', value: `${dist.value} AU` });
  rows.push(...(b.rows || []));
  const sum = summaryText(st, hm);
  const note = (sum || 'Loading live solar data…') + (!below && alt ? ' Never look at the Sun without a proper solar filter.' : '');
  const media = sun.imgOk === false ? undefined : {
    src: sdoUrl(f.id, 512), href: sdoUrl(f.id, 1024), alt: `Latest NASA SDO image of the Sun in ${f.name.toLowerCase()} (${f.label})`,
    caption: `NASA SDO · ${f.id.startsWith('HMI') ? 'HMI' : 'AIA'} ${f.label} · ${f.name} · live, new frame about every 15 min`,
  };
  const extra = (b.actions || []);
  return { ...b, title: 'Sun', icon: 'sun', subtitle: (below ? 'Below your horizon' : 'Above your horizon') + ' · ' + st.word.toLowerCase() + ' today', stats, rows, note, media,
    actions: [
      { label: 'Open Sun dashboard', onClick: () => import('./card.js').then(m => m.openSunDashboard()) },
      { label: `Next filter · ${next.label}`, onClick: () => setFilter(getFilter() + 1) },
      ...extra,
    ] };
}
export { ensureSunCss };
