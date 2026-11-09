// Globe layer: the auroral oval as two thin, additive, shimmering shells built from the OVATION probability grid.
// The grid lives in a 360x181 R8 texture; the fragment shader turns probability into a green -> teal -> magenta glow,
// fades it out on the day side, brightens it toward the limb (looking through the curtain edge-on) and animates
// ray-like shimmer. Cheap: two sphere meshes, one texture, no per-frame CPU work besides a few uniforms.
import * as state from '../state.js';
import * as clock from '../clock.js';
import { registerGlobeLayer } from '../globe/plugins.js';
import { aur, onAurora, loadOvation, GRID_W, GRID_H } from './data.js';
import { lsGet, lsSet } from '../ui/notify.js';

const KEY_ON = 'zenith:aurora:globe';
let on = lsGet(KEY_ON, true);
let ctx = null, THREE = null, group = null, tex = null, mats = [], fade = 0, hasData = false, texAt = 0;
const sun = { v: null };

export const isAuroraLayerOn = () => on;
export function setAuroraLayerOn(v) {
  on = !!v; lsSet(KEY_ON, on);
  if (group) group.visible = on && hasData;
  if (on) loadOvation().catch(() => {});
  ctx?.requestRender(500);
  state.emit('aurora:globe', on);
}

const VS = `
  varying vec3 vN; varying vec3 vView;
  void main() {
    vN = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vView = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const FS = `
  precision highp float;
  uniform sampler2D uTex; uniform vec3 uSun; uniform float uTime, uLayer, uGain, uFade;
  varying vec3 vN; varying vec3 vView;
  const float PI = 3.14159265;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    vec3 n = normalize(vN);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lon = atan(-n.z, n.x);                                   // scene mapping: z = -cos(lat) sin(lon)
    float lonDeg = degrees(lon); if (lonDeg < 0.0) lonDeg += 360.0;
    float p = texture2D(uTex, vec2((lonDeg + 0.5) / 360.0, (degrees(lat) + 90.5) / 181.0)).r * 255.0;   // percent
    float base = smoothstep(0.6, 6.0, p) * pow(clamp(p / 30.0, 0.0, 1.4), 0.85);
    if (base < 0.002) discard;
    // Curtain shimmer: thin rays stretched along latitude, drifting slowly; layers use different offsets.
    vec2 q = vec2(lon * 70.0 + sin(lat * 24.0 + uTime * 0.25 + uLayer * 3.0) * 2.5, lat * 10.0 - uTime * 0.05 + uLayer * 9.0);
    float rays = vnoise(q) * 0.6 + vnoise(q * vec2(2.7, 1.4) + 5.0) * 0.4;
    float wave = 0.86 + 0.14 * sin(uTime * 0.55 + lon * 9.0 + uLayer * 2.0);
    float I = base * (0.45 + 1.0 * rays) * wave;
    vec3 green = vec3(0.10, 0.98, 0.42), teal = vec3(0.22, 1.0, 0.76), pink = vec3(0.96, 0.28, 0.86);
    vec3 col = mix(green, teal, smoothstep(0.25, 0.75, base));
    col = mix(col, pink, smoothstep(0.62, 1.15, base) * (0.45 + 0.4 * uLayer));
    float night = smoothstep(0.14, -0.26, dot(n, uSun));
    float vis = mix(0.07, 1.0, night);
    float fres = 1.0 - clamp(dot(n, normalize(vView)), 0.0, 1.0);
    float boost = 1.0 + 2.2 * pow(fres, 2.2);
    float a = clamp(I * vis * boost * uGain * uFade, 0.0, 1.0);
    gl_FragColor = vec4(col * (0.85 + 0.5 * I), a);
  }`;

function ensureTexture() {
  if (!aur.ovation) return false;
  if (!tex) {
    tex = new THREE.DataTexture(new Uint8Array(GRID_W * GRID_H), GRID_W, GRID_H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping; tex.unpackAlignment = 1; tex.generateMipmaps = false;
    for (const m of mats) m.uniforms.uTex.value = tex;
  }
  if (texAt !== aur.ovation.at) { tex.image.data.set(aur.ovation.grid); tex.needsUpdate = true; texAt = aur.ovation.at; }
  if (!hasData) { hasData = true; fade = 0; }
  return true;
}

const layer = {
  id: 'aurora',
  init(c) {
    ctx = c; THREE = c.THREE; sun.v = new THREE.Vector3(1, 0, 0);
    group = new THREE.Group(); group.name = 'aurora'; group.visible = false;
    [[1.010, 0, 1.0], [1.022, 1, 0.55]].forEach(([r, layerIdx, gain], i) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uSun: { value: sun.v }, uTime: { value: 0 }, uLayer: { value: layerIdx }, uGain: { value: gain }, uFade: { value: 0 } },
        vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      mats.push(m);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 144, 72), m);
      mesh.renderOrder = 6 + i; mesh.frustumCulled = false;
      group.add(mesh);
    });
    ctx.root.add(group);
    const sync = () => { if (ensureTexture()) { group.visible = on; ctx.requestRender(1800); } };
    onAurora(sync); sync();
    // Fetch lazily: when idle after the globe is ready (only if the layer is on).
    if (on && !aur.ovation) (window.requestIdleCallback || setTimeout)(() => loadOvation().catch(() => {}), { timeout: 5000 });
  },
  update(c, nowMs) {
    if (!group || !group.visible) return;
    ctx.coords.sunSceneVec(clock.now(), sun.v);
    const t = performance.now() / 1000;
    if (fade < 1) { fade = Math.min(1, fade + 0.016); ctx.requestRender(100); }
    for (const m of mats) { m.uniforms.uTime.value = t; m.uniforms.uFade.value = fade; }
  },
  dispose() { if (group) ctx.root.remove(group); for (const m of mats) m.dispose(); tex?.dispose(); },
};
export function initAuroraGlobe() { registerGlobeLayer(layer); }
