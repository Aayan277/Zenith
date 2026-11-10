// Live Sun data: NASA SDO imagery (hotlinked <img>, no CORS needed) + NOAA SWPC JSON (CORS ok, no key).
// Nothing loads until Sun content is opened (detail panel, Aurora "Sun now" card, dashboard).
//
// Endpoints (sizes measured Nov 2026):
//   flareNow  json/goes/primary/xray-flares-latest.json        0.5 KB   current class + latest flare   (TTL 2 min)
//   wind      products/summary/solar-wind-speed.json           0.1 KB   proton speed km/s              (TTL 2 min)
//   flares    json/goes/primary/xray-flares-7-day.json          49 KB   flare list                     (TTL 10 min)
//   regions   json/solar_regions.json                          107 KB   30 days of AR rows, newest used (TTL 30 min)
//   xray      json/goes/primary/xrays-1-day.json               656 KB   1-min flux, 2 bands; dashboard only (TTL 5 min)
//   cycle     json/solar-cycle/sunspots.json (127 KB) + predicted-solar-cycle.json (17 KB); dashboard only (TTL 12 h)
// Reduced results are cached in memory and localStorage (a few KB each), every request has a timeout and fails softly.
import { lsGet, lsSet } from '../ui/notify.js';

const BASE = 'https://services.swpc.noaa.gov';
const J = p => BASE + '/' + p;
const KEY = 'zenith:sun:v1', KEY_XR = 'zenith:sun:xray:v1', KEY_CY = 'zenith:sun:cycle:v1', KEY_F = 'zenith:sun:filter';

export const FILTERS = [
  { id: '0193', label: '193 Å', name: 'Corona', color: '#e8b64a',
    blurb: 'Hot coronal plasma at ~1.2 million °C (flares reach 20 million). Dark patches are coronal holes, the source of fast solar wind that can spark aurora.' },
  { id: '0171', label: '171 Å', name: 'Coronal loops', color: '#f2d36b',
    blurb: 'Coronal loops at ~600,000 °C. Glowing arches trace magnetic field lines above active regions, the best view of the quiet corona.' },
  { id: '0304', label: '304 Å', name: 'Chromosphere', color: '#ff6b57',
    blurb: 'The chromosphere and transition region at ~50,000 °C. Prominences and filaments loop off the limb; bright patches mark active regions.' },
  { id: 'HMIIC', label: 'Visible', name: 'Sunspots', color: '#ff9a3c',
    blurb: 'The Sun as a filtered telescope sees it (~5,500 °C surface). Dark sunspots are cooler, magnetically knotted patches, and big groups are flare factories.' },
  { id: 'HMIBC', label: 'Magnetogram', name: 'Magnetic field', color: '#c3cde0',
    blurb: 'Surface magnetic polarity: white is north, black is south. Tight, tangled white/black pairs are the regions most likely to flare.' },
];
export const sdoUrl = (id, size = 512) => `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_${size}_${id}.jpg?z=${Math.floor(Date.now() / 900e3)}`;

let filterIdx = Math.max(0, Math.min(FILTERS.length - 1, lsGet(KEY_F, 0) | 0));
export const getFilter = () => filterIdx;
export function setFilter(i) { filterIdx = ((i % FILTERS.length) + FILTERS.length) % FILTERS.length; lsSet(KEY_F, filterIdx); emit(); return filterIdx; }

// ---- flare classes ----------------------------------------------------------------------------------------------------
export const BANDS = [
  { k: 'A', lo: 1e-8, hi: 1e-7, color: '#8da2c8' },
  { k: 'B', lo: 1e-7, hi: 1e-6, color: '#5ce1ff' },
  { k: 'C', lo: 1e-6, hi: 1e-5, color: '#ffd166' },
  { k: 'M', lo: 1e-5, hi: 1e-4, color: '#ff9a4d' },
  { k: 'X', lo: 1e-4, hi: 1e-3, color: '#ff5c7a' },
];
const BASEF = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };
export function classOf(flux) {
  if (!(flux > 0)) return null;
  const k = flux >= 1e-4 ? 'X' : flux >= 1e-5 ? 'M' : flux >= 1e-6 ? 'C' : flux >= 1e-7 ? 'B' : 'A', n = flux / BASEF[k];
  return { k, n, flux, label: k + (n >= 10 ? Math.round(n) : n.toFixed(1)), color: BANDS.find(b => b.k === k).color };
}
export function parseClass(s) {
  const m = /^([ABCMX])(\d+(?:\.\d+)?)$/.exec(String(s || '').trim());
  return m ? BASEF[m[1]] * parseFloat(m[2]) : NaN;
}
export const classColor = s => (classOf(parseClass(s)) || { color: '#8da2c8' }).color;
export const fmtFlux = f => { const e = Math.floor(Math.log10(f)); return (f / 10 ** e).toFixed(1) + 'e' + String(e).replace('-', '−'); };

// ---- store ----------------------------------------------------------------------------------------------------------------
export const sun = {
  flareNow: null,   // { cls: 'B9.8', flux, maxClass, maxAt, beginAt, endAt }
  wind: null,       // { speed km/s, t }
  flares: null,     // [{ b, m, e, c (max class), bc, flux }] ms, newest last
  regions: null,    // [{ n, loc, spots, cls, mag, area, c, m, x, status }]
  regionsDate: '',
  xray: null,       // { t: ms[], f: flux[] } 0.1-0.8 nm, 1-min
  cycle: null,      // { obs: [[ms, ssn]], pred: [[ms, p, lo, hi]] }
  t: {},            // part -> last success ms
  errors: {}, loading: {}, imgOk: null,
};
const subs = new Set();
export const onSun = fn => { subs.add(fn); return () => subs.delete(fn); };
function emit() { for (const fn of subs) { try { fn(sun); } catch (e) { console.error('[sun]', e); } } }

const utc = s => Date.parse(String(s || '').replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
async function getJson(url, ms = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ---- reducers (raw JSON -> small cached shapes) -----------------------------------------------------------------
const red = {
  flareNow(j) {
    const r = Array.isArray(j) ? j[0] : null; if (!r) throw new Error('empty');
    return { cls: r.current_class, flux: parseClass(r.current_class), maxClass: r.max_class, maxAt: utc(r.max_time), beginAt: utc(r.begin_time), endAt: utc(r.end_time), at: utc(r.time_tag) };
  },
  wind(j) { const r = Array.isArray(j) ? j[0] : null; if (!r || !Number.isFinite(+r.proton_speed)) throw new Error('empty'); return { speed: +r.proton_speed, t: utc(r.time_tag) }; },
  flares(j) {
    return (j || []).map(r => ({ b: utc(r.begin_time), m: utc(r.max_time), e: utc(r.end_time), c: r.max_class, bc: r.begin_class, flux: parseClass(r.max_class) }))
      .filter(r => Number.isFinite(r.m) && Number.isFinite(r.flux)).sort((a, b) => a.m - b.m);
  },
  regions(j) {
    const rows = Array.isArray(j) ? j : [];
    const date = rows.reduce((a, r) => (r.observed_date > a ? r.observed_date : a), '');
    return { date, list: rows.filter(r => r.observed_date === date).map(r => ({ n: r.region, loc: r.location, spots: r.number_spots, cls: r.spot_class || '', mag: r.mag_class || '', area: r.area,
      c: r.c_flare_probability, m: r.m_flare_probability, x: r.x_flare_probability, status: r.status })) };
  },
};
const PARTS = {
  flareNow: { url: J('json/goes/primary/xray-flares-latest.json'), ttl: 2 * 60e3 },
  wind: { url: J('products/summary/solar-wind-speed.json'), ttl: 2 * 60e3 },
  flares: { url: J('json/goes/primary/xray-flares-7-day.json'), ttl: 10 * 60e3 },
  regions: { url: J('json/solar_regions.json'), ttl: 30 * 60e3 },
};
export const LITE = ['flareNow', 'wind'], FULL = ['flareNow', 'wind', 'flares', 'regions'];

try {
  const c = lsGet(KEY, null);
  if (c) { sun.flareNow = c.flareNow || null; sun.wind = c.wind || null; sun.flares = c.flares || null; sun.regions = c.regions || null; sun.regionsDate = c.regionsDate || ''; sun.t = c.t || {}; }
} catch {}
const persist = () => lsSet(KEY, { t: sun.t, flareNow: sun.flareNow, wind: sun.wind, flares: sun.flares, regions: sun.regions, regionsDate: sun.regionsDate });

const inflight = {}, tried = {};
/** Refresh the given parts whose TTL has lapsed (a failed part is not retried for 60 s). Resolves when they settle. */
export function ensure(parts = FULL) {
  const jobs = [];
  for (const name of parts) {
    const P = PARTS[name], now = Date.now();
    if (inflight[name]) { jobs.push(inflight[name]); continue; }
    if (sun[name] && now - (sun.t[name] || 0) < P.ttl) continue;
    if (now - (tried[name] || 0) < 60e3) continue;
    tried[name] = now; sun.loading[name] = true;
    inflight[name] = getJson(P.url).then(j => {
      const v = red[name](j);
      if (name === 'regions') { sun.regions = v.list; sun.regionsDate = v.date; } else sun[name] = v;
      sun.t[name] = Date.now(); delete sun.errors[name]; persist();
    }).catch(e => { sun.errors[name] = e; console.info('[sun]', name, 'failed:', e.message); })
      .finally(() => { delete inflight[name]; sun.loading[name] = false; emit(); });
    jobs.push(inflight[name]);
  }
  if (jobs.length) emit();
  return Promise.all(jobs);
}

/** Forget TTLs and failure back-off (dashboard "refresh"). */
export function invalidate() { sun.t = {}; for (const k of Object.keys(tried)) delete tried[k]; }

/** SDO <img> reachability probe, so a dead host never leaves a broken image in the panel. */
let probing = false;
export function probeSdo() {
  if (probing || sun.imgOk !== null) return; probing = true;
  const im = new Image();
  im.onload = () => { sun.imgOk = true; emit(); };
  im.onerror = () => { sun.imgOk = false; probing = false; emit(); setTimeout(() => { sun.imgOk = null; }, 5 * 60e3); };
  im.src = sdoUrl('0193', 512);
}

// ---- dashboard-only data -------------------------------------------------------------------------------------------
let xrP = null;
export function loadXray({ force = false } = {}) {
  if (xrP) return xrP;
  if (!sun.xray) { const c = lsGet(KEY_XR, null); if (c?.t?.length) { sun.xray = { t: c.t.map(m => m * 60e3), f: c.f }; sun.t.xray = c.at; } }
  if (!force && sun.xray && Date.now() - (sun.t.xray || 0) < 5 * 60e3) return Promise.resolve(sun);
  sun.loading.xray = true; emit();
  xrP = getJson(J('json/goes/primary/xrays-1-day.json'), 25000).then(j => {
    const t = [], f = [];
    for (const r of j) { if (r.energy !== '0.1-0.8nm') continue; const ms = utc(r.time_tag), v = +r.flux; if (Number.isFinite(ms) && v > 0) { t.push(ms); f.push(+v.toPrecision(3)); } }
    if (t.length < 10) throw new Error('no data');
    sun.xray = { t, f }; sun.t.xray = Date.now(); delete sun.errors.xray;
    lsSet(KEY_XR, { at: sun.t.xray, t: t.map(x => Math.round(x / 60e3)), f });
  }).catch(e => { sun.errors.xray = e; }).finally(() => { sun.loading.xray = false; xrP = null; emit(); }).then(() => sun);
  return xrP;
}

let cyP = null;
export function loadCycle() {
  if (cyP) return cyP;
  if (!sun.cycle) { const c = lsGet(KEY_CY, null); if (c?.cycle) { sun.cycle = c.cycle; sun.t.cycle = c.at; } }
  if (sun.cycle && Date.now() - (sun.t.cycle || 0) < 12 * 3600e3) return Promise.resolve(sun);
  sun.loading.cycle = true; emit();
  const ym = s => { const [y, m] = String(s).split('-'); return Date.UTC(+y, +m - 1, 15); };
  cyP = Promise.all([getJson(J('json/solar-cycle/sunspots.json'), 25000), getJson(J('json/solar-cycle/predicted-solar-cycle.json')).catch(() => [])]).then(([o, p]) => {
    const obs = o.filter(r => r['time-tag'] >= '1995-01' && r.ssn >= 0).map(r => [ym(r['time-tag']), r.ssn]);
    if (obs.length < 12) throw new Error('no data');
    const pred = (p || []).map(r => [ym(r['time-tag']), r.predicted_ssn, r.low_ssn, r.high_ssn]).filter(r => Number.isFinite(r[1]));
    sun.cycle = { obs, pred }; sun.t.cycle = Date.now(); delete sun.errors.cycle;
    lsSet(KEY_CY, { at: sun.t.cycle, cycle: sun.cycle });
  }).catch(e => { sun.errors.cycle = e; }).finally(() => { sun.loading.cycle = false; cyP = null; emit(); }).then(() => sun);
  return cyP;
}

// ---- derived summary ---------------------------------------------------------------------------------------------------
const H24 = 24 * 3600e3;
const art = w => (/^[AEFHILMNORSX]/.test(w) ? 'an' : 'a');
/** Everything the panels show, computed from whatever has loaded so far (fields are null until then). */
export function status(now = Date.now()) {
  const fn = sun.flareNow, cur = fn ? classOf(fn.flux) : null;
  const recent = (sun.flares || []).filter(f => f.m >= now - H24);
  const big = recent.reduce((a, f) => (!a || f.flux > a.flux ? f : a), null);
  const live = (sun.regions || []).filter(r => r.status !== 'd');
  const groups = live.filter(r => r.spots > 0);
  const spots = groups.reduce((a, r) => a + r.spots, 0);
  const maxFlux = Math.max(big ? big.flux : 0, cur ? cur.flux : 0);
  const word = cur && cur.flux >= 1e-5 ? 'Flaring' : (cur && cur.flux >= 1e-6) || maxFlux >= 1e-5 ? 'Active' : 'Quiet';
  const tier = maxFlux >= 1e-4 ? 'very active' : maxFlux >= 1e-5 ? 'fairly active' : maxFlux >= 1e-6 ? 'mildly active' : 'quiet';
  return {
    cur, word, big, recent, live, groups, spots,
    ssn: sun.regions ? groups.length * 10 + spots : null,   // Wolf-style estimate from today's region table
    wind: sun.wind?.speed ?? null, tier,
    ready: !!(sun.flareNow && sun.regions),
    maxFlux,
  };
}
export function summaryText(st, fmtTime) {
  if (!sun.flareNow) return '';
  const bigTxt = st.big && st.big.flux >= 1e-6 ? `${art(st.big.c)} ${st.big.c} flare${fmtTime ? ' at ' + fmtTime(st.big.m) : ''}` : 'no flares above C-class';
  const groups = sun.regions ? ` and ${st.groups.length} sunspot group${st.groups.length === 1 ? '' : 's'}` : '';
  return `The Sun is ${st.tier} today: ${bigTxt}${groups}. Aurora chances rise 1–3 days after big flares/CMEs.`;
}
