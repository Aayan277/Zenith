// Aurora model: geomagnetic latitude, OVATION grid sampling, Kp helpers, NOAA alert parsing and the plain-English verdict.
import { fmtLocal, tzLabel } from '../util/time.js';
import { GRID_W, GRID_H } from './data.js';

const D2R = Math.PI / 180;

/** Dipole geomagnetic latitude (deg) of a geographic point. */
export function geomagLat(lat, lon) {
  const p = 80.7 * D2R, pl = -72.7 * D2R, f = lat * D2R, l = lon * D2R;
  const s = Math.sin(f) * Math.sin(p) + Math.cos(f) * Math.cos(p) * Math.cos(l - pl);
  return Math.asin(Math.max(-1, Math.min(1, s))) * 180 / Math.PI;
}

// ---- Kp ------------------------------------------------------------------------------------------------------
export const KP_COLORS = ['#5ce1a5', '#5ce1a5', '#5ce1a5', '#5ce1a5', '#b6e35c', '#ffd166', '#ff9f5c', '#ff6b5c', '#ff4f8b', '#d86bff'];
export const kpColor = kp => KP_COLORS[Math.max(0, Math.min(9, Math.round(kp)))];
export const gScale = kp => (kp >= 9 ? 5 : kp >= 8 ? 4 : kp >= 7 ? 3 : kp >= 6 ? 2 : kp >= 5 ? 1 : 0);
export const G_NAME = ['', 'minor', 'moderate', 'strong', 'severe', 'extreme'];
/** The 3-hour Kp block containing `t` (rows are block starts). */
export function kpAt(rows, t) {
  let cur = null;
  for (const r of rows || []) { if (r.t <= t) cur = r; else break; }
  return cur;
}
export function kpMaxBetween(rows, a, b) {
  let m = null;
  for (const r of rows || []) if (r.t < b && r.t + 3 * 3600e3 > a) m = m == null ? r.kp : Math.max(m, r.kp);
  return m;
}

/** Equatorward edge of the auroral oval ~ 67 deg - 2.1 deg per Kp (rough rule of thumb). Positive margin = oval overhead. */
export const boundaryMargin = (kp, mlat) => mlat - (67 - 2.1 * kp);
/** Kp needed to bring the oval to a given geomagnetic latitude. */
export const kpNeeded = mlat => Math.max(0, (67 - mlat) / 2.1);

/** Chance level from the Kp forecast alone (what the Tonight card shows). */
export function assess(rows, nowMs, lat, lon, hoursAhead = 24) {
  const next = rows.filter(r => r.t + 3 * 3600e3 > nowMs && r.t < nowMs + hoursAhead * 3600e3);
  const maxKp = next.length ? Math.max(...next.map(r => r.kp)) : null;
  const mlat = Math.abs(geomagLat(lat, lon));
  if (maxKp == null) return { maxKp, mlat, level: 'unknown', text: 'No forecast available', hot: false };
  const margin = boundaryMargin(maxKp, mlat);
  let level, text;
  if (margin >= 0) { level = 'likely'; text = mlat > 62 ? 'Likely overhead tonight' : 'Possible overhead; look north (south in the S. hemisphere)'; }
  else if (margin >= -5) { level = 'possible'; text = 'Possible low on the northern horizon'; }
  else if (margin >= -10) { level = 'unlikely'; text = 'Unlikely from here, only a faint glow at best'; }
  else { level = 'none'; text = 'Not visible from your latitude'; }
  if (level === 'likely' && maxKp < 4 && mlat < 60) { level = 'possible'; text = 'Possible low on the horizon'; }
  return { maxKp, mlat, level, text, hot: level === 'likely', series: next };
}

// ---- OVATION grid -----------------------------------------------------------------------------------------------
/** Bilinear sample of the grid (percent) at lat/lon. */
export function sampleGrid(grid, lat, lon) {
  if (!grid) return null;
  const la = Math.max(-90, Math.min(90, lat)) + 90;
  let lo = ((lon % 360) + 360) % 360;
  const i0 = Math.min(GRID_H - 2, Math.floor(la)), fy = la - i0;
  const j0 = Math.floor(lo) % GRID_W, j1 = (j0 + 1) % GRID_W, fx = lo - Math.floor(lo);
  const g = (i, j) => grid[i * GRID_W + j];
  return (g(i0, j0) * (1 - fx) + g(i0, j1) * fx) * (1 - fy) + (g(i0 + 1, j0) * (1 - fx) + g(i0 + 1, j1) * fx) * fy;
}
/**
 * Aurora chance for an observer: `here` = percent overhead; `horizon` = best percent poleward of you along the observer's
 * meridian, discounted with distance (an aurora ~100-300 km up is visible low on the horizon from up to ~800-1000 km
 * away, i.e. roughly 8-10 degrees of latitude); `horizonDeg` = how far poleward that best point is.
 */
export function chanceAt(grid, lat, lon) {
  if (!grid) return null;
  const hemi = lat >= 0 ? 1 : -1, here = sampleGrid(grid, lat, lon);
  let horizon = 0, horizonDeg = 0;
  for (let d = 1; d <= 10; d++) {
    const la = lat + hemi * d; if (Math.abs(la) > 90) break;
    const v = sampleGrid(grid, la, lon) * (1 - d / 12);
    if (v > horizon) { horizon = v; horizonDeg = d; }
  }
  return { here, horizon, horizonDeg, hemi };
}

// ---- verdict ---------------------------------------------------------------------------------------------------------
const fmtT = ms => fmtLocal(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/**
 * Plain-English verdict. level: 'good' | 'possible' | 'unlikely' | 'none' | 'unknown'.
 * in: { chance (chanceAt result or null), sunAlt (deg at observer), kpRows, now (sim ms), live (sim ~ real time), loc, win ({start,end}|null) }
 */
export function makeVerdict({ chance, sunAlt, kpRows, now, live, loc, win }) {
  const hemi = loc.lat >= 0 ? 'north' : 'south';
  const mlat = Math.abs(geomagLat(loc.lat, loc.lon));
  if (!kpRows && !chance) return { level: 'unknown', title: 'Checking space weather…', detail: '', mlat };
  if (mlat < 38) return { level: 'none', title: 'Not visible from your latitude', detail: 'Aurora almost never reaches this far from the poles. Only an extreme (G5) storm could.', mlat };
  const dark = sunAlt < -9;
  const needed = Math.ceil(kpNeeded(mlat));
  const n = (v) => Math.round(v);
  // Right now, with the live OVATION nowcast.
  if (live && chance && dark) {
    const { here, horizon } = chance;
    if (here >= 20 || horizon >= 35) return { level: 'good', title: `Good chance — look ${hemi}`, mlat, here, horizon,
      detail: here >= 20 ? `About ${n(here)}% aurora probability overhead right now.` : `Strong aurora just ${hemi === 'north' ? 'north' : 'south'} of you: ${n(horizon)}% on the horizon.` };
    if (here >= 5 || horizon >= 12) return { level: 'possible', title: `Possible low on the ${hemi}ern horizon`, mlat, here, horizon,
      detail: `${n(horizon)}% on the ${hemi}ern horizon, ${n(here)}% overhead. Find a dark spot with a clear ${hemi} view.` };
    return { level: 'unlikely', title: 'Unlikely right now', mlat, here, horizon,
      detail: `The oval is well poleward of you. It would take about Kp ${needed} to bring it overhead.` };
  }
  // Otherwise: Kp forecast over the coming dark window.
  if (!win) return { level: 'none', title: 'No dark sky tonight', detail: 'It does not get dark enough at this latitude and date to see aurora.', mlat };
  const kp = kpMaxBetween(kpRows, Math.max(win.start, now), win.end);
  if (kp == null) return { level: 'unknown', title: 'No forecast for tonight', detail: '', mlat };
  const margin = boundaryMargin(kp, mlat);
  const inWin = now >= win.start && now < win.end;
  const when = inWin ? '' : ` after ${fmtT(win.start)}`;
  if (margin >= 0 && !(kp < 4 && mlat < 60)) return { level: 'good', title: `Good chance${when} — look ${hemi}`, mlat, kp,
    detail: `Forecast Kp ${kp.toFixed(1)} puts the oval over or near ${mlat > 62 ? 'you' : 'your latitude'}.` };
  if (margin >= -5) return { level: 'possible', title: `Possible low on the ${hemi}ern horizon${when}`, mlat, kp,
    detail: `Forecast Kp ${kp.toFixed(1)}. Look toward the ${hemi} once it is properly dark.` };
  return { level: margin >= -10 ? 'unlikely' : 'none', title: 'Unlikely tonight', mlat, kp,
    detail: margin >= -10 ? `Forecast Kp ${kp.toFixed(1)}; it would take about Kp ${needed} to reach you.` : 'Too far from the auroral oval for this forecast.' };
}

// ---- NOAA alerts ------------------------------------------------------------------------------------------------------
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const parseSwpcTime = s => { const m = /(\d{4}) (\w{3}) (\d{1,2}) (\d{2})(\d{2}) UTC/.exec(s || ''); return m ? Date.UTC(+m[1], MON[m[2]], +m[3], +m[4], +m[5]) : null; };
const dayEnd = (mon, day, issued) => {
  const y = new Date(issued).getUTCFullYear(), im = new Date(issued).getUTCMonth();
  const year = MON[mon] < im - 6 ? y + 1 : MON[mon] > im + 6 ? y - 1 : y;
  return Date.UTC(year, MON[mon], +day, 23, 59, 59);
};
const dshort = ms => fmtLocal(ms, { day: 'numeric', month: 'short' });
const when = ms => `${fmtLocal(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} ${tzLabel(ms)}`;

/** Parse geomagnetic watches/warnings/alerts; newest first. Other product types are ignored. */
export function parseAlerts(raw, now = Date.now()) {
  const out = [];
  for (const a of raw || []) {
    const msg = String(a.message || ''), code = /Message Code:\s*(\w+)/.exec(msg)?.[1] || a.product_id || '';
    const issued = Date.parse(String(a.issue_datetime || '').replace(' ', 'T') + 'Z') || parseSwpcTime(/Issue Time:\s*(.*)/.exec(msg)?.[1]);
    if (!issued) continue;
    let m;
    if (/^WATA/.test(code) || /WATCH:\s*Geomagnetic Storm/i.test(msg)) {
      const g = +(/Category G(\d)/.exec(msg)?.[1] || 1);
      const days = [...msg.matchAll(/([A-Z][a-z]{2})\s+(\d{1,2}):\s+G(\d)/g)].map(d => ({ mon: d[1], day: d[2], g: +d[3], end: dayEnd(d[1], d[2], issued) }));
      const last = days.length ? days[days.length - 1].end : issued + 3 * 86400e3;
      const peak = Math.max(g, ...days.map(d => d.g));
      const span = days.length ? (days.length > 1 ? `${dshort(days[0].end - 12 * 3600e3)}–${dshort(last - 12 * 3600e3)}` : dshort(days[0].end - 12 * 3600e3)) : 'in the next 3 days';
      out.push({ id: `${code}${/Serial Number:\s*(\d+)/.exec(msg)?.[1] || issued}`, kind: 'watch', g: peak, issued, until: last, active: last > now,
        title: `G${peak} storm watch`, text: `A ${G_NAME[peak]} geomagnetic storm (G${peak}) is possible ${days.length ? 'on ' : ''}${span}. Aurora could be seen farther from the poles than usual.` });
    } else if ((m = /^WARK(\d\d)/.exec(code)) || /WARNING:\s*Geomagnetic K-index of (\d)/i.test(msg)) {
      const k = m ? +m[1] : +/K-index of (\d)/.exec(msg)[1], g = gScale(k);
      const to = parseSwpcTime(/(?:Valid To|Now Valid Until):\s*(.*)/.exec(msg)?.[1]);
      const from = parseSwpcTime(/Valid From:\s*(.*)/.exec(msg)?.[1]);
      const ext = /EXTENDED/i.test(msg);
      out.push({ id: `${code}${/Serial Number:\s*(\d+)/.exec(msg)?.[1] || issued}`, kind: 'warning', kp: k, g, issued, from, until: to, active: !to || to > now,
        title: `Kp ${k} expected${g ? ` (G${g})` : ''}`, text: `${ext ? 'Extended: ' : ''}Geomagnetic activity of Kp ${k}${g ? `, a ${G_NAME[g]} storm,` : ''} is expected${to ? ` until ${when(to)}` : ''}.` });
    } else if ((m = /^ALTK(\d\d)/.exec(code)) || /ALERT:\s*Geomagnetic K-index of (\d)/i.test(msg)) {
      const k = m ? +m[1] : +/K-index of (\d)/.exec(msg)[1], g = gScale(k);
      const at = parseSwpcTime(/Threshold Reached:\s*(.*)/.exec(msg)?.[1]) || issued;
      out.push({ id: `${code}${/Serial Number:\s*(\d+)/.exec(msg)?.[1] || issued}`, kind: 'alert', kp: k, g, issued, until: at + 3 * 3600e3, active: at + 3 * 3600e3 > now,
        title: `Kp ${k} reached${g ? ` (G${g})` : ''}`, text: `Geomagnetic activity hit Kp ${k}${g ? `, a ${G_NAME[g]} storm` : ''} at ${when(at)}.` });
    }
  }
  return out.sort((a, b) => b.issued - a.issued);
}
/** The few alerts worth showing: newest first, one per (kind, level), active ones preferred. */
export function topAlerts(parsed, n = 3) {
  const seen = new Set(), out = [];
  for (const a of [...parsed.filter(a => a.active), ...parsed.filter(a => !a.active)]) {
    const k = a.kind + (a.kp ?? a.g);
    if (seen.has(k)) continue; seen.add(k); out.push(a);
  }
  return out.sort((a, b) => (b.active - a.active) || (b.issued - a.issued)).slice(0, n);
}
