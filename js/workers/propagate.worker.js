/* Skywatch propagation worker (classic worker).
 *
 * in : { type:'sync', gen, order:Int32Array(ids, final slot order), cats:Uint8Array, hl:Uint8Array,
 *        addIds:Int32Array, add:string }       -> (re)builds the slot table. `add` holds "l1\nl2\n" for each
 *                                                 id in addIds; satrecs of ids seen before are kept, so growing the
 *                                                 catalog only builds the new ones.
 *      { type:'mask', cats:Uint8Array(per category), hlOnly, keep:Int32Array }
 *                                              -> which slots to propagate (hidden slots are left at 0,0,0)
 *      { type:'tick', time, seq, gen, recycle:[ArrayBuffer...] }
 *                                              -> propagate; `recycle` hands back buffers of stale ticks (pool)
 * out: { type:'ready', gen, count, rejected, ids:Int32Array }       slot i <-> ids[i] for this generation
 *      { type:'tick', gen, seq, time, count, ecef:Float32Array(3*count, km ECEF), sunlit:Uint8Array(count),
 *        sun:[x,y,z], ms }   buffers are transferred and pooled: no per-tick allocation in steady state.
 *
 * Slots are fixed for a generation: slot i is always ids[i]. A slot that is masked out, or whose sgp4 fails
 * at this particular time, is written as (0,0,0) with sunlit=1; consumers treat |ecef| = 0 as "no position".
 * Satellites with unusable TLEs are dropped when the slot table is built.
 */
importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const RE = 6378.137;           // Earth equatorial radius, km (shadow cylinder radius)
const D2R = Math.PI / 180;

const known = new Map();       // id -> { r: satrec, ep: epoch ms } | null (rejected)
let gen = 0;
let recs = [];                 // per slot
let epochMs = new Float64Array(0);
let slotIds = new Int32Array(0);
let slotCat = new Uint8Array(0);
let slotHl = new Uint8Array(0);
let n = 0;
let catOn = new Uint8Array(32).fill(1), hlOnly = false, keep = new Set();
let active = null;             // Uint8Array(n): slot is propagated (recomputed when mask/slots change)
let pool = [];

function buildRec(l1, l2) {
  try {
    const r = satellite.twoline2satrec(l1, l2);
    if (r.error && r.error !== 0) return null;
    if (!(r.no > 0)) return null;
    return { r, ep: (r.jdsatepoch + (r.jdsatepochF || 0) - 2440587.5) * 86400000 };
  } catch (e) { return null; }
}

function sync(m) {
  const t0 = performance.now();
  if (m.add && m.addIds) {
    const lines = m.add.split('\n');
    for (let i = 0; i < m.addIds.length; i++) known.set(m.addIds[i], buildRec(lines[2 * i], lines[2 * i + 1]));
  }
  const order = m.order;
  const keepIdx = [];
  for (let i = 0; i < order.length; i++) if (known.get(order[i])) keepIdx.push(i);
  n = keepIdx.length;
  recs = new Array(n); epochMs = new Float64Array(n); slotIds = new Int32Array(n);
  slotCat = new Uint8Array(n); slotHl = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const i = keepIdx[k], e = known.get(order[i]);
    recs[k] = e.r; epochMs[k] = e.ep; slotIds[k] = order[i]; slotCat[k] = m.cats[i]; slotHl[k] = m.hl[i];
  }
  gen = m.gen; pool = [];
  buildActive();
  postMessage({ type: 'ready', gen, count: n, rejected: order.length - n, ids: slotIds.slice(), ms: performance.now() - t0 });
}

function buildActive() {
  active = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    let on = catOn[slotCat[k]] === 1 && (!hlOnly || slotHl[k] === 1);
    if (!on && keep.size && keep.has(slotIds[k])) on = true;
    active[k] = on ? 1 : 0;
  }
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

function tick(m) {
  const t0 = performance.now();
  if (m.recycle) for (const b of m.recycle) pool.push(b);
  if (m.gen !== gen) { postMessage({ type: 'tick', stale: true, gen: m.gen, seq: m.seq }); return; }
  // take a pooled buffer pair (ecef + sunlit) or allocate one
  let ecef = null, lit = null;
  for (let i = pool.length - 1; i >= 0 && !(ecef && lit); i--) {
    const b = pool[i];
    if (!ecef && b.byteLength === n * 12) { ecef = new Float32Array(b); pool.splice(i, 1); }
    else if (!lit && b.byteLength === n) { lit = new Uint8Array(b); pool.splice(i, 1); }
  }
  if (pool.length > 8) pool.length = 0;   // stale sizes from an older generation
  if (!ecef) ecef = new Float32Array(n * 3);
  if (!lit) lit = new Uint8Array(n);
  const time = m.time;
  const th = gmstRad(time);
  const c = Math.cos(th), s = Math.sin(th);
  const sun = sunEcef(time);
  const sx = sun[0], sy = sun[1], sz = sun[2];
  const RE2 = RE * RE, MIN2 = 6400 * 6400 * 0.9;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    lit[i] = 1;
    if (active[i] === 0) { ecef[j] = 0; ecef[j + 1] = 0; ecef[j + 2] = 0; continue; }
    const o = satellite.sgp4(recs[i], (time - epochMs[i]) / 60000);
    const p = o && o.position;
    if (!p || p === true || !isFinite(p.x)) { ecef[j] = 0; ecef[j + 1] = 0; ecef[j + 2] = 0; continue; }
    // TEME -> ECEF (GMST rotation; polar motion ignored)
    const x = c * p.x + s * p.y, y = -s * p.x + c * p.y, z = p.z;
    const rr = x * x + y * y + z * z;
    if (rr < MIN2 || rr > 1e12) { ecef[j] = 0; ecef[j + 1] = 0; ecef[j + 2] = 0; continue; }   // decayed / garbage
    ecef[j] = x; ecef[j + 1] = y; ecef[j + 2] = z;
    const proj = x * sx + y * sy + z * sz;                  // cylindrical Earth shadow
    lit[i] = (proj < 0 && rr - proj * proj < RE2) ? 0 : 1;
  }
  postMessage({ type: 'tick', gen, seq: m.seq, time, count: n, ecef, sunlit: lit, sun, ms: performance.now() - t0 },
              [ecef.buffer, lit.buffer]);
}

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'sync') sync(m);
    else if (m.type === 'mask') {
      catOn = m.cats; hlOnly = !!m.hlOnly; keep = new Set(m.keep || []);
      if (n) buildActive();
    } else if (m.type === 'tick') tick(m);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
