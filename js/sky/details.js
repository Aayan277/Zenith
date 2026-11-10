// Detail-panel providers for sky objects: body, star, constellation.
import * as state from '../state.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { computeBodies, makeFrame, applyM, enuToAltAz, compass, riseTransitSet, defineStar, observer,
  bvToTemp, tempToRGB, spectralClass, raDecToVec, BODY_COLORS, AU_KM, R2D } from './astro.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GREEK = { α: 'Alpha', β: 'Beta', γ: 'Gamma', δ: 'Delta', ε: 'Epsilon', ζ: 'Zeta', η: 'Eta', θ: 'Theta', ι: 'Iota', κ: 'Kappa', λ: 'Lambda', μ: 'Mu', ν: 'Nu', ξ: 'Xi', ο: 'Omicron', π: 'Pi', ρ: 'Rho', σ: 'Sigma', τ: 'Tau', υ: 'Upsilon', φ: 'Phi', χ: 'Chi', ψ: 'Psi', ω: 'Omega' };

const dayKey = ms => fmtLocal(ms, { year: 'numeric', month: 'numeric', day: 'numeric' });
export function fmtTime(d, refMs) {
  if (!d) return '—';
  const t = new Date(d).getTime();
  const hm = fmtLocal(t, { hour: 'numeric', minute: '2-digit' }) + ' ' + tzLabel(t);
  if (dayKey(t) === dayKey(refMs)) return hm;
  return t > refMs ? `${hm} (tomorrow)` : `${hm} (yesterday)`;
}
const fmtDay = d => fmtLocal(d.getTime(), { month: 'short', day: 'numeric' });
const f1 = (x, d = 1) => Number(x).toFixed(d);

function moonPhaseName(angle) {
  const a = ((angle % 360) + 360) % 360;
  if (a < 4 || a >= 356) return 'New Moon';
  if (a < 86) return 'Waxing Crescent';
  if (a < 94) return 'First Quarter';
  if (a < 176) return 'Waxing Gibbous';
  if (a < 184) return 'Full Moon';
  if (a < 266) return 'Waning Gibbous';
  if (a < 274) return 'Last Quarter';
  return 'Waning Crescent';
}

// --- SUN (js/sun/): the live Sun module is loaded lazily the first time the Sun is selected, then merges into this provider's output.
let sunMod = null, sunLoading = false;
function mergeSun(base, nowMs) {
  if (sunMod) return sunMod.mergeSunDetail(base, nowMs);
  if (!sunLoading) { sunLoading = true; import('../sun/index.js').then(m => { sunMod = m; }).catch(e => { sunLoading = false; console.error('[sun]', e); }); }
  return base;
}
// --- /SUN

export function registerProviders(ctx) {
  const A = () => window.Astronomy;

  // ---- bodies ----
  state.registerDetailProvider('body', (sel, nowMs) => {
    if (sel.id === 'Aurora') return ctx.aurora ? ctx.aurora(nowMs) : null;
    if (!A()) return null;
    const loc = state.get('location');
    const frame = ctx.frameAt(nowMs);
    const b = computeBodies(nowMs, loc, frame, true, sel.id)[0];
    if (!b) return null;
    const rts = riseTransitSet('body:' + sel.id, sel.id, loc, nowMs);
    let con = '—'; try { con = A().Constellation(b.ra, b.dec).name; } catch {}
    const stats = [
      { label: 'Altitude', value: f1(b.alt), unit: '°' },
      { label: 'Azimuth', value: f1(b.az, 0), unit: '° ' + compass(b.az) },
    ];
    const rows = [];
    let icon = 'planet', note = '', subtitle = b.alt > 0 ? 'Above your horizon' : 'Below your horizon';
    if (sel.id === 'Sun') {
      icon = 'sun'; stats.push({ label: 'Distance', value: f1(b.distAU, 3), unit: 'AU' });
      note = b.alt > 0 ? 'Never look at the Sun directly without proper solar filters.' : 'The Sun is below your horizon.';
    } else if (sel.id === 'Moon') {
      icon = 'moon';
      const ph = A().MoonPhase(A().MakeTime(new Date(nowMs)));
      subtitle = moonPhaseName(ph) + (b.alt > 0 ? '' : ' · below horizon');
      stats.push({ label: 'Illuminated', value: f1(b.phaseFrac * 100, 0), unit: '%' });
      stats.push({ label: 'Magnitude', value: f1(b.mag), unit: '' });
      rows.push({ label: 'Distance', value: Math.round(b.distAU * AU_KM).toLocaleString() + ' km' });
      rows.push({ label: 'Age', value: f1(ph / 360 * 29.53) + ' days' });
      try {
        const t = A().MakeTime(new Date(nowMs));
        rows.push({ label: 'Next full moon', value: fmtDay(A().SearchMoonPhase(180, t, 40).date) });
        rows.push({ label: 'Next new moon', value: fmtDay(A().SearchMoonPhase(0, t, 40).date) });
      } catch {}
    } else {
      stats.push({ label: 'Magnitude', value: f1(b.mag), unit: '' });
      stats.push({ label: 'Distance', value: f1(b.distAU, 2), unit: 'AU' });
      rows.push({ label: 'Illuminated', value: f1(b.phaseFrac * 100, 0) + '%' });
      note = b.mag < 1 ? 'Bright enough to spot easily with the naked eye.' : b.mag < 5.5 ? 'Visible to the naked eye under dark skies.' : 'Needs binoculars or a telescope.';
    }
    rows.push({ label: 'Rises', value: fmtTime(rts.rise, nowMs) });
    rows.push({ label: 'Highest', value: fmtTime(rts.transit, nowMs) + (rts.transitAlt != null ? ` · ${f1(rts.transitAlt, 0)}°` : '') });
    rows.push({ label: 'Sets', value: fmtTime(rts.set, nowMs) });
    rows.push({ label: 'Constellation', value: con });
    const out = { title: sel.id, subtitle, color: BODY_COLORS[sel.id], icon, stats, rows, note,
      actions: [{ label: 'Center in sky', onClick: () => state.emit('focus', { kind: 'body', id: sel.id }) }] };
    return sel.id === 'Sun' ? mergeSun(out, nowMs) : out; // SUN: merge live solar data
  });

  // ---- stars ----
  state.registerDetailProvider('star', (sel, nowMs) => {
    const d = ctx.data(); if (!d || !A()) return null;
    const i = d.stars.byHip.get(sel.id); if (i === undefined) return null;
    const loc = state.get('location');
    const frame = ctx.frameAt(nowMs);
    const v = [d.stars.vec[i * 3], d.stars.vec[i * 3 + 1], d.stars.vec[i * 3 + 2]];
    const enu = applyM(frame.M, v[0], v[1], v[2]);
    const aa = enuToAltAz(enu[0], enu[1], enu[2]);
    const nm = d.names.get(sel.id);
    const ra = d.stars.ra[i], dec = d.stars.dec[i], mag = d.stars.mag[i], bv = d.stars.bv[i];
    let conName = '—', conAbbr = nm?.con || '';
    try { const c = A().Constellation(ra / 15, dec); conName = c.name; conAbbr = c.symbol; } catch {}
    const gen = d.consById.get(conAbbr);
    const bayer = nm?.bayer ? (GREEK[nm.bayer] || nm.bayer) : '';
    const title = nm?.name || (bayer ? `${bayer} ${conName}` : nm?.flam ? `${nm.flam} ${conName}` : `HIP ${sel.id}`);
    const desig = [nm?.bayer ? `${nm.bayer} ${conAbbr}` : '', `HIP ${sel.id}`].filter(Boolean).join(' · ');
    const T = bvToTemp(bv), rgb = tempToRGB(T).map(Math.round);
    defineStar(ra, dec);
    const rts = riseTransitSet('star:' + sel.id, 'Star1', loc, nowMs);
    const rows = [];
    // never sets: dec > 90-|lat| in same hemisphere; never rises: opposite
    const neverSets = (loc.lat >= 0 ? dec : -dec) > 90 - Math.abs(loc.lat);
    const neverRises = (loc.lat >= 0 ? -dec : dec) > 90 - Math.abs(loc.lat);
    if (neverSets) rows.push({ label: 'Visibility', value: 'Circumpolar — never sets' });
    else if (neverRises) rows.push({ label: 'Visibility', value: 'Never rises at your latitude' });
    else { rows.push({ label: 'Rises', value: fmtTime(rts.rise, nowMs) }); rows.push({ label: 'Sets', value: fmtTime(rts.set, nowMs) }); }
    rows.push({ label: 'Highest', value: fmtTime(rts.transit, nowMs) + (rts.transitAlt != null ? ` · ${f1(rts.transitAlt, 0)}°` : '') });
    rows.unshift({ label: 'Constellation', value: conName });
    rows.push({ label: 'Colour', value: `${Math.round(T / 100) * 100} K · ${spectralClass(bv)}` });
    rows.push({ label: 'RA / Dec', value: `${f1(ra / 15, 2)}h / ${f1(dec, 1)}°` });
    return {
      title, subtitle: desig, color: `rgb(${rgb.join(',')})`, icon: 'star',
      stats: [
        { label: 'Magnitude', value: f1(mag, 2), unit: '' },
        { label: 'Altitude', value: f1(aa.alt), unit: '°' },
        { label: 'Azimuth', value: f1(aa.az, 0), unit: '° ' + compass(aa.az) },
      ],
      rows, note: aa.alt < 0 ? 'Below your horizon right now.' : mag < 2.5 ? 'One of the brighter stars in the sky.' : '',
      actions: [{ label: 'Center in sky', onClick: () => state.emit('focus', { kind: 'star', id: sel.id }) }],
    };
  });

  // ---- constellations ----
  let conStats = null; // abbr -> {n, brightestIdx}
  function buildConStats(d) {
    conStats = new Map();
    const Ast = A();
    for (let i = 0; i < d.stars.n; i++) {
      if (d.stars.mag[i] > 5.0) continue;
      let abbr; try { abbr = Ast.Constellation(d.stars.ra[i] / 15, d.stars.dec[i]).symbol; } catch { continue; }
      let s = conStats.get(abbr); if (!s) conStats.set(abbr, s = { n: 0, best: i });
      s.n++;
      if (d.stars.mag[i] < d.stars.mag[s.best]) s.best = i;
    }
  }
  state.registerDetailProvider('constellation', (sel, nowMs) => {
    const d = ctx.data(); if (!d || !A()) return null;
    const c = d.consById.get(sel.id); if (!c) return null;
    const frame = ctx.frameAt(nowMs);
    const enu = applyM(frame.M, c.label[0], c.label[1], c.label[2]);
    const aa = enuToAltAz(enu[0], enu[1], enu[2]);
    if (!conStats) buildConStats(d);
    const st = conStats.get(sel.id);
    const rows = [];
    if (st) {
      const bi = st.best, nm = d.names.get(d.stars.hip[bi]);
      rows.push({ label: 'Brightest star', value: `${nm?.name || 'HIP ' + d.stars.hip[bi]} (${f1(d.stars.mag[bi], 1)})` });
      rows.push({ label: 'Naked-eye stars', value: String(st.n) });
    }
    // Best seen: when the constellation culminates at local midnight (Sun ~12h of RA away).
    const sunRa = (c.labelRa - 180 + 360) % 360;
    const doy = 79 + sunRa / 360 * 365.25;
    const monthIdx = Math.floor((((doy - 1) % 365.25) + 365.25) % 365.25 / 30.44) % 12;
    rows.push({ label: 'Best seen', value: `${MONTHS[monthIdx]} evenings` });
    rows.push({ label: 'Abbreviation', value: sel.id });
    const n = c.segs.reduce((a, s) => a + Math.max(0, s.length / 3 - 1), 0);
    return {
      title: c.name, subtitle: aa.alt > 0 ? 'Above your horizon' : 'Below your horizon', icon: 'constellation', color: '#7fd3ff',
      stats: [{ label: 'Altitude', value: f1(aa.alt, 0), unit: '°' }, { label: 'Azimuth', value: f1(aa.az, 0), unit: '° ' + compass(aa.az) }],
      rows, note: `The stick figure uses ${Math.round(n)} line segments between its brightest stars.`,
      actions: [{ label: 'Center in sky', onClick: () => state.emit('focus', { kind: 'constellation', id: sel.id }) }],
    };
  });
}
