// System view: the Solar System, live. Real heliocentric positions from astronomy-engine for the shared sim clock,
// orbit lines, textured planets, deep-space spacecraft (JPL Horizons data baked into data/spacecraft.json),
// a compressed / real-distance scale toggle and a fly-to camera. Lazy: main.js imports this on first open.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as state from '../state.js';
import { now, getRate, setTime, setRate, goLive } from '../clock.js';
import { fmtLocal } from '../util/time.js';
import { createLoop, onVisibility, isHidden, reducedMotion, QualityGovernor, idle } from '../util/governor.js';
import {
  AU_KM, LIGHT_AU_S, DAY, K_COMPRESS, PLANETS, PLUTO, MOON, SUN, SUN_RC, compressedRadius, radiusReal,
  helioEcl, moonEcl, eclToScene, eqjArrToEcl, gstDeg, loadCraft, craftEcl, craftCovers, fmtLight,
} from './data.js';
import { registerSystemDetails } from './detail.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const asset = n => new URL('../../assets/textures/' + n, import.meta.url).href;

// ---- quality / software GL (same policy as the Orbit view) ----
const DEVICE_DPR = Math.min(window.devicePixelRatio || 1, 2);
const PIN_QUALITY = /[?&]quality=(high|max)/.test(location.search);
const SOFTWARE_GL_RE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;
function detectSoftwareGL(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return SOFTWARE_GL_RE.test(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '');
  } catch { return false; }
}

const SCALE_NOTE = {
  compressed: 'Distances compressed (square root), sizes enlarged: not to scale',
  real: 'Distances to scale; planets drawn larger than life until you zoom in',
};
const TIMELAPSE = [{ r: 0, label: 'Off' }, { r: 86400, label: '1 day/s' }, { r: 604800, label: '1 week/s' }, { r: 2629800, label: '1 month/s' }];

function el(tag, cls, parent, html) {
  const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; if (parent) parent.append(e); return e;
}

// ---- small canvas textures ----
function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowTex = stops => canvasTex(256, (g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
});
const sparkTex = () => canvasTex(256, (g, s) => {
  g.translate(s / 2, s / 2);
  for (let i = 0; i < 6; i++) {
    g.save(); g.rotate(i * Math.PI / 3 + 0.3);
    const gr = g.createLinearGradient(0, 0, s / 2, 0); gr.addColorStop(0, 'rgba(255,220,160,.55)'); gr.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, -3); g.lineTo(s / 2, 0); g.lineTo(0, 3); g.closePath(); g.fill(); g.restore();
  }
});
const ringTex = () => canvasTex(64, (g, s) => { g.strokeStyle = '#fff'; g.lineWidth = 3.2; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 5, 0, 7); g.stroke(); });
const dotRingTex = () => canvasTex(64, (g, s) => {
  g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 2; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 6, 0, 7); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.arc(s / 2, s / 2, 3, 0, 7); g.fill();
});
const diamondTex = () => canvasTex(64, (g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  g.strokeStyle = '#fff'; g.fillStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 3.5; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(s / 2, 14); g.lineTo(s - 14, s / 2); g.lineTo(s / 2, s - 14); g.lineTo(14, s / 2); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(s / 2, s / 2, 4, 0, 7); g.fill();
});

// ---- atmosphere rim (screen-space, depth-log aware) ----
function atmosphereMaterial(def, shell) {
  const a = def.atm;
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    uniforms: { uColor: { value: new THREE.Color(a.c[0], a.c[1], a.c[2]) }, uI: { value: a.i }, uK: { value: a.k }, uShell: { value: shell }, uSun: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uShell;
      varying vec3 vP; varying vec3 vC; varying float vR;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vP = mv.xyz; vC = modelViewMatrix[3].xyz; vR = length(modelViewMatrix[0].xyz) / uShell;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor; uniform float uI; uniform float uK; uniform vec3 uSun;
      varying vec3 vP; varying vec3 vC; varying float vR;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 r = normalize(vP);
        float t = dot(r, vC);
        vec3 q = r * t - vC;                       // closest approach, relative to the centre
        float rho = length(q) / vR;                // 1 = limb
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        float lit = smoothstep(-0.35, 0.55, dot(normalize(q), sunV));
        float inside = pow(1.0 - sqrt(max(0.0, 1.0 - rho * rho)), 2.2);
        float outside = exp(-(rho - 1.0) / uK);
        float g = (rho < 1.0 ? inside : outside) * lit * uI;
        gl_FragColor = vec4(uColor * g, g);
      }`,
  });
}

export async function init() {
  const host = document.getElementById('view-system');
  if (!host) return;
  if (!document.querySelector('link[data-system-css]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('../../css/system.css', import.meta.url).href; l.dataset.systemCss = '';
    document.head.append(l);
  }
  registerSystemDetails();

  // ---------- renderer / scene / camera ----------
  const canvas = el('canvas', 'sys-canvas', host);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: DEVICE_DPR < 2, powerPreference: 'high-performance', alpha: false, logarithmicDepthBuffer: true });
  } catch (e) {
    canvas.remove();
    el('div', 'sys-fallback', host).textContent = 'The Solar System view needs WebGL, which is unavailable in this browser.';
    throw e;
  }
  const softwareGL = !PIN_QUALITY && detectSoftwareGL(renderer);
  const TIERS = [];
  if (softwareGL) { TIERS.push({ dpr: 0.6, atm: false, seg: 40 }); console.info('[system] software WebGL detected: low-power rendering'); }
  else {
    for (const d of [DEVICE_DPR, 1.5, 1]) if (d <= DEVICE_DPR + 1e-6 && !TIERS.some(t => t.dpr === d)) TIERS.push({ dpr: d, atm: true, seg: 96 });
    TIERS.push({ dpr: TIERS[TIERS.length - 1].dpr, atm: false, seg: 96 });
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x02040a, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1e-6, 1e5);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.zoomSpeed = 0.9; controls.screenSpacePanning = true;
  controls.minDistance = 1e-6; controls.maxDistance = 3000; controls.rotateSpeed = 0.7; controls.panSpeed = 0.8;

  let interacting = false;
  const loop = createLoop(frame, { interval: idleInterval, minInterval: () => (softwareGL ? (interacting ? 66 : 400) : 0) });

  const sunLight = new THREE.PointLight(0xffffff, 3.6, 0, 0);
  scene.add(sunLight, new THREE.AmbientLight(0x6b7894, 0.22));

  // ---------- state ----------
  let m = 0, mFrom = 0, mTo = 0, mT0 = 0, mDur = 1;      // scale blend: 0 compressed, 1 real
  const MDUR = 1.7;
  let tier = 0, W = 1, H = 1;
  const ents = [];            // every pickable / labelled thing
  const byKey = new Map();
  const planets = [];
  const textures = new Map();

  // ---------- background ----------
  const starsGroup = new THREE.Group(); scene.add(starsGroup);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4e4, 48, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false, fog: false }));
  sky.renderOrder = -3; starsGroup.add(sky);
  {
    const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * 6.2832, s = Math.sqrt(1 - u * u);
      pos[i * 3] = s * Math.cos(a) * 3.5e4; pos[i * 3 + 1] = u * 3.5e4; pos[i * 3 + 2] = s * Math.sin(a) * 3.5e4;
      const b = 0.25 + Math.pow(Math.random(), 4) * 0.75, tw = Math.random();
      col[i * 3] = b * (tw < 0.2 ? 1 : 0.85 + tw * 0.15); col[i * 3 + 1] = b * (0.88 + tw * 0.1); col[i * 3 + 2] = b * (tw > 0.7 ? 1 : 0.78 + tw * 0.2);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.9, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    pts.renderOrder = -2; starsGroup.add(pts);
  }
  // Milky Way map is galactic-aligned equirect; orient it into the ecliptic scene (galactic north ~ RA 192.86, Dec 27.13).
  {
    const gn = eclToScene(eqjArrToEcl(...[Math.cos(27.13 * D2R) * Math.cos(192.86 * D2R), Math.cos(27.13 * D2R) * Math.sin(192.86 * D2R), Math.sin(27.13 * D2R)]));
    const gc = eclToScene(eqjArrToEcl(...[Math.cos(-28.94 * D2R) * Math.cos(266.4 * D2R), Math.cos(-28.94 * D2R) * Math.sin(266.4 * D2R), Math.sin(-28.94 * D2R)]));
    const y = new THREE.Vector3(...gn), x = new THREE.Vector3(...gc); x.addScaledVector(y, -x.dot(y)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    sky.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }

  // ---------- ecliptic reference rings (outer solar system) ----------
  const gridDefs = [50, 100, 150];
  const gridGroup = new THREE.Group(); scene.add(gridGroup);
  const unitCircle = (() => { const n = 160, p = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const a = i / n * 6.2832; p[i * 3] = Math.cos(a); p[i * 3 + 2] = -Math.sin(a); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); return g; })();
  const gridLabels = [];
  for (const a of gridDefs) {
    const ring = new THREE.LineLoop(unitCircle, new THREE.LineBasicMaterial({ color: 0x7aa2e0, transparent: true, opacity: 0.12, depthWrite: false }));
    ring.userData.au = a; gridGroup.add(ring);
    gridLabels.push({ au: a, v: new THREE.Vector3(), el: null });
  }
  const gridRadius = (a, mm) => lerp(K_COMPRESS * Math.sqrt(a), a, mm);

  // ---------- Sun ----------
  const sunGroup = new THREE.Group(); scene.add(sunGroup);
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, TIERS[0].seg, TIERS[0].seg / 2), sunMat);
  sunGroup.add(sunMesh);
  const glowBig = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex([[0, 'rgba(255,214,140,.55)'], [.18, 'rgba(255,170,70,.30)'], [.45, 'rgba(255,120,30,.08)'], [1, 'rgba(255,100,20,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  const glowMid = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex([[0, 'rgba(255,245,215,.95)'], [.3, 'rgba(255,205,120,.45)'], [.7, 'rgba(255,150,50,.08)'], [1, 'rgba(255,120,30,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  const glowRays = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkTex(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
  glowBig.renderOrder = 3; glowMid.renderOrder = 4; glowRays.renderOrder = 4;
  sunGroup.add(glowBig, glowMid, glowRays);

  // ---------- entities ----------
  const labelLayer = el('div', 'sys-labels', host);
  function makeEnt(o) {
    const e = { pos: new THREE.Vector3(), posC: new THREE.Vector3(), posR: new THREE.Vector3(), rad: 0.1, radMode: 0.1, vis: true, sx: 0, sy: 0, px: 0, on: false, distSun: 0, distEarth: 0, ...o };
    e.key = o.kind + ':' + o.id;
    e.label = el('div', 'sys-label ' + (o.cls || ''), labelLayer); e.label.textContent = o.short || o.name; e.label.style.opacity = 0;
    ents.push(e); byKey.set(e.key, e); return e;
  }
  const sunEnt = makeEnt({ kind: 'body', id: 'Sun', name: 'Sun', cls: 'sun', color: SUN.color, prio: 0 });
  const geomCache = new Map();
  const sphereGeom = seg => geomCache.get(seg) || (geomCache.set(seg, new THREE.SphereGeometry(1, seg, seg / 2)), geomCache.get(seg));

  function buildPlanet(def, kind = 'body', extra = {}) {
    const group = new THREE.Group(); scene.add(group);
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(def.color) });
    const mesh = new THREE.Mesh(sphereGeom(TIERS[0].seg), mat); group.add(mesh);
    const e = makeEnt({ kind, id: def.id, name: def.id, cls: 'planet', color: def.color, prio: def.id === 'Earth' ? 0.5 : 1, def, group, mesh, mat, ...extra });
    if (def.atm) {
      e.atm = new THREE.Mesh(sphereGeom(48), atmosphereMaterial(def, 1.14)); e.atm.scale.setScalar(1.14); e.atm.renderOrder = 2; group.add(e.atm);
    }
    if (def.ring) {
      const [ri, ro] = def.ring.map(r => r / def.km);
      const g = new THREE.RingGeometry(ri, ro, 160, 1);
      const p = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getY(i)); uv.setXY(i, (r - ri) / (ro - ri), 0.5); }
      e.ringMat = new THREE.MeshLambertMaterial({ color: 0xcdb99a, side: THREE.DoubleSide, transparent: true, depthWrite: false, opacity: 0 });
      e.ring = new THREE.Mesh(g, e.ringMat); e.ring.renderOrder = 1; group.add(e.ring);
    }
    e.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: new THREE.Color(def.color), sizeAttenuation: false, transparent: true, depthWrite: false, opacity: 0 }));
    e.halo.scale.setScalar(0.017); e.halo.renderOrder = 6; scene.add(e.halo);
    // static pole frame (scene coords)
    if (def.pole) {
      const a = def.pole[0] * D2R, d = def.pole[1] * D2R;
      e.P = new THREE.Vector3(...eclToScene(eqjArrToEcl(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d))));
      e.Q = new THREE.Vector3(...eclToScene(eqjArrToEcl(-Math.sin(a), Math.cos(a), 0)));
      e.PxQ = new THREE.Vector3().crossVectors(e.P, e.Q);
      if (e.ring) e.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), e.P);
    }
    return e;
  }
  const haloTex = ringTex();
  for (const def of PLANETS) planets.push(buildPlanet(def, def.id === 'Earth' ? 'world' : 'body'));
  const planetById = new Map(planets.map(e => [e.id, e]));
  const plutoEnt = buildPlanet(PLUTO, 'world', { prio: 2 });
  plutoEnt.cls = 'planet dim'; plutoEnt.label.classList.add('dim');
  const earthEnt = planetById.get('Earth');
  // Moon (orbit radius exaggerated)
  const moonEnt = buildPlanet({ ...MOON, atm: null, pole: null }, 'body', { prio: 2 });
  moonEnt.label.textContent = 'Moon'; moonEnt.label.classList.add('dim');
  moonEnt.sub = 'Orbit distance exaggerated';
  const moonDir = new THREE.Vector3(1, 0, 0);
  const moonOrbit = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9aa8c4, transparent: true, opacity: 0.28, depthWrite: false }));
  moonOrbit.visible = false; scene.add(moonOrbit);

  // ---------- orbit lines (sampled once per body over one period, centred on the epoch at first open) ----------
  const orbits = new Map();
  const epoch = now();
  function sampleOrbit(e) {
    const def = e.def, N = def.period > 20000 ? 360 : def.period > 1000 ? 280 : 200, pts = new Float64Array((N + 1) * 3), tmp = [0, 0, 0], s = [0, 0, 0];
    for (let i = 0; i <= N; i++) {
      const t = epoch + (-0.5 + i / N) * def.period * DAY;
      helioEcl(def.id, t, tmp); eclToScene(tmp, s);
      pts[i * 3] = s[0]; pts[i * 3 + 1] = s[1]; pts[i * 3 + 2] = s[2];
    }
    // the epoch-centred sample starts and ends half a period away from `now`: close the loop exactly
    pts[N * 3] = pts[0]; pts[N * 3 + 1] = pts[1]; pts[N * 3 + 2] = pts[2];
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(def.color).lerp(new THREE.Color(0x8fb4ff), 0.35), transparent: true, opacity: 0.42, depthWrite: false }));
    line.renderOrder = 0; line.frustumCulled = false; scene.add(line);
    const o = { line, pts, N, mApplied: -1, ent: e }; orbits.set(def.id, o); applyOrbit(o);
  }
  function applyOrbit(o) {
    if (o.mApplied === m) return; o.mApplied = m;
    const a = o.line.geometry.attributes.position.array, p = o.pts;
    for (let i = 0; i <= o.N; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], len = Math.hypot(x, y, z) || 1, k = lerp(K_COMPRESS * Math.sqrt(len) / len, 1, m);
      a[i * 3] = x * k; a[i * 3 + 1] = y * k; a[i * 3 + 2] = z * k;
    }
    o.line.geometry.attributes.position.needsUpdate = true;
  }
  [...planets, plutoEnt].forEach((e, i) => setTimeout(() => { try { sampleOrbit(e); loop.wake(300); } catch (err) { console.warn('[system] orbit', e.id, err); } }, 60 + i * 40));
  {
    const N = 72, pts = new Float32Array(N * 3), tmp = [0, 0, 0];
    for (let i = 0; i < N; i++) { moonEcl(epoch + i / N * 27.32 * DAY, tmp); const l = Math.hypot(...tmp); pts[i * 3] = tmp[0] / l; pts[i * 3 + 1] = tmp[2] / l; pts[i * 3 + 2] = -tmp[1] / l; }
    moonOrbit.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3)); moonOrbit.visible = true; moonOrbit.frustumCulled = false;
  }

  // ---------- spacecraft ----------
  let craft = [];
  const diamond = diamondTex();
  const stalk = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.22, depthWrite: false }));
  stalk.frustumCulled = false; scene.add(stalk);
  const TRAIL_N = 31;
  loadCraft().then(list => {
    craft = list.map(c => {
      const e = makeEnt({ kind: 'craft', id: c.id, name: c.name, short: c.short || c.name, cls: 'craft', color: c.color, prio: 3, craft: c, far: false });
      e.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: diamond, color: new THREE.Color(c.color), sizeAttenuation: false, transparent: true, depthWrite: false }));
      e.marker.scale.setScalar(0.021); e.marker.renderOrder = 7; scene.add(e.marker);
      e.label.style.setProperty('--c', c.color);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
      const col = new Float32Array(TRAIL_N * 4), cc = new THREE.Color(c.color);
      for (let i = 0; i < TRAIL_N; i++) { col[i * 4] = cc.r; col[i * 4 + 1] = cc.g; col[i * 4 + 2] = cc.b; col[i * 4 + 3] = Math.pow(i / (TRAIL_N - 1), 1.6) * 0.85; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 4));
      e.trail = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      e.trail.frustumCulled = false; e.trail.renderOrder = 5; scene.add(e.trail);
      e.trailMs = -1e18; e.trailM = -1; e.trailN = 0;
      return e;
    });
    stalk.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(craft.length * 6), 3));
    loop.wake(600); needFrame = true;
    updatePositions(now());
    const sel = entFor(state.get('selection')); if (sel && sel.kind === 'craft') onSelection(state.get('selection'));
  }).catch(e => { console.warn('[system] spacecraft data', e); state.emit('toast', 'Spacecraft positions are unavailable'); });

  // ---------- selection ring ----------
  const selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotRingTex(), color: new THREE.Color(0x5ce1ff), sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false }));
  selRing.renderOrder = 20; selRing.visible = false; scene.add(selRing);

  // ---------- DOM chrome ----------
  const tip = el('div', 'sys-tip', host);
  const vignette = el('div', 'sys-vignette', host);
  const card = el('div', 'sys-card glass', host, `
    <div class="sys-row">
      <div class="sys-seg" role="group" aria-label="Distance scale">
        <button data-scale="compressed" class="on" aria-pressed="true">Compressed</button>
        <button data-scale="real" aria-pressed="false">Real distances</button>
      </div>
      <button class="sys-chip" data-act="home" title="Back to the full system">Overview</button>
      <button class="sys-chip" data-act="lapse" title="Fast-forward the clock so the planets visibly move">Time-lapse <b>Off</b></button>
    </div>
    <div class="sys-row">
      <div class="sys-jump" role="group" aria-label="Jump in time">
        <button data-j="-12">&minus;1 yr</button><button data-j="-1">&minus;1 mo</button><button data-j="0" class="today">Today</button><button data-j="1">+1 mo</button><button data-j="12">+1 yr</button>
      </div>
      <span class="sys-date mono"></span>
    </div>
    <div class="sys-fact"><i></i><span></span></div>
    <div class="sys-note"></div>`);
  const elDate = card.querySelector('.sys-date'), elFact = card.querySelector('.sys-fact span'), elNote = card.querySelector('.sys-note');
  const elLapse = card.querySelector('[data-act="lapse"] b');
  const segBtns = [...card.querySelectorAll('[data-scale]')];

  // ---------- sizing ----------
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(TIERS[tier].dpr); renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
  }
  new ResizeObserver(() => { resize(); needFrame = true; loop.wake(300); }).observe(host);
  resize();

  function applyTier() {
    const t = TIERS[tier];
    for (const e of planets) if (e.atm) e.atm.visible = t.atm;
  }

  // ---------- math helpers ----------
  const tmpV = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qId = new THREE.Quaternion();
  const mat4 = new THREE.Matrix4(), ex = [0, 0, 0], sc = [0, 0, 0];
  const UP = new THREE.Vector3(0, 1, 0);
  function compress(v, out) { const len = v.length(); return len < 1e-12 ? out.set(0, 0, 0) : out.copy(v).multiplyScalar(K_COMPRESS * Math.sqrt(len) / len); }
  const jd = ms => ms / DAY + 2440587.5 - 2451545;

  function setSpin(e, ms) {
    const def = e.def; if (!e.P) return;
    const W_ = (e.id === 'Earth' ? gstDeg(ms) - 90 : def.w0 + def.rate * jd(ms)) * D2R;
    const c = Math.cos(W_), s = Math.sin(W_);
    tmpA.copy(e.Q).multiplyScalar(c).addScaledVector(e.PxQ, s);          // prime meridian
    tmpB.crossVectors(tmpA, e.P);                                          // z = x cross y
    mat4.makeBasis(tmpA, e.P, tmpB); e.mesh.quaternion.setFromRotationMatrix(mat4);
  }

  // ---------- per-frame world update ----------
  function updatePositions(ms) {
    // Sun
    sunEnt.posR.set(0, 0, 0); sunEnt.posC.set(0, 0, 0); sunEnt.pos.set(0, 0, 0); sunEnt.distSun = 0;
    for (const e of [...planets, plutoEnt]) {
      helioEcl(e.id, ms, ex); eclToScene(ex, sc);
      e.posR.set(sc[0], sc[1], sc[2]); compress(e.posR, e.posC);
      e.pos.lerpVectors(e.posC, e.posR, m);
      e.distSun = e.posR.length();
      e.radMode = lerp(compressedRadius(e.def.km), radiusReal(e.def.km), m);
      setSpin(e, ms);
    }
    // Moon
    moonEcl(ms, ex); eclToScene(ex, sc);
    moonDir.set(sc[0], sc[1], sc[2]).normalize();
    const dM = lerp(1.15, 0.035, m);
    moonEnt.posR.copy(earthEnt.posR).addScaledVector(moonDir, Math.hypot(...ex));
    moonEnt.pos.copy(earthEnt.pos).addScaledVector(moonDir, dM);
    moonEnt.moonOff = dM;
    moonEnt.distEarth = Math.hypot(...ex); moonEnt.distSun = moonEnt.posR.length();
    moonEnt.radMode = lerp(compressedRadius(MOON.km) * 0.85, radiusReal(MOON.km), m);
    // tidally locked: the texture's centre (lon 0) faces Earth
    tmpA.copy(moonDir).negate();
    tmpB.crossVectors(tmpA, UP).normalize();
    tmpV.crossVectors(tmpB, tmpA).normalize();
    mat4.makeBasis(tmpA, tmpV, tmpB); moonEnt.mesh.quaternion.setFromRotationMatrix(mat4);
    moonOrbit.position.copy(earthEnt.pos); moonOrbit.scale.setScalar(dM);
    sunEnt.radMode = lerp(SUN_RC, radiusReal(SUN.km), m);
    // Spacecraft
    for (const e of craft) {
      const c = e.craft, p = craftEcl(c, ms, ex);
      e.vis = !!p;
      if (!p) continue;
      eclToScene(ex, sc); e.posR.set(sc[0], sc[1], sc[2]);
      e.distSun = e.posR.length(); e.distEarth = e.posR.distanceTo(earthEnt.posR);
      compress(e.posR, e.posC);
      // Close to a planet the compressed positions would sit inside its (enlarged) sphere: hang the craft off it instead.
      let best = null, bd = 1e9;
      for (const q of planets) { const d = q.posR.distanceTo(e.posR); if (d < bd) { bd = d; best = q; } }
      const w = smooth(0.12, 0.04, bd) * (1 - m);
      e.anchored = w;
      if (w > 0 && best) {
        tmpV.copy(e.posR).sub(best.posR).normalize().multiplyScalar(compressedRadius(best.def.km) * 1.7 + bd * 60).add(best.posC);
        e.posC.lerp(tmpV, w);
      }
      e.pos.lerpVectors(e.posC, e.posR, m);
      e.far = e.distSun > 8;
    }
    // stalks + trails
    if (craft.length) {
      const a = stalk.geometry.attributes.position.array;
      craft.forEach((e, i) => {
        const o = i * 6;
        if (e.vis && !(e.anchored > 0.05)) { a[o] = e.pos.x; a[o + 1] = e.pos.y; a[o + 2] = e.pos.z; a[o + 3] = e.pos.x; a[o + 4] = 0; a[o + 5] = e.pos.z; }
        else a[o] = a[o + 1] = a[o + 2] = a[o + 3] = a[o + 4] = a[o + 5] = 0;
      });
      stalk.geometry.attributes.position.needsUpdate = true;
      for (const e of craft) updateTrail(e, ms);
    }
  }
  function updateTrail(e, ms) {
    const show = e.vis && !(e.anchored > 0.02);
    e.trail.visible = show;
    if (!show) return;
    if (Math.abs(ms - e.trailMs) < 3.6e6 && e.trailM === m) return;
    e.trailMs = ms; e.trailM = m;
    const a = e.trail.geometry.attributes.position.array, c = e.craft;
    let first = TRAIL_N;
    for (let i = 0; i < TRAIL_N; i++) {
      const t = i === TRAIL_N - 1 ? ms : ms - (TRAIL_N - 1 - i) * DAY;
      const p = craftEcl(c, t, ex); if (!p) continue;
      if (i < first) first = i;
      eclToScene(ex, sc); tmpV.set(sc[0], sc[1], sc[2]); compress(tmpV, tmpA);
      tmpA.lerp(tmpV, m);
      a[i * 3] = tmpA.x; a[i * 3 + 1] = tmpA.y; a[i * 3 + 2] = tmpA.z;
    }
    for (let i = 0; i < first && first < TRAIL_N; i++) { a[i * 3] = a[first * 3]; a[i * 3 + 1] = a[first * 3 + 1]; a[i * 3 + 2] = a[first * 3 + 2]; }
    e.trail.geometry.attributes.position.needsUpdate = true;
    e.trail.geometry.computeBoundingSphere();
  }

  // apply sizes after the camera has moved
  const FLOOR = 0.0021;           // minimum on-screen radius as a fraction of camera distance (~4 px)
  function applySizes(tSec) {
    const cam = camera.position;
    for (const e of [sunEnt, ...planets, plutoEnt, moonEnt]) {
      const d = cam.distanceTo(e.pos);
      e.rad = Math.max(e.radMode, d * FLOOR * (e === sunEnt ? 2.4 : 1));
      e.px = e.rad * H / (0.8284 * Math.max(d, 1e-12));
      if (e === sunEnt) continue;
      e.group.position.copy(e.pos); e.group.scale.setScalar(e.rad);
      e.halo.position.copy(e.pos);
      e.halo.material.opacity = clamp(1 - e.px / 7, 0, 1) * 0.85;
      e.halo.visible = e.halo.material.opacity > 0.01;
      if (e.atm) { e.atm.material.uniforms.uSun.value.copy(e.pos).negate().normalize(); }
      if (e.ring) e.ringMat.opacity = e.ringMat.userData.ready ? 1 : 0;
    }
    sunGroup.scale.setScalar(sunEnt.rad);
    const pulse = reducedMotion() ? 1 : 1 + 0.025 * Math.sin(tSec * 0.7) + 0.012 * Math.sin(tSec * 1.9 + 1);
    glowBig.scale.setScalar(9.5 * pulse); glowMid.scale.setScalar(4.1 * (2 - pulse)); glowRays.scale.setScalar(7.5 * pulse);
    glowRays.material.rotation = reducedMotion() ? 0.3 : tSec * 0.012;
    sunLight.position.set(0, 0, 0);
    for (const e of craft) {
      e.marker.visible = e.vis; e.marker.position.copy(e.pos);
      const d = cam.distanceTo(e.pos); e.px = 0; e.rad = d * 0.01;
    }
    for (const o of orbits.values()) { applyOrbit(o); }
    const ordHide = m > 0.5 ? 0.18 : 0.42;
    for (const o of orbits.values()) o.line.material.opacity = o.ent === selEnt ? 0.9 : ordHide + (o.ent === plutoEnt ? -0.12 : 0);
    moonOrbit.material.opacity = selEnt === moonEnt || selEnt === earthEnt ? 0.5 : 0.22;
    gridGroup.children.forEach(r => r.scale.setScalar(gridRadius(r.userData.au, m)));
    // sky follows the camera
    starsGroup.position.copy(cam);
  }

  // ---------- scale toggle ----------
  function setScale(mode, animate = true) {
    const to = mode === 'real' ? 1 : 0;
    segBtns.forEach(b => { const on = b.dataset.scale === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    elNote.textContent = SCALE_NOTE[mode];
    if (to === mTo) return;
    mFrom = m; mTo = to; mT0 = performance.now(); mDur = (animate && !reducedMotion()) ? MDUR : 0.001;
    // re-frame so the camera distance follows the change of scale
    flyTo(selEnt || homeEnt, MDUR);
    loop.wake(mDur * 1000 + 400);
  }
  function stepScale(tNow) {
    if (m === mTo) return false;
    const k = clamp((tNow - mT0) / (mDur * 1000), 0, 1);
    m = lerp(mFrom, mTo, easeInOut(k)); if (k >= 1) m = mTo;
    return true;
  }

  // ---------- camera fly / follow ----------
  const homeEnt = { pos: new THREE.Vector3(), radMode: 0, isHome: true };
  const homeDir = new THREE.Vector3(-0.3, 0.52, 0.8).normalize();
  const aspectK = () => Math.max(1, 1.45 / camera.aspect);
  const homeDist = mm => lerp(112, 52, mm) * aspectK();
  let fly = null, follow = null, selEnt = null;

  function focusSpec(e, mm) {
    if (e.isHome) return { dist: homeDist(mm), dir: homeDir.clone() };
    const dir = new THREE.Vector3(), radial = e.pos.clone(); if (radial.lengthSq() < 1e-12) radial.set(1, 0, 0); radial.normalize();
    const tang = new THREE.Vector3().crossVectors(UP, radial).normalize();
    if (e === sunEnt) return { dist: lerp(SUN_RC, radiusReal(SUN.km), mm) * 4.2, dir: dir.set(0.2, 0.35, 1).normalize() };
    if (e.kind === 'craft') {
      const far = e.far;
      const dist = far ? lerp(46, 28, mm) : lerp(6, 0.06, mm);
      if (far) dir.copy(radial).multiplyScalar(0.9).addScaledVector(UP, 0.12).addScaledVector(tang, 0.28);
      else dir.copy(radial).multiplyScalar(-0.4).addScaledVector(UP, 0.3).addScaledVector(tang, 0.85);
      return { dist, dir: dir.normalize() };
    }
    const rad = e === moonEnt ? lerp(compressedRadius(MOON.km) * 0.85, radiusReal(MOON.km), mm) : lerp(compressedRadius(e.def.km), radiusReal(e.def.km), mm);
    const k = e.def?.ring ? 8.5 : e === moonEnt ? 6 : 4.6;
    dir.copy(radial).multiplyScalar(-0.78).addScaledVector(UP, e.def?.ring ? 0.42 : 0.3).addScaledVector(tang, 0.5);
    return { dist: rad * k, dir: dir.normalize() };
  }
  function flyTo(e, dur = 1.8) {
    if (!e) return;
    if (reducedMotion()) dur = 0.001;
    const spec = focusSpec(e, mTo);
    const off = tmpV.copy(camera.position).sub(controls.target);
    const fromDist = Math.max(off.length(), 1e-9);
    fly = { t0: performance.now(), dur: dur * 1000, ent: e, fromTarget: controls.target.clone(), fromDir: off.clone().normalize(), fromDist, toDist: spec.dist, toDir: spec.dir };
    follow = null;
    loop.wake(dur * 1000 + 400);
  }
  controls.addEventListener('start', () => { interacting = true; fly = null; if (!follow && selEnt) follow = { ent: selEnt, last: selEnt.pos.clone() }; loop.wake(600); });
  controls.addEventListener('end', () => { interacting = false; loop.wake(900); });

  function stepCamera(tNow) {
    if (fly) {
      const t = clamp((tNow - fly.t0) / fly.dur, 0, 1), k = easeInOut(t), target = fly.ent.pos;
      controls.target.copy(fly.fromTarget).lerp(target, k);
      qA.setFromUnitVectors(fly.fromDir, fly.toDir); qB.copy(qId).slerp(qA, k);
      const dir = tmpA.copy(fly.fromDir).applyQuaternion(qB);
      const dist = Math.exp(lerp(Math.log(fly.fromDist), Math.log(fly.toDist), k));
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      if (t >= 1) { if (!fly.ent.isHome) follow = { ent: fly.ent, last: fly.ent.pos.clone() }; fly = null; }
    } else if (follow) {
      tmpV.copy(follow.ent.pos).sub(follow.last);
      camera.position.add(tmpV); controls.target.add(tmpV); follow.last.copy(follow.ent.pos);
    }
    controls.minDistance = follow ? Math.max(1e-9, follow.ent.rad * 1.25) : 1e-9;
  }

  // ---------- selection / focus ----------
  const OURS = new Set(['body', 'craft', 'world']);
  const entFor = s => s && OURS.has(s.kind) ? byKey.get(s.kind + ':' + s.id) || null : null;
  function onSelection(s) {
    selEnt = entFor(s);
    selRing.visible = !!selEnt;
    if (selEnt && state.get('view') === 'system') flyTo(selEnt, 1.8);
    else if (!selEnt) follow = null;
    needFrame = true; loop.wake(500);
  }
  state.on('selection', onSelection);
  state.on('focus', sel => {
    if (!sel || state.get('view') !== 'system') return;
    const e = entFor(sel); if (e) flyTo(e, 1.6);
  });

  // ---------- picking / hover ----------
  const pointer = { x: -1, y: -1, inside: false, moved: false };
  let down = null, hover = null, lastPick = 0;
  const rect = () => canvas.getBoundingClientRect();
  function pickAt(x, y) {
    let best = null, bd = 1e9;
    for (const e of ents) {
      if (!e.on || e.vis === false) continue;
      const r = Math.max(e.px, e.kind === 'craft' ? 13 : 9);
      const d = Math.hypot(e.sx - x, e.sy - y);
      if (d > r + 3) continue;
      const score = d - Math.min(e.px, 40) * 0.4;       // prefer the smaller thing when two overlap (Moon on Earth)
      if (score < bd) { bd = score; best = e; }
    }
    return best;
  }
  canvas.addEventListener('pointermove', e => { const r = rect(); pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.inside = true; pointer.moved = true; loop.wake(250); });
  canvas.addEventListener('pointerleave', () => { pointer.inside = false; pointer.moved = true; loop.wake(200); });
  canvas.addEventListener('wheel', () => { loop.wake(1200); if (fly) fly = null; }, { passive: true });
  canvas.addEventListener('pointerdown', e => { loop.wake(600); down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button }; });
  canvas.addEventListener('pointerup', e => {
    if (!down || down.btn !== 0) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t; down = null;
    if (moved > 5 || dt > 600) return;
    const r = rect(), hit = pickAt(e.clientX - r.left, e.clientY - r.top);
    if (hit) state.set('selection', { kind: hit.kind, id: hit.id });
    else if (entFor(state.get('selection'))) state.set('selection', null);
  });
  function subtitleFor(e) {
    if (e.kind === 'craft') return e.craft.agency + ' · ' + (e.distSun < 100 ? e.distSun.toFixed(2) : e.distSun.toFixed(0)) + ' AU from the Sun';
    if (e === sunEnt) return 'Our star';
    if (e === moonEnt) return 'Orbit distance exaggerated';
    return (e === plutoEnt ? 'Dwarf planet · ' : 'Planet · ') + e.distSun.toFixed(2) + ' AU from the Sun';
  }
  function updateHover() {
    if (!pointer.moved) return;
    const t = performance.now(); if (t - lastPick < 30 && !down) return;
    lastPick = t; pointer.moved = false;
    hover = (down || !pointer.inside) ? null : pickAt(pointer.x, pointer.y);
    if (hover) {
      tip.innerHTML = `<i style="background:${hover.color}"></i><b></b><span></span>`;
      tip.querySelector('b').textContent = hover.name; tip.querySelector('span').textContent = subtitleFor(hover);
      tip.style.opacity = 1; canvas.style.cursor = 'pointer';
    } else { tip.style.opacity = 0; canvas.style.cursor = ''; }
  }
  function placeTip() {
    if (!hover) return;
    const x = Math.min(pointer.x + 16, W - tip.offsetWidth - 8), y = Math.max(pointer.y - 36, 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  // ---------- projection + labels ----------
  const proj = new THREE.Vector3();
  function project(e) {
    proj.copy(e.pos).project(camera);
    e.on = proj.z > -1 && proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05;
    e.sx = (proj.x * 0.5 + 0.5) * W; e.sy = (0.5 - proj.y * 0.5) * H;
  }
  const boxes = [];
  function placeLabels() {
    for (const e of ents) project(e);
    const sel = state.get('selection');
    const order = ents.filter(e => e.on && e.vis !== false).sort((a, b) => (prioOf(a) - prioOf(b)));
    boxes.length = 0;
    // keep-out boxes for the planet disks of big things so labels are not hidden on top of the Sun
    let used = 0;
    const shown = new Set();
    for (const e of order) {
      const w = e.label.textContent.length * 7.3 + 22, h = 16;
      const x = e.sx + Math.max(e.px * (e.def?.ring ? 2.3 : 1), e.kind === 'craft' ? (e === selEnt ? 16 : 6) : 3) + 8, y = e.sy - 9;
      // keep clear of the right panel / left panel is not needed: labels only ever sit over the canvas
      if (x < 4 || x + w > W - 4 || y < 60 || y + h > H - 90) continue;
      let hit = false;
      for (const b of boxes) if (x < b[0] + b[2] + 3 && x + w + 3 > b[0] && y < b[1] + b[3] && y + h > b[1]) { hit = true; break; }
      if (hit && !(e === selEnt || e === hover)) continue;
      boxes.push([x, y, w, h]); shown.add(e);
      e.label.style.transform = `translate(${x}px, ${y}px)`;
      e.label.classList.toggle('sel', e === selEnt);
      if (e.label.style.opacity !== '1') e.label.style.opacity = 1;
      used++;
    }
    for (const e of ents) if (!shown.has(e) && e.label.style.opacity !== '0') e.label.style.opacity = 0;
    // reference ring labels
    gridLabels.forEach((g, i) => {
      if (!g.el) { g.el = el('div', 'sys-label grid', labelLayer, g.au + ' AU'); g.el.style.opacity = 0; }
      g.v.set(gridRadius(g.au, m), 0, 0).project(camera);
      const x = (g.v.x * 0.5 + 0.5) * W + 4, y = (0.5 - g.v.y * 0.5) * H - 8, ok = g.v.z > -1 && g.v.z < 1 && x > 8 && x < W - 60 && y > 60 && y < H - 100;
      let hit = false;
      if (ok) for (const b of boxes) if (x < b[0] + b[2] && x + 44 > b[0] && y < b[1] + b[3] && y + 14 > b[1]) { hit = true; break; }
      g.el.style.transform = `translate(${x}px, ${y}px)`; g.el.style.opacity = ok && !hit ? 1 : 0;
    });
    // selection ring
    if (selEnt && selEnt.on) {
      selRing.visible = selEnt.px < 26; selRing.position.copy(selEnt.pos);
      selRing.scale.setScalar(Math.max(0.04, (selEnt.px * 2 + 16) / H));
    } else selRing.visible = false;
  }
  function prioOf(e) {
    if (e === selEnt) return -2; if (e === hover) return -1;
    return e.prio;
  }

  // ---------- card ----------
  let lastCard = 0;
  function updateCard(simMs) {
    elDate.textContent = fmtLocal(simMs, { day: 'numeric', month: 'short', year: 'numeric' });
    const r = getRate(), tl = TIMELAPSE.findIndex(t => t.r && Math.abs(Math.abs(r) - t.r) < 1);
    elLapse.textContent = tl > 0 ? TIMELAPSE[tl].label : 'Off';
    card.querySelector('[data-act="lapse"]').classList.toggle('on', tl > 0);
    let fact;
    const e = selEnt;
    if (e && e.kind === 'craft') fact = e.vis ? `A signal from ${e.name} takes ${fmtLight(e.distEarth * LIGHT_AU_S)} to reach Earth` : `${e.name}: position not available for this date`;
    else if (e === moonEnt) fact = `Light from the Moon to Earth: ${fmtLight(moonEnt.distEarth * LIGHT_AU_S)}`;
    else if (e && e !== sunEnt && e !== earthEnt) fact = `Light from the Sun to ${e.name}: ${fmtLight(e.distSun * LIGHT_AU_S)}`;
    else fact = `Light from the Sun to Earth: ${fmtLight(earthEnt.distSun * LIGHT_AU_S)}`;
    if (elFact.textContent !== fact) elFact.textContent = fact;
  }
  function speedHint() {
    const r = getRate();
    if (Math.abs(r) < 1.5) return 'Real time: planets barely move. Jump ahead or pick a speed in the time bar.';
    const per = Math.abs(r);
    const unit = per >= 2.4e6 ? `${(per / 2.6298e6).toFixed(per % 2.6298e6 < 1 ? 0 : 1)} month` : per >= 86400 ? `${(per / 86400).toFixed(per % 86400 < 1 ? 0 : 1)} day` : per >= 3600 ? `${(per / 3600).toFixed(per % 3600 < 1 ? 0 : 1)} hour` : `${Math.round(per / 60)} min`;
    return `${r < 0 ? 'Reversed ' : ''}${per.toLocaleString('en-US')}×: 1 second = ${unit}${/^1 /.test(unit) ? '' : 's'}`;
  }

  // jumps / buttons
  const shiftMonths = (ms, n) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };
  let lapseSet = false;
  card.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.scale) { setScale(b.dataset.scale); return; }
    if (b.dataset.j != null) {
      const n = +b.dataset.j;
      if (n === 0) { goLive(); lapseSet = false; } else setTime(shiftMonths(now(), n));
      needSnapTime(); return;
    }
    if (b.dataset.act === 'home') { state.set('selection', null); follow = null; flyTo(homeEnt, 1.8); }
    if (b.dataset.act === 'lapse') {
      const r = getRate(), cur = Math.max(0, TIMELAPSE.findIndex(t => t.r && Math.abs(Math.abs(r) - t.r) < 1)), next = (cur + 1) % TIMELAPSE.length;
      setRate(TIMELAPSE[next].r || 1); lapseSet = next > 0; needSnapTime();
    }
  });
  function needSnapTime() { needFrame = true; loop.wake(900); }
  state.on('clock', () => { if (state.get('view') === 'system') { needFrame = true; loop.wake(300); } });

  // ---------- textures (progressive) ----------
  const loader = new THREE.TextureLoader();
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  function loadTex(url, srgb = true) {
    return new Promise((res, rej) => loader.load(url, t => { t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = maxAniso; res(t); }, undefined, rej));
  }
  const applyTex = {
    sun: t => { sunMat.map = t; sunMat.color.set(0xffd9a0); sunMat.needsUpdate = true; },
    moon: t => setMap(moonEnt, t),
  };
  function setMap(e, t) { e.mat.map = t; e.mat.color.set(0xffffff); e.mat.needsUpdate = true; }
  const texJobs = [
    ['sun', 'system/sun.webp'], ['Earth', 'earth-day-2k.webp'], ['Jupiter', 'system/jupiter.webp'], ['Saturn', 'system/saturn.webp'],
    ['ring', 'system/saturn-ring.webp'], ['Mars', 'system/mars.webp'], ['Venus', 'system/venus.webp'], ['Mercury', 'system/mercury.webp'],
    ['Neptune', 'system/neptune.webp'], ['Uranus', 'system/uranus.webp'], ['moon', 'system/moon.webp'], ['milky', 'milkyway-2k.webp'],
  ];
  (async function loadAll() {
    for (const [key, file] of texJobs) {
      try {
        const t = await loadTex(asset(file));
        if (key === 'sun') applyTex.sun(t);
        else if (key === 'moon') applyTex.moon(t);
        else if (key === 'ring') { const s = planetById.get('Saturn'); s.ringMat.map = t; s.ringMat.color.setRGB(3.2, 3.0, 2.7); s.ringMat.userData.ready = true; s.ringMat.needsUpdate = true; }
        else if (key === 'milky') { sky.material.map = t; sky.material.color.setScalar(1.15); sky.material.needsUpdate = true; }
        else setMap(planetById.get(key), t);
        needFrame = true; loop.wake(500);
      } catch (e) { console.warn('[system] texture', file, e); }
      await new Promise(r => idle(r, 400));
    }
  })();

  // ---------- adaptive quality ----------
  const quality = new QualityGovernor(TIERS.length, t => { tier = t; resize(); applyTier(); }, { pinned: PIN_QUALITY, name: 'system' });
  applyTier();

  // ---------- loop ----------
  let needFrame = true, camMoved = false, lastLabels = 0, lastSim = now(), lastReal = performance.now(), mAnimating = false;
  const last = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  function busy() { return interacting || camMoved || !!fly || mAnimating || Math.abs(getRate()) > 10; }
  function idleInterval() {
    if (softwareGL) return interacting ? 66 : busy() ? 400 : (Math.abs(getRate()) > 1.5 ? 1000 : 4000);
    if (busy()) return 0;
    return Math.abs(getRate()) > 1.5 ? 33 : 66;
  }
  let hintTimer = 0;
  function frame(ts) {
    const tNow = performance.now(), simMs = now();
    mAnimating = stepScale(tNow);
    updatePositions(simMs);
    stepCamera(tNow);
    controls.update();
    camera.updateMatrixWorld();
    const cp = camera.position, cq = camera.quaternion, dist = cp.distanceTo(controls.target);
    const moved = Math.abs(cp.x - last.x) + Math.abs(cp.y - last.y) + Math.abs(cp.z - last.z) > 2e-5 * dist
      || Math.abs(cq.x - last.qx) + Math.abs(cq.y - last.qy) + Math.abs(cq.z - last.qz) + Math.abs(cq.w - last.qw) > 2e-5;
    last.x = cp.x; last.y = cp.y; last.z = cp.z; last.qx = cq.x; last.qy = cq.y; last.qz = cq.z; last.qw = cq.w;
    camMoved = moved && !(follow && !fly && !interacting && !mAnimating);
    if (moved) loop.wake(160);
    applySizes(ts / 1000);
    camera.updateMatrixWorld();
    updateHover();
    renderer.render(scene, camera);
    if (camMoved || fly || interacting || mAnimating || Math.abs(getRate()) > 10 || tNow - lastLabels > 200 || needFrame) {
      lastLabels = tNow; placeLabels();
    }
    placeTip();
    if (tNow - lastCard > 400) { lastCard = tNow; updateCard(simMs); elNote.textContent = (getRate() === 1 && !lapseSet) ? SCALE_NOTE[mTo ? 'real' : 'compressed'] : SCALE_NOTE[mTo ? 'real' : 'compressed'] + ' · ' + speedHint(); }
    needFrame = false;
    quality.sample(ts, busy());
  }

  let started = false, hideTimer = 0, introDone = false;
  function start() {
    if (loop.running || isHidden()) return;
    quality.reset(); lastSim = now();
    if (!introDone) {
      introDone = true;
      updatePositions(now());
      const spec = focusSpec(homeEnt, 0);
      controls.target.set(0, 0, 0);
      const sel = entFor(state.get('selection'));
      camera.position.copy(spec.dir).multiplyScalar(spec.dist * ((reducedMotion() || softwareGL || sel) ? 1 : 1.5));
      camera.lookAt(0, 0, 0);
      selEnt = sel; selRing.visible = !!sel;
      if (sel) flyTo(sel, 2.2); else if (!reducedMotion() && !softwareGL) flyTo(homeEnt, 3.2);
    } else if (!selEnt) {
      const sel = entFor(state.get('selection')); if (sel) { selEnt = sel; flyTo(sel, 1.6); }
    }
    started = true;
    needFrame = true;
    loop.start();
  }
  function stop() {
    loop.stop();
    if (lapseSet || TIMELAPSE.some(t => t.r && Math.abs(Math.abs(getRate()) - t.r) < 1)) { setRate(1); lapseSet = false; }
  }
  state.on('view', v => {
    clearTimeout(hideTimer);
    if (v === 'system') start();
    else hideTimer = setTimeout(() => { if (state.get('view') !== 'system') stop(); }, 600);
  });
  onVisibility(hidden => {
    if (hidden) loop.stop();
    else if (state.get('view') === 'system') { quality.reset(); needFrame = true; loop.start(); }
  });
  setScale('compressed', false);
  if (state.get('view') === 'system') start();

  window.__system = { THREE, scene, camera, controls, ents, byKey, loop, renderer, quality, planets, setScale, flyTo, get m() { return m; }, get follow() { return follow; }, get fly() { return fly; }, get selEnt() { return selEnt; }, get tier() { return tier; }, homeEnt };
}
