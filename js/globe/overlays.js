// Overlays: pulsing selection ring, orbit path, ground track, nadir line, observer beacon,
// footprint circle and graticule.
import * as THREE from 'three';
import { R_KM, latLonToVec, horizonAngle, gmstRad } from './coords.js';

// ---------- ring marker (screen-space sprite via Points) ----------
const RING_VERT = /* glsl */`
  uniform float uSize; uniform float uPx;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * uPx;
    gl_Position = projectionMatrix * mv;
  }`;
const RING_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uTime; uniform float uPulse;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float d = length(q);
    float ring = smoothstep(0.50, 0.56, d) * (1.0 - smoothstep(0.62, 0.70, d));
    float a = ring * 0.95;
    if (uPulse > 0.5) {
      float ph = fract(uTime * 0.9);
      float r = 0.18 + ph * 0.82;
      float w = 0.05 + 0.03 * ph;
      a += smoothstep(r - w, r, d) * (1.0 - smoothstep(r, r + w, d)) * (1.0 - ph) * 0.9;
      a += smoothstep(0.30, 0.0, d) * 0.25;
    }
    if (d > 1.0 || a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

export function makeRingMarker(color, size, pulse) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: size }, uPx: { value: 1 }, uTime: { value: 0 }, uPulse: { value: pulse ? 1 : 0 },
                uColor: { value: new THREE.Color(color) } },
    vertexShader: RING_VERT, fragmentShader: RING_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false; p.renderOrder = 6; p.visible = false;
  return p;
}

// ---------- phase-faded line ----------
const LINE_VERT = /* glsl */`
  attribute float aPhase;
  uniform float uPhase; uniform float uWrap; uniform float uTail;
  varying float vA;
  void main() {
    float f = aPhase - uPhase;
    if (uWrap > 0.5) f = fract(f);
    // f >= 0: ahead of the satellite (fades out), f < 0: behind (short tail)
    vA = f >= 0.0 ? 1.0 - 0.82 * pow(clamp(f, 0.0, 1.0), 0.8) : clamp(1.0 + f * uTail, 0.0, 1.0) * 0.8;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const LINE_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha;
  varying float vA;
  void main() {
    gl_FragColor = vec4(uColor, vA * uAlpha);
    #include <colorspace_fragment>
  }`;
function phaseLineMaterial(color, alpha, wrap, tail) {
  return new THREE.ShaderMaterial({
    uniforms: { uPhase: { value: 0 }, uWrap: { value: wrap ? 1 : 0 }, uTail: { value: tail }, uAlpha: { value: alpha },
                uColor: { value: new THREE.Color(color) } },
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

const sat = () => window.satellite;

/** Orbit ellipse (inertial), ground track and nadir line for the selected satellite. */
export class SelectedPath {
  constructor() {
    this.group = new THREE.Group();
    this.orbitGroup = new THREE.Group();            // rotated by -GMST to turn TEME into ECEF
    this.orbitLine = new THREE.Line(new THREE.BufferGeometry(), phaseLineMaterial('#7fe6ff', 0.95, true, 1.5));
    this.orbitLine.frustumCulled = false;
    this.orbitGroup.add(this.orbitLine);
    this.trackLine = new THREE.Line(new THREE.BufferGeometry(), phaseLineMaterial('#ffe08a', 0.55, false, 3.0));
    this.trackLine.frustumCulled = false;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.dropLine = new THREE.Line(dg, new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.dropLine.frustumCulled = false;
    this.footDot = makeRingMarker('#9fdcff', 14, false);
    this.group.add(this.orbitGroup, this.trackLine, this.dropLine, this.footDot);
    this.group.visible = false;
    this.rec = null; this.periodMs = 0; this.orbitT0 = 0; this.trackT0 = 0;
  }
  set(rec) {
    this.rec = rec;
    this.group.visible = !!rec;
    this.orbitT0 = this.trackT0 = 0; this.orbitReady = this.trackReady = false;
    if (rec) this.periodMs = Math.min(2 * Math.PI / rec.no, 3000) * 60000;
  }
  _epochMs() { return (this.rec.jdsatepoch + (this.rec.jdsatepochF || 0) - 2440587.5) * 86400000; }

  _buildOrbit(t0) {
    const N = 360, P = this.periodMs, ep = this._epochMs();
    const pos = new Float32Array((N + 1) * 3), ph = new Float32Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const o = sat().sgp4(this.rec, (t0 + (k / N) * P - ep) / 60000);
      const p = o && o.position;
      if (p) { pos[k * 3] = p.x / R_KM; pos[k * 3 + 1] = p.z / R_KM; pos[k * 3 + 2] = -p.y / R_KM; }
      else if (k > 0) { pos.copyWithin(k * 3, (k - 1) * 3, k * 3); }
      ph[k] = k / N;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    this.orbitLine.geometry.dispose(); this.orbitLine.geometry = g;
    this.orbitT0 = t0; this.orbitReady = true;
  }
  _buildTrack(t0) {
    const M = 240, P = this.periodMs, ep = this._epochMs();
    const pos = new Float32Array((M + 1) * 3), ph = new Float32Array(M + 1);
    for (let k = 0; k <= M; k++) {
      const t = t0 + (k / M) * P;
      const o = sat().sgp4(this.rec, (t - ep) / 60000);
      const p = o && o.position;
      const th = gmstRad(t), c = Math.cos(th), s = Math.sin(th);
      if (p) {
        const x = c * p.x + s * p.y, y = -s * p.x + c * p.y, z = p.z;
        const m = Math.hypot(x, y, z) || 1, r = 1.004 / m;
        pos[k * 3] = x * r; pos[k * 3 + 1] = z * r; pos[k * 3 + 2] = -y * r;
      } else if (k > 0) pos.copyWithin(k * 3, (k - 1) * 3, k * 3);
      ph[k] = k / M;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    this.trackLine.geometry.dispose(); this.trackLine.geometry = g;
    this.trackT0 = t0; this.trackReady = true;
  }

  /** satPos: current interpolated scene position of the satellite (or null) */
  update(simMs, satPos, camera, uPx) {
    if (!this.rec) return;
    const P = this.periodMs;
    // orbit: inertial ellipse, rebuilt rarely
    if (!this.orbitReady || Math.abs(simMs - this.orbitT0) > 6 * P) this._buildOrbit(simMs);
    this.orbitGroup.rotation.y = -gmstRad(simMs);
    let ph = ((simMs - this.orbitT0) / P) % 1; if (ph < 0) ph += 1;
    this.orbitLine.material.uniforms.uPhase.value = ph;
    // ground track: window from -0.2P to +0.8P around now
    const tp = (simMs - this.trackT0) / P;
    if (!this.trackReady || tp < 0.05 || tp > 0.4) { this._buildTrack(simMs - 0.2 * P); }
    this.trackLine.material.uniforms.uPhase.value = (simMs - this.trackT0) / P;
    // nadir line
    const arr = this.dropLine.geometry.attributes.position.array;
    if (satPos) {
      const m = satPos.length();
      arr[0] = satPos.x; arr[1] = satPos.y; arr[2] = satPos.z;
      arr[3] = satPos.x / m; arr[4] = satPos.y / m; arr[5] = satPos.z / m;
      this.dropLine.geometry.attributes.position.needsUpdate = true;
      this.dropLine.visible = true;
      this.footDot.visible = true;
      const fp = this.footDot.geometry.attributes.position.array;
      fp[0] = arr[3] * 1.003; fp[1] = arr[4] * 1.003; fp[2] = arr[5] * 1.003;
      this.footDot.geometry.attributes.position.needsUpdate = true;
      this.footDot.material.uniforms.uPx.value = uPx;
    } else { this.dropLine.visible = false; this.footDot.visible = false; }
  }
  invalidate() { this.orbitReady = this.trackReady = false; }
}

/** Observer beacon + visibility footprint. */
export class ObserverMarker {
  constructor() {
    this.group = new THREE.Group();
    this.beacon = new THREE.Group();
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0065, 24),
      new THREE.MeshBasicMaterial({ color: 0x8ff0ff, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide }));
    const halo = new THREE.Mesh(new THREE.CircleGeometry(0.02, 32),
      new THREE.MeshBasicMaterial({ color: 0x5ce1ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.pulse = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0x5ce1ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.pulse.scale.setScalar(0.03);
    // thin vertical beam
    const beam = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.12)]),
      new THREE.LineBasicMaterial({ color: 0x8ff0ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.beacon.add(halo, dot, this.pulse, beam);
    this.footprint = new THREE.LineLoop(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x5ce1ff, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.footprint.frustumCulled = false;
    this.group.add(this.beacon, this.footprint);
    this.vec = new THREE.Vector3();
  }
  set(lat, lon) {
    const p = latLonToVec(lat, lon, 1.0015, this.vec);
    this.beacon.position.copy(p);
    this.beacon.lookAt(p.clone().multiplyScalar(2));      // +Z of the group points away from Earth
    // footprint of a 500 km satellite at 0 deg elevation
    const psi = horizonAngle(500), n = 160, pts = [];
    const c = latLonToVec(lat, lon, 1), up = Math.abs(c.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const e1 = new THREE.Vector3().crossVectors(c, up).normalize(), e2 = new THREE.Vector3().crossVectors(c, e1);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const v = c.clone().multiplyScalar(Math.cos(psi))
        .addScaledVector(e1, Math.sin(psi) * Math.cos(a)).addScaledVector(e2, Math.sin(psi) * Math.sin(a))
        .multiplyScalar(1.0015);
      pts.push(v);
    }
    this.footprint.geometry.dispose();
    this.footprint.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }
  update(tSec, camDist) {
    const ph = (tSec * 0.6) % 1;
    this.beacon.scale.setScalar(Math.max(0.2, Math.min(1.3, (camDist - 1.0) * 0.5)));
    this.pulse.scale.setScalar(0.012 + ph * 0.05);
    this.pulse.material.opacity = 0.65 * (1 - ph);
  }
}

export function makeGraticule() {
  const pts = [];
  const R = 1.0012;
  const seg = (a, b) => { pts.push(a, b); };
  for (let lat = -60; lat <= 60; lat += 30) {
    let prev = latLonToVec(lat, -180, R);
    for (let lon = -175; lon <= 180; lon += 5) { const v = latLonToVec(lat, lon, R); seg(prev, v); prev = v; }
  }
  for (let lon = -180; lon < 180; lon += 30) {
    let prev = latLonToVec(-85, lon, R);
    for (let lat = -80; lat <= 85; lat += 5) { const v = latLonToVec(lat, lon, R); seg(prev, v); prev = v; }
  }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8fc4ff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
  l.visible = false; l.renderOrder = 2;
  return l;
}
