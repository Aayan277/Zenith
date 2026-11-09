// Stargazing score (0-100) for the coming / current night.
//
// FORMULA
//   dark window = astronomical night (sun < -18) from max(now, dusk) to dawn
//                 (falls back to nautical, then sunset->sunrise at high latitudes)
//   cloud  = mean over the window of  0.75*cloud_cover + 0.25*cloud_cover_low   (0-100 %)
//   clear  = (1 - cloud/100)^1.25                  -> clouds dominate, mild clouds hurt less than linear
//   moon   = 1 - illumination * fractionOfWindowMoonIsUp   (new moon / set moon = 1)
//   length = clamp(windowHours / 7, 0, 1)          -> long winter nights score higher
//   vis    = clamp(meanVisibility_km / 25, 0, 1)   -> haze / fog
//   score  = 100 * (0.62*clear + 0.20*moon + 0.08*length + 0.10*vis)
//   if cloud > 85 % the score is capped at 20; if cloud > 65 % capped at 45.
// Words: >=80 Excellent, >=60 Good, >=35 Fair, else Poor.
import { clamp, fmtTime } from './util.js';

export function computeScore({ hours, win, moonFrac, moon }) {
  if (!win || win.hours <= 0) return { score: 0, word: 'Poor', parts: {}, cloud: null, reason: 'No real darkness tonight' };
  const sel = (hours || []).filter(h => h.t + 3600e3 > win.start && h.t < win.end);
  const have = sel.length > 0;
  const cloud = have ? sel.reduce((a, h) => a + 0.75 * h.cloud + 0.25 * h.low, 0) / sel.length : null;
  const vis = have ? sel.reduce((a, h) => a + h.vis, 0) / sel.length / 1000 : 20;
  const clear = have ? Math.pow(1 - cloud / 100, 1.25) : 0.5;
  const moonF = 1 - moon.illum * moonFrac;
  const length = clamp(win.hours / 7, 0, 1);
  const visF = clamp(vis / 25, 0, 1);
  let score = 100 * (0.62 * clear + 0.20 * moonF + 0.08 * length + 0.10 * visF);
  if (have && cloud > 85) score = Math.min(score, 20);
  else if (have && cloud > 65) score = Math.min(score, 45);
  score = Math.round(clamp(score, 0, 100));
  const word = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 35 ? 'Fair' : 'Poor';
  return { score, word, cloud, vis, moonF, parts: { clear, moonF, length, visF } };
}

export function reasonText({ cloud, moon, win, tz, moonFrac }) {
  const bits = [];
  if (cloud == null) bits.push('Cloud forecast unavailable');
  else bits.push(cloud < 15 ? 'Clear skies' : cloud < 35 ? 'Mostly clear' : cloud < 60 ? 'Partly cloudy' : cloud < 85 ? 'Mostly cloudy' : 'Overcast');
  if (win) {
    if (moon.illum < 0.08) bits.push('dark Moon');
    else if (moonFrac < 0.05) bits.push('Moon stays down');
    else if (moonFrac > 0.95 && moon.illum > 0.5) bits.push(`bright ${Math.round(moon.illum * 100)}% Moon all night`);
    else if (moon.up && moon.set && moon.set < win.end + 3600e3) bits.push(`Moon sets at ${fmtTime(moon.set, tz)}`);
    else if (!moon.up && moon.rise && moon.rise < win.end) bits.push(`Moon rises at ${fmtTime(moon.rise, tz)}`);
    else bits.push(`${Math.round(moon.illum * 100)}% Moon`);
  }
  return bits.join(', ');
}
