// Drives passes.worker.js: picks the satellites, requests predictions, caches the result.
import * as state from '../state.js';
import * as clock from '../clock.js';
import { loadCatalog, getSat, allSats } from '../data/catalog.js';

const WINDOW_DAYS = 3;
// Standard magnitudes (at 1000 km, half phase) for well-known objects; default -0.5.
const STD = { 25544: -1.8, 48274: -1.5, 20580: 1.5, 49044: -0.8 };
const BRIGHT_IDS = [25544, 48274, 20580];
const SKIP = new Set([49044]); // Nauka module is docked to ISS: same object visually

let worker = null, reqId = 0, current = null, winStart = 0, winEnd = 0, key = '';
let busy = false;

function pickSats() {
  const ids = new Set(BRIGHT_IDS);
  for (const s of allSats()) {
    // 'stations' also holds docked modules, cargo ships and debris: keep only the station cores.
    if (s.cat === 'stations' && /^(ISS|CSS) \((ZARYA|TIANHE)\)/.test(s.name) && !SKIP.has(s.id)) ids.add(s.id);
    else if (s.notable && s.bright && !SKIP.has(s.id)) ids.add(s.id);
    else if (s.mag != null && s.mag <= 3) ids.add(s.id);
  }
  return [...ids].map(getSat).filter(Boolean).map(s => ({
    id: s.id, name: s.notable || s.name, l1: s.l1, l2: s.l2, std: s.mag != null ? s.mag : (STD[s.id] ?? -0.5) }));
}

export function getPasses() { return current; }

/** Recompute if location changed or the clock left the computed window. Returns promise of passes. */
export async function ensurePasses(force = false) {
  const loc = state.get('location');
  const t = clock.now();
  const k = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
  const stale = !current || k !== key || t < winStart - 60e3 || t > winEnd - 6 * 3600e3 || t > winStart + 12 * 3600e3;
  if (!force && !stale) return current;
  if (busy && k === key && !force) return current;
  await loadCatalog();
  if (!worker) worker = new Worker(new URL('../workers/passes.worker.js', import.meta.url));
  const id = ++reqId; busy = true;
  const startMs = t - 10 * 60e3; // include a pass in progress
  const sats = pickSats();
  return new Promise((resolve, reject) => {
    const onMsg = ev => {
      if (ev.data.reqId !== id) return;
      worker.removeEventListener('message', onMsg);
      busy = false;
      if (ev.data.type === 'error') return reject(new Error(ev.data.error));
      current = ev.data.passes; key = k; winStart = startMs; winEnd = startMs + WINDOW_DAYS * 86400e3;
      state.emit('passes', current);
      resolve(current);
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'compute', reqId: id, sats, lat: loc.lat, lon: loc.lon, elevM: loc.elevM || 0, startMs, days: WINDOW_DAYS + 10 * 60e3 / 86400e3 });
  }).finally(() => { busy = false; });
}
export function invalidate() { key = ''; }
