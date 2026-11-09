// Compacts the raw d3-celestial files in data/sky/ into data/sky/sky.json.
// Usage: node scripts/build-sky.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sky');
const rd = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const r = (x, p) => { const k = 10 ** p; return Math.round(x * k) / k; };
const ra360 = lon => ((lon % 360) + 360) % 360;

// ---- Stars: [ra°, dec°, mag, bv, hip] sorted by magnitude (brightest first)
const starsRaw = rd('stars.6.json').features;
const names = rd('starnames.json');
const stars = starsRaw.map(f => {
  const [lon, lat] = f.geometry.coordinates;
  const bv = parseFloat(f.properties.bv);
  return [r(ra360(lon), 3), r(lat, 3), r(f.properties.mag, 2), Number.isFinite(bv) ? r(bv, 2) : 0.6, f.id];
}).sort((a, b) => a[2] - b[2]);

// Names: proper name, bayer (greek), flamsteed, constellation abbreviation
const starNames = {};
for (const s of stars) {
  const n = names[s[4]];
  if (!n) continue;
  const proper = (n.name || '').trim();
  if (proper || (n.bayer && s[2] < 4.6)) {
    starNames[s[4]] = [proper, n.bayer || '', n.flam || '', n.c || ''];
  }
}

// ---- Constellations
const cons = rd('constellations.json').features;
const lines = Object.fromEntries(rd('constellations.lines.json').features.map(f => [f.id, f.geometry.coordinates]));
const constellations = cons.map(f => {
  const [lon, lat] = f.geometry.coordinates;
  const ls = (lines[f.id] || []).map(poly => poly.flatMap(([lo, la]) => [r(ra360(lo), 2), r(la, 2)]));
  return { id: f.id, name: f.properties.name, label: [r(ra360(lon), 2), r(lat, 2)], lines: ls };
});

// ---- Milky Way: 5 brightness levels (outer -> inner).
// d3-celestial stores each level as one spherical polygon. Rings that wrap all the way
// round the sky (the two edges of the band) are converted into a single closed
// "band" polygon in unwrapped equirectangular space; other rings are unwrapped so they
// do not jump at +-180. The client draws every polygon at lon offsets -360/0/+360.
const wrapLon = lo => ((lo + 540) % 360) - 180;
function unwrap(ring) {
  const out = [[ring[0][0], ring[0][1]]]; let off = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    if (d > 180) off -= 360; else if (d < -180) off += 360;
    out.push([ring[i][0] + off, ring[i][1]]);
  }
  return out;
}
function decimate(pts, maxPts) {
  const step = Math.max(1, Math.ceil(pts.length / maxPts));
  const out = []; for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  return out;
}
const flat = pts => pts.flatMap(([lo, la]) => [r(lo, 1), r(la, 1)]);
const mw = rd('mw.json').features.map(f => {
  const polys = [], curves = [];
  for (const poly of f.geometry.coordinates) for (const ring of poly) {
    const u = unwrap(ring);
    const span = u[u.length - 1][0] - u[0][0];
    if (Math.abs(span) > 300) {
      // band edge: sort by wrapped longitude -> single curve west..east
      const c = u.map(([lo, la]) => [wrapLon(lo), la]).sort((a, b) => a[0] - b[0]);
      curves.push(decimate(c, 260));
    } else {
      const d = decimate(u, 160);
      if (d.length >= 3) polys.push(flat(d));
    }
  }
  curves.sort((a, b) => b.reduce((s, p) => s + p[1], 0) / b.length - a.reduce((s, p) => s + p[1], 0) / a.length);
  for (let i = 0; i + 1 < curves.length; i += 2) polys.push(flat(curves[i].concat(curves[i + 1].slice().reverse())));
  return polys;
});

const out = { stars, starNames, constellations, mw };
const json = JSON.stringify(out);
writeFileSync(join(dir, 'sky.json'), json);
console.log(`sky.json: ${(json.length / 1024).toFixed(1)} KB — ${stars.length} stars, ${Object.keys(starNames).length} named, ${constellations.length} constellations, mw rings ${mw.map(l => l.length).join('/')}`);
