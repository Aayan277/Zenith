// Shader for imagery tile patches. Lighting is the Earth's own (earthShade from ../surface.js): only where the albedo comes from
// differs. Per tile the day (and, for GIBS tiles, night) colour is a cross-fade between the PREVIOUS texture (typically the parent
// tile's sub-region, via a uv transform) and the CURRENT one, so a tile that arrives dissolves in over what was there (300 ms) and
// a tile with nothing underneath dissolves in over the base globe (alpha).
import { GLSL_NOISE, GLSL_ATMO, GLSL_CLOUD } from '../atmo.js';
import { GLSL_SURFACE } from '../surface.js';

export const TILE_VERT = /* glsl */`
  attribute vec2 aUvb;
  varying vec3 vN; varying vec2 vUv; varying vec3 vW; varying vec2 vT;
  void main() {
    vT = uv; vUv = aUvb;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

export const TILE_FRAG = /* glsl */`
  uniform sampler2D uDayC, uDayP, uNightC, uNightP, uWater;
  uniform vec4 uXfDC, uXfDP, uXfNC, uXfNP;          // uv transform (offset xy, scale zw) into the displayed texture
  uniform float uDayK, uDayHasP;                    // cross-fade 0..1; 1 when a previous texture exists
  uniform float uNightK, uNightHas, uNightHasP;     // night: base map -> tile (or previous tile -> tile)
  uniform float uGlobal;                            // layer opacity (zoom fade)
  uniform float uTilePx, uTexelW, uDetail, uLights, uDuskFade, uSeaFade, uBlueLo, uBlueHi, uPriorLod, uPriorK;
  uniform vec3 uGamma, uGain, uOcean;
  uniform float uSat, uOceanRef;
  uniform float uTexel, uPxK, uFeather;
  ${GLSL_NOISE}
  ${GLSL_ATMO}
  ${GLSL_CLOUD}
  ${GLSL_SURFACE}
  varying vec3 vN; varying vec2 vUv; varying vec3 vW; varying vec2 vT;

  void main() {
    vec3 N = normalize(vN);
    // fragments whose ray misses the unit sphere (the lifted shell sticks out ~2 km past the limb) belong to the base globe's silhouette
    vec3 ro = cameraPosition, rd = normalize(vW - ro);
    float bb = dot(ro, rd);
    if (bb * bb - (dot(ro, ro) - 1.0) < 0.0) discard;

    float fp = 0.0;
    vec2 t = vT, uvw = vUv;
    if (uRide > 0.001) {
      fp = length(fwidth(vW));
      vec2 w = rideWobble(N, fp);
      uvw = vUv + w * uTexel * 1.3 * uRide;
      // magnified imagery: wobble the lookup by up to a texel, like the base maps
      float s = uXfDC.z;
      float mag = clamp(uTexelW / s / max(fp, 1e-9) - 0.7, 0.0, 1.0);
      t = vT + w * (1.0 / (uTilePx * s)) * 1.3 * mag * uRide;
    }

    vec3 c = texture2D(uDayC, t * uXfDC.zw + uXfDC.xy).rgb;
    float a = 1.0;
    if (uDayHasP > 0.5) c = mix(texture2D(uDayP, t * uXfDP.zw + uXfDP.xy).rgb, c, uDayK);
    else a = uDayK;

    // water: blue + dark in the tile, near an ocean in the (blurred) base mask. Oceans take the base globe's ocean tone,
    // modulated by the tile's own shading (bathymetry, shallows); land is graded to the base texture's look.
    vec3 s = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
    float wm = smoothstep(uBlueLo, uBlueHi, s.b - max(s.r, s.g));
    float bright = 1.0 - smoothstep(0.30, 0.60, max(max(s.r, s.g), s.b));
    float prior = clamp(textureLod(uWater, vUv, uPriorLod).r * uPriorK, 0.0, 1.0);
    // wide, forgiving ocean mask used only to hand the deep layer's (blocky, low-resolution) open-ocean pixels over to GIBS
    float seaMask = smoothstep(0.0, 0.03, s.b - max(s.r, s.g)) * bright * prior;
    wm *= bright * prior;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 land = pow(max(c, vec3(1e-4)), uGamma) * uGain;
    land = mix(vec3(dot(land, vec3(0.2126, 0.7152, 0.0722))), land, uSat);
    vec3 sea = uOcean * clamp(pow(lum / uOceanRef, 0.35), 0.5, 1.8);
    vec3 day = mix(land, sea, wm);

    vec3 night = texture2D(uNight, uvw).rgb;
    if (uNightHas > 0.5) {
      vec3 nc = texture2D(uNightC, t * uXfNC.zw + uXfNC.xy).rgb;
      vec3 nprev = uNightHasP > 0.5 ? texture2D(uNightP, t * uXfNP.zw + uXfNP.xy).rgb : night;
      night = mix(nprev, nc, uNightK);
    }

    vec3 col = earthShade(day, night, wm, N, vUv, uvw, vW, fp, uDetail, uLights);
    // day-only overlays (no night imagery) dissolve into the GIBS layer underneath towards the dark side
    a *= uGlobal * mix(1.0, smoothstep(-0.10, 0.06, dot(N, normalize(uSun))), uDuskFade);
    // deep layer: its ocean pixels hand over to the GIBS ocean (one ocean tone everywhere, no layer seam over water)
    a *= 1.0 - uSeaFade * seaMask;
    // deep layer: dissolve in where the finest GIBS texel exceeds ~1 screen pixel (soft edge instead of a tile-shaped patch)
    if (uFeather > 0.0) a *= smoothstep(0.6, 1.2, uFeather * uPxK / length(vW - cameraPosition));
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
