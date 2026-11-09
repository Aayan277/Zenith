// Astronomy helpers for the sky view: frame matrices, bodies, visibility limits,
// rise/set caching. Wraps window.Astronomy (astronomy-engine).
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const AU_KM = 149597870.7;

const A = () => window.Astronomy;

export const BODY_NAMES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
export const BODY_COLORS = {
  Sun: '#fff1b8', Moon: '#e9edf5', Mercury: '#cfc6b6', Venus: '#fff6dc', Mars: '#ff8f66',
  Jupiter: '#ffe3bd', Saturn: '#f2d99a', Uranus: '#a9eaf0', Neptune: '#86a5ff',
};

let obsKey = '', obs = null;
export function observer(loc) {
  const k = `${loc.lat},${loc.lon},${loc.elevM || 0}`;
  if (k !== obsKey) { obsKey = k; obs = new (A().Observer)(loc.lat, loc.lon, loc.elevM || 0); }
  return obs;
}

// ---- Frame: equatorial J2000 -> local horizontal (E, N, U) ------------------
// M (row-major 3x3) maps J2000 equatorial unit vectors to ENU.
// Mdate maps equatorial-of-date vectors (solar system bodies) to ENU.
export function makeFrame(ms, loc) {
  const Ast = A();
  const t = Ast.MakeTime(new Date(ms));
  const gst = Ast.SiderealTime(t);               // hours
  const th = (gst * 15 + loc.lon) * D2R;
  const ph = loc.lat * D2R;
  const sT = Math.sin(th), cT = Math.cos(th), sP = Math.sin(ph), cP = Math.cos(ph);
  const Mdate = [
    -sT, cT, 0,
    -sP * cT, -sP * sT, cP,
    cP * cT, cP * sT, sP,
  ];
  // precession+nutation J2000 -> of date
  let P = null;
  try {
    const rot = Ast.Rotation_EQJ_EQD(t);
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(([x, y, z]) => {
      const v = Ast.RotateVector(rot, new Ast.Vector(x, y, z, t));
      return [v.x, v.y, v.z];
    });
    P = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  } catch { P = precessionFallback(ms); }
  return { time: ms, M: mul3(Mdate, P), Mdate, lst: th };
}

function mul3(a, b) {
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
function precessionFallback(ms) {
  const T = (ms / 86400000 + 2440587.5 - 2451545.0) / 36525;
  const z = (2306.2181 * T + 1.09468 * T * T) / 3600 * D2R;
  const zz = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) / 3600 * D2R;
  const th = (2004.3109 * T - 0.42665 * T * T) / 3600 * D2R;
  const cz = Math.cos(z), sz = Math.sin(z), cc = Math.cos(zz), sc = Math.sin(zz), ct = Math.cos(th), st = Math.sin(th);
  return [
    cc * ct * cz - sc * sz, -cc * ct * sz - sc * cz, -cc * st,
    sc * ct * cz + cc * sz, -sc * ct * sz + cc * cz, -sc * st,
    st * cz, -st * sz, ct,
  ];
}

export function raDecToVec(raDeg, decDeg, out = [0, 0, 0]) {
  const a = raDeg * D2R, d = decDeg * D2R, c = Math.cos(d);
  out[0] = c * Math.cos(a); out[1] = c * Math.sin(a); out[2] = Math.sin(d);
  return out;
}
export function applyM(M, x, y, z, out = [0, 0, 0]) {
  out[0] = M[0] * x + M[1] * y + M[2] * z;
  out[1] = M[3] * x + M[4] * y + M[5] * z;
  out[2] = M[6] * x + M[7] * y + M[8] * z;
  return out;
}
export function enuToAltAz(e, n, u) {
  let az = Math.atan2(e, n) * R2D; if (az < 0) az += 360;
  return { alt: Math.asin(Math.max(-1, Math.min(1, u))) * R2D, az };
}
export function altAzToEnu(altDeg, azDeg, out = [0, 0, 0]) {
  const a = altDeg * D2R, z = azDeg * D2R, c = Math.cos(a);
  out[0] = c * Math.sin(z); out[1] = c * Math.cos(z); out[2] = Math.sin(a);
  return out;
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = az => COMPASS[Math.round(az / 22.5) % 16];

// ---- Solar system bodies ----------------------------------------------------
export function computeBodies(ms, loc, frame, withMag = true, only = null) {
  const Ast = A();
  const t = Ast.MakeTime(new Date(ms));
  const o = observer(loc);
  const out = [];
  for (const name of (only ? [only] : BODY_NAMES)) {
    try {
      const eq = Ast.Equator(name, t, o, true, true);
      const v = eq.vec, L = Math.hypot(v.x, v.y, v.z);
      const enu = applyM(frame.Mdate, v.x / L, v.y / L, v.z / L);
      let mag = name === 'Sun' ? -26.7 : 0, phaseFrac = 1, phaseAngle = 0;
      if (name !== 'Sun' && withMag) {
        const il = Ast.Illumination(name, t);
        mag = il.mag; phaseFrac = il.phase_fraction; phaseAngle = il.phase_angle;
      }
      const aa = enuToAltAz(enu[0], enu[1], enu[2]);
      out.push({ name, kind: 'body', id: name, e: enu[0], n: enu[1], u: enu[2], alt: aa.alt, az: aa.az,
        ra: eq.ra, dec: eq.dec, distAU: eq.dist, mag, phaseFrac, phaseAngle, color: BODY_COLORS[name] });
    } catch (e) { console.warn('[sky] body', name, e); }
  }
  return out;
}

// Naked-eye limiting magnitude as a function of the Sun's altitude.
const LIM = [[-18, 6.6], [-12, 5.4], [-9, 4.0], [-6, 2.6], [-3, 0.8], [0, -1.2], [4, -2.6], [12, -4.2]];
export function limitMag(sunAlt) {
  if (sunAlt <= LIM[0][0]) return LIM[0][1];
  for (let i = 1; i < LIM.length; i++) {
    if (sunAlt <= LIM[i][0]) {
      const [a0, m0] = LIM[i - 1], [a1, m1] = LIM[i];
      return m0 + (m1 - m0) * (sunAlt - a0) / (a1 - a0);
    }
  }
  return LIM[LIM.length - 1][1];
}
export function twilightName(sunAlt) {
  if (sunAlt > 0) return 'Daylight';
  if (sunAlt > -6) return 'Civil twilight';
  if (sunAlt > -12) return 'Nautical twilight';
  if (sunAlt > -18) return 'Astronomical twilight';
  return 'Night';
}

// ---- Star colour from B-V ---------------------------------------------------
export function bvToTemp(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}
export function tempToRGB(T) {
  const t = T / 100; let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  const c = v => Math.max(0, Math.min(255, v));
  return [c(r), c(g), c(b)];
}
export function spectralClass(bv) {
  if (bv < -0.2) return 'O/B (blue-white)';
  if (bv < 0.0) return 'B (blue-white)';
  if (bv < 0.3) return 'A (white)';
  if (bv < 0.58) return 'F (yellow-white)';
  if (bv < 0.81) return 'G (yellow)';
  if (bv < 1.4) return 'K (orange)';
  return 'M (red-orange)';
}

// ---- Rise / transit / set (cached) ------------------------------------------
const cache = new Map();
export function riseTransitSet(key, bodyName, loc, ms) {
  const ck = `${key}|${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}|${Math.floor(ms / 300000)}`;
  if (cache.has(ck)) return cache.get(ck);
  if (cache.size > 200) cache.clear();
  const Ast = A(); const o = observer(loc); const t = Ast.MakeTime(new Date(ms));
  const res = { rise: null, set: null, transit: null };
  try { const r = Ast.SearchRiseSet(bodyName, o, +1, t, 1.2); res.rise = r ? r.date : null; } catch {}
  try { const s = Ast.SearchRiseSet(bodyName, o, -1, t, 1.2); res.set = s ? s.date : null; } catch {}
  try { const h = Ast.SearchHourAngle(bodyName, o, 0, t); res.transit = h?.time?.date || null;
        res.transitAlt = h?.hor?.altitude; } catch {}
  cache.set(ck, res);
  return res;
}
export function defineStar(raDeg, decDeg) {
  A().DefineStar('Star1', raDeg / 15, decDeg, 1000);
  return 'Star1';
}
