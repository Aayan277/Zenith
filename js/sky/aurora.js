// Aurora in the sky dome.
//
// Physics (simplified, but geometrically honest):
//  * Emission sits in a shell ~95-330 km up: green 557.7 nm peaks just above the sharp lower border (~100-110 km)
//    and fades upward; red 630 nm is a broad, faint layer around 200-300 km.
//  * For every line of sight (azimuth, elevation) we march through that shell, with Earth curvature:
//      h(s) = sqrt(R² + s² + 2·R·s·sin el) − R,   ground range d(s) = R·atan2(s·cos el, R + s·sin el)
//    and integrate emissivity(h) × P(azimuth, d), where P is the aurora probability under that point.
//    Distant ovals therefore appear as a low band on the poleward horizon (long slant path), near ovals climb
//    overhead, and curtains straight above converge on the zenith.
//  * P comes from the NOAA OVATION nowcast grid when the sim time is within 45 min of its forecast time,
//    otherwise from a Kp-forecast oval (equatorward edge ≈ 67° − 2.1·Kp geomagnetic, see js/aurora/model.js).
//
// The (az, el) field depends only on location + data, so it is rebuilt rarely. The screen layer depends on the camera
// and is cached in two small offscreen canvases (two ray phases); per frame we only cross-fade them additively.
import { compass } from './astro.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { idle } from '../util/governor.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI, RE = 6371;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const AZN = 360, ELN = 181, EL_STEP = 0.5;          // field: 1° azimuth × 0.5° elevation
const DSTEP = 10, ND = 215;                          // probability along each bearing: 0..2140 km
const H0 = 92, H1 = 330, K = 30;                     // emission shell and march steps
const OVA_WINDOW = 45 * 60e3;

let A = null;                 // { aur, loadSmall, loadOvation, onAurora, geomagLat, sampleGrid, kpAt }
let onChange = () => {};
const st = {
  enabled: true, source: null, kp: null, mlat: 0, dark: 0, vis: 0,
  fieldKey: '', ver: 0, peak: 0, dirAz: 0, dirEl: 0, pctMax: 0, forecastAt: 0, elTop: new Float32Array(AZN),
};
const fG = new Float32Array(AZN * ELN), fR = new Float32Array(AZN * ELN), fP = new Float32Array(AZN * ELN);
const prob = new Float32Array(AZN * ND), arcW = new Float32Array(AZN * ND);
// Discrete arcs: real aurora is a few thin curtains aligned with geomagnetic latitude, not a uniform glow.
// Peaks every ~1.4° of geomagnetic latitude (~150 km), each ~25-40 km thick, with varying strength,
// on top of a weak diffuse background. The arcs are bent slightly with longitude so they are not perfect circles.
function arcs(m, lon) {
  const x = m / 1.4 + 0.18 * Math.sin(lon * D2R * 2.0 + 0.6) + 0.1 * Math.sin(lon * D2R * 5.0 + 2.0);
  const i = Math.floor(x), f = x - i - 0.5;
  const str = 0.45 + 0.55 * Math.abs(Math.sin(i * 12.9898 + 4.1));       // per-arc strength
  return 0.22 + 1.9 * str * Math.exp(-((f / 0.11) ** 2));
}
let rays = null;              // per elevation bin: { d: Float32Array(K), g, r }
let lastSmallReq = 0, lastOvaReq = 0;

// ---- setup -----------------------------------------------------------------------------------------------
export async function initAurora(changed) {
  onChange = changed || onChange;
  try {
    const [d, m] = await Promise.all([import('../aurora/data.js'), import('../aurora/model.js')]);
    A = { aur: d.aur, loadSmall: d.loadSmall, loadOvation: d.loadOvation, onAurora: d.onAurora,
      geomagLat: m.geomagLat, sampleGrid: m.sampleGrid, kpAt: m.kpAt };
    A.onAurora(() => { st.fieldKey = ''; onChange(); });
  } catch (e) { console.warn('[sky] aurora data unavailable', e.message); }
}

function buildRays() {
  rays = [];
  const gEm = h => (h < 95 ? 0 : (1 - Math.exp(-(h - 95) / 5)) * Math.exp(-Math.max(0, h - 108) / 30));
  const rEm = h => 0.075 * Math.exp(-(((h - 235) / 60) ** 2));
  const sAt = (h, se) => -RE * se + Math.sqrt(RE * RE * se * se + h * h + 2 * RE * h);
  for (let e = 0; e < ELN; e++) {
    const el = Math.max(0.1, e * EL_STEP) * D2R, se = Math.sin(el), ce = Math.cos(el);
    const s0 = sAt(H0, se), s1 = sAt(H1, se), ds = (s1 - s0) / K;
    const d = new Float32Array(K), g = new Float32Array(K), r = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const s = s0 + (k + 0.5) * ds;
      const h = Math.sqrt(RE * RE + s * s + 2 * RE * s * se) - RE;
      d[k] = RE * Math.atan2(s * ce, RE + s * se) / DSTEP;          // fractional index into the bearing table
      g[k] = gEm(h) * ds; r[k] = rEm(h) * ds;
    }
    rays.push({ d, g, r });
  }
}

// ---- data selection + field build ---------------------------------------------------------------------------
/** Called every frame (cheap). Returns the shared state object. */
export function updateAurora(loc, simNow, sunAlt, enabled) {
  st.enabled = enabled;
  st.dark = clamp((-8 - sunAlt) / 6, 0, 1);
  if (!enabled || !A || st.dark <= 0) { st.vis = 0; return st; }
  const aur = A.aur, now = Date.now();
  // 1) cheap Kp products first (the aurora module caches them in localStorage)
  if ((!aur.kp || now - aur.updatedAt > 15 * 60e3) && !aur.loading.small && now - lastSmallReq > 5 * 60e3) {
    lastSmallReq = now; A.loadSmall().catch(() => {});
  }
  const row = aur.kp ? A.kpAt(aur.kp, simNow) : null;
  st.kp = row ? row.kp : null;
  st.mlat = Math.abs(A.geomagLat(loc.lat, loc.lon));
  // 2) the 0.9 MB OVATION grid only when the oval could plausibly reach this sky and the nowcast is relevant
  const plausible = st.kp != null ? st.mlat >= (67 - 2.1 * st.kp) - 12 : st.mlat > 50;
  const nearLive = Math.abs(simNow - now) < 2 * 3600e3;
  const ova = aur.ovation;
  if (plausible && nearLive && !aur.loading.ovation && now - lastOvaReq > 5 * 60e3 && (!ova || now - aur.ovationAt > 15 * 60e3)) {
    lastOvaReq = now; A.loadOvation().catch(() => {});
  }
  const ovaT = ova ? (ova.forecast || ova.obs || ova.at) : 0;
  let source = null;
  if (ova && Math.abs(simNow - ovaT) <= OVA_WINDOW) source = 'ovation';
  else if (st.kp != null) source = 'kp';
  st.source = source; st.forecastAt = source === 'ovation' ? ovaT : (row ? row.t : 0);
  if (!source) { st.vis = 0; return st; }
  const key = `${source}|${source === 'ovation' ? aur.ovationAt : st.kp.toFixed(2)}|${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  if (key !== st.fieldKey) {
    st.fieldKey = key;
    const lk = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
    if (lk !== lastLocKey) { lastLocKey = lk; st.peak = 0; }   // never show another place's aurora while rebuilding
    buildField(loc, source);
  }
  st.vis = st.peak > 0.02 ? st.dark : 0;
  return st;
}

function kpProb(mlat, kp) {
  // Oval band: equatorward edge 67 − 2.1·Kp, ~6-11° wide, peak chance rising with Kp.
  const edge = 67 - 2.1 * kp, w = 6 + 0.55 * kp, c = edge + w * 0.45;
  const peak = clamp(0.18 + 0.075 * kp, 0.18, 0.9);
  const x = (Math.abs(mlat) - c) / (w * 0.5);
  return peak * Math.exp(-x * x * 1.6);
}

// The build (~60 ms of maths) is time-sliced over idle callbacks so it never stalls a frame; the previous field stays
// on screen until the new one is complete, then the buffers are swapped.
let job = null, running = false, lastLocKey = '';
const nG = new Float32Array(AZN * ELN), nR = new Float32Array(AZN * ELN), nP = new Float32Array(AZN * ELN);
const nTop = new Float32Array(AZN), colSum = new Float32Array(AZN);
function buildField(loc, source) {
  if (!rays) buildRays();
  const f1 = loc.lat * D2R;
  job = { l1: loc.lon * D2R, sf: Math.sin(f1), cf: Math.cos(f1), grid: source === 'ovation' ? A.aur.ovation.grid : null,
    kp: st.kp, phase: 0, b: 0, peak: 0, pmax: 0 };
  if (!running) { running = true; idle(runJob, 300); }
}
function runJob() {
  const j = job; if (!j) { running = false; return; }
  const t0 = performance.now();
  while (performance.now() - t0 < 7) {
    if (j.phase === 0) { probRow(j, j.b); if (++j.b === AZN) { j.phase = 1; j.b = 0; } }
    else { integrateRow(j, j.b); if (++j.b === AZN) { finish(j); return; } }
  }
  idle(runJob, 300);
}
function probRow(j, b) {
  const br = b * D2R, sb = Math.sin(br), cb = Math.cos(br), { sf, cf, l1, grid, kp } = j;
  for (let k = 0; k < ND; k++) {
    const dl = k * DSTEP / RE, sd = Math.sin(dl), cd = Math.cos(dl);
    const s2 = sf * cd + cf * sd * cb, f2 = Math.asin(clamp(s2, -1, 1));
    const l2 = l1 + Math.atan2(sb * sd * cf, cd - sf * s2);
    const lat = f2 * R2D, lon = l2 * R2D, m = A.geomagLat(lat, lon);
    const p = grid ? A.sampleGrid(grid, lat, lon) / 100 : kpProb(m, kp);
    prob[b * ND + k] = p;
    arcW[b * ND + k] = p > 0.04 ? Math.pow(p - 0.04, 1.15) * arcs(Math.abs(m), lon) : 0;   // emissivity
  }
}
function integrateRow(j, b) {
  const P = b * ND;
  let top = 0, sum = 0;
  for (let e = 0; e < ELN; e++) {
    const ray = rays[e];
    let G = 0, Rr = 0, Pw = 0, W = 0;
    for (let k = 0; k < K; k++) {
      const di = ray.d[k]; const i0 = di | 0; if (i0 >= ND - 1) break;
      const t = di - i0, em = arcW[P + i0] * (1 - t) + arcW[P + i0 + 1] * t;
      if (em <= 0) continue;
      const p = prob[P + i0] * (1 - t) + prob[P + i0 + 1] * t, eg = em * ray.g[k];
      G += eg; Rr += em * ray.r[k]; Pw += p * eg; W += eg;
    }
    const idx = b * ELN + e, pm = W > 0 ? Pw / W : 0;
    nG[idx] = G; nR[idx] = Rr; nP[idx] = pm;
    const I = 1 - Math.exp(-G * KN);
    if (I > 0.01) top = e * EL_STEP;
    if (I > j.peak) j.peak = I;
    sum += I;
    if (pm > j.pmax) j.pmax = pm;
  }
  nTop[b] = top; colSum[b] = sum;
}
function finish(j) {
  job = null; running = false;
  fG.set(nG); fR.set(nR); fP.set(nP); st.elTop.set(nTop);
  let here = 0; for (let b = 0; b < AZN; b += 10) here += prob[b * ND] / 36;
  let best = 0, bestSum = 0;
  for (let b = 0; b < AZN; b++) if (colSum[b] > bestSum) { bestSum = colSum[b]; best = b; }
  st.here = here; st.peak = j.peak; st.pctMax = Math.round(j.pmax * 100); st.dirAz = best;
  let m = 0; for (let e = 0; e < ELN; e++) { const I = fG[best * ELN + e]; if (I > m) { m = I; st.dirEl = e * EL_STEP; } }
  st.ver++;
  onChange();
}
const KN = 1 / 38;            // green column integral → display intensity

/** Field lookup (bilinear) at azimuth/elevation in degrees. */
function lookup(arr, az, el) {
  if (el < 0) el = 0;
  const x = ((az % 360) + 360) % 360, y = el / EL_STEP;
  const b0 = x | 0, b1 = (b0 + 1) % AZN, fx = x - b0;
  const e0 = Math.min(ELN - 2, y | 0), fy = Math.min(1, y - e0);
  const a = arr[b0 * ELN + e0] * (1 - fx) + arr[b1 * ELN + e0] * fx;
  const c = arr[b0 * ELN + e0 + 1] * (1 - fx) + arr[b1 * ELN + e0 + 1] * fx;
  return a + (c - a) * fy;
}

/** Hover info at a horizontal unit vector (east, north, up). */
export function auroraAt(e, n, u) {
  if (!st.vis || u < 0) return null;
  const az = Math.atan2(e, n) * R2D, el = Math.asin(clamp(u, -1, 1)) * R2D;
  const I = (1 - Math.exp(-lookup(fG, az, el) * KN)) * st.vis;
  if (I < 0.05) return null;
  return { I, pct: Math.round(lookup(fP, az, el) * 100), source: st.source };
}
export const auroraState = () => st;

// ---- screen layer -------------------------------------------------------------------------------------------
let single = false, cvA = null, cvB = null, ctxA = null, ctxB = null, layerKey = '', imgA = null, imgB = null;
const PH = [[0.3, 1.7, 4.1, 2.2], [2.4, 0.2, 1.1, 5.0]];
function rayMod(azR, ph) {
  // Rays cluster in bundles (slow envelope) instead of a uniform sunburst.
  const env = 0.5 + 0.5 * Math.sin(azR * 6 + ph[3]) * Math.sin(azR * 2.3 + ph[0]);
  const fine = 0.5 * Math.sin(azR * 41 + ph[0]) + 0.3 * Math.sin(azR * 97 + ph[1]) + 0.2 * Math.sin(azR * 233 + ph[2]);
  return 0.8 + 0.26 * env * fine + 0.12 * (env - 0.5);
}

/**
 * Rebuild the cached screen layer if needed. cam = { key, W, H, cx, cy, S, r:[3], u:[3], f:[3] }, cell in CSS px.
 */
export function prepareAuroraLayer(cam, cell, busy = false) {
  if (!st.vis) return false;
  const key = `${cam.key}|${st.ver}|${cell}|${busy}`;
  if (key === layerKey && cvA) return true;
  layerKey = key; single = busy;
  const nPh = busy ? 1 : 2;
  const bw = Math.ceil(cam.W / cell), bh = Math.ceil(cam.H / cell);
  if (!cvA || cvA.width !== bw || cvA.height !== bh) {
    cvA = document.createElement('canvas'); cvB = document.createElement('canvas');
    cvA.width = cvB.width = bw; cvA.height = cvB.height = bh;
    ctxA = cvA.getContext('2d'); ctxB = cvB.getContext('2d');
    imgA = ctxA.createImageData(bw, bh); imgB = ctxB.createImageData(bw, bh);
  }
  const da = imgA.data, db = imgB.data;
  const { cx, cy, S } = cam, [r0, r1, r2] = cam.r, [u0, u1, u2] = cam.u, [f0, f1, f2] = cam.f;
  const elTop = st.elTop;
  let o = 0;
  for (let y = 0; y < bh; y++) {
    const yy = (cy - (y + 0.5) * cell) / S;
    for (let x = 0; x < bw; x++, o += 4) {
      const xx = ((x + 0.5) * cell - cx) / S, rho2 = xx * xx + yy * yy, dd = 4 + rho2;
      const vr = 4 * xx / dd, vu = 4 * yy / dd, vf = (4 - rho2) / dd;
      const up = vr * r2 + vu * u2 + vf * f2;
      da[o] = da[o + 1] = da[o + 2] = db[o] = db[o + 1] = db[o + 2] = 0; da[o + 3] = db[o + 3] = 255;
      if (up < -0.003) continue;
      const e = vr * r0 + vu * u0 + vf * f0, n = vr * r1 + vu * u1 + vf * f1;
      let az = Math.atan2(e, n) * R2D; if (az < 0) az += 360;
      const el = Math.asin(up > 1 ? 1 : up) * R2D;
      if (el > elTop[az | 0] + 3 && el > elTop[((az | 0) + 1) % AZN] + 3) continue;
      const azR = az * D2R;
      // gentle folds of the lower border
      const elq = el - (0.55 * Math.sin(azR * 3 + 0.7) + 0.3 * Math.sin(azR * 8 + 2.1)) * (1 - up);
      const G = lookup(fG, az, elq), Rr = lookup(fR, az, elq);
      if (G < 1e-3 && Rr < 1e-3) continue;
      // rays: stronger up the curtain than at the bright lower edge
      for (let s = 0; s < nPh; s++) {
        const ray = rayMod(azR, PH[s]);
        const g = 1 - Math.exp(-G * KN * ray * 1.15), r = 1 - Math.exp(-Rr * KN * (0.7 + 0.3 * ray) * 1.15);
        const d = s ? db : da;
        d[o] = Math.min(255, 40 * g + 235 * r);
        d[o + 1] = Math.min(255, 255 * g + 40 * r);
        d[o + 2] = Math.min(255, 120 * g + 95 * r);
      }
    }
  }
  ctxA.putImageData(imgA, 0, 0); if (!busy) ctxB.putImageData(imgB, 0, 0);
  return true;
}

/** Per-frame draw: additive cross-fade of the two ray phases (gentle shimmer). */
export function drawAurora(ctx, W, H, ts, still) {
  if (!st.vis || !cvA) return;
  const t = ts / 1000;
  const w = single ? 0 : still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.21);
  const breath = still ? 1 : 0.93 + 0.07 * Math.sin(t * 0.13 + 1.3);
  const a = st.vis * breath;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = a * (1 - w); ctx.drawImage(cvA, 0, 0, W, H);
  ctx.globalAlpha = a * w; ctx.drawImage(cvB, 0, 0, W, H);
  ctx.restore();
}

// ---- words ----------------------------------------------------------------------------------------------------
const WORDS = { N: 'north', NNE: 'north', NE: 'northeast', ENE: 'east', E: 'east', ESE: 'east', SE: 'southeast', SSE: 'south',
  S: 'south', SSW: 'south', SW: 'southwest', WSW: 'west', W: 'west', WNW: 'west', NW: 'northwest', NNW: 'north' };
/** Header line, or '' when nothing worth mentioning is on screen. */
export function auroraHeadline() {
  const strength = st.vis ? st.peak * st.vis : 0;
  if (strength < 0.15) return '';
  const dir = WORDS[compass(st.dirAz)] || 'north';
  // Weak, distant ovals only tint the horizon: say so instead of promising a show.
  const where = strength < 0.35 ? `Faint aurora glow low in the ${dir} (camera may see more than your eyes)`
    : st.here > 0.25 || st.dirEl > 55 ? 'Aurora possible — look up' : `Aurora possible — look ${dir}`;
  return where + (st.source === 'kp' ? ' · estimated from Kp forecast' : '');
}

/** Detail-panel content for selection {kind:'body', id:'Aurora'}. */
export function auroraDetail(loc, nowMs) {
  const hemi = loc.lat >= 0 ? 'Northern' : 'Southern';
  const src = st.source === 'ovation' ? 'NOAA OVATION nowcast' : st.source === 'kp' ? 'Estimated from Kp forecast' : 'No data';
  const rows = [
    { label: 'Source', value: src },
    { label: st.source === 'ovation' ? 'Forecast for' : 'Kp block from', value: st.forecastAt ? `${fmtLocal(st.forecastAt, { hour: 'numeric', minute: '2-digit' }, loc)} ${tzLabel(st.forecastAt, loc)}` : '—' },
    { label: 'Geomagnetic latitude', value: `${st.mlat.toFixed(1)}°` },
    { label: 'Sky', value: st.dark >= 1 ? 'Dark enough' : st.dark > 0 ? 'Getting dark' : 'Too bright' },
  ];
  return {
    title: 'Aurora', subtitle: `${hemi} lights · ${st.vis ? 'in your sky' : 'not visible now'}`, color: '#5ce1a5', icon: 'star',
    stats: [
      { label: 'Chance', value: String(st.pctMax), unit: '%' },
      { label: 'Kp', value: st.kp != null ? st.kp.toFixed(1) : '—', unit: '' },
      { label: 'Overhead', value: String(Math.round((st.here || 0) * 100)), unit: '%' },
      { label: 'Look', value: st.here > 0.25 || st.dirEl > 55 ? 'up' : compass(st.dirAz), unit: st.here > 0.25 || st.dirEl > 55 ? '' : `${Math.round(st.dirEl)}° high` },
    ],
    rows,
    note: 'Aurora curtains glow 100–300 km up: green oxygen light at the lower edge, faint red above. From far away they sit low on the poleward horizon.',
  };
}
