// Satellite point cloud: one THREE.Points, positions interpolated on the GPU between the
// two latest worker ticks (great-circle slerp with linearly interpolated radius), plus a CPU
// mirror of the same maths for picking / markers.
import * as THREE from 'three';
import { CATEGORIES } from '../state.js';
import { R_KM } from './coords.js';

const CAT_KEYS = Object.keys(CATEGORIES);
const NCAT = CAT_KEYS.length;

const VERT = /* glsl */`
  attribute vec3 aPrev;
  attribute float aCat;
  attribute float aLit;
  attribute float aSz;     // size multiplier from RCS class
  attribute float aHi;     // 1 = notable / bright: extra glow
  attribute float aShow;   // 0 = hidden by highlights-only
  attribute float aNew;    // 1 = joined with a later catalog stage: fades in
  uniform float uNew;
  uniform float uU;
  uniform float uPx;
  uniform float uScale;
  uniform float uRide;
  uniform vec3 uHide;
  uniform vec3 uCol[${NCAT}];
  uniform float uSize[${NCAT}];
  uniform float uVis[${NCAT}];
  varying vec3 vCol;
  varying float vLit;
  varying float vHi;
  varying float vFade;
  void main() {
    int ci = int(aCat + 0.5);
    vec3 b = position;
    vec3 a = aPrev;
    float lb = length(b);
    float la = length(a);
    if (uVis[ci] < 0.5 || aShow < 0.5 || lb < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vLit = 0.0; return; }
    vec3 p = b;
    if (la > 0.01) {
      vec3 da = a / la; vec3 db = b / lb;
      float om = acos(clamp(dot(da, db), -1.0, 1.0));
      vec3 d = (om < 1e-4) ? normalize(mix(da, db, uU))
                           : (sin((1.0 - uU) * om) * da + sin(uU * om) * db) / sin(om);
      p = d * mix(la, lb, uU);
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = length(mv.xyz);
    float k = clamp(3.0 / dist, 0.75, 3.2);
    float fadeNear = 1.0;
    if (uRide > 0.001) {
      // ride along: the swarm is seen from inside it, so keep the dots star-sized and fade out the very near ones
      k = mix(k, clamp(0.16 / dist, 0.30, 0.9), uRide);
      fadeNear = mix(1.0, smoothstep(0.0015, 0.009, dist) * 0.7, uRide);
      if (distance(p, uHide) < 0.0009) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vLit = 0.0; return; }
    }
    gl_PointSize = uSize[ci] * aSz * (1.0 + 0.6 * aHi) * 4.6 * uPx * k * uScale * (aLit > 0.5 ? 1.0 : 0.8);
    gl_Position = projectionMatrix * mv;
    vCol = uCol[ci];
    vLit = aLit;
    vHi = aHi;
    vFade = mix(1.0, uNew, aNew) * fadeNear;
  }`;

const FRAG = /* glsl */`
  varying vec3 vCol;
  varying float vLit;
  varying float vHi;
  varying float vFade;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float d = length(q);
    if (d > 1.0) discard;
    float core = smoothstep(0.50, 0.05, d);
    float glow = pow(1.0 - d, 2.2) * (0.7 + 0.5 * vHi) + vHi * pow(1.0 - d, 4.0) * 0.5;
    float a = core + glow;
    vec3 c = mix(vCol, vec3(1.0), core * 0.3);
    if (vLit < 0.5) {
      // in Earth's shadow: dim and desaturated (only visible by earthshine)
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(c, vec3(l) * vec3(0.7, 0.8, 1.0), 0.65) * 0.5;
      a *= 0.5;
    }
    gl_FragColor = vec4(c, a * vFade);
    #include <colorspace_fragment>
  }`;

export class SatLayer {
  constructor() {
    this.n = 0;
    this.ids = null;                 // slot table (propagator ids array); slot i <-> list[i]
    this.list = [];
    this.idToIndex = new Map();
    this.catIdx = new Uint8Array(0);
    this.prev = new Float32Array(0);
    this.next = new Float32Array(0);
    this.lit = new Uint8Array(0);
    this.tPrev = 0; this.tNext = 0; this.haveTick = false;
    this.u = 1;
    this.visible = new Array(NCAT).fill(true);
    this.highlightsOnly = false;
    this.hl = new Uint8Array(0);
    this.notable = [];
    this.fading = false; this.bornAt = 0;
    this._m = new THREE.Matrix4(); this._tmp = new THREE.Vector3();
    this._catSize = CAT_KEYS.map(k => CATEGORIES[k].size);

    const col = CAT_KEYS.map(k => new THREE.Color(CATEGORIES[k].color));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uU: { value: 1 }, uPx: { value: 1 }, uScale: { value: 1 }, uNew: { value: 1 }, uRide: { value: 0 }, uHide: { value: new THREE.Vector3(1e6, 0, 0) },
        uCol: { value: col.map(c => new THREE.Vector3(c.r, c.g, c.b)) },
        uSize: { value: CAT_KEYS.map(k => CATEGORIES[k].size) },
        uVis: { value: new Array(NCAT).fill(1) },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /**
   * (Re)build the layer for a propagator slot table. Slot i is ids[i]. Sats that were already on screen keep
   * their prev/next positions (matched by id), so a catalog stage swap does not move or blink existing dots;
   * sats new to the layer fade in.
   */
  setSlots(ids, lookup) {
    const old = { n: this.n, idToIndex: this.idToIndex, prev: this.prev, next: this.next, lit: this.lit };
    const n = this.n = ids.length;
    this.ids = ids;
    const list = this.list = new Array(n);
    const idToIndex = this.idToIndex = new Map();
    const catIdx = this.catIdx = new Uint8Array(n);
    const aCat = new Float32Array(n), aSz = new Float32Array(n), aHi = new Float32Array(n), aNew = new Float32Array(n);
    const hl = this.hl = new Uint8Array(n);
    const notable = this.notable = [];
    const other = CAT_KEYS.indexOf('other');
    const SZ = { L: 1.8, M: 1.25, S: 0.65 };
    this.prev = new Float32Array(n * 3); this.next = new Float32Array(n * 3);
    this.lit = new Uint8Array(n).fill(1);
    let fresh = 0;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const q = lookup(id) || { id, name: String(id), cat: 'other' };
      list[i] = q; idToIndex.set(id, i);
      let ci = CAT_KEYS.indexOf(q.cat); if (ci < 0) ci = other;
      catIdx[i] = ci; aCat[i] = ci;
      aSz[i] = SZ[q.size] || 1;
      const hi = !!(q.notable || q.bright);
      aHi[i] = hi ? 1 : 0;
      hl[i] = (hi || q.size === 'L') ? 1 : 0;
      if (q.notable) notable.push(i);
      if (old.n) {
        const o = old.idToIndex.get(id);
        if (o === undefined) { aNew[i] = 1; fresh++; }
        else {
          const a = i * 3, b = o * 3;
          this.prev[a] = old.prev[b]; this.prev[a + 1] = old.prev[b + 1]; this.prev[a + 2] = old.prev[b + 2];
          this.next[a] = old.next[b]; this.next[a + 1] = old.next[b + 1]; this.next[a + 2] = old.next[b + 2];
          this.lit[i] = old.lit[o];
        }
      }
    }
    this.aShow = new Float32Array(n).fill(1);
    const g = new THREE.BufferGeometry();
    this.attrNext = new THREE.BufferAttribute(this.next, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrPrev = new THREE.BufferAttribute(this.prev, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrLit = new THREE.BufferAttribute(this.lit, 1, true).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attrNext);
    g.setAttribute('aPrev', this.attrPrev);
    g.setAttribute('aCat', new THREE.BufferAttribute(aCat, 1));
    g.setAttribute('aLit', this.attrLit);
    g.setAttribute('aSz', new THREE.BufferAttribute(aSz, 1));
    g.setAttribute('aHi', new THREE.BufferAttribute(aHi, 1));
    g.setAttribute('aNew', new THREE.BufferAttribute(aNew, 1));
    this.attrShow = new THREE.BufferAttribute(this.aShow, 1);
    g.setAttribute('aShow', this.attrShow);
    g.setDrawRange(0, n);
    this.points.geometry.dispose();
    this.points.geometry = g;
    if (!old.n) this.haveTick = false;     // first generation: the next tick snaps
    if (fresh) { this.fading = true; this.bornAt = performance.now(); this.material.uniforms.uNew.value = 0; }
    this.setHighlightsOnly(this.highlightsOnly);
  }

  setHighlightsOnly(v) {
    this.highlightsOnly = !!v;
    if (!this.n) return;
    for (let i = 0; i < this.n; i++) this.aShow[i] = (!v || this.hl[i]) ? 1 : 0;
    this.attrShow.needsUpdate = true;
  }

  /** Consume a worker tick for the current slot table. snap=true replaces both buffers (time jump / first tick). */
  applyTick(tick, snap) {
    const n = this.n; if (!n || tick.ids !== this.ids) return;
    const R = 1 / R_KM, ec = tick.ecef, sl = tick.sunlit, nx = this.next, pv = this.prev, lit = this.lit;
    const first = snap || !this.haveTick;
    if (!first) pv.set(nx);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      nx[j] = ec[j] * R; nx[j + 1] = ec[j + 2] * R; nx[j + 2] = -ec[j + 1] * R;
      lit[i] = sl[i];
    }
    if (first) { pv.set(nx); this.tPrev = tick.time; }
    else this.tPrev = this.tNext;
    this.tNext = tick.time;
    this.haveTick = true;
    this.attrNext.needsUpdate = true; this.attrPrev.needsUpdate = true; this.attrLit.needsUpdate = true;
  }

  setFilters(filters) {
    const v = this.material.uniforms.uVis.value;
    for (let c = 0; c < NCAT; c++) { this.visible[c] = !!filters[CAT_KEYS[c]]; v[c] = this.visible[c] ? 1 : 0; }
  }

  /** simMs -> interpolation factor (can slightly exceed 1 = extrapolate) */
  setTime(simMs) {
    const dt = this.tNext - this.tPrev;
    let u = dt === 0 ? 1 : (simMs - this.tPrev) / dt;
    if (!(u > -0.5)) u = -0.5; if (u > 5) u = 5;
    this.u = u;
    this.material.uniforms.uU.value = u;
    if (this.fading) {
      const k = (performance.now() - this.bornAt) / 700;
      if (k >= 1) { this.fading = false; this.material.uniforms.uNew.value = 1; }
      else this.material.uniforms.uNew.value = k * k * (3 - 2 * k);
    }
  }

  /** CPU mirror of the vertex shader. Returns false if the sat has no valid position. */
  posOf(i, out) {
    const nx = this.next, pv = this.prev, j = i * 3;
    const bx = nx[j], by = nx[j + 1], bz = nx[j + 2];
    const lb = Math.sqrt(bx * bx + by * by + bz * bz);
    if (lb < 0.01) return false;
    const ax = pv[j], ay = pv[j + 1], az = pv[j + 2];
    const la = Math.sqrt(ax * ax + ay * ay + az * az);
    if (la < 0.01) { out.set(bx, by, bz); return true; }
    const u = this.u;
    const dax = ax / la, day = ay / la, daz = az / la, dbx = bx / lb, dby = by / lb, dbz = bz / lb;
    const c = Math.max(-1, Math.min(1, dax * dbx + day * dby + daz * dbz));
    const om = Math.acos(c);
    let dx, dy, dz;
    if (om < 1e-4) { dx = dax + (dbx - dax) * u; dy = day + (dby - day) * u; dz = daz + (dbz - daz) * u; const m = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; dx /= m; dy /= m; dz /= m; }
    else { const s = Math.sin(om), w0 = Math.sin((1 - u) * om) / s, w1 = Math.sin(u * om) / s; dx = w0 * dax + w1 * dbx; dy = w0 * day + w1 * dby; dz = w0 * daz + w1 * dbz; }
    const r = la + (lb - la) * u;
    out.set(dx * r, dy * r, dz * r);
    return true;
  }

  /** Nearest visible, un-occluded sat within `thresh` CSS px of (px,py). Returns index or -1.
   *  Uses a linear blend of the two tick positions (error < 10 m, far below a pixel) to stay cheap. */
  pick(px, py, camera, w, h, thresh) {
    const n = this.n; if (!n) return -1;
    camera.updateMatrixWorld();
    const m = this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const nx = this.next, pv = this.prev, u = this.u, vis = this.visible, cat = this.catIdx, hl = this.hl, hlOnly = this.highlightsOnly;
    let best = -1, bestD = thresh * thresh;
    for (let i = 0; i < n; i++) {
      if (!vis[cat[i]]) continue;
      if (hlOnly && !hl[i]) continue;
      const j = i * 3;
      let x = nx[j], y = nx[j + 1], z = nx[j + 2];
      if (x * x + y * y + z * z < 1e-4) continue;
      const ax = pv[j], ay = pv[j + 1], az = pv[j + 2];
      if (ax * ax + ay * ay + az * az > 1e-4) { x = ax + (x - ax) * u; y = ay + (y - ay) * u; z = az + (z - az) * u; }
      const W = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (W <= 0) continue;
      const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / W;
      const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / W;
      const dx = (sx * 0.5 + 0.5) * w - px, dy = (0.5 - sy * 0.5) * h - py;
      let d = dx * dx + dy * dy;
      if (d >= bestD) continue;
      // Earth occlusion: closest approach of segment camera->sat to the origin
      const vx = x - cx, vy = y - cy, vz = z - cz;
      let t = -(cx * vx + cy * vy + cz * vz) / (vx * vx + vy * vy + vz * vz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = cx + vx * t, qy = cy + vy * t, qz = cz + vz * t;
      if (qx * qx + qy * qy + qz * qz < 0.99) continue;
      // slight preference for big (station) markers
      d -= this._catSize[cat[i]] * 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
}
