// Solar System view: body table, ephemeris helpers (astronomy-engine) and spacecraft interpolation.
// Frames: "ecl" = heliocentric ecliptic J2000 (what Horizons and the scene use, +z = ecliptic north);
// three.js scene = (x, y, z) <- (x_ecl, z_ecl, -y_ecl), so +Y is ecliptic north and orbits run counter-clockwise from above.

export const AU_KM = 149597870.7;
export const LIGHT_AU_S = 499.00478384;           // light-seconds per AU
const D2R = Math.PI / 180;
const OBL = 23.4392911 * D2R;                     // J2000 mean obliquity
const COS_O = Math.cos(OBL), SIN_O = Math.sin(OBL);
export const DAY = 86400e3;

/** Equatorial J2000 {x,y,z} -> ecliptic J2000 array. */
export function eqjToEcl(v, out = [0, 0, 0]) {
  out[0] = v.x; out[1] = v.y * COS_O + v.z * SIN_O; out[2] = -v.y * SIN_O + v.z * COS_O; return out;
}
/** Raw equatorial vector array [x,y,z] -> ecliptic array. */
export function eqjArrToEcl(x, y, z, out = [0, 0, 0]) {
  out[0] = x; out[1] = y * COS_O + z * SIN_O; out[2] = -y * SIN_O + z * COS_O; return out;
}
/** ecliptic [x,y,z] -> scene [x,y,z] (in place into out). */
export function eclToScene(e, out = [0, 0, 0]) { out[0] = e[0]; out[1] = e[2]; out[2] = -e[1]; return out; }

// Radii in km. rc = radius in the compressed view (scene units; 10 units ~ 1 AU there).
// pole = IAU north pole (RA, Dec deg, J2000); w0 / rate = prime meridian angle (deg) and spin (deg/day).
export const K_COMPRESS = 10;
export const PLANETS = [
  { id: 'Mercury', km: 2439.7,  color: '#a9a49c', tex: 'mercury', pole: [281.01, 61.45], w0: 329.55, rate: 6.1385025,    period: 87.969,  atm: null },
  { id: 'Venus',   km: 6051.8,  color: '#e8cb90', tex: 'venus',   pole: [272.76, 67.16], w0: 160.20, rate: -1.4813688,   period: 224.701, atm: { c: [1.0, 0.82, 0.5], i: 0.9, k: 0.05 } },
  { id: 'Earth',   km: 6371.0,  color: '#4f93e6', tex: 'earth',   pole: [0, 90],         w0: 0,      rate: 360.9856,     period: 365.256, atm: { c: [0.35, 0.62, 1.0], i: 1.25, k: 0.045 } },
  { id: 'Mars',    km: 3389.5,  color: '#d2673c', tex: 'mars',    pole: [317.68, 52.89], w0: 176.63, rate: 350.89198,    period: 686.98,  atm: { c: [1.0, 0.6, 0.4], i: 0.5, k: 0.03 } },
  { id: 'Jupiter', km: 69911,   color: '#dcb88c', tex: 'jupiter', pole: [268.06, 64.50], w0: 284.95, rate: 870.5366,     period: 4332.59, atm: { c: [1.0, 0.85, 0.65], i: 0.45, k: 0.03 } },
  { id: 'Saturn',  km: 58232,   color: '#ead5a2', tex: 'saturn',  pole: [40.59, 83.54],  w0: 38.90,  rate: 810.7939,     period: 10759.2, atm: { c: [1.0, 0.9, 0.65], i: 0.4, k: 0.03 }, ring: [74500, 140220] },
  { id: 'Uranus',  km: 25362,   color: '#a2e3ea', tex: 'uranus',  pole: [257.31, -15.18], w0: 203.81, rate: -501.16009,  period: 30688.5, atm: { c: [0.55, 0.95, 1.0], i: 0.9, k: 0.04 } },
  { id: 'Neptune', km: 24622,   color: '#4f70ea', tex: 'neptune', pole: [299.36, 43.46], w0: 253.18, rate: 536.31285,    period: 60182,   atm: { c: [0.35, 0.5, 1.0], i: 1.0, k: 0.04 } },
];
export const PLUTO = { id: 'Pluto', km: 1188.3, color: '#cdb9a0', tex: null, pole: [132.99, -6.16], w0: 302.7, rate: -56.3625, period: 90560, atm: null, dwarf: true };
export const MOON = { id: 'Moon', km: 1737.4, color: '#bdbdbd', tex: 'moon' };
export const SUN = { id: 'Sun', km: 695700, color: '#ffc85a', tex: 'sun', pole: [286.13, 63.87], w0: 84.176, rate: 14.1844 };

/** Visual radius in the compressed view (scene units). */
export function compressedRadius(km) { return 0.55 * Math.pow(km / 6371, 0.45) * 1.45; }
export const SUN_RC = 3.3;
export const radiusReal = km => km / AU_KM;

const A = () => window.Astronomy;

/** Heliocentric ecliptic position (AU) of a planet / Pluto at ms. Returns the shared `out` array. */
export function helioEcl(name, ms, out = [0, 0, 0]) {
  const v = A().HelioVector(name, new Date(ms));
  return eqjToEcl(v, out);
}
/** Geocentric ecliptic position of the Moon (AU). */
export function moonEcl(ms, out = [0, 0, 0]) {
  const v = A().GeoMoon(new Date(ms));
  return eqjToEcl(v, out);
}
/** Greenwich sidereal angle in degrees. */
export function gstDeg(ms) { return (A().SiderealTime(new Date(ms)) * 15) % 360; }

// ---- spacecraft ------------------------------------------------------------------
let craftList = null, craftPromise = null;
export const getCraftList = () => craftList;
export const getCraft = id => craftList && craftList.find(c => c.id === id) || null;

export function loadCraft() {
  return craftPromise ||= fetch(new URL('../../data/spacecraft.json', import.meta.url))
    .then(r => { if (!r.ok) throw new Error('spacecraft.json ' + r.status); return r.json(); })
    .then(j => {
      craftList = j.craft.map(c => ({ ...c, p: Float64Array.from(c.p), t0: j.t0, stepMs: j.stepMs, n: j.n, generated: j.generated }));
      return craftList;
    });
}

/** Does the data cover ms? */
export function craftCovers(c, ms) { const f = (ms - c.t0) / c.stepMs; return f >= 0 && f <= c.n - 1; }

/** Ecliptic position (AU) of a craft at ms by cubic Hermite (Catmull-Rom) interpolation; null outside the window. */
export function craftEcl(c, ms, out = [0, 0, 0]) {
  const f = (ms - c.t0) / c.stepMs;
  if (!(f >= 0 && f <= c.n - 1)) return null;
  const i = Math.min(c.n - 2, Math.floor(f)), u = f - i, p = c.p, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const im = Math.max(0, i - 1), ip = Math.min(c.n - 1, i + 2);
  for (let k = 0; k < 3; k++) {
    const p0 = p[i * 3 + k], p1 = p[(i + 1) * 3 + k];
    const m0 = (p1 - p[im * 3 + k]) / (i - im + 1), m1 = (p[ip * 3 + k] - p0) / (ip - i);
    out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
  }
  return out;
}

/** Speed (km/s) from a centred difference of the interpolated track. */
export function craftSpeedKmS(c, ms) {
  const a = craftEcl(c, ms - 0.25 * DAY), b = craftEcl(c, ms + 0.25 * DAY);
  if (!a || !b) { const x = craftEcl(c, ms - 0.25 * DAY) || craftEcl(c, ms); const y = craftEcl(c, ms + 0.25 * DAY) || craftEcl(c, ms); if (!x || !y) return null; return Math.hypot(y[0] - x[0], y[1] - x[1], y[2] - x[2]) * AU_KM / (0.5 * 86400); }
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * AU_KM / (0.5 * 86400);
}

// ---- formatting ------------------------------------------------------------------
export function fmtLight(sec) {
  if (!isFinite(sec)) return '—';
  if (sec < 10) return sec.toFixed(1) + ' s';
  if (sec < 60) return Math.round(sec) + ' s';
  if (sec < 3600) { const m = Math.floor(sec / 60), s = Math.round(sec - m * 60); return s === 60 ? `${m + 1}m 00s` : `${m}m ${String(s).padStart(2, '0')}s`; }
  const h = Math.floor(sec / 3600), m = Math.round((sec - h * 3600) / 60);
  return m === 60 ? `${h + 1}h 00m` : `${h}h ${String(m).padStart(2, '0')}m`;
}
export const fmtKm = km => Math.round(km).toLocaleString('en-US') + ' km';
