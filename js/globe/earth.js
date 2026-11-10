// Earth, clouds, atmosphere, star sphere and sun glare. All custom shaders; lighting is done in
// linear space and encoded with <colorspace_fragment>.
import * as THREE from 'three';
import { sunSceneVec, gmstRad } from './coords.js';
import { GLSL_NOISE, GLSL_ATMO, GLSL_CLOUD, createNoise3D, dummyNoise3D } from './atmo.js';

const TEX = 'assets/textures/';
// First load: 2048x1024 WebP (~0.6 MB total). On capable desktops the day/night maps are upgraded to 4096x1024
// WebP shortly after the first frame, once the main thread is idle (see upgradeTextures).
const lowData = () => {
  const c = navigator.connection;
  return !!(c && (c.saveData || /(^|-)2g$|3g/.test(c.effectiveType || '')));
};
const wantHiRes = (renderer) => {
  try {
    return matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)').matches
      && renderer.capabilities.maxTextureSize >= 4096
      && !renderer.userData?.softwareGL
      && !lowData() && !(navigator.deviceMemory && navigator.deviceMemory < 4);
  } catch { return false; }
};

function loadTexture(loader, file, { srgb, anisotropy = 1, repeatX = false } = {}) {
  return new Promise((resolve, reject) => {
    loader.load(TEX + file, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = anisotropy;
      t.wrapS = repeatX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      resolve(t);
    }, undefined, reject);
  });
}

const COMMON_VERT = /* glsl */`
  varying vec3 vN; varying vec2 vUv; varying vec3 vW;
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const EARTH_FRAG = /* glsl */`
  uniform sampler2D uDay, uNight, uWater, uCloud;
  uniform float uTexel, uCloudRot;
  ${GLSL_NOISE}
  ${GLSL_ATMO}
  ${GLSL_CLOUD}
  varying vec3 vN; varying vec2 vUv; varying vec3 vW;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec3 N = normalize(vN);
    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vW);
    float ndl = dot(N, L);
    float ndv = max(dot(N, V), 0.0);
    float rideK = uRide;                         // 0 in the normal orbit view: every ride branch below is skipped

    vec2 uvw = vUv;
    float fp = 0.0, cloudSh = 0.0, hgt = 0.0, grain = 0.0;
    vec3 Nb = N;
    vec3 tint = vec3(1.0);
    vec3 N0 = N;
    if (rideK > 0.001) {
      fp = length(fwidth(vW));
      // break up the bilinear blur of the magnified maps: wobble the lookup by about a texel
      vec2 w = vec2(fbmF(N0, 150.0, 3, fp), fbmF(N0 + 7.1, 150.0, 3, fp));
      uvw = vUv + w * uTexel * 1.3 * rideK;
    }
    vec3 day = texture2D(uDay, uvw).rgb;
    vec3 night = texture2D(uNight, uvw).rgb;
    float water = texture2D(uWater, uvw).r;
    vec2 uvc = vUv - vec2(uCloudRot / 6.2831853, 0.0);
    float cloud;
    float dl = 0.0;
    if (rideK > 0.001) {
      vec3 dObj = rotY(N0, -uCloudRot);
      float shp;
      cloud = cloudDens(uCloud, uvc, dObj, fp, shp);
      // ground detail: albedo variation + a faint relief that catches grazing sun
      dl = fbmF(N0, 520.0, 5, fp);
      float dl2 = fbmF(N0 + 3.3, 2600.0, 3, fp);
      hgt = fbmF(N0 + 9.1, 260.0, 5, fp);
      float land = 1.0 - water;
      float ridge = 1.0 - abs(fbmF(N0 + 21.0, 340.0, 4, fp));
      float ridgeL = 1.0 - abs(fbmF(N0 + 33.0, 95.0, 3, fp));
      day *= 1.0 + (dl * 0.62 + dl2 * 0.38) * (0.38 + 0.55 * land) * rideK - (ridge * ridge - 0.45) * 0.42 * land * rideK - (ridgeL * ridgeL * ridgeL - 0.35) * 0.35 * land * rideK;
      day = mix(day, day * day * (3.0 - 2.0 * day), 0.45 * rideK);       // contrast
      day = mix(vec3(luma(day)), day, 1.0 + 0.45 * rideK);               // saturation
      day = mix(day, day * vec3(1.06, 1.02, 0.90), clamp(dl * 0.5 + 0.5, 0.0, 1.0) * land * rideK * 0.5);
      vec3 dpdx = dFdx(vW), dpdy = dFdy(vW);
      vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
      float det = dot(dpdx, r1);
      vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
      Nb = normalize(abs(det) * N - 0.00045 * (0.25 + 0.75 * land) * grad * rideK);
      // sunlight colour at ground level: gold and red towards the terminator, white overhead
      vec3 sun0 = sunTransAt(N0 * 1.00001) / vec3(0.946, 0.879, 0.728);
      tint = mix(vec3(1.0), clamp(sun0, 0.0, 1.6), rideK);
      // cloud shadows: look for cloud on the line towards the Sun
      vec3 Lt = L - N * ndl;
      float cosLat = max(sqrt(max(1.0 - N.y * N.y, 0.0)), 0.04);
      vec3 east = vec3(N.z, 0.0, -N.x) / cosLat;
      vec3 north = cross(N, east);
      float off = 0.0032 / max(ndl, 0.14);
      vec2 uvs = uvc + vec2(dot(Lt, east) / (6.2831853 * cosLat), dot(Lt, north) / 3.14159265) * off;
      if (ndl > 0.0) {
        float shp2;
        float cs = cloudDens(uCloud, uvs, rotY(normalize(N0 + Lt * off), -uCloudRot), fp, shp2);
        cloudSh = cs * 0.36 * smoothstep(0.02, 0.2, ndl) * rideK;
      }
    } else {
      cloud = texture2D(uCloud, uvc).r;
    }
    float ndlB = rideK > 0.001 ? dot(Nb, L) : ndl;

    // soft terminator
    float daylight = smoothstep(-0.14, 0.34, ndl);
    float dayRide = smoothstep(-0.03, 0.30, ndlB);
    float diffuse = mix(daylight, dayRide, rideK);
    // land gets a touch of contrast, oceans a bit deeper
    vec3 albedo = day * mix(vec3(1.0), vec3(0.78, 0.9, 1.05), water * 0.5);
    vec3 col = albedo * (diffuse * 1.18) * tint * (1.0 - cloudSh);
    // blue skylight fills the shadow side of ridges and the terminator zone
    col += albedo * vec3(0.05, 0.10, 0.22) * rideK * smoothstep(-0.25, 0.25, ndl) * (1.0 - diffuse * 0.6);
    // faint moon/starlight ambient on the night side so continents are readable
    col += albedo * vec3(0.010, 0.016, 0.036) * (1.0 - daylight);

    // city lights: warm, hidden by clouds and by daylight
    float darkness = 1.0 - smoothstep(-0.20, 0.10, ndl);
    float nl = luma(night);
    vec3 lights = mix(night, vec3(nl) * vec3(1.0, 0.70, 0.38), 0.55);
    lights = lights * (1.0 + 2.2 * nl) * 1.7;
    vec3 lightsOut = lights;
    if (rideK > 0.001) {
      // up close the lights map is a soft blob: rebuild it as scattered point lights (density follows the map) over a gentle halo
      vec3 nb = texture2D(uNight, uvw, 3.0).rgb, nb2 = texture2D(uNight, uvw, 5.5).rgb;
      float nlB = luma(nb), nlB2 = luma(nb2);
      float veins = fbmF(N0 + 4.2, 640.0, 4, fp) * 0.5 + 0.5;      // breaks the blocky blobs of the map into patchy, branching clusters
      float vm = 0.35 + 1.15 * veins;
      float dens = clamp(mix(nl, nlB, 0.45) * 1.8 * vm, 0.0, 1.0);
      vec3 lit2 = vec3(0.0);
      if (dens > 0.02 && darkness > 0.01) {
        const float DF = 1500.0;
        vec3 pc = N0 * DF, ci = floor(pc), cf = pc - ci;
        float h0 = hash13(ci);
        vec3 off = vec3(hash13(ci + 17.0), hash13(ci + 31.0), hash13(ci + 47.0)) * 0.5 + 0.25;
        float dd = length(cf - off);
        float fade = 1.0 - smoothstep(0.30, 0.80, fp * DF);
        float present = step(h0, pow(dens, 1.5) * 1.35);
        float r2 = max(0.034, 0.8 * fp * DF * fp * DF);          // dots never smaller than about a pixel
        float pt = present * exp(-dd * dd / r2) * inversesqrt(r2 / 0.034) * (0.6 + 0.9 * hash13(ci + 5.0));
        vec3 hot = mix(vec3(1.0, 0.58, 0.24), vec3(1.0, 0.90, 0.72), clamp(pt * 0.9, 0.0, 1.0));
        lit2 = hot * pt * 3.2 * fade;
        lit2 += vec3(1.0, 0.56, 0.24) * (nl * 0.26 + nlB * 0.30) * vm * mix(0.8, 1.6, 1.0 - fade);
      }
      vec3 halo = vec3(1.0, 0.50, 0.20) * (nlB * 0.5 + nlB2 * 0.8) * 0.24;
      lightsOut = mix(lights, lit2 + halo, rideK);
    }
    col += lightsOut * darkness * (1.0 - mix(0.65, 0.82, rideK) * cloud);

    // ocean glint
    vec3 H = normalize(L + V);
    float nh = max(dot(N, H), 0.0);
    float spec = pow(nh, 140.0) * 2.2 + pow(nh, 22.0) * 0.16;
    col += vec3(1.0, 0.92, 0.78) * tint * spec * water * smoothstep(0.0, 0.25, ndl) * (1.0 - 0.7 * cloud) * (1.0 + rideK * 0.35 * dl);
    // ocean sky-reflection at grazing angles
    float fres = pow(1.0 - ndv, 4.0);
    col += water * fres * vec3(0.10, 0.22, 0.46) * daylight * 0.9;

    // twilight band
    float tw = exp(-pow(ndl / 0.13, 2.0));
    col += vec3(1.0, 0.36, 0.09) * tw * (0.05 + 0.22 * luma(day)) * 0.9 * (1.0 - 0.6 * rideK);

    // atmospheric haze on the limb (orbit view)
    float rim = pow(1.0 - ndv, 2.6);
    vec3 haze = vec3(0.22, 0.5, 1.0) * (0.10 + 0.9 * daylight) + vec3(1.0, 0.45, 0.18) * tw * 0.5;
    col += haze * rim * 0.85 * (1.0 - rideK);

    // ride mode: real aerial perspective (extinction + in-scatter) along the line of sight to this pixel
    if (rideK > 0.001) {
      vec3 ro = cameraPosition, d = vW - ro;
      float dist = length(d);
      vec3 S, T;
      aMarch(ro, d / dist, dist, max(uSteps * 3 / 5, 6), S, T);
      col = mix(col, col * T + S * 0.62, rideK);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const CLOUD_FRAG = /* glsl */`
  uniform sampler2D uCloud, uNight;
  uniform float uCloudRot;
  ${GLSL_NOISE}
  ${GLSL_ATMO}
  ${GLSL_CLOUD}
  varying vec3 vN; varying vec2 vUv; varying vec3 vW;
  void main() {
    vec3 N = normalize(vN);
    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vW);
    float ndl = dot(N, L);
    float fp = uRide > 0.001 ? length(fwidth(vW)) : 0.0;
    float shp;
    float dens = cloudDens(uCloud, vUv, rotY(N, -uCloudRot), fp, shp);
    if (dens < 0.004) discard;
    float daylight = smoothstep(-0.10, 0.30, ndl);
    float tw = exp(-pow(ndl / 0.12, 2.0));
    vec3 base = mix(vec3(0.010, 0.014, 0.026), vec3(1.0, 1.0, 1.0), daylight);
    base = mix(base, vec3(1.0, 0.52, 0.28), tw * 0.55);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    base += vec3(0.2, 0.4, 0.8) * rim * 0.25 * daylight;
    float a = dens * 0.88;
    vec3 col = base;
    if (uRide > 0.001) {
      // puffy shading from the noise field, sunset colours, and the glow of city lights from underneath
      vec3 Lt = L - N * ndl;
      float shp2 = fbmG(rotY(normalize(N + Lt * 0.0035), -uCloudRot), 130.0, 6, fp, 0.56);
      float fine = fbmF(rotY(N, -uCloudRot) + 3.0, 1100.0, 3, fp);
      float lit = clamp(0.97 + (shp - shp2) * 3.2 + fine * 0.30, 0.66, 1.16);
      vec3 sunC = clamp(sunTransAt(N * 1.003) / vec3(0.946, 0.879, 0.728), 0.0, 1.6);
      vec3 dayC = mix(vec3(0.55, 0.64, 0.82), vec3(1.0), smoothstep(0.0, 0.7, dens)) * lit;
      vec3 c2 = dayC * sunC * smoothstep(-0.06, 0.28, ndl) + vec3(0.55, 0.70, 1.0) * 0.07 * daylight;
      c2 += vec3(0.010, 0.014, 0.028) * (1.0 - daylight);                              // starlit
      vec3 nb = texture2D(uNight, vUv, 4.0).rgb;
      float nlB = dot(nb, vec3(0.299, 0.587, 0.114));
      float dark = 1.0 - smoothstep(-0.20, 0.10, ndl);
      c2 += vec3(1.0, 0.52, 0.22) * pow(nlB, 0.9) * 1.5 * dark * (0.3 + 0.7 * dens);   // lit from below
      col = mix(base, c2, uRide);
      a = mix(a, dens * 0.90, uRide);
      vec3 ro = cameraPosition, d = vW - ro;
      float dist = length(d);
      vec3 rd = d / dist;
      // pixels whose ray misses the planet are covered by the sky pass instead
      float b = dot(ro, rd);
      if (b * b - (dot(ro, ro) - 1.0) > 0.0 && -b - sqrt(max(b * b - (dot(ro, ro) - 1.0), 0.0)) > 0.0) {
        vec3 S, T;
        aMarch(ro, rd, dist, max(uSteps / 2, 6), S, T);
        col = col * T + S * 0.9;
      }
    }
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const ATMO_VERT = /* glsl */`
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const ATMO_FRAG = /* glsl */`
  uniform vec3 uSun;
  uniform float uShell, uFade;
  varying vec3 vW;
  void main() {
    vec3 rd = normalize(vW - cameraPosition);
    float b = length(cross(rd, cameraPosition));     // ray distance from Earth's centre
    float t = clamp((b - 1.0) / (uShell - 1.0), 0.0, 1.0);
    float g1 = pow(1.0 - t, 4.5);
    float g2 = pow(1.0 - t, 1.7) * 0.22;
    float g = g1 * 1.25 + g2;
    float sd = dot(normalize(vW), normalize(uSun));
    float dayF = smoothstep(-0.30, 0.45, sd);
    float tw = exp(-pow(sd / 0.24, 2.0));
    vec3 blueDeep = vec3(0.12, 0.38, 1.0);
    vec3 bluePale = vec3(0.50, 0.80, 1.0);
    vec3 col = mix(blueDeep, bluePale, g1) * dayF;
    col += vec3(1.0, 0.42, 0.12) * tw * 0.9;
    col += vec3(0.02, 0.05, 0.13) * (1.0 - dayF);
    gl_FragColor = vec4(col * g * uFade, 1.0);
    #include <colorspace_fragment>
  }`;


// ---------- ride-mode sky: limb glow, airglow, sun disk (drawn on pixels the planet does not cover) ----------
const SKY_VERT = /* glsl */`
  varying vec2 vNdc;
  void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.99999994, 1.0); }`;
const SKY_FRAG = /* glsl */`
  ${GLSL_ATMO}
  uniform mat4 uInvProj, uCamWorld;
  uniform float uNight, uSunVis;
  varying vec2 vNdc;
  void main() {
    vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
    vec3 rd = normalize(mat3(uCamWorld) * (v.xyz / v.w));
    vec3 ro = cameraPosition;
    vec3 S, T;
    aMarch(ro, rd, 1e5, uSteps, S, T);
    // gentle highlight roll-off, keeps the white-hot horizon from clipping into a flat band
    S *= 2.6;
    S = S / (1.0 + 0.22 * S);
    vec3 col = S;
    // airglow: green/orange films ~90-130 km up, only where the limb is in darkness
    float b = dot(ro, rd), rr = dot(ro, ro);
    float hit = b * b - (rr - 1.0);
    bool earthHit = hit > 0.0 && -b - sqrt(max(hit, 0.0)) > 0.0;
    if (!earthHit) {
      float tcl = max(-b, 0.0);
      vec3 pc = ro + rd * tcl;
      float ht = length(pc) - 1.0;
      float night = 1.0 - smoothstep(-0.30, 0.12, dot(normalize(pc), uSun));
      float g1 = exp(-pow((ht - 0.0150) / 0.0022, 2.0)), g2 = exp(-pow((ht - 0.0330) / 0.0045, 2.0));
      col += (vec3(0.05, 0.42, 0.16) * g1 + vec3(0.30, 0.10, 0.05) * g2 * 0.07) * night * 0.16 * (tcl > 0.0 ? 1.0 : 0.0);
    }
    // sun: disk, corona and haze glow, reddened by the air in between
    float ang = acos(clamp(dot(rd, uSun), -1.0, 1.0));
    float disk = smoothstep(0.0049, 0.0042, ang);
    float corona = exp(-ang / 0.010) * 1.3 + exp(-ang / 0.09) * 0.10 + exp(-ang / 0.45) * 0.015;
    col += (vec3(1.0, 0.96, 0.88) * disk * 60.0 + vec3(1.0, 0.88, 0.70) * corona * 2.0) * T;
    float al = 1.0 - dot(T, vec3(0.3333));
    gl_FragColor = vec4(col * uRide, al * uRide);
    #include <colorspace_fragment>
  }`;

// lens/veil glare over everything (additive, no depth test); strength follows the real Sun visibility
const GLARE_FRAG = /* glsl */`
  uniform mat4 uInvProj, uCamWorld;
  uniform vec3 uSun;
  uniform float uSunVis, uRide;
  varying vec2 vNdc;
  void main() {
    vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
    vec3 rd = normalize(mat3(uCamWorld) * (v.xyz / v.w));
    float c = clamp(dot(rd, uSun), -1.0, 1.0);
    float ang = acos(c);
    float g = exp(-ang / 0.028) * 0.55 + exp(-ang / 0.20) * 0.10 + exp(-ang / 0.9) * 0.018;
    // faint anamorphic streak through the Sun
    vec3 side = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
    vec3 s2 = normalize(cross(side, uSun));
    float lx = dot(rd, side), ly = dot(rd, s2);
    float streak = exp(-abs(ly) / 0.004) * exp(-abs(lx) / 0.12) * 0.09 * step(0.0, c);
    vec3 col = vec3(1.0, 0.86, 0.62) * (g + streak) * uSunVis * uRide;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

const STAR_VERT = /* glsl */`
  attribute float aMag; attribute vec3 aCol;
  uniform float uPx, uVis;
  varying float vB; varying vec3 vC;
  void main() {
    vB = aMag * uVis; vC = aCol;
    gl_PointSize = (1.1 + 1.9 * aMag) * uPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const STAR_FRAG = /* glsl */`
  varying float vB; varying vec3 vC;
  void main() {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float a = exp(-d * d * 3.2) * vB;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vC, a);
    #include <colorspace_fragment>
  }`;

function fullscreenTri() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

function starField(count) {
  let seed = 90210; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pos = new Float32Array(count * 3), mag = new Float32Array(count), col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    pos[i * 3] = r * Math.cos(a) * 100; pos[i * 3 + 1] = z * 100; pos[i * 3 + 2] = r * Math.sin(a) * 100;
    const m = Math.pow(rnd(), 3.2);                      // few bright, many faint
    mag[i] = 0.18 + 0.82 * m;
    const t = rnd();
    col[i * 3] = t < 0.25 ? 1.0 : 0.85 + 0.15 * t; col[i * 3 + 1] = 0.9 + 0.08 * t; col[i * 3 + 2] = t > 0.6 ? 1.0 : 0.8 + 0.3 * t;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  return g;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0.0, 'rgba(255,248,230,1)');
  grd.addColorStop(0.06, 'rgba(255,236,200,0.85)');
  grd.addColorStop(0.2, 'rgba(255,200,140,0.28)');
  grd.addColorStop(0.5, 'rgba(255,170,110,0.07)');
  grd.addColorStop(1.0, 'rgba(255,160,100,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function createEarth(renderer) {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const [day, night, water, clouds, sky] = await Promise.all([
    loadTexture(loader, 'earth-day-2k.webp', { srgb: true, anisotropy: aniso }),
    loadTexture(loader, 'earth-night-2k.webp', { srgb: true, anisotropy: aniso }),
    loadTexture(loader, 'earth-water-2k.webp', { srgb: false, anisotropy: 2 }),
    loadTexture(loader, 'earth-clouds-2k.webp', { srgb: false, anisotropy: 2, repeatX: true }),
    loadTexture(loader, 'milkyway-2k.webp', { srgb: true, anisotropy: 1 }),
  ]);
  // CSS fades the canvas in from this marker (css/base.css).
  document.body.dataset.earth = 'ready';

  const root = new THREE.Group();
  const sun = new THREE.Vector3(1, 0, 0);
  const sunU = { value: sun };
  // shared by every ride-mode shader (all neutral at uRide = 0, the normal orbit view)
  const noiseU = { value: dummyNoise3D(THREE) };
  const rideU = { uNoise: noiseU, uSun: sunU, uRide: { value: 0 }, uSteps: { value: 20 }, uCloudRot: { value: 0 } };
  const nightU = { value: night };

  // Earth
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 96),
    new THREE.ShaderMaterial({
      uniforms: { uDay: { value: day }, uNight: nightU, uWater: { value: water }, uCloud: { value: clouds }, uTexel: { value: 1 / 2048 }, ...rideU },
      vertexShader: COMMON_VERT, fragmentShader: EARTH_FRAG,
    }));
  earth.name = 'earth';
  root.add(earth);

  // Clouds (cosmetic drift)
  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.0065, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: { uCloud: { value: clouds }, uNight: nightU, ...rideU },
      vertexShader: COMMON_VERT, fragmentShader: CLOUD_FRAG,
      transparent: true, depthWrite: false,
    }));
  cloudMesh.renderOrder = 1;
  root.add(cloudMesh);

  // Atmosphere shell
  const SHELL = 1.075;
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(SHELL, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: { uSun: sunU, uShell: { value: SHELL }, uFade: { value: 1 } },
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  atmo.renderOrder = 2;
  root.add(atmo);

  // Milky Way backdrop (dim so it does not fight the Earth). Inertial: rotates by -GMST.
  const stars = new THREE.Mesh(
    new THREE.SphereGeometry(120, 64, 48),
    new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, color: 0x6a7388, depthWrite: false, toneMapped: false }));
  stars.renderOrder = -10;
  root.add(stars);

  // Sun glare
  const glare = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7, toneMapped: false,
  }));
  glare.scale.set(34, 34, 1);
  glare.renderOrder = -5;
  root.add(glare);

  // ---------- ride mode: sky pass, glare, stars ----------
  const camU = { uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } };
  const sunVisU = { value: 1 };
  const skyMesh = new THREE.Mesh(fullscreenTri(), new THREE.ShaderMaterial({
    uniforms: { ...rideU, ...camU, uNight: { value: 0 }, uSunVis: sunVisU },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  skyMesh.frustumCulled = false; skyMesh.renderOrder = 2; skyMesh.visible = false;
  const glareMesh = new THREE.Mesh(fullscreenTri(), new THREE.ShaderMaterial({
    uniforms: { ...camU, uSun: sunU, uSunVis: sunVisU, uRide: rideU.uRide },
    vertexShader: SKY_VERT.replace('0.99999994', '0.0'), fragmentShader: GLARE_FRAG,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  }));
  glareMesh.frustumCulled = false; glareMesh.renderOrder = 9; glareMesh.visible = false;
  const starPts = new THREE.Points(starField(5200), new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uVis: { value: 0 } },
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  }));
  starPts.frustumCulled = false; starPts.renderOrder = -9; starPts.visible = false;
  const skyGroup = new THREE.Group();            // inertial: turns with the star sphere
  skyGroup.add(starPts);
  root.add(skyMesh, glareMesh, skyGroup);

  const starsBase = stars.material.color.clone();
  const cloudR0 = 1.0065, cloudR1 = 1.0028;
  const geoNormal = { earth: earth.geometry, cloud: cloudMesh.geometry };
  let hiGeo = null, noiseBuilt = false;

  // Desktop-only upgrade to 4096 px day/night maps, after the page has settled (or at once when a ride starts).
  let upgraded = false;
  const upgrade = async () => {
    if (upgraded) return; upgraded = true;
    try {
      const uniforms = earth.material.uniforms;
      const [d, n] = await Promise.all([
        loadTexture(loader, 'earth-day-4k.webp', { srgb: true, anisotropy: aniso }),
        loadTexture(loader, 'earth-night-4k.webp', { srgb: true, anisotropy: aniso }),
      ]);
      const [od, on] = [uniforms.uDay.value, nightU.value];
      uniforms.uDay.value = d; nightU.value = n; uniforms.uTexel.value = 1 / 4096;
      od.dispose(); on.dispose();
    } catch (e) { upgraded = false; console.warn('[earth] hi-res textures unavailable', e); }
  };
  if (wantHiRes(renderer)) {
    setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(upgrade, { timeout: 3000 }) : upgrade()), 5000);
  }

  return {
    root, earth, sun,
    /** simMs: simulation time (ms) */
    update(simMs, realDtSec) {
      sunSceneVec(simMs, sun);
      stars.rotation.y = -gmstRad(simMs);
      cloudMesh.rotation.y += realDtSec * 0.0006;      // cosmetic drift
      rideU.uCloudRot.value = cloudMesh.rotation.y;
      glare.position.copy(sun).multiplyScalar(80);
      skyGroup.rotation.y = stars.rotation.y;
    },
    cloudMesh,
    /** Ride-along rendering. k = 0 (orbit view) .. 1 (fully in the low-orbit look). */
    rideFx: {
      setAmount(k, { softwareGL = false } = {}) {
        k = Math.max(0, Math.min(1, k));
        const on = k > 0.001;
        rideU.uRide.value = k;
        rideU.uSteps.value = softwareGL ? 9 : 20;
        skyMesh.visible = glareMesh.visible = starPts.visible = on;
        atmo.material.uniforms.uFade.value = 1 - k;
        atmo.visible = k < 0.999;
        glare.material.opacity = 0.7 * (1 - k);
        glare.visible = k < 0.999;
        const s = (cloudR0 + (cloudR1 - cloudR0) * k) / cloudR0;
        cloudMesh.scale.setScalar(s);
      },
      /** per-frame: camera matrices for the full-screen passes, Sun visibility (0 hidden behind the planet .. 1), star exposure */
      update(camera, sunVis, starVis, dpr) {
        camU.uInvProj.value.copy(camera.projectionMatrixInverse);
        camU.uCamWorld.value.copy(camera.matrixWorld);
        sunVisU.value = sunVis;
        starPts.material.uniforms.uVis.value = starVis * rideU.uRide.value;
        starPts.material.uniforms.uPx.value = dpr;
        const k = rideU.uRide.value, f = 1 - k * (1 - (0.10 + 0.55 * starVis));
        stars.material.color.copy(starsBase).multiplyScalar(f);
      },
      /** finer spheres while riding so the limb is round and the relief is not faceted */
      setDetailGeometry(on) {
        if (on && !hiGeo) {
          hiGeo = { earth: new THREE.SphereGeometry(1, 288, 192), cloud: new THREE.SphereGeometry(1.0065, 192, 128) };
          earth.geometry = hiGeo.earth; cloudMesh.geometry = hiGeo.cloud;
        } else if (!on && hiGeo) {
          earth.geometry = geoNormal.earth; cloudMesh.geometry = geoNormal.cloud;
          hiGeo.earth.dispose(); hiGeo.cloud.dispose(); hiGeo = null;
        }
      },
      upgradeNow: () => (wantHiRes(renderer) ? upgrade() : undefined),
      ensureNoise() { if (!noiseBuilt) { noiseBuilt = true; noiseU.value = createNoise3D(THREE); } },
    },
  };
}
