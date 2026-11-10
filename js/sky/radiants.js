// Meteor-shower radiants in the sky dome: a starburst with faint streaks at the radiant, a label with the ZHR, a few very
// subtle animated meteors near the peak (dark sky only, never with reduced motion), picking and a detail provider.
// Data comes from js/events/index.js (getShowers(year), activeShowers(ms)); falls back to js/events/showers.js.
import * as state from '../state.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { raDecToVec, applyM, enuToAltAz, compass, riseTransitSet, defineStar, computeBodies, D2R } from './astro.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const HOUR = 3600e3;
export const RADIANT_RGB = '255,222,150';

// ---- data ------------------------------------------------------------------------------------------------------------
let ev = null, evLoading = null;
function loadEvents() {
  if (evLoading) return evLoading;
  evLoading = (async () => {
    try { ev = await import('../events/index.js'); if (typeof ev.getShowers !== 'function' || typeof ev.activeShowers !== 'function') throw new Error('contract'); }
    catch {
      try {
        const m = await import('../events/showers.js');
        ev = { getShowers: m.showersForYear, activeShowers: ms => { const y = new Date(ms).getUTCFullYear(); return [y - 1, y, y + 1].flatMap(m.showersForYear).filter(s => ms >= s.start && ms <= s.end); } };
      } catch { ev = null; }
    }
    return ev;
  })();
  return evLoading;
}
const vecCache = new Map();
function decorate(s) {
  let r = vecCache.get(s.id);
  if (!r || r.ra !== s.ra || r.dec !== s.dec) { const v = raDecToVec(s.ra, s.dec, [0, 0, 0]); r = { ra: s.ra, dec: s.dec, x: v[0], y: v[1], z: v[2] }; vecCache.set(s.id, r); }
  return { ...s, x: r.x, y: r.y, z: r.z };
}
let activeCache = { key: -1, list: [] };
/** Showers active at ms (sync; the first call kicks off the async load and returns []). */
export function activeRadiants(ms) {
  if (!ev) { loadEvents().then(() => { activeCache.key = -1; onChange?.(); }); return []; }
  const key = Math.floor(ms / 600000);
  if (key === activeCache.key) return activeCache.list;
  let list = [];
  try { list = (ev.activeShowers(ms) || []).map(decorate); } catch (e) { console.warn('[sky] showers', e); }
  activeCache = { key, list };
  return list;
}
let onChange = null;
export const setRadiantChangeHandler = fn => { onChange = fn; };
export const activeKey = ms => activeRadiants(ms).map(s => s.id).join(',');

/** Find a shower (active or not) by id: the occurrence of the year nearest to ms. */
export function findRadiant(id, ms) {
  if (!ev) return null;
  const y = new Date(ms).getUTCFullYear();
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    let l = []; try { l = ev.getShowers(yy) || []; } catch {}
    for (const s of l) if ((s.id === id || s.name === id) && (!best || Math.abs(s.peak - ms) < Math.abs(best.peak - ms))) best = s;
  }
  return best ? decorate(best) : null;
}
/** Activity relative to the peak (0..1): halves every `hw` hours from the peak. */
export function activity(s, ms) {
  const hw = s.hw || 24;
  return Math.pow(0.5, Math.abs(ms - s.peak) / HOUR / hw);
}

// ---- drawing --------------------------------------------------------------------------------------------------------------
export const hits = { n: 0, x: new Float32Array(16), y: new Float32Array(16), a: new Float32Array(16), o: new Array(16).fill(null) };
let glowSprite = null;
function getGlow() {
  if (glowSprite) return glowSprite;
  glowSprite = document.createElement('canvas'); glowSprite.width = glowSprite.height = 64;
  const g = glowSprite.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, `rgba(${RADIANT_RGB},0.55)`); r.addColorStop(0.4, `rgba(${RADIANT_RGB},0.14)`); r.addColorStop(1, `rgba(${RADIANT_RGB},0)`);
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return glowSprite;
}
const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Static part (cached layer): starburst + faint streaks. env: { ctx, C, M, S, cx, cy, W, H, zoom, night, simNow, selId } */
export function drawRadiants(env) {
  hits.n = 0;
  const list = activeRadiants(env.simNow);
  if (!list.length || env.night < 0.05) return;
  const { ctx, C, M, S, cx, cy, W, H, zoom } = env;
  const zs0 = 1 + 0.1 * Math.log2(Math.max(1, zoom));
  ctx.save(); ctx.lineCap = 'round';
  for (const s of list) {
    const zc = C[6] * s.x + C[7] * s.y + C[8] * s.z, den = 1 + zc; if (den < 0.08) continue;
    const up = M[6] * s.x + M[7] * s.y + M[8] * s.z; if (up < -0.03) continue;
    const k = 2 * S / den;
    const X = cx + k * (C[0] * s.x + C[1] * s.y + C[2] * s.z), Y = cy - k * (C[3] * s.x + C[4] * s.y + C[5] * s.z);
    if (X < -70 || X > W + 70 || Y < -70 || Y > H + 70) continue;
    const act = activity(s, env.simNow);
    const str = clamp(Math.sqrt(s.zhr * (0.3 + 0.7 * act) / 50), 0.4, 1.15);   // weak showers (Taurids) stay subtle
    let a = env.night * (0.5 + 0.5 * act) * str;
    if (up < 0.1) a *= clamp((up + 0.03) / 0.13, 0.25, 1);
    const sel = s.id === env.selId; if (sel) a = Math.max(a, 0.85);
    const rgb = RADIANT_RGB, zs = zs0 * (0.7 + 0.3 * str);
    ctx.globalCompositeOperation = 'lighter';
    const g = 30 * zs; ctx.globalAlpha = a * 0.7; ctx.drawImage(getGlow(), X - g, Y - g, g * 2, g * 2);
    ctx.globalAlpha = 1;
    // faint short streaks radiating outward (deterministic per shower)
    const R = rnd(hash(s.id));
    for (let i = 0; i < 16; i++) {
      const ang = R() * TAU, r0 = (13 + R() * 14) * zs, len = (9 + R() * 22 * (0.5 + 0.5 * act)) * zs, ca = Math.cos(ang), sa = Math.sin(ang);
      const gr = ctx.createLinearGradient(X + ca * r0, Y + sa * r0, X + ca * (r0 + len), Y + sa * (r0 + len));
      gr.addColorStop(0, `rgba(${rgb},${(a * 0.34).toFixed(3)})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      ctx.strokeStyle = gr; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X + ca * r0, Y + sa * r0); ctx.lineTo(X + ca * (r0 + len), Y + sa * (r0 + len)); ctx.stroke();
    }
    // starburst: 8 rays, long/short alternating
    ctx.strokeStyle = `rgba(${rgb},${(a * 0.85).toFixed(3)})`; ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = i * Math.PI / 4 + 0.2, l = (i % 2 ? 7 : 12.5) * zs, ca = Math.cos(ang), sa = Math.sin(ang);
      ctx.moveTo(X + ca * 3.4, Y + sa * 3.4); ctx.lineTo(X + ca * l, Y + sa * l);
    }
    ctx.stroke();
    ctx.fillStyle = `rgba(255,248,226,${(a * 0.95).toFixed(3)})`; ctx.beginPath(); ctx.arc(X, Y, 1.7, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const h = hits.n; if (h < hits.x.length) { hits.x[h] = X; hits.y[h] = Y; hits.a[h] = a; hits.o[h] = s; hits.n++; }
  }
  ctx.restore();
}
export const radiantLabel = s => `${s.name} radiant · ZHR ${Math.round(s.zhr)}`;

// ---- meteors (per frame) ------------------------------------------------------------------------------------------------------
const POOL = 6;
const meteors = Array.from({ length: POOL }, () => ({ on: false, t0: 0, dur: 0, rx: 0, ry: 0, rz: 0, ex: 0, ey: 0, ez: 0, s0: 0, len: 0 }));
let nextSpawn = 0;
/** env: { ctx, C, M, S, cx, cy, W, H, ts, simNow, sunAlt, reduced } */
export function drawMeteors(env) {
  if (env.reduced) return;
  const { ctx, C, M, S, cx, cy, W, H, ts } = env;
  if (env.sunAlt > -12) return;
  const list = activeRadiants(env.simNow);
  // radiants that are near their peak and above the horizon
  let cand = null, wsum = 0;
  for (const s of list) {
    const act = activity(s, env.simNow); if (act < 0.5) continue;
    const up = M[6] * s.x + M[7] * s.y + M[8] * s.z; if (up < 0.12) continue;
    const w = s.zhr * act * up; wsum += w;
    if (!cand || Math.random() * wsum < w) cand = s;
  }
  if (cand && ts >= nextSpawn) {
    const rateHz = clamp(wsum / 220, 0.12, 0.45);       // at most about one meteor every 2.2 s at a rich peak
    nextSpawn = ts + (700 + Math.random() * 1300) / rateHz;
    const m = meteors.find(q => !q.on);
    if (m) {
      const th = Math.random() * TAU, vx = cand.x, vy = cand.y, vz = cand.z;
      // tangent basis at the radiant
      let ax = -vy, ay = vx, az = 0; const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al;
      const bx = vy * az - vz * ay, by = vz * ax - vx * az, bz = vx * ay - vy * ax;
      m.rx = vx; m.ry = vy; m.rz = vz;
      m.ex = Math.cos(th) * ax + Math.sin(th) * bx; m.ey = Math.cos(th) * ay + Math.sin(th) * by; m.ez = Math.cos(th) * az + Math.sin(th) * bz;
      m.s0 = (9 + Math.random() * 32) * D2R; m.len = (5 + Math.random() * 9) * D2R; m.t0 = ts; m.dur = 380 + Math.random() * 380; m.on = true;
    }
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (const m of meteors) {
    if (!m.on) continue;
    const t = (ts - m.t0) / m.dur;
    if (t >= 1) { m.on = false; continue; }
    const head = m.s0 + m.len * t, tail = m.s0 + m.len * Math.max(0, t - 0.45);
    const p = (s, out) => { const c = Math.cos(s), n = Math.sin(s); out[0] = c * m.rx + n * m.ex; out[1] = c * m.ry + n * m.ey; out[2] = c * m.rz + n * m.ez; return out; };
    p(head, P1); p(tail, P2);
    const a = Math.sin(Math.PI * t) * 0.8;
    if (!sp(P1, C, M, S, cx, cy, Q1) || !sp(P2, C, M, S, cx, cy, Q2)) continue;
    if (Q1[0] < -20 || Q1[0] > W + 20 || Q1[1] < -20 || Q1[1] > H + 20) continue;
    const g = ctx.createLinearGradient(Q2[0], Q2[1], Q1[0], Q1[1]);
    g.addColorStop(0, 'rgba(255,240,205,0)'); g.addColorStop(1, `rgba(255,250,235,${a.toFixed(3)})`);
    ctx.strokeStyle = g; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(Q2[0], Q2[1]); ctx.lineTo(Q1[0], Q1[1]); ctx.stroke();
  }
  ctx.restore();
}
const P1 = [0, 0, 0], P2 = [0, 0, 0], Q1 = [0, 0], Q2 = [0, 0];
function sp(v, C, M, S, cx, cy, out) {
  const den = 1 + C[6] * v[0] + C[7] * v[1] + C[8] * v[2]; if (den < 0.08) return false;
  if (M[6] * v[0] + M[7] * v[1] + M[8] * v[2] < 0.01) return false;    // below the horizon
  const k = 2 * S / den; out[0] = cx + k * (C[0] * v[0] + C[1] * v[1] + C[2] * v[2]); out[1] = cy - k * (C[3] * v[0] + C[4] * v[1] + C[5] * v[2]); return true;
}
export const meteorsActive = () => meteors.some(m => m.on);

// ---- detail provider ------------------------------------------------------------------------------------------------------------
const f0 = x => Math.round(x).toLocaleString('en-US');
const fmtRa = deg => { const h = deg / 15, hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${hh}h ${String(mm === 60 ? 59 : mm).padStart(2, '0')}m`; };
const fmtDec = d => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)}°`;
const dateOpts = { month: 'short', day: 'numeric' };

export function registerRadiantProvider(ctx) {
  state.registerDetailProvider('radiant', (sel, nowMs) => {
    if (!ev) { loadEvents().then(() => onChange?.()); return null; }
    const s = findRadiant(sel.id, nowMs);
    if (!s) return { title: String(sel.id), subtitle: 'Unknown meteor shower', icon: 'star', stats: [], rows: [] };
    try { return radiantDetail(s, nowMs, ctx); }
    catch (e) { console.error('[sky] radiant detail', e); return { title: `${s.name} radiant`, subtitle: 'Meteor shower', icon: 'star', stats: [], rows: [], note: s.note || '' }; }
  });
}
function radiantDetail(s, nowMs, ctx) {
  const A = window.Astronomy, loc = state.get('location');
  const frame = ctx.frameAt(nowMs);
  const enu = applyM(frame.M, s.x, s.y, s.z), aa = enuToAltAz(enu[0], enu[1], enu[2]);
  const bodies = computeBodies(nowMs, loc, frame, true);
  const sun = bodies.find(b => b.name === 'Sun'), moon = bodies.find(b => b.name === 'Moon');
  const moonUp = moon && moon.alt > 0, illum = moon ? moon.phaseFrac : 0;
  const moonPen = moonUp ? clamp(1 - 0.7 * illum, 0.3, 1) : 1;
  const act = activity(s, nowMs), active = nowMs >= s.start && nowMs <= s.end;
  const dark = !sun || sun.alt < -6;
  const sinAlt = Math.max(0, Math.sin(aa.alt * D2R));
  const rate = dark && active ? s.zhr * act * sinAlt * moonPen : 0;
  let con = ''; try { con = A.Constellation(s.ra / 15, s.dec).name; } catch {}
  const rows = [];
  rows.push({ label: 'Peak', value: `${fmtLocal(s.peak, { ...dateOpts, hour: 'numeric', minute: '2-digit' })} ${tzLabel(s.peak)}` });
  rows.push({ label: 'Active', value: `${fmtLocal(s.start, dateOpts)} – ${fmtLocal(s.end, dateOpts)}` });
  rows.push({ label: 'Activity now', value: !active ? 'Not active' : `${Math.round(act * 100)}% of peak` });
  rows.push({ label: 'Radiant', value: `${fmtRa(s.ra)} ${fmtDec(s.dec)}${con ? ' · ' + con : ''}` });
  rows.push({ label: 'Alt / az now', value: aa.alt > 0 ? `${aa.alt.toFixed(0)}° · ${compass(aa.az)}` : `Below horizon (${aa.alt.toFixed(0)}°)` });
  try {
    defineStar(s.ra, s.dec);
    const r = riseTransitSet('rad:' + s.id, 'Star1', loc, nowMs);
    const dk = ms => fmtLocal(ms, { year: 'numeric', month: 'numeric', day: 'numeric' });
    const t = d => { if (!d) return '—'; const ms = new Date(d).getTime(); return `${fmtLocal(ms, { hour: 'numeric', minute: '2-digit' })} ${tzLabel(ms)}${dk(ms) === dk(nowMs) ? '' : ms > nowMs ? ' (tomorrow)' : ' (yesterday)'}`; };
    if (r.rise || r.set) { rows.push({ label: 'Rises', value: t(r.rise) }); rows.push({ label: 'Highest', value: t(r.transit) + (r.transitAlt != null ? ` · ${r.transitAlt.toFixed(0)}°` : '') }); rows.push({ label: 'Sets', value: t(r.set) }); }
    else rows.push({ label: 'Visibility', value: r.transitAlt > 0 ? 'Circumpolar: always up' : 'Never rises at your latitude' });
  } catch {}
  rows.push({ label: 'Moon', value: moon ? `${Math.round(illum * 100)}% lit · ${moonUp ? 'up' : 'down'}${moonUp ? ` (rate ×${moonPen.toFixed(2)})` : ''}` : '—' });
  if (s.best) rows.push({ label: 'Best time', value: s.best });
  const tips = `Look about 40° away from the radiant, with a wide view of the sky, no optics, and give your eyes 20 minutes to adapt. ${moonUp && illum > 0.5 ? 'A bright Moon will wash out the fainter meteors. ' : ''}${aa.alt < 20 ? 'The radiant is low now: it will be better when it climbs. ' : ''}`;
  const sub = !active ? 'Not active now' : !dark ? 'Sky too bright now' : aa.alt > 0 ? 'Radiant above your horizon' : 'Radiant below your horizon';
  return {
    title: `${s.name}`, subtitle: sub, color: `rgb(${RADIANT_RGB})`, icon: 'star',
    stats: [{ label: 'ZHR', value: f0(s.zhr), unit: '/h' }, { label: 'Expected now', value: rate >= 1 ? f0(rate) : rate > 0 ? '<1' : '0', unit: '/h' }, { label: 'Speed', value: f0(s.speed), unit: 'km/s' }],
    rows: [{ label: 'Parent body', value: s.parent || '—' }, ...rows],
    note: `${s.note ? s.note + ' ' : ''}${tips}`.trim(),
    actions: [{ label: 'Center in sky', onClick: () => { state.set('view', 'sky'); state.emit('focus', { kind: 'radiant', id: s.id }); } }],
  };
}
export const radiantEnu = (id, M, ms) => { const s = findRadiant(id, ms) || activeRadiants(ms).find(q => q.id === id); return s ? applyM(M, s.x, s.y, s.z, [0, 0, 0]) : null; };
export const radiantEquatorial = (id, ms) => findRadiant(id, ms) || activeRadiants(ms).find(q => q.id === id) || null;
export { loadEvents as loadShowers };
