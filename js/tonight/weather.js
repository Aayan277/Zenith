// Open-Meteo hourly cloud / visibility (no key). Cached per rounded location for 20 min.
const cache = new Map();

/** @returns {Promise<{tz:string, elevation:number, hours:{t:number, cloud:number, low:number, vis:number}[]}>} */
export function fetchWeather(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit.p;
  const p = (async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&hourly=cloud_cover,cloud_cover_low,visibility&timezone=auto&forecast_days=3&past_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('weather ' + res.status);
    const j = await res.json();
    const off = (j.utc_offset_seconds || 0) * 1000;
    const h = j.hourly;
    const hours = h.time.map((t, i) => ({
      t: Date.parse(t + ':00Z') - off, // local wall-clock string -> true UTC ms
      cloud: h.cloud_cover[i] ?? 0, low: h.cloud_cover_low[i] ?? 0, vis: h.visibility[i] ?? 20000,
    }));
    return { tz: j.timezone || 'UTC', elevation: j.elevation, hours };
  })();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}
