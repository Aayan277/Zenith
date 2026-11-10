// Curved imagery patch: a (N+1)x(N+1) grid on the unit sphere from a tile's lat/lon bounds, plus a one-row skirt that hangs
// below the edges so a coarse tile next to a finer one never shows a crack (chord sag of the coarse edge).
//
// Per vertex: position (radius 1 + lift), normal (radial), uv (tile texture space, v = 0 at the SOUTH edge, matching bitmaps
// decoded with imageOrientation 'flipY'), aUvb (equirectangular uv on the BASE maps: clouds, water prior, base night lights).
import * as THREE from 'three';
import { latAt } from './sources.js';

const D2R = Math.PI / 180;
const SKIRT = 6e-4;                         // radial drop of the skirt (about 3.8 km)

const indexCache = new Map();
/** Shared, topology-only index buffer for a given N. Winding is checked on a flat, front-facing grid. */
function patchIndex(N) {
  let ia = indexCache.get(N);
  if (ia) return ia;
  const W = N + 1, main = W * W;
  const idx = [];
  const g = (i, j) => j * W + i;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = g(i, j), b = g(i, j + 1), c = g(i + 1, j), d = g(i + 1, j + 1);
    idx.push(a, b, c, c, b, d);
  }
  // skirt rings: 4 edges, each W vertices (copies of the edge vertices, lowered)
  const sk = (e, k) => main + e * W + k;
  const edgeV = [(k) => g(k, 0), (k) => g(N, k), (k) => g(N - k, N), (k) => g(0, N - k)];   // N->E->S->W, so the tile is on the right of travel
  // flat positions to decide winding: x = i (east), y = N - j (north), z = depth (skirt below = -1, viewer at +z)
  const flat = (v) => { if (v < main) return [v % W, N - Math.floor(v / W), 0]; const e = Math.floor((v - main) / W), k = (v - main) % W, base = edgeV[e](k); return [base % W, N - Math.floor(base / W), -1]; };
  const outward = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let e = 0; e < 4; e++) for (let k = 0; k < N; k++) {
    const t0 = edgeV[e](k), t1 = edgeV[e](k + 1), b0 = sk(e, k), b1 = sk(e, k + 1);
    for (const tri of [[t0, t1, b0], [t1, b1, b0]]) {
      const p = tri.map(flat);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
      const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
      if (nx * outward[e][0] + ny * outward[e][1] < 0) tri.reverse();
      idx.push(tri[0], tri[1], tri[2]);
    }
  }
  ia = new THREE.BufferAttribute(new Uint16Array(idx), 1);
  indexCache.set(N, ia);
  return ia;
}

/** @param b bounds from sources.bounds(); @param lift radial lift above the unit sphere */
export function buildPatch(b, N, lift) {
  const W = N + 1, main = W * W, total = main + 4 * W;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2), uvb = new Float32Array(total * 2);
  const put = (n, lat, lon, u, v, r) => {
    const la = lat * D2R, lo = lon * D2R, c = Math.cos(la), x = c * Math.cos(lo), y = Math.sin(la), z = -c * Math.sin(lo);
    pos[n * 3] = x * r; pos[n * 3 + 1] = y * r; pos[n * 3 + 2] = z * r;
    nor[n * 3] = x; nor[n * 3 + 1] = y; nor[n * 3 + 2] = z;
    uv[n * 2] = u; uv[n * 2 + 1] = 1 - v;
    uvb[n * 2] = (lon + 180) / 360; uvb[n * 2 + 1] = (lat + 90) / 180;
  };
  const r0 = 1 + lift, r1 = r0 - SKIRT;
  for (let j = 0; j <= N; j++) {
    const v = j / N, lat = latAt(b, v);
    for (let i = 0; i <= N; i++) { const u = i / N; put(j * W + i, lat, b.lonW + (b.lonE - b.lonW) * u, u, v, r0); }
  }
  const edges = [(k) => [k, 0], (k) => [N, k], (k) => [N - k, N], (k) => [0, N - k]];
  for (let e = 0; e < 4; e++) for (let k = 0; k <= N; k++) {
    const [i, j] = edges[e](k), v = j / N, u = i / N;
    put(main + e * W + k, latAt(b, v), b.lonW + (b.lonE - b.lonW) * u, u, v, r1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aUvb', new THREE.BufferAttribute(uvb, 2));
  g.setIndex(patchIndex(N));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);       // culling is done by the quadtree, not by three
  return g;
}
