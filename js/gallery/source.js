// NASA Image and Video Library client: paged, filtered, de-duplicated feeds of one telescope's images.
// No DOM use (testable in Node). Pages are cached in memory and in sessionStorage.
import { COMMON_EXCLUDE, ART_EXCLUDE, DEFAULT_CENTERS } from './telescopes.js';

const API = 'https://images-api.nasa.gov/search';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CALL = 5;        // stop hunting for survivors of the filters after this many requests
const SS_PREFIX = 'zenith:gal:v1:';

const mem = new Map();               // url -> Promise<{ items, next }>

// ---- sessionStorage (best-effort) -------------------------------------------
function ssGet(k) { try { const s = sessionStorage.getItem(SS_PREFIX + k); return s ? JSON.parse(s) : null; } catch { return null; } }
function ssSet(k, v) {
  try { sessionStorage.setItem(SS_PREFIX + k, JSON.stringify(v)); }
  catch {
    try { // quota: drop our oldest entries and retry once
      const ours = []; for (let i = 0; i < sessionStorage.length; i++) { const key = sessionStorage.key(i); if (key?.startsWith(SS_PREFIX)) ours.push(key); }
      ours.slice(0, Math.ceil(ours.length / 2)).forEach(key => sessionStorage.removeItem(key));
      sessionStorage.setItem(SS_PREFIX + k, JSON.stringify(v));
    } catch {}
  }
}

// ---- text cleanup ------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', deg: '°' };
function clean(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : m; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const looksLikeId = t => !/\s/.test(t) && /\d/.test(t) && t.length > 5;
const firstSentence = (s, max = 90) => { const m = s.match(/^.{12,}?[.!?](\s|$)/); const x = (m ? m[0] : s).trim(); return x.length > max ? x.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : x; };

// ---- normalising one API item -----------------------------------------------
function linkOf(links, name) {
  const l = links.find(x => x.href && x.href.includes(`~${name}.`));
  return l ? { url: l.href.replace(/^http:/, 'https:'), w: l.width || 0, h: l.height || 0 } : null;
}

/** API item -> compact record (also what is cached). null when it has no usable image. */
export function normalize(it) {
  const d = it?.data?.[0]; if (!d || d.media_type !== 'image') return null;
  const links = (it.links || []).filter(l => l.render === 'image' || /\.(jpe?g|png|tif)$/i.test(l.href || ''));
  const small = linkOf(links, 'small'), medium = linkOf(links, 'medium'), large = linkOf(links, 'large'), thumb = linkOf(links, 'thumb'), orig = linkOf(links, 'orig');
  const grid = small || medium || thumb || large || (orig && /\.(jpe?g|png)$/i.test(orig.url) ? orig : null);
  if (!grid) return null;
  const dim = medium || small || large || thumb || orig;
  let desc = clean(d.description_508 && d.description_508.length > (d.description || '').length ? d.description_508 : d.description);
  // "Credits: …" trailing lines are common in descriptions: lift them into the credit field.
  let credit = clean(d.secondary_creator || '');
  const m = desc.match(/\n?\s*(?:Image\s+)?Credits?:\s*([^\n]+)\s*$/i);
  if (m) { if (!credit) credit = m[1].trim(); desc = desc.slice(0, m.index).trim(); }
  let title = clean(d.title);
  if (/^[A-Za-z][a-z]+(_[A-Za-z0-9-]+){2,}$/.test(title)) title = title.replace(/_/g, ' ');   // Webb_first_deep_field_SMACS_0723
  else if (looksLikeId(title) && desc) title = firstSentence(desc);
  const kw = (d.keywords || []).map(clean).filter(Boolean).slice(0, 8);
  const best = large || medium || (orig && /\.(jpe?g|png)$/i.test(orig.url) ? orig : null) || grid;
  return {
    id: d.nasa_id, title, desc: desc.slice(0, 1800), kw, credit, center: d.center || '',
    date: (d.date_created || '').slice(0, 10),
    w: dim.w || 4, h: dim.h || 3,
    th: grid.url, thw: grid.w || 0, th2: medium?.url || '', th2w: medium?.w || 0,   // grid image (+ 2x candidate)
    lg: best.url,                                                                  // lightbox image
    dl: orig && /\.(jpe?g|png)$/i.test(orig.url) ? orig.url : best.url,                  // "download": original JPEG when there is one
  };
}

// ---- filtering ---------------------------------------------------------------
export function accepts(tel, r) {
  const s = tel.search || {};
  if (!(s.centers || DEFAULT_CENTERS).test(r.center)) return false;
  if (COMMON_EXCLUDE.test(r.title) || (!s.allowArt && ART_EXCLUDE.test(r.title))) return false;
  if (s.excludeTitle?.test(r.title)) return false;
  if (s.excludeDesc?.test(r.desc)) return false;
  if (!s.allowArt && /\bartist[’']?s?\s+(concept|illustration|impression|rendering|depiction|view|animation)/i.test(r.desc)) return false;
  if (s.include && !s.include.test(`${r.title} ${r.kw.join(' ')} ${r.desc}`)) return false;
  return true;
}

// ---- fetching ----------------------------------------------------------------
async function getJson(url, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('NASA library ' + res.status);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError' || attempt >= 1) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

/** One cached API page. */
function page(params, signal) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API}?${qs}`;
  let p = mem.get(url);
  if (p) return p;
  const stored = ssGet(url);
  if (stored) { p = Promise.resolve(stored); mem.set(url, p); return p; }
  p = getJson(url, signal).then(j => {
    const col = j?.collection;
    const out = { items: (col?.items || []).map(normalize).filter(Boolean), next: !!col?.links?.some(l => l.rel === 'next') };
    ssSet(url, out);
    return out;
  });
  mem.set(url, p);
  p.catch(() => mem.delete(url));      // never cache failures
  return p;
}

const tokens = q => q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const matchesQuery = (r, toks) => { const h = `${r.title} ${r.kw.join(' ')} ${r.desc}`.toLowerCase(); return toks.every(t => h.includes(t)); };

/**
 * A feed yields filtered, de-duplicated records in chunks: `await feed.next(24)` -> { items, done }.
 * Curated nasa_ids come first (filtered locally by the query), then each source in order.
 */
export function createFeed(tel, { query = '', signal } = {}) {
  const cfg = tel.search || {};
  const sources = cfg.sources || [];
  const q = query.trim();
  const seenId = new Set(), seenKey = new Set();
  let curatedDone = !(tel.curated?.length), si = 0, pg = 1, done = false, busy = null;

  const keep = (r, bypassFilters) => {
    if (seenId.has(r.id)) return false;
    const key = r.title.toLowerCase() + '|' + r.desc.slice(0, 40).toLowerCase();
    if (seenKey.has(key)) return false;
    if (!bypassFilters && !accepts(tel, r)) return false;
    seenId.add(r.id); seenKey.add(key);
    return true;
  };

  async function pull(min) {
    const out = [];
    if (!curatedDone) {
      curatedDone = true;
      const res = await Promise.all(tel.curated.map(id => page({ nasa_id: id, media_type: 'image' }, signal).then(p => p.items[0]).catch(() => null)));
      const toks = tokens(q);
      for (const r of res) if (r && (!toks.length || matchesQuery(r, toks)) && keep(r, true)) out.push(r);
    }
    let calls = 0;
    while (si < sources.length && out.length < min && calls < MAX_PAGES_PER_CALL) {
      const src = sources[si];
      const params = { ...src, media_type: 'image', page_size: PAGE_SIZE, page: pg };
      const qq = [src.q, q].filter(Boolean).join(' ');
      if (qq) params.q = qq; else delete params.q;
      calls++;
      const p = await page(params, signal);
      for (const r of p.items) if (keep(r)) out.push(r);
      if (p.next && p.items.length) pg++; else { si++; pg = 1; }
    }
    done = curatedDone && si >= sources.length;
    return { items: out, done };
  }

  return {
    get done() { return done; },
    /** Next chunk (>= min items unless exhausted or the per-call page budget is spent). Calls are serialised. */
    next(min = 24) {
      if (done) return Promise.resolve({ items: [], done: true });
      busy = (busy || Promise.resolve()).then(() => (done ? { items: [], done: true } : pull(min)));
      const mine = busy; busy = mine.catch(() => {});
      return mine;
    },
  };
}

export const nasaUrl = id => `https://images.nasa.gov/details/${encodeURIComponent(id)}`;
