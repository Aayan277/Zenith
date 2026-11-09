// Visible satellite pass predictor (Web Worker, classic script).
//
// Request:  { type:'compute', reqId, sats:[{id,name,l1,l2,std?}], lat, lon, elevM, startMs, days }
// Response: { type:'passes', reqId, passes:[{satId,name,start,max,end,startAz,maxAz,endAz,maxEl,mag,track}] }
//
// A pass is "visible" while ALL hold: satellite elevation > 10 deg, satellite is
// sunlit (cylindrical Earth shadow), and the Sun is below -6 deg at the observer
// (civil twilight ends). Strategy: coarse 30 s stepping, then bisection to 1 s on
// each edge of a visible run, then 2 s sampling for the peak and the sky track.
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const AU_KM = 149597870.7, RE_KM = 6371;
const MIN_EL = 10, MAX_SUN_ALT = -6;
const COARSE = 30000;

// Compact solar position (Meeus low-precision, ~0.01 deg). Returns ECI vector in km
// and equatorial coords in radians.
function sunPos(ms) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
  return { eci: { x: x * R, y: y * R, z: z * R }, u: { x, y, z }, ra: Math.atan2(y, x), dec: Math.asin(z) };
}

function makeCtx(req) {
  const { lat, lon, elevM } = req;
  const gd = { latitude: lat * D2R, longitude: lon * D2R, height: (elevM || 0) / 1000 };
  const obsEcf = satellite.geodeticToEcf(gd);
  return { gd, obsEcf, latR: gd.latitude, lonR: gd.longitude };
}

// Everything we need about (satrec, time).
function sample(rec, ctx, ms) {
  const d = new Date(ms);
  const pv = satellite.propagate(rec, d);
  if (!pv.position) return null;
  const gmst = satellite.gstime(d);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const la = satellite.ecfToLookAngles(ctx.gd, ecf);
  const sun = sunPos(ms);
  // Sun altitude at observer
  const H = gmst + ctx.lonR - sun.ra;
  const sunAlt = Math.asin(Math.sin(ctx.latR) * Math.sin(sun.dec) + Math.cos(ctx.latR) * Math.cos(sun.dec) * Math.cos(H)) * R2D;
  // Cylindrical shadow
  const p = pv.position, u = sun.u;
  const dot = p.x * u.x + p.y * u.y + p.z * u.z;
  let sunlit = true;
  if (dot < 0) {
    const px = p.x - dot * u.x, py = p.y - dot * u.y, pz = p.z - dot * u.z;
    sunlit = Math.hypot(px, py, pz) > RE_KM;
  }
  return { ms, az: ((la.azimuth * R2D) % 360 + 360) % 360, el: la.elevation * R2D, range: la.rangeSat,
           sunAlt, sunlit, pos: p, sun, gmst };
}

const isVis = s => !!s && s.el > MIN_EL && s.sunlit && s.sunAlt < MAX_SUN_ALT;

// Estimated apparent magnitude: standard magnitude is defined at 1000 km, 50% illuminated
// (phase angle 90 deg); diffuse-sphere phase law.
function estMag(s, ctx, std) {
  const obsEci = satellite.ecfToEci(ctx.obsEcf, s.gmst);
  const a = { x: s.sun.eci.x - s.pos.x, y: s.sun.eci.y - s.pos.y, z: s.sun.eci.z - s.pos.z };
  const b = { x: obsEci.x - s.pos.x, y: obsEci.y - s.pos.y, z: obsEci.z - s.pos.z };
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z));
  const phi = Math.acos(Math.max(-1, Math.min(1, c)));
  const f = (Math.sin(phi) + (Math.PI - phi) * Math.cos(phi)) / Math.PI; // 1/pi at 90 deg
  return std + 5 * Math.log10(s.range / 1000) - 2.5 * Math.log10(Math.max(f, 1e-4) * Math.PI);
}

// Bisect predicate edge between a (pred false/true) and b (opposite) down to 1 s.
function bisect(rec, ctx, a, b, wantAtB) {
  while (b - a > 1000) {
    const m = Math.round((a + b) / 2);
    if (isVis(sample(rec, ctx, m)) === wantAtB) b = m; else a = m;
  }
  return wantAtB ? b : a; // first visible ms (rise) or last visible ms (set)
}

function passesFor(sat, ctx, startMs, endMs) {
  const rec = satellite.twoline2satrec(sat.l1, sat.l2);
  if (rec.error) return [];
  // Only low-Earth orbits make sky passes (>= ~10 rev/day); GEO/HEO objects hover for hours.
  if (rec.no * 1440 / (2 * Math.PI) < 10) return [];
  const out = [];
  let prevVis = false, prevT = startMs, runStart = null;
  const finish = (s, e) => {
    let best = null; const track = [];
    for (let t = s; t <= e + 1; t += 2000) {
      const x = sample(rec, ctx, Math.min(t, e));
      if (!x) continue;
      if (!best || x.el > best.el) best = x;
    }
    const n = 14, step = Math.max(1000, (e - s) / n);
    for (let t = s; t < e + step / 2; t += step) {
      const x = sample(rec, ctx, Math.min(t, e)); if (x) track.push([+x.az.toFixed(1), +x.el.toFixed(1)]);
    }
    const a = sample(rec, ctx, s), z = sample(rec, ctx, e);
    if (!best || !a || !z) return;
    out.push({ satId: sat.id, name: sat.name, start: s, max: best.ms, end: e,
      startAz: a.az, maxAz: best.az, endAz: z.az, maxEl: best.el,
      mag: +estMag(best, ctx, sat.std ?? 0).toFixed(1), track });
  };
  for (let t = startMs; t <= endMs; t += COARSE) {
    const vis = isVis(sample(rec, ctx, t));
    if (vis && !prevVis) runStart = t === startMs ? t : bisect(rec, ctx, prevT, t, true);
    if (!vis && prevVis) { finish(runStart, bisect(rec, ctx, prevT, t, false)); runStart = null; }
    prevVis = vis; prevT = t;
  }
  if (prevVis && runStart != null) finish(runStart, prevT);
  // Drop blips, anything longer than 20 min (high orbit) and naked-eye-invisible passes (mag > 4.5).
  return out.filter(p => p.end - p.start >= 20000 && p.end - p.start <= 20 * 60000 && p.mag <= 4.5);
}

self.onmessage = (ev) => {
  const req = ev.data;
  if (!req || req.type !== 'compute') return;
  try {
    const ctx = makeCtx(req);
    const end = req.startMs + req.days * 86400000;
    let passes = [];
    for (const s of req.sats) { try { passes = passes.concat(passesFor(s, ctx, req.startMs, end)); } catch (e) { /* skip bad TLE */ } }
    passes.sort((a, b) => a.start - b.start);
    self.postMessage({ type: 'passes', reqId: req.reqId, passes });
  } catch (e) {
    self.postMessage({ type: 'error', reqId: req.reqId, error: String(e && e.message || e) });
  }
};
