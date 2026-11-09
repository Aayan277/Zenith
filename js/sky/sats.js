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
let cat, lit, ids, hi, valid, hasPrev;
let vis, nVis = 0;            // indices of sats above horizon
let tickTime = 0, tickDt = 0, n = 0;
let hasData = false, catDirty = true;
let slotIds = null;           // propagator slot table the arrays below are aligned with

// frame output (reused)
export const frame = {
  count: 0, idx: new Int32Array(0), dx: new Float32Array(0), dy: new Float32Array(0), dz: new Float32Array(0),
  range: new Float32Array(0), cat: new Uint8Array(0), lit: new Uint8Array(0), ids: null,
};

function alloc(m) {
  cap = Math.ceil(m * 1.1) + 16;
  E = new Float32Array(cap); N = new Float32Array(cap); U = new Float32Array(cap);
  VE = new Float32Array(cap); VN = new Float32Array(cap); VU = new Float32Array(cap);
  cat = new Uint8Array(cap); hi = new Uint8Array(cap); lit = new Uint8Array(cap); vis = new Int32Array(cap);
  valid = new Uint8Array(cap); hasPrev = new Uint8Array(cap);
  frame.idx = new Int32Array(cap); frame.dx = new Float32Array(cap); frame.dy = new Float32Array(cap);
  frame.dz = new Float32Array(cap); frame.range = new Float32Array(cap); frame.cat = new Uint8Array(cap);
  frame.lit = new Uint8Array(cap);
}

/** The slot table changed (catalog grew): re-align arrays, carrying positions of sats we already tracked. */
function realign(tick, m) {
  const old = { ids: slotIds, n, E, N, U, valid };
  if (m > cap || !E) alloc(m);
  else { /* arrays are reused below; old values are copied through temporaries first */ }
  if (old.ids && hasData) {
    const idx = new Map();
    for (let k = 0; k < old.n; k++) if (old.valid[k]) idx.set(old.ids[k], k);
    // E/N/U may alias the new arrays when capacity sufficed: snapshot first
    const sE = Float32Array.from(old.E.subarray(0, old.n)), sN = Float32Array.from(old.N.subarray(0, old.n)), sU = Float32Array.from(old.U.subarray(0, old.n));
    for (let i = 0; i < m; i++) {
      const o = idx.get(tick.ids[i]);
      if (o === undefined) { hasPrev[i] = 0; E[i] = N[i] = U[i] = 0; }
      else { hasPrev[i] = 1; E[i] = sE[o]; N[i] = sN[o]; U[i] = sU[o]; }
    }
  } else hasPrev.fill(0, 0, m);
  slotIds = tick.ids;
  catDirty = true;
}

function refreshCats(m) {
  catDirty = false;
  for (let i = 0; i < m; i++) {
    const s = getSat(ids[i]);
    hi[i] = s && (s.notable || s.bright || s.size === 'L') ? 1 : 0;
    cat[i] = s && CAT_INDEX[s.cat] !== undefined ? CAT_INDEX[s.cat] : CAT_INDEX.other;
  }
}

let seq = 0;
/** Counter of ticks consumed (cheap change detection for label layout). */
export const tickSeq = () => seq;
const tmpEnu = [0, 0, 0];
function onTick(tick) {
  const m = tick.count ?? tick.ids.length;
  if (tick.ids !== slotIds) realign(tick, m);
  ids = tick.ids;
  const dt = (tick.time - tickTime) / 1000;
  const useVel = hasData && dt !== 0 && Math.abs(dt) < 120;
  const ec = tick.ecef, sl = tick.sunlit, tmp = tmpEnu;
  const ox = obs.ecef[0], oy = obs.ecef[1], oz = obs.ecef[2], sLo = obs.sinLon, cLo = obs.cosLon, sLa = obs.sinLat, cLa = obs.cosLat;
  nVis = 0;
  for (let i = 0, j = 0; i < m; i++, j += 3) {
    const x = ec[j], y = ec[j + 1], z = ec[j + 2];
    if (x === 0 && y === 0 && z === 0) { valid[i] = 0; hasPrev[i] = 0; continue; }   // no position this tick
    const dx = x - ox, dy = y - oy, dz = z - oz;
    const e = -sLo * dx + cLo * dy;
    const nn = -sLa * cLo * dx - sLa * sLo * dy + cLa * dz;
    const u = cLa * cLo * dx + cLa * sLo * dy + sLa * dz;
    if (useVel && hasPrev[i]) { const k = 1 / dt; VE[i] = (e - E[i]) * k; VN[i] = (nn - N[i]) * k; VU[i] = (u - U[i]) * k; }
    else { VE[i] = VN[i] = VU[i] = 0; }
    E[i] = e; N[i] = nn; U[i] = u; valid[i] = 1; hasPrev[i] = 1;
    lit[i] = sl[i];
    if (u > -0.03 * Math.sqrt(e * e + nn * nn + u * u)) vis[nVis++] = i;
  }
  if (catDirty) refreshCats(m);
  n = m; tickTime = tick.time; tickDt = Math.abs(dt);
  hasData = true; seq++;
}

let propMod = null, off = null;
export async function initSats() {
  try { propMod = await import('../data/propagator.js'); }
  catch (e) { console.warn('[sky] propagator unavailable', e.message); }
  state.on('catalogReady', () => { catDirty = true; });
}
// Subscribe only while the sky view is visible (the worker runs only while someone listens).
export function setActive(active) {
  if (!propMod) return;
  if (active && !off) { off = propMod.onTick(onTick); const last = propMod.getLatest?.(); if (last) onTick(last); }
  else if (!active && off) { off(); off = null; }
}

// Build the per-frame list of visible, filter-passing, projected-ready sats. No allocation: the output buffers are reused.
const allow = new Uint8Array(CAT_KEYS.length);
export function getFrame(simNow, filters, includeShadow, selectedId) {
  let c = 0;
  if (!hasData) { frame.count = 0; return frame; }
  const span = Math.max(1.5, 3 * tickDt);
  let dtx = (simNow - tickTime) / 1000; dtx = Math.max(-span, Math.min(span, dtx));
  for (let k = 0; k < allow.length; k++) allow[k] = filters[CAT_KEYS[k]] !== false ? 1 : 0;
  const hlOnly = !!state.get('highlightsOnly');
  const sel = selectedId != null ? selectedId : -1;
  const fi = frame.idx, fx = frame.dx, fy = frame.dy, fz = frame.dz, fr = frame.range, fc = frame.cat, fl = frame.lit;
  for (let j = 0; j < nVis; j++) {
    const i = vis[j];
    if (ids[i] !== sel) {
      if (!allow[cat[i]]) continue;
      if (hlOnly && !hi[i]) continue;
      if (!lit[i] && !includeShadow) continue;
    }
    const e = E[i] + VE[i] * dtx, nn = N[i] + VN[i] * dtx, u = U[i] + VU[i] * dtx;
    const r = Math.sqrt(e * e + nn * nn + u * u);
    if (u < -0.02 * r) continue;
    const ir = 1 / r;
    fi[c] = i; fx[c] = e * ir; fy[c] = nn * ir; fz[c] = u * ir;
    fr[c] = r; fc[c] = cat[i]; fl[c] = lit[i];
    c++;
  }
  frame.count = c; frame.ids = ids;
  return frame;
}

export function satPosition(id, simNow) {
  if (!hasData) return null;
  let i = -1;
  for (let k = 0; k < n; k++) if (ids[k] === id) { i = k; break; }
  if (i < 0 || !valid[i]) return null;
  const span = Math.max(1.5, 3 * tickDt);
  const dtx = Math.max(-span, Math.min(span, (simNow - tickTime) / 1000));
  const e = E[i] + VE[i] * dtx, nn = N[i] + VN[i] * dtx, u = U[i] + VU[i] * dtx;
  const r = Math.sqrt(e * e + nn * nn + u * u);
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
