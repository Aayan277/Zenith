// Deep-sky objects (Messier + famous NGC/IC) for the sky dome: data, symbols, hit-testing, detail provider and
// image lookup (NASA Image and Video Library, optional DSS survey cutout from CDS hips2fits).
//
// Drawing is done into sky.js's cached static layer (`drawDso`); labels are queued into its collision pass.
import * as state from '../state.js';
import { fmtLocal } from '../util/time.js';
import { raDecToVec, applyM, enuToAltAz, compass, riseTransitSet, defineStar, D2R } from './astro.js';
import { normalize, nasaUrl } from '../gallery/source.js';
import { COMMON_EXCLUDE, ART_EXCLUDE, DEFAULT_CENTERS } from '../gallery/telescopes.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const TYPE_STYLE = {
  'galaxy': { rgb: '255,166,128', label: 'Galaxy', short: 'galaxy' },
  'emission nebula': { rgb: '255,120,180', label: 'Emission nebula', short: 'nebula' },
  'supernova remnant': { rgb: '255,140,140', label: 'Supernova remnant', short: 'remnant' },
  'planetary nebula': { rgb: '90,232,204', label: 'Planetary nebula', short: 'planetary' },
  'open cluster': { rgb: '200,184,255', label: 'Open cluster', short: 'cluster' },
  'globular cluster': { rgb: '255,214,120', label: 'Globular cluster', short: 'globular' },
};

// ---- data ---------------------------------------------------------------------------------------------------------
export const dso = { list: [], byId: new Map(), ready: false };
let loading = null;
export function loadDso() {
  if (loading) return loading;
  loading = fetch(new URL('../../data/sky/dso.json', import.meta.url)).then(r => { if (!r.ok) throw new Error('dso.json ' + r.status); return r.json(); }).then(j => {
    const list = j.objects.map(o => {
      const v = raDecToVec(o.ra, o.dec, [0, 0, 0]);
      const a = o.ra * D2R, d = o.dec * D2R;
      let tx = 0, ty = 0, tz = 0;
      if (o.pa != null) {  // unit tangent at position angle pa (from north through east)
        const p = o.pa * D2R, n = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)], e = [-Math.sin(a), Math.cos(a), 0];
        tx = Math.cos(p) * n[0] + Math.sin(p) * e[0]; ty = Math.cos(p) * n[1] + Math.sin(p) * e[1]; tz = Math.cos(p) * n[2] + Math.sin(p) * e[2];
      }
      const style = TYPE_STYLE[o.type] || TYPE_STYLE.galaxy;
      return { ...o, x: v[0], y: v[1], z: v[2], tx, ty, tz, rgb: style.rgb, label: o.name || o.id };
    });
    list.sort((a, b) => a.mag - b.mag);
    dso.list = list; dso.byId = new Map(list.map(o => [o.id, o])); dso.ready = true;
    return dso;
  }).catch(e => { loading = null; console.error('[sky] dso', e); return dso; });
  return loading;
}
export const getDso = id => dso.byId.get(id) || null;

// ---- sprites (tinted glows) ---------------------------------------------------------------------------------------
const sprites = new Map();
function glow(rgb, shape) {
  const k = shape + rgb; let c = sprites.get(k); if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d');
  if (shape === 'sq') {          // soft square: stacked rounded rects fading outward, then a light blur
    g.filter = 'blur(3px)';
    for (let i = 0; i < 7; i++) {
      const half = 14 + i * 4.4, k = 48 - half; g.fillStyle = `rgba(${rgb},${0.085 - i * 0.008})`;
      g.beginPath(); g.roundRect(k, k, half * 2, half * 2, 5 + i * 1.4); g.fill();
    }
    g.filter = 'none';
  } else {
    const r = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    r.addColorStop(0, `rgba(${rgb},0.55)`); r.addColorStop(0.45, `rgba(${rgb},0.18)`); r.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = r; g.fillRect(0, 0, 96, 96);
  }
  sprites.set(k, c); return c;
}

// ---- drawing ------------------------------------------------------------------------------------------------------
// Pickable symbols of the last render of the static layer: parallel arrays (pooled).
export const hits = { n: 0, x: new Float32Array(256), y: new Float32Array(256), r: new Float32Array(256), a: new Float32Array(256), o: new Array(256).fill(null) };
export const visibleCount = () => hits.n;

/** Magnitude limit of what is shown at a given zoom (about the 20 brightest above the horizon at whole-sky zoom). */
export const magLimit = zoom => 5.9 + 1.5 * Math.log2(Math.max(1, zoom));

/**
 * env: { ctx, C (J2000 -> camera, 9), M (J2000 -> ENU, 9), S, cx, cy, W, H, zoom, lim, selId }
 */
export function drawDso(env) {
  hits.n = 0;
  if (!dso.ready) return;
  const { ctx, C, M, S, cx, cy, W, H, zoom, lim, selId } = env;
  const vis0 = clamp((lim - 3.0) / 3.0, 0, 1);           // objects are invisible in twilight / daylight
  if (vis0 <= 0.02 && !selId) return;
  const ml = magLimit(zoom);
  const zs = 1 + 0.12 * Math.log2(Math.max(1, zoom));
  const selObj = selId ? dso.byId.get(selId) : null;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const o of dso.list) {
    const sel = o.id === selId;
    if (o.mag > ml + 0.2 && !sel) { if (!selObj || selObj.mag < o.mag) break; continue; }   // sorted by magnitude; keep scanning only for a selected faint object
    let a = Math.min(1, clamp((ml - o.mag) / 0.9, 0, 1) * 0.5 + 0.5 * clamp((ml - o.mag) / 3, 0, 1)) * vis0;
    if (sel) a = Math.max(a, 0.9);
    if (a < 0.05) continue;
    const zc = C[6] * o.x + C[7] * o.y + C[8] * o.z, den = 1 + zc;
    if (den < 0.08) continue;
    const up = M[6] * o.x + M[7] * o.y + M[8] * o.z; if (up < -0.012) continue;
    if (up < 0.15) a *= 0.35 + 0.65 * clamp((up + 0.012) / 0.15, 0, 1);   // extinction near the horizon
    const k = 2 * S / den;
    const X = cx + k * (C[0] * o.x + C[1] * o.y + C[2] * o.z), Y = cy - k * (C[3] * o.x + C[4] * o.y + C[5] * o.z);
    if (X < -60 || X > W + 60 || Y < -60 || Y > H + 60) continue;
    // apparent half-size in px (arcmin -> rad -> px) with a per-type floor
    const real = o.size / 60 * D2R / 2 * k;
    const t = o.type;
    const floor = (t === 'galaxy' ? 4.4 : t === 'globular cluster' ? 3.9 : t === 'planetary nebula' ? 3.9 : t === 'open cluster' ? 4.8 : 5) * zs;
    const r = clamp(Math.max(real, floor), floor, 900);
    if (X + r < -20 || X - r > W + 20 || Y + r < -20 || Y - r > H + 20) continue;
    const rgb = o.rgb;
    ctx.globalAlpha = 1;
    // soft halo (the glow of the object), stronger for the large ones
    const big = r > 7;
    if (big || t === 'emission nebula' || t === 'supernova remnant') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, a * (t === 'emission nebula' || t === 'supernova remnant' ? 1.5 : 0.55));
      if (t === 'emission nebula' || t === 'supernova remnant') { const g = Math.min(r * 1.9, 1600); ctx.drawImage(glow(rgb, 'sq'), X - g, Y - g, g * 2, g * 2); }
      else if (t === 'galaxy' && o.pa != null) {
        const [ax, ay] = screenAngle(o, C, S, cx, cy, X, Y, k); const g = Math.min(r * 2.4, 1600);
        ctx.save(); ctx.translate(X, Y); ctx.rotate(Math.atan2(ay, ax)); ctx.scale(1, Math.max(0.25, o.ratio));
        ctx.drawImage(glow(rgb, 'rd'), -g, -g, g * 2, g * 2); ctx.restore();
      } else { const g = Math.min(r * 2.2, 1600); ctx.drawImage(glow(rgb, 'rd'), X - g, Y - g, g * 2, g * 2); }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.lineWidth = r > 14 ? 1.15 : 1.25;
    ctx.strokeStyle = `rgba(${rgb},${Math.min(1, a * 1.05).toFixed(3)})`;
    ctx.fillStyle = `rgba(${rgb},${(a * 0.9).toFixed(3)})`;
    const rr = Math.min(r, 1400);
    switch (t) {
      case 'galaxy': {
        let ang = 0, ratio = 0.62;
        if (o.pa != null) { const [ax, ay] = screenAngle(o, C, S, cx, cy, X, Y, k); ang = Math.atan2(ay, ax); ratio = o.ratio; }
        else ang = -0.5;
        ctx.beginPath(); ctx.ellipse(X, Y, rr, Math.max(1.6, rr * ratio), ang, 0, TAU); ctx.stroke();
        if (rr > 12) { const cg = Math.min(rr * 0.55, 90); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a * 0.7; ctx.drawImage(glow(rgb, 'rd'), X - cg, Y - cg, cg * 2, cg * 2); ctx.globalCompositeOperation = 'source-over'; }
        if (rr < 9) { ctx.globalAlpha = a * 0.5; ctx.beginPath(); ctx.arc(X, Y, 0.9, 0, TAU); ctx.fill(); }
        break;
      }
      case 'emission nebula': case 'supernova remnant': {
        const s = Math.min(rr, 1200);
        ctx.globalAlpha = 0.5; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.roundRect(X - s * 0.72, Y - s * 0.72, s * 1.44, s * 1.44, Math.min(4, s * 0.3)); ctx.stroke();
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a * 0.9; ctx.beginPath(); ctx.arc(X, Y, 1.1, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'planetary nebula':
        ctx.beginPath(); ctx.arc(X, Y, rr, 0, TAU); ctx.stroke();
        ctx.globalAlpha = a * 0.8; ctx.beginPath(); ctx.arc(X, Y, Math.max(0.9, rr * 0.2), 0, TAU); ctx.fill();
        break;
      case 'open cluster':
        ctx.lineWidth = 1.5; ctx.setLineDash([1.2, 3.1]);
        ctx.beginPath(); ctx.arc(X, Y, rr, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        break;
      case 'globular cluster': {
        ctx.beginPath(); ctx.arc(X, Y, rr, 0, TAU); ctx.stroke();
        const c = rr * 1.45; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(X - c, Y); ctx.lineTo(X + c, Y); ctx.moveTo(X, Y - c); ctx.lineTo(X, Y + c); ctx.stroke();
        break;
      }
    }
    ctx.globalAlpha = 1;
    // pick record (also what the label pass reads)
    const h = hits.n; if (h < hits.x.length) { hits.x[h] = X; hits.y[h] = Y; hits.r[h] = Math.min(rr, 400); hits.a[h] = a; hits.o[h] = o; hits.n++; }
  }
  ctx.restore();
}
const _sa = [0, 0];
function screenAngle(o, C, S, cx, cy, X, Y, k) {
  const e = 0.01, x = o.x + e * o.tx, y = o.y + e * o.ty, z = o.z + e * o.tz;
  const den = 1 + C[6] * x + C[7] * y + C[8] * z, k2 = 2 * S / den;
  _sa[0] = (cx + k2 * (C[0] * x + C[1] * y + C[2] * z)) - X; _sa[1] = (cy - k2 * (C[3] * x + C[4] * y + C[5] * z)) - Y;
  if (!_sa[0] && !_sa[1]) _sa[0] = 1;
  return _sa;
}
/** Apparent radius in px of the symbol of a drawn object (for the selection ring). */
export function symbolRadius(id) { for (let i = 0; i < hits.n; i++) if (hits.o[i].id === id) return hits.r[i]; return 10; }

/** Queue labels (low priority) for the symbols of the last static render. env: { zoom, selId, labels, compact, queue(key,text,x,y,r,prio,fs,fill) } */
export function queueDsoLabels(env) {
  if (!env.labels) return;
  const fs = env.compact ? 10 : 11, labelMag = magLimit(env.zoom) - (env.compact ? 1.6 : 1.1);
  for (let i = 0; i < hits.n; i++) {
    const o = hits.o[i], sel = o.id === env.selId, a = hits.a[i];
    if (!sel && (o.mag > labelMag || a < 0.3)) continue;
    env.queue('d:' + o.id, o.label, hits.x[i], hits.y[i], Math.min(hits.r[i], 60) + 2, sel ? 0 : 5.5 + o.mag / 14, fs,
      `rgba(${o.rgb.split(',').map(v => Math.round(+v * 0.55 + 255 * 0.45)).join(',')},${sel ? 0.98 : (0.62 * a).toFixed(3)})`);
  }
}

// ---- formatting helpers ---------------------------------------------------------------------------------------------
export function fmtDist(ly) {
  if (ly >= 1e9) return [(ly / 1e9).toFixed(1), 'billion ly'];
  if (ly >= 1e6) return [(ly / 1e6).toFixed(ly >= 1e7 ? 0 : 1), 'million ly'];
  return [Math.round(ly).toLocaleString('en-US'), 'ly'];
}
export function fmtSize(arcmin) {
  if (arcmin >= 60) return [(arcmin / 60).toFixed(1), '°'];
  if (arcmin >= 1) return [arcmin >= 10 ? String(Math.round(arcmin)) : arcmin.toFixed(1), '′'];
  return [String(Math.round(arcmin * 60)), '″'];
}
const equipment = (mag, size) => mag <= 6 && size >= 8 ? 'Naked eye (dark sky)' : mag <= 6.5 ? 'Naked eye / binoculars' : mag <= 9 ? 'Binoculars or small telescope' : 'Telescope';
export function bestSeenMonth(raDeg) {
  const sunRa = (raDeg - 180 + 360) % 360;                 // the Sun is 12 h away from an object culminating at midnight
  const doy = 79 + sunRa / 360 * 365.25;
  return MONTHS[Math.floor((((doy - 1) % 365.25) + 365.25) % 365.25 / 30.44) % 12];
}

// ---- images -----------------------------------------------------------------------------------------------------------
const PREFER = /hubble|spitzer|chandra|webb|jwst|galex|wise|herschel|xmm|nustar|fermi|swift|kepler|\bhst\b|stsci|cxc|esa/i;
const imgCache = new Map();        // id -> Promise<record|null>
const imgDone = new Map();         // id -> record|null (sync read for the provider)
const NASA = 'https://images-api.nasa.gov/search';

function matcher(o) {
  const ids = [o.id, ...(o.aka ? o.aka.split(',').map(s => s.trim()) : [])];
  const parts = [];
  for (const id of ids) {
    const m = id.match(/^(M|NGC|IC)\s*(\d+)$/i);
    if (!m) { if (id && id.length > 3) parts.push(esc(id)); continue; }
    const pre = m[1].toUpperCase();
    parts.push(pre === 'M' ? `(?:M|Messier)\\s?${m[2]}` : `${pre}\\s?${m[2]}`);
  }
  const nm = o.name ? o.name.replace(/\s+(Nebula|Galaxy|Cluster)$/i, '') : '';
  const strong = new RegExp(`(?:^|[^A-Za-z0-9])(?:${parts.join('|')})(?![0-9])`, 'i');
  const name = o.name ? new RegExp(esc(o.name).replace(/\\?'/g, "['’]?"), 'i') : null;
  const nameLoose = nm.length > 4 ? new RegExp(esc(nm), 'i') : null;
  return { strong, name, nameLoose };
}
/** Score of one normalised NASA record for an object; <= 0 means unusable. */
export function scoreImage(o, r, mt = matcher(o)) {
  const hay = `${r.title} ${r.kw.join(' ')} ${r.desc}`;
  if (COMMON_EXCLUDE.test(r.title) || ART_EXCLUDE.test(r.title)) return -1;
  if (!DEFAULT_CENTERS.test(r.center) && !/^(NSSDC|SSC|IPAC|LaRC)/i.test(r.center)) return -1;
  if (/\bartist[’']?s?\s+(concept|illustration|impression|rendering|depiction|view|animation)/i.test(r.desc)) return -1;
  if (/\b(portrait|astronomer|scientists?|team|poster|infographic|logo|diagram|chart|spectrum|light curve)\b/i.test(r.title)) return -1;
  let s = 0;
  if (mt.strong.test(r.title)) s += 6; else if (mt.strong.test(hay)) s += 2;
  if (mt.name?.test(r.title) || mt.nameLoose?.test(r.title)) s += 5; else if (mt.name?.test(hay) || mt.nameLoose?.test(hay)) s += 2;
  if (s < 2) return -1;
  if (PREFER.test(`${r.title} ${r.kw.join(' ')} ${r.credit} ${r.desc.slice(0, 400)}`)) s += 3;
  if (/^(STScI|GSFC|JPL|CXC|SAO|ARC)/i.test(r.center)) s += 1;
  s += Math.min(1.5, (r.w || 0) / 1600);                      // slightly prefer larger images
  if (r.title.length > 90) s -= 0.5;
  return s;
}
export function dsoQueries(o) { return o.q?.length ? o.q : [o.name || o.id, o.id]; }

async function fetchJson(url, ms = 9000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const res = await fetch(url, { signal: ac.signal }); if (!res.ok) throw new Error('NASA ' + res.status); return await res.json(); }
  finally { clearTimeout(t); }
}
function ssGet(k) { try { const s = sessionStorage.getItem('zenith:dsoimg:v1:' + k); return s ? JSON.parse(s) : undefined; } catch { return undefined; } }
function ssSet(k, v) { try { sessionStorage.setItem('zenith:dsoimg:v1:' + k, JSON.stringify(v)); } catch {} }

/** Best NASA image record for an object (or null). Results are cached (memory + sessionStorage). */
export function findImage(o) {
  let p = imgCache.get(o.id); if (p) return p;
  const stored = ssGet(o.id);
  if (stored !== undefined) { imgDone.set(o.id, stored); p = Promise.resolve(stored); imgCache.set(o.id, p); return p; }
  const mt = matcher(o);
  p = (async () => {
    let best = null, bs = 0;
    for (const q of dsoQueries(o).slice(0, 2)) {
      const j = await fetchJson(`${NASA}?${new URLSearchParams({ q, media_type: 'image', page_size: '60' })}`);
      for (const it of j?.collection?.items || []) {
        const r = normalize(it); if (!r) continue;
        const s = scoreImage(o, r, mt);
        if (s > bs) { bs = s; best = r; }
      }
      if (best && bs >= 9) break;
    }
    const rec = best ? { id: best.id, title: best.title, th: best.th, th2: best.th2, lg: best.lg, credit: best.credit, center: best.center } : null;
    ssSet(o.id, rec); imgDone.set(o.id, rec);
    return rec;
  })().catch(e => { imgCache.delete(o.id); console.warn('[sky] dso image', o.id, e?.message || e); return null; });
  imgCache.set(o.id, p);
  return p;
}

// Optional survey cutout (CDS hips2fits, DSS2 colour). Probed once with a timeout; the "Survey view" action only appears if it loads.
export function surveyUrl(o) {
  const fov = clamp(o.size / 60 * 2.2, 0.15, 12);
  return `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=${encodeURIComponent('CDS/P/DSS2/color')}&width=512&height=512&ra=${o.ra}&dec=${o.dec}&fov=${fov.toFixed(3)}&projection=TAN&format=jpg`;
}
const surveyState = new Map();     // id -> 'probing' | 'ok' | 'fail'
function probeSurvey(o) {
  if (surveyState.has(o.id)) return;
  surveyState.set(o.id, 'probing');
  const im = new Image(); let settled = false;
  const fin = ok => { if (settled) return; settled = true; surveyState.set(o.id, ok ? 'ok' : 'fail'); im.onload = im.onerror = null; };
  im.onload = () => fin(im.naturalWidth > 16); im.onerror = () => fin(false);
  setTimeout(() => fin(false), 7000);
  im.referrerPolicy = 'no-referrer'; im.src = surveyUrl(o);
}

// ---- detail provider ------------------------------------------------------------------------------------------------------
const viewMode = new Map();        // id -> 'photo' | 'survey'
export function registerDsoProvider(ctx) {
  state.registerDetailProvider('dso', (sel, nowMs) => {
    const o = getDso(sel.id);
    if (!o) return dso.ready ? { title: String(sel.id), subtitle: 'Unknown deep-sky object', icon: 'star', stats: [], rows: [] } : null;
    try { return dsoDetail(o, nowMs, ctx); }
    catch (e) { console.error('[sky] dso detail', e); return { title: o.label, subtitle: o.type, icon: 'star', stats: [], rows: [], note: o.desc }; }
  });
}
function dsoDetail(o, nowMs, ctx) {
  const A = window.Astronomy;
  const loc = state.get('location');
  const frame = ctx.frameAt(nowMs);
  const enu = applyM(frame.M, o.x, o.y, o.z);
  const aa = enuToAltAz(enu[0], enu[1], enu[2]);
  const rows = [];
  const style = TYPE_STYLE[o.type] || TYPE_STYLE.galaxy;
  const neverSets = (loc.lat >= 0 ? o.dec : -o.dec) > 90 - Math.abs(loc.lat);
  const neverRises = (loc.lat >= 0 ? -o.dec : o.dec) > 90 - Math.abs(loc.lat);
  rows.push({ label: 'Type', value: style.label });
  rows.push({ label: 'Constellation', value: o.con });
  rows.push({ label: 'Alt / az now', value: aa.alt > 0 ? `${aa.alt.toFixed(0)}° · ${compass(aa.az)} (${aa.az.toFixed(0)}°)` : `Below horizon (${aa.alt.toFixed(0)}°)` });
  if (A) {
    let rts = null;
    try { defineStar(o.ra, o.dec); rts = riseTransitSet('dso:' + o.id, 'Star1', loc, nowMs); } catch {}
    const t = d => (d ? fmtTimeLocal(new Date(d).getTime(), nowMs) : '—');
    if (neverSets) rows.push({ label: 'Visibility', value: 'Circumpolar: never sets' });
    else if (neverRises) rows.push({ label: 'Visibility', value: 'Never rises at your latitude' });
    else if (rts) { rows.push({ label: 'Rises', value: t(rts.rise) }); }
    if (rts) {
      rows.push({ label: 'Highest', value: t(rts.transit) + (rts.transitAlt != null ? ` · ${rts.transitAlt.toFixed(0)}°` : '') });
      if (!neverSets && !neverRises) rows.push({ label: 'Sets', value: t(rts.set) });
    }
  }
  rows.push({ label: 'Best seen', value: `${bestSeenMonth(o.ra)} (highest at midnight)` });
  rows.push({ label: 'Needs', value: equipment(o.mag, o.size) });
  if (o.aka && o.aka !== o.label) rows.push({ label: 'Also known as', value: o.aka });

  // media
  let media;
  const mode = viewMode.get(o.id) || 'photo';
  const img = imgDone.get(o.id);
  if (img === undefined) findImage(o);
  probeSurvey(o);
  if (mode === 'survey' && surveyState.get(o.id) === 'ok') {
    media = { src: surveyUrl(o), alt: `${o.label} in the Digitized Sky Survey`, caption: 'Survey view · DSS2 colour via CDS hips2fits' };
  } else if (img) {
    media = { src: img.th, alt: img.title || o.label, href: nasaUrl(img.id), caption: `${img.title ? img.title.slice(0, 80) + ' · ' : ''}${img.credit ? img.credit.split(/[,;]/)[0].slice(0, 40) : 'NASA'}` };
  }
  const [dv, du] = fmtDist(o.dist), [sv, su] = fmtSize(o.size);
  const actions = [
    { label: 'More photos', onClick: () => openMore(o) },
    { label: 'Center in sky', onClick: () => { state.set('view', 'sky'); state.emit('focus', { kind: 'dso', id: o.id }); } },
  ];
  if (surveyState.get(o.id) === 'ok') {
    actions.push({ label: mode === 'survey' ? 'Photo' : 'Survey view', onClick: () => { viewMode.set(o.id, mode === 'survey' ? 'photo' : 'survey'); } });
  }
  return {
    title: o.label, subtitle: o.name ? `${o.id} · ${style.label}` : `${style.label} in ${o.con}`, color: `rgb(${o.rgb})`, icon: 'star',
    media,
    stats: [{ label: 'Magnitude', value: o.mag.toFixed(1), unit: '' }, { label: 'Size', value: sv, unit: su }, { label: 'Distance', value: dv, unit: du }],
    rows, note: o.desc, actions,
  };
}
function fmtTimeLocal(t, refMs) {
  const hm = fmtLocal(t, { hour: 'numeric', minute: '2-digit' });
  const dk = ms => fmtLocal(ms, { year: 'numeric', month: 'numeric', day: 'numeric' });
  return dk(t) === dk(refMs) ? hm : t > refMs ? `${hm} (tomorrow)` : `${hm} (yesterday)`;
}

export function openMore(o) {
  import('./dso-gallery.js').then(m => m.openSearchGallery(o.name ? `${o.name}` : o.id, dsoQueries(o)[0], {
    queries: dsoQueries(o), kicker: o.name ? o.id : styleLabel(o), blurb: o.desc, include: matcherForGallery(o),
    meta: [['Type', (TYPE_STYLE[o.type] || {}).label || o.type], ['Constellation', o.con], ['Magnitude', o.mag.toFixed(1)], ['Distance', fmtDist(o.dist).join(' ')]],
  })).catch(e => { console.error('[sky] gallery', e); state.emit('toast', 'Could not open the photo gallery'); });
}
const styleLabel = o => (TYPE_STYLE[o.type] || {}).label || o.type;
function matcherForGallery(o) { const m = matcher(o); return new RegExp(`${m.strong.source}${m.name ? '|' + m.name.source : ''}${m.nameLoose ? '|' + m.nameLoose.source : ''}`, 'i'); }

// ---- search index (see search.js hint in the report) ---------------------------------------------------------------------------------
export function searchDso(query, limit = 6) {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' '); if (!q || !dso.ready) return [];
  const qn = q.replace(/^messier\s*/, 'm').replace(/^m\s+(\d)/, 'm$1');
  const out = [];
  for (const o of dso.list) {
    const id = o.id.toLowerCase().replace(/\s+/g, ''), nm = (o.name || '').toLowerCase(), aka = (o.aka || '').toLowerCase();
    let s = 0;
    if (id === qn.replace(/\s+/g, '') || id === qn) s = 100;
    else if (nm === q) s = 95;
    else if (nm.startsWith(q)) s = 80;
    else if (nm.split(/\s+/).some(w => w.startsWith(q))) s = 60;
    else if (q.length >= 3 && nm.includes(q)) s = 50;
    else if (q.length >= 3 && aka.replace(/\s+/g, '').includes(q.replace(/\s+/g, ''))) s = 45;
    else if (q.length >= 2 && id.startsWith(qn.replace(/\s+/g, ''))) s = 40;
    if (s) out.push([s - o.mag / 100, o]);
  }
  out.sort((a, b) => b[0] - a[0]);
  return out.slice(0, limit).map(x => x[1]);
}
