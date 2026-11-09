// Sun / Moon times for the observer using astronomy-engine (window.Astronomy).
const A = () => window.Astronomy;
const T = d => (d ? d.date.getTime() : null);

function mkObs(loc) { return new (A().Observer)(loc.lat, loc.lon, loc.elevM || 0); }

export function bodyAlt(body, ms, loc) {
  const obs = mkObs(loc), d = new Date(ms);
  const eq = A().Equator(body, d, obs, true, true);
  return A().Horizon(d, obs, eq.ra, eq.dec, 'normal').altitude;
}

/**
 * The "night" that matters at time `nowMs`: sunset -> dusk(-18) -> dawn(-18) -> sunrise.
 * Searching starts 12 h back so that at 3 am we still describe the night in progress;
 * once that night's sunrise has passed we describe the coming one.
 */
export function sunSequence(loc, nowMs) {
  const obs = mkObs(loc), Sun = 'Sun';
  const run = t0 => {
    const d0 = new Date(t0);
    const sunset = T(A().SearchRiseSet(Sun, obs, -1, d0, 2));
    const from = sunset ? new Date(sunset) : d0;
    const dusk = T(A().SearchAltitude(Sun, obs, -1, from, 2, -18));
    const dawn = T(A().SearchAltitude(Sun, obs, +1, new Date(dusk || sunset || t0), 2, -18));
    const sunrise = T(A().SearchRiseSet(Sun, obs, +1, new Date(sunset || t0), 2));
    const nDusk = T(A().SearchAltitude(Sun, obs, -1, from, 2, -12));
    const nDawn = T(A().SearchAltitude(Sun, obs, +1, new Date(nDusk || sunset || t0), 2, -12));
    return { sunset, dusk, dawn, sunrise, nDusk, nDawn };
  };
  let s = run(nowMs - 12 * 3600e3);
  if (s.sunrise && s.sunrise < nowMs) s = run(nowMs);
  return s;
}

/** Window used for scoring: astronomical dark if it exists, else nautical, else sunset->sunrise. */
export function darkWindow(seq, nowMs) {
  let a = seq.dusk, b = seq.dawn, kind = 'astronomical';
  if (!a || !b) { a = seq.nDusk; b = seq.nDawn; kind = 'nautical'; }
  if (!a || !b) { a = seq.sunset; b = seq.sunrise; kind = 'sunset'; }
  if (!a || !b) return null;
  return { start: Math.max(a, nowMs), end: b, kind, hours: Math.max(0, (b - Math.max(a, nowMs)) / 3600e3) };
}

export function moonInfo(loc, nowMs) {
  const d = new Date(nowMs), obs = mkObs(loc);
  const phase = A().MoonPhase(d);            // 0 new, 90 first quarter, 180 full, 270 last quarter
  const illum = A().Illumination('Moon', d).phase_fraction; // 0..1
  const rise = T(A().SearchRiseSet('Moon', obs, +1, d, 2));
  const set = T(A().SearchRiseSet('Moon', obs, -1, d, 2));
  const up = bodyAlt('Moon', nowMs, loc) > -0.5;
  return { phase, illum, rise, set, up, name: phaseName(phase) };
}

export function phaseName(p) {
  const n = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  return n[Math.round(p / 45) % 8];
}

/** Fraction of [start,end] (sampled every 20 min) during which the Moon is above the horizon. */
export function moonUpFraction(loc, start, end) {
  if (!(end > start)) return 0;
  let up = 0, n = 0;
  for (let t = start; t <= end; t += 20 * 60e3) { n++; if (bodyAlt('Moon', t, loc) > 0) up++; }
  return n ? up / n : 0;
}

/** Moon icon SVG with the correct illuminated fraction. `phase` in degrees. */
export function moonSvg(phase, lat = 1, size = 56) {
  const r = size / 2 - 3, c = size / 2;
  const rad = phase * Math.PI / 180, k = Math.cos(rad);
  const rx = Math.abs(k) * r;
  const waxing = phase < 180;
  const lit = phase < 1 || phase > 359 ? '' :
    `M0 ${-r} A${r} ${r} 0 0 1 0 ${r} A${rx.toFixed(2)} ${r} 0 0 ${k > 0 ? 0 : 1} 0 ${-r}Z`;
  const flip = (waxing ? 1 : -1) * (lat < 0 ? -1 : 1);
  return `<svg class="tn-moon" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <defs><radialGradient id="mg" cx="40%" cy="38%"><stop offset="0" stop-color="#fffdf2"/><stop offset="1" stop-color="#d6d3c4"/></radialGradient></defs>
    <circle cx="${c}" cy="${c}" r="${r}" fill="#141b2e" stroke="rgba(150,190,255,.25)"/>
    <g transform="translate(${c} ${c}) scale(${flip} 1)"><path d="${lit}" fill="url(#mg)"/></g></svg>`;
}
