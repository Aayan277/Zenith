#!/usr/bin/env node
// Builds data/sats.json (full) and data/sats-core.json (~800 sats) from CelesTrak (GP API, TLE format),
// with a fallback to tle.ivanstanojevic.me. Node 20+, zero dependencies.
//
//   node scripts/fetch-sats.mjs [--out data/sats.json] [--allow-small]
//        [--fallback-only] [--max-pages N] [--max-age-days 30] [--quiet]
//        [--core-only]   derive sats-core.json from the existing --out file (no network)
//
// Both outputs share one compact row format (v2), expanded by js/data/catalog.js:
//   { v: 2, generated, source, core?: true, sats: [[id, name, cat, l1, l2, flags, size, notable?], ...] }
//   l1, l2   TLE lines without the leading "1 NNNNN" / "2 NNNNN" (re-derived from id; full lines are also accepted)
//   flags    bitfield: 1 = bright, 2 = notable (display name in row[7])
//   size     'S' (<0.1 m2) | 'M' (0.1-1 m2) | 'L' (>1 m2), from CelesTrak SATCAT radar cross-section; '' if unknown
//   notable  display name for a curated list of famous objects / crewed vehicles
// sats-core.json = stations + notable + bright + size L: what the UI needs for first paint. It is a strict
// subset of sats.json (same rows), written next to --out as sats-core.json.
// The old object format ({ sats: [{ id, name, cat, l1, l2, bright?, size?, notable? }] }) is still read.
//   size    'S' (<0.1 m2) | 'M' (0.1-1 m2) | 'L' (>1 m2), from CelesTrak SATCAT radar cross-section; omitted if unknown
//   notable display name for a curated list of famous objects / crewed vehicles
//   --enrich-only  re-apply category cleanup, notable and size to the existing output file (no TLE fetch)

import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'zenith-data-bot/1.0 (+https://github.com/Aayan277/zenith; static satellite viewer, refreshes every 6h)';
const DELAY_MS = 1000;
const MIN_SATS = 2000;

// ---- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = resolve(ROOT, opt('out', 'data/sats.json'));
const ALLOW_SMALL = flag('allow-small');
const FALLBACK_ONLY = flag('fallback-only');
const ENRICH_ONLY = flag('enrich-only');
const CORE_ONLY = flag('core-only');
const CORE_OUT = resolve(dirname(OUT), 'sats-core.json');
const MAX_PAGES = Number(opt('max-pages', 0)) || Infinity;
const MAX_AGE_DAYS = Number(opt('max-age-days', 30));
const log = (...a) => { if (!flag('quiet')) console.log(...a); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- CelesTrak groups, in priority order (first match wins) -----------------
// `visual` is cross-cutting: it only sets bright:true, it never decides the category.
const GROUPS = [
  ['stations', 'stations'],
  ['science', 'science'], ['geodetic', 'science'],
  ['weather', 'weather'], ['goes', 'weather'],
  ['gps-ops', 'navigation'], ['glo-ops', 'navigation'], ['galileo', 'navigation'],
  ['beidou', 'navigation'], ['sbas', 'navigation'], ['gnss', 'navigation'],
  ['resource', 'earthobs'], ['planet', 'earthobs'], ['spire', 'earthobs'], ['sarsat', 'earthobs'],
  ['starlink', 'starlink'],
  ['geo', 'comms'], ['intelsat', 'comms'], ['ses', 'comms'], ['iridium-NEXT', 'comms'],
  ['oneweb', 'comms'], ['orbcomm', 'comms'], ['globalstar', 'comms'], ['amateur', 'comms'],
  ['x-comm', 'comms'], ['other-comm', 'comms'],
  ['cosmos-1408-debris', 'debris'], ['fengyun-1c-debris', 'debris'],
  ['iridium-33-debris', 'debris'], ['cosmos-2251-debris', 'debris'],
  ['active', 'other'],
];

// ---- helpers ---------------------------------------------------------------
async function get(url, { json = false, tries = 3 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      err = e;
      if (i < tries - 1) await sleep(DELAY_MS * 3 * (i + 1));
    }
  }
  throw err;
}

// Parse 3-line TLE text -> [{id,name,l1,l2}]. Tolerant of blank lines and CRLF.
function parseTle(text) {
  const lines = text.split(/\r?\n/).map(s => s.replace(/\s+$/, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const [n, a, b] = [lines[i], lines[i + 1], lines[i + 2]];
    if (a.startsWith('1 ') && b.startsWith('2 ') && a.length >= 69 && b.length >= 69 && !n.startsWith('1 ')) {
      const id = parseInt(a.slice(2, 7), 10);
      if (Number.isFinite(id)) out.push({ id, name: n.replace(/^0 /, '').trim(), l1: a, l2: b });
      i += 2;
    }
  }
  return out;
}

function epochMs(l1) {
  const yy = parseInt(l1.slice(18, 20), 10), day = parseFloat(l1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return NaN;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (day - 1) * 86400000;
}

const isRocket = name => /\bR\/B\b/.test(name);

// Name heuristics (fallback source, and for sats seen only in `visual`).
function classify(name) {
  const n = name.toUpperCase();
  if (isRocket(n)) return 'rocket';
  if (/\bDEB\b|DEBRIS/.test(n)) return 'debris';
  if (/^(ISS|CSS|ZARYA|TIANHE|WENTIAN|MENGTIAN|ZVEZDA|NAUKA|POISK|PROGRESS|SOYUZ|TIANZHOU|SHENZHOU|CYGNUS|DRAGON|CREW|HTV|DREAM CHASER)\b/.test(n)) return 'stations';
  if (/^STARLINK/.test(n)) return 'starlink';
  if (/NAVSTAR|^GPS\b|GLONASS|GALILEO|GSAT0|BEIDOU|IRNSS|NAVIC|QZS|COMPASS/.test(n)) return 'navigation';
  if (/^NOAA|^GOES|METEOR-?M|^METEOSAT|^METOP|FENGYUN|^FY-|HIMAWARI|^DMSP|SUOMI|^JPSS|^GOMS|ELEKTRO|INSAT|GK-2A|^MTG|^MSG-/.test(n)) return 'weather';
  if (/^HST\b|HUBBLE|CHANDRA|^SWIFT|FERMI|^XMM|NUSTAR|^TESS|^NICER|^NEOWISE|^SPITZER|^INTEGRAL|^AGILE|^GAIA|^CHEOPS|^HXMT|^INSIGHT|^AMS\b|^COSMIC|^ICESAT|^GRACE|^GOCE|^SWARM|^CALIPSO|^CLOUDSAT|^SDO\b|^IRIS\b|^HINODE|^RHESSI|^LAGEOS|^LARES|^STARLETTE|^STELLA|^AJISAI|^ETALON|^GEOS|^EXPLORER|^SCISAT|^ODIN|^PROBA|^BIOMASS|^EARTHCARE|^SMAP|^OCO-|^SORCE|^THEMIS|^MMS|^VAN ALLEN|^RBSP|^IXPE|^AEOLUS/.test(n)) return 'science';
  if (/SENTINEL|LANDSAT|WORLDVIEW|PLEIADES|SKYSAT|FLOCK|LEMUR|^DOVE|PLANET|SPIRE|RESURS|^TERRA\b|^AQUA\b|CARTOSAT|RADARSAT|ALOS|KOMPSAT|ICEYE|CAPELLA|BLACKSKY|SAR-?LUPE|COSMO-SKYMED|TERRASAR|TANDEM-X|GAOFEN|YAOGAN|JILIN|ZIYUAN|HJ-|SUPERVIEW|SPOT|GEOEYE|IKONOS|QUICKBIRD|RAPIDEYE|KANOPUS|\bPAZ\b|UMBRA|SATELLOGIC|BLUEWALKER|SARSAT|COSPAS/.test(n)) return 'earthobs';
  if (/IRIDIUM|ONEWEB|ORBCOMM|GLOBALSTAR|INTELSAT|^SES-|^ASTRA|EUTELSAT|TELESAT|VIASAT|AMOS|YAMAL|ARABSAT|THURAYA|INMARSAT|^AO-|^FO-|^SO-|^IO-|OSCAR|FOSSA|NAYIF|TDRS|SKYNET|^WGS|MILSTAR|AMC-|ECHOSTAR|DIRECTV|SIRIUS|^XM-|HOT BIRD|NILESAT|TURKSAT|KOREASAT|JCSAT|SUPERBIRD|APSTAR|ASIASAT|CHINASAT|ZHONGXING|TIANTONG|SPACEWAY|GALAXY|ANIK|NIMIQ|HISPASAT|AMAZONAS|STAR ONE|BADR|CUBESAT|BEESAT|UWE-|QO-100|SATNOGS/.test(n)) return 'comms';
  return 'other';
}

// ---- Source 1: CelesTrak ---------------------------------------------------
async function fromCelesTrak() {
  const byId = new Map();
  const bright = new Set();
  let failed = 0, okGroups = 0;

  // visual first: only provides the `bright` flag (+ records for objects in no other group)
  const plan = [['visual', null], ...GROUPS];
  for (let gi = 0; gi < plan.length; gi++) {
    const [group, cat] = plan[gi];
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    try {
      const text = await get(url);
      const recs = parseTle(text);
      if (!recs.length) throw new Error(`no TLEs parsed (${text.slice(0, 60).replace(/\s+/g, ' ')})`);
      okGroups++;
      let added = 0;
      for (const r of recs) {
        if (group === 'visual') {
          bright.add(r.id);
          if (!byId.has(r.id)) byId.set(r.id, { ...r, cat: null });
          continue;
        }
        const prev = byId.get(r.id);
        if (prev && prev.cat) continue;              // first match wins
        // Rocket bodies are always 'rocket' (except stations).
        const c = isRocket(r.name) && cat !== 'stations' ? 'rocket' : cat;
        byId.set(r.id, { ...r, cat: c });
        added++;
      }
      log(`  celestrak ${group.padEnd(20)} ${String(recs.length).padStart(6)} records, ${String(added).padStart(6)} new`);
    } catch (e) {
      failed++;
      log(`  celestrak ${group.padEnd(20)} FAILED: ${e.message}`);
      if (okGroups === 0 && failed >= 2) throw new Error('CelesTrak unreachable');
    }
    if (gi < plan.length - 1) await sleep(DELAY_MS);
  }
  for (const r of byId.values()) if (!r.cat) r.cat = classify(r.name);
  for (const id of bright) { const r = byId.get(id); if (r) r.bright = true; }
  return { sats: [...byId.values()], source: 'celestrak' };
}

// ---- Source 2: tle.ivanstanojevic.me --------------------------------------
async function fromIvan() {
  const base = 'https://tle.ivanstanojevic.me/api/tle/?page-size=100&page=';
  const byId = new Map();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  let pages = 1, stale = 0;
  for (let p = 1; p <= Math.min(pages, MAX_PAGES); p++) {
    const j = await get(base + p, { json: true });
    if (p === 1) {
      pages = Math.ceil((j.totalItems || 0) / 100) || 1;
      log(`  ivan: ${j.totalItems} records, ${pages} pages` + (MAX_PAGES < pages ? ` (capped at ${MAX_PAGES})` : ''));
    }
    for (const m of j.member || []) {
      if (!m.line1 || !m.line2) continue;
      const e = epochMs(m.line1);
      if (Number.isFinite(e) && e < cutoff) { stale++; continue; }
      const name = (m.name || '').trim();
      byId.set(m.satelliteId, { id: m.satelliteId, name, cat: classify(name), l1: m.line1, l2: m.line2 });
    }
    if (p % 10 === 0) log(`  ivan: page ${p}/${Math.min(pages, MAX_PAGES)} (${byId.size} kept, ${stale} stale)`);
    await sleep(DELAY_MS);
  }
  log(`  ivan: kept ${byId.size}, dropped ${stale} stale (> ${MAX_AGE_DAYS} d)`);
  return { sats: [...byId.values()], source: 'tle.ivanstanojevic.me' };
}


// ---- Highlights: stations cleanup, notable list, SATCAT sizes ----------------
// Only real stations and visiting/attached vehicles belong in 'stations'.
const STATION_RE = /^(ISS|CSS|ZARYA|ZVEZDA|NAUKA|POISK|RASSVET|TIANHE|WENTIAN|MENGTIAN|PROGRESS|SOYUZ|TIANZHOU|SHENZHOU|CYGNUS|DRAGON|CREW|HTV|DREAM CHASER)\b/i;
// [NORAD id, display name, name check]. A wrong id (name mismatch) is dropped.
const NOTABLE = [
  [25544, 'ISS', /ISS|ZARYA/], [48274, 'Tiangong', /CSS|TIANHE/], [20580, 'Hubble', /HST|HUBBLE/],
  [43013, 'NOAA-20', /NOAA 20|JPSS-1/], [54234, 'NOAA-21', /NOAA 21|JPSS-2/],
  [25994, 'Terra', /TERRA/], [27424, 'Aqua', /AQUA/], [39084, 'Landsat 8', /LANDSAT 8/], [49260, 'Landsat 9', /LANDSAT 9/],
  [40697, 'Sentinel-2A', /SENTINEL-2A/], [41866, 'GOES-16', /GOES 16/], [51850, 'GOES-18', /GOES 18/],
  [28485, 'Swift', /SWIFT/], [33053, 'Fermi', /FERMI|FGRST|GLAST/], [25867, 'Chandra', /CHANDRA|CXO/],
  [38358, 'NuSTAR', /NUSTAR/], [43435, 'TESS', /TESS/], [27386, 'Envisat', /ENVISAT/],
  [5, 'Vanguard 1', /VANGUARD 1/], [39634, 'Sentinel-1A', /SENTINEL-1A/], [60133, 'GOES-19', /GOES 19/],
];
// Crewed / cargo vehicles currently attached to or near stations (found by name).
const VEHICLE_RE = /^(CREW DRAGON|SOYUZ-MS|SHENZHOU|TIANZHOU|PROGRESS-MS|CYGNUS|DRAGON)\b/i;

function sizeFromRcs(v) {
  const x = parseFloat(v);
  if (!Number.isFinite(x) || v === '' ) return undefined;
  return x < 0.1 ? 'S' : x <= 1 ? 'M' : 'L';
}
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
// One polite request for the whole SATCAT. Returns Map(noradId -> 'S'|'M'|'L'), or null on failure.
async function fetchSizes() {
  try {
    const text = await get('https://celestrak.org/pub/satcat.csv');
    const lines = text.split(/\r?\n/);
    const head = splitCsv(lines[0]);
    const iId = head.indexOf('NORAD_CAT_ID'), iRcs = head.indexOf('RCS');
    if (iId < 0 || iRcs < 0) throw new Error('unexpected SATCAT header');
    const m = new Map();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const c = splitCsv(lines[i]);
      const sz = sizeFromRcs(c[iRcs]);
      if (sz) m.set(parseInt(c[iId], 10), sz);
    }
    log(`  satcat: ${m.size} objects with RCS`);
    return m;
  } catch (e) { log('  satcat unavailable:', e.message); return null; }
}

// Mutates sats: fixes 'stations', sets notable and (when known) size.
function enrich(sats, sizes, prevSizes) {
  const byId = new Map(sats.map(s => [s.id, s]));
  for (const s of sats) {
    if (s.cat === 'stations' && !STATION_RE.test(s.name)) s.cat = classify(s.name) === 'stations' ? 'other' : classify(s.name);
    delete s.notable;
    const sz = (sizes && sizes.get(s.id)) || prevSizes?.get(s.id);
    if (sz) s.size = sz; else delete s.size;
  }
  const kept = [];
  for (const [id, name, re] of NOTABLE) {
    const s = byId.get(id);
    if (!s) continue;
    if (!re.test(s.name.toUpperCase())) { log(`  notable ${id} "${name}" does not match catalog name "${s.name}" - dropped`); continue; }
    s.notable = name; s.bright = true; kept.push(`${id}:${name}`);
  }
  for (const s of sats) if (s.cat === 'stations' && VEHICLE_RE.test(s.name) && !s.notable) {
    s.notable = s.name.replace(/\s*\(.*\)$/, '').replace(/\b([A-Z])([A-Z]+)/g, (_, a, b) => a + b.toLowerCase()).replace(/-ms /i, '-MS ');
    s.bright = true; kept.push(`${s.id}:${s.notable}`);
  }
  log('  notable:', kept.join(', '));
}
// ---- compact row format (v2) --------------------------------------------------
const F_BRIGHT = 1, F_NOTABLE = 2;
const isCore = s => s.cat === 'stations' || s.bright || s.notable || s.size === 'L';
// "1 25544" / "2 25544" is redundant with the id: rows carry the TLE lines without that 7-char prefix (~10% smaller gzip).
const pad5 = id => String(id).padStart(5, '0');
const strip = (l, n, id) => (l.startsWith(`${n} ${pad5(id)}`) ? l.slice(7) : l);
const unstrip = (l, n, id) => (l[0] === String(n) ? l : `${n} ${pad5(id)}${l}`);
function toRow(s) {
  const r = [s.id, s.name, s.cat, strip(s.l1, 1, s.id), strip(s.l2, 2, s.id), (s.bright ? F_BRIGHT : 0) | (s.notable ? F_NOTABLE : 0), s.size || ''];
  if (s.notable) r.push(s.notable);
  return r;
}
function fromRow(r) {
  const o = { id: r[0], name: r[1], cat: r[2], l1: unstrip(r[3], 1, r[0]), l2: unstrip(r[4], 2, r[0]) };
  if (r[5] & F_BRIGHT) o.bright = true;
  if (r[6]) o.size = r[6];
  if ((r[5] & F_NOTABLE) && r[7]) o.notable = r[7];
  return o;
}
// Reads an existing output file in either format -> { ...meta, sats: [objects] }
async function readExisting(file = OUT) {
  const j = JSON.parse(await readFile(file, 'utf8'));
  if (Array.isArray(j.sats?.[0])) j.sats = j.sats.map(fromRow);
  return j;
}
function packSat(s) {
  const o = { id: s.id, name: s.name, cat: s.cat, l1: s.l1, l2: s.l2 };
  if (s.bright) o.bright = true;
  if (s.size) o.size = s.size;
  if (s.notable) o.notable = s.notable;
  return o;
}
async function writeJson(file, obj) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(obj));
  await rename(tmp, file);
}
// out.sats: packed objects. Writes the full file and the core subset.
async function writeOut(out, { full = true } = {}) {
  const meta = { v: 2, generated: out.generated, source: out.source };
  if (full) {
    await writeJson(OUT, { ...meta, sats: out.sats.map(toRow) });
    log(`Wrote ${out.sats.length} satellites -> ${OUT}`);
  }
  const core = out.sats.filter(isCore);
  await writeJson(CORE_OUT, { ...meta, core: true, sats: core.map(toRow) });
  log(`Wrote ${core.length} core satellites -> ${CORE_OUT}`);
}
async function coreOnly() {
  const prev = await readExisting();
  await writeOut(prev, { full: false });
}
async function enrichOnly() {
  const prev = await readExisting();
  const sizes = await fetchSizes();
  enrich(prev.sats, sizes, null);
  prev.sats = prev.sats.map(packSat);
  await writeOut(prev);
  log(`Enriched ${prev.sats.length} satellites in ${OUT}`);
}

// ---- main ------------------------------------------------------------------
async function main() {
  if (CORE_ONLY) return coreOnly();
  if (ENRICH_ONLY) return enrichOnly();
  let result = null;
  if (!FALLBACK_ONLY) {
    log('Fetching CelesTrak…');
    try { result = await fromCelesTrak(); } catch (e) { log('CelesTrak failed:', e.message); }
    if (result && result.sats.length < MIN_SATS && !ALLOW_SMALL) {
      log(`CelesTrak result too small (${result.sats.length}); trying fallback`);
      result = null;
    }
  }
  if (!result) {
    log('Fetching fallback (tle.ivanstanojevic.me)…');
    try { result = await fromIvan(); } catch (e) { console.error('Fallback failed:', e.message); }
  }
  if (!result || !result.sats.length) { console.error('No data fetched; leaving existing file untouched.'); process.exit(1); }
  if (result.sats.length < MIN_SATS && !ALLOW_SMALL) {
    console.error(`Only ${result.sats.length} satellites (< ${MIN_SATS}); refusing to write. Use --allow-small to override.`);
    process.exit(1);
  }

  // stable order (category, then id) keeps git diffs small
  const order = ['stations', 'science', 'weather', 'navigation', 'earthobs', 'starlink', 'comms', 'other', 'rocket', 'debris'];
  result.sats.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.id - b.id);

  const counts = {};
  for (const s of result.sats) counts[s.cat] = (counts[s.cat] || 0) + 1;
  const out = {
    generated: new Date().toISOString(),
    source: result.source,
    sats: [],
  };
  let prevSizes = null;
  try { prevSizes = new Map((await readExisting()).sats.filter(x => x.size).map(x => [x.id, x.size])); } catch {}
  await sleep(DELAY_MS);
  enrich(result.sats, await fetchSizes(), prevSizes);
  out.sats = result.sats.map(packSat);
  counts.stations = out.sats.filter(s => s.cat === 'stations').length;

  // A capped/partial run must not clobber a much bigger existing catalog.
  try {
    const prev = await readExisting();
    if (prev.sats?.length > out.sats.length * 1.5 && !ALLOW_SMALL) {
      console.error(`Existing file has ${prev.sats.length} sats vs ${out.sats.length} new; keeping existing (use --allow-small to force).`);
      process.exit(1);
    }
  } catch {}

  await writeOut(out);
  log(`Source: ${out.source}`);
  log('By category:', JSON.stringify(counts));
}

main().catch(e => { console.error(e); process.exit(1); });
