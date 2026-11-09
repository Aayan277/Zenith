// Orbit view: Earth-fixed 3D globe with the live satellite swarm.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as state from '../state.js';
import { CATEGORIES } from '../state.js';
import { now, getRate } from '../clock.js';
import { loadCatalog, allSats, getSat, satrec } from '../data/catalog.js';
import { onTick, requestTick } from '../data/propagator.js';
import { latLonToVec } from './coords.js';
import { createEarth } from './earth.js';
import { SatLayer } from './sats.js';
import { SelectedPath, ObserverMarker, makeGraticule, makeRingMarker } from './overlays.js';
import { registerSatDetail } from './detail.js';

const ISS_ID = 25544;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

export async function init() {
  const host = document.getElementById('view-globe');
  if (!host) return;

  // ---------- renderer / scene / camera ----------
  const canvas = document.createElement('canvas');
  canvas.className = 'globe-canvas';
  host.append(canvas);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
  } catch (e) {
    canvas.remove();
    const msg = el('div', 'globe-fallback', host);
    msg.textContent = 'The 3D orbit view needs WebGL, which is unavailable in this browser. The sky view still works.';
    throw e;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x03050a, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.enablePan = false; controls.minDistance = 1.12; controls.maxDistance = 14;
  controls.zoomSpeed = 0.7;

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
  const issLabel = el('div', 'globe-label iss', host); issLabel.textContent = 'ISS';
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
  let W = 1, H = 1;
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
  const qTmp = new THREE.Quaternion();
  let fly = null;
  const homeDist = () => 3.2 * Math.max(1, 0.85 / camera.aspect);
  const obsDir = () => { const l = state.get('location'); return latLonToVec(l.lat, l.lon, 1, new THREE.Vector3()); };

  /** targetFn() returns a unit-ish Vector3 (re-evaluated every frame so moving targets work). */
  function flyTo(targetFn, dist, dur = 1.6) {
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
    const q = new THREE.Quaternion().slerp(qTmp, k);
    tmpB.copy(fly.fromDir).applyQuaternion(q);
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
    if (state.get('view') !== 'globe') { camera.position.copy(obsDir()).multiplyScalar(homeDist()); return; }
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
    return tmpC.clone().normalize();
  }
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
      const v = new THREE.Vector3(nx[j] - pv[j], nx[j + 1] - pv[j + 1], nx[j + 2] - pv[j + 2]);
      const nn = new THREE.Vector3().crossVectors(d, v);
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
    }
  });

  state.on('filters', (f) => sats.setFilters(f));
  sats.setFilters(state.get('filters'));

  function applyLocation() { const l = state.get('location'); observer.set(l.lat, l.lon); }
  state.on('location', applyLocation);
  applyLocation();
  btnHome.addEventListener('click', () => flyTo(obsDir, Math.min(homeDist(), Math.max(camera.position.length(), 2.0)) , 1.6));

  // ---------- catalog + ticks ----------
  let pendingTick = null, needSnap = true, lastSim = now(), lastReal = performance.now();
  function handleTick(tick) {
    if (!sats.n) { pendingTick = tick; return; }
    const spacing = Math.abs(getRate()) * 100;
    const gap = Math.abs(tick.time - sats.tNext);
    const snap = needSnap || (sats.haveTick && gap > spacing * 8 + 2500);
    needSnap = false;
    sats.applyTick(tick, snap);
  }
  loadCatalog().then(() => {
    sats.setCatalog(allSats());
    sats.setFilters(state.get('filters'));
    if (pendingTick) { const t = pendingTick; pendingTick = null; handleTick(t); }
    const sel = state.get('selection'); if (sel) onSelection(sel);
    maybeIntro();
  }).catch(() => {});

  // ---------- picking ----------
  let pointer = { x: -1, y: -1, inside: false, moved: false };
  let down = null, hoverIdx = -1;
  const rect = () => canvas.getBoundingClientRect();
  canvas.addEventListener('pointermove', (e) => {
    const r = rect(); pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.inside = true; pointer.moved = true;
  });
  canvas.addEventListener('pointerleave', () => { pointer.inside = false; pointer.moved = true; });
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || down.btn !== 0) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 5 || dt > 600) return;
    const r = rect();
    const i = sats.pick(e.clientX - r.left, e.clientY - r.top, camera, W, H, 12);
    if (i >= 0) state.set('selection', { kind: 'sat', id: sats.list[i].id });
    else if (state.get('selection')?.kind === 'sat') state.set('selection', null);
  });
  function updateHover() {
    if (!pointer.moved) return;
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

  // ---------- render loop ----------
  let raf = 0, offTick = null, last = performance.now(), hideTimer = 0;
  const satPos = new THREE.Vector3(), issPos = new THREE.Vector3(), hovPos = new THREE.Vector3();
  const prevFollowDir = new THREE.Vector3();

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
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

    // markers
    const tSec = ts / 1000;
    selMarker.visible = !!hasSel;
    if (hasSel) {
      selMarker.geometry.attributes.position.array.set([satPos.x, satPos.y, satPos.z]);
      selMarker.geometry.attributes.position.needsUpdate = true;
      selMarker.material.uniforms.uTime.value = tSec;
    }
    issMarker.visible = !!hasIss && !(hasSel && selId === ISS_ID);
    if (hasIss) {
      issMarker.geometry.attributes.position.array.set([issPos.x, issPos.y, issPos.z]);
      issMarker.geometry.attributes.position.needsUpdate = true;
    }
    if (hoverIdx >= 0 && sats.posOf(hoverIdx, hovPos)) {
      hoverMarker.visible = true;
      hoverMarker.geometry.attributes.position.array.set([hovPos.x, hovPos.y, hovPos.z]);
      hoverMarker.geometry.attributes.position.needsUpdate = true;
    } else hoverMarker.visible = false;

    path.update(simMs, hasSel ? satPos : null, camera, renderer.getPixelRatio());
    observer.update(tSec, dist);

    // hover (after camera moved so the pick matches what is on screen)
    camera.updateMatrixWorld();
    updateHover();
    renderer.render(scene, camera);

    // labels
    if (hasIss) place(issLabel, issPos, 14, -22); else issLabel.style.opacity = 0;
    if (hasSel && selId !== ISS_ID) place(selLabel, satPos, 18, -26); else selLabel.style.opacity = 0;
    if (hasSel && selId === ISS_ID) { /* ISS label doubles as the selection label */ }
    placeTip();
  }

  function start() {
    if (raf) return;
    clearTimeout(hideTimer);
    last = performance.now(); lastReal = last; lastSim = now(); needSnap = true;
    offTick = onTick(handleTick);
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    if (offTick) { offTick(); offTick = null; }
  }
  state.on('view', (v) => {
    if (v === 'globe') start();
    else { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (state.get('view') !== 'globe') stop(); }, 700); }
  });
  if (state.get('view') === 'globe') start();
  maybeIntro();

  // handy for tests / debugging
  window.__globe = { THREE, scene, camera, controls, sats, path, renderer, flyTo, api, earth, get fly() { return fly; }, obsDir };
}

function el(tag, cls, parent) {
  const e = document.createElement(tag); e.className = cls; if (parent) parent.append(e); return e;
}
