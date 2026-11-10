// "Up tonight" card: what is worth looking at for the observer tonight, as at most six lines sorted by time.
// computeUp() is pure data; renderUp() returns HTML; click handling lives in tonight.js (data-up attributes).
import { fmtLocal, tzLabel } from '../util/time.js';
import { compass, magLabel, esc, dayKey } from './util.js';
import { activeShowers, evaluateShower } from '../events/index.js';
import { PLANET_COLOR } from '../events/compute.js';
import { icon } from '../events/ui.js';
import { pending } from '../launches/data.js';
import { assessNow } from '../aurora/assess.js';
import { aur } from '../aurora/data.js';

const A = () => window.Astronomy;
const H = 3600e3;
const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
const MAX_LINES = 6;
const tm = ms => fmtLocal(ms, { hour: 'numeric', minute: '2-digit' });

function horiz(body, ms, obs) {
  const d = new Date(ms), eq = A().Equator(body, d, obs, true, true);
  return A().Horizon(d, obs, eq.ra, eq.dec, 'normal');
}

let planetMemo = { key: '', lines: [] };
/** Planets brighter than mag 5.5 that are above 10 deg at some point of the dark window. */
function planetLines(loc, win) {
  if (!win) return [];
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${win.start},${win.end}`;
  if (planetMemo.key === key) return planetMemo.lines;
  const obs = new (A().Observer)(loc.lat, loc.lon, loc.elevM || 0), lines = [];
  for (const body of PLANETS) {
    const mid = (win.start + win.end) / 2, mag = A().Illumination(body, new Date(mid)).mag;
    if (!(mag < 5.5)) continue;
    let first = null, last = null, az0 = 0, peak = 0;
    for (let t = win.start; t <= win.end + 1; t += 15 * 60e3) {
      const hz = horiz(body, Math.min(t, win.end), obs);
      if (hz.altitude >= 10) { if (first == null) { first = Math.min(t, win.end); az0 = hz.azimuth; } last = Math.min(t, win.end); peak = Math.max(peak, hz.altitude); }
    }
    if (first == null) continue;
    lines.push({ kind: 'planet', id: body, name: body, t: first, end: last, dir: compass(az0), mag, peak });
  }
  planetMemo = { key, lines };
  return lines;
}

/** @returns {{kind:string,id?:string|number,name:string,detail:string,time:string,t:number,color:string,ic:string,prio:number}[]} */
export function computeUp(ctx, now) {
  const out = [], loc = ctx.loc, win = ctx.win;
  // Planets
  for (const p of planetLines(loc, win)) {
    out.push({ kind: 'planet', id: p.id, name: p.name, detail: `${p.dir} · ${magLabel(p.mag) || 'Visible'}`, time: `${tm(p.t)}–${tm(p.end)}`,
      t: p.t, color: PLANET_COLOR[p.id], ic: 'dot', prio: 60 - p.mag * 6, title: `${p.name}: above 10° from ${tm(p.t)} to ${tm(p.end)}, peaks ${Math.round(p.peak)}° high (mag ${p.mag.toFixed(1)})` });
  }
  // Moon
  const m = ctx.moon;
  if (m) {
    const times = [m.rise != null && m.rise >= now - 1 ? ['↑', m.rise] : null, m.set != null && m.set >= now - 1 ? ['↓', m.set] : null].filter(Boolean).sort((a, b) => a[1] - b[1]);
    out.push({ kind: 'body', id: 'Moon', name: 'Moon', detail: `${m.name} · ${Math.round(m.illum * 100)}%`, time: times.map(([s, t]) => `${s} ${tm(t)}`).join(' · ') || (m.up ? 'Up now' : '—'),
      t: times.length ? Math.min(times[0][1], now + 12 * H) : now, color: PLANET_COLOR.Moon, ic: 'moon', phase: m.phase, prio: 70, title: `Moon ${m.name.toLowerCase()}, ${Math.round(m.illum * 100)}% lit` });
  }
  // Next ISS pass
  const iss = (ctx.passes || []).find(p => p.satId === 25544 && p.end > now && p.start < now + 36 * H);
  if (iss) {
    const today = dayKey(iss.start) === dayKey(now), tomorrow = dayKey(iss.start) === dayKey(now + 24 * H);
    out.push({ kind: 'sat', id: iss.satId, name: 'ISS pass', detail: `${today ? '' : (tomorrow ? 'Tomorrow · ' : fmtLocal(iss.start, { weekday: 'short' }) + ' · ')}${compass(iss.startAz)} → ${compass(iss.endAz)} · ${Math.round(iss.maxEl)}°`,
      time: now >= iss.start ? 'Overhead now' : tm(iss.start), t: iss.start, color: '#ffb347', ic: 'sat', prio: 85, title: `ISS: ${magLabel(iss.mag)}, max ${Math.round(iss.maxEl)}°` });
  }
  // Meteor shower active tonight
  try {
    const range = win ? { from: win.start, to: win.end } : null;
    let best = null;
    for (const s of activeShowers(now)) {
      if (Math.abs(s.daysFromPeak) > 7) continue;
      const ev = evaluateShower(s, loc, undefined, range);
      if (ev.rate >= 5 && (!best || ev.rate > best.ev.rate)) best = { s, ev };
    }
    if (best) {
      const { s, ev } = best, d = Math.abs(s.daysFromPeak);
      out.push({ kind: 'shower', id: s.id, name: s.name, detail: `${d < 0.6 ? 'Peak tonight' : d < 1.6 ? 'Near peak' : 'Active'} · ~${Math.round(ev.rate)}/hr`,
        time: `${tm(ev.bestStart)}–${tm(ev.bestEnd)}`, t: ev.bestStart, color: '#b79cff', ic: 'meteor', prio: ev.rate >= 18 ? 82 : 66,
        title: `${s.name}: ZHR ${s.zhr}, about ${Math.round(ev.rate)} per hour from here, Moon ${Math.round(ev.moonIllum * 100)}% lit` });
    }
  } catch (e) { console.warn('[tonight] shower line', e.message); }
  // Aurora (only when not unlikely)
  try {
    if (aur.kp) {
      const a = assessNow(aur, loc, now).verdict;
      if (a && (a.level === 'good' || a.level === 'possible')) {
        const north = loc.lat >= 0 ? 'north' : 'south';
        out.push({ kind: 'aurora', name: 'Aurora', detail: `${a.level === 'good' ? 'Good chance' : 'Possible'} · look ${north}`, time: win ? `${tm(win.start)}–${tm(win.end)}` : 'Tonight',
          t: win ? win.start : now, color: '#5ce1a5', ic: 'aurora', prio: a.level === 'good' ? 88 : 72, title: a.title });
      }
    }
  } catch (e) { console.warn('[tonight] aurora line', e.message); }
  // A launch today
  try {
    const l = pending(now).find(x => dayKey(x.net) === dayKey(now) && x.net > now - 30 * 60e3);
    if (l) out.push({ kind: 'launch', id: l.id, name: l.mission, detail: `${l.rocket || 'Launch'}${l.provider ? ' · ' + l.provider : ''}`, time: ['SEC', 'MIN', 'HR'].includes(l.precision) ? tm(l.net) : 'Today', t: l.net, color: '#ff9f5c', ic: 'rocket', prio: 90, title: `${l.mission}: ${l.rocketFull || l.rocket}` });
  } catch {}
  return out.sort((a, b) => b.prio - a.prio).slice(0, MAX_LINES).sort((a, b) => a.t - b.t);
}

const tinyMoon = phase => {
  const k = Math.cos(phase * Math.PI / 180), rx = Math.abs(k) * 7, waxing = phase < 180, flip = waxing ? 1 : -1;
  const lit = phase < 2 || phase > 358 ? '' : `<g transform="translate(9 9) scale(${flip} 1)"><path d="M0 -7A7 7 0 0 1 0 7A${rx.toFixed(2)} 7 0 0 ${k > 0 ? 0 : 1} 0 -7Z" fill="#f4f1e2"/></g>`;
  return `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="#161e33" stroke="rgba(190,205,235,.4)" stroke-width=".8"/>${lit}</svg>`;
};

export function renderUp(lines, now, loading) {
  const head = `<div class="tn-card-head"><span class="eyebrow">Up tonight</span><span class="tn-right">Times in ${esc(tzLabel(now))}</span></div>`;
  if (!lines.length) return head + `<p class="tn-empty">${loading ? 'Checking the sky…' : 'Nothing notable tonight.'}</p>`;
  return head + `<ul class="up-list">${lines.map(l => `<li><button type="button" class="up-row" data-up="${l.kind}"${l.id != null ? ` data-id="${esc(l.id)}"` : ''} style="--c:${l.color}" title="${esc(l.title || l.name)}">
    <span class="up-ic">${l.ic === 'dot' ? '<i class="up-dot"></i>' : l.ic === 'moon' ? tinyMoon(l.phase) : icon(l.ic, 17)}</span>
    <span class="up-txt"><b>${esc(l.name)}</b><span>${esc(l.detail)}</span></span>
    <span class="up-time mono">${esc(l.time)}</span></button></li>`).join('')}</ul>`;
}
