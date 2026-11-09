// Globe layer: launch-pad markers, a pulsing beacon + "T-2d 4h · Falcon 9" label on the next launch's pad,
// hover tooltip, click-to-select ({kind:'launch', id}) and a small camera fly-to for "Show pad".
import * as state from '../state.js';
import * as clock from '../clock.js';
import { registerGlobeLayer } from '../globe/plugins.js';
import { onLaunches, pending, store } from './data.js';
import { STATUS, short, esc, tminus, fmtLocalFull, statusOf, hasClock, fmtDay } from './util.js';
import { lsGet, lsSet } from '../ui/notify.js';

// Set to true once globe.js handles state.emit('focus', {kind:'latlon', lat, lon}) itself; the fallback fly below
// then switches off so the two do not fight over the camera.
const GLOBE_HANDLES_LATLON = false;
const KEY_ON = 'zenith:launches:globe';
const R_PAD = 1.004;

let ctx = null, THREE = null;
let points, beacon, selBeacon, pads = [], nextPad = null, selPad = null;
let labelEl, tipEl, host;
let visible = lsGet(KEY_ON, true);
let hover = null, ptr = null, lastLabel = 0, needsRebuild = true;
let fly = null;
const v = {};

export const isLaunchLayerOn = () => visible;
export function setLaunchLayerOn(on) {
  visible = !!on; lsSet(KEY_ON, visible); apply(); ctx?.requestRender(400);
  state.emit('launches:globe', visible);
}
function apply() {
  if (points) points.visible = visible && pads.length > 0;
  if (beacon) beacon.visible = visible && !!nextPad;
  if (selBeacon) selBeacon.visible = visible && !!selPad && selPad !== nextPad;
  if (!visible) { hideLabel(); hideTip(); }
}

const hexToRgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// ---- shaders ------------------------------------------------------------------------------------------------
const POINT_VS = `
  attribute vec3 aColor; attribute float aSize; attribute float aPhase;
  uniform float uPR; uniform float uTime;
  varying vec3 vColor; varying float vGlow;
  void main() {
    vColor = aColor;
    vGlow = 0.85 + 0.15 * sin(uTime * 1.6 + aPhase);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPR;
  }`;
const POINT_FS = `
  varying vec3 vColor; varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.42, 0.0, d);
    float halo = smoothstep(1.0, 0.15, d) * 0.55;
    float ring = smoothstep(0.08, 0.0, abs(d - 0.62)) * 0.9;
    vec3 col = mix(vColor, vec3(1.0), core * 0.75);
    gl_FragColor = vec4(col, clamp(core + halo + ring, 0.0, 1.0) * vGlow);
  }`;
const BEACON_VS = `varying vec2 vUv; void main() { vUv = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEACON_FS = `
  uniform float uTime; uniform vec3 uColor; uniform float uPulse;
  varying vec2 vUv;
  void main() {
    float d = length(vUv) * 2.0;
    float a = 0.0;
    for (int k = 0; k < 3; k++) {
      float ph = fract(uTime * 0.38 * uPulse + float(k) / 3.0);
      float r = 0.12 + ph * 0.88;
      a += smoothstep(0.075, 0.0, abs(d - r)) * pow(1.0 - ph, 1.4);
    }
    a *= uPulse;
    a += (1.0 - uPulse) * smoothstep(0.05, 0.0, abs(d - 0.5)) * 0.9;     // steady ring (selected pad)
    a += smoothstep(0.2, 0.0, d) * 0.6;
    if (d > 1.0) discard;
    gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
  }`;

function makeBeacon(color, pulse) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uPulse: { value: pulse } },
    vertexShader: BEACON_VS, fragmentShader: BEACON_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = 9; m.visible = false; m.frustumCulled = false;
  ctx.root.add(m);
  return m;
}
function placeBeacon(m, pad) {
  const dir = ctx.coords.latLonToVec(pad.lat, pad.lon, 1, new THREE.Vector3());
  m.position.copy(dir).multiplyScalar(R_PAD + 0.0005);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  m.userData.dir = dir;
}

// ---- model --------------------------------------------------------------------------------------------------
function buildPads() {
  const list = pending(clock.now());
  const map = new Map();
  for (const l of list) {
    const k = l.lat.toFixed(2) + ',' + l.lon.toFixed(2);
    let p = map.get(k);
    if (!p) { p = { key: k, lat: l.lat, lon: l.lon, launches: [], dir: ctx.coords.latLonToVec(l.lat, l.lon, 1, new THREE.Vector3()) }; map.set(k, p); }
    p.launches.push(l);
  }
  pads = [...map.values()];
  for (const p of pads) p.first = p.launches[0];
  pads.sort((a, b) => a.first.net - b.first.net);
  nextPad = pads[0] || null;

  if (points) { ctx.root.remove(points); points.geometry.dispose(); points.material.dispose(); points = null; }
  if (pads.length) {
    const n = pads.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), ph = new Float32Array(n);
    pads.forEach((p, i) => {
      p.dir.clone().multiplyScalar(R_PAD).toArray(pos, i * 3);
      col.set(hexToRgb(statusOf(p.first).color), i * 3);
      size[i] = p === nextPad ? 17 : 12; ph[i] = i * 1.7;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPR: { value: ctx.renderer.getPixelRatio() }, uTime: { value: 0 } },
      vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    points = new THREE.Points(g, mat); points.renderOrder = 8; points.frustumCulled = false;
    ctx.root.add(points);
  }
  if (nextPad) { placeBeacon(beacon, nextPad); beacon.material.uniforms.uColor.value.set(statusOf(nextPad.first).color); }
  syncSelection(state.get('selection'));
  apply();
  needsRebuild = false;
}

function syncSelection(sel) {
  selPad = null;
  if (sel?.kind === 'launch') selPad = pads.find(p => p.launches.some(l => l.id === sel.id)) || null;
  if (selPad && selPad !== nextPad) { placeBeacon(selBeacon, selPad); selBeacon.material.uniforms.uColor.value.set('#5ce1ff'); }
  apply();
}

// ---- DOM ----------------------------------------------------------------------------------------------------
function hideLabel() { if (labelEl) labelEl.style.opacity = 0; }
function hideTip() { if (tipEl) tipEl.style.opacity = 0; host?.classList.remove('lc-hover'); }

function project(dir, out) {
  out.copy(dir).multiplyScalar(R_PAD).project(ctx.camera);
  const w = host.clientWidth, h = host.clientHeight;
  return { x: (out.x * 0.5 + 0.5) * w, y: (-out.y * 0.5 + 0.5) * h, z: out.z };
}
const facing = dir => ctx.camera.position.dot(dir) > 1.0 + 0.02;

function updateLabel(now) {
  if (!labelEl) return;
  if (!visible || !nextPad || state.get('view') !== 'globe' || !facing(nextPad.dir)) { labelEl.style.opacity = 0; return; }
  const s = project(nextPad.dir, v.p);
  const front = Math.min(1, (ctx.camera.position.dot(nextPad.dir) - 1.02) * 6);
  const l = nextPad.first;
  if (now - lastLabel > 500) {
    lastLabel = now;
    const txt = `${l.net - now > 0 ? 'T−' + short(l.net - now) : 'T+' + short(now - l.net)} · ${l.rocket}`;
    if (labelEl.dataset.t !== txt) { labelEl.dataset.t = txt; labelEl.querySelector('span').textContent = txt; }
    labelEl.style.setProperty('--c', statusOf(l).color);
  }
  labelEl.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
  labelEl.style.opacity = front.toFixed(2);
}

function nearestPad(x, y, maxPx) {
  if (!visible || !pads.length) return null;
  let best = null, bd = maxPx * maxPx;
  for (const p of pads) {
    if (!facing(p.dir)) continue;
    const s = project(p.dir, v.p), d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function showTip(p, x, y) {
  const now = clock.now(), l = p.first, st = statusOf(l);
  const more = p.launches.length - 1;
  tipEl.innerHTML = `<i style="background:${st.color};color:${st.color}"></i><b>${esc(l.rocket)} · ${esc(l.mission)}</b>
    <span>${esc(l.location || l.pad)} · ${l.net - now > 0 ? 'T−' + short(l.net - now) : 'launching'}${more > 0 ? ` · +${more} more` : ''}</span>`;
  tipEl.style.transform = `translate(${(x + 14).toFixed(0)}px, ${(y + 14).toFixed(0)}px)`;
  tipEl.style.opacity = 1;
  host.classList.add('lc-hover');
}

function onMove(e) {
  if (!ctx || !visible) return;
  const r = host.getBoundingClientRect();
  ptr = { x: e.clientX - r.left, y: e.clientY - r.top };
  requestAnimationFrame(() => {
    if (!ptr) return;
    const p = nearestPad(ptr.x, ptr.y, 12);
    if (p && state.get('view') === 'globe') { hover = p; showTip(p, ptr.x, ptr.y); ctx.requestRender(150); }
    else if (hover) { hover = null; hideTip(); }
  });
}

// ---- camera fly (fallback until globe.js supports focus kind 'latlon') ---------------------------------------
function startFly(lat, lon, dist) {
  const to = ctx.coords.latLonToVec(lat, lon, 1, new THREE.Vector3());
  const from = ctx.camera.position.clone();
  const d0 = from.length();
  fly = { t0: performance.now(), dur: 1500, from: from.clone().normalize(), to, d0, d1: dist ?? Math.min(Math.max(d0, 1.6), 2.6) };
  ctx.requestRender(fly.dur + 200);
}
function stepFly(now) {
  if (!fly) return;
  const k = Math.min(1, (now - fly.t0) / fly.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const q = new THREE.Quaternion().setFromUnitVectors(fly.from, fly.to);
  const qi = new THREE.Quaternion().slerp(q, e);
  const dir = fly.from.clone().applyQuaternion(qi);
  ctx.camera.position.copy(dir).multiplyScalar(fly.d0 + (fly.d1 - fly.d0) * e);
  ctx.requestRender(120);
  if (k >= 1) fly = null;
}
function onFocus(sel) {
  if (!ctx || !sel) return;
  if (sel.kind === 'latlon' && !GLOBE_HANDLES_LATLON && state.get('view') === 'globe') startFly(sel.lat, sel.lon, sel.dist);
}

// ---- layer --------------------------------------------------------------------------------------------------
const layer = {
  id: 'launches',
  init(c) {
    ctx = c; THREE = c.THREE; host = c.host;
    v.p = new THREE.Vector3();
    beacon = makeBeacon('#5ce1a5', 1); selBeacon = makeBeacon('#5ce1ff', 0);
    labelEl = document.createElement('div'); labelEl.className = 'lc-label'; labelEl.innerHTML = '<i></i><span></span>';
    tipEl = document.createElement('div'); tipEl.className = 'lc-tip';
    host.append(labelEl, tipEl);
    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerleave', () => { ptr = null; hover = null; hideTip(); });
    onLaunches(() => { needsRebuild = true; ctx.requestRender(300); });
    state.on('selection', s => { syncSelection(s); ctx.requestRender(300); });
    state.on('focus', onFocus);
    if (store.loaded) buildPads();
  },
  update(c, nowMs) {
    if (needsRebuild) buildPads();
    const t = performance.now() / 1000, now = clock.now();
    for (const m of [beacon, selBeacon]) {
      if (!m.visible) continue;
      m.material.uniforms.uTime.value = t;
      const dist = ctx.camera.position.length(), s = Math.min(0.14, Math.max(0.035, 0.05 * (dist - 0.7)));
      m.scale.setScalar(s * (m === selBeacon ? 0.8 : 1));
    }
    if (points) { points.material.uniforms.uTime.value = t; points.material.uniforms.uPR.value = ctx.renderer.getPixelRatio(); }
    stepFly(performance.now());
    updateLabel(now);
    if (hover && tipEl.style.opacity === '1' && ptr) showTip(hover, ptr.x, ptr.y);
  },
  pick(c, x, y) {
    const p = nearestPad(x, y, 14);
    return p ? { kind: 'launch', id: p.first.id } : null;
  },
  dispose() {
    for (const m of [beacon, selBeacon, points]) if (m) { ctx.root.remove(m); m.geometry?.dispose(); m.material?.dispose(); }
    labelEl?.remove(); tipEl?.remove();
  },
};

export function initLaunchGlobe() { registerGlobeLayer(layer); }
export function flyToLatLon(lat, lon, dist) { state.emit('focus', { kind: 'latlon', lat, lon, dist }); }
export const _debug = () => ({ pads, nextPad, STATUS });
