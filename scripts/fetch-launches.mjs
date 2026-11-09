#!/usr/bin/env node
// Build-time snapshot of Launch Library 2 (The Space Devs) -> data/launches.json.
// Node 20, zero dependencies. Unauthenticated LL2 allows ~15 requests/hour per IP, so this makes 2 requests.
// The site fetches live data from the visitor's browser; this snapshot is the fallback (offline / rate limited).
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, API_VERSIONS, normalizeList } from '../js/launches/normalize.mjs';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../data/launches.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Zenith-snapshot/1.0 (+https://aayan277.github.io/Zenith/)' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { const wait = Math.min(60, Number(res.headers.get('retry-after')) || 20); lastErr = new Error('429 rate limited'); if (i < tries - 1) { console.warn(`429, waiting ${wait}s`); await sleep(wait * 1000); continue; } break; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

async function main() {
  let version = null, upcoming = null, previous = null, lastErr = null;
  for (const v of API_VERSIONS) {
    try {
      upcoming = normalizeList(await get(`${API_BASE}/${v}/launches/upcoming/?limit=20&mode=detailed`));
      previous = normalizeList(await get(`${API_BASE}/${v}/launches/previous/?limit=5&mode=detailed`));
      version = v; break;
    } catch (e) { lastErr = e; console.warn(`LL2 ${v} failed: ${e.message}`); }
  }
  if (!version) {
    // Keep the previous snapshot rather than failing the deploy.
    try { await readFile(OUT); console.warn('Keeping existing data/launches.json (' + lastErr?.message + ')'); return; } catch {}
    throw lastErr || new Error('no data');
  }
  const doc = { generated: new Date().toISOString(), source: 'The Space Devs, Launch Library 2', version, upcoming, previous };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(doc));
  console.log(`launches.json: ${upcoming.length} upcoming, ${previous.length} previous (LL2 ${version})`);
}
main().catch(e => { console.error(e); process.exit(1); });
