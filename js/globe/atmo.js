// GLSL chunks for "Ride along" (low-orbit view). Scene units: 1 = 6371 km, Earth centred on the origin.
//
//   GLSL_NOISE  hash/value noise + footprint-faded fbm (detail that fades out when it drops below a pixel)
//   GLSL_ATMO   single-scattering ray-marched atmosphere (Rayleigh + a little Mie) with Earth shadow and
//               sun transmittance, used for the limb/sky pass AND the aerial perspective on ground/cloud pixels
//   GLSL_CLOUD  cloud density with fractal erosion (ride mode) shared by the ground (shadows) and cloud shell
//
// Every shader that includes GLSL_ATMO must not declare uSun / uRide / uSteps itself.

export const GLSL_NOISE = /* glsl */`
  precision highp sampler3D;
  uniform sampler3D uNoise;                        // 128^3 white noise, see createNoise3D()
  float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  // value noise with smootherstep interpolation, done as ONE filtered fetch (the hardware lerp does the 8-corner blend)
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return texture(uNoise, (i + f + 0.5) * (1.0 / 128.0)).r;
  }
  const mat3 NROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  float fbmG(vec3 d, float f0, int oct, float fp, float gain) {
    float a = 0.5, s = 0.0, f = f0;
    vec3 p = d * f0;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      float w = 1.0 - smoothstep(0.28, 0.75, fp * f);
      if (w < 0.001) break;                       // finer octaves are faded out too
      s += a * w * (vnoise(p + float(i) * 13.7) * 2.0 - 1.0);
      a *= gain; f *= 2.03; p = NROT * p * 2.03;
    }
    return s * 1.25;
  }
  float fbmF(vec3 d, float f0, int oct, float fp) { return fbmG(d, f0, oct, fp, 0.5); }
  vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
`;

export const GLSL_ATMO = /* glsl */`
  uniform vec3 uSun;
  uniform float uRide;
  uniform int uSteps;
  const float A_HS = 0.0016;                       // Rayleigh scale height (~10 km)
  const float A_TOP = 1.0230;                      // top of the modelled atmosphere (~146 km)
  const vec3 A_BETA = vec3(36.9, 86.0, 211.0);     // Rayleigh extinction per scene unit (5.8, 13.5, 33.1 per Mm... scaled)
  const float A_HM = 0.00050, A_BM = 150.0;        // aerosol scale height / extinction
  const float A_I0 = 7.0;                          // sun intensity

  float aRho(float h) { return exp(-max(h, 0.0) / A_HS); }

  // Sunlight arriving at p (colour): reddens towards the terminator, goes dark in Earth's shadow.
  vec3 sunTransAt(vec3 p) {
    float r = length(p), mu = dot(p, uSun) / r, h = r - 1.0;
    float D;
    if (mu >= 0.0) D = aRho(h) * A_HS / (mu + 0.0305);
    else {
      float ht = r * sqrt(max(1.0 - mu * mu, 0.0)) - 1.0;
      float vis = smoothstep(-0.0012, 0.0005, ht);
      float k = 2.0 - exp(-max(h - ht, 0.0) / (0.8 * A_HS));
      D = aRho(ht) * A_HS * 32.0 * k;
      return exp(-A_BETA * D) * vis;
    }
    return exp(-A_BETA * D);
  }

  float phaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
  float phaseM(float mu) { const float g = 0.74; float d = 1.0 + g * g - 2.0 * g * mu; return 0.0795775 * (1.0 - g * g) / (d * sqrt(d)); }

  // In-scatter S and transmittance T along ro + rd * t, t in [0, tmax].
  void aMarch(vec3 ro, vec3 rd, float tmax, int N, out vec3 S, out vec3 T) {
    S = vec3(0.0); T = vec3(1.0);
    float b = dot(ro, rd), rr = dot(ro, ro);
    float disc = b * b - (rr - A_TOP * A_TOP);
    if (disc <= 0.0) return;
    float sq = sqrt(disc);
    float t0 = max(-b - sq, 0.0), t1 = min(-b + sq, tmax);
    float disc2 = b * b - (rr - 1.0);
    if (disc2 > 0.0) { float tg = -b - sqrt(disc2); if (tg > 0.0) t1 = min(t1, tg); }
    if (t1 <= t0) return;
    float tc = clamp(-b, t0, t1);
    float L = tc - t0, R = t1 - tc;
    int nL;
    if (L < 1e-6) nL = 0; else if (R < 1e-6) nL = N; else nL = clamp(int(float(N) * L / (L + R) + 0.5), 1, N - 1);
    int nR = N - nL;
    float mu = dot(rd, uSun);
    float pr = phaseR(mu), pm = phaseM(mu);
    for (int i = 0; i < 48; i++) {
      if (i >= N) break;
      float t, ds;
      if (i < nL) { float w = (float(i) + 0.5) / float(nL), q = 1.0 - w; t = tc - L * q * q; ds = 2.0 * L * q / float(nL); }
      else { float w = (float(i - nL) + 0.5) / float(nR); t = tc + R * w * w; ds = 2.0 * R * w / float(nR); }
      vec3 p = ro + rd * t;
      float h = length(p) - 1.0;
      float rho = aRho(h), rhoM = exp(-max(h, 0.0) / A_HM);
      vec3 ext = A_BETA * rho * ds + vec3(A_BM * rhoM * ds);
      vec3 stepT = exp(-ext);
      vec3 sun = sunTransAt(p) * A_I0;
      vec3 srcR = A_BETA * rho * pr, srcM = vec3(A_BM * rhoM * pm);
      vec3 src = (srcR + srcM) * sun / max(A_BETA * rho + vec3(A_BM * rhoM), vec3(1e-6));
      src += vec3(0.010, 0.024, 0.060);                // starlight / airglow / city glow scattered by the air: the faint night limb
      S += T * (vec3(1.0) - stepT) * src;
      T *= stepT;
    }
  }
`;

// Cloud density. uCloud is the coverage map; in ride mode its blur is eroded with fractal noise. dObj is the
// direction in the cloud layer's own (drifting) frame, uv is the cloud-frame texture coordinate.
export const GLSL_CLOUD = /* glsl */`
  float cloudDens(sampler2D tex, vec2 uv, vec3 dObj, float fp, out float shape) {
    float c = texture2D(tex, uv).r;
    shape = 0.0;
    if (uRide < 0.001) return smoothstep(0.05, 0.95, c);
    float n = fbmG(dObj, 130.0, 6, fp, 0.56);
    shape = n;
    float cc = c + n * 0.48 * smoothstep(0.03, 0.40, c) - 0.04 * (1.0 - c);
    float dRide = smoothstep(0.26, 0.60, cc);
    return mix(smoothstep(0.05, 0.95, c), dRide, uRide);
  }
`;

/** Tileable white-noise volume for the ride shaders (built lazily on the first ride). */
export function createNoise3D(THREE, size = 128) {
  const n = size * size * size, d = new Uint8Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; d[i] = seed >>> 24; }
  const t = new THREE.Data3DTexture(d, size, size, size);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}
export function dummyNoise3D(THREE) {
  const t = new THREE.Data3DTexture(new Uint8Array([128]), 1, 1, 1);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.NearestFilter; t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}
