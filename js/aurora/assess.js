// Combines the observer's sky (sun altitude, dark window) with the aurora data into one verdict.
import { bodyAlt, sunSequence, darkWindow } from '../tonight/astro.js';
import { chanceAt, makeVerdict, kpAt, parseAlerts, topAlerts } from './model.js';

let memo = { key: '', win: null };
/** Memoised dark window for the observer (sunSequence is a handful of astronomy-engine searches). */
function windowFor(loc, t) {
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${Math.floor(t / 600e3)}`;
  if (memo.key === key) return memo.win;
  let win = null; try { win = darkWindow(sunSequence(loc, t), t); } catch (e) { console.warn('[aurora] dark window', e.message); }
  memo = { key, win }; return win;
}

export function assessNow(aur, loc, simNow) {
  const live = Math.abs(simNow - Date.now()) < 45 * 60e3;
  let sunAlt = -90; try { sunAlt = bodyAlt('Sun', simNow, loc); } catch {}
  const chance = aur.ovation ? chanceAt(aur.ovation.grid, loc.lat, loc.lon) : null;
  const win = windowFor(loc, simNow);
  const verdict = makeVerdict({ chance, sunAlt, kpRows: aur.kp, now: simNow, live, loc, win });
  const kpNow = aur.kp ? kpAt(aur.kp, simNow) : null;
  return { verdict, chance, sunAlt, win, live, dark: sunAlt < -9, kpNow };
}

export function alertList(aur, now = Date.now()) { return topAlerts(parseAlerts(aur.alerts, now), 3); }

/** Alert-condition check for a threshold preset, against REAL time (alerts are about now, not the scrubbed clock). */
export function conditionFor(preset, aur, loc, now = Date.now()) {
  if (preset === 'kp5') {
    const cur = aur.kp ? kpAt(aur.kp, now) : null, nxt = aur.kp ? kpAt(aur.kp, now + 3 * 3600e3) : null;
    const hit = [cur, nxt].filter(r => r && r.kp >= 5).sort((a, b) => b.kp - a.kp)[0];
    return hit ? { on: true, key: `kp5:${hit.t}`, title: `Geomagnetic storm: Kp ${Math.round(hit.kp * 10) / 10}`, body: 'Aurora may be visible much farther from the poles than usual. Open Zenith for the details.' } : { on: false };
  }
  if (preset === 'watch') {
    const w = parseAlerts(aur.alerts, now).find(a => a.kind === 'watch' && a.active);
    return w ? { on: true, key: `watch:${w.issued}`, title: `${w.title} issued`, body: w.text } : { on: false };
  }
  // 'local': likely at my location, right now
  const a = assessNow(aur, loc, now);
  if (!a.verdict || a.verdict.level !== 'good') return { on: false };
  const nightKey = new Date(now - 12 * 3600e3).toISOString().slice(0, 10) + `@${Math.round(loc.lat)},${Math.round(loc.lon)}`;
  const body = a.chance ? `${Math.round(a.chance.here)}% chance overhead, ${Math.round(a.chance.horizon)}% on the horizon near ${(loc.name || 'you').split(',')[0]}.` : a.verdict.detail;
  return { on: true, key: `local:${nightKey}`, title: a.verdict.title, body };
}
