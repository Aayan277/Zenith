// Aurora data from NOAA SWPC (no key, CORS enabled): OVATION aurora grid, planetary-K forecast, alerts, solar wind.
// Every request has a timeout and a localStorage cache; failures are kept per source so one bad endpoint
// never blanks the rest. The OVATION grid (~920 KB of JSON) is reduced to a 360x181 Uint8 grid (65 KB) on arrival.
import { lsGet, lsSet } from '../ui/notify.js';

const BASE = 'https://services.swpc.noaa.gov';
const URLS = {
  ovation: BASE + '/json/ovation_aurora_latest.json',
  kp: BASE + '/products/noaa-planetary-k-index-forecast.json',
  alerts: BASE + '/products/alerts.json',
  speed: BASE + '/products/summary/solar-wind-speed.json',
  mag: BASE + '/products/summary/solar-wind-mag-field.json',
};
const KEY_SMALL = 'zenith:aurora:small:v1', KEY_OVA = 'zenith:aurora:ovation:v1';
const TTL_SMALL = 10 * 60e3, TTL_OVA = 15 * 60e3;
export const GRID_W = 360, GRID_H = 181;

export const aur = {
  kp: null,            // [{ t, kp, obs: 'observed'|'estimated'|'predicted', scale }]
  alerts: null,        // raw SWPC alert objects
  wind: null,          // { speed, bz, bt, t }
  ovation: null,       // { grid: Uint8Array(360*181) [lat row][lon col], obs, forecast, at }
  errors: {},          // source -> Error
  updatedAt: 0, ovationAt: 0, loading: { small: false, ovation: false },
};
const subs = new Set();
export const onAurora = fn => { subs.add(fn); return () => subs.delete(fn); };
const emit = () => { for (const fn of subs) { try { fn(aur); } catch (e) { console.error('[aurora]', e); } } };

async function getJson(url, ms = 12000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}
const utc = s => { const x = String(s || ''); return Date.parse(x.replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(x) ? '' : 'Z')); };

export function parseKp(j) {
  let rows;
  if (Array.isArray(j) && Array.isArray(j[0])) rows = j.slice(1).map(r => ({ t: utc(r[0]), kp: parseFloat(r[1]), obs: r[2] || 'predicted', scale: r[3] || null }));
  else rows = (j || []).map(r => ({ t: utc(r.time_tag), kp: parseFloat(r.kp ?? r.Kp), obs: r.observed || 'predicted', scale: r.noaa_scale || null }));
  return rows.filter(r => Number.isFinite(r.t) && Number.isFinite(r.kp)).sort((a, b) => a.t - b.t);
}

function applySmall(d) {
  if (d.kp) aur.kp = d.kp;
  if (d.alerts) aur.alerts = d.alerts;
  if (d.wind) aur.wind = d.wind;
  aur.updatedAt = d.at || Date.now();
}

let smallP = null;
/** Kp forecast + alerts + solar wind (~55 KB). */
export function loadSmall({ force = false } = {}) {
  if (smallP) return smallP;
  const cached = lsGet(KEY_SMALL, null);
  if (cached && !aur.kp) applySmall(cached);                      // instant paint from cache
  if (!force && cached && Date.now() - cached.at < TTL_SMALL) { emit(); return Promise.resolve(aur); }
  aur.loading.small = true; emit();
  smallP = (async () => {
    const out = { at: Date.now() };
    const jobs = [
      getJson(URLS.kp).then(j => { out.kp = parseKp(j); delete aur.errors.kp; }).catch(e => { aur.errors.kp = e; }),
      getJson(URLS.alerts).then(j => { out.alerts = Array.isArray(j) ? j : []; delete aur.errors.alerts; }).catch(e => { aur.errors.alerts = e; }),
      Promise.all([getJson(URLS.speed), getJson(URLS.mag)]).then(([s, m]) => {
        const a = s?.[0] || {}, b = m?.[0] || {};
        out.wind = { speed: Number(a.proton_speed), bz: Number(b.bz_gsm), bt: Number(b.bt), t: utc(b.time_tag || a.time_tag) };
        delete aur.errors.wind;
      }).catch(e => { aur.errors.wind = e; }),
    ];
    await Promise.all(jobs);
    applySmall(out);
    // Cache whatever we have (merge with the previous cache so a failed source keeps its last good value).
    lsSet(KEY_SMALL, { at: out.kp || out.alerts || out.wind ? Date.now() : (cached?.at || 0), kp: aur.kp, alerts: (aur.alerts || []).slice(0, 40), wind: aur.wind });
  })().finally(() => { aur.loading.small = false; smallP = null; emit(); }).then(() => aur);
  return smallP;
}

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

let ovaP = null;
/** OVATION aurora probability grid. grid[(lat+90)*360 + lon], values 0..100 (percent). */
export function loadOvation({ force = false } = {}) {
  if (ovaP) return ovaP;
  if (!aur.ovation) {
    const c = lsGet(KEY_OVA, null);
    if (c?.b64) { try { aur.ovation = { grid: unb64(c.b64), obs: c.obs, forecast: c.forecast, at: c.at }; aur.ovationAt = c.at; } catch {} }
  }
  if (!force && aur.ovation && Date.now() - aur.ovationAt < TTL_OVA) { emit(); return Promise.resolve(aur); }
  aur.loading.ovation = true; emit();
  ovaP = (async () => {
    const j = await getJson(URLS.ovation, 25000);
    const grid = new Uint8Array(GRID_W * GRID_H);
    for (const c of j.coordinates || []) {
      const lon = c[0] | 0, lat = c[1] | 0;
      if (lon < 0 || lon >= GRID_W || lat < -90 || lat > 90) continue;
      grid[(lat + 90) * GRID_W + lon] = Math.max(0, Math.min(255, c[2] | 0));
    }
    const o = { grid, obs: utc(j['Observation Time']), forecast: utc(j['Forecast Time']), at: Date.now() };
    aur.ovation = o; aur.ovationAt = o.at; delete aur.errors.ovation;
    lsSet(KEY_OVA, { b64: b64(grid), obs: o.obs, forecast: o.forecast, at: o.at });
  })().catch(e => { aur.errors.ovation = e; console.info('[aurora] ovation failed:', e.message); })
    .finally(() => { aur.loading.ovation = false; ovaP = null; emit(); }).then(() => aur);
  return ovaP;
}

/** For the Tonight card (js/tonight/aurora.js): Kp rows [{t, kp}], rejects when unavailable. */
export async function getKpRows() {
  if (!aur.kp || Date.now() - aur.updatedAt > TTL_SMALL) await loadSmall();
  if (!aur.kp) throw aur.errors.kp || new Error('kp unavailable');
  return aur.kp;
}
