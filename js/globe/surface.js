// Shared Earth surface lighting, used by the base globe (earth.js) AND by every imagery tile patch (tiles/).
//
//   earthShade(day, night, water, N, vUv, uvw, vW, fp, detail, lights)  ->  linear colour, before tone mapping
//
//     day, night   linear albedo / city-light colour (sampled by the caller: base maps or tile textures)
//     water        0..1 ocean mask (glint, ocean colour, ride land/sea detail)
//     N, vW        unit surface normal and world position of the fragment
//     vUv          equirectangular uv of the fragment on the BASE maps (clouds are always read from the base cloud map)
//     uvw          vUv wobbled for ride mode (used for the blurred base night lookups)
//     fp           pixel footprint in world units (length(fwidth(vW))), only needed (and only valid) when uRide > 0
//     detail       0..1 how much procedural ride-mode ground detail to add (1 = base globe, less over real imagery)
//     lights       0..1 multiplier of the city-light term (0 for day-only overlays)
//
// The caller declares uDay/uWater (or its tile samplers) itself. This chunk declares uCloud, uNight (the BASE night map,
// used for the blurred lights lookups in ride mode), uCloudRot and uCloudFade.
// Requires GLSL_NOISE + GLSL_ATMO + GLSL_CLOUD to be included first (it uses fbmF, aMarch, sunTransAt, cloudDens, uSun, uRide, uSteps).

export const GLSL_SURFACE = /* glsl */`
  uniform sampler2D uCloud, uNight;
  uniform float uCloudRot, uCloudFade;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  // ride mode: a wobble of the texture lookup breaks up the bilinear blur of magnified maps
  vec2 rideWobble(vec3 N, float fp) { return vec2(fbmF(N, 150.0, 3, fp), fbmF(N + 7.1, 150.0, 3, fp)); }

  vec3 earthShade(vec3 day, vec3 night, float water, vec3 N, vec2 vUv, vec2 uvw, vec3 vW, float fp, float detail, float lights) {
    vec3 L = normalize(uSun);
    vec3 V = normalize(cameraPosition - vW);
    float ndl = dot(N, L);
    float ndv = max(dot(N, V), 0.0);
    float rideK = uRide;                         // 0 in the normal orbit view: every ride branch below is skipped

    float cloudSh = 0.0, hgt = 0.0, dl = 0.0;
    vec3 Nb = N;
    vec3 tint = vec3(1.0);
    vec3 N0 = N;
    vec2 uvc = vUv - vec2(uCloudRot / 6.2831853, 0.0);
    float cloud;
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
      float rd = rideK * detail;
      day *= 1.0 + (dl * 0.62 + dl2 * 0.38) * (0.38 + 0.55 * land) * rd - (ridge * ridge - 0.45) * 0.42 * land * rd - (ridgeL * ridgeL * ridgeL - 0.35) * 0.35 * land * rd;
      day = mix(day, day * day * (3.0 - 2.0 * day), 0.45 * rideK);       // contrast
      day = mix(vec3(luma(day)), day, 1.0 + 0.45 * rideK);               // saturation
      day = mix(day, day * vec3(1.06, 1.02, 0.90), clamp(dl * 0.5 + 0.5, 0.0, 1.0) * land * rd * 0.5);
      vec3 dpdx = dFdx(vW), dpdy = dFdy(vW);
      vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
      float det = dot(dpdx, r1);
      vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
      Nb = normalize(abs(det) * N - 0.00045 * (0.25 + 0.75 * land) * grad * rideK * detail);
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
        cloudSh = smoothstep(0.06, 0.45, cs) * 0.36 * smoothstep(0.02, 0.2, ndl) * rideK * uCloudFade;     // only under real cloud, never from the faint haze values of the coverage map
      }
    } else {
      cloud = texture2D(uCloud, uvc).r;
    }
    cloud *= uCloudFade;
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
    vec3 lights0 = mix(night, vec3(nl) * vec3(1.0, 0.70, 0.38), 0.55);
    lights0 = lights0 * (1.0 + 2.2 * nl) * 1.7;
    vec3 lightsOut = lights0;
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
      lightsOut = mix(lights0, lit2 + halo, rideK);
    }
    col += lightsOut * lights * darkness * (1.0 - mix(0.65, 0.82, rideK) * cloud);

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
    return col;
  }
`;
