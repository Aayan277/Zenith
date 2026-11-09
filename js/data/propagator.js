// Shared propagation engine. One Web Worker propagates the whole catalog with SGP4;
// every view subscribes with onTick(). The worker runs only while somebody listens.
//
//   const off = onTick(tick => …);   // tick = { time, ids, ecef, sunlit, count, sun, ms, seq }
//   getLatest()                      // last tick or null
//   ecefToTopo(ecefKm, lat, lon, elevM) -> { az, el, rangeKm }   (degrees)
//
// tick.time is the sim time (ms) the positions are valid for. It is deliberately a
// little ahead of the clock (see LOOKAHEAD_S) so views can interpolate towards it.
import { now, getRate } from '../clock.js';
import { loadCatalog, allSats } from './catalog.js';

const TICK_MS = 100;           // ~10 Hz
const LOOKAHEAD_S = 0.1;       // real seconds of look-ahead (tick.time = now + rate*lookahead)

let worker = null;
let ready = false;            // worker has TLEs
let initializing = false;
let inflight = false;
let seq = 0;
let timer = 0;
let latest = null;
const subs = new Set();

function ensureWorker() {
  if (worker || initializing) return;
  initializing = true;
  loadCatalog().then(() => {
    worker = new Worker(new URL('../workers/propagate.worker.js', import.meta.url));
    worker.onmessage = onMessage;
    worker.onerror = (e) => { console.error('[propagator] worker error', e.message || e); inflight = false; };
    worker.postMessage({ type: 'init', sats: allSats().map(s => ({ id: s.id, l1: s.l1, l2: s.l2 })) });
  }).catch(e => { console.error('[propagator] catalog failed', e); initializing = false; });
}

function onMessage(e) {
  const m = e.data;
  if (m.type === 'ready') {
    ready = true;
    if (m.rejected) console.info(`[propagator] ${m.count} sats ready, ${m.rejected} rejected`);
    pump();
  } else if (m.type === 'tick') {
    inflight = false;
    latest = m;
    for (const fn of subs) { try { fn(m); } catch (err) { console.error('[propagator] subscriber', err); } }
  } else if (m.type === 'error') {
    inflight = false;
    console.error('[propagator]', m.message);
  }
}

function pump() {
  if (!ready || inflight || subs.size === 0) return;
  inflight = true;
  worker.postMessage({ type: 'tick', time: now() + getRate() * LOOKAHEAD_S * 1000, seq: ++seq });
}

/** Ask for a tick right now (e.g. after a time jump). */
export function requestTick() { pump(); }

export function onTick(fn) {
  subs.add(fn);
  ensureWorker();
  if (!timer) timer = setInterval(pump, TICK_MS);
  if (latest) { try { fn(latest); } catch (e) { console.error(e); } }
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && timer) { clearInterval(timer); timer = 0; }
  };
}

export function getLatest() { return latest; }

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
