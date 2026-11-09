// Satellite catalog loader. Single source of truth for TLE data.
// data/sats-core.json (~800 sats: stations, notable, bright, large) loads first so the UI can paint;
// data/sats.json (full, ~18k) streams in afterwards. Both are refreshed by scripts/fetch-sats.mjs.
// File format (v2): { v:2, generated, source, core?, sats: [[id, name, cat, l1, l2, flags, size, notable?], ...] }
//   flags: 1 = bright, 2 = notable (name in row[7]). Legacy object rows ({id,name,cat,l1,l2,...}) are still accepted.
// l1/l2 omit the redundant "1 NNNNN"/"2 NNNNN" prefix (rebuilt here). Rows are expanded to the object shape { id, name, cat, l1, l2, bright?, size?, notable? } for consumers.
//
// Events (js/state.js `emit`/`on`):
//   'catalog' { stage: 'core' | 'full', full: boolean, count: number }  fired when a stage is installed.
//   'catalogReady' (state key, true)  fired for every stage, so existing listeners refresh themselves.
// After the 'full' stage allSats() returns a NEW array (core objects are reused by identity); anything that
// copied the list (propagator worker, globe sats) must re-read allSats() on 'catalog' with stage === 'full'.
import { set, emit, on } from '../state.js';

let corePromise = null;
let fullPromise = null;
let byId = new Map();
let list = [];
let isFull = false;
let meta = {};

function expand(rows) {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) { out[i] = r; continue; }
    const id = r[0], a = r[3], b = r[4];
    // l1/l2 are stored without their "1 NNNNN" / "2 NNNNN" prefix (derived from id); full lines also accepted
    const o = { id, name: r[1], cat: r[2], l1: a[0] === '1' ? a : '1 ' + String(id).padStart(5, '0') + a,
                l2: b[0] === '2' ? b : '2 ' + String(id).padStart(5, '0') + b };
    const f = r[5] | 0;
    if (f & 1) o.bright = true;
    if (r[6]) o.size = r[6];
    if ((f & 2) && r[7]) o.notable = r[7];
    out[i] = o;
  }
  return out;
}

// The core file is preloaded from index.html (default cache mode so the preload is reused); the full file always revalidates.
async function fetchJson(url, revalidate) {
  const res = await fetch(url, revalidate ? { cache: 'no-cache' } : undefined);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function install(data, full) {
  let next = expand(data.sats);
  if (byId.size) next = next.map(s => byId.get(s.id) || s);   // keep identity of objects already handed out
  list = next;
  byId = new Map(list.map(s => [s.id, s]));
  isFull = full;
  meta = { generated: data.generated, source: data.source };
  set('catalogReady', true);
  emit('catalog', { stage: full ? 'full' : 'core', full, count: list.length });
}

/** Resolves once at least the core catalog is installed. Rejects only if neither file loads. */
export function loadCatalog() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    try {
      const data = await fetchJson('data/sats-core.json', false);
      install(data, false);
      loadFullCatalog().catch(e => console.warn('[catalog] full catalog unavailable:', e.message));
      return { ...meta, sats: list, full: false };
    } catch (e) {
      console.warn('[catalog] core unavailable, loading full catalog:', e.message);
      await loadFullCatalog(true);
      return { ...meta, sats: list, full: true };
    }
  })();
  return corePromise;
}

/** Resolves when the full catalog is installed. Starts the download (deferred to idle unless `now`). */
export function loadFullCatalog(now = false) {
  if (fullPromise) return fullPromise;
  fullPromise = (async () => {
    if (!now) await idle(1500);
    install(await fetchJson('data/sats.json', true), true);
  })();
  return fullPromise;
}

function idle(timeout) {
  return new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout }) : setTimeout(r, 200)));
}

/** True once data/sats.json (every object) is installed. */
export function isFullCatalog() { return isFull; }
/** Subscribe to catalog stages. fn({stage, full, count}); returns an unsubscribe fn. Not replayed. */
export function onCatalogUpdate(fn) { return on('catalog', fn); }

export function getSat(id) { return byId.get(id); }
export function allSats() { return list; }

// satellite.js is loaded globally (window.satellite) from index.html.
const recCache = new Map();
export function satrec(id) {
  let r = recCache.get(id);
  if (!r) {
    const s = byId.get(id);
    if (!s) return null;
    r = window.satellite.twoline2satrec(s.l1, s.l2);
    recCache.set(id, r);
  }
  return r;
}
