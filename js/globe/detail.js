// Detail-panel provider for selection.kind === 'sat'.
import * as state from '../state.js';
import { CATEGORIES, registerDetailProvider } from '../state.js';
import { getSat, satrec } from '../data/catalog.js';
import { sunSceneVec } from './coords.js';
import { telescopeForNorad } from '../gallery/telescopes.js';   // GALLERY HOOK (js/gallery): registry only, the gallery UI is imported on click

const MU = 398600.4418, RE = 6378.137;

// Rough operator/country guess from the object name (TLE data itself carries no country).
const COUNTRY = [
  [/^(ISS|ZARYA|ZVEZDA|POISK|RASSVET|NAUKA|PRICHAL)/i, 'International'],
  [/^(CSS|TIANHE|WENTIAN|MENGTIAN|SHENZHOU|TIANZHOU|BEIDOU|YAOGAN|FENGYUN|FY-|GAOFEN|TIANTONG|CZ-|CHINASAT|SHIJIAN|ZHONGXING|JILIN)/i, 'China'],
  [/^(COSMOS|KOSMOS|GLONASS|SOYUZ|PROGRESS|METEOR|ELEKTRO|RESURS|LUCH|EXPRESS|MOLNIYA|BLITS)/i, 'Russia'],
  [/^(STARLINK|NAVSTAR|GPS |USA |NOAA|GOES|IRIDIUM|GLOBALSTAR|ORBCOMM|LANDSAT|TERRA|AQUA|AURA|HST|TDRS|SKYSAT|PLANET|FLOCK|DOVE|LEMUR|WORLDVIEW|SES-|O3B|IRIDIUM|DRAGON|CYGNUS|SWFO|JPSS|SUOMI|SENTINEL-6|FENGYUN)/i, 'USA'],
  [/^(SENTINEL|GALILEO|METEOSAT|METOP|ENVISAT|ERS-|CRYOSAT|SWARM|GAIA)/i, 'Europe'],
  [/^(ONEWEB)/i, 'UK'],
  [/^(QZS|MICHIBIKI|HIMAWARI|HAYABUSA|ALOS|GOSAT|IGS)/i, 'Japan'],
  [/^(IRNSS|NAVIC|INSAT|GSAT|CARTOSAT|RISAT|RESOURCESAT|ASTROSAT)/i, 'India'],
];
function guessCountry(name) { for (const [re, c] of COUNTRY) if (re.test(name)) return c; return null; }

function intlDes(l1) {
  const yy = l1.substring(9, 11).trim(), num = l1.substring(11, 14).trim(), piece = l1.substring(14, 17).trim();
  if (!yy || !num) return null;
  const y = +yy; const year = y < 57 ? 2000 + y : 1900 + y;
  return `${year}-${num}${piece}`;
}
function epochMsOf(l1) {
  const yr = +l1.substring(18, 20), day = +l1.substring(20, 32);
  const y = yr < 57 ? 2000 + yr : 1900 + yr;
  return Date.UTC(y, 0, 1) + (day - 1) * 86400000;
}
function fmtAge(ms) {
  const sign = ms < 0 ? -1 : 1, a = Math.abs(ms), h = a / 3600000;
  const s = h < 1 ? `${Math.round(a / 60000)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  return sign > 0 ? `data ${s} old` : `epoch ${s} ahead`;
}
const f1 = (v, d = 1) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function registerSatDetail(api) {
  registerDetailProvider('sat', (sel, nowMs) => {
    const sat = getSat(sel.id); if (!sat) return null;
    const rec = satrec(sel.id); const S = window.satellite;
    const cat = CATEGORIES[sat.cat] || CATEGORIES.other;
    const country = guessCountry(sat.name), des = intlDes(sat.l1);
    const subtitle = [cat.label, country, des].filter(Boolean).join(' · ');

    const date = new Date(nowMs);
    let alt = null, speed = null, lat = null, lon = null, lit = null, decayed = false;
    try {
      const pv = S.propagate(rec, date);
      if (pv && pv.position && isFinite(pv.position.x)) {
        const gst = S.gstime(date);
        const geo = S.eciToGeodetic(pv.position, gst);
        alt = geo.height; lat = S.degreesLat(geo.latitude); lon = S.degreesLong(geo.longitude);
        speed = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
        // cylindrical shadow, using the same Sun as the globe (scene axes: x,z,-y -> ECI approx via ECEF)
        const sv = sunSceneVec(nowMs);
        const c = Math.cos(gst), s = Math.sin(gst);
        const ex = c * pv.position.x + s * pv.position.y, ey = -s * pv.position.x + c * pv.position.y, ez = pv.position.z;
        const sx = sv.x, sy = -sv.z, sz = sv.y;
        const proj = ex * sx + ey * sy + ez * sz, rr = ex * ex + ey * ey + ez * ez;
        lit = !(proj < 0 && rr - proj * proj < RE * RE);
      } else decayed = true;
    } catch { decayed = true; }

    const n = rec.no / 60;                                 // rad/s
    const a = Math.cbrt(MU / (n * n));
    const periodMin = 2 * Math.PI / rec.no;
    const apo = a * (1 + rec.ecco) - RE, peri = a * (1 - rec.ecco) - RE;
    const incl = rec.inclo * 180 / Math.PI;
    const following = api.isFollowing(sel.id);

    return {
      title: sat.notable || sat.name,
      subtitle,
      color: cat.color,
      icon: 'sat',
      stats: decayed ? [] : [
        { label: 'Altitude', value: f1(alt, 0), unit: 'km' },
        { label: 'Speed', value: f1(speed, 2), unit: 'km/s' },
        { label: 'Latitude', value: f1(lat, 2), unit: '°' },
        { label: 'Longitude', value: f1(lon, 2), unit: '°' },
      ],
      rows: [
        { label: 'Orbital period', value: `${f1(periodMin, 1)} min` },
        { label: 'Inclination', value: `${f1(incl, 2)}°` },
        { label: 'Apogee / perigee', value: `${f1(apo, 0)} / ${f1(peri, 0)} km` },
        { label: 'NORAD ID', value: String(sat.id) },
        { label: 'TLE epoch', value: fmtAge(nowMs - epochMsOf(sat.l1)) },
        { label: 'Illumination', value: decayed ? 'No valid orbit' : lit ? 'Sunlit' : 'In Earth’s shadow' },
      ],
      note: decayed ? 'This orbit can no longer be propagated (likely decayed or stale elements).' : undefined,
      actions: [
        // GALLERY HOOK: telescopes get a "View its photos" action first (js/gallery/telescopes.js is the registry, keyed by NORAD id)
        ...(telescopeForNorad(sel.id) ? [{ label: '📷 View its photos', onClick: () => import('../gallery/index.js').then(m => m.openGallery(telescopeForNorad(sel.id).key)).catch(e => { console.warn('[gallery]', e); state.emit('toast', 'Couldn’t open the photo gallery'); }) }] : []),
        { label: following ? 'Stop following' : 'Follow', onClick: () => api.toggleFollow(sel.id) },
        { label: 'Show in sky', onClick: () => { state.set('view', 'sky'); state.emit('focus', sel); } },
      ],
    };
  });
}
