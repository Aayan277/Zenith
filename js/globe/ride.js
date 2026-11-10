// "Ride along": the view from a satellite (ISS first, any satellite works).
//
// The camera sits on the satellite (interpolated by SatLayer, so it is smooth at any sim rate), looks along the
// velocity vector tilted down towards the Earth, and the low-orbit rendering in earth.js (earth.rideFx) fades in.
// This module owns: the flight in/out, the look-around controls (drag = yaw/pitch with a gentle spring back, wheel = FOV),
// the Esc / R keys, and the DOM HUD (name, altitude, speed, position, daylight/sunrise countdown, local solar time,
// orbit ring, LIVE badge, Exit / Look down / Look forward / 1x / 60x).
//
//   const ride = createRide({ camera, controls, renderer, host, canvas, sats, earth, softwareGL, cancelFly, onChange })
//   ride.enter(id) / ride.exit(immediate) / ride.toggle(id)
//   ride.step(nowT, simMs, dt)    every frame while ride.active: takes over the camera
//   ride.k (0..1)                 how far into the ride look we are (0 = orbit view)
import * as THREE from 'three';
import * as state from '../state.js';
import { getSat, satrec } from '../data/catalog.js';
import { now as simNow, getRate, setRate, isLive } from '../clock.js';
import { sunSceneVec, vecToLatLon, R_KM } from './coords.js';

const D2R = Math.PI / 180, RE = 6378.137, W_EARTH = 7.2921159e-5;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeIO = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

const DOWN_PITCH = -86 * D2R;
// Camera pitch presets depend on how far below the horizon the Earth is: dip = angle from horizontal down to the limb
// (20 deg from the ISS, ~81 deg from GEO). Default looks 10 deg past the limb: horizon and limb arc stay in frame.
const dipOf = (r) => Math.acos(clamp(1 / r, 0, 1));
const homePitch = (mode, r) => mode === 'down' ? DOWN_PITCH : clamp(-(dipOf(r) + (mode === 'fwd' ? -7 : 10) * D2R), DOWN_PITCH, -4 * D2R);
const FOV_DEFAULT = 62, FOV_MIN = 28, FOV_MAX = 100;
const NEAR = 0.0004;

// ---- a small place list for the "nearest place" hint (cheap: no network, ~4 KB) ----
const CITIES = [
  ['London', 51.5, -0.13], ['Paris', 48.86, 2.35], ['Madrid', 40.42, -3.7], ['Lisbon', 38.72, -9.14], ['Rome', 41.9, 12.5], ['Berlin', 52.52, 13.4],
  ['Warsaw', 52.23, 21], ['Kyiv', 50.45, 30.52], ['Istanbul', 41, 28.98], ['Moscow', 55.75, 37.62], ['Saint Petersburg', 59.93, 30.3], ['Stockholm', 59.33, 18.07],
  ['Reykjavik', 64.15, -21.94], ['Athens', 37.98, 23.73], ['Cairo', 30.04, 31.24], ['Lagos', 6.52, 3.38], ['Nairobi', -1.29, 36.82], ['Johannesburg', -26.2, 28.05],
  ['Cape Town', -33.92, 18.42], ['Kinshasa', -4.44, 15.27], ['Addis Ababa', 9.03, 38.74], ['Casablanca', 33.57, -7.59], ['Algiers', 36.75, 3.06], ['Khartoum', 15.5, 32.56],
  ['Dakar', 14.72, -17.47], ['Luanda', -8.84, 13.23], ['Dar es Salaam', -6.79, 39.21], ['Tehran', 35.69, 51.39], ['Baghdad', 33.31, 44.36], ['Riyadh', 24.71, 46.68],
  ['Dubai', 25.2, 55.27], ['Karachi', 24.86, 67], ['Delhi', 28.61, 77.21], ['Mumbai', 19.08, 72.88], ['Kolkata', 22.57, 88.36], ['Chennai', 13.08, 80.27],
  ['Dhaka', 23.81, 90.41], ['Colombo', 6.93, 79.86], ['Bangkok', 13.75, 100.5], ['Singapore', 1.35, 103.82], ['Jakarta', -6.2, 106.85], ['Manila', 14.6, 120.98],
  ['Hanoi', 21.03, 105.85], ['Ho Chi Minh City', 10.82, 106.63], ['Kuala Lumpur', 3.14, 101.69], ['Hong Kong', 22.32, 114.17], ['Shanghai', 31.23, 121.47], ['Beijing', 39.9, 116.4],
  ['Guangzhou', 23.13, 113.26], ['Chengdu', 30.57, 104.07], ['Urumqi', 43.83, 87.62], ['Seoul', 37.57, 126.98], ['Tokyo', 35.68, 139.69], ['Osaka', 34.69, 135.5],
  ['Sapporo', 43.06, 141.35], ['Vladivostok', 43.12, 131.89], ['Novosibirsk', 55.03, 82.92], ['Yakutsk', 62.03, 129.73], ['Almaty', 43.24, 76.89], ['Tashkent', 41.3, 69.24],
  ['Kabul', 34.53, 69.17], ['Sydney', -33.87, 151.21], ['Melbourne', -37.81, 144.96], ['Perth', -31.95, 115.86], ['Brisbane', -27.47, 153.03], ['Darwin', -12.46, 130.84],
  ['Adelaide', -34.93, 138.6], ['Auckland', -36.85, 174.76], ['Wellington', -41.29, 174.78], ['Port Moresby', -9.44, 147.18], ['Honolulu', 21.31, -157.86], ['Anchorage', 61.22, -149.9],
  ['Vancouver', 49.28, -123.12], ['Seattle', 47.61, -122.33], ['San Francisco', 37.77, -122.42], ['Los Angeles', 34.05, -118.24], ['Phoenix', 33.45, -112.07], ['Denver', 39.74, -104.99],
  ['Dallas', 32.78, -96.8], ['Houston', 29.76, -95.37], ['Chicago', 41.88, -87.63], ['Minneapolis', 44.98, -93.27], ['Atlanta', 33.75, -84.39], ['Miami', 25.76, -80.19],
  ['Washington', 38.9, -77.04], ['New York', 40.71, -74], ['Boston', 42.36, -71.06], ['Toronto', 43.65, -79.38], ['Montreal', 45.5, -73.57], ['Winnipeg', 49.9, -97.14],
  ['Mexico City', 19.43, -99.13], ['Guatemala City', 14.63, -90.51], ['Havana', 23.11, -82.37], ['Bogota', 4.71, -74.07], ['Caracas', 10.48, -66.9], ['Lima', -12.05, -77.04],
  ['Quito', -0.18, -78.47], ['La Paz', -16.5, -68.15], ['Santiago', -33.45, -70.67], ['Buenos Aires', -34.6, -58.38], ['Sao Paulo', -23.55, -46.63], ['Rio de Janeiro', -22.91, -43.17],
  ['Brasilia', -15.79, -47.88], ['Manaus', -3.12, -60.02], ['Recife', -8.05, -34.88], ['Montevideo', -34.9, -56.16], ['Nuuk', 64.18, -51.72], ['Murmansk', 68.97, 33.08],
  ['Tromso', 69.65, 18.96], ['Helsinki', 60.17, 24.94], ['Oslo', 59.91, 10.75], ['Vienna', 48.21, 16.37], ['Bucharest', 44.43, 26.1], ['Tunis', 36.8, 10.18],
  ['Tripoli', 32.89, 13.19], ['Tel Aviv', 32.09, 34.78], ['Antananarivo', -18.88, 47.51], ['Maputo', -25.97, 32.57], ['Accra', 5.6, -0.19], ['Abidjan', 5.36, -4],
  ['Kampala', 0.35, 32.58], ['Lusaka', -15.39, 28.32], ['Windhoek', -22.56, 17.08], ['Ulaanbaatar', 47.89, 106.91], ['Yangon', 16.84, 96.17], ['Kathmandu', 27.7, 85.32],
  ['Muscat', 23.59, 58.41], ['Baku', 40.41, 49.87], ['Tbilisi', 41.72, 44.79],
].map(([n, la, lo]) => ({ n, la: la * D2R, lo: lo * D2R, c: Math.cos(la * D2R) }));

function nearestCity(latDeg, lonDeg) {
  const la = latDeg * D2R, lo = lonDeg * D2R, cl = Math.cos(la);
  let best = null, bd = 1e9;
  for (const c of CITIES) {
    const dlo = lo - c.lo, dla = la - c.la;
    const h = Math.sin(dla / 2) ** 2 + cl * c.c * Math.sin(dlo / 2) ** 2;
    const d = 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    if (d < bd) { bd = d; best = c; }
  }
  return { name: best.n, km: bd };
}
function oceanName(lat, lon) {
  if (lat < -60) return 'Southern Ocean';
  if (lat > 68) return 'Arctic Ocean';
  if (lat > 43 && lat < 49 && lon > -10 && lon < -1.5) return 'Bay of Biscay';
  if (lat > 30 && lat < 46 && lon > -6 && lon < 36 && !(lat > 40 && lon < 0)) return 'Mediterranean Sea';
  if (lat > 12 && lat < 30 && lon > 32 && lon < 44) return 'Red Sea';
  if (lat > 17 && lat < 31 && lon > -98 && lon < -80) return 'Gulf of Mexico';
  if (lat > 8 && lat < 22 && lon > -88 && lon < -60) return 'Caribbean Sea';
  if (lon > -68 && lon < 20) return 'Atlantic Ocean';
  if (lon >= 20 && lon < 120 && lat < 30) return 'Indian Ocean';
  return 'Pacific Ocean';
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;
function fmtCountdown(sec) {
  sec = Math.max(0, sec);
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  if (m < 120) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
}

export function createRide(env) {
  const { camera, controls, renderer, host, canvas, sats, earth, softwareGL } = env;
  const fx = earth.rideFx;

  const R = {
    phase: null,            // null | 'in' | 'on' | 'out'
    id: null, k: 0,
    get active() { return this.phase !== null; },
  };

  // ---------- pose state ----------
  const P = new THREE.Vector3(), U = new THREE.Vector3(), F = new THREE.Vector3(), Fs = new THREE.Vector3(), Rt = new THREE.Vector3();
  const V = new THREE.Vector3(), tmp = new THREE.Vector3(), dirV = new THREE.Vector3(), upV = new THREE.Vector3(), hV = new THREE.Vector3();
  const mBasis = new THREE.Matrix4(), qRide = new THREE.Quaternion(), qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
  const sunV = new THREE.Vector3(), nDir = new THREE.Vector3();
  let hasHeading = false;
  const look = { yaw: 0, pitch: -30 * D2R, home: -30 * D2R, mode: 'auto' };
  let lastDrag = 0, dragging = false, fov = FOV_DEFAULT;
  let saved = null;          // orbit camera to return to
  let flight = null;         // { t0, dur, pos0, q0, fov0, near0, kStart }
  let target = null;         // 'out' target pose { pos, quat, fov, near, far }
  let sunVis = 1, starVis = 0, lit = true;
  let rateBefore = null, rateByHud = null;

  // ---------- keyboard ----------
  const typing = (e) => { const t = e.target; return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); };
  const modalOpen = () => {
    if (document.body.classList.contains('modal-open')) return true;
    for (const m of document.querySelectorAll('[aria-modal="true"]')) if (m.getClientRects().length) return true;
    return false;
  };
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || modalOpen()) return;
    if (e.key === 'Escape' && R.phase && R.phase !== 'out') {
      e.preventDefault(); e.stopImmediatePropagation(); R.exit(); return;
    }
    if ((e.key === 'r' || e.key === 'R') && !e.shiftKey && state.get('view') === 'globe') {
      if (R.phase && R.phase !== 'out') { e.preventDefault(); R.exit(); return; }
      const sel = state.get('selection');
      if (!R.phase && sel && sel.kind === 'sat') { e.preventDefault(); R.enter(sel.id); }
    }
  }, true);

  // ---------- look-around (drag) and FOV (wheel) ----------
  let dragLast = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (R.phase !== 'on' && R.phase !== 'in') return;
    dragging = true; dragLast = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !dragLast) return;
    const dx = e.clientX - dragLast.x, dy = e.clientY - dragLast.y;
    dragLast.x = e.clientX; dragLast.y = e.clientY;
    const s = 0.0022 * (fov / FOV_DEFAULT);
    look.yaw = clamp(look.yaw - dx * s, -120 * D2R, 120 * D2R);
    look.pitch = clamp(look.pitch + dy * s, -89 * D2R, 62 * D2R);
    lastDrag = performance.now();
  });
  const endDrag = (e) => { dragging = false; dragLast = null; lastDrag = performance.now(); try { canvas.releasePointerCapture(e.pointerId); } catch {} };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    if (!R.phase || R.phase === 'out') return;
    e.preventDefault();
    fov = clamp(fov * Math.exp(e.deltaY * 0.0012), FOV_MIN, FOV_MAX);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { if (R.phase === 'on') { look.yaw = 0; look.pitch = look.home; fov = FOV_DEFAULT; } });

  // ---------- orbit scan (sunlit ring, next sunrise/sunset) ----------
  const litAt = (rec, ms) => {
    const S = window.satellite, d = new Date(ms);
    const pv = S.propagate(rec, d);
    if (!pv || !pv.position || !isFinite(pv.position.x)) return null;
    const gst = S.gstime(d), c = Math.cos(gst), s = Math.sin(gst);
    const ex = c * pv.position.x + s * pv.position.y, ey = -s * pv.position.x + c * pv.position.y, ez = pv.position.z;
    const sv = sunSceneVec(ms, sunV);
    const proj = ex * sv.x + ey * -sv.z + ez * sv.y, rr = ex * ex + ey * ey + ez * ez;
    return !(proj < 0 && rr - proj * proj < RE * RE);
  };
  function scanOrbit(rec, ms) {
    const S = window.satellite;
    const periodS = 2 * Math.PI / rec.no * 60;
    const bins = new Uint8Array(72);
    // argument of latitude now -> where the dot sits on the ring
    let frac = 0;
    const pv = S.propagate(rec, new Date(ms));
    if (pv && pv.position) {
      const r = pv.position, v = pv.velocity;
      const hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z;
      const nx = -hy, ny = hx, nn = Math.hypot(nx, ny) || 1, rn = Math.hypot(r.x, r.y, r.z) || 1;
      let u = Math.acos(clamp((nx * r.x + ny * r.y) / (nn * rn), -1, 1));
      if (r.z < 0) u = 2 * Math.PI - u;
      frac = u / (2 * Math.PI);
    }
    for (let k = 0; k < 72; k++) bins[k] = litAt(rec, ms + ((k + 0.5) / 72 - frac) * periodS * 1000) ? 1 : 0;
    // next terminator crossing of the satellite's own sunlight
    const now0 = litAt(rec, ms);
    let ev = null;
    if (now0 !== null) {
      let a = ms, step = 45000, n = Math.ceil(periodS * 1.1 / 45);
      for (let i = 1; i <= n; i++) {
        const b = ms + i * step;
        if (litAt(rec, b) !== now0) {
          let lo = a, hi = b;
          for (let j = 0; j < 8; j++) { const m = (lo + hi) / 2; if (litAt(rec, m) === now0) lo = m; else hi = m; }
          ev = { ms: (lo + hi) / 2, toLit: !now0 };
          break;
        }
        a = b;
      }
    }
    const recent = now0 !== null && litAt(rec, ms - 70000) !== now0;
    return { bins, frac, ev, at: ms, recent: recent ? now0 : null };
  }
  function ringGradient(bins) {
    const stops = []; const n = bins.length;
    const col = (b) => b ? 'rgba(255,196,110,0.95)' : 'rgba(70,110,190,0.55)';
    let s = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || bins[i] !== bins[s]) { stops.push(`${col(bins[s])} ${(s / n * 360).toFixed(1)}deg ${(i / n * 360).toFixed(1)}deg`); s = i; }
    }
    return `conic-gradient(from 0deg, ${stops.join(',')})`;
  }

  // ---------- land/ocean from the water map ----------
  let waterPx = null;
  function waterAt(lat, lon) {
    if (!waterPx) {
      try {
        const img = earth.earth.material.uniforms.uWater.value.image;
        const c = document.createElement('canvas'); c.width = 512; c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 512, 256);
        waterPx = g.getImageData(0, 0, 512, 256).data;
      } catch { waterPx = false; }
    }
    if (!waterPx) return null;
    const x = clamp(Math.floor((lon / 360 + 0.5) * 512), 0, 511), y = clamp(Math.floor((0.5 - lat / 180) * 256), 0, 255);
    return waterPx[(y * 512 + x) * 4] > 128;
  }

  // ---------- HUD ----------
  const hud = document.createElement('div');
  hud.className = 'ride-hud'; hud.hidden = true;
  hud.innerHTML = `
    <div class="rh-vig"></div>
    <div class="rh-id">
      <div class="rh-eyebrow">Riding along</div>
      <h2 class="rh-name"></h2>
      <dl class="rh-stats">
        <div><dt>Altitude</dt><dd data-f="alt">–</dd></div>
        <div><dt>Speed</dt><dd data-f="spd">–</dd></div>
        <div><dt>Position</dt><dd data-f="pos">–</dd></div>
      </dl>
      <div class="rh-place" data-f="place"></div>
    </div>
    <div class="rh-side">
      <div class="rh-ring" aria-hidden="true"><i class="rh-arc"></i><i class="rh-dot"></i></div>
      <div class="rh-live" data-f="live"><span></span>LIVE</div>
    </div>
    <div class="rh-light">
      <div class="rh-phase" data-f="phase">Daylight</div>
      <div class="rh-sub" data-f="next"></div>
      <div class="rh-solar"><span>Local solar time</span> <b data-f="solar">--:--</b></div>
    </div>
    <div class="rh-bar glass" role="toolbar" aria-label="Ride along controls">
      <button class="globe-btn rh-exit" data-a="exit" title="Back to orbit view (Esc)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg><span>Exit</span><kbd>Esc</kbd></button>
      <i class="rh-sep"></i>
      <button class="globe-btn" data-a="down" title="Look straight down"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4v14M6 12l6 6 6-6"/></svg><span>Look down</span></button>
      <button class="globe-btn" data-a="fwd" title="Look towards the horizon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 15h18M12 4v8M8 8l4-4 4 4"/></svg><span>Look forward</span></button>
      <i class="rh-sep"></i>
      <button class="globe-btn rh-rate" data-a="r1" title="Real time">1×</button>
      <button class="globe-btn rh-rate" data-a="r60" title="60× speed">60×</button>
    </div>`;
  host.append(hud);
  const q = (f) => hud.querySelector(`[data-f="${f}"]`);
  const fEls = { alt: q('alt'), spd: q('spd'), pos: q('pos'), place: q('place'), live: q('live'), phase: q('phase'), next: q('next'), solar: q('solar') };
  const nameEl = hud.querySelector('.rh-name'), ringEl = hud.querySelector('.rh-arc'), dotEl = hud.querySelector('.rh-dot');
  const btn = (a) => hud.querySelector(`[data-a="${a}"]`);
  btn('exit').addEventListener('click', () => R.exit());
  btn('down').addEventListener('click', () => { look.mode = look.mode === 'down' ? 'auto' : 'down'; look.yaw = 0; lastDrag = 0; syncButtons(); });
  btn('fwd').addEventListener('click', () => { look.mode = look.mode === 'fwd' ? 'auto' : 'fwd'; look.yaw = 0; lastDrag = 0; syncButtons(); });
  const setHudRate = (r) => { if (rateBefore === null) rateBefore = getRate(); rateByHud = r; setRate(r); syncButtons(); };
  btn('r1').addEventListener('click', () => setHudRate(1));
  btn('r60').addEventListener('click', () => setHudRate(60));
  function syncButtons() {
    const r = getRate();
    btn('r1').classList.toggle('on', r === 1); btn('r60').classList.toggle('on', r === 60);
    btn('down').classList.toggle('on', look.mode === 'down'); btn('fwd').classList.toggle('on', look.mode === 'fwd');
  }
  state.on('clock', () => { if (R.phase) syncButtons(); });

  let scan = null, scanWall = 0, ringSig = '', lastHud = 0;
  const geo = { lat: 0, lon: 0, alt: 0, spd: 0 };
  function hudTick(simMs, force) {
    const t = performance.now();
    if (!force && t - lastHud < 240) return;
    lastHud = t;
    let rec; try { rec = satrec(R.id); } catch { return; }
    const S = window.satellite, date = new Date(simMs);
    let pv = null; try { pv = S.propagate(rec, date); } catch {}
    if (pv && pv.position && isFinite(pv.position.x)) {
      const g = S.eciToGeodetic(pv.position, S.gstime(date));
      geo.alt = g.height; geo.lat = S.degreesLat(g.latitude); geo.lon = S.degreesLong(g.longitude);
      geo.spd = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    }
    fEls.alt.textContent = `${geo.alt.toFixed(0)} km`;
    fEls.spd.textContent = `${geo.spd.toFixed(2)} km/s`;
    fEls.pos.textContent = `${fmtLat(geo.lat)}  ${fmtLon(geo.lon)}`;
    const water = waterAt(geo.lat, geo.lon);
    let place = '';
    if (water === true) place = `Over the ${oceanName(geo.lat, geo.lon)}`;
    else if (water === false) { const c = nearestCity(geo.lat, geo.lon); place = c.km < 1300 ? `Near ${c.name} · ${Math.round(c.km / 10) * 10} km` : 'Over land'; }
    if (fEls.place.textContent !== place) fEls.place.textContent = place;

    // daylight / orbit scan (a few propagations, throttled)
    if (!scan || t - scanWall > 2000 && (Math.abs(simMs - scan.at) > 25000 || (scan.ev && simMs > scan.ev.ms))) {
      try { scan = scanOrbit(rec, simMs); } catch (e) { scan = null; }
      scanWall = t;
      if (scan) {
        const sig = Array.from(scan.bins).join('');
        if (sig !== ringSig) { ringSig = sig; ringEl.style.background = ringGradient(scan.bins); }
      }
    }
    if (scan) dotEl.style.transform = `rotate(${(scan.frac + (simMs - scan.at) / 1000 / (2 * Math.PI / rec.no * 60)) * 360}deg)`;
    // phase label from the live (per-frame) lit state
    const recentNow = scan && scan.recent !== null && Math.abs(simMs - scan.at) < 70000;
    const toEv = scan && scan.ev ? (scan.ev.ms - simMs) / 1000 : null;
    let phase = lit ? 'Daylight' : 'Night', next = '';
    if (toEv !== null && toEv >= 0) {
      const what = scan.ev.toLit ? 'Sunrise' : 'Sunset';
      next = `${what} in ${fmtCountdown(toEv)}`;
      if (toEv < 75) phase = scan.ev.toLit ? 'Orbital sunrise' : 'Orbital sunset';
    }
    if (recentNow) phase = lit ? 'Orbital sunrise' : 'Orbital sunset';
    fEls.phase.textContent = phase;
    fEls.phase.dataset.state = /sunrise/i.test(phase) ? 'rise' : /sunset/i.test(phase) ? 'set' : lit ? 'day' : 'night';
    fEls.next.textContent = next;
    // true local solar time at the sub-satellite point
    const sv = sunSceneVec(simMs, sunV), lonS = Math.atan2(-sv.z, sv.x) / D2R;
    let h = 12 + (geo.lon - lonS) / 15; h = ((h % 24) + 24) % 24;
    fEls.solar.textContent = `${pad2(Math.floor(h))}:${pad2(Math.floor((h % 1) * 60))}`;
    const live = isLive();
    fEls.live.style.display = live ? '' : 'none';
  }

  // ---------- flight helpers ----------
  const lerpLog = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
  const dA = new THREE.Vector3(), dB = new THREE.Vector3(), qS = new THREE.Quaternion(), qId = new THREE.Quaternion();
  function placeBetween(pos0, q0, posT, qT, e, eq, out) {
    // direction: rotate pos0's direction towards posT's; radius: log-interpolated
    dA.copy(pos0).normalize(); dB.copy(posT).normalize();
    qS.setFromUnitVectors(dA, dB); qB.copy(qId).slerp(qS, e);
    dA.applyQuaternion(qB);
    const r = lerpLog(pos0.length(), posT.length(), e);
    camera.position.copy(dA).multiplyScalar(r);
    camera.quaternion.copy(q0).slerp(qT, eq);
  }
  function lookQuat(eye, out) {
    mBasis.lookAt(eye, tmp.set(0, 0, 0), upV.set(0, 1, 0));
    return out.setFromRotationMatrix(mBasis);
  }

  function heading(idx, dt) {
    const j = idx * 3, nx = sats.next, pv = sats.prev;
    V.set(nx[j] - pv[j], nx[j + 1] - pv[j + 1], nx[j + 2] - pv[j + 2]);
    const dtMs = sats.tNext - sats.tPrev;
    let ok = dtMs !== 0 && V.lengthSq() > 1e-16;
    if (!ok) ok = sgp4Velocity(simNowCache);                 // right after a time jump the tick buffers hold no motion yet
    else V.multiplyScalar(1000 / dtMs);
    if (ok) {
      V.x += W_EARTH * P.z; V.z -= W_EARTH * P.x;         // + omega x r: inertial velocity, so "forward" is where the vehicle flies
      F.copy(V).addScaledVector(U, -V.dot(U));
      ok = F.lengthSq() > 1e-18;
    }
    if (ok) F.normalize(); else if (hasHeading) F.copy(Fs); else { F.set(0, 1, 0).addScaledVector(U, -U.y).normalize(); if (F.lengthSq() < 0.5) F.set(1, 0, 0); }
    if (!hasHeading) { Fs.copy(F); hasHeading = true; }
    else Fs.lerp(F, 1 - Math.exp(-dt * 7));
    Fs.addScaledVector(U, -Fs.dot(U)).normalize();
  }

  // velocity (scene units / s, Earth-fixed) straight from SGP4: two positions 2 s apart
  const pA = new THREE.Vector3();
  function sgp4Pos(rec, ms, out) {
    const S = window.satellite, d = new Date(ms), pv = S.propagate(rec, d);
    if (!pv || !pv.position || !isFinite(pv.position.x)) return false;
    const g = S.gstime(d), c = Math.cos(g), s = Math.sin(g), p = pv.position;
    out.set((c * p.x + s * p.y) / R_KM, p.z / R_KM, -(-s * p.x + c * p.y) / R_KM);
    return true;
  }
  function sgp4Velocity(ms) {
    try {
      const rec = satrec(R.id);
      if (!sgp4Pos(rec, ms - 1000, pA) || !sgp4Pos(rec, ms + 1000, V)) return false;
      V.sub(pA).multiplyScalar(0.5);
      return V.lengthSq() > 1e-16;
    } catch { return false; }
  }

  function rideQuat(out) {
    Rt.crossVectors(Fs, U).normalize();                   // right = forward x up
    const cy = Math.cos(look.yaw), sy = Math.sin(look.yaw), cp = Math.cos(look.pitch), sp = Math.sin(look.pitch);
    hV.copy(Fs).multiplyScalar(cy).addScaledVector(Rt, sy);
    dirV.copy(hV).multiplyScalar(cp).addScaledVector(U, sp);
    upV.copy(U).multiplyScalar(cp).addScaledVector(hV, -sp);
    tmp.crossVectors(dirV, upV).normalize();              // camera x (right)
    nDir.copy(dirV).negate();
    mBasis.makeBasis(tmp, upV, nDir);
    return out.setFromRotationMatrix(mBasis);
  }

  function updateSun() {
    // Sun visibility from the satellite: hidden when its direction lies inside the Earth's disc as seen from here.
    const rr = P.length(), rho = Math.asin(clamp(1 / rr, 0, 1));
    sunSceneVec(simNowCache, sunV);
    const ang = Math.acos(clamp(-U.dot(sunV), -1, 1));           // angle between nadir and the Sun
    sunVis = smooth(rho - 0.010, rho + 0.016, ang);
    lit = sunVis > 0.5;
    const sunElev = U.dot(sunV);                                  // Sun above the local horizon at the sub-satellite point
    const nightBelow = 1 - smooth(-0.22, 0.16, sunElev);
    starVis = clamp(Math.max(1 - sunVis * 0.97, nightBelow * 0.3), 0.03, 1);
  }
  let simNowCache = 0;

  const prevVis = { overlays: true };
  R.k = 0;
  R.enter = function enter(id) {
    if (state.get('view') !== 'globe') return false;
    const idx = sats.idToIndex.get(id);
    if (idx === undefined || !sats.posOf(idx, P)) { state.emit('toast', 'This satellite has no valid position right now'); return false; }
    if (R.phase === 'out') return false;
    const sat = getSat(id);
    if (R.phase) { R.id = id; nameEl.textContent = sat ? (sat.notable || sat.name) : String(id); hasHeading = false; scan = null; return true; }
    env.cancelFly?.();
    R.id = id; R.phase = 'in'; hasHeading = false; scan = null; ringSig = '';
    saved = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov, near: camera.near, far: camera.far };
    flight = { el: 0, dur: reduced() ? 0.001 : 2.6, pos0: camera.position.clone(), q0: camera.quaternion.clone(), fov0: camera.fov, near0: camera.near, kStart: 0 };
    look.yaw = 0; look.mode = 'auto'; look.home = look.pitch = homePitch('auto', P.length()); fov = FOV_DEFAULT;
    controls.enabled = false;
    rateBefore = null; rateByHud = null;
    nameEl.textContent = sat ? (sat.notable || sat.name) : String(id);
    hud.hidden = false; requestAnimationFrame(() => hud.classList.add('show'));
    document.body.classList.add('riding');
    fx.ensureNoise(); fx.setDetailGeometry(true); fx.upgradeNow();
    if (softwareGL) state.emit('toast', 'Low-power graphics: reduced quality');
    syncButtons();
    env.onChange?.(true);
    env.wake?.(4000);
    return true;
  };

  R.exit = function exit(immediate = false) {
    if (!R.phase || R.phase === 'out') return;
    if (immediate || reduced()) { finish(); return; }
    // orbit camera to return to: the saved one, unless the satellite has left that side of the planet
    const to = saved.pos.clone();
    const idx = sats.idToIndex.get(R.id);
    if (idx !== undefined && sats.posOf(idx, tmp)) {
      const sd = tmp.clone().normalize();
      if (sd.angleTo(to.clone().normalize()) > 1.0) {
        const side = to.clone().normalize();
        to.copy(sd).multiplyScalar(clamp(saved.pos.length(), 1.7, 6));
        to.y = clamp(to.y, -to.length() * 0.95, to.length() * 0.95);
        void side;
      }
    }
    const qT = lookQuat(to, new THREE.Quaternion());
    target = { pos: to, quat: qT };
    flight = { el: 0, dur: 2.0, pos0: camera.position.clone(), q0: camera.quaternion.clone(), fov0: camera.fov, near0: camera.near, kStart: R.k };
    R.phase = 'out';
    hud.classList.remove('show');
    env.wake?.(3000);
  };

  function finish() {
    const wasActive = !!R.phase;
    R.phase = null; R.k = 0; flight = null;
    hud.classList.remove('show'); hud.hidden = true;
    document.body.classList.remove('riding');
    fx.setAmount(0); fx.setDetailGeometry(false);
    sats.material.uniforms.uRide.value = 0;
    if (wasActive && saved) {
      const pos = target ? target.pos : saved.pos;
      camera.up.set(0, 1, 0);
      camera.position.copy(pos);
      camera.fov = saved.fov; camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix();
      camera.lookAt(0, 0, 0);
    }
    target = null;
    controls.enabled = true;
    controls.update();
    // restore the sim speed if the HUD changed it
    if (rateBefore !== null && rateByHud !== null && getRate() === rateByHud) setRate(rateBefore);
    rateBefore = rateByHud = null;
    dragging = false;
    env.onChange?.(false);
    env.wake?.(1500);
  }
  R.toggle = (id) => { if (R.phase && R.phase !== 'out') R.exit(); else R.enter(id); };

  /** Take over the camera for this frame. Returns false when the ride ended (caller then runs the orbit camera). */
  R.step = function step(nowT, simMs, dt) {
    if (!R.phase) return false;
    simNowCache = simMs;
    const idx = sats.idToIndex.get(R.id);
    if (idx === undefined || !sats.posOf(idx, P)) { R.exit(true); return false; }
    U.copy(P).divideScalar(P.length());
    heading(idx, dt);
    // gentle spring back to the home view after a drag
    if (!dragging && nowT - lastDrag > 700) {
      const a = 1 - Math.exp(-dt * 1.8);
      look.yaw += (0 - look.yaw) * a; look.pitch += (look.home - look.pitch) * a;
    }
    look.home = homePitch(look.mode, P.length());
    rideQuat(qRide);
    updateSun();

    if (R.phase === 'on') {
      camera.position.copy(P); camera.quaternion.copy(qRide);
      if (camera.fov !== fov || camera.near !== NEAR) { camera.fov = fov; camera.near = NEAR; }
      R.k = 1;
    } else if (R.phase === 'in') {
      flight.el += dt;
      const t = clamp(flight.el / flight.dur, 0, 1), e = easeIO(t);
      placeBetween(flight.pos0, flight.q0, P, qRide, e, smooth(0.12, 1, t), null);
      // the target moves with the satellite: aim the descent at where it is now
      camera.fov = flight.fov0 + (fov - flight.fov0) * e;
      camera.near = lerpLog(flight.near0, NEAR, e);
      R.k = e;
      if (t >= 1) { R.phase = 'on'; camera.position.copy(P); camera.quaternion.copy(qRide); camera.fov = fov; camera.near = NEAR; R.k = 1; }
    } else if (R.phase === 'out') {
      flight.el += dt;
      const t = clamp(flight.el / flight.dur, 0, 1), e = easeIO(t);
      placeBetween(flight.pos0, flight.q0, target.pos, target.quat, e, smooth(0.0, 0.75, t), null);
      camera.fov = flight.fov0 + (saved.fov - flight.fov0) * e;
      camera.near = lerpLog(flight.near0, saved.near, e);
      R.k = flight.kStart * (1 - e);
      if (t >= 1) { finish(); return false; }
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    fx.setAmount(R.k, { softwareGL });
    fx.update(camera, sunVis, starVis, renderer.getPixelRatio());
    const su = sats.material.uniforms;
    su.uRide.value = R.k; su.uHide.value.copy(P);
    hudTick(simMs, false);
    return true;
  };

  // leaving the Orbit view ends the ride at once
  state.on('view', (v) => { if (v !== 'globe' && R.phase) R.exit(true); });
  state.on('selection', (sel) => {
    if (!R.phase || R.phase === 'out') return;
    if (!sel || sel.kind !== 'sat') R.exit();
    else if (sel.id !== R.id) R.enter(sel.id);
  });

  R._look = look;
  R.dpr = (d) => (softwareGL ? Math.min(d, 0.5) : Math.min(d, 1.5));
  R.hudTickNow = (simMs) => hudTick(simMs, true);
  return R;
}
