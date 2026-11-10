// Shareable links: app state <-> URL query.
//
//   ?view=sky|system            (omitted for the Orbit view)
//   &sat=25544 | body=Mars | star=32349 | craft=jwst | launch=<id> | con=Ori | world=Pluto
//   &t=2026-11-10T21:30Z        simulated time (UTC, minute precision); omitted while live
//   &rate=60                    time rate, only together with t and only when not 1
//   &loc=40.71,-74.01,New%20York,America/New_York    observer location (lat, lon, name, IANA zone)
//
// The address bar never carries `loc` unless it came from the link that was opened, or the user ticked
// "Include my location" in the share dialog. A location from a link is applied with source:'link' and is never
// written to the saved preferences (see protectSavedLocation).
import * as state from '../state.js';
import * as clock from '../clock.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { getSat, isFullCatalog } from '../data/catalog.js';

const SEL_PARAM = { sat: 'sat', body: 'body', star: 'star', craft: 'craft', launch: 'launch', constellation: 'con', world: 'world' };
const OWN = new Set(['view', 'sat', 'body', 'star', 'craft', 'launch', 'con', 'world', 't', 'rate', 'loc', 'az', 'alt', 'zoom']);
const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
const VIEW_FROM = { globe: 'globe', orbit: 'globe', sky: 'sky', system: 'system' };
export const VIEW_LABEL = { globe: 'Orbit view', sky: 'Sky view', system: 'System view' };

let fromLink = false;
let pendingSel = null;          // selection requested by the link, not applied yet
let shareLoc = false;           // user opted in (share dialog) to carry the location in the address bar
let userActed = false;

export const isFromLink = () => fromLink;
export const getShareLoc = () => shareLoc;
export function setShareLoc(v) { shareLoc = !!v; scheduleSync(); }

// ---------------------------------------------------------------- parsing
function rawParam(search, name) {
  for (const part of String(search).replace(/^\?/, '').split('&')) {
    const i = part.indexOf('=');
    if ((i < 0 ? part : part.slice(0, i)) === name) return i < 0 ? '' : part.slice(i + 1);
  }
  return null;
}
const dec = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
const clean = (s, n = 60) => String(s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function cleanSel(kind, raw) {
  raw = dec(raw).trim();
  switch (kind) {
    case 'sat': return /^\d{1,9}$/.test(raw) ? { kind, id: +raw } : null;
    case 'star': return /^\d{1,7}$/.test(raw) ? { kind, id: +raw } : null;
    case 'body': { const b = BODIES.find(x => x.toLowerCase() === raw.toLowerCase()); return b ? { kind, id: b } : null; }
    case 'world': { const w = ['Earth', 'Pluto'].find(x => x.toLowerCase() === raw.toLowerCase()); return w ? { kind, id: w } : null; }
    case 'constellation': return /^[A-Za-z]{2,4}$/.test(raw) ? { kind, id: raw } : null;
    case 'craft': return /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? { kind, id: raw.toLowerCase() } : null;
    case 'launch': return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? { kind, id: raw } : null;
  }
  return null;
}

/** Parse a query string into { view?, sel?, t?, rate?, loc? }. Anything invalid is dropped. */
export function parseLink(search = location.search) {
  const out = {};
  const v = VIEW_FROM[dec(rawParam(search, 'view') || '').toLowerCase()];
  if (v) out.view = v;
  for (const [kind, p] of Object.entries(SEL_PARAM)) {
    const raw = rawParam(search, p);
    if (raw == null) continue;
    const sel = cleanSel(kind, raw);
    if (sel) { out.sel = sel; break; }
  }
  const t = rawParam(search, 't');
  if (t && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(dec(t))) {
    const ms = Date.parse(dec(t));
    if (Number.isFinite(ms) && ms > Date.UTC(1990, 0, 1) && ms < Date.UTC(2100, 0, 1)) out.t = ms;
  }
  const r = rawParam(search, 'rate');
  if (r != null && r !== '') { const n = Number(dec(r)); if (Number.isFinite(n) && Math.abs(n) <= 1e8) out.rate = n; }
  const l = rawParam(search, 'loc');
  if (l) {
    const [la, lo, name, tz] = l.split(',').map(dec);
    const lat = Number(la), lon = Number(lo);
    if (la !== '' && lo !== '' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.loc = { lat, lon, elevM: 0, name: clean(name || '') || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, source: 'link' };
      if (tz && /^[A-Za-z0-9_+\-/]{1,40}$/.test(tz)) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); out.loc.tz = tz; } catch {} }
    }
  }
  return out;
}

// ---------------------------------------------------------------- applying a link
// state.js persists `location` on every change. A location that came from a link must not replace the one the user
// saved, so after each write we put the saved value back. (Registered after state.js's own listeners, so it runs last.)
function protectSavedLocation() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('skywatch:prefs') || 'null')?.location; } catch {}
  const fix = () => {
    if (state.get('location')?.source !== 'link') return;
    try {
      localStorage.setItem('skywatch:prefs', JSON.stringify({ ...(saved ? { location: saved } : {}), filters: state.get('filters'), highlightsOnly: state.get('highlightsOnly') }));
    } catch {}
  };
  for (const k of ['location', 'filters', 'highlightsOnly']) state.on(k, fix);
  fix();
}

const toast = m => state.emit('toast', m);

/** Call once, synchronously, before the other modules init (main.js). Returns true when the URL carried state. */
export function applyLink() {
  const p = parseLink();
  // Any of our parameters means "opened from a link" (no tour), even if its value turned out to be unusable.
  fromLink = [...OWN].some(k => rawParam(location.search, k) != null);
  if (!Object.keys(p).length) return false;
  const act = () => { userActed = true; };
  for (const ev of ['pointerdown', 'keydown', 'wheel']) addEventListener(ev, act, { capture: true, once: true, passive: true });
  if (p.view) state.set('view', p.view);
  if (p.loc) { protectSavedLocation(); state.set('location', p.loc); }
  if (p.rate != null) clock.setRate(p.rate);
  if (p.t != null) clock.setTime(p.t);
  if (p.sel) { pendingSel = p.sel; resolveSelection(p.sel); }
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 30000, every = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(every); }
  return false;
}

async function resolveSelection(sel) {
  let ok = true;
  if (sel.kind === 'sat') {
    ok = await waitFor(() => getSat(sel.id) || (isFullCatalog() ? 'missing' : false), 40000);
    if (ok === 'missing' || !ok) { toast(`Satellite ${sel.id} is not in the catalog`); ok = false; }
  } else if (sel.kind === 'launch') {
    try {
      const d = await import('../launches/data.js');
      if (!d.store.loaded) await d.loadLaunches().catch(() => {});
      ok = !!d.getLaunch(sel.id);
    } catch { ok = false; }
    if (!ok) toast('That launch is no longer in the schedule');
  }
  if (pendingSel !== sel) return;            // the user picked something else meanwhile
  pendingSel = null;
  if (!ok) { scheduleSync(); return; }
  if (sel.kind === 'sat') {
    const cat = getSat(sel.id)?.cat;
    if (cat && state.get('filters')[cat] === false) state.patch('filters', { [cat]: true });
  }
  state.set('selection', sel);
  // The detail provider (globe / sky / system / launches) registers when its module is ready; focus after that.
  await waitFor(() => { try { return state.getDetail(sel, clock.now()); } catch { return false; } }, 20000, 250);
  const same = () => { const s = state.get('selection'); return s && s.kind === sel.kind && s.id === sel.id; };
  if (!same()) return;
  state.emit('focus', sel);
  await sleep(1800);                          // views fly while they are still warming up: ask once more
  if (same() && !userActed) state.emit('focus', sel);
}

// ---------------------------------------------------------------- building links
const trim = n => String(+n.toFixed(4));

function locParam(loc) {
  const gps = loc.source === 'gps';
  const la = gps ? loc.lat.toFixed(2) : trim(loc.lat), lo = gps ? loc.lon.toFixed(2) : trim(loc.lon);
  let s = `${la},${lo}`;
  const name = clean(loc.name || '', 40);
  if (name || loc.tz) s += ',' + encodeURIComponent(name);
  if (loc.tz) s += ',' + encodeURIComponent(loc.tz).replace(/%2F/g, '/');
  return s;
}

/** Ordered [key, rawValue] pairs for the current state. opts: { time, loc, sel }. Values are already URL-encoded. */
export function linkPairs({ time = !clock.isLive(), loc = false, sel } = {}) {
  const out = [];
  const view = state.get('view');
  if (view && view !== 'globe') out.push(['view', view]);
  const s = sel === undefined ? (state.get('selection') || pendingSel) : sel;
  if (s && SEL_PARAM[s.kind]) out.push([SEL_PARAM[s.kind], encodeURIComponent(s.id)]);
  if (time) {
    out.push(['t', new Date(Math.floor(clock.now() / 60000) * 60000).toISOString().slice(0, 16) + 'Z']);
    const r = clock.getRate();
    if (r !== 1) out.push(['rate', String(r)]);
  }
  const l = state.get('location');
  if (loc && l && l.source !== 'default' && Number.isFinite(l.lat) && Number.isFinite(l.lon)) out.push(['loc', locParam(l)]);
  return out;
}

export function buildUrl(opts = {}, { keepOthers = true } = {}) {
  const pairs = linkPairs(opts);
  if (keepOthers) {
    for (const part of location.search.replace(/^\?/, '').split('&')) {
      if (part && !OWN.has(part.split('=')[0])) pairs.push(part.split('='));
    }
  }
  const q = pairs.map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join('&');
  return location.origin + location.pathname + (q ? '?' + q : '') + location.hash;
}

// ---------------------------------------------------------------- description ("Opens: ISS · Sky view · Tue 21:30 EST · New York")
export function selectionName(sel) {
  if (!sel) return '';
  try {
    if (sel.kind === 'sat') { const s = getSat(sel.id); if (s) return s.notable || s.name; }
    const d = state.getDetail(sel, clock.now());
    if (d?.title) return String(d.title);
  } catch {}
  return sel.kind === 'star' ? `Star HIP ${sel.id}` : String(sel.id);
}

export function describeLink({ time = !clock.isLive(), loc = false, sel } = {}) {
  const parts = [];
  const s = sel === undefined ? (state.get('selection') || pendingSel) : sel;
  if (s) parts.push(selectionName(s));
  parts.push(VIEW_LABEL[state.get('view')] || 'Orbit view');
  const l = state.get('location');
  const useLoc = loc && l && l.source !== 'default';
  if (time) {
    const ms = Math.floor(clock.now() / 60000) * 60000;
    // Without a location in the link the recipient sees their own zone, so the preview is given in UTC.
    const zone = useLoc ? l : { tz: 'UTC' };
    parts.push(`${fmtLocal(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, zone)} ${tzLabel(ms, zone)}`);
  } else parts.push('live');
  if (useLoc) parts.push((l.name || '').split(',')[0].trim() || `${l.lat.toFixed(1)}, ${l.lon.toFixed(1)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- address bar sync
let timer = 0, lastUrl = location.href;
function scheduleSync() { clearTimeout(timer); timer = setTimeout(syncNow, 350); }
function syncNow() {
  try {
    const url = buildUrl({ time: !clock.isLive(), loc: fromLinkLoc() });
    if (url !== lastUrl) { history.replaceState(history.state, '', url); lastUrl = url; }
  } catch (e) { /* sandboxed iframe / file: */ }
}
const fromLinkLoc = () => shareLoc || state.get('location')?.source === 'link';

export function initUrlSync() {
  for (const k of ['view', 'selection', 'location']) state.on(k, scheduleSync);
  state.on('clock', scheduleSync);
  // Keep the pending selection in the URL until it resolves, then take over.
  if (!fromLink) syncNow(); else scheduleSync();
}
