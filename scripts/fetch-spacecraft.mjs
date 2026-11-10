#!/usr/bin/env node
// Builds data/spacecraft.json: heliocentric ecliptic-J2000 daily positions (AU) of deep-space missions
// from the JPL Horizons API (which has no CORS, so the browser cannot call it). Node 20, zero dependencies.
//
//   node scripts/fetch-spacecraft.mjs [--out data/spacecraft.json] [--back 30] [--ahead 120]
//
// Polite: strictly sequential requests with a 1 s gap. A craft that fails (unknown id, no ephemeris for
// the window, network error) is dropped with a warning; if nothing at all succeeds the script exits 1 and
// does not touch the output file, so a committed snapshot stays in place.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const OUT = resolve(process.cwd(), arg('out', resolve(HERE, '../data/spacecraft.json')));
const BACK = +arg('back', 30), AHEAD = +arg('ahead', 120);
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const DAY = 86400e3;

// key: stable id used by the app ({kind:'craft', id:key}). `h` = Horizons id. `color` = marker tint.
export const CRAFT = [
  { key: 'jwst', h: '-170', name: 'James Webb Space Telescope', short: 'JWST', agency: 'NASA / ESA / CSA', launch: 2021, color: '#ffd24a',
    desc: 'Infrared observatory orbiting the Sun-Earth L2 point, 1.5 million km behind Earth.', status: 'Operating',
    url: 'https://science.nasa.gov/mission/webb/' },
  { key: 'voyager1', h: '-31', name: 'Voyager 1', short: 'Voyager 1', agency: 'NASA', launch: 1977, color: '#7fe6ff',
    desc: 'The most distant human-made object, travelling through interstellar space since 2012.', status: 'Interstellar mission',
    url: 'https://science.nasa.gov/mission/voyager/voyager-1/' },
  { key: 'voyager2', h: '-32', name: 'Voyager 2', short: 'Voyager 2', agency: 'NASA', launch: 1977, color: '#9bb7ff',
    desc: 'The only spacecraft to visit Uranus and Neptune; in interstellar space since 2018.', status: 'Interstellar mission',
    url: 'https://science.nasa.gov/mission/voyager/voyager-2/' },
  { key: 'parker', h: '-96', name: 'Parker Solar Probe', short: 'Parker', agency: 'NASA', launch: 2018, color: '#ff9a5c',
    desc: 'Flies through the Sun’s corona, the fastest human-made object, to study the solar wind.', status: 'Operating',
    url: 'https://science.nasa.gov/mission/parker-solar-probe/' },
  { key: 'newhorizons', h: '-98', name: 'New Horizons', short: 'New Horizons', agency: 'NASA', launch: 2006, color: '#ff8fb3',
    desc: 'Flew past Pluto in 2015 and Arrokoth in 2019; now exploring the outer Kuiper Belt.', status: 'Extended mission',
    url: 'https://science.nasa.gov/mission/new-horizons/' },
  { key: 'juno', h: '-61', name: 'Juno', short: 'Juno', agency: 'NASA', launch: 2011, color: '#ffc27a',
    desc: 'Polar orbiter studying Jupiter’s interior, magnetic field and auroras.', status: 'Jupiter orbit',
    url: 'https://science.nasa.gov/mission/juno/' },
  { key: 'clipper', h: '-159', name: 'Europa Clipper', short: 'Europa Clipper', agency: 'NASA', launch: 2024, color: '#8ff0d0',
    desc: 'Cruising to Jupiter to make dozens of flybys of the ice-covered ocean moon Europa.', status: 'Cruise',
    url: 'https://science.nasa.gov/mission/europa-clipper/' },
  { key: 'psyche', h: '-255', name: 'Psyche', short: 'Psyche', agency: 'NASA', launch: 2023, color: '#d9a8ff',
    desc: 'Heading for the metal-rich asteroid 16 Psyche in the main belt.', status: 'Cruise',
    url: 'https://science.nasa.gov/mission/psyche/' },
  { key: 'lucy', h: '-49', name: 'Lucy', short: 'Lucy', agency: 'NASA', launch: 2021, color: '#b5e36b',
    desc: 'First mission to the Trojan asteroids that share Jupiter’s orbit.', status: 'Cruise',
    url: 'https://science.nasa.gov/mission/lucy/' },
  { key: 'bepicolombo', h: '-121', name: 'BepiColombo', short: 'BepiColombo', agency: 'ESA / JAXA', launch: 2018, color: '#ff7a7a',
    desc: 'Two orbiters on their way to Mercury, using repeated planetary flybys to slow down.', status: 'Arriving at Mercury',
    url: 'https://www.esa.int/Science_Exploration/Space_Science/BepiColombo' },
  { key: 'solarorbiter', h: '-144', name: 'Solar Orbiter', short: 'Solar Orbiter', agency: 'ESA / NASA', launch: 2020, color: '#ffe066',
    desc: 'Takes the first images of the Sun’s poles, orbiting inside the orbit of Mercury.', status: 'Operating',
    url: 'https://www.esa.int/Science_Exploration/Space_Science/Solar_Orbiter' },
  { key: 'juice', h: '-28', name: 'JUICE', short: 'JUICE', agency: 'ESA', launch: 2023, color: '#6fb8ff',
    desc: 'Jupiter Icy Moons Explorer: en route to study Ganymede, Callisto and Europa.', status: 'Cruise',
    url: 'https://www.esa.int/Science_Exploration/Space_Science/Juice' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const sig = x => { const v = Math.abs(x) >= 20 ? +x.toFixed(4) : +x.toFixed(6); return v === 0 ? 0 : v; };

async function fetchVectors(h, startMs, stopMs) {
  const q = new URLSearchParams({
    format: 'json', COMMAND: `'${h}'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS', CENTER: "'500@10'",
    REF_PLANE: 'ECLIPTIC', START_TIME: `'${ymd(startMs)}'`, STOP_TIME: `'${ymd(stopMs)}'`, STEP_SIZE: "'1 d'",
    VEC_TABLE: '1', OUT_UNITS: 'AU-D', TIME_TYPE: 'TDB',
  });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}?${q}`, { headers: { 'user-agent': 'zenith-data-build/1.0' }, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const text = j.result || '';
      const a = text.indexOf('$$SOE'), b = text.indexOf('$$EOE');
      if (a < 0 || b < 0) throw new Error((j.error || text.split('\n').find(l => /No ephemeris|No such|error|Cannot/i.test(l)) || 'no data').trim().slice(0, 140));
      // Plain-text blocks: "2461354.5 = A.D. ... TDB" then " X = 1.0E+00 Y = ... Z = ..."
      const body = text.slice(a + 5, b);
      const rows = [...body.matchAll(/^\s*(\d+\.\d+)\s*=.*\n\s*X\s*=\s*(\S+)\s+Y\s*=\s*(\S+)\s+Z\s*=\s*(\S+)/gm)].map(m => [m[1], '', m[2], m[3], m[4]]);
      return rows.map(r => ({ jd: +r[0], p: [+r[2], +r[3], +r[4]] }));
    } catch (e) {
      lastErr = e;
      if (/No ephemeris|No such|no data/i.test(e.message)) break;   // not transient
      await sleep(2500);
    }
  }
  throw lastErr;
}

async function main() {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const t0 = today - BACK * DAY, t1 = today + AHEAD * DAY;
  const n = Math.round((t1 - t0) / DAY) + 1;
  const craft = [];
  for (const c of CRAFT) {
    try {
      const rows = await fetchVectors(c.h, t0, t1);
      if (rows.length !== n) throw new Error(`expected ${n} rows, got ${rows.length}`);
      if (rows.some(r => r.p.some(v => !Number.isFinite(v)))) throw new Error('non-finite values');
      const p = []; for (const r of rows) for (const v of r.p) p.push(sig(v));
      const { h, key, color, ...meta } = c;
      craft.push({ id: key, horizons: +h, color, ...meta, p });
      const last = rows[Math.floor(rows.length / 4)].p;
      console.log(`ok   ${key.padEnd(13)} ${h.padStart(5)}  r=${Math.hypot(...last).toFixed(3)} AU`);
    } catch (e) {
      console.warn(`DROP ${c.key} (${c.h}): ${e.message}`);
    }
    await sleep(1000);
  }
  if (!craft.length) { console.error('No spacecraft data fetched; leaving output untouched.'); process.exit(1); }
  const out = { v: 1, generated: new Date().toISOString(), source: 'NASA/JPL Horizons (ssd.jpl.nasa.gov/api/horizons.api)',
    frame: 'heliocentric ecliptic J2000, AU', t0, stepMs: DAY, n, craft };
  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(OUT, json);
  console.log(`wrote ${OUT}: ${craft.length} craft, ${(json.length / 1024).toFixed(1)} KB`);
}
main().catch(e => { console.error(e); process.exit(1); });
