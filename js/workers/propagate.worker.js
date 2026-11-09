/* Skywatch propagation worker (classic worker).
 *
 * in : { type:'init', sats:[{id,l1,l2}] }          -> builds satrecs once
 *      { type:'tick', time:<sim ms>, seq:<n> }      -> propagates everything
 * out: { type:'ready', count, rejected }
 *      { type:'tick', seq, time, count, ids:Int32Array, ecef:Float32Array(3*count, km),
 *        sunlit:Uint8Array(count), sun:[x,y,z] (ECEF unit vector), ms:<compute time> }
 *      (buffers are transferred, not copied)
 *
 * Satellites that fail to decode at init (bad TLE, already decayed) are dropped for good;
 * satellites that error at a particular time (decayed / sgp4 error) are omitted from that
 * tick only. `ids[i]` always matches `ecef[3i..3i+2]` and `sunlit[i]`.
 */
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const RE = 6378.137;           // Earth equatorial radius, km (shadow cylinder radius)
const D2R = Math.PI / 180;

let recs = [];                 // satrec per good sat
let ids = new Int32Array(0);
let epochMs = new Float64Array(0);

function init(list) {
  const rs = [], idl = [], ep = [];
  let rejected = 0;
  for (const s of list) {
    try {
      const r = satellite.twoline2satrec(s.l1, s.l2);
      if (r.error && r.error !== 0) { rejected++; continue; }
      // sanity: need a valid mean motion
      if (!(r.no > 0)) { rejected++; continue; }
      rs.push(r); idl.push(s.id);
      ep.push((r.jdsatepoch + (r.jdsatepochF || 0) - 2440587.5) * 86400000);
    } catch (e) { rejected++; }
  }
  recs = rs; ids = Int32Array.from(idl); epochMs = Float64Array.from(ep);
  postMessage({ type: 'ready', count: recs.length, rejected });
}

// Low-precision solar position (Astronomical Almanac, ~0.01 deg) -> ECEF unit vector.
function sunEcef(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;          // days since J2000
  const L = (280.460 + 0.9856474 * d) * D2R;
  const g = (357.528 + 0.9856003 * d) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * d) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ex = Math.cos(dec) * Math.cos(ra), ey = Math.cos(dec) * Math.sin(ra), ez = Math.sin(dec);
  const th = gmstRad(ms);
  const c = Math.cos(th), s = Math.sin(th);
  return [c * ex + s * ey, -s * ex + c * ey, ez];
}
function gmstRad(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  let g = (280.46061837 + 360.98564736629 * d) % 360;
  if (g < 0) g += 360;
  return g * D2R;
}

function tick(time, seq) {
  const t0 = performance.now();
  const n = recs.length;
  const outE = new Float32Array(n * 3);
  const outI = new Int32Array(n);
  const lit = new Uint8Array(n);
  const th = gmstRad(time);
  const c = Math.cos(th), s = Math.sin(th);
  const sun = sunEcef(time);
  const sx = sun[0], sy = sun[1], sz = sun[2];
  const RE2 = RE * RE;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const r = recs[i];
    const o = satellite.sgp4(r, (time - epochMs[i]) / 60000);
    const p = o && o.position;
    if (!p || p === true || !isFinite(p.x)) continue;
    // TEME -> ECEF (GMST rotation; polar motion ignored)
    const x = c * p.x + s * p.y, y = -s * p.x + c * p.y, z = p.z;
    const rr = x * x + y * y + z * z;
    if (rr < 6400 * 6400 * 0.9 || rr > 1e12) continue;       // decayed / garbage
    const j = k * 3;
    outE[j] = x; outE[j + 1] = y; outE[j + 2] = z;
    outI[k] = ids[i];
    // cylindrical Earth shadow
    const proj = x * sx + y * sy + z * sz;
    lit[k] = (proj < 0 && rr - proj * proj < RE2) ? 0 : 1;
    k++;
  }
  const ecef = k === n ? outE : outE.slice(0, k * 3);
  const oid = k === n ? outI : outI.slice(0, k);
  const ol = k === n ? lit : lit.slice(0, k);
  postMessage({ type: 'tick', seq, time, count: k, ids: oid, ecef, sunlit: ol, sun,
                ms: performance.now() - t0 }, [oid.buffer, ecef.buffer, ol.buffer]);
}

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') init(m.sats);
    else if (m.type === 'tick') tick(m.time, m.seq);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
