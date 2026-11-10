// Sky-event computation for one observer: meteor showers, eclipses, Moon phases, planet events, seasons.
// Pure astronomy-engine maths, no DOM. Heavy scans are split into small tasks that run in idle time (see runTasks).
import { tzOffsetMinutes } from '../util/time.js';
import { showersForYear } from './showers.js';

const A = () => window.Astronomy;
const H = 3600e3, DAY = 86400e3, D2R = Math.PI / 180;
const AU_KM = 149597870.7;
const T = t => t.date.getTime();                       // AstroTime -> ms
const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
const FULL_NAMES = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Harvest', "Hunter's", 'Beaver', 'Cold'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const PLANET_COLOR = { Mercury: '#b9b2a6', Venus: '#fff1c9', Mars: '#ff7b54', Jupiter: '#f2cf9b', Saturn: '#ead58b', Moon: '#f4f1e2', Sun: '#ffb347' };

// ---------- observer helpers ----------
export function makeObs(loc) {
  const obs = new (A().Observer)(loc.lat, loc.lon, loc.elevM || 0);
  const alt = (body, ms) => {
    const d = new Date(ms), eq = A().Equator(body, d, obs, true, true);
    return A().Horizon(d, obs, eq.ra, eq.dec, 'normal').altitude;
  };
  const radiantAlt = (ra, dec, ms) => A().Horizon(new Date(ms), obs, ra / 15, dec, 'normal').altitude;
  return { obs, alt, radiantAlt };
}

/** When (within +-14 h of ms) is `body` highest while the sky is at least civil-dark? { ms, alt } or null. */
function bestView(O, body, ms, minAlt = 8) {
  let best = null;
  for (let t = ms - 14 * H; t <= ms + 14 * H; t += 30 * 60e3) {
    if (O.alt('Sun', t) > -6) continue;
    const a = O.alt(body, t);
    if (a > minAlt && (!best || a > best.alt)) best = { ms: t, alt: a };
  }
  return best;
}

// ---------- meteor showers ----------
const RATING = [[45, 'Excellent'], [18, 'Good'], [7, 'Fair'], [0, 'Poor']];
/**
 * Viewing quality of a shower for this observer. Samples the nights around the peak every 30 minutes, keeps dark samples
 * (Sun below -12 deg) and scores each by activity profile x sin(radiant altitude) x Moon penalty; the best 3-hour stretch wins.
 * `range` {from,to} restricts the sampling (e.g. tonight's dark window). Returns { rate (meteors/hour estimate), rating, moonIllum (at peak), radiantAlt, bestStart, bestEnd, bestMs, dark }.
 */
export function evaluateShower(sh, loc, O = makeObs(loc), range = null) {
  const moonPeak = A().Illumination('Moon', new Date(sh.peak)).phase_fraction;
  const nights = new Map(), lonOff = loc.lon / 15 * H;
  const t0 = range?.from ?? sh.peak - 30 * H, t1 = range?.to ?? sh.peak + 30 * H;
  for (let t = t0; t <= t1; t += 30 * 60e3) {
    if (O.alt('Sun', t) > -12) continue;
    const key = Math.floor((t + lonOff - 12 * H) / DAY);
    let n = nights.get(key); if (!n) nights.set(key, n = { illum: A().Illumination('Moon', new Date(t)).phase_fraction, s: [] });
    const rAlt = O.radiantAlt(sh.ra, sh.dec, t), mAlt = O.alt('Moon', t);
    const act = Math.pow(2, -Math.abs(t - sh.peak) / H / sh.hw);
    const mf = mAlt > 0 ? 1 - 0.8 * n.illum : 1;
    n.s.push({ t, rAlt, mAlt, v: act * Math.sin(Math.max(0, rAlt) * D2R) * mf });
  }
  let best = null;
  for (const n of nights.values()) {
    const s = n.s, w = Math.min(6, s.length);
    for (let i = 0; i + w <= s.length; i++) {
      let sum = 0; for (let j = i; j < i + w; j++) sum += s[j].v;
      if (!best || sum / w > best.mean) best = { mean: sum / w, a: s[i], b: s[i + w - 1], mid: s[i + (w >> 1)], illum: n.illum };
    }
  }
  if (!best) return { rate: 0, rating: 'Poor', moonIllum: moonPeak, radiantAlt: null, bestStart: null, bestEnd: null, bestMs: null, dark: false };
  const rate = sh.zhr * best.mean;
  return { rate, rating: RATING.find(([m]) => rate >= m)[1], moonIllum: moonPeak, radiantAlt: best.mid.rAlt, moonAlt: best.mid.mAlt,
    bestStart: best.a.t, bestEnd: best.b.t + 30 * 60e3, bestMs: best.mid.t, dark: true };
}

function showerEvents(loc, from, to, O) {
  const out = [];
  const y0 = new Date(from).getUTCFullYear(), y1 = new Date(to).getUTCFullYear();
  for (let y = y0; y <= y1; y++) for (const sh of showersForYear(y)) {
    if (sh.peak < from || sh.peak > to) continue;
    const ev = evaluateShower(sh, loc, O);
    const rate = ev.rate;
    out.push({
      id: `meteor-${sh.id.toLowerCase().replace(/[^a-z]+/g, '')}-${y}`, type: 'meteor', sub: 'shower', t: sh.peak,
      title: `${sh.name} peak`, line: `ZHR ${sh.zhr} · Moon ${Math.round(ev.moonIllum * 100)}%`, badge: ev.rating,
      importance: (ev.rating === 'Excellent' ? 7 : ev.rating === 'Good' ? 6 : ev.rating === 'Fair' ? 4 : 2) + (sh.zhr >= 100 && ev.rating !== 'Poor' ? 1 : 0),
      vis: ev.dark && rate >= 7 ? 'yes' : ev.dark ? 'part' : 'no',
      visNote: ev.dark ? `Radiant ${Math.round(ev.radiantAlt)}° high in the best hours` : 'No dark sky at the peak from here',
      viewMs: ev.bestMs || sh.peak, focus: { kind: 'radiant', id: sh.id }, shower: { ...sh, ...ev, rate }, key: sh.id,
      desc: `${sh.name} meteors are debris from ${sh.parent}. Typical peak rate under a perfect sky is ${sh.zhr} per hour.`,
    });
  }
  return out;
}

// ---------- Moon phases ----------
function moonEvents(loc, from, to) {
  const out = [], quarters = [];
  let mq = A().SearchMoonQuarter(new Date(from));
  while (T(mq.time) <= to) { if (mq.quarter === 0 || mq.quarter === 2) quarters.push({ q: mq.quarter, t: T(mq.time) }); mq = A().NextMoonQuarter(mq); }
  const fullByMonth = new Map();
  for (const m of quarters) if (m.q === 2) { const k = monthKey(m.t); fullByMonth.set(k, (fullByMonth.get(k) || 0) + 1); }
  const seen = new Map();
  for (const m of quarters) {
    const dist = A().GeoVector('Moon', new Date(m.t), true).Length() * AU_KM;
    const loc0 = new Date(m.t + tzOffsetMinutes(m.t, loc) * 60e3);
    const iso = new Date(m.t).toISOString().slice(0, 10);
    if (m.q === 2) {
      const mo = loc0.getUTCMonth(), k = monthKey(m.t);
      const nth = (seen.set(k, (seen.get(k) || 0) + 1), seen.get(k));
      const blue = nth === 2, name = FULL_NAMES[mo];
      const sup = dist <= 361000;
      out.push({
        id: `moon-full-${iso}`, type: 'moon', sub: 'full', t: m.t, title: blue ? 'Blue Moon' : sup ? `${name} Supermoon` : `${name} Moon`,
        line: blue ? `Second full Moon of ${MONTHS[mo]}` : sup ? `Full Moon · ${Math.round(dist / 1000)}k km away` : 'Full Moon',
        badge: sup ? 'Super' : blue ? 'Blue' : 'Full', importance: blue || sup ? 5 : 3, vis: null,
        viewMs: m.t, focus: { kind: 'body', id: 'Moon' }, dist, key: `full-${iso}`,
        desc: `${blue ? 'The second full Moon within one calendar month. ' : ''}${sup ? 'The Moon is full close to its nearest point to Earth, so it looks a little larger and brighter than usual. ' : ''}${name} Moon is the traditional name for the ${MONTHS[mo]} full Moon.`,
        rows: [{ label: 'Moon distance', text: `${Math.round(dist).toLocaleString('en-US')} km` }],
      });
    } else {
      out.push({
        id: `moon-new-${iso}`, type: 'moon', sub: 'new', t: m.t, title: 'New Moon', line: 'Darkest skies of the month', badge: 'New', importance: 1, vis: null,
        viewMs: m.t, focus: { kind: 'body', id: 'Moon' }, dist, key: `new-${iso}`,
        desc: 'The Moon is between Earth and the Sun, so it is lost in the glare. The sky stays moonless all night: the best time of the month for faint galaxies, nebulae and the Milky Way.',
        rows: [{ label: 'Moon distance', text: `${Math.round(dist).toLocaleString('en-US')} km` }],
      });
    }
  }
  return out;
  function monthKey(ms) { const d = new Date(ms + tzOffsetMinutes(ms, loc) * 60e3); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
}

// ---------- eclipses ----------
const upDn = a => a > 0 ? `${Math.round(a)}° up` : 'below horizon';
function lunarEclipses(loc, from, to, O) {
  const out = [];
  let e = A().SearchLunarEclipse(new Date(from));
  while (T(e.peak) <= to) {
    const peak = T(e.peak), pen = (e.sd_penum || 0) * 60e3, par = (e.sd_partial || 0) * 60e3, tot = (e.sd_total || 0) * 60e3;
    const marks = [['Penumbral begins', peak - pen], ['Partial begins', par && peak - par], ['Totality begins', tot && peak - tot], ['Maximum', peak],
      ['Totality ends', tot && peak + tot], ['Partial ends', par && peak + par], ['Penumbral ends', peak + pen]].filter(m => m[1]);
    const rows = marks.map(([label, ms]) => ({ label, ms, alt: O.alt('Moon', ms) }));
    const upAt = rows.filter(r => r.alt > 0).length, peakUp = O.alt('Moon', peak) > 0;
    const vis = upAt === rows.length ? 'yes' : peakUp || upAt > 0 ? 'part' : 'no';
    const kind = e.kind;                                          // penumbral | partial | total
    const kn = kind[0].toUpperCase() + kind.slice(1);
    const spanStart = par ? peak - par : peak - pen, spanEnd = par ? peak + par : peak + pen;
    const iso = new Date(peak).toISOString().slice(0, 10);
    const place = (loc.name || 'your location').split(',')[0];
    out.push({
      id: `ecl-lunar-${iso}`, type: 'eclipse', sub: `lunar-${kind}`, t: peak, title: `${kn} Lunar Eclipse`,
      line: kind === 'total' ? 'Blood Moon' : kind === 'partial' ? `Umbra covers ${Math.round(e.obscuration * 100)}% of the Moon` : 'Subtle shading of the Moon',
      badge: vis === 'no' ? 'Not visible' : vis === 'part' ? 'Partly visible' : 'Visible', vis,
      visNote: vis === 'yes' ? `The whole eclipse is above your horizon from ${place}` : vis === 'part' ? `The Moon is up for only part of it from ${place}` : `The Moon is below the horizon from ${place}`,
      importance: vis === 'no' ? (kind === 'total' ? 4 : kind === 'partial' ? 3 : 1) : kind === 'total' ? 9 : kind === 'partial' ? 6 : 3,
      viewMs: vis === 'no' ? peak : (O.alt('Moon', peak) > 0 ? peak : marks.map(m => m[1]).find(ms => O.alt('Moon', ms) > 0) || peak),
      focus: { kind: 'body', id: 'Moon' }, ics: { start: spanStart, end: spanEnd }, rows,
      desc: kind === 'total' ? `The Moon passes fully into Earth's shadow and turns coppery red for about ${Math.round(2 * tot / 60e3)} minutes. Safe to watch with the naked eye, binoculars or a telescope.`
        : kind === 'partial' ? 'Part of the Moon enters Earth\'s dark umbral shadow and looks "bitten". Safe to watch with the naked eye.'
        : 'The Moon only passes through the faint outer shadow (penumbra), so it dims very slightly. Easy to miss without photos.',
      key: `lunar-${iso}`,
    });
    e = A().NextLunarEclipse(e.peak);
  }
  return out;
}

function solarEclipses(loc, from, to, O) {
  const out = [];
  let g = A().SearchGlobalSolarEclipse(new Date(from));
  while (T(g.peak) <= to) {
    const peak = T(g.peak), kind = g.kind;                         // partial | annular | total
    const kn = kind[0].toUpperCase() + kind.slice(1);
    let local = null;
    try { local = A().SearchLocalSolarEclipse(new Date(peak - 2 * DAY), O.obs); } catch {}
    if (local && Math.abs(T(local.peak.time) - peak) > DAY) local = null;
    const iso = new Date(peak).toISOString().slice(0, 10), place = (loc.name || 'your location').split(',')[0];
    let vis = 'no', rows = [], visNote, ics = { start: peak - H, end: peak + H }, viewMs = peak, line, importance;
    const gPos = g.latitude != null && g.longitude != null ? `${Math.abs(g.latitude).toFixed(0)}°${g.latitude < 0 ? 'S' : 'N'} ${Math.abs(g.longitude).toFixed(0)}°${g.longitude < 0 ? 'W' : 'E'}` : '';
    if (local) {
      const pts = [['Partial begins', local.partial_begin], ['Totality begins', local.total_begin], ['Maximum', local.peak], ['Totality ends', local.total_end], ['Partial ends', local.partial_end]];
      rows = pts.filter(p => p[1]).map(([label, ev]) => ({ label, ms: T(ev.time), alt: ev.altitude }));
      const upCount = rows.filter(r => r.alt > 0).length;
      vis = local.peak.altitude > 0 ? 'yes' : upCount ? 'part' : 'no';
      const pct = Math.round((local.obscuration ?? 0) * 100);
      rows.push({ label: 'Sun covered at maximum', text: `${pct}%` });
      ics = { start: T(local.partial_begin.time), end: T(local.partial_end.time) };
      viewMs = T(local.peak.time);
      visNote = vis === 'yes' ? `${local.kind === 'partial' || kind === 'partial' ? 'Partial' : kn} eclipse from ${place}: ${pct}% of the Sun covered` : vis === 'part' ? `Only visible near sunrise or sunset from ${place}` : `The Sun is below the horizon from ${place}`;
      line = vis === 'no' ? 'Not visible from here' : local.kind === 'partial' && kind !== 'partial' ? `Partial from here (${pct}%)` : `${local.kind[0].toUpperCase()}${local.kind.slice(1)} from here · ${pct}%`;
    } else {
      visNote = `No part of the eclipse is visible from ${place}`;
      line = gPos ? `Greatest near ${gPos}` : 'Not visible from here';
      rows = [{ label: 'Peak (global)', ms: peak }];
    }
    importance = vis === 'no' ? (kind === 'total' ? 5 : kind === 'annular' ? 4 : 2)
      : (local?.kind === 'total' ? 10 : local?.kind === 'annular' ? 8 : 6);
    if (gPos) rows.push({ label: 'Greatest eclipse at', text: gPos });
    out.push({
      id: `ecl-solar-${iso}`, type: 'eclipse', sub: `solar-${kind}`, t: peak, title: `${kn} Solar Eclipse`, line,
      badge: vis === 'no' ? 'Not visible' : vis === 'part' ? 'Partly visible' : 'Visible', vis, visNote, importance, viewMs,
      focus: { kind: 'body', id: 'Sun' }, ics, rows,
      desc: (kind === 'total' ? 'The Moon completely covers the Sun along a narrow path, turning day into twilight; outside the path it is a partial eclipse. '
        : kind === 'annular' ? 'The Moon is too far away to cover the Sun fully, leaving a "ring of fire"; outside the narrow path it is a partial eclipse. '
        : 'The Moon covers only part of the Sun. ') + 'Never look at the Sun without certified solar eclipse glasses or a solar filter.',
      key: `solar-${iso}`,
    });
    g = A().NextGlobalSolarEclipse(g.peak);
  }
  return out;
}

// ---------- seasons ----------
function seasonEvents(loc, from, to) {
  const out = [], north = loc.lat >= 0;
  for (let y = new Date(from).getUTCFullYear(); y <= new Date(to).getUTCFullYear(); y++) {
    const s = A().Seasons(y);
    const list = [['mar', 'March Equinox', north ? 'Spring begins' : 'Autumn begins', s.mar_equinox], ['jun', 'June Solstice', north ? 'Summer begins, longest day' : 'Winter begins, shortest day', s.jun_solstice],
      ['sep', 'September Equinox', north ? 'Autumn begins' : 'Spring begins', s.sep_equinox], ['dec', 'December Solstice', north ? 'Winter begins, shortest day' : 'Summer begins, longest day', s.dec_solstice]];
    for (const [k, title, line, at] of list) {
      const t = T(at); if (t < from || t > to) continue;
      out.push({ id: `season-${k}-${y}`, type: 'planet', sub: 'season', t, title, line, badge: 'Season', importance: 3, vis: null, viewMs: t,
        focus: { kind: 'body', id: 'Sun' }, key: `${k}-${y}`,
        desc: k === 'jun' || k === 'dec' ? 'The Sun reaches its most northern or southern point in the sky: the longest or shortest day of the year for your hemisphere.' : 'The Sun crosses the celestial equator: day and night are nearly equal everywhere on Earth, and the Sun rises due east and sets due west.' });
    }
  }
  return out;
}

// ---------- oppositions & greatest elongations ----------
const iso = ms => new Date(ms).toISOString().slice(0, 10);
function oppositionEvents(loc, from, to, O) {
  const out = [];
  for (const body of ['Mars', 'Jupiter', 'Saturn']) {
    let t = A().SearchRelativeLongitude(body, 180, new Date(from));
    while (t && T(t) <= to) {
      const ms = T(t), ill = A().Illumination(body, t.date), dec = A().Equator(body, t.date, O.obs, true, true).dec;
      const culm = 90 - Math.abs(loc.lat - dec);
      const view = bestView(O, body, ms, 5);
      out.push({
        id: `opp-${body.toLowerCase()}-${iso(ms)}`, type: 'planet', sub: 'opposition', t: ms, title: `${body} at opposition`,
        line: `Brightest of the year · mag ${fmtMag(ill.mag)}`, badge: 'Opposition', importance: body === 'Mars' ? 6 : 6, vis: culm >= 25 ? 'yes' : culm > 5 ? 'part' : 'no',
        visNote: `${body} is up all night and reaches ${Math.round(Math.max(0, culm))}° at its highest from here`,
        viewMs: view ? view.ms : ms, focus: { kind: 'body', id: body }, body,
        rows: [{ label: 'Brightness', text: `mag ${fmtMag(ill.mag)}` }, { label: 'Distance', text: `${ill.geo_dist.toFixed(2)} AU (${Math.round(ill.geo_dist * AU_KM / 1e6)} million km)` }, { label: 'Highest altitude', text: `${Math.round(Math.max(0, culm))}°` }],
        desc: `${body} lies opposite the Sun: it rises at sunset, is up all night and is at its closest and brightest. The best time of the year to observe it with a telescope.`, key: `opp-${body}-${iso(ms)}`,
      });
      t = A().SearchRelativeLongitude(body, 180, new Date(ms + 30 * DAY));
    }
  }
  return out;
}

function elongationEvents(loc, from, to, O) {
  const out = [];
  for (const body of ['Mercury', 'Venus']) {
    let e = A().SearchMaxElongation(body, new Date(from));
    while (e && T(e.time) <= to) {
      const ms = T(e.time), eve = e.visibility === 'evening', ill = A().Illumination(body, e.time.date);
      const view = bestView(O, body, ms, 4);
      const alt = view ? view.alt : null;
      out.push({
        id: `elong-${body.toLowerCase()}-${iso(ms)}`, type: 'planet', sub: 'elongation', t: ms, title: `${body} greatest ${eve ? 'eastern' : 'western'} elongation`,
        line: `${e.elongation.toFixed(0)}° from the Sun · ${eve ? 'evening' : 'morning'} sky`, badge: eve ? 'Evening' : 'Morning', importance: body === 'Venus' ? 5 : 4,
        vis: alt && alt >= 10 ? 'yes' : alt ? 'part' : 'no',
        visNote: alt ? `Look ${eve ? 'west after sunset' : 'east before sunrise'}; about ${Math.round(alt)}° high in twilight from here` : `${body} stays too close to the horizon from here`,
        viewMs: view ? view.ms : ms, focus: { kind: 'body', id: body }, body,
        rows: [{ label: 'Elongation', text: `${e.elongation.toFixed(1)}° ${eve ? 'east' : 'west'} of the Sun` }, { label: 'Brightness', text: `mag ${fmtMag(ill.mag)}` }],
        desc: `${body} is as far from the Sun in the sky as it gets this time round, so it is easiest to spot low in the ${eve ? 'west after sunset' : 'east before sunrise'}.`, key: `elong-${body}-${iso(ms)}`,
      });
      e = A().SearchMaxElongation(body, new Date(ms + 20 * DAY));
    }
  }
  return out;
}
const fmtMag = m => (m < 0 ? '−' : '') + Math.abs(m).toFixed(1);

// ---------- conjunctions (planet-planet and Moon-planet within 2 degrees) ----------
const CONJ_BODIES = ['Moon', ...PLANETS];
const SEP_MAX = 2;
function sepDeg(a, b, ms) {
  const d = new Date(ms), v1 = A().GeoVector(a, d, true), v2 = A().GeoVector(b, d, true);
  const c = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (v1.Length() * v2.Length());
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}
function minSep(a, b, lo, hi) {                                    // ternary search of a smooth, locally unimodal function
  for (let i = 0; i < 28; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (sepDeg(a, b, m1) < sepDeg(a, b, m2)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2; return { t, sep: sepDeg(a, b, t) };
}
const wrap180 = x => ((x + 540) % 360) - 180;

function conjunctionScanTasks(loc, from, to, O, sink) {
  const days = Math.ceil((to - from) / DAY) + 2, elon = {}, tasks = [];
  for (const b of CONJ_BODIES) elon[b] = new Float64Array(days + 1);
  const CH = 30;
  for (let c0 = 0; c0 <= days; c0 += CH) tasks.push(() => {
    for (let i = c0; i < Math.min(days + 1, c0 + CH); i++) {
      const d = new Date(from + i * DAY);
      for (const b of CONJ_BODIES) elon[b][i] = A().Ecliptic(A().GeoVector(b, d, true)).elon;
    }
  });
  const pairs = [];
  for (let i = 0; i < CONJ_BODIES.length; i++) for (let j = i + 1; j < CONJ_BODIES.length; j++) pairs.push([CONJ_BODIES[i], CONJ_BODIES[j]]);
  for (const [a, b] of pairs) tasks.push(() => {
    for (let i = 0; i < days; i++) {
      const d0 = wrap180(elon[a][i] - elon[b][i]), d1 = wrap180(elon[a][i + 1] - elon[b][i + 1]);
      if (!(d0 === 0 || (d0 < 0) !== (d1 < 0)) || Math.abs(d0 - d1) > 60) continue;   // sign change without the 180 deg wrap
      const t0 = from + i * DAY;
      const m = minSep(a, b, t0 - (a === 'Moon' ? 0.4 : 1.5) * DAY, t0 + DAY + (a === 'Moon' ? 0.4 : 1.5) * DAY);
      if (m.sep > SEP_MAX || m.t < from || m.t > to) continue;
      const planet = a === 'Moon' ? b : a;
      const elongSun = A().AngleFromSun(planet, new Date(m.t));
      if (elongSun < 10) continue;                                // lost in the Sun's glare
      sink.push(conjEvent(loc, O, a, b, m.t, m.sep, elongSun));
    }
  });
  return tasks;
}
function conjEvent(loc, O, a, b, t, sep, elongSun) {
  const moon = a === 'Moon', planet = moon ? b : a;
  const view = bestView(O, planet, t, 6);
  const ill = A().Illumination(planet, new Date(t));
  const eveMorn = wrap180(A().Ecliptic(A().GeoVector(planet, new Date(t), true)).elon - A().SunPosition(new Date(t)).elon) > 0 ? 'evening' : 'morning';
  const sepTxt = sep < 0.95 ? `${Math.round(sep * 60)}′` : `${sep.toFixed(1)}°`;
  return {
    id: `conj-${a.toLowerCase()}-${b.toLowerCase()}-${iso(t)}`, type: 'planet', sub: moon ? 'moon-conjunction' : 'conjunction', t,
    title: moon ? `Moon near ${planet}` : `${a} near ${b}`, line: `${sepTxt} apart · ${eveMorn} sky`, badge: sep < 1 ? 'Close' : 'Pair',
    importance: moon ? (planet === 'Venus' || planet === 'Jupiter' ? 4 : 3) : (sep < 1 ? 6 : 5),
    vis: view ? 'yes' : 'no', visNote: view ? `Look ${eveMorn === 'evening' ? 'west after sunset' : 'east before sunrise'} (about ${Math.round(view.alt)}° high at best)` : 'Not well placed in your sky',
    viewMs: view ? view.ms : t, focus: { kind: 'body', id: planet }, bodies: [a, b], key: `conj-${a}-${b}-${iso(t)}`,
    rows: [{ label: 'Closest approach', text: `${sepTxt} (${sep.toFixed(2)}°)` }, { label: 'Elongation from Sun', text: `${Math.round(elongSun)}°` }, ...(moon ? [{ label: `${planet} brightness`, text: `mag ${fmtMag(ill.mag)}` }] : [{ label: `${a} brightness`, text: `mag ${fmtMag(A().Illumination(a, new Date(t)).mag)}` }, { label: `${b} brightness`, text: `mag ${fmtMag(A().Illumination(b, new Date(t)).mag)}` }])],
    desc: moon ? `The Moon passes ${sepTxt} from ${planet}, a pretty pairing to the naked eye or in binoculars. It happens each month, but only some passes are this close.`
      : `${a} and ${b} appear only ${sepTxt} apart: they fit together in a telescope eyepiece, and look like one bright "double star" to the eye. They are really hundreds of millions of kilometres apart.`,
  };
}

// ---------- scheduler ----------
const ric = fn => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 800 }) : setTimeout(fn, 8));
/** Run tasks in idle time, about 10 ms per slice, so the UI never janks. */
export function runTasks(tasks, onProgress, budgetMs = 10) {
  return new Promise(resolve => {
    let i = 0;
    const slice = () => {
      const t0 = performance.now();
      while (i < tasks.length && performance.now() - t0 < budgetMs) {
        try { tasks[i](); } catch (e) { console.warn('[events] task failed', e); }
        i++;
      }
      onProgress?.(i / tasks.length);
      if (i < tasks.length) ric(slice); else resolve();
    };
    ric(slice);
  });
}

/** All events from `from` to `from + days` for an observer, sorted by time. onProgress(0..1) is called as chunks finish. */
export async function computeEvents(loc, from, days, onProgress) {
  const to = from + days * DAY, O = makeObs(loc), out = [];
  const add = fn => () => { const r = fn(); if (r) out.push(...r); };
  const tasks = [
    add(() => moonEvents(loc, from, to)),
    add(() => lunarEclipses(loc, from, to, O)),
    add(() => solarEclipses(loc, from, to, O)),
    add(() => seasonEvents(loc, from, to)),
    add(() => oppositionEvents(loc, from, to, O)),
    add(() => elongationEvents(loc, from, to, O)),
    ...conjunctionScanTasks(loc, from, to, O, out),
  ];
  const y0 = new Date(from).getUTCFullYear(), y1 = new Date(to).getUTCFullYear();
  for (let y = y0; y <= y1; y++) for (const sh of showersForYear(y)) if (sh.peak >= from && sh.peak <= to) {
    tasks.push(() => out.push(...showerEvents(loc, sh.peak, sh.peak, O).filter(e => e.key === sh.id)));
  }
  await runTasks(tasks, onProgress);
  out.sort((a, b) => a.t - b.t);
  return out;
}
