// Detail-panel providers owned by the System view: 'craft' (deep-space missions) and 'world' (Earth, Pluto).
import * as state from '../state.js';
import { AU_KM, LIGHT_AU_S, getCraft, craftEcl, craftSpeedKmS, helioEcl, fmtLight, fmtKm } from './data.js';

const f = (x, d = 2) => Number(x).toFixed(d);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const _e = [0, 0, 0];

function toast(msg) { state.emit('toast', msg); }

function earthDetail(nowMs) {
  const p = helioEcl('Earth', nowMs), r = Math.hypot(p[0], p[1], p[2]);
  const lon = ((Math.atan2(p[1], p[0]) * 180 / Math.PI) + 360) % 360;
  const day = (nowMs - Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 0)) / 864e5;
  return {
    title: 'Earth', subtitle: 'Third planet from the Sun', color: '#4f93e6', icon: 'planet',
    stats: [
      { label: 'From the Sun', value: f(r, 4), unit: 'AU' },
      { label: 'Sunlight takes', value: fmtLight(r * LIGHT_AU_S), unit: '' },
      { label: 'Orbit speed', value: f(29.78 * Math.sqrt(2 / r - 1) , 2), unit: 'km/s' },
    ],
    rows: [
      { label: 'Sun distance', value: fmtKm(r * AU_KM) },
      { label: 'Heliocentric longitude', value: f(lon, 1) + '\u00b0' },
      { label: 'Day of year', value: String(Math.floor(day)) },
      { label: 'Moon distance', value: '384,400 km (drawn exaggerated here)' },
    ],
    note: r < 1 ? 'Earth is currently a little inside its 1 AU average distance from the Sun.' : 'Earth is currently a little beyond its 1 AU average distance from the Sun.',
    actions: [{ label: 'Open Orbit view', onClick: () => state.set('view', 'globe') }],
  };
}

export function registerSystemDetails() {
  state.registerDetailProvider('craft', (sel, nowMs) => {
    const c = getCraft(sel.id);
    if (!c) return null;
    const base = { title: c.name, subtitle: `${c.agency} · launched ${c.launch}`, color: c.color, icon: 'sat' };
    const actions = [{ label: 'Mission page', onClick: () => window.open(c.url, '_blank', 'noopener') }];
    if (c.id === 'jwst') {
      actions.push({ label: 'View photos', onClick: () => {
        import('../gallery/index.js').then(m => m.openGallery('jwst')).catch(e => { console.warn('[system] gallery', e); toast('Photo gallery is not available right now'); });
      } });
    }
    const p = craftEcl(c, nowMs);
    if (!p) {
      return { ...base, stats: [], rows: [{ label: 'Status', value: c.status }, { label: 'Position', value: 'not available for this date' }],
        note: `${c.desc} Position not available for this date: tracking data covers roughly 30 days back and 120 days ahead of the last data update.`, actions };
    }
    const earth = helioEcl('Earth', nowMs, _e);
    const dSun = Math.hypot(p[0], p[1], p[2]), dEarth = dist3(p, earth);
    const v = craftSpeedKmS(c, nowMs);
    const near = dEarth < 0.1;
    return {
      ...base,
      stats: [
        { label: 'From the Sun', value: f(dSun, dSun < 10 ? 3 : 2), unit: 'AU' },
        { label: 'From Earth', value: near ? f(dEarth * AU_KM / 1e6, 3) : f(dEarth, dEarth < 10 ? 3 : 2), unit: near ? 'M km' : 'AU' },
        { label: 'One-way light', value: fmtLight(dEarth * LIGHT_AU_S), unit: '' },
        { label: 'Speed', value: v == null ? '—' : f(v, 2), unit: 'km/s' },
      ],
      rows: [
        { label: 'Sun distance', value: fmtKm(dSun * AU_KM) },
        { label: 'Earth distance', value: fmtKm(dEarth * AU_KM) },
        { label: 'Status', value: c.status },
        { label: 'Agency', value: c.agency },
        { label: 'Launched', value: String(c.launch) },
      ],
      note: c.desc,
      actions,
    };
  });

  // Earth (the sky provider has no 'illumination of the Earth') and Pluto (not a sky body): kind 'world'
  state.registerDetailProvider('world', (sel, nowMs) => {
    if (sel.id === 'Earth') return earthDetail(nowMs);
    if (sel.id !== 'Pluto') return null;
    const p = helioEcl('Pluto', nowMs), earth = helioEcl('Earth', nowMs, _e);
    const dSun = Math.hypot(p[0], p[1], p[2]), dEarth = dist3(p, earth);
    return {
      title: 'Pluto', subtitle: 'Dwarf planet · Kuiper Belt', color: '#cdb9a0', icon: 'planet',
      stats: [
        { label: 'From the Sun', value: f(dSun, 2), unit: 'AU' },
        { label: 'From Earth', value: f(dEarth, 2), unit: 'AU' },
        { label: 'One-way light', value: fmtLight(dEarth * LIGHT_AU_S), unit: '' },
      ],
      rows: [
        { label: 'Diameter', value: '2,377 km' },
        { label: 'Orbital period', value: '248 years' },
        { label: 'Moons', value: '5 (Charon is half its size)' },
        { label: 'Magnitude', value: 'about 14.4, telescope only' },
      ],
      note: 'Pluto is far too faint for the naked eye. Its orbit is tilted 17 degrees and so eccentric that it sometimes brings Pluto closer to the Sun than Neptune.',
      actions: [{ label: 'Mission: New Horizons', onClick: () => state.set('selection', { kind: 'craft', id: 'newhorizons' }) }],
    };
  });
}
