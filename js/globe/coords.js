// Globe coordinate conventions.
//
// Scene units: 1 unit = Earth radius = 6371 km. The scene is EARTH-FIXED (ECEF); the Earth
// mesh never rotates, the Sun (and the star sphere) move instead.
//
//   ECEF (x,y,z) km   x -> lon 0 / lat 0,  y -> lon 90E,  z -> north pole
//   scene (X,Y,Z)     X =  ecef.x,  Y = ecef.z (north = +Y),  Z = -ecef.y
//   => lat/lon -> scene:  ( cos(lat)cos(lon),  sin(lat),  -cos(lat)sin(lon) ) * r
//
// This is a proper rotation (det +1) and matches THREE.SphereGeometry UVs for an equirectangular
// texture centred on lon 0: u = 0.5 + lon/360 lands on +X, u = 0.75 (90E) on -Z.
// TEME/inertial vectors become scene vectors the same way, then Group.rotation.y = -GMST.
import * as THREE from 'three';

export const R_KM = 6371;
const D2R = Math.PI / 180;

export function latLonToVec(latDeg, lonDeg, r = 1, out = new THREE.Vector3()) {
  const la = latDeg * D2R, lo = lonDeg * D2R, c = Math.cos(la);
  return out.set(c * Math.cos(lo) * r, Math.sin(la) * r, -c * Math.sin(lo) * r);
}
export function vecToLatLon(v) {
  const r = Math.hypot(v.x, v.y, v.z) || 1;
  return { lat: Math.asin(v.y / r) / D2R, lon: Math.atan2(-v.z, v.x) / D2R };
}
export function ecefKmToScene(x, y, z, out = new THREE.Vector3()) {
  return out.set(x / R_KM, z / R_KM, -y / R_KM);
}

/** Greenwich mean sidereal time, radians. */
export function gmstRad(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  let g = (280.46061837 + 360.98564736629 * d) % 360;
  if (g < 0) g += 360;
  return g * D2R;
}

/** Sun unit vector in the Earth-fixed scene frame (low-precision, ~0.01 deg). */
export function sunSceneVec(ms, out = new THREE.Vector3()) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * d) * D2R;
  const g = (357.528 + 0.9856003 * d) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * d) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ex = Math.cos(dec) * Math.cos(ra), ey = Math.cos(dec) * Math.sin(ra), ez = Math.sin(dec);
  const th = gmstRad(ms), c = Math.cos(th), s = Math.sin(th);
  const x = c * ex + s * ey, y = -s * ex + c * ey;   // ECEF
  return out.set(x, ez, -y);
}

/** Angular radius (rad) of the footprint on the ground from which a satellite at altKm is above the horizon. */
export function horizonAngle(altKm) { return Math.acos(R_KM / (R_KM + altKm)); }
