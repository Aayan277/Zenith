// Satellite feed for the sky view: consumes propagator ticks, converts ECEF to
// the observer's ENU frame and extrapolates between ticks.
import * as state from '../state.js';
import { getSat, satrec } from '../data/catalog.js';
import { D2R } from './astro.js';

const CAT_KEYS = Object.keys(state.CATEGORIES);
const CAT_INDEX = Object.fromEntries(CAT_KEYS.map((k, i) => [k, i]));
export { CAT_KEYS };

let obs = { lat: 0, lon: 0, ecef: [0, 0, 0], sinLat: 0, cosLat: 1, sinLon: 0, cosLon: 1 };
export function setObserver(loc) {
  const a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lat = loc.lat * D2R, lon = loc.lon * D2R, h = (loc.elevM || 0) / 1000;
  const sL = Math.sin(lat), cL = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sL * sL);
  obs = {
    lat, lon, sinLat: sL, cosLat: cL, sinLon: Math.sin(lon), cosLon: Math.cos(lon),
    ecef: [(N + h) * cL * Math.cos(lon), (N + h) * cL * Math.sin(lon), (N * (1 - e2) + h) * sL],
  };
}
// ECEF km -> ENU km relative to observer
export function ecefToEnu(x, y, z, out = [0, 0, 0]) {
  const dx = x - obs.ecef[0], dy = y - obs.ecef[1], dz = z - obs.ecef[2];
  out[0] = -obs.sinLon * dx + obs.cosLon * dy;
  out[1] = -obs.sinLat * obs.cosLon * dx - obs.sinLat * obs.sinLon * dy + obs.cosLat * dz;
  out[2] = obs.cosLat * obs.cosLon * dx + obs.cosLat * obs.sinLon * dy + obs.sinLat * dz;
  return out;
}

let cap = 0;
let E, N, U, VE, VN, VU;      // current ENU (km) and velocity (km/s)
let cat, lit, ids;
let vis, nVis = 0;            // indices of sats above horizon
let tickTime = 0, tickDt = 0, n = 0;
let hasData = false, catReady = false, lastIdsKey = '';
let idToIdx = new Map();

// frame output (reused)
export const frame = {
  count: 0, idx: new Int32Array(0), dx: new Float32Array(0), dy: new Float32Array(0), dz: new Float32Array(0),
  range: new Float32Array(0), cat: new Uint8Array(0), lit: new Uint8Array(0), ids: null,
};

function ensure(m) {
  if (m <= cap) return;
  cap = Math.ceil(m * 1.2);
  E = new Float32Array(cap); N = new Float32Array(cap); U = new Float32Array(cap);
  VE = new Float32Array(cap); VN = new Float32Array(cap); VU = new Float32Array(cap);
  cat = new Uint8Array(cap); lit = new Uint8Array(cap); vis = new Int32Array(cap);
  frame.idx = new Int32Array(cap); frame.dx = new Float32Array(cap); frame.dy = new Float32Array(cap);
  frame.dz = new Float32Array(cap); frame.range = new Float32Array(cap); frame.cat = new Uint8Array(cap);
  frame.lit = new Uint8Array(cap);
  lastIdsKey = '';
}

function onTick(tick) {
  const m = tick.count ?? tick.ids.length;
  const prevCap = cap;
  ensure(m);
  const first = !hasData || prevCap !== cap;
  const dt = (tick.time - tickTime) / 1000;
  const sameOrder = hasData && n === m && ids && ids[0] === tick.ids[0] && ids[m - 1] === tick.ids[m - 1] && ids[m >> 1] === tick.ids[m >> 1];
  const useVel = sameOrder && dt !== 0 && Math.abs(dt) < 120 && !first;
  const ec = tick.ecef, tmp = [0, 0, 0];
  nVis = 0;
  for (let i = 0; i < m; i++) {
    ecefToEnu(ec[i * 3], ec[i * 3 + 1], ec[i * 3 + 2], tmp);
    if (useVel) { VE[i] = (tmp[0] - E[i]) / dt; VN[i] = (tmp[1] - N[i]) / dt; VU[i] = (tmp[2] - U[i]) / dt; }
    else { VE[i] = VN[i] = VU[i] = 0; }
    E[i] = tmp[0]; N[i] = tmp[1]; U[i] = tmp[2];
    lit[i] = tick.sunlit ? tick.sunlit[i] : 1;
    const r = Math.hypot(tmp[0], tmp[1], tmp[2]);
    if (tmp[2] > -0.03 * r) vis[nVis++] = i;
  }
  const key = m + ':' + tick.ids[0] + ':' + tick.ids[m - 1];
  if (key !== lastIdsKey || !catReady) {
    lastIdsKey = key; idToIdx = new Map();
    let ok = false;
    for (let i = 0; i < m; i++) {
      const s = getSat(tick.ids[i]); if (s) ok = true;
      cat[i] = s && CAT_INDEX[s.cat] !== undefined ? CAT_INDEX[s.cat] : CAT_INDEX.other;
    }
    catReady = ok;
  }
  ids = tick.ids; n = m; tickTime = tick.time; tickDt = Math.abs(dt);
  hasData = true;
}

let propMod = null, off = null;
export async function initSats() {
  try { propMod = await import('../data/propagator.js'); }
  catch (e) { console.warn('[sky] propagator unavailable', e.message); }
  state.on('catalogReady', () => { catReady = false; lastIdsKey = ''; });
}
// Subscribe only while the sky view is visible (the worker runs only while someone listens).
export function setActive(active) {
  if (!propMod) return;
  if (active && !off) { off = propMod.onTick(onTick); const last = propMod.getLatest?.(); if (last) onTick(last); }
  else if (!active && off) { off(); off = null; }
}

// Build the per-frame list of visible, filter-passing, projected-ready sats.
export function getFrame(simNow, filters, includeShadow, selectedId) {
  let c = 0;
  if (!hasData) { frame.count = 0; return frame; }
  const span = Math.max(1.5, 3 * tickDt);
  let dtx = (simNow - tickTime) / 1000; dtx = Math.max(-span, Math.min(span, dtx));
  const allow = CAT_KEYS.map(k => filters[k] !== false);
  for (let j = 0; j < nVis; j++) {
    const i = vis[j];
    const isSel = selectedId != null && ids[i] === selectedId;
    if (!isSel) {
      if (!allow[cat[i]]) continue;
      if (!lit[i] && !includeShadow) continue;
    }
    const e = E[i] + VE[i] * dtx, nn = N[i] + VN[i] * dtx, u = U[i] + VU[i] * dtx;
    const r = Math.hypot(e, nn, u);
    if (u < -0.02 * r) continue;
    frame.idx[c] = i; frame.dx[c] = e / r; frame.dy[c] = nn / r; frame.dz[c] = u / r;
    frame.range[c] = r; frame.cat[c] = cat[i]; frame.lit[c] = lit[i];
    c++;
  }
  frame.count = c; frame.ids = ids;
  return frame;
}

export function satPosition(id, simNow) {
  if (!hasData) return null;
  let i = -1;
  for (let k = 0; k < n; k++) if (ids[k] === id) { i = k; break; }
  if (i < 0) return null;
  const span = Math.max(1.5, 3 * tickDt);
  const dtx = Math.max(-span, Math.min(span, (simNow - tickTime) / 1000));
  const e = E[i] + VE[i] * dtx, nn = N[i] + VN[i] * dtx, u = U[i] + VU[i] * dtx;
  const r = Math.hypot(e, nn, u);
  return { e: e / r, n: nn / r, u: u / r, range: r, lit: !!lit[i] };
}
export const hasSatData = () => hasData;

// Ground-track in the sky: ENU unit vectors for [t0, t1], using satellite.js
export function skyTrack(satId, t0, t1, stepSec) {
  const sat = window.satellite; if (!sat) return [];
  let rec; try { rec = satrec(satId); } catch { return []; }
  if (!rec) return [];
  const out = [], tmp = [0, 0, 0];
  for (let t = t0; t <= t1; t += stepSec * 1000) {
    const d = new Date(t);
    const pv = sat.propagate(rec, d);
    if (!pv.position) continue;
    const ecf = sat.eciToEcf(pv.position, sat.gstime(d));
    ecefToEnu(ecf.x, ecf.y, ecf.z, tmp);
    const r = Math.hypot(tmp[0], tmp[1], tmp[2]);
    out.push({ e: tmp[0] / r, n: tmp[1] / r, u: tmp[2] / r, t, range: r });
  }
  return out;
}
