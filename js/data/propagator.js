// Shared propagation engine. One Web Worker propagates the whole catalog with SGP4;
// every view subscribes with onTick(). The worker runs only while somebody listens AND the tab is visible.
//
//   const off = onTick(tick => …);   // tick = { time, ids, ecef, sunlit, count, sun, ms, seq, gen }
//   getLatest()                      // last tick or null
//   ecefToTopo(ecefKm, lat, lon, elevM) -> { az, el, rangeKm }   (degrees)
//
// Contract (see also js/workers/propagate.worker.js):
//  * index i <-> ids[i] <-> ecef[3i..3i+2] <-> sunlit[i]; `count` === ids.length.
//  * `ids` is the SAME object for every tick of a catalog generation (compare by identity to detect a
//    catalog change; it changes when the catalog grows). Slot order is the catalog order of the usable sats.
//  * ecef (0,0,0) = no position this tick (sat filtered out by the layer filters, decayed, or sgp4 error).
//  * ecef/sunlit buffers are pooled: read them inside the callback and do not keep them. getLatest() stays
//    valid until the next tick arrives.
//  * tick.time is the sim time (ms) the positions are valid for. It is one tick interval ahead of the clock
//    so views interpolate between the previous tick and this one (no extrapolation).
//  * the tick rate adapts: ~1 Hz at 1x (interpolation hides it), faster at higher sim rates.
import * as state from '../state.js';
import { CATEGORIES } from '../state.js';
import { now, getRate } from '../clock.js';
import { loadCatalog, allSats } from './catalog.js';
import { isHidden, onVisibility } from '../util/governor.js';

const CAT_KEYS = Object.keys(CATEGORIES);
const ISS_ID = 25544;

let worker = null;
let ready = false;            // worker has a slot table for curGen
let creating = false;
let inflight = false;
let seq = 0;
let timer = 0, timerMs = 0;
let latest = null;
let wantGen = 0, curGen = 0;
let curIds = null;
let maskDirty = false;
const idsByGen = new Map();
const sent = new Set();       // ids whose TLE the worker already has
const recycle = [];           // stale tick buffers to hand back to the worker pool
const subs = new Set();
const stats = { ticks: 0, msSum: 0, lastMs: 0, syncs: 0 };

export function getTickIntervalMs() {
  const r = Math.abs(getRate());
  return r <= 1.5 ? 1000 : r <= 15 ? 500 : 100;
}

function ensureWorker() {
  if (worker || creating) return;
  creating = true;
  loadCatalog().then(() => {
    worker = new Worker(new URL('../workers/propagate.worker.js', import.meta.url));
    worker.onmessage = onMessage;
    worker.onerror = (e) => { console.error('[propagator] worker error', e.message || e); inflight = false; };
    syncCatalog();
  }).catch(e => { console.error('[propagator] catalog failed', e); creating = false; });
}

/** Send the current catalog to the worker. Only TLEs it has not seen travel; the slot order is re-sent. */
function syncCatalog() {
  if (!worker) return;
  const list = allSats();
  const n = list.length;
  const order = new Int32Array(n), cats = new Uint8Array(n), hl = new Uint8Array(n);
  const addIds = [], add = [];
  for (let i = 0; i < n; i++) {
    const s = list[i];
    order[i] = s.id;
    let c = CAT_KEYS.indexOf(s.cat); if (c < 0) c = CAT_KEYS.indexOf('other');
    cats[i] = c;
    hl[i] = (s.notable || s.bright || s.size === 'L') ? 1 : 0;
    if (!sent.has(s.id)) { sent.add(s.id); addIds.push(s.id); add.push(s.l1, s.l2); }
  }
  const addI = Int32Array.from(addIds);
  wantGen++;
  stats.syncs++;
  worker.postMessage({ type: 'sync', gen: wantGen, order, cats, hl, addIds: addI, add: add.join('\n') },
                     [order.buffer, cats.buffer, hl.buffer, addI.buffer]);
  sendMask();
}

function sendMask() {
  if (!worker) return;
  const filters = state.get('filters') || {};
  const on = new Uint8Array(CAT_KEYS.length);
  for (let c = 0; c < on.length; c++) on[c] = filters[CAT_KEYS[c]] === false ? 0 : 1;
  const sel = state.get('selection');
  const keep = [ISS_ID];
  if (sel && sel.kind === 'sat') keep.push(sel.id);
  worker.postMessage({ type: 'mask', cats: on, hlOnly: !!state.get('highlightsOnly'), keep: Int32Array.from(keep) });
  maskDirty = true;
  pump();
}
let maskT = 0;
const maskSoon = () => { clearTimeout(maskT); maskT = setTimeout(sendMask, 30); };
state.on('filters', maskSoon);
state.on('highlightsOnly', maskSoon);
state.on('selection', (s) => { if (s && s.kind === 'sat') maskSoon(); });
state.on('clock', () => { if (subs.size) { retime(); requestTick(); } });

function onMessage(e) {
  const m = e.data;
  if (m.type === 'ready') {
    idsByGen.set(m.gen, m.ids);
    if (m.gen >= wantGen) { curGen = m.gen; curIds = m.ids; ready = true; }
    for (const g of [...idsByGen.keys()]) if (g < curGen - 1) idsByGen.delete(g);
    if (m.rejected) console.info(`[propagator] gen ${m.gen}: ${m.count} sats ready, ${m.rejected} rejected`);
    pump();
  } else if (m.type === 'tick') {
    inflight = false;
    if (m.stale || m.gen < curGen) {                       // belongs to a catalog generation that is gone
      if (m.ecef) recycle.push(m.ecef.buffer, m.sunlit.buffer);
      pump(); return;
    }
    m.ids = idsByGen.get(m.gen) || curIds;
    if (latest && latest.gen === m.gen) recycle.push(latest.ecef.buffer, latest.sunlit.buffer);
    latest = m;
    stats.ticks++; stats.msSum += m.ms; stats.lastMs = m.ms;
    for (const fn of subs) { try { fn(m); } catch (err) { console.error('[propagator] subscriber', err); } }
    if (maskDirty) { maskDirty = false; pump(); }
  } else if (m.type === 'error') {
    inflight = false;
    console.error('[propagator]', m.message);
  }
}

function pump() {
  if (!ready || inflight || subs.size === 0 || isHidden() || wantGen !== curGen) return;
  inflight = true;
  const iv = getTickIntervalMs();
  const msg = { type: 'tick', gen: curGen, time: now() + getRate() * iv, seq: ++seq, recycle: recycle.length ? recycle.slice() : undefined };
  const tr = msg.recycle;
  recycle.length = 0;
  if (tr) worker.postMessage(msg, tr); else worker.postMessage(msg);
}

/** Ask for a tick right now (e.g. after a time jump). */
export function requestTick() { pump(); }

function retime() {
  const iv = getTickIntervalMs();
  if (timer && iv === timerMs) return;
  clearInterval(timer); timer = 0;
  if (subs.size === 0 || isHidden()) return;
  timerMs = iv;
  timer = setInterval(pump, iv);
}

onVisibility((hidden) => {
  if (hidden) { clearInterval(timer); timer = 0; }
  else if (subs.size) { retime(); pump(); }
});

export function onTick(fn) {
  subs.add(fn);
  ensureWorker();
  retime();
  if (latest) { try { fn(latest); } catch (e) { console.error(e); } }
  pump();
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && timer) { clearInterval(timer); timer = 0; }
  };
}

// Catalog grew (core -> full): re-send the slot table; the worker only builds satrecs it does not have yet.
state.on('catalog', () => { if (worker) syncCatalog(); });

export function getLatest() { return latest; }
export const propagatorStats = () => ({ ...stats, avgMs: stats.ticks ? stats.msSum / stats.ticks : 0 });

// ---- ECEF -> topocentric (az from North clockwise, el above horizon, degrees) ----
const WGS_A = 6378.137, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F);
export function ecefToTopo(ecefKm, lat, lon, elevM = 0) {
  const x = ecefKm.x ?? ecefKm[0], y = ecefKm.y ?? ecefKm[1], z = ecefKm.z ?? ecefKm[2];
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, h = elevM / 1000;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  const N = WGS_A / Math.sqrt(1 - WGS_E2 * sl * sl);
  const ox = (N + h) * cl * co, oy = (N + h) * cl * so, oz = (N * (1 - WGS_E2) + h) * sl;
  const dx = x - ox, dy = y - oy, dz = z - oz;
  const e = -so * dx + co * dy;
  const n = -sl * co * dx - sl * so * dy + cl * dz;
  const u = cl * co * dx + cl * so * dy + sl * dz;
  const rangeKm = Math.hypot(dx, dy, dz);
  let az = Math.atan2(e, n) * 180 / Math.PI; if (az < 0) az += 360;
  const el = Math.atan2(u, Math.hypot(e, n)) * 180 / Math.PI;
  return { az, el, rangeKm };
}
