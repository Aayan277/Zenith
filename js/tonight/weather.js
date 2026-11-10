// Hourly cloud / visibility forecast for the Tonight card (and everything that scores a night).
//
//   1. Open-Meteo (no key, CORS) is the primary source.
//   2. MET Norway Locationforecast 2.0 is the fallback when Open-Meteo answers 429 / 5xx / errors / times out.
//   Results are cached in memory and in localStorage for 30 min per location rounded to 2 decimals.
//   If both sources fail, a stored copy up to 6 h old is served (flagged `stale: true`) instead of failing the card.
//
// Resolved value (the shape every consumer relies on; the extra fields are optional metadata):
//   { tz: string, elevation: number, hours: [{ t: utc ms on the hour, cloud: 0-100, low: 0-100, vis: metres }],
//     source: 'open-meteo' | 'met.no', sourceLabel: 'Open-Meteo' | 'MET Norway',
//     tzEstimated?: true, tzGuess?: 'Etc/GMT+5' (met.no only, when the location has no tz: `tz` is '' so learnZone() ignores it
//       and js/util/time.js keeps using its own longitude estimate; `tzGuess` is the same estimate as an IANA zone),
//     stale?: true (both sources failed, this is an old stored copy), at: ms the forecast was fetched }
//
// MET Norway terms (https://api.met.no/doc/TermsOfService, checked 2026-11):
//   - Requests must identify the client with a User-Agent; "in cases where this is not possible (e.g. simple
//     cross-origin requests in Javascript) the website must instead identify itself using an Origin header".
//     Browsers send Origin automatically on cross-origin fetch, so a plain GET with no custom headers is compliant.
//     Do NOT add custom request headers: that makes the request non-simple (CORS preflight), which is "explicitly not supported".
//   - Browser use is tolerated for low-volume sites ("may use simple cross-origin Javascript requests ... provided the site
//     identifies itself"; the general advice is that browsers should use a proxy). Hence: fallback only, 30 min cache,
//     no polling. If traffic grows, route it through a caching proxy.
//   - Coordinates must be truncated to at most 4 decimals (5+ returns 403). We use 2 decimals, which also makes
//     identical requests cacheable. The 30 min client cache matches their ~30 min Expires header.
import { get as getState } from '../state.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const MET = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const TTL = 30 * 60e3, STALE_TTL = 6 * 3600e3;
const OM_TIMEOUT = 8000, MET_TIMEOUT = 10000;
const LS_KEY = 'zenith:weather:v1', LS_COOLDOWN = 'zenith:weather:om-until', LS_MAX_ENTRIES = 6;
const H = 3600e3;

const mem = new Map();

const ls = {
  get(k) { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const cleanLoc = (lat, lon) => `${(Math.round(lat * 100) / 100).toFixed(2)},${(Math.round(lon * 100) / 100).toFixed(2)}`;
const num = (v, d) => (Number.isFinite(v) ? v : d);
const pct = v => Math.max(0, Math.min(100, Math.round(num(v, 0))));

function readStored(key) { const e = (ls.get(LS_KEY) || {})[key]; return e && e.data && e.data.hours && e.at ? e : null; }
function writeStored(key, data) {
  const all = ls.get(LS_KEY) || {};
  all[key] = { at: data.at, data };
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const k of keys.slice(LS_MAX_ENTRIES)) delete all[k];
  ls.set(LS_KEY, all);
}

async function getJson(url, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    // No custom headers on purpose (see the MET Norway notes above): keeps the request "simple" (no preflight).
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) {
      const e = new Error('weather ' + res.status); e.status = res.status; e.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw e;
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') { const te = new Error('weather timeout'); te.status = 0; throw te; }
    throw e;
  } finally { clearTimeout(t); }
}

async function fromOpenMeteo(lat, lon) {
  const url = `${OM}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&hourly=cloud_cover,cloud_cover_low,visibility&timezone=auto&forecast_days=3&past_days=1`;
  const j = await getJson(url, OM_TIMEOUT);
  const off = (j.utc_offset_seconds || 0) * 1000;
  const h = j.hourly;
  const hours = h.time.map((t, i) => ({
    t: Date.parse(t + ':00Z') - off, // local wall-clock string -> true UTC ms
    cloud: h.cloud_cover[i] ?? 0, low: h.cloud_cover_low[i] ?? 0, vis: h.visibility[i] ?? 20000,
  }));
  return { tz: j.timezone || 'UTC', elevation: j.elevation, hours, source: 'open-meteo', sourceLabel: 'Open-Meteo' };
}

/** Time zone for a met.no result (the API returns none): the location's own, else only a longitude guess (see `tzGuess`). */
function zoneFor(lon) {
  let known; try { known = getState('location')?.tz; } catch {}
  if (known) { try { new Intl.DateTimeFormat('en', { timeZone: known }); return { tz: known, est: false }; } catch {} }
  const offH = Math.max(-12, Math.min(14, Math.round(lon / 15)));
  // IANA "Etc/GMT-5" means UTC+5 (sign is inverted). Etc/GMT has no "+0"/"-0" spelling.
  return { tz: offH === 0 ? 'Etc/GMT' : `Etc/GMT${offH > 0 ? '-' : '+'}${Math.abs(offH)}`, est: true };
}

/** met.no `complete` timeseries (hourly for ~2.5 days, then 6-hourly) -> hourly rows, linearly interpolated across the gaps. */
export function mapMetNo(j, lon = 0) {
  const ts = j?.properties?.timeseries;
  if (!Array.isArray(ts) || !ts.length) throw new Error('met.no: empty timeseries');
  const pts = [];
  for (const e of ts) {
    const d = e?.data?.instant?.details, t = Date.parse(e?.time);
    if (!d || !Number.isFinite(t) || !Number.isFinite(d.cloud_area_fraction)) continue;
    const cloud = d.cloud_area_fraction;
    // Without low/medium/high (compact endpoint) all we can say is "total": treat it as low cloud too (conservative).
    const low = Number.isFinite(d.cloud_area_fraction_low) ? d.cloud_area_fraction_low : cloud;
    // met.no has no visibility. Fog fraction is the nearest thing: 0 % fog = clear (24 km, Open-Meteo's usual cap), 100 % = 200 m.
    const vis = Number.isFinite(d.fog_area_fraction) ? Math.max(200, 24000 * (1 - d.fog_area_fraction / 100)) : 24000;
    pts.push({ t, cloud, low, vis });
  }
  if (!pts.length) throw new Error('met.no: no cloud data');
  pts.sort((a, b) => a.t - b.t);
  const hours = [];
  const push = (t, a, b, k) => hours.push({
    t, cloud: pct(a.cloud + (b.cloud - a.cloud) * k), low: pct(a.low + (b.low - a.low) * k), vis: Math.round(a.vis + (b.vis - a.vis) * k),
  });
  // The first entry is the next whole hour: cover the previous two hours too so "next 12 h" has no hole at the start.
  const first = Math.ceil(pts[0].t / H) * H;
  for (let i = 2; i >= 1; i--) push(first - i * H, pts[0], pts[0], 0);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (!b) { push(Math.round(a.t / H) * H, a, a, 0); break; }
    const steps = Math.max(1, Math.round((b.t - a.t) / H));
    for (let s = 0; s < steps; s++) push(Math.round((a.t + s * H) / H) * H, a, b, s / steps);
  }
  const z = zoneFor(lon);
  const coords = j.geometry?.coordinates;
  // An estimated zone must NOT be returned as `tz`: tonight.js calls learnZone(w.tz), which would save a wrong fixed-offset zone
  // (no DST, e.g. Etc/GMT for London in summer) into the user's prefs. '' is ignored by learnZone and time.js falls back to lon/15.
  const out = { tz: z.est ? '' : z.tz, elevation: Array.isArray(coords) ? num(coords[2], 0) : 0, hours, source: 'met.no', sourceLabel: 'MET Norway' };
  if (z.est) { out.tzEstimated = true; out.tzGuess = z.tz; }
  return out;
}

async function fromMetNo(lat, lon) {
  const rl = Math.round(lat * 100) / 100, ro = Math.round(lon * 100) / 100;   // 2 decimals (terms: max 4)
  const j = await getJson(`${MET}?lat=${rl.toFixed(2)}&lon=${ro.toFixed(2)}`, MET_TIMEOUT);
  return mapMetNo(j, ro);
}

async function load(lat, lon, key) {
  const cooldown = ls.get(LS_COOLDOWN) || 0;
  let omErr;
  if (cooldown > Date.now()) omErr = Object.assign(new Error('weather 429 (cooling down)'), { status: 429 });
  else {
    try { return await fromOpenMeteo(lat, lon); }
    catch (e) {
      omErr = e;
      // Rate limited: stop hitting Open-Meteo from this browser for a while (Retry-After, clamped to 5-30 min).
      if (e.status === 429) ls.set(LS_COOLDOWN, Date.now() + Math.max(300, Math.min(1800, e.retryAfter || 600)) * 1000);
    }
  }
  try { return await fromMetNo(lat, lon); }
  catch (e2) {
    const old = readStored(key);
    if (old && Date.now() - old.at < STALE_TTL) { console.info('[weather] both sources failed, serving stored forecast'); return { ...old.data, stale: true }; }
    throw omErr || e2;
  }
}

/** @returns {Promise<{tz:string, elevation:number, hours:{t:number, cloud:number, low:number, vis:number}[], source:string, sourceLabel:string, at:number}>} */
export function fetchWeather(lat, lon) {
  const key = cleanLoc(lat, lon);
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const stored = readStored(key);
  if (stored && Date.now() - stored.at < TTL) {
    const p = Promise.resolve(stored.data);
    mem.set(key, { at: stored.at, p });
    return p;
  }
  const p = load(lat, lon, key).then(d => {
    const data = { ...d, at: d.at || Date.now() };
    if (!data.stale) writeStored(key, data);
    return data;
  });
  mem.set(key, { at: Date.now(), p });
  p.catch(() => mem.delete(key));
  return p;
}
