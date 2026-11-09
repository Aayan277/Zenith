// Satellite catalog loader. Single source of truth for TLE data.
// data/sats.json is refreshed by a GitHub Action (scripts/fetch-sats.mjs).
// Format: { generated: ISO, source: string, sats: [{ id, name, cat, l1, l2, mag? }] }
import { set } from '../state.js';

let promise = null;
let byId = new Map();
let list = [];

export function loadCatalog() {
  if (promise) return promise;
  promise = (async () => {
    const res = await fetch('data/sats.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    const data = await res.json();
    list = data.sats;
    byId = new Map(list.map(s => [s.id, s]));
    set('catalogReady', true);
    return data;
  })();
  return promise;
}

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
