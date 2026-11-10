// Sky-events data API (used by the Events tab, the Tonight summary and the Sky view for meteor-shower radiants).
//
//   getShowers(year)            -> [{ id, name, peak (ms), start, end, zhr, ra, dec, speed, parent, best, note }]   sync, cheap, cached per year
//   activeShowers(ms)           -> shower objects active at ms, each with { daysFromPeak }; sync, cheap
//   upcomingEvents(fromMs, days)-> sorted event objects between fromMs and fromMs + days (default 365). SYNC: returns what is
//                                  computed so far for the current location ([] until ready). Call ensureEvents() first / listen onEvents().
//   ensureEvents({force})       -> Promise<event[]>: computes the next ~12 months in idle time for the current location, cached per
//                                  location + UTC day; concurrent calls share one run.
//   onEvents(fn)                -> unsubscribe; fn({ status: 'loading'|'ready', progress, events }) on every progress step / completion.
//   getEvent(id) / eventStatus()
//   evaluateShower(shower, loc?, {from,to}?) -> { rate, rating, moonIllum, radiantAlt, bestStart, bestEnd, bestMs } for the current location
// Event: { id, type: 'meteor'|'eclipse'|'moon'|'planet', sub, t (ms), title, line, badge, importance, vis: 'yes'|'part'|'no'|null,
//          visNote, viewMs, focus: {kind, id}, rows, desc, ics?: {start, end}, ... }
import * as state from '../state.js';
import { showersForYear } from './showers.js';
import { computeEvents, evaluateShower as evalShower, makeObs } from './compute.js';

export { SHOWERS, showerById } from './showers.js';

const DAY = 86400e3;
const cache = new Map();                       // key -> { events, at }
let inflight = null, inflightKey = '', progress = 0, status = 'idle', lastKey = '';
const subs = new Set();
const emit = () => { const p = { status, progress, events: current() }; for (const f of subs) { try { f(p); } catch (e) { console.error('[events]', e); } } };

const keyFor = (loc = state.get('location')) => `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}|${Math.floor(Date.now() / DAY)}`;
const current = () => cache.get(keyFor())?.events || [];

export function getShowers(year = new Date().getUTCFullYear()) { return showersForYear(year).map(s => ({ ...s })); }

export function activeShowers(ms = Date.now()) {
  const y = new Date(ms).getUTCFullYear(), out = [];
  for (const yr of [y, y + 1]) for (const s of showersForYear(yr)) if (ms >= s.start && ms <= s.end) out.push({ ...s, daysFromPeak: (ms - s.peak) / DAY });
  return out.sort((a, b) => a.peak - b.peak);
}

export function evaluateShower(shower, loc = state.get('location'), range = null) { return evalShower(shower, loc, makeObs(loc), range); }

export function upcomingEvents(fromMs = Date.now(), days = 365) {
  return current().filter(e => e.t >= fromMs && e.t <= fromMs + days * DAY);
}
export const getEvent = id => current().find(e => e.id === id) || null;
export const eventStatus = () => ({ status: cache.has(keyFor()) ? 'ready' : status, progress });
export const onEvents = fn => { subs.add(fn); return () => subs.delete(fn); };

/** Compute (or return the cached) events for the current location. Never blocks: work runs in idle slices. */
export function ensureEvents({ force = false } = {}) {
  const loc = state.get('location'), key = keyFor(loc);
  if (!force && cache.has(key)) return Promise.resolve(cache.get(key).events);
  if (inflight && inflightKey === key) return inflight;
  status = 'loading'; progress = 0; inflightKey = key; lastKey = key;
  const day0 = Math.floor(Date.now() / DAY) * DAY;
  emit();
  const p = computeEvents({ ...loc }, day0, 366, pr => { progress = pr; if (inflightKey === key) emit(); })
    .then(events => { cache.set(key, { events, at: Date.now() }); return events; })
    .catch(e => { console.error('[events] compute failed', e); return []; })
    .finally(() => { if (inflight === p) { inflight = null; } status = 'ready'; progress = 1; emit(); });
  inflight = p;
  return p;
}

// Location changes invalidate by key; if anybody is listening the next ensureEvents() recomputes.
state.on('location', l => { if (subs.size && keyFor(l) !== lastKey) ensureEvents(); });
