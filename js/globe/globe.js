// Orbit view: Earth-fixed 3D globe with the live satellite swarm.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as state from '../state.js';
import { CATEGORIES } from '../state.js';
import { now, getRate } from '../clock.js';
import { loadCatalog, allSats, getSat, satrec } from '../data/catalog.js';
import { onTick, requestTick, getTickIntervalMs } from '../data/propagator.js';
import { createLoop, onVisibility, isHidden, reducedMotion, QualityGovernor } from '../util/governor.js';
import { latLonToVec } from './coords.js';
import { createEarth } from './earth.js';
import { SatLayer } from './sats.js';
import { SelectedPath, ObserverMarker, makeGraticule, makeRingMarker } from './overlays.js';
import { registerSatDetail } from './detail.js';
import * as coords from './coords.js';
import { attachGlobe, updateLayers, pickLayers } from './plugins.js';

const ISS_ID = 25544;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

// ---- quality tiers (adaptive): pixel ratio, then the cloud shell. ?quality=high pins the top tier. ----
const DEVICE_DPR = Math.min(window.devicePixelRatio || 1, 2);
const PIN_QUALITY = /[?&]quality=(high|max)/.test(location.search);
const TIERS = [];                         // { dpr, clouds }
for (const d of [DEVICE_DPR, 1.5, 1]) if (d <= DEVICE_DPR + 1e-6 && !TIERS.some(t => t.dpr === d)) TIERS.push({ dpr: d, clouds: true });
TIERS.push({ dpr: TIERS[TIERS.length - 1].dpr, clouds: false });

// ---- software rendering (no usable GPU) ----
// Some machines render WebGL on the CPU (GPU blocklisted, VMs, remote desktops, hardware acceleration off).
// There a single frame can take ~250 ms and freeze the page, so we render a reduced-resolution globe without
// clouds, skip the intro flight, and redraw about once a second when nothing is moving. Satellites drift
// under a pixel per second at 1x anyway. ?quality=high opts out.
const SOFTWARE_GL_RE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;
function detectSoftwareGL(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return SOFTWARE_GL_RE.test(String(name || ''));
  } catch { return false; }
}

export async function init() {
  const host = document.getElementById('view-globe');
  if (!host) return;

  // ---------- renderer / scene / camera ----------
  const canvas = document.createElement('canvas');
  canvas.className = 'globe-canvas';
  host.append(canvas);
  let renderer;
  try {
    // MSAA is invisible (and expensive) on hi-dpi targets; the globe limb is shader-smoothed anyway.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: (window.devicePixelRatio || 1) < 2, powerPreference: 'high-performance', alpha: false });
  } catch (e) {
    canvas.remove();
    const msg = el('div', 'globe-fallback', host);
    msg.textContent = 'The 3D orbit view needs WebGL, which is unavailable in this browser. The sky view still works.';
    throw e;
  }
  const softwareGL = !PIN_QUALITY && detectSoftwareGL(renderer);
  if (softwareGL) {
    TIERS.length = 0;
    TIERS.push({ dpr: 0.6, clouds: false });
    console.info('[globe] software WebGL detected: low-power rendering');
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x03050a, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.enablePan = false; controls.minDistance = 1.12; controls.maxDistance = 14;
  controls.zoomSpeed = 0.7;
  // Created up front (frame/idleInterval are hoisted function declarations) so nothing can reach it before it exists.
  let interacting = false;   // declared before the loop so its interval callbacks can read it
  const loop = createLoop(frame, { interval: idleInterval, minInterval: () => (softwareGL ? (interacting ? 66 : 400) : 0) });

  renderer.userData = { ...(renderer.userData || {}), softwareGL };
  const earth = await createEarth(renderer);   // loads textures
  scene.add(earth.root);

  const sats = new SatLayer();
  scene.add(sats.points);
  const path = new SelectedPath();
  scene.add(path.group);
  const observer = new ObserverMarker();
  scene.add(observer.group);
  const graticule = makeGraticule();
  scene.add(graticule);
  const selMarker = makeRingMarker('#7fe6ff', 54, true);
  const issMarker = makeRingMarker('#ffb347', 26, false);
  const hoverMarker = makeRingMarker('#ffffff', 22, false);
  scene.add(selMarker, issMarker, hoverMarker);

  // ---------- DOM chrome ----------
  const tip = el('div', 'globe-tip', host);
  const labelPool = [];
  const selLabel = el('div', 'globe-label sel', host);
  const vignette = el('div', 'globe-vignette', host);
  const ctl = el('div', 'globe-controls glass', host);
  const btnHome = el('button', 'globe-btn', ctl);
  btnHome.title = 'Fly to my location';
  btnHome.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg><span>My location</span>';
  const btnGrid = el('button', 'globe-btn', ctl);
  btnGrid.title = 'Toggle lat/long grid';
  btnGrid.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg><span>Grid</span>';
  btnGrid.addEventListener('click', () => { graticule.visible = !graticule.visible; btnGrid.classList.toggle('on', graticule.visible); });

  // ---------- sizing ----------
  let W = 1, H = 1, tier = 0;
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    const dpr = TIERS[tier].dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    sats.material.uniforms.uPx.value = dpr;
    sats.material.uniforms.uScale.value = clamp(Math.min(W, H * 1.4) / 900, 0.75, 1.35);
    for (const m of [selMarker, issMarker, hoverMarker, path.footDot]) m.material.uniforms.uPx.value = dpr;
  }
  new ResizeObserver(resize).observe(host);
  window.addEventListener('resize', resize);
  resize();

  // ---------- camera animation ----------
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const qTmp = new THREE.Quaternion(), qId = new THREE.Quaternion(), qStep = new THREE.Quaternion();
  let fly = null;
  const homeDist = () => 3.2 * Math.max(1, 0.85 / camera.aspect);
  const obsDir = () => { const l = state.get('location'); return latLonToVec(l.lat, l.lon, 1, new THREE.Vector3()); };

  /** targetFn() returns a unit-ish Vector3 (re-evaluated every frame so moving targets work). */
  function flyTo(targetFn, dist, dur = 1.6) {
    if (reducedMotion()) dur = 0.001;           // prefers-reduced-motion: jump, do not glide
    loop.wake(dur * 1000 + 300);
    fly = { t0: performance.now(), dur: dur * 1000, fromDir: camera.position.clone().normalize(),
            fromDist: camera.position.length(), toDist: dist, targetFn };
  }
  controls.addEventListener('start', () => { fly = null; });

  function stepFly(nowT) {
    if (!fly) return;
    const t = clamp((nowT - fly.t0) / fly.dur, 0, 1);
    const k = fly.ease ? fly.ease(t) : easeInOut(t);
    const to = fly.targetFn(); if (!to) { fly = null; return; }
    tmpA.copy(to).normalize();
    qTmp.setFromUnitVectors(fly.fromDir, tmpA);
    // slerp from identity to full rotation by k
    qStep.copy(qId).slerp(qTmp, k);
    tmpB.copy(fly.fromDir).applyQuaternion(qStep);
    // keep the camera from flipping over the poles
    tmpB.y = clamp(tmpB.y, -0.985, 0.985); tmpB.normalize();
    const dist = fly.fromDist + (fly.toDist - fly.fromDist) * k;
    camera.position.copy(tmpB).multiplyScalar(dist);
    if (t >= 1) fly = null;
  }

  // initial placement: far away, looking at the observer
  {
    const d = obsDir();
    const off = new THREE.Vector3().copy(d).applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.9);
    camera.position.copy(off).multiplyScalar(11);
    camera.lookAt(0, 0, 0);
  }
  let introPending = true;
  function maybeIntro() {
    if (!introPending || !state.get('catalogReady')) return;
    introPending = false;
    if (state.get('view') !== 'globe' || reducedMotion() || softwareGL) { camera.position.copy(obsDir()).multiplyScalar(homeDist()); return; }
    flyTo(obsDir, homeDist(), 4.2);
    fly.ease = easeOutQuart;
  }

  // ---------- selection / follow ----------
  let selIdx = -1, selId = null;
  let follow = null;   // { id, last: Vector3|null }
  const api = {
    isFollowing: (id) => !!follow && follow.id === id,
    toggleFollow(id) {
      if (follow && follow.id === id) { follow = null; return; }
      if (state.get('selection')?.id !== id) state.set('selection', { kind: 'sat', id });
      const i = sats.idToIndex.get(id);
      follow = { id, last: null };
      if (i !== undefined) flyTo(satTarget(id), clamp(camera.position.length(), 1.5, 2.6), 1.4);
    },
  };
  registerSatDetail(api);

  function satDir(id) {
    const i = sats.idToIndex.get(id);
    if (i === undefined || !sats.posOf(i, tmpC)) return null;
    return dirOut.copy(tmpC).normalize();
  }
  const dirOut = new THREE.Vector3(), tV = new THREE.Vector3(), tN = new THREE.Vector3();
  /** Camera target that sits ~20 deg off the orbital plane so the orbit reads as an ellipse, not an edge-on line. */
  function satTarget(id) {
    const i = sats.idToIndex.get(id);
    let side = 0;
    if (i !== undefined && sats.posOf(i, tmpC)) {
      const j = i * 3, nx = sats.next, pv = sats.prev;
      tmpA.set(nx[j] - pv[j], nx[j + 1] - pv[j + 1], nx[j + 2] - pv[j + 2]);
      tmpB.copy(tmpC).cross(tmpA);
      if (tmpB.lengthSq() > 1e-12) side = tmpB.dot(camera.position) < 0 ? -1 : 1;
    }
    const n = new THREE.Vector3();
    if (side) { n.copy(tmpB).normalize().multiplyScalar(side); }
    return () => {
      const d = satDir(id); if (!d) return null;
      if (!side) return d;
      // re-derive the normal from the current velocity so the offset follows the orbit
      const k = sats.idToIndex.get(id), j = k * 3, nx = sats.next, pv = sats.prev;
      const v = tV.set(nx[j] - pv[j], nx[j + 1] - pv[j + 1], nx[j + 2] - pv[j + 2]);
      const nn = tN.crossVectors(d, v);
      if (nn.lengthSq() < 1e-12) return d;
      nn.normalize().multiplyScalar(side * Math.sign(sats.tNext - sats.tPrev || 1));
      return d.multiplyScalar(Math.cos(0.35)).addScaledVector(nn, Math.sin(0.35)).normalize();
    };
  }

  function onSelection(sel) {
    if (sel && sel.kind === 'sat') {
      selId = sel.id;
      selIdx = sats.idToIndex.has(sel.id) ? sats.idToIndex.get(sel.id) : -1;
      if (follow && follow.id !== sel.id) follow = null;
      let rec = null; try { rec = satrec(sel.id); } catch {}
      path.set(rec);
      const sat = getSat(sel.id);
      selLabel.textContent = sat ? sat.name : '';
      selMarker.material.uniforms.uColor.value.set(sat ? (CATEGORIES[sat.cat]?.color || '#7fe6ff') : '#7fe6ff').lerp(new THREE.Color('#ffffff'), 0.35);
      if (state.get('view') === 'globe' && selIdx >= 0 && !fly) {
        const id = sel.id;
        flyTo(satTarget(id), clamp(camera.position.length(), 1.7, 3.4), 1.3);
      }
    } else {
      selId = null; selIdx = -1; follow = null; path.set(null);
      selMarker.visible = false; selLabel.style.opacity = 0;
    }
  }
  state.on('selection', onSelection);

  state.on('focus', (sel) => {
    if (!sel || state.get('view') !== 'globe') return;
    if (sel.kind === 'sat') {
      if (!sats.idToIndex.has(sel.id)) return;
      const id = sel.id;
      flyTo(satTarget(id), clamp(camera.position.length(), 1.7, 3.0), 1.5);
    } else if (sel.kind === 'latlon') {
      flyTo(() => latLonToVec(sel.lat, sel.lon), sel.dist ?? clamp(camera.position.length(), 1.6, 2.6), 1.5);
    }
  });

  state.on('filters', (f) => sats.setFilters(f));
  sats.setFilters(state.get('filters'));
  state.on('highlightsOnly', (v) => sats.setHighlightsOnly(v));
  sats.highlightsOnly = !!state.get('highlightsOnly');

  function applyLocation() { const l = state.get('location'); observer.set(l.lat, l.lon); }
  state.on('location', applyLocation);
  applyLocation();
  btnHome.addEventListener('click', () => flyTo(obsDir, Math.min(homeDist(), Math.max(camera.position.length(), 2.0)) , 1.6));

  // ---------- catalog + ticks ----------
  // The propagator hands out ticks for a slot table (tick.ids). When the catalog grows (core -> full) the table
  // changes identity: the layer is rebuilt, carrying over positions of sats it already had (matched by id).
  let needSnap = true, lastSim = now(), lastReal = performance.now(), firstSlots = true;
  function adoptSlots(ids) {
    sats.setSlots(ids, getSat);
    selIdx = selId != null && sats.idToIndex.has(selId) ? sats.idToIndex.get(selId) : -1;
    hoverIdx = -1; hasSelBox = null;
    if (firstSlots) { firstSlots = false; const sel = state.get('selection'); if (sel) onSelection(sel); }
    loop.wake(900);                                  // new dots fade in
  }
  function handleTick(tick) {
    if (tick.ids !== sats.ids) adoptSlots(tick.ids);
    const interval = Math.abs(getRate()) * getTickIntervalMs();
    const gap = Math.abs(tick.time - sats.tNext);
    const snap = needSnap || (sats.haveTick && gap > interval * 8 + 2500);
    needSnap = false;
    sats.applyTick(tick, snap);
  }
  loadCatalog().then(() => { maybeIntro(); }).catch(() => {});

  // ---------- picking ----------
  let pointer = { x: -1, y: -1, inside: false, moved: false };
  let down = null, hoverIdx = -1, lastPick = 0;
  const rect = () => canvas.getBoundingClientRect();
  canvas.addEventListener('pointermove', (e) => {
    const r = rect(); pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.inside = true; pointer.moved = true;
    loop.wake(250);
  });
  canvas.addEventListener('pointerleave', () => { pointer.inside = false; pointer.moved = true; });
  canvas.addEventListener('wheel', () => loop.wake(1200), { passive: true });
  canvas.addEventListener('pointerdown', (e) => { loop.wake(600); down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || down.btn !== 0) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 5 || dt > 600) return;
    const r = rect();
    const claimed = pickLayers(e.clientX - r.left, e.clientY - r.top);
    if (claimed) { state.set('selection', claimed); return; }
    const i = sats.pick(e.clientX - r.left, e.clientY - r.top, camera, W, H, 12);
    if (i >= 0) state.set('selection', { kind: 'sat', id: sats.list[i].id });
    else if (state.get('selection')?.kind === 'sat') state.set('selection', null);
  });
  function updateHover() {
    if (!pointer.moved) return;
    const tNow = performance.now();
    if (tNow - lastPick < 30 && !down) return;     // pick scans every sat: at most ~30 Hz
    lastPick = tNow;
    pointer.moved = false;
    if (down || !pointer.inside) { hoverIdx = -1; }
    else hoverIdx = sats.pick(pointer.x, pointer.y, camera, W, H, 10);
    if (hoverIdx >= 0) {
      const s = sats.list[hoverIdx], c = CATEGORIES[s.cat] || CATEGORIES.other;
      tip.innerHTML = `<i style="background:${c.color}"></i><b></b><span>${c.label}</span>`;
      tip.querySelector('b').textContent = s.name;
      tip.style.opacity = 1;
      canvas.style.cursor = 'pointer';
    } else { tip.style.opacity = 0; canvas.style.cursor = ''; }
  }

  // ---------- helpers for screen projection ----------
  const proj = new THREE.Vector3();
  function toScreen(p, out) {
    proj.copy(p).project(camera);
    if (proj.z > 1 || proj.z < -1) return false;
    out.x = (proj.x * 0.5 + 0.5) * W; out.y = (0.5 - proj.y * 0.5) * H; return true;
  }
  function occluded(p) {
    const c = camera.position;
    const vx = p.x - c.x, vy = p.y - c.y, vz = p.z - c.z;
    let t = -(c.x * vx + c.y * vy + c.z * vz) / (vx * vx + vy * vy + vz * vz);
    t = clamp(t, 0, 1);
    const qx = c.x + vx * t, qy = c.y + vy * t, qz = c.z + vz * t;
    return qx * qx + qy * qy + qz * qz < 0.99;
  }
  const scr = { x: 0, y: 0 };
  function place(div, p, dx = 12, dy = -4) {
    if (toScreen(p, scr) && !occluded(p)) {
      div.style.transform = `translate(${scr.x + dx}px, ${scr.y + dy}px)`;
      div.style.opacity = 1;
    } else div.style.opacity = 0;
  }
  function placeTip() {
    if (hoverIdx >= 0) {
      const x = Math.min(pointer.x + 16, W - tip.offsetWidth - 8), y = Math.max(pointer.y - 34, 8);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  // ---------- notable labels (declutter by zoom + screen collisions) ----------
  // Candidate storage is preallocated: this runs every frame while the camera moves.
  const lp = new THREE.Vector3(), lscr = { x: 0, y: 0 };
  let cX = new Float32Array(256), cY = new Float32Array(256), cI = new Int32Array(256), cP = new Uint8Array(256);
  const boxes = new Float32Array(4 * 64);
  function placeNotableLabels(dist) {
    const budget = dist > 7 ? 5 : dist > 4.5 ? 8 : dist > 3.2 ? 14 : dist > 2.2 ? 22 : 40;
    const notable = sats.notable;
    if (cX.length < notable.length) { const m = notable.length + 64; cX = new Float32Array(m); cY = new Float32Array(m); cI = new Int32Array(m); cP = new Uint8Array(m); }
    let nc = 0;
    for (let q = 0; q < notable.length; q++) {
      const i = notable[q];
      if (!sats.visible[sats.catIdx[i]] || (sats.highlightsOnly && !sats.hl[i])) continue;
      const s = sats.list[i];
      if (s.id === selId) continue;
      if (!sats.posOf(i, lp)) continue;
      if (!toScreen(lp, lscr) || lscr.x < 0 || lscr.x > W || lscr.y < 0 || lscr.y > H || occluded(lp)) continue;
      cX[nc] = lscr.x; cY[nc] = lscr.y; cI[nc] = i;
      cP[nc] = s.id === ISS_ID ? 0 : s.cat === 'stations' ? 1 : 2;     // ISS, then stations/vehicles, then the rest
      nc++;
    }
    let nb = 0;
    if (selLabel.style.opacity === '1' && hasSelBox) { boxes[0] = hasSelBox.x; boxes[1] = hasSelBox.y; boxes[2] = hasSelBox.w; boxes[3] = hasSelBox.h; nb = 1; }
    let used = 0;
    for (let pr = 0; pr < 3 && used < budget; pr++) {
      for (let c = 0; c < nc && used < budget; c++) {
        if (cP[c] !== pr) continue;
        const name = sats.list[cI[c]].notable;
        const w = name.length * 7.2 + 26, h = 16;
        const bx = cX[c] + 6, by = cY[c] - 22;
        let hit = false;
        for (let b = 0; b < nb; b++) { const o = b * 4; if (bx < boxes[o] + boxes[o + 2] && bx + w > boxes[o] && by < boxes[o + 1] + boxes[o + 3] && by + h > boxes[o + 1]) { hit = true; break; } }
        if (hit) continue;
        if (nb < 64) { const o = nb * 4; boxes[o] = bx; boxes[o + 1] = by; boxes[o + 2] = w; boxes[o + 3] = h; nb++; }
        let d = labelPool[used];
        if (!d) { d = el('div', 'globe-label', host); labelPool[used] = d; labelOp[used] = 0; }
        if (d.dataset.n !== name) { d.textContent = name; d.dataset.n = name; }
        d.classList.toggle('iss', pr === 0); d.classList.toggle('stn', pr === 1);
        d.style.transform = `translate(${cX[c] + 14}px, ${cY[c] - 26}px)`;
        if (labelOp[used] !== 1) { d.style.opacity = 1; labelOp[used] = 1; }
        used++;
      }
    }
    for (let k = used; k < labelPool.length; k++) if (labelOp[k] !== 0) { labelPool[k].style.opacity = 0; labelOp[k] = 0; }
  }
  const labelOp = [];
  let hasSelBox = null;

  // ---------- render loop ----------
  // Full rate (60 fps) while the camera moves, a fly-to runs, the user interacts or the sim runs fast; ~20-30 fps
  // otherwise (at 1x a satellite crosses ~0.5 px/s, and positions are interpolated per frame anyway).
  let offTick = null;
  const satPos = new THREE.Vector3(), issPos = new THREE.Vector3(), hovPos = new THREE.Vector3();
  let camMoved = false, lastLabels = 0;
  controls.addEventListener('start', () => { interacting = true; loop.wake(600); });
  controls.addEventListener('end', () => { interacting = false; loop.wake(900); });

  function busy() {
    return interacting || camMoved || !!fly || sats.fading || Math.abs(getRate()) > 10;
  }
  function idleInterval() {
    // Software GL: each frame costs ~100 ms of CPU, so idle redraws are rare (dots move only a few px in 4 s at 1x).
    if (softwareGL) return interacting ? 66 : busy() ? 400 : (Math.abs(getRate()) > 1.5 ? 1000 : 4000);
    if (busy()) return 0;
    if (Math.abs(getRate()) > 1.5 || selId != null || follow) return 33;
    return 50;
  }
  const pluginRoot = new THREE.Group(); pluginRoot.name = 'plugins'; scene.add(pluginRoot);
  attachGlobe({ THREE, scene, camera, renderer, root: pluginRoot, coords, host, requestRender: (ms = 300) => loop.wake(ms) });

  // ---------- adaptive quality ----------
  // Sustained > ~20 ms between full-rate frames steps down: pixel ratio 2 -> 1.5 -> 1, then the cloud shell.
  // It steps back up after a cooldown; a failed attempt doubles the cooldown. ?quality=high pins the top tier.
  const cloudMesh = earth.root.children.find(c => c.renderOrder === 1 && c.isMesh);
  if (cloudMesh) cloudMesh.visible = TIERS[0].clouds;
  const quality = new QualityGovernor(TIERS.length, (t) => {
    tier = t; resize();
    if (cloudMesh) cloudMesh.visible = TIERS[t].clouds;
  }, { pinned: PIN_QUALITY, name: 'globe' });

  let lastCamX = 0, lastCamY = 0, lastCamZ = 0, lastQ = 0, lastQy = 0, lastQz = 0, lastQw = 1;
  function frame(ts, dt) {
    const simMs = now();

    // time-jump detection (scrubbing, go-live, rate flips)
    const expected = lastSim + getRate() * (ts - lastReal);
    if (Math.abs(simMs - expected) > 1500 + Math.abs(getRate()) * 120) { needSnap = true; requestTick(); }
    lastSim = simMs; lastReal = ts;

    earth.update(simMs, dt);
    sats.setTime(simMs);

    // selected / ISS / hover positions
    const have = sats.n > 0;
    const hasSel = have && selIdx >= 0 && sats.posOf(selIdx, satPos);
    const issIdx = have ? sats.idToIndex.get(ISS_ID) : undefined;
    const hasIss = issIdx !== undefined && sats.posOf(issIdx, issPos);

    // camera: fly-to, then follow
    stepFly(performance.now());
    if (follow) {
      const p = follow.id === selId && hasSel ? satPos : null;
      if (p) {
        tmpA.copy(p).normalize();
        if (follow.last && !fly) { qTmp.setFromUnitVectors(follow.last, tmpA); camera.position.applyQuaternion(qTmp); }
        if (!follow.last) follow.last = new THREE.Vector3();
        follow.last.copy(tmpA);
      }
    }
    const dist = camera.position.length();
    controls.rotateSpeed = 0.18 + 0.62 * clamp((dist - 1.12) / 2.6, 0, 1);
    controls.update();
    const cp = camera.position, cq = camera.quaternion;
    const moved = Math.abs(cp.x - lastCamX) + Math.abs(cp.y - lastCamY) + Math.abs(cp.z - lastCamZ) > 2e-5 * dist
      || Math.abs(cq.x - lastQ) + Math.abs(cq.y - lastQy) + Math.abs(cq.z - lastQz) + Math.abs(cq.w - lastQw) > 2e-5;
    lastCamX = cp.x; lastCamY = cp.y; lastCamZ = cp.z; lastQ = cq.x; lastQy = cq.y; lastQz = cq.z; lastQw = cq.w;
    // follow mode drifts the camera ~1 px/s: that alone must not pin the loop at full rate
    camMoved = moved && !(follow && !fly && !interacting);
    if (camMoved) loop.wake(160);                    // let OrbitControls' damping finish at full rate

    // markers
    const tSec = ts / 1000;
    selMarker.visible = !!hasSel;
    if (hasSel) {
      const a = selMarker.geometry.attributes.position; a.array[0] = satPos.x; a.array[1] = satPos.y; a.array[2] = satPos.z;
      a.needsUpdate = true;
      selMarker.material.uniforms.uTime.value = reducedMotion() ? 0.3 : tSec;
    }
    issMarker.visible = !!hasIss && !(hasSel && selId === ISS_ID);
    if (hasIss) {
      const a = issMarker.geometry.attributes.position; a.array[0] = issPos.x; a.array[1] = issPos.y; a.array[2] = issPos.z;
      a.needsUpdate = true;
    }
    if (hoverIdx >= 0 && sats.posOf(hoverIdx, hovPos)) {
      hoverMarker.visible = true;
      const a = hoverMarker.geometry.attributes.position; a.array[0] = hovPos.x; a.array[1] = hovPos.y; a.array[2] = hovPos.z;
      a.needsUpdate = true;
    } else hoverMarker.visible = false;

    path.update(simMs, hasSel ? satPos : null, camera, renderer.getPixelRatio());
    observer.update(reducedMotion() ? 0 : tSec, dist);

    // hover (after camera moved so the pick matches what is on screen)
    camera.updateMatrixWorld();
    updateHover();
    updateLayers(simMs, dt * 1000);
    renderer.render(scene, camera);

    // labels: DOM writes are throttled to ~5 Hz while nothing moves
    const tNow = performance.now();
    if (camMoved || fly || interacting || tNow - lastLabels > 200) {
      lastLabels = tNow;
      placeNotableLabels(dist);
      if (hasSel) { place(selLabel, satPos, 18, -26); hasSelBox = selLabel.style.opacity === '1' ? { x: scr.x + 12, y: scr.y - 30, w: selLabel.textContent.length * 8 + 26, h: 18 } : null; }
      else { selLabel.style.opacity = 0; hasSelBox = null; }
    }
    placeTip();
    quality.sample(ts, busy());
  }

  function start() {
    if (loop.running || isHidden()) return;
    lastSim = now(); lastReal = performance.now(); needSnap = true; quality.reset();
    offTick = onTick(handleTick);
    loop.start();
  }
  function stop() {
    loop.stop();
    if (offTick) { offTick(); offTick = null; }
  }
  let hideTimer = 0;
  state.on('view', (v) => {
    clearTimeout(hideTimer);
    if (v === 'globe') start();
    else hideTimer = setTimeout(() => { if (state.get('view') !== 'globe') stop(); }, 700);
  });
  // Hidden tab: no rAF, no worker ticks. Resume (with a position snap) when it is visible again.
  onVisibility((hidden) => {
    if (hidden) stop();
    else if (state.get('view') === 'globe') start();
  });
  if (state.get('view') === 'globe') start();
  maybeIntro();

  // handy for tests / debugging
  window.__globe = { THREE, scene, camera, controls, sats, path, renderer, flyTo, api, earth, loop, get fly() { return fly; }, get tier() { return tier; }, quality, obsDir };
}

function el(tag, cls, parent) {
  const e = document.createElement(tag); e.className = cls; if (parent) parent.append(e); return e;
}
