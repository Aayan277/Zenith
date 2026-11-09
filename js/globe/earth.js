// Earth, clouds, atmosphere, star sphere and sun glare. All custom shaders; lighting is done in
// linear space and encoded with <colorspace_fragment>.
import * as THREE from 'three';
import { sunSceneVec, gmstRad } from './coords.js';

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
  uniform vec3 uSun;
  varying vec3 vN; varying vec2 vUv; varying vec3 vW;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec3 N = normalize(vN);
    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vW);
    float ndl = dot(N, L);
    float ndv = max(dot(N, V), 0.0);

    vec3 day = texture2D(uDay, vUv).rgb;
    vec3 night = texture2D(uNight, vUv).rgb;
    float water = texture2D(uWater, vUv).r;
    float cloud = texture2D(uCloud, vUv).r;

    // soft terminator
    float daylight = smoothstep(-0.14, 0.34, ndl);
    float diffuse = mix(0.0, 1.0, daylight);
    // land gets a touch of contrast, oceans a bit deeper
    vec3 albedo = day * mix(vec3(1.0), vec3(0.78, 0.9, 1.05), water * 0.5);
    vec3 col = albedo * (diffuse * 1.18);
    // faint moon/starlight ambient on the night side so continents are readable
    col += albedo * vec3(0.010, 0.016, 0.036) * (1.0 - daylight);

    // city lights: warm, hidden by clouds and by daylight
    float darkness = 1.0 - smoothstep(-0.20, 0.10, ndl);
    float nl = luma(night);
    vec3 lights = mix(night, vec3(nl) * vec3(1.0, 0.70, 0.38), 0.55);
    lights = lights * (1.0 + 2.2 * nl) * 1.7;
    col += lights * darkness * (1.0 - 0.65 * cloud);

    // ocean glint
    vec3 H = normalize(L + V);
    float nh = max(dot(N, H), 0.0);
    float spec = pow(nh, 140.0) * 2.2 + pow(nh, 22.0) * 0.16;
    col += vec3(1.0, 0.92, 0.78) * spec * water * smoothstep(0.0, 0.25, ndl) * (1.0 - 0.7 * cloud);
    // ocean sky-reflection at grazing angles
    float fres = pow(1.0 - ndv, 4.0);
    col += water * fres * vec3(0.10, 0.22, 0.46) * daylight * 0.9;

    // twilight band
    float tw = exp(-pow(ndl / 0.13, 2.0));
    col += vec3(1.0, 0.36, 0.09) * tw * (0.05 + 0.22 * luma(day)) * 0.9;

    // atmospheric haze on the limb
    float rim = pow(1.0 - ndv, 2.6);
    vec3 haze = vec3(0.22, 0.5, 1.0) * (0.10 + 0.9 * daylight) + vec3(1.0, 0.45, 0.18) * tw * 0.5;
    col += haze * rim * 0.85;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const CLOUD_FRAG = /* glsl */`
  uniform sampler2D uCloud;
  uniform vec3 uSun;
  varying vec3 vN; varying vec2 vUv; varying vec3 vW;
  void main() {
    vec3 N = normalize(vN);
    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vW);
    float ndl = dot(N, L);
    float c = texture2D(uCloud, vUv).r;
    float dens = smoothstep(0.05, 0.95, c);
    float daylight = smoothstep(-0.10, 0.30, ndl);
    float tw = exp(-pow(ndl / 0.12, 2.0));
    vec3 base = mix(vec3(0.010, 0.014, 0.026), vec3(1.0, 1.0, 1.0), daylight);
    base = mix(base, vec3(1.0, 0.52, 0.28), tw * 0.55);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    base += vec3(0.2, 0.4, 0.8) * rim * 0.25 * daylight;
    float a = dens * 0.88;
    gl_FragColor = vec4(base, a);
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
  uniform float uShell;
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
    gl_FragColor = vec4(col * g, 1.0);
    #include <colorspace_fragment>
  }`;

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
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
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

  // Earth
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 96),
    new THREE.ShaderMaterial({
      uniforms: { uDay: { value: day }, uNight: { value: night }, uWater: { value: water }, uCloud: { value: clouds }, uSun: sunU },
      vertexShader: COMMON_VERT, fragmentShader: EARTH_FRAG,
    }));
  earth.name = 'earth';
  root.add(earth);

  // Clouds (cosmetic drift)
  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.0065, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: { uCloud: { value: clouds }, uSun: sunU },
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
      uniforms: { uSun: sunU, uShell: { value: SHELL } },
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

  // Desktop-only upgrade to 4096 px day/night maps, after the page has settled.
  if (wantHiRes(renderer)) {
    const uniforms = earth.material.uniforms;
    const upgrade = async () => {
      try {
        const [d, n] = await Promise.all([
          loadTexture(loader, 'earth-day-4k.webp', { srgb: true, anisotropy: aniso }),
          loadTexture(loader, 'earth-night-4k.webp', { srgb: true, anisotropy: aniso }),
        ]);
        const [od, on] = [uniforms.uDay.value, uniforms.uNight.value];
        uniforms.uDay.value = d; uniforms.uNight.value = n;
        od.dispose(); on.dispose();
      } catch (e) { console.warn('[earth] hi-res textures unavailable', e); }
    };
    setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(upgrade, { timeout: 3000 }) : upgrade()), 5000);
  }

  return {
    root, earth, sun,
    /** simMs: simulation time (ms) */
    update(simMs, realDtSec) {
      sunSceneVec(simMs, sun);
      stars.rotation.y = -gmstRad(simMs);
      cloudMesh.rotation.y += realDtSec * 0.0006;      // cosmetic drift
      glare.position.copy(sun).multiplyScalar(80);
    },
  };
}
