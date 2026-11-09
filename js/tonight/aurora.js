// Aurora chance from NOAA SWPC planetary-K forecast + dipole geomagnetic latitude.
const URL_KP = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';

export function geomagLat(lat, lon) {
  const p = 80.7 * Math.PI / 180, pl = -72.7 * Math.PI / 180, f = lat * Math.PI / 180, l = lon * Math.PI / 180;
  const s = Math.sin(f) * Math.sin(p) + Math.cos(f) * Math.cos(p) * Math.cos(l - pl);
  return Math.asin(Math.max(-1, Math.min(1, s))) * 180 / Math.PI;
}

let cached = null;
export async function fetchKp() {
  if (cached && Date.now() - cached.at < 15 * 60000) return cached.rows;
  const res = await fetch(URL_KP);
  if (!res.ok) throw new Error('swpc ' + res.status);
  const j = await res.json();
  let rows;
  if (Array.isArray(j[0])) rows = j.slice(1).map(r => ({ t: Date.parse(r[0].replace(' ', 'T') + 'Z'), kp: parseFloat(r[1]) }));
  else rows = j.map(r => ({ t: Date.parse(String(r.time_tag).replace(' ', 'T') + (/Z$/.test(r.time_tag) ? '' : 'Z')), kp: parseFloat(r.kp ?? r.Kp) }));
  rows = rows.filter(r => isFinite(r.t) && isFinite(r.kp));
  cached = { at: Date.now(), rows };
  return rows;
}

/** Equatorward edge of the auroral oval ~ 67 deg - 2.1 deg per Kp (rough rule of thumb). */
export function assess(rows, nowMs, lat, lon) {
  const next = rows.filter(r => r.t + 3 * 3600e3 > nowMs && r.t < nowMs + 24 * 3600e3);
  const maxKp = next.length ? Math.max(...next.map(r => r.kp)) : null;
  const mlat = Math.abs(geomagLat(lat, lon));
  if (maxKp == null) return { maxKp, mlat, level: 'unknown', text: 'No forecast available', hot: false };
  const margin = mlat - (67 - 2.1 * maxKp);
  let level, text;
  if (margin >= 0) { level = 'likely'; text = mlat > 62 ? 'Likely overhead tonight' : 'Possible overhead; look north (south in the S. hemisphere)'; }
  else if (margin >= -5) { level = 'possible'; text = 'Possible low on the northern horizon'; }
  else if (margin >= -10) { level = 'unlikely'; text = 'Unlikely from here, only a faint glow at best'; }
  else { level = 'none'; text = 'Not visible from your latitude'; }
  if (level === 'likely' && maxKp < 4 && mlat < 60) { level = 'possible'; text = 'Possible low on the horizon'; }
  return { maxKp, mlat, level, text, hot: level === 'likely', series: next };
}
