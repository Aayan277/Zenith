// "Look up" sky view: stereographic all-sky dome with stars, constellations,
// Milky Way, Sun/Moon/planets and live satellites for the observer's location.
import * as state from '../state.js';
import * as clock from '../clock.js';
import { D2R, R2D, makeFrame, computeBodies, applyM, enuToAltAz, altAzToEnu, limitMag, twilightName, compass,
  riseTransitSet, defineStar, observer, BODY_COLORS, BODY_NAMES } from './astro.js';
import { loadSkyData, makeStarSprites, makeGlowSprite, bvBucket, BV_BUCKETS, MW_W, MW_H } from './data.js';
import { initSats, setActive as setSatsActive, setObserver, getFrame as getSatFrame, satPosition, skyTrack, tickSeq, CAT_KEYS } from './sats.js';
import { registerProviders, fmtTime } from './details.js';
import { initAurora, updateAurora, prepareAuroraLayer, drawAurora, auroraAt, auroraState, auroraHeadline, auroraDetail } from './aurora.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { createLoop, onVisibility, isHidden, reducedMotion, idle, QualityGovernor } from '../util/governor.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const FONT = "'Space Grotesk', system-ui, sans-serif";
const PREF_KEY = 'skywatch:sky';

// ---- module state -----------------------------------------------------------
let root, canvas, ctx, tip, headerEl, headerAurEl, controlsEl;
let W = 0, H = 0, dpr = 1;
let data = null, sprites = null, sunGlow = null, moonGlow = null, glowSprites = {};
let active = false, lastTs = 0;
// Layer caches (full-resolution offscreen canvases):
//   back  = sky gradient + Milky Way + grid + constellation lines + non-twinkling stars  (changes with camera / slow time drift)
//   front = ground + labels + compass                                                    (changes with camera / selection / ~1 Hz)
// Per frame only the moving things are drawn on top: twinkling stars, bodies, satellites, tracks, selection ring.
let backCv = null, backCtx = null, backKey = '', frontCv = null, frontCtx = null, frontKey = '';
let mainCtx = null, queueOn = true, camBusy = false, qTier = 0, qGov = null, loop = null;
const DEVICE_DPR = Math.min(window.devicePixelRatio || 1, 2);
const QTIERS = [DEVICE_DPR, 1.5, 1].filter((d, i, a) => d <= DEVICE_DPR + 1e-6 && a.indexOf(d) === i);
const PIN_QUALITY = /[?&]quality=(high|max)/.test(location.search);
const invalidate = () => { skyKey = ''; backKey = ''; frontKey = ''; };
let F = null;                       // frame matrices
let bodies = [], bodiesOrder = [], bodiesTime = -1e15, bodiesLoc = '', filtVer = 0;
let sunAlt = -30, lim = 6.5;
const opts = { lines: true, labels: true, mw: true, grid: false, sats: true, aurora: true };
const cam = { alt: 90, az: 180, zoom: 1 };
let zoomT = 1, zoomAnchor = null, tween = null;
let velPan = { x: 0, y: 0 }, velAz = 0, dragging = false;
let cx = 0, cy = 0, S = 100;
let r0, r1, r2, u0, u1, u2, f0, f1, f2;      // camera basis (ENU)
let C = new Float64Array(9);                 // J2000 equatorial -> camera
let PX = 0, PY = 0, PZ = 0;
let hover = null, hoverCon = null;
let selection = null;
let skyBuf = null, skyBufCtx = null, skyKey = '';
let skyColors = null;                        // {hz, zen} for ground tint
let passes = [], passTrack = null, passKey = '';
let selTrack = null, selTrackKey = '', selTrackAt = 0;
let hits = null;                             // picking buffers
let orientOn = false, orientSupported = false;
let treeCache = null;
let defaultCam = true;

// ---- init -------------------------------------------------------------------
export async function init() {
  root = document.getElementById('view-sky');
  if (!root) return;
  loadPrefs();
  buildDom();
  setObserver(state.get('location'));
  registerProviders({ aurora: (ms) => auroraDetail(state.get('location'), ms), data: () => data, frameAt: ms => (F && Math.abs(F.time - ms) < 1500 ? F : makeFrame(ms, state.get('location'))) });
  loop = createLoop(loopFrame, { interval: idleInterval });
  qGov = new QualityGovernor(QTIERS.length, (t) => { qTier = t; resize(); }, { pinned: PIN_QUALITY, name: 'sky' });
  wire();
  resize();
  new ResizeObserver(resize).observe(root);
  onVisibility((hidden) => { if (hidden) halt(); else if (active) resume(); });
  // Star data / Milky Way / sprites are parsed off the critical path: right away when the sky is the first view,
  // otherwise when the browser is idle.
  initAurora(() => { loop && loop.wake(300); });
  const boot = async () => { await loadData(); await initSats(); setActive(state.get('view') === 'sky', true); };
  if (state.get('view') === 'sky') await boot();
  else idle(() => { boot().catch(e => console.error('[sky] boot', e)); }, 2500);
}

async function loadData() {
  try { data = await loadSkyData(); } catch (e) { console.error('[sky] data', e); state.emit('toast', 'Could not load star data'); return; }
  [...data.cons].sort((a, b) => b.segs.reduce((n, g) => n + g.length, 0) - a.segs.reduce((n, g) => n + g.length, 0)).forEach((c, i) => { c.rank = i; });
  sprites = makeStarSprites();
  sunGlow = makeGlowSprite('255,236,170', 128);
  moonGlow = makeGlowSprite('200,215,255', 128);
  for (const [k, rgb] of Object.entries({ Mercury: '207,198,182', Venus: '255,246,220', Mars: '255,143,102', Jupiter: '255,227,189', Saturn: '242,217,154', Uranus: '169,234,240', Neptune: '134,165,255', sat: '255,255,255' }))
    glowSprites[k] = makeGlowSprite(rgb, 64);
  hits = { n: 0, x: new Float32Array(data.stars.n), y: new Float32Array(data.stars.n), i: new Int32Array(data.stars.n) };
  buildTreeline();
}

function loadPrefs() {
  try { Object.assign(opts, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(opts)); } catch {} }

function buildDom() {
  root.innerHTML = `
    <canvas class="sky-canvas" aria-label="Sky dome showing stars, planets and satellites above you"></canvas>
    <div class="sky-header" aria-live="off"><span class="sky-header-main"></span><span class="sky-header-aur" hidden></span></div>
    <div class="sky-controls glass" role="toolbar" aria-label="Sky layers">
      <button class="sky-btn" data-opt="lines" title="Constellation lines">Lines</button>
      <button class="sky-btn" data-opt="labels" title="Constellation and star names">Names</button>
      <button class="sky-btn" data-opt="mw" title="Milky Way">Milky Way</button>
      <button class="sky-btn" data-opt="grid" title="Altitude/azimuth grid, ecliptic and celestial equator">Grid</button>
      <button class="sky-btn" data-opt="sats" title="Satellites">Satellites</button>
      <button class="sky-btn" data-opt="aurora" title="Aurora (NOAA OVATION nowcast / Kp forecast)">Aurora</button>
      <button class="sky-btn sky-orient" data-act="orient" title="Aim the view with your phone" hidden>Phone</button>
      <button class="sky-btn sky-reset" data-act="reset" title="Reset view (double-click)" hidden>Reset</button>
    </div>
    <div class="sky-hint glass" hidden>
      <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-opacity=".6"/><circle cx="20" cy="20" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="2 3"/><circle cx="20" cy="20" r="2.2" fill="#5ce1ff"/></svg>
      <div><b>Looking up</b><span>Center = straight up<em> · </em><br>Edge = horizon</span></div>
      <button class="sky-hint-x" aria-label="Dismiss hint">&times;</button>
    </div>
    <div class="sky-tip" role="tooltip" hidden></div>`;
  canvas = root.querySelector('canvas');
  ctx = canvas.getContext('2d');
  tip = root.querySelector('.sky-tip');
  headerEl = root.querySelector('.sky-header-main');
  headerAurEl = root.querySelector('.sky-header-aur');
  controlsEl = root.querySelector('.sky-controls');
  const hint = root.querySelector('.sky-hint');
  let seen = false; try { seen = localStorage.getItem('skywatch:sky:hint') === '1'; } catch {}
  hint.hidden = seen;
  hint.querySelector('.sky-hint-x').addEventListener('click', () => { hint.hidden = true; try { localStorage.setItem('skywatch:sky:hint', '1'); } catch {} });
  syncButtons();
  controlsEl.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.opt) { opts[b.dataset.opt] = !opts[b.dataset.opt]; savePrefs(); syncButtons(); invalidate(); }
    else if (b.dataset.act === 'reset') resetView();
    else if (b.dataset.act === 'orient') toggleOrientation();
  });
  orientSupported = typeof DeviceOrientationEvent !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  if (orientSupported) controlsEl.querySelector('.sky-orient').hidden = false;
}
function syncButtons() {
  controlsEl.querySelectorAll('[data-opt]').forEach(b => { const on = !!opts[b.dataset.opt]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
}

function resize() {
  const r = root.getBoundingClientRect();
  W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
  dpr = QTIERS[qTier] || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  if (!backCv) { backCv = document.createElement('canvas'); backCtx = backCv.getContext('2d'); frontCv = document.createElement('canvas'); frontCtx = frontCv.getContext('2d'); }
  backCv.width = frontCv.width = canvas.width; backCv.height = frontCv.height = canvas.height;
  invalidate(); uiRect.bottom = 0;
  if (loop) loop.wake(300);
}

function setActive(on, force) {
  if (on === active && !force) return;
  active = on;
  if (on) resume();
  else { halt(); if (orientOn) toggleOrientation(); }
}
// Hidden tab / other view: no rAF, no worker ticks.
function halt() { loop && loop.stop(); setSatsActive(false); }
function resume() {
  if (isHidden() || !active || !loop) return;
  setSatsActive(true);
  lastTs = 0; if (qGov) qGov.reset();
  loop.start();
}

function wire() {
  state.on('view', v => setActive(v === 'sky'));
  state.on('location', loc => { setObserver(loc); F = null; bodiesTime = -1e15; invalidate(); selTrackKey = ''; });
  state.on('filters', () => { filtVer++; });
  state.on('highlightsOnly', () => { filtVer++; });
  state.on('selection', s => { selection = s; selTrackKey = ''; frontKey = ''; backKey = ''; loop && loop.wake(300); });
  selection = state.get('selection');
  state.on('focus', focusOn);
  state.on('passes', list => { passes = Array.isArray(list) ? list : []; passKey = ''; });
  state.on('clock', () => { invalidate(); loop && loop.wake(300); });
  setupPointer();
}

// ---- camera -----------------------------------------------------------------
// Free area for the dome, measured from the real chrome (topbar, controls, timebar, mobile sheet).
let uiRect = { top: 110, bottom: 0, left: 0, right: 0 }, uiAt = 0;
function visibleRect(sel) {
  const el = document.querySelector(sel); if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' ? r : null;
}
function refreshUi() {
  uiAt = performance.now();
  const mobile = W <= 760;
  let top = 100, bottom = H - 16;
  const tb = visibleRect('#topbar'); if (tb) top = Math.max(top, tb.bottom + 36 + (headerAurEl && !headerAurEl.hidden && !mobile ? 14 : 0));
  const ctl = controlsEl.getBoundingClientRect();
  const hintEl = root.querySelector('.sky-hint');
  const hintH = mobile && hintEl && !hintEl.hidden ? hintEl.offsetHeight + 8 : 0;
  if (mobile) top = Math.max(top, ctl.bottom + 16 + hintH);
  else bottom = Math.min(bottom, ctl.top - 6);
  const tl = visibleRect('#timebar'); if (tl) bottom = Math.min(bottom, tl.top - 8);
  if (mobile) { const sh = visibleRect('#panel-tonight'); if (sh && sh.top > top + 180) bottom = Math.min(bottom, sh.top - 8); }
  if (bottom - top < 150) bottom = top + 150;
  const k = `${top | 0}|${bottom | 0}`;
  if (k !== `${uiRect.top | 0}|${uiRect.bottom | 0}`) skyKey = '';
  uiRect = { top, bottom }; window.__skyUi = { top, bottom, hintH, ctlB: ctl.bottom };
  if (hintEl) hintEl.style.top = mobile && !hintEl.hidden ? (ctl.bottom + 6) + 'px' : '';
}
function layout() {
  if (!uiRect.bottom || performance.now() - uiAt > 300) refreshUi();
  const freeW = W > 900 ? W - 720 : W - 16;
  const availH = uiRect.bottom - uiRect.top;
  const S0 = Math.max(40, Math.min((availH / 2 - 16) / 2.2, (freeW / 2 - 8) / 2.2));
  S = S0 * cam.zoom;
  cx = W / 2;
  cy = (uiRect.top + uiRect.bottom) / 2;
  const a = cam.alt * D2R, A = cam.az * D2R;
  const sa = Math.sin(a), ca = Math.cos(a), sA = Math.sin(A), cA = Math.cos(A);
  f0 = ca * sA; f1 = ca * cA; f2 = sa;
  r0 = cA; r1 = -sA; r2 = 0;
  u0 = -sa * sA; u1 = -sa * cA; u2 = ca;
}
function proj(e, n, u) {
  const xc = r0 * e + r1 * n + r2 * u, yc = u0 * e + u1 * n + u2 * u, zc = f0 * e + f1 * n + f2 * u;
  const den = 1 + zc; PZ = zc;
  if (den < 0.05) return false;
  const k = 2 * S / den; PX = cx + k * xc; PY = cy - k * yc; return true;
}
function unproj(px, py, out) {
  const x = (px - cx) / S, y = (cy - py) / S, rho2 = x * x + y * y, d = 4 + rho2;
  const vr = 4 * x / d, vu = 4 * y / d, vf = (4 - rho2) / d;
  out[0] = vr * r0 + vu * u0 + vf * f0; out[1] = vr * r1 + vu * u1 + vf * f1; out[2] = vr * r2 + vu * u2 + vf * f2;
  return out;
}
// Move the sky content by (dx, dy) screen pixels (drag semantics).
function panPx(dx, dy) {
  layout();
  const kx = -dx / S, ky = dy / S;
  const e = f0 + kx * r0 + ky * u0, n = f1 + kx * r1 + ky * u1, u = f2 + kx * r2 + ky * u2;
  const L = Math.hypot(e, n, u);
  let alt = Math.asin(clamp(u / L, -1, 1)) * R2D;
  if (Math.hypot(e, n) / L > 0.02) cam.az = ((Math.atan2(e, n) * R2D) % 360 + 360) % 360;
  cam.alt = clamp(alt, -12, 90);
  defaultCam = false;
}
function resetView() {
  startTween({ alt: 90, az: shortestAz(cam.az, 180), zoom: 1 }, 900);
  defaultCam = true;
}
const shortestAz = (from, to) => { let d = ((to - from) % 360 + 540) % 360 - 180; return from + d; };
function startTween(to, dur = 1200) {
  if (reducedMotion()) dur = 1;
  if (loop) loop.wake(dur + 300);
  tween = { t0: performance.now(), dur, from: { ...cam }, to: { ...to } };
  zoomT = to.zoom; zoomAnchor = null; velPan.x = velPan.y = 0; velAz = 0;
}
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function stepCamera(dt, now) {
  if (tween) {
    const t = clamp((now - tween.t0) / tween.dur, 0, 1), k = ease(t);
    cam.alt = lerp(tween.from.alt, tween.to.alt, k);
    cam.az = ((lerp(tween.from.az, tween.to.az, k) % 360) + 360) % 360;
    cam.zoom = Math.exp(lerp(Math.log(tween.from.zoom), Math.log(tween.to.zoom), k));
    if (t >= 1) tween = null;
    return;
  }
  // zoom smoothing (+ keep point under cursor fixed when zooming in)
  if (Math.abs(zoomT - cam.zoom) > 1e-4) {
    let anchorVec = null;
    if (zoomAnchor && zoomT > cam.zoom && cam.zoom > 1.05) { layout(); anchorVec = unproj(zoomAnchor.x, zoomAnchor.y, [0, 0, 0]); }
    cam.zoom *= Math.exp(Math.log(zoomT / cam.zoom) * (1 - Math.exp(-dt * (reducedMotion() ? 1e3 : 11))));
    if (Math.abs(zoomT - cam.zoom) < 1e-3) cam.zoom = zoomT;
    if (anchorVec) { layout(); if (proj(anchorVec[0], anchorVec[1], anchorVec[2])) panPx(zoomAnchor.x - PX, zoomAnchor.y - PY); }
  }
  if (!dragging) {
    if (Math.abs(velAz) > 0.05) { cam.az = ((cam.az + velAz * dt) % 360 + 360) % 360; velAz *= Math.exp(-dt * 3.2); } else velAz = 0;
    if (Math.abs(velPan.x) + Math.abs(velPan.y) > 4) {
      panPx(velPan.x * dt, velPan.y * dt);
      const d = Math.exp(-dt * 4); velPan.x *= d; velPan.y *= d;
    } else velPan.x = velPan.y = 0;
    if (zoomT < 1.25 && !orientOn && cam.alt < 90) cam.alt = Math.min(90, cam.alt + (90 - cam.alt) * (1 - Math.exp(-dt * 3.5)));
  }
}

const auroraCam = { key: '', W: 0, H: 0, cx: 0, cy: 0, S: 1, r: [0, 0, 0], u: [0, 0, 0], f: [0, 0, 0] };
// ---- main loop ----------------------------------------------------------------
// Full rate while the camera moves / the user interacts / the sim runs fast; ~20-30 fps when still.
function isBusy() {
  return dragging || pointers.size > 0 || !!tween || orientOn || Math.abs(velAz) > 0.05 || Math.abs(velPan.x) + Math.abs(velPan.y) > 4
    || Math.abs(zoomT - cam.zoom) > 1e-3 || Math.abs(clock.getRate()) > 10;
}
function idleInterval() {
  if (camBusy) return 0;
  return (selection || Math.abs(clock.getRate()) > 1.5) ? 33 : 50;
}
function loopFrame(ts, dt) {
  if (!active) return;
  lastTs = ts;
  const t0 = performance.now();
  try { frame(ts, dt); } catch (e) { console.error('[sky] frame', e); }
  window.__skyFrames = (window.__skyFrames || 0) + 1;
  window.__skyFrameMs = (window.__skyFrameMs || 0) * 0.9 + (performance.now() - t0) * 0.1;
  camBusy = isBusy();
  if (camBusy) loop.wake(120);
  qGov.sample(ts, camBusy);
}

function frame(ts, dt) {
  if (!window.Astronomy || !data) return;
  const loc = state.get('location');
  const simNow = clock.now();
  stepCamera(dt, ts);
  layout();
  if (!F || Math.abs(simNow - F.time) > 400) F = makeFrame(simNow, loc);
  const locKey = `${loc.lat},${loc.lon}`;
  if (Math.abs(simNow - bodiesTime) > (bodiesTime === -1e15 ? 0 : 15000) || locKey !== bodiesLoc) {
    bodies = computeBodies(simNow, loc, F, true); bodiesTime = simNow; bodiesLoc = locKey;
    sunAlt = bodies[0] ? bodies[0].alt : -30; lim = limitMag(sunAlt);
    bodiesOrder = bodies.filter(b => b.name !== 'Sun' && b.name !== 'Moon').concat(bodies.filter(b => b.name === 'Moon'), bodies.filter(b => b.name === 'Sun'));
    for (const b of bodies) if (!b.rgb) b.rgb = hexToRgb(b.color);
  }
  const aSt = updateAurora(loc, simNow, sunAlt, opts.aurora);
  // camera -> equatorial matrix
  const M = F.M;
  C[0] = r0 * M[0] + r1 * M[3] + r2 * M[6]; C[1] = r0 * M[1] + r1 * M[4] + r2 * M[7]; C[2] = r0 * M[2] + r1 * M[5] + r2 * M[8];
  C[3] = u0 * M[0] + u1 * M[3] + u2 * M[6]; C[4] = u0 * M[1] + u1 * M[4] + u2 * M[7]; C[5] = u0 * M[2] + u1 * M[5] + u2 * M[8];
  C[6] = f0 * M[0] + f1 * M[3] + f2 * M[6]; C[7] = f0 * M[1] + f1 * M[4] + f2 * M[7]; C[8] = f0 * M[2] + f1 * M[5] + f2 * M[8];

  mainCtx = ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const night = clamp((lim - 1) / 3.5, 0, 1);   // 0 day .. 1 night, for overlays
  const rate = clock.getRate();
  const hiCon = hoverCon || (selection?.kind === 'constellation' ? selection.id : '');

  // ---- static layer: re-rendered when the camera moves or the star field has drifted by ~0.4 px
  const driftPxPerS = 1.46e-4 * S * Math.max(1, Math.abs(rate));
  const tb = clamp(400 / driftPxPerS, 250, 4000);
  const bKey = `${cam.alt.toFixed(3)}|${cam.az.toFixed(3)}|${cam.zoom.toFixed(4)}|${W}|${H}|${dpr}|${uiRect.top | 0}|${uiRect.bottom | 0}|${opts.mw}|${opts.grid}|${opts.lines}|${hiCon}|${Math.floor(simNow / tb)}|${camBusy ? 1 : 0}|${Math.round(sunAlt * 4)}`;
  // ---- front layer (ground, labels, compass): same camera triggers + selection/hover/filters + a ~1 Hz refresh
  const fb = Math.abs(rate) <= 1.5 ? 1000 : 1;
  const sel = selection ? selection.kind + selection.id : '';
  const hv = hover ? hover.kind + hover.id : '';
  const fKey = `${cam.alt.toFixed(3)}|${cam.az.toFixed(3)}|${cam.zoom.toFixed(4)}|${W}|${H}|${dpr}|${uiRect.top | 0}|${uiRect.bottom | 0}|${opts.lines}|${opts.labels}|${opts.sats}|${sel}|${hv}|${hiCon}|${filtVer}|${bodiesTime}|${passKey}|${Math.round(sunAlt * 8)}|${Math.floor(simNow / fb)}|${tickSeq()}`;
  const needBack = bKey !== backKey, needFront = fKey !== frontKey;
  // While the camera moves both layers change every frame and caching would only add two full-screen blits:
  // draw straight onto the canvas (original order) and let the caches rebuild once the camera settles.
  const direct = camBusy && needBack && needFront;
  queueOn = needFront;
  labelQ.length = 0; obst.length = 0;
  if (direct) { backKey = ''; frontKey = ''; drawBackLayers(simNow, ts, night); }
  else {
    if (needBack) { backKey = bKey; renderBack(simNow, ts, night); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backCv, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  if (aSt.vis) {
    // Additive glow over the cached sky + stars (addition commutes, so stars stay visible "through" it);
    // ground and labels come later in the front layer.
    auroraCam.key = `${cam.alt.toFixed(3)}|${cam.az.toFixed(3)}|${cam.zoom.toFixed(4)}|${W}|${H}|${cx.toFixed(1)}|${cy.toFixed(1)}`;
    auroraCam.W = W; auroraCam.H = H; auroraCam.cx = cx; auroraCam.cy = cy; auroraCam.S = S;
    auroraCam.r[0] = r0; auroraCam.r[1] = r1; auroraCam.r[2] = r2; auroraCam.u[0] = u0; auroraCam.u[1] = u1; auroraCam.u[2] = u2;
    auroraCam.f[0] = f0; auroraCam.f[1] = f1; auroraCam.f[2] = f2;
    if (prepareAuroraLayer(auroraCam, camBusy ? 8 : (compact() ? 4 : 3), camBusy)) drawAurora(ctx, W, H, ts, reducedMotion());
  }
  drawTwinkle(ts);
  drawBodies(ts, simNow);
  if (opts.sats) drawSats(ts, simNow); else satPick.n = 0;
  drawPassArc(simNow);
  if (needFront) {
    queueSelectionLabel(simNow);
    if (opts.lines || opts.labels) queueConLabels(night);
    queueStarLabels(night);
    if (direct) drawFrontLayers(night);
    else { frontKey = fKey; renderFront(night); }
  }
  if (!direct) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(frontCv, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawSelection(ts, simNow);
  updateHeader(simNow, loc);
  // reset button visibility
  const rb = controlsEl.querySelector('.sky-reset'); const show = !(cam.alt >= 89.9 && Math.abs(cam.zoom - 1) < 0.02);
  if (rb.hidden === show) rb.hidden = !show;
}

function drawBackLayers(simNow, ts, night) {
  drawSkyBackground(simNow);
  if (opts.grid) drawGrid(ts);
  if (opts.lines) drawConLines(night);
  drawStarsStatic(night);
}
function drawFrontLayers(night) {
  skyColors = skyParams(sunAlt);
  // Labels go on top of the ground so ones near the horizon aren't clipped
  // (objects below the horizon never queue a label).
  drawGround(night);
  flushLabels();
  drawCompass();
}
function renderBack(simNow, ts, night) {
  ctx = backCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawBackLayers(simNow, ts, night);
  ctx = mainCtx;
}
function renderFront(night) {
  ctx = frontCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, frontCv.width, frontCv.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawFrontLayers(night);
  ctx = mainCtx;
}

// ---- sky background (low-res per-pixel buffer, upscaled) ---------------------
const SKY_KEYS = [
  [-18, [2, 4, 11], [8, 13, 26], [30, 40, 70], 0.0],
  [-12, [4, 9, 26], [16, 28, 58], [90, 60, 85], 0.30],
  [-6, [8, 18, 54], [44, 62, 106], [225, 110, 62], 0.85],
  [-1.5, [20, 46, 108], [112, 104, 138], [255, 128, 56], 1.0],
  [3, [40, 92, 176], [170, 176, 200], [255, 176, 104], 0.8],
  [12, [62, 128, 214], [158, 200, 238], [255, 236, 205], 0.35],
  [40, [48, 118, 214], [150, 200, 242], [255, 245, 222], 0.2],
];
function skyParams(s) {
  let a = SKY_KEYS[0], b = SKY_KEYS[0], t = 0;
  if (s >= SKY_KEYS[SKY_KEYS.length - 1][0]) a = b = SKY_KEYS[SKY_KEYS.length - 1];
  else if (s > SKY_KEYS[0][0]) {
    for (let i = 1; i < SKY_KEYS.length; i++) if (s <= SKY_KEYS[i][0]) { a = SKY_KEYS[i - 1]; b = SKY_KEYS[i]; t = (s - a[0]) / (b[0] - a[0]); break; }
  }
  const mix = (i) => a[i].map((v, j) => lerp(v, b[i][j], t));
  return { zen: mix(1), hz: mix(2), glow: mix(3), amt: lerp(a[4], b[4], t) };
}

function drawSkyBackground(simNow) {
  const key = [cam.alt.toFixed(3), cam.az.toFixed(3), cam.zoom.toFixed(4), W, H, Math.floor(simNow / 4000), opts.mw, camBusy].join('|');
  const cell = opts.mw ? (camBusy ? 9 : 6) : 10;   // coarser gradient while the camera moves; settles to full detail when still
  const bw = Math.ceil(W / cell), bh = Math.ceil(H / cell);
  if (!skyBuf || skyBuf.width !== bw || skyBuf.height !== bh) {
    skyBuf = document.createElement('canvas'); skyBuf.width = bw; skyBuf.height = bh;
    skyBufCtx = skyBuf.getContext('2d'); skyKey = '';
  }
  const P = skyParams(sunAlt);
  skyColors = P;
  if (key !== skyKey) {
    skyKey = key;
    const img = skyBufCtx.createImageData(bw, bh), d = img.data;
    const sun = bodies[0];
    const se = sun ? sun.e : 0, sn = sun ? sun.n : 0, su = sun ? sun.u : -1;
    const nightF = opts.mw ? clamp((-sunAlt - 9) / 7, 0, 1) : 0;
    const kc = sunAlt > 0 ? lerp(5, 40, clamp(sunAlt / 25, 0, 1)) : lerp(3.2, 5, clamp((sunAlt + 18) / 18, 0, 1));
    const flat = clamp((sunAlt - 5) / 20, 0, 1);
    const M = F.M, tex = data.mw.tex;
    const [zr, zg, zb] = P.zen, [hr, hg, hb] = P.hz, [gr, gg, gb] = P.glow;
    let o = 0;
    for (let y = 0; y < bh; y++) {
      const py = (y + 0.5) * cell, yy = (cy - py) / S;
      for (let x = 0; x < bw; x++) {
        const px = (x + 0.5) * cell, xx = (px - cx) / S;
        const rho2 = xx * xx + yy * yy, dd = 4 + rho2;
        const vr = 4 * xx / dd, vu = 4 * yy / dd, vf = (4 - rho2) / dd;
        const e = vr * r0 + vu * u0 + vf * f0, n = vr * r1 + vu * u1 + vf * f1, up = vr * r2 + vu * u2 + vf * f2;
        let R, G, B;
        if (up <= 0) {
          const k = 0.55; R = hr * k; G = hg * k; B = hb * k;
        } else {
          const t = Math.pow(up, 0.42);
          R = hr + (zr - hr) * t; G = hg + (zg - hg) * t; B = hb + (zb - hb) * t;
          const cg = e * se + n * sn + up * su;
          const hp = lerp(Math.exp(-up * 4.5), 1, flat);
          const gl = P.amt * Math.exp(-(1 - cg) * kc) * hp;
          R += gr * gl; G += gg * gl; B += gb * gl;
          if (nightF > 0) {
            const X = M[0] * e + M[3] * n + M[6] * up, Y = M[1] * e + M[4] * n + M[7] * up, Z = M[2] * e + M[5] * n + M[8] * up;
            const lon = Math.atan2(Y, X), dec = Math.asin(Z > 1 ? 1 : Z < -1 ? -1 : Z);
            const tx = ((lon + Math.PI) / TAU * MW_W) | 0, ty = ((Math.PI / 2 - dec) / Math.PI * (MW_H - 1)) | 0;
            const v = tex[ty * MW_W + (tx >= MW_W ? MW_W - 1 : tx)];
            if (v > 0.003) {
              const ext = 0.3 + 0.7 * clamp(up * 3.5, 0, 1);
              const m = v * v * 0.5 * nightF * ext + v * 0.5 * nightF * ext * 0.4;
              R += 120 * m; G += 146 * m; B += 205 * m;
            }
          }
        }
        d[o++] = R > 255 ? 255 : R; d[o++] = G > 255 ? 255 : G; d[o++] = B > 255 ? 255 : B; d[o++] = 255;
      }
    }
    skyBufCtx.putImageData(img, 0, 0);
  }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(skyBuf, 0, 0, W, H);
}

// ---- grid, ecliptic -------------------------------------------------------------
function strokePolyline(pts, closed) { /* pts: [e,n,u,...] flat */
  let pen = false;
  for (let i = 0; i < pts.length; i += 3) {
    if (proj(pts[i], pts[i + 1], pts[i + 2])) { if (pen) ctx.lineTo(PX, PY); else { ctx.moveTo(PX, PY); pen = true; } }
    else pen = false;
  }
}
let gridPts = null;
function buildGrid() {
  const alts = [], azs = [];
  for (const a of [15, 30, 45, 60, 75]) { const p = []; for (let z = 0; z <= 360; z += 3) p.push(...altAzToEnu(a, z)); alts.push(p); }
  for (let z = 0; z < 360; z += 30) { const p = []; for (let a = 0; a <= 90; a += 3) p.push(...altAzToEnu(a, z)); azs.push(p); }
  gridPts = { alts, azs };
}
function drawGrid(ts) {
  if (!gridPts) buildGrid();
  ctx.save();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(140,190,255,0.16)';
  ctx.beginPath();
  for (const p of gridPts.alts) strokePolyline(p);
  for (const p of gridPts.azs) strokePolyline(p);
  ctx.stroke();
  // celestial equator + ecliptic (J2000 eq. vectors -> ENU)
  const M = F.M;
  const eq = [], ec = [], eps = 23.4393 * D2R;
  for (let l = 0; l <= 360; l += 2) {
    const a = l * D2R;
    let v = applyM(M, Math.cos(a), Math.sin(a), 0); eq.push(v[0], v[1], v[2]);
    v = applyM(M, Math.cos(a), Math.sin(a) * Math.cos(eps), Math.sin(a) * Math.sin(eps)); ec.push(v[0], v[1], v[2]);
  }
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(92,225,200,0.28)'; ctx.beginPath(); strokePolyline(eq); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,196,110,0.34)'; ctx.beginPath(); strokePolyline(ec); ctx.stroke();
  ctx.setLineDash([]);
  // altitude labels along the meridian opposite the camera az
  ctx.font = `500 10px ${FONT}`; ctx.fillStyle = 'rgba(160,200,255,0.4)'; ctx.textAlign = 'center';
  for (const a of [30, 60]) for (const z of [0, 90, 180, 270]) {
    const v = altAzToEnu(a, z); if (proj(v[0], v[1], v[2]) && onScreen(PX, PY, 0)) ctx.fillText(a + '°', PX, PY - 3);
  }
  ctx.restore();
}
const onScreen = (x, y, m = 20) => x > -m && x < W + m && y > -m && y < H + m;

// ---- constellations -------------------------------------------------------------
function drawConLines(night) {
  if (night < 0.02 || !opts.lines) return;
  const hi = hoverCon || (selection?.kind === 'constellation' ? selection.id : null);
  ctx.lineWidth = 1; ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(110,195,255,${0.26 * night})`;
  ctx.beginPath();
  for (const c of data.cons) { if (c.id === hi) continue; conPath(c); }
  ctx.stroke();
  if (hi) {
    const c = data.consById.get(hi);
    if (c) { ctx.lineWidth = 1.6; ctx.strokeStyle = `rgba(140,220,255,${0.75 * night})`; ctx.beginPath(); conPath(c); ctx.stroke(); }
  }
}
function queueConLabels(night) {
  if (night < 0.02 || !opts.labels) return;
  const zs = Math.min(1.6, 1 + 0.12 * Math.log2(cam.zoom));
  const hi = hoverCon || (selection?.kind === 'constellation' ? selection.id : null);
  const M = F.M;
  const fs = compact() ? 8 : cam.zoom < 1.6 ? 9 : Math.round(9 * zs + 1);
  const minorA = clamp((cam.zoom - 1.4) / 1.3, 0, 1);
  for (const c of data.cons) {
    const isHi = c.id === hi, sel = selection?.kind === 'constellation' && selection.id === c.id;
    const major = c.rank < (compact() ? 16 : 36);
    const k = major ? 1 : minorA;
    if (k <= 0.02 && !isHi) continue;
    const v = applyM(M, c.label[0], c.label[1], c.label[2], tmpv);
    if (v[2] < -0.05) continue;
    if (!proj(v[0], v[1], v[2]) || !onScreen(PX, PY, 40)) continue;
    const a = (isHi ? 0.9 : (cam.zoom < 1.6 ? 0.19 : 0.27) * k) * night;
    queueLabel('c:' + c.id, c.name.toUpperCase(), PX, PY, 0, sel ? 0 : 5, fs, `rgba(150,205,255,${a})`, 'center', 3, c);
  }
}
const tmpv = [0, 0, 0];
const conLabelPos = [];

function conPath(c) {
  const M = F.M;
  for (const seg of c.segs) {
    let pen = false;
    for (let i = 0; i < seg.length; i += 3) {
      const v = applyM(M, seg[i], seg[i + 1], seg[i + 2], tmpv);
      if (proj(v[0], v[1], v[2]) && PZ > -0.8) { if (pen) ctx.lineTo(PX, PY); else { ctx.moveTo(PX, PY); pen = true; } }
      else pen = false;
    }
  }
}

// ---- stars ----------------------------------------------------------------------
function firstIndexFainterThan(mag) {
  const a = data.stars.mag; let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= mag) lo = m + 1; else hi = m; }
  return lo;
}
const TWM = 3.6;                       // stars brighter than this twinkle: they are redrawn every frame
const TW = { n: 0, x: new Float32Array(512), y: new Float32Array(512), a: new Float32Array(512), d: new Float32Array(512),
  amp: new Float32Array(512), w: new Float32Array(512), ph: new Float32Array(512), b: new Uint8Array(512) };
const starZs = () => (1 + 0.2 * Math.log2(cam.zoom)) * clamp(Math.sqrt(S / cam.zoom / 150), 0.72, 1);
function drawStarsStatic(night) {
  const st = data.stars, M = F.M;
  const zs = starZs();
  const nEnd = firstIndexFainterThan(lim + 0.7);
  ctx.globalCompositeOperation = 'lighter';
  const vec = st.vec, mag = st.mag;
  hits.n = 0; TW.n = 0;
  const Cc = C;
  for (let i = nEnd - 1; i >= 0; i--) {
    const x = vec[i * 3], y = vec[i * 3 + 1], z = vec[i * 3 + 2];
    const zc = Cc[6] * x + Cc[7] * y + Cc[8] * z;
    const den = 1 + zc; if (den < 0.08) continue;
    const up = M[6] * x + M[7] * y + M[8] * z; if (up < -0.012) continue;
    const k = 2 * S / den;
    const X = cx + k * (Cc[0] * x + Cc[1] * y + Cc[2] * z), Y = cy - k * (Cc[3] * x + Cc[4] * y + Cc[5] * z);
    if (X < -30 || X > W + 30 || Y < -30 || Y > H + 30) continue;
    const m = mag[i];
    const vis = clamp((lim - m + 0.7) / 1.7, 0, 1);
    if (vis <= 0.01) continue;
    let a = (0.3 + 0.7 * clamp((6.4 - m) / 4.8, 0, 1)) * vis;
    // atmospheric extinction near the horizon
    if (up < 0.15) a *= 0.35 + 0.65 * clamp((up + 0.012) / 0.15, 0, 1);
    const rc = (0.45 + 0.43 * Math.pow(Math.max(0, 5.9 - m), 1.12)) * zs;
    const d = rc * 5 + 1.2;
    if (m < TWM) {
      const t = TW.n++;
      if (t >= TW.x.length) { TW.n--; } else {
        const lowness = 1 - clamp(up * 2, 0, 1);
        TW.x[t] = X; TW.y[t] = Y; TW.a[t] = a; TW.d[t] = d; TW.b[t] = st.bucket[i];
        TW.amp[t] = 0.05 + 0.2 * lowness * lowness; TW.w[t] = 3 + (i % 7); TW.ph[t] = st.phase[i];
      }
    } else {
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.drawImage(sprites[st.bucket[i]], X - d / 2, Y - d / 2, d, d);
    }
    if (m < 5.4) { const h = hits.n++; hits.x[h] = X; hits.y[h] = Y; hits.i[h] = i; }
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
// The bright stars: positions come from the last static render, only the scintillation is evaluated per frame.
function drawTwinkle(ts) {
  if (!TW.n) return;
  const t = ts / 1000, still = reducedMotion();
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < TW.n; k++) {
    let a = TW.a[k];
    if (!still) a *= 1 + TW.amp[k] * Math.sin(t * TW.w[k] + TW.ph[k]);
    const d = TW.d[k];
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(sprites[TW.b[k]], TW.x[k] - d / 2, TW.y[k] - d / 2, d, d);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
// star names (greedy, brightest first, skipping overlaps)
function queueStarLabels(night) {
  if (!(opts.labels && night > 0.05)) return;
  const st = data.stars, M = F.M, vec = st.vec, mag = st.mag;
  const zs = starZs();
  const lm = Math.min(4.6, 2.2 + 0.9 * Math.log2(cam.zoom)) - (compact() ? 0.8 : 0);
  const fs = Math.round((compact() ? 10 : 11) * Math.min(1.2, zs));
  ctx.font = `500 ${fs}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const i of st.labelled) {
    const m = mag[i]; if (m > lm) break;
    const x = vec[i * 3], y = vec[i * 3 + 1], z = vec[i * 3 + 2];
    const v = applyM(M, x, y, z, tmpv); if (v[2] < 0.02) continue;
    if (!proj(v[0], v[1], v[2]) || !onScreen(PX, PY)) continue;
    const rc = (0.45 + 0.43 * Math.pow(Math.max(0, 5.9 - m), 1.12)) * zs;
    const al = clamp((lm - m) / 0.7, 0, 1) * night * clamp((lim - m) / 1.5, 0, 1);
    if (al < 0.03) continue;
    const isSel = selection?.kind === 'star' && selection.id === st.hip[i];
    queueLabel('s:' + st.hip[i], data.names.get(st.hip[i]).name, PX, PY, rc * 1.4 + 2, isSel ? 0 : 3 + m / 10, fs, `rgba(214,228,255,${0.66 * al})`, 'side', 0);
  }
}

// ---- label placement ----------------------------------------------------------
const labelQ = [], obst = [], placedR = [], widthCache = new Map();
function queueLabel(key, text, x, y, r, prio, fs, fill, mode, spacing, ref) {
  if (!queueOn) return;
  labelQ.push({ key, text, x, y, r, prio, fs, fill, mode, spacing, ref });
}
function textW(text, fs, spacing, weight) {
  const k = weight + fs + '|' + spacing + '|' + text;
  let w = widthCache.get(k);
  if (w === undefined) {
    ctx.font = `${weight} ${fs}px ${FONT}`;
    try { ctx.letterSpacing = spacing + 'px'; } catch {}
    w = ctx.measureText(text).width;
    try { ctx.letterSpacing = '0px'; } catch {}
    if (widthCache.size > 600) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}
const overlaps = (x0, y0, x1, y1, arr) => { for (let q = 0; q < arr.length; q += 4) if (x0 < arr[q + 2] && x1 > arr[q] && y0 < arr[q + 3] && y1 > arr[q + 1]) return true; return false; };
function flushLabels() {
  labelQ.sort((a, b) => a.prio - b.prio);
  placedR.length = 0; conLabelPos.length = 0;
  const done = new Set();
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  for (const L of labelQ) {
    if (done.has(L.key)) continue;
    const weight = L.prio === 0 ? 600 : 500;
    const w = textW(L.text, L.fs, L.spacing, weight) + 2, h = L.fs + 2;
    const d = L.r + 4, x = L.x, y = L.y;
    let cands;
    if (L.mode === 'center') cands = [[x - w / 2, y - h / 2], [x - w / 2, y - h * 1.5], [x - w / 2, y + h * 0.6]];
    else cands = [[x + d, y - h / 2], [x - d - w, y - h / 2], [x - w / 2, y - d - h], [x - w / 2, y + d],
      [x + d * 0.7, y - d * 0.7 - h], [x + d * 0.7, y + d * 0.7], [x - d * 0.7 - w, y - d * 0.7 - h], [x - d * 0.7 - w, y + d * 0.7]];
    let pick = null;
    for (const c of cands) {
      const x0 = c[0], y0 = c[1], x1 = x0 + w, y1 = y0 + h;
      if (x0 < 4 || x1 > W - 4 || y0 < 4 || y1 > H - 4) continue;
      if (overlaps(x0, y0, x1, y1, placedR) || overlaps(x0, y0, x1, y1, obst)) continue;
      pick = c; break;
    }
    if (!pick) continue;
    done.add(L.key);
    placedR.push(pick[0] - 1, pick[1], pick[0] + w + 1, pick[1] + h);
    ctx.font = `${weight} ${L.fs}px ${FONT}`; ctx.fillStyle = L.fill;
    try { ctx.letterSpacing = L.spacing + 'px'; } catch {}
    ctx.fillText(L.text, pick[0] + 1, pick[1] + 1);
    try { ctx.letterSpacing = '0px'; } catch {}
    if (L.ref && L.ref.segs) conLabelPos.push(L.ref, pick[0] + w / 2, pick[1] + h / 2);
  }
  ctx.textBaseline = 'middle';
}

// ---- Sun, Moon, planets ---------------------------------------------------------
const drawn = []; drawn.n = 0; // pickable bodies this frame (pooled objects): {id, x, y, r, b}
function drawBodies(ts, simNow) {
  drawn.n = 0;
  ctx.textBaseline = 'middle';
  // planets first, then Moon, then Sun on top
  const order = bodiesOrder;
  const zs = 1 + 0.18 * Math.log2(cam.zoom);
  for (const b of order) {
    // refresh position for smoothness at high playback rates is covered by 15s recompute; fine at this scale
    if (b.u < -0.03) continue;
    if (!proj(b.e, b.n, b.u) || !onScreen(PX, PY, 80)) continue;
    const x = PX, y = PY;
    let vis = 1, r;
    if (b.name === 'Sun') {
      r = Math.max(7.5, S * 0.00465);
      const g = r * 9; ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = sunAlt > 0 ? 0.9 : 0.8; ctx.drawImage(sunGlow, x - g, y - g, g * 2, g * 2);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, '#fffdf2'); gr.addColorStop(0.7, '#fff3c4'); gr.addColorStop(1, '#ffd982');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    } else if (b.name === 'Moon') {
      r = Math.max(10, S * 0.0045);
      drawMoon(b, x, y, r);
    } else {
      vis = clamp((lim - b.mag + 2.6) / 2.6, 0, 1);
      if (vis <= 0.02) continue;
      r = clamp(2.1 + (2.2 - b.mag) * 0.55, 1.9, 5.2) * Math.min(zs, 1.7);
      const g = r * 5;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.65 * vis;
      ctx.drawImage(glowSprites[b.name], x - g, y - g, g * 2, g * 2);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = vis;
      ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }
    const dr = drawn[drawn.n] || (drawn[drawn.n] = { id: '', x: 0, y: 0, r: 0, b: null }); drawn.n++;
    dr.id = b.name; dr.x = x; dr.y = y; dr.r = Math.max(r, 7); dr.b = b;
    const isPl = b.name !== 'Sun' && b.name !== 'Moon';
    if (isPl && vis > 0.05) { // tiny coloured halo ring
      ctx.strokeStyle = b.color; ctx.globalAlpha = 0.55 * vis; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r + 4.5, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (queueOn) obst.push(x - r - 3, y - r - 3, x + r + 3, y + r + 3);
    const la = isPl ? 0.95 * vis : 0.9;
    let fill;
    if (isPl) { const c = b.rgb || (b.rgb = hexToRgb(b.color)); fill = sunAlt > -3 ? `rgba(${c[0] * 0.35 | 0},${c[1] * 0.35 | 0},${c[2] * 0.45 | 0},${la})` : `rgba(${lerp(c[0], 255, 0.25) | 0},${lerp(c[1], 255, 0.25) | 0},${lerp(c[2], 255, 0.25) | 0},${la})`; }
    else fill = b.name === 'Sun' ? 'rgba(255,255,255,0.92)' : (sunAlt > -3 ? 'rgba(20,40,80,0.85)' : 'rgba(235,242,255,0.9)');
    const sel = selection?.kind === 'body' && selection.id === b.name;
    queueLabel('b:' + b.name, b.name, x, y, r + 3, sel ? 0 : isPl ? 2 : 1, compact() ? 11 : 12, fill, 'side', 0);
  }
}
const compact = () => W <= 760;
const hexToRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function drawMoon(b, x, y, R) {
  // glow
  const g = R * 6; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5 * (0.25 + 0.75 * b.phaseFrac);
  ctx.drawImage(moonGlow, x - g, y - g, g * 2, g * 2);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // direction on screen toward the Sun
  const sun = bodies[0];
  let ang = 0;
  if (sun) {
    const dot = b.e * sun.e + b.n * sun.n + b.u * sun.u;
    const te = sun.e - dot * b.e, tn = sun.n - dot * b.n, tu = sun.u - dot * b.u;
    const L = Math.hypot(te, tn, tu) || 1, eps = 0.01;
    const pe = b.e + te / L * eps, pn = b.n + tn / L * eps, pu = b.u + tu / L * eps;
    if (proj(pe, pn, pu)) ang = Math.atan2(PY - y, PX - x);
  }
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  // unlit disc (earthshine)
  ctx.fillStyle = sunAlt > -3 ? 'rgba(120,140,175,0.38)' : 'rgba(54,64,86,0.92)';
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  // lit part
  const k = clamp(b.phaseFrac, 0, 1), xt = -(2 * k - 1) * R;  // terminator x at equator
  const lg = ctx.createRadialGradient(-R * 0.2, -R * 0.2, R * 0.1, 0, 0, R);
  lg.addColorStop(0, '#fbfcff'); lg.addColorStop(1, '#d6dcea');
  ctx.fillStyle = lg;
  ctx.beginPath();
  ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
  const rx = Math.max(0.01, Math.abs(xt));
  ctx.ellipse(0, 0, rx, R, 0, Math.PI / 2, -Math.PI / 2, xt > 0);
  ctx.closePath(); ctx.fill();
  // faint maria
  if (R > 11) {
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(90,100,125,0.22)';
    for (const [mx, my, mr] of [[-0.25, -0.2, 0.32], [0.2, -0.05, 0.26], [-0.05, 0.3, 0.22], [0.35, 0.28, 0.14]]) {
      ctx.beginPath(); ctx.arc(mx * R, my * R, mr * R, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

// ---- satellites -----------------------------------------------------------------
const satCounts = new Int32Array(Object.keys(state.CATEGORIES).length + 1), satPos2 = new Int32Array(Object.keys(state.CATEGORIES).length);
const satTmp = { cap: 0, order: null, x: null, y: null, ok: null };
const satPick = { n: 0, x: new Float32Array(0), y: new Float32Array(0), idx: new Int32Array(0) };
function drawSats(ts, simNow) {
  const filters = state.get('filters');
  const selId = selection?.kind === 'sat' ? selection.id : null;
  const fr = getSatFrame(simNow, filters, false, selId);
  if (fr.count === 0) { satPick.n = 0; return; }
  if (satPick.x.length < fr.count) { satPick.x = new Float32Array(fr.count + 256); satPick.y = new Float32Array(fr.count + 256); satPick.idx = new Int32Array(fr.count + 256); }
  const dayFade = 0.14 + 0.86 * clamp((lim - 1) / 3.5, 0, 1);
  const zs = 1 + 0.15 * Math.log2(cam.zoom);
  const K = CAT_KEYS.length;
  // bucket by category
  const counts = satCounts; counts.fill(0);
  for (let j = 0; j < fr.count; j++) counts[fr.cat[j] + 1]++;
  for (let c = 0; c < K; c++) counts[c + 1] += counts[c];
  if (satTmp.cap < fr.count) { satTmp.cap = fr.count + 512; satTmp.order = new Int32Array(satTmp.cap); satTmp.x = new Float32Array(satTmp.cap); satTmp.y = new Float32Array(satTmp.cap); satTmp.ok = new Uint8Array(satTmp.cap); }
  const order = satTmp.order, pos = satPos2; for (let c = 0; c < K; c++) pos[c] = counts[c];
  for (let j = 0; j < fr.count; j++) order[pos[fr.cat[j]]++] = j;
  const px = satPick.x, py = satPick.y, pidx = satPick.idx;
  let np = 0;
  const posX = satTmp.x, posY = satTmp.y, ok = satTmp.ok;
  for (let j = 0; j < fr.count; j++) {
    ok[j] = 0;
    if (proj(fr.dx[j], fr.dy[j], fr.dz[j]) && onScreen(PX, PY, 10)) { posX[j] = PX; posY[j] = PY; ok[j] = 1; }
  }
  for (let c = 0; c < K; c++) {
    const col = state.CATEGORIES[CAT_KEYS[c]];
    const size = (col.size || 1) * zs;
    const rr = (0.55 + 0.5 * size) * (compact() ? 0.72 : 1);
    ctx.fillStyle = col.color;
    for (let q = counts[c]; q < counts[c + 1]; q++) {
      const j = order[q]; if (!ok[j]) continue;
      const x = posX[j], y = posY[j];
      if (fr.lit[j]) {
        ctx.globalAlpha = c === 0 ? Math.max(0.7, dayFade) : dayFade;
        if (rr < 1.4) ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
        else { ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill(); }
        if (c === 0) { // stations get a halo
          ctx.globalAlpha = 0.25 * dayFade; ctx.beginPath(); ctx.arc(x, y, rr * 2.6, 0, TAU); ctx.fill();
        }
      } else { ctx.globalAlpha = 0.28; ctx.fillRect(x - 1, y - 1, 2, 2); }
      px[np] = x; py[np] = y; pidx[np] = j; np++;
    }
  }
  ctx.globalAlpha = 1;
  satPick.n = np; satPick.frame = fr;
  // labels for stations and selection
  ctx.font = `500 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (queueOn) for (let j = 0; j < fr.count; j++) {
    if (!ok[j]) continue;
    const id = fr.ids[fr.idx[j]];
    if (fr.cat[j] === 0 && fr.lit[j] || id === selId) {
      const s = lookupSat(id);
      queueLabel('t:' + id, s?.name || String(id), posX[j], posY[j], 5, id === selId ? 0 : 3.5, 11, `rgba(255,214,150,${dayFade * 0.95})`, 'side', 0);
    }
  }
  // selected satellite path (±10 min)
  if (selId != null) drawSelTrack(selId, simNow);
}
let getSatFn = null;
import('../data/catalog.js').then(m => { getSatFn = m.getSat; });
const lookupSat = id => (getSatFn ? getSatFn(id) : null);

function drawSelTrack(id, simNow) {
  const key = id + '|' + Math.floor(simNow / 20000);
  if (key !== selTrackKey) { selTrackKey = key; selTrack = skyTrack(id, simNow - 600000, simNow + 600000, 15); }
  if (!selTrack || selTrack.length < 2) return;
  ctx.save();
  ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]);
  for (const [from, to, a] of [[0, 1, 0.35], [1, 1, 0]]) { /* placeholder to keep structure simple */ }
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  let pen = false;
  for (const p of selTrack) {
    if (p.u > -0.01 && proj(p.e, p.n, p.u)) { if (pen) ctx.lineTo(PX, PY); else { ctx.moveTo(PX, PY); pen = true; } } else pen = false;
  }
  ctx.stroke();
  ctx.restore();
}

function drawPassArc(simNow) {
  if (sunAlt > -2) return;
  const p = passes.find(q => q.satId === 25544 && q.end > simNow);
  if (!p) return;
  const key = p.start + ':' + p.end;
  if (key !== passKey) { passKey = key; passTrack = skyTrack(25544, p.start, p.end, 10); }
  if (!passTrack || passTrack.length < 2) return;
  ctx.save();
  ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(255,179,71,0.55)';
  ctx.beginPath(); let pen = false, best = null;
  for (const q of passTrack) {
    if (q.u > 0 && proj(q.e, q.n, q.u)) {
      if (pen) ctx.lineTo(PX, PY); else { ctx.moveTo(PX, PY); pen = true; }
      if (!best || q.u > best.u) best = { u: q.u, x: PX, y: PY };
    } else pen = false;
  }
  ctx.stroke(); ctx.setLineDash([]);
  if (best && onScreen(best.x, best.y, 0)) {
    queueLabel('pass', `ISS pass ${fmtLocal(p.max, { hour: 'numeric', minute: '2-digit' })} · max ${Math.round(p.maxEl ?? Math.asin(best.u) * R2D)}°`, best.x, best.y, 2, 3.8, compact() ? 10 : 11, 'rgba(255,200,120,0.92)', 'center', 0);
  }
  ctx.restore();
}

// ---- ground, horizon, compass ----------------------------------------------------
function buildTreeline() {
  const N = 1440, pts = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const az = i / N * 360, a = az * D2R;
    let h = 0.5 + 0.3 * Math.sin(a * 5 + 1.3) + 0.2 * Math.sin(a * 13 + 0.4) + 0.14 * Math.sin(a * 37 + 2.1) + 0.1 * Math.sin(a * 91) + 0.06 * Math.sin(a * 211 + 1);
    h = Math.max(0.05, h) * 0.75;
    const v = altAzToEnu(h, az); pts[i * 3] = v[0]; pts[i * 3 + 1] = v[1]; pts[i * 3 + 2] = v[2];
  }
  treeCache = { N, pts };
}
let groundXY = null;
function drawGround(night) {
  const { N, pts } = treeCache;
  if (!groundXY || groundXY[0].length !== N) groundXY = [new Float32Array(N), new Float32Array(N)];
  const gx = groundXY[0], gy = groundXY[1];
  for (let i = 0; i < N; i++) {
    const e = pts[i * 3], n = pts[i * 3 + 1], u = pts[i * 3 + 2];
    const xc = r0 * e + r1 * n + r2 * u, yc = u0 * e + u1 * n + u2 * u, zc = f0 * e + f1 * n + f2 * u;
    const den = Math.max(1 + zc, 0.0008), k = 2 * S / den;
    gx[i] = clamp(cx + k * xc, -2e5, 2e5); gy[i] = clamp(cy - k * yc, -2e5, 2e5);
  }
  const path = () => { ctx.moveTo(gx[0], gy[0]); for (let i = 1; i < N; i++) ctx.lineTo(gx[i], gy[i]); ctx.closePath(); };
  const hz = skyColors.hz, gl = skyColors.glow;
  // horizon glow on the sky side
  ctx.save();
  ctx.lineJoin = 'round';
  const glowA = clamp(0.5 + skyColors.amt * 0.5, 0.3, 1);
  for (const [w, a] of [[30, 0.035], [16, 0.06], [7, 0.1]]) {
    ctx.lineWidth = w; ctx.strokeStyle = `rgba(${hz[0] * 0.9 + gl[0] * 0.2 | 0},${hz[1] * 0.9 + gl[1] * 0.2 | 0},${hz[2] * 0.9 + gl[2] * 0.2 | 0},${a * glowA})`;
    ctx.beginPath(); path(); ctx.stroke();
  }
  ctx.restore();
  // ground fill
  const gcol = `rgb(${2 + hz[0] * 0.07 | 0},${3 + hz[1] * 0.07 | 0},${6 + hz[2] * 0.08 | 0})`;
  ctx.fillStyle = gcol;
  ctx.beginPath(); path();
  if (cam.alt >= 0) { ctx.rect(-3000, -3000, W + 6000, H + 6000); ctx.fill('evenodd'); }
  else ctx.fill();
  // crisp horizon edge
  ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${hz[0] * 0.8 + 60 | 0},${hz[1] * 0.8 + 70 | 0},${hz[2] * 0.8 + 90 | 0},${0.18 + 0.1 * (1 - night)})`;
  ctx.beginPath(); path(); ctx.stroke();
}

const CARD = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
const INTER = [['NE', 45], ['SE', 135], ['SW', 225], ['NW', 315]];
function drawCompass() {
  const day = sunAlt > -4;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // tick marks just below the horizon
  ctx.lineWidth = 1;
  const tickCol = day ? 'rgba(235,242,255,0.55)' : 'rgba(190,210,245,0.45)';
  ctx.strokeStyle = tickCol; ctx.beginPath();
  const pxDeg = 1 / (S * D2R);
  for (let az = 0; az < 360; az += 5) {
    const len = (az % 30 === 0 ? 11 : az % 10 === 0 ? 6.5 : 3.5) * pxDeg;
    const a = altAzToEnu(-0.3 * Math.min(1, pxDeg * 4), az), b = altAzToEnu(-0.3 * Math.min(1, pxDeg * 4) - len, az);
    if (proj(a[0], a[1], a[2])) { const x0 = PX, y0 = PY; if (proj(b[0], b[1], b[2])) { ctx.moveTo(x0, y0); ctx.lineTo(PX, PY); } }
  }
  ctx.stroke();
  // degree labels every 30 (zoomed in only)
  if (cam.zoom > 1.6) {
    ctx.font = `500 10px ${FONT}`; ctx.fillStyle = 'rgba(190,210,245,0.5)';
    for (let az = 0; az < 360; az += 15) {
      if (az % 90 === 0) continue;
      const v = altAzToEnu(-3.6, az); if (proj(v[0], v[1], v[2]) && onScreen(PX, PY, 0)) ctx.fillText(az + '°', PX, PY);
    }
  }
  const alt = -(2.2 + 1.5 / Math.sqrt(cam.zoom));
  ctx.font = `600 ${cam.zoom > 3 ? 18 : 16}px ${FONT}`;
  for (const [t, az] of CARD) {
    const v = altAzToEnu(alt, az); if (!proj(v[0], v[1], v[2]) || !onScreen(PX, PY, 0)) continue;
    ctx.fillStyle = t === 'N' ? '#5ce1ff' : 'rgba(232,238,252,0.9)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6;
    ctx.fillText(t, PX, PY); ctx.shadowBlur = 0;
  }
  ctx.font = `500 11px ${FONT}`; ctx.fillStyle = 'rgba(190,210,245,0.6)';
  for (const [t, az] of INTER) {
    const v = altAzToEnu(alt + 0.2, az); if (proj(v[0], v[1], v[2]) && onScreen(PX, PY, 0)) ctx.fillText(t, PX, PY);
  }
}

// ---- selection & hover ------------------------------------------------------------
function objectEnu(kind, id, simNow) {
  if (kind === 'body' && id === 'Aurora') { const a = auroraState(); return a.vis ? altAzToEnu(Math.max(a.dirEl, 8), a.dirAz) : null; }
  if (kind === 'body') { const b = bodies.find(x => x.name === id); return b ? [b.e, b.n, b.u] : null; }
  if (kind === 'star') { const i = data.stars.byHip.get(id); if (i === undefined) return null; return applyM(F.M, data.stars.vec[i * 3], data.stars.vec[i * 3 + 1], data.stars.vec[i * 3 + 2]); }
  if (kind === 'constellation') { const c = data.consById.get(id); return c ? applyM(F.M, c.label[0], c.label[1], c.label[2]) : null; }
  if (kind === 'sat') { const p = satPosition(id, simNow); return p ? [p.e, p.n, p.u] : null; }
  return null;
}
function queueSelectionLabel(simNow) {
  if (!selection || selection.kind === 'body' || selection.kind === 'sat' || selection.kind === 'constellation') return;
  const v = objectEnu(selection.kind, selection.id, simNow);
  if (!v || v[2] < 0 || !proj(v[0], v[1], v[2]) || !onScreen(PX, PY, 0)) return;
  const nm = data.names.get(selection.id);
  queueLabel('s:' + selection.id, nm?.name || (nm?.bayer ? `${nm.bayer} ${nm.con}` : `HIP ${selection.id}`), PX, PY, 14, 0, 11, 'rgba(255,255,255,0.95)', 'side', 0);
}
function drawSelection(ts, simNow) {
  if (!selection) return;
  const v = objectEnu(selection.kind, selection.id, simNow);
  if (!v || v[2] < -0.02 || !proj(v[0], v[1], v[2]) || !onScreen(PX, PY, 40)) return;
  const t = ts / 1000;
  const still = reducedMotion();
  const r = (selection.kind === 'constellation' ? 0 : 13) + (still ? 0 : 2 * Math.sin(t * 3));
  if (selection.kind === 'constellation') return;
  ctx.save(); ctx.translate(PX, PY); ctx.rotate(still ? 0 : t * 0.8);
  ctx.strokeStyle = 'rgba(92,225,255,0.95)'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.arc(0, 0, r + (selection.kind === 'body' ? 8 : 0), 0, TAU); ctx.stroke();
  ctx.restore();
}

function pick(px, py) {
  if (!data) return null;
  let best = null, bd = 1e9;
  const consider = (kind, id, x, y, rad, pri, label, extra) => {
    const d = Math.hypot(x - px, y - py) - pri;
    if (Math.hypot(x - px, y - py) <= rad && d < bd) { bd = d; best = { kind, id, x, y, label, ...extra }; }
  };
  for (let q = 0; q < drawn.n; q++) { const o = drawn[q]; consider('body', o.id, o.x, o.y, Math.max(12, o.r + 4), 10, o.id, { body: o.b }); }
  if (opts.sats && satPick.n && satPick.frame) {
    const fr = satPick.frame;
    for (let q = 0; q < satPick.n; q++) {
      const x = satPick.x[q], y = satPick.y[q];
      if (Math.abs(x - px) > 9 || Math.abs(y - py) > 9) continue;
      const j = satPick.idx[q]; if (!fr.lit[j]) continue;
      const id = fr.ids[fr.idx[j]];
      consider('sat', id, x, y, 9, 4, lookupSat(id)?.name || String(id), { range: fr.range[j], el: Math.asin(fr.dz[j]) * R2D });
    }
  }
  for (let h = 0; h < hits.n; h++) {
    const x = hits.x[h], y = hits.y[h]; if (Math.abs(x - px) > 11 || Math.abs(y - py) > 11) continue;
    const i = hits.i[h], m = data.stars.mag[i];
    const nm = data.names.get(data.stars.hip[i]);
    consider('star', data.stars.hip[i], x, y, 11, (6 - m) * 0.6, nm?.name || (nm?.bayer ? `${nm.bayer} ${nm.con}` : `HIP ${data.stars.hip[i]}`), { mag: m });
  }
  if (!best && opts.labels) {
    for (let q = 0; q < conLabelPos.length; q += 3) {
      const c = conLabelPos[q], x = conLabelPos[q + 1], y = conLabelPos[q + 2];
      if (Math.abs(x - px) < c.name.length * 4.2 && Math.abs(y - py) < 9) { best = { kind: 'constellation', id: c.id, x, y, label: c.name }; break; }
    }
  }
  if (!best && opts.aurora && auroraState().vis) {
    const v = unproj(px, py, [0, 0, 0]);
    const a = v[2] > 0 ? auroraAt(v[0], v[1], v[2]) : null;
    if (a) best = { kind: 'body', id: 'Aurora', x: px, y: py, label: 'Aurora', aurora: a };
  }
  return best;
}

// ---- pointer input ------------------------------------------------------------------
const pointers = new Map();
let lastTap = { t: 0, x: 0, y: 0 }, downInfo = null, pinch0 = null, lastMoveT = 0;
function setupPointer() {
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId); loop.wake(800);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    tween = null; velPan.x = velPan.y = 0; velAz = 0;
    if (pointers.size === 1) { downInfo = { x: e.offsetX, y: e.offsetY, t: performance.now(), moved: 0 }; dragging = true; }
    if (pointers.size === 2) { pinch0 = { d: pinchDist(), z: zoomT }; downInfo = null; }
    hideTip();
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) { loop.wake(250); onHover(e.offsetX, e.offsetY, e); return; }
    const nx = e.offsetX, ny = e.offsetY, dx = nx - p.x, dy = ny - p.y;
    p.x = nx; p.y = ny;
    const now = performance.now(), dtm = Math.max(1, now - lastMoveT); lastMoveT = now;
    if (pointers.size === 1) {
      if (downInfo) downInfo.moved += Math.abs(dx) + Math.abs(dy);
      layout();
      if (orientOn) return;
      if (cam.alt >= 88 && cam.zoom < 1.8) {
        const a0 = Math.atan2(ny - dy - cy, nx - dx - cx), a1 = Math.atan2(ny - cy, nx - cx);
        let d = a1 - a0; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU;
        const deg = d * R2D; cam.az = ((cam.az + deg) % 360 + 360) % 360; defaultCam = false;
        velAz = lerp(velAz, deg / dtm * 1000, 0.5);
      } else {
        panPx(dx, dy);
        velPan.x = lerp(velPan.x, dx / dtm * 1000, 0.5); velPan.y = lerp(velPan.y, dy / dtm * 1000, 0.5);
      }
      canvas.style.cursor = 'grabbing';
    } else if (pointers.size === 2 && pinch0) {
      const d = pinchDist();
      zoomT = clamp(pinch0.z * d / pinch0.d, 1, 60);
      const c = pinchCenter(); zoomAnchor = c;
      cam.zoom = zoomT; // direct response while pinching
    }
  });
  const up = e => {
    const p = pointers.get(e.pointerId); if (!p) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      dragging = false; canvas.style.cursor = '';
      loop.wake(700);
      if (downInfo && downInfo.moved < 6 && performance.now() - downInfo.t < 500) onTap(e.offsetX, e.offsetY, e.pointerType);
      else if (performance.now() - lastMoveT > 90 || reducedMotion()) { velPan.x = velPan.y = 0; velAz = 0; }
      downInfo = null;
    }
    if (pointers.size < 2) pinch0 = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (!pointers.size) { hover = null; hoverCon = null; hideTip(); } });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomT = clamp(zoomT * Math.exp(-dy * 0.0016), 1, 60);
    zoomAnchor = { x: e.offsetX, y: e.offsetY }; tween = null; loop.wake(1500);
  }, { passive: false });
  canvas.addEventListener('dblclick', e => { e.preventDefault(); resetView(); });
}
const pinchDist = () => { const a = [...pointers.values()]; return Math.max(10, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)); };
const pinchCenter = () => { const a = [...pointers.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; };

function onTap(x, y, type) {
  const now = performance.now();
  if (type === 'touch' && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) { resetView(); lastTap.t = 0; return; }
  lastTap = { t: now, x, y };
  const hit = pick(x, y);
  if (hit) state.set('selection', { kind: hit.kind, id: hit.id });
  else if (state.get('selection')) state.set('selection', null);
}

function onHover(x, y, e) {
  if (e.pointerType === 'touch') return;
  const hit = pick(x, y);
  hover = hit; hoverCon = hit?.kind === 'constellation' ? hit.id : null;
  canvas.style.cursor = hit ? 'pointer' : '';
  if (!hit) { hideTip(); return; }
  let sub = '';
  if (hit.aurora) sub = hit.aurora.source === 'ovation' ? `${hit.aurora.pct}% chance (NOAA OVATION)` : `~${hit.aurora.pct}% chance (estimated from Kp forecast)`;
  else if (hit.kind === 'body' && hit.body) sub = `alt ${hit.body.alt.toFixed(0)}° · ${compass(hit.body.az)}` + (hit.id !== 'Sun' && hit.id !== 'Moon' ? ` · mag ${hit.body.mag.toFixed(1)}` : '');
  else if (hit.kind === 'star') sub = `magnitude ${hit.mag.toFixed(1)}`;
  else if (hit.kind === 'sat') sub = `alt ${hit.el.toFixed(0)}° · ${Math.round(hit.range).toLocaleString()} km`;
  else sub = 'constellation';
  tip.innerHTML = `<b></b><span></span>`;
  tip.firstChild.textContent = hit.label; tip.lastChild.textContent = sub;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.transform = `translate(${Math.min(W - tw - 8, x + 16)}px, ${Math.max(8, y - 14)}px)`;
}
function hideTip() { if (tip) tip.hidden = true; }

// ---- focus --------------------------------------------------------------------------------
function focusOn(req) {
  if (!req || !data) return;
  const simNow = clock.now();
  if (!F) F = makeFrame(simNow, state.get('location'));
  if (!bodies.length) { bodies = computeBodies(simNow, state.get('location'), F, true); bodiesTime = simNow; bodiesLoc = `${state.get('location').lat},${state.get('location').lon}`; }
  let v = objectEnu(req.kind, req.id, simNow);
  if (!v) return;
  const aa = enuToAltAz(v[0], v[1], v[2]);
  const name = req.kind === 'body' ? req.id : req.kind === 'star' ? (data.names.get(req.id)?.name || `HIP ${req.id}`) : req.kind === 'constellation' ? (data.consById.get(req.id)?.name || req.id) : 'Satellite';
  if (aa.alt < -0.5) {
    let msg = `${name} is below your horizon`;
    try {
      const loc = state.get('location');
      let key = null, bn = null;
      if (req.kind === 'body') { key = 'body:' + req.id; bn = req.id; }
      else if (req.kind === 'star') { const i = data.stars.byHip.get(req.id); defineStar(data.stars.ra[i], data.stars.dec[i]); key = 'star:' + req.id; bn = 'Star1'; }
      if (key) { const r = riseTransitSet(key, bn, loc, simNow); if (r.rise) msg += ` — rises at ${fmtTime(r.rise, simNow)}`; }
    } catch {}
    state.emit('toast', msg);
    // still turn toward the horizon in that direction
    startTween({ alt: 8, az: shortestAz(cam.az, aa.az), zoom: Math.max(1.8, cam.zoom) }, 1100);
    defaultCam = false;
    return;
  }
  const zoom = req.kind === 'constellation' ? 2.6 : req.kind === 'body' && (req.id === 'Moon' || req.id === 'Sun') ? 8 : req.kind === 'sat' ? 4 : 5;
  startTween({ alt: clamp(aa.alt, 5, 90), az: shortestAz(cam.az, aa.az), zoom }, 1300);
  defaultCam = false;
}

// ---- header ----------------------------------------------------------------------------------
let lastHeader = 0;
function updateHeader(simNow, loc) {
  const t = performance.now(); if (t - lastHeader < 500) return; lastHeader = t;
  const place = (loc.name || 'Unknown location').split(',')[0];
  const txt = `Your sky · ${place} · ${fmtLocal(simNow, { hour: 'numeric', minute: '2-digit' }, loc)} ${tzLabel(simNow, loc)} · ${twilightName(sunAlt)}`;
  if (headerEl.textContent !== txt) headerEl.textContent = txt;
  const al = opts.aurora ? auroraHeadline() : '';
  if (headerAurEl.textContent !== al) headerAurEl.textContent = al;
  headerAurEl.hidden = !al;
}

// ---- device orientation ("point phone") -------------------------------------------------------
let orientHandler = null;
async function toggleOrientation() {
  const btn = controlsEl.querySelector('.sky-orient');
  if (orientOn) {
    orientOn = false; btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
    window.removeEventListener('deviceorientationabsolute', orientHandler, true);
    window.removeEventListener('deviceorientation', orientHandler, true);
    return;
  }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { state.emit('toast', 'Motion access was not granted'); return; }
    }
  } catch { state.emit('toast', 'Could not access device motion'); return; }
  orientOn = true; btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
  tween = null; zoomT = Math.max(zoomT, 2.2);
  let got = false;
  orientHandler = ev => {
    let alpha = ev.alpha, beta = ev.beta, gamma = ev.gamma;
    if (ev.webkitCompassHeading != null) alpha = 360 - ev.webkitCompassHeading;
    if (alpha == null || beta == null || gamma == null) return;
    got = true;
    const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
    const E = -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a);
    const N = -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a);
    const U = -Math.cos(g) * Math.cos(b);
    const alt = Math.asin(clamp(U, -1, 1)) * R2D;
    let az = Math.atan2(E, N) * R2D;
    if (alt > 75) { const tE = -Math.cos(b) * Math.sin(a), tN = Math.cos(b) * Math.cos(a); az = Math.atan2(-tE, -tN) * R2D; }
    az = (az + 360) % 360;
    cam.alt = lerp(cam.alt, clamp(alt, -12, 90), 0.25);
    cam.az = ((shortestAz(cam.az, az) * 0.75 + cam.az * 0.25) % 360 + 360) % 360;
    defaultCam = false;
  };
  window.addEventListener('deviceorientationabsolute', orientHandler, true);
  window.addEventListener('deviceorientation', orientHandler, true);
  setTimeout(() => { if (!got && orientOn) { state.emit('toast', 'No motion sensor data available'); toggleOrientation(); } }, 2500);
}
