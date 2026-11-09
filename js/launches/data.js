// Launch data: Launch Library 2 (The Space Devs) fetched from the visitor's browser, cached in localStorage
// (30 min), with the build-time snapshot data/launches.json as the fallback. Unauthenticated LL2 allows ~15
// requests/hour per IP, so we make at most 2 requests per refresh and honour 429s.
import { API_BASE, API_VERSIONS, normalizeList } from './normalize.mjs';
import { lsGet, lsSet } from '../ui/notify.js';

const KEY = 'zenith:launches:v1', KEY_THROTTLE = 'zenith:launches:throttle';
const TTL = 30 * 60e3, TIMEOUT = 12e3;

export const store = {
  upcoming: [], previous: [], source: null /* 'live'|'cache'|'snapshot' */, updatedAt: 0,
  loading: false, error: null, note: '', loaded: false,
};
const subs = new Set();
export const onLaunches = fn => { subs.add(fn); return () => subs.delete(fn); };
const emit = () => { for (const fn of subs) { try { fn(store); } catch (e) { console.error('[launches]', e); } } };

export const getLaunch = id => store.upcoming.find(l => l.id === id) || store.previous.find(l => l.id === id) || null;
/** Upcoming launches that have not happened yet, soonest first. `slackMs` keeps a just-launched vehicle around. */
export function pending(nowMs = Date.now(), slackMs = 30 * 60e3) {
  return store.upcoming.filter(l => l.net != null && !(l.status.key === 'success' || l.status.key === 'failure') && l.net > nowMs - slackMs)
    .sort((a, b) => a.net - b.net);
}
export const nextLaunch = (nowMs) => pending(nowMs)[0] || null;

async function getJson(url, ms = TIMEOUT) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (res.status === 429) {
      const wait = Math.max(60, Number(res.headers.get('retry-after')) || 1800);
      lsSet(KEY_THROTTLE, Date.now() + wait * 1000);
      const e = new Error('rate limited'); e.code = 429; throw e;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function fetchLive() {
  const until = lsGet(KEY_THROTTLE, 0);
  if (until > Date.now()) { const e = new Error('rate limited'); e.code = 429; throw e; }
  let lastErr;
  for (const v of API_VERSIONS) {
    try {
      const [up, prev] = await Promise.all([
        getJson(`${API_BASE}/${v}/launches/upcoming/?limit=20&mode=detailed`),
        getJson(`${API_BASE}/${v}/launches/previous/?limit=5&mode=detailed`).catch(e => { if (e.code === 429) throw e; return null; }),
      ]);
      return { upcoming: normalizeList(up), previous: prev ? normalizeList(prev) : [], version: v, at: Date.now() };
    } catch (e) { lastErr = e; if (e.code === 429) break; }
  }
  throw lastErr || new Error('LL2 unavailable');
}

async function fetchSnapshot() {
  const j = await getJson('data/launches.json', 8000);
  return { upcoming: j.upcoming || [], previous: j.previous || [], at: Date.parse(j.generated) || 0 };
}

function apply(d, source, note = '') {
  store.upcoming = d.upcoming; store.previous = d.previous; store.source = source; store.updatedAt = d.at;
  store.note = note; store.error = null; store.loaded = true;
}

let inflight = null, lastTry = 0;
/** Load launches. Safe to call repeatedly; concurrent calls share one request. */
export function loadLaunches({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && store.loaded && Date.now() - lastTry < 60e3) return Promise.resolve(store);
  lastTry = Date.now();
  inflight = (async () => {
    store.loading = true; emit();
    const cached = lsGet(KEY, null);
    const fresh = cached && cached.upcoming && Date.now() - cached.at < TTL;
    try {
      if (fresh && !force) { apply(cached, 'cache'); return store; }
      // Paint something immediately while the live request is in flight.
      if (!store.loaded) {
        if (cached?.upcoming) apply(cached, 'cache', 'Showing saved data while refreshing…');
        else { try { apply(await fetchSnapshot(), 'snapshot', 'Showing the latest saved schedule while refreshing…'); } catch {} }
        if (store.loaded) emit();
      }
      try {
        const live = await fetchLive();
        apply(live, 'live'); lsSet(KEY, { upcoming: live.upcoming, previous: live.previous, at: live.at });
      } catch (e) {
        const rl = e.code === 429;
        if (!store.loaded) {
          if (cached?.upcoming) apply(cached, 'cache');
          else apply(await fetchSnapshot(), 'snapshot');   // throws if the snapshot is missing too
        }
        store.note = rl ? 'Live schedule is rate-limited right now; showing saved data.' : 'Live schedule unavailable; showing saved data.';
        console.info('[launches] live fetch failed:', e.message);
      }
    } catch (e) {
      store.error = e; store.loaded = store.loaded || false;
    } finally { store.loading = false; inflight = null; emit(); }
    return store;
  })();
  return inflight;
}
