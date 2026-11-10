// Streaming imagery tiles over the globe ("Google-Earth style" level of detail).
//
//   const tiles = createTiles({ THREE, renderer, root, shared, sun, softwareGL, pinned })
//   tiles.update(camera, dtSec, nowMs)    every rendered frame, after the camera is final; returns { animating, visible, hideBase }
//   tiles.suspend() / tiles.resume()       view or tab hidden: abort requests, stop selecting
//   tiles.setQuality(tier)                 adaptive-quality tier from globe.js (coarser selection, no deep layer on the lowest tiers)
//
// Two independent quadtrees ("layers"), drawn on top of the always-present base globe:
//   A  GIBS Blue Marble (EPSG:4326, z 3..7) + GIBS VIIRS night lights for dark tiles
//   B  EOX Sentinel-2 cloudless (EPSG:3857, z 9..15), only where its texels are finer than GIBS's, day side only
// Each frame a layer's quadtree is cut by screen-space error (texel size in screen pixels), horizon and frustum culling. Each
// selected tile is a curved patch whose texture is the best loaded ANCESTOR sub-region until its own image arrives, then the two
// cross-fade. Textures live in an LRU cache (count + byte caps); decoded bitmaps are uploaded under a per-frame time budget.
import { SOURCES, bounds, latAt, texelRad, rootTiles, MERC_MAX_LAT } from './sources.js';
import { buildPatch } from './patch.js';
import { TileLoader } from './loader.js';
import { TILE_VERT, TILE_FRAG } from './shader.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- tunables (also reachable through tiles.params for measuring) ----
export const PARAMS = {
  startDist: 2.5,          // tiles are requested / drawn below this camera distance (Earth radii); they fade in from startDist+0.1 to startDist-0.25
  fadeMs: 300,             // cross-fade of an arriving tile
  thrA: 1.4,               // refine while a texel covers more than this many screen pixels (layer A, GIBS)
  thrB: 0.85,              // same for layer B (Sentinel-2): lower, it should only appear where it clearly beats GIBS
  concurrency: 6,
  maxTiles: 256,           // LRU cap on tiles holding GPU textures
  maxBytes: 224 * 1024 * 1024,
  uploadBudgetMs: 3,       // texture uploads per frame (at least one)
  maxZA: 7, maxZB: 15,
  enableB: true,
  liftA: 4e-4, liftB: 6e-4,
};

// Colour grading: fitted (log-domain regression in linear light, land pixels worldwide) so the tiles match the base day texture,
// then judged by eye. day = pow(tile, gamma) * gain, then saturation. Oceans are re-toned separately in the shader.
const GRADE = {
  bm: { gamma: [0.707, 0.707, 0.707], gain: [1.18, 1.16, 1.10], sat: 0.88, ocean: [0.0130, 0.0436, 0.181], oceanRef: 0.012 },
  s2: { gamma: [0.62, 0.64, 1.0], gain: [0.80, 0.78, 1.30], sat: 0.88, ocean: [0.0130, 0.0436, 0.181], oceanRef: 0.012 },
};

export function createTiles({ THREE, renderer, root, shared, sun, softwareGL = false, pinned = false }) {
  const V3 = THREE.Vector3, V4 = THREE.Vector4;
  const params = { ...PARAMS };
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const group = new THREE.Group(); group.name = 'tiles'; group.visible = false;
  root.add(group);

  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  dummy.needsUpdate = true;

  const state = {
    enabled: true, suspended: false, frame: 0, tier: 0,
    emitted: 0, emittedA: 0, emittedB: 0, visited: 0, cached: 0, bytes: 0, pending: 0,
    uploads: 0, uploadMs: 0, maxUploadMs: 0, selectMs: 0, lastSelectMs: 0, failures: 0, visible: false, hideBase: false,
    maxLevel: { a: 0, b: 0 }, glRate: 0,
  };

  // ---------------------------------------------------------------------------------------------- tiles & layers
  const latLon = (lat, lon, out) => { const la = lat * D2R, lo = lon * D2R, c = Math.cos(la); return out.set(c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo)); };
  const chan = () => ({ cur: null, curXf: new V4(0, 0, 1, 1), prev: null, prevXf: new V4(0, 0, 1, 1), k: 1 });

  class Tile {
    constructor(layer, z, x, y) {
      const src = layer.src;
      this.layer = layer; this.src = src; this.z = z; this.x = x; this.y = y;
      this.key = `${src.id}/${z}/${x}/${y}`; this.keyN = this.key + ':n';
      const b = this.b = bounds(src, z, x, y);
      const latM = latAt(b, 0.5), lonM = (b.lonW + b.lonE) / 2;
      this.center = latLon(latM, lonM, new V3());
      let rho = 0;
      const p = new V3();
      for (const [v, u] of [[0, 0], [0, 1], [1, 0], [1, 1], [0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1]]) {
        latLon(latAt(b, v), b.lonW + (b.lonE - b.lonW) * u, p);
        rho = Math.max(rho, Math.acos(clamp(this.center.dot(p), -1, 1)));
      }
      this.rho = rho * 1.02 + 1e-6;
      if (this.rho < Math.PI / 2) { this.sphereC = this.center.clone().multiplyScalar(Math.cos(this.rho)); this.sphereR = Math.sin(this.rho); }
      else { this.sphereC = new V3(); this.sphereR = 1; }
      this.texel = texelRad(src, z, latM);
      this.tex = { day: null, night: null };
      this.fail = { day: null, night: null };
      this.pend = { day: false, night: false };         // decoded, waiting for its GPU upload
      this.bytes = 0;
      this.mesh = null; this.mat = null;
      this.disp = { day: chan(), night: chan() };
      this.lastUsed = 0; this.lastEmit = -1e9; this.split = false; this.dark = false;
    }
    parent() { return this.z > this.layer.minReq ? this.layer.get(this.z - 1, this.x >> 1, this.y >> 1) : null; }
    child(i) { return this.layer.get(this.z + 1, this.x * 2 + (i & 1), this.y * 2 + (i >> 1)); }
    hasTex() { return !!(this.tex.day || this.tex.night); }
  }

  const pxKU = { value: 1000 };
  function makeLayer(src, o) {
    const gr = GRADE[src.id] || GRADE.bm;
    const layer = {
      src, tiles: new Map(), roots: null, order: o.order, lift: o.lift, minReq: o.minReq, thr: 1, maxZ: src.maxZ, on: true,
      u: {   // uniforms shared by every tile of this layer
        uGamma: { value: new V3(...gr.gamma) }, uGain: { value: new V3(...gr.gain) }, uSat: { value: gr.sat },
        uOcean: { value: new V3(...gr.ocean) }, uOceanRef: { value: gr.oceanRef },
        uGlobal: { value: 0 }, uTilePx: { value: src.tilePx }, uDetail: { value: o.detail },
        uLights: { value: o.lights }, uDuskFade: { value: o.duskFade }, uPxK: pxKU, uFeather: { value: 0 }, uSeaFade: { value: o.duskFade }, uBlueLo: { value: o.blue[0] }, uBlueHi: { value: o.blue[1] }, uPriorLod: { value: o.prior[0] }, uPriorK: { value: o.prior[1] },
      },
      get(z, x, y) { const k = `${src.id}/${z}/${x}/${y}`; let t = this.tiles.get(k); if (!t) { t = new Tile(layer, z, x, y); this.tiles.set(k, t); } return t; },
      emit: [], glob: 0,
    };
    if (src.roots > 0) layer.roots = rootTiles(src).map(([z, x, y]) => layer.get(z, x, y));
    else layer.roots = [layer.get(0, 0, 0)];
    return layer;
  }
  const layerA = makeLayer(SOURCES.bm, { order: -4, lift: params.liftA, minReq: SOURCES.bm.roots, detail: 0.6, lights: 1, duskFade: 0, blue: [0.005, 0.04], prior: [2.5, 4] });
  const layerB = makeLayer(SOURCES.s2, { order: -3, lift: params.liftB, minReq: SOURCES.s2.minRender, detail: 0.3, lights: 0, duskFade: 1, blue: [0.035, 0.075], prior: [5, 3] });
  const layers = [layerA, layerB];
  const nightSrc = SOURCES.night;

  function makeMaterial(layer, tile) {
    const u = {
      ...shared, ...layer.u,
      uDayC: { value: dummy }, uDayP: { value: dummy }, uNightC: { value: dummy }, uNightP: { value: dummy },
      uXfDC: { value: new V4(0, 0, 1, 1) }, uXfDP: { value: new V4(0, 0, 1, 1) }, uXfNC: { value: new V4(0, 0, 1, 1) }, uXfNP: { value: new V4(0, 0, 1, 1) },
      uDayK: { value: 0 }, uDayHasP: { value: 0 }, uNightK: { value: 0 }, uNightHas: { value: 0 }, uNightHasP: { value: 0 },
      uTexelW: { value: tile.texel },
    };
    const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: TILE_VERT, fragmentShader: TILE_FRAG, transparent: true, depthWrite: true, depthTest: true });
    return m;
  }
  const patchN = (z) => (z <= 4 ? 32 : z <= 8 ? 16 : 8);
  function ensureMesh(layer, t) {
    if (t.mesh) return t.mesh;
    const geo = buildPatch(t.b, patchN(t.z), layer.lift);
    t.mat = makeMaterial(layer, t);
    const mesh = new THREE.Mesh(geo, t.mat);
    mesh.frustumCulled = false; mesh.renderOrder = layer.order; mesh.visible = false; mesh.matrixAutoUpdate = false;
    mesh.name = t.key;
    group.add(mesh);
    t.mesh = mesh;
    return mesh;
  }
  function freeMesh(t) {
    if (!t.mesh) return;
    group.remove(t.mesh); t.mesh.geometry.dispose(); t.mat.dispose(); t.mesh = null; t.mat = null;
  }
  function freeTex(t) {
    for (const k of ['day', 'night']) {
      const tx = t.tex[k]; if (!tx) continue;
      tx.dispose(); t.tex[k] = null; state.cached--; state.bytes -= tx.userData.bytes || 0;
    }
  }

  // ---------------------------------------------------------------------------------------------- loading
  const ready = [];
  const loader = new TileLoader({
    concurrency: params.concurrency,
    urlOf: (t, kind) => (kind === 'night' ? nightSrc.url(t.z, t.x, t.y) : t.src.url(t.z, t.x, t.y)),
    onReady: (item, decoded) => { item.tile.pend[item.kind] = true; ready.push({ item, decoded }); },
    onFail: (item, err, permanent) => {
      const t = item.tile, f = t.fail[item.kind];
      t.fail[item.kind] = { n: (f ? f.n : 0) + 1, at: performance.now(), perm: permanent };
      state.failures++;
    },
  });
  const failBlocked = (t, kind, now) => {
    const f = t.fail[kind]; if (!f) return false;
    return f.perm || f.n >= 4 || now - f.at < 4000 * 2 ** (f.n - 1);
  };
  function want(t, kind, prio, now) {
    if (t.tex[kind] || t.pend[kind] || failBlocked(t, kind, now)) return;
    loader.want(kind === 'night' ? t.keyN : t.key, prio, now, t, kind);
  }
  function upload(budgetMs) {
    const t0 = performance.now();
    let n = 0;
    while (ready.length) {
      const { item, decoded } = ready.shift();
      const t = item.tile;
      t.pend[item.kind] = false;
      if (t.tex[item.kind] || t.layer.tiles.get(t.key) !== t) { try { decoded.img.close?.(); } catch {} continue; }
      const tx = new THREE.Texture(decoded.img);
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.minFilter = THREE.LinearMipmapLinearFilter; tx.magFilter = THREE.LinearFilter; tx.generateMipmaps = true;
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping; tx.anisotropy = aniso;
      tx.flipY = !decoded.flipped; tx.premultiplyAlpha = false;
      const px = (decoded.img.width || 256) * (decoded.img.height || 256);
      tx.userData.bytes = Math.round(px * 4 * 1.34);
      tx.onUpdate = () => { try { decoded.img.close?.(); } catch {} tx.onUpdate = null; };
      tx.needsUpdate = true;
      try { renderer.initTexture(tx); } catch (e) { console.warn('[tiles] texture upload failed', e); tx.dispose(); continue; }
      t.tex[item.kind] = tx; state.cached++; state.bytes += tx.userData.bytes;
      n++; state.uploads++;
      if (performance.now() - t0 > budgetMs) break;
    }
    if (n) { const dt = performance.now() - t0; state.uploadMs += dt; state.maxUploadMs = Math.max(state.maxUploadMs, dt); }
  }

  // ---------------------------------------------------------------------------------------------- selection
  const P = new V3(), Pn = new V3(), focus = new V3(), sunDir = new V3(), tmp = new V3();
  const sizeV = new THREE.Vector2();
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sphere = new THREE.Sphere();
  let D = 3, horizon = 0, pxK = 1000, nearD = 0.01;

  function visibleTile(t, lift) {
    const ang = Math.acos(clamp(Pn.dot(t.center), -1, 1));
    if (ang - t.rho > horizon + 0.02) return -1;
    sphere.center.copy(t.sphereC); sphere.radius = t.sphereR + lift + 1e-3;
    if (!frustum.intersectsSphere(sphere)) return -1;
    return ang;
  }
  function visit(layer, t) {
    state.visited++;
    const ang = visibleTile(t, layer.lift);
    if (ang < 0) return;
    const phi = Math.max(0, ang - t.rho);
    const d = Math.max(phi < 1e-6 ? D - 1 : Math.sqrt(Math.max(D * D + 1 - 2 * D * Math.cos(phi), 0)), nearD * 1.2, 1e-4);
    const px = t.texel * pxK / d;
    const thr = layer.thr * (t.split ? 0.72 : 1);
    if (t.z < layer.maxZ && px > thr) {
      t.split = true;
      for (let i = 0; i < 4; i++) visit(layer, t.child(i));
      return;
    }
    t.split = false;
    if (t.z < layer.src.minRender) return;
    // darkness of the patch: any point with the Sun below ~7 deg elevation shows city lights
    const angL = Math.acos(clamp(t.center.dot(sunDir), -1, 1));
    t.dark = Math.cos(Math.min(Math.PI, angL + t.rho)) < 0.12;
    if (layer === layerB && Math.cos(Math.max(0, angL - t.rho)) < -0.12) return;          // wholly dark: GIBS shows through
    t.focusAng = Math.acos(clamp(focus.dot(t.center), -1, 1));
    layer.emit.push(t);
  }

  // best loaded texture for tile t on a channel: itself or the nearest ancestor. Returns { tile, xf } or null.
  const xfOut = new V4();
  function bestTexture(t, kind, maxUp = 99) {
    let a = t, up = 0;
    while (a && !a.tex[kind]) { a = a.parent(); if (++up > maxUp) return null; }
    if (!a) return null;
    const n = t.z - a.z, s = 1 / (1 << n);
    const cx = (t.x - a.x * (1 << n)) * s, rf = (t.y - a.y * (1 << n)) * s;
    xfOut.set(cx, 1 - rf - s, s, s);
    return a;
  }
  function recentlyEmitted(t, frame) {
    const p = t.parent(); if (p && p.lastEmit >= frame - 3) return true;
    if (t.z < t.layer.maxZ) for (let i = 0; i < 4; i++) { const c = t.layer.tiles.get(`${t.src.id}/${t.z + 1}/${t.x * 2 + (i & 1)}/${t.y * 2 + (i >> 1)}`); if (c && c.lastEmit >= frame - 3) return true; }
    return false;
  }
  function updateChannel(t, kind, dtMs, frame, instantOk) {
    const ch = t.disp[kind];
    // drop references to textures that were evicted
    if (ch.cur && !ch.cur.tex[kind]) ch.cur = null;
    if (ch.prev && !ch.prev.tex[kind]) ch.prev = null;
    const best = bestTexture(t, kind);
    if (best && (ch.cur !== best || ch.curXf.x !== xfOut.x || ch.curXf.y !== xfOut.y || ch.curXf.z !== xfOut.z)) {
      if (!ch.cur) { ch.prev = null; ch.k = instantOk ? 1 : 0; }             // continuing a parent's / child's image (instant) or revealing over the base (fade)
      else if (best.z > ch.cur.z) { ch.prev = ch.cur; ch.prevXf.copy(ch.curXf); ch.k = 0; }   // a finer image arrived: dissolve from what is on screen
      else { ch.prev = null; ch.k = 1; }
      ch.cur = best; ch.curXf.copy(xfOut);
    }
    let fading = false;
    if (ch.k < 1) { ch.k = Math.min(1, ch.k + dtMs / params.fadeMs); fading = ch.k < 1; if (!fading) ch.prev = null; }
    return fading;
  }

  let animating = false, shownA = 0;
  function applyUniforms(t, now) {
    const u = t.mat.uniforms, d = t.disp.day, n = t.disp.night;
    u.uDayC.value = d.cur ? d.cur.tex.day : dummy; u.uXfDC.value.copy(d.curXf);
    const hp = !!(d.prev && d.prev.tex.day);
    u.uDayHasP.value = hp ? 1 : 0; u.uDayP.value = hp ? d.prev.tex.day : dummy; u.uXfDP.value.copy(d.prevXf);
    u.uDayK.value = d.k;
    const hn = !!(n.cur && n.cur.tex.night);
    u.uNightHas.value = hn ? 1 : 0; u.uNightC.value = hn ? n.cur.tex.night : dummy; u.uXfNC.value.copy(n.curXf);
    const hnp = hn && !!(n.prev && n.prev.tex.night);
    u.uNightHasP.value = hnp ? 1 : 0; u.uNightP.value = hnp ? n.prev.tex.night : dummy; u.uXfNP.value.copy(n.prevXf);
    u.uNightK.value = n.k;
  }

  function run(camera, dtMs, now) {
    const frame = state.frame;
    // camera state
    P.copy(camera.position); D = P.length(); Pn.copy(P).divideScalar(D);
    horizon = D > 1 ? Math.acos(1 / D) : Math.PI / 2;
    camera.updateMatrixWorld();
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    pxK = renderer.getDrawingBufferSize(sizeV).y / (2 * Math.tan(camera.fov * D2R / 2));
    nearD = camera.near;
    pxKU.value = pxK;
    layerB.u.uFeather.value = texelRad(SOURCES.bm, Math.min(SOURCES.bm.maxZ, params.maxZA), 0);   // the deep layer only shows where GIBS runs out of detail
    // where the user is looking: camera ray against the unit sphere, else the point below the camera
    camera.getWorldDirection(tmp);
    const bq = P.dot(tmp), disc = bq * bq - (D * D - 1);
    if (disc > 0 && -bq - Math.sqrt(disc) > 0) focus.copy(P).addScaledVector(tmp, -bq - Math.sqrt(disc)).normalize();
    else focus.copy(Pn);
    sunDir.copy(sun).normalize();

    for (const layer of layers) {
      layer.emit.length = 0;
      layer.maxZ = layer === layerA ? Math.min(layer.src.maxZ, params.maxZA) : Math.min(layer.src.maxZ, params.maxZB);
      layer.thr = (layer === layerA ? params.thrA : params.thrB) * [1, 1.25, 1.6, 2.1][Math.min(state.tier, 3)];
      layer.on = layer === layerA || (params.enableB && state.tier < 3);
      if (!layer.on) continue;
      for (const r of layer.roots) visit(layer, r);
    }

    // build the visible set, request what is missing
    let anyFading = false, allOpaque = true, nA = 0, nB = 0, maxA = 0, maxB = 0, sA = 0;
    for (const layer of layers) {
      for (const t of layer.emit) {
        const instant = !(t.lastEmit >= frame - 3) && recentlyEmitted(t, frame);
        ensureMesh(layer, t);
        t.lastUsed = frame;
        // priority: coarse before fine, then nearest to the centre of the view
        const cd = (t.focusAng || 0) / (Math.PI / 2);
        const base = layer === layerB ? 200 : 0;
        for (let a = t; a; a = a.parent()) { a.lastUsed = frame; want(a, 'day', base + a.z * 10 + cd * 9, now); }
        if (layer === layerA && t.dark && t.z <= nightSrc.maxZ) for (let a = t; a; a = a.parent()) { a.lastUsed = frame; want(a, 'night', a.z * 10 + cd * 9 + 12, now); }
        const f1 = updateChannel(t, 'day', dtMs, frame, instant);
        const f2 = layer === layerA && t.dark ? updateChannel(t, 'night', dtMs, frame, instant) : false;
        if (layer === layerA && !t.dark) { const n = t.disp.night; if (n.cur) { n.cur = null; n.prev = null; } }
        t.lastEmit = frame;
        for (const k of ['day', 'night']) { const c = t.disp[k]; if (c.cur) c.cur.lastUsed = frame; if (c.prev) c.prev.lastUsed = frame; }
        const d = t.disp.day;
        const shown = !!d.cur;
        t.mesh.visible = shown;
        if (shown) applyUniforms(t, now);
        anyFading = anyFading || f1 || f2;
        const alpha = d.cur ? (d.prev ? 1 : d.k) : 0;
        if (layer === layerA) { nA++; if (shown) sA++; maxA = Math.max(maxA, t.z); if (alpha < 0.999) allOpaque = false; } else { nB++; maxB = Math.max(maxB, t.z); }
      }
    }
    // hide tiles that left the cut
    for (const layer of layers) for (const t of layer.tiles.values()) if (t.mesh && t.mesh.visible && t.lastEmit !== frame) t.mesh.visible = false;

    state.emittedA = nA; state.emittedB = nB; state.emitted = nA + nB; state.maxLevel.a = maxA; state.maxLevel.b = maxB;
    state.hideBase = nA > 0 && allOpaque && layerA.glob >= 0.999;
    animating = anyFading; shownA = sA;
  }

  function evict(frame) {
    if (state.cached <= params.maxTiles && state.bytes <= params.maxBytes) return;
    const cand = [];
    for (const layer of layers) for (const t of layer.tiles.values()) if (t.hasTex() && t.lastUsed < frame - 45) cand.push(t);
    cand.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of cand) {
      if (state.cached <= params.maxTiles * 0.9 && state.bytes <= params.maxBytes * 0.9) break;
      freeTex(t); freeMesh(t);
      t.disp.day = chan(); t.disp.night = chan();
    }
  }
  function sweep(frame) {            // meshes / bookkeeping of tiles nobody has used for a while
    for (const layer of layers) for (const [k, t] of layer.tiles) {
      if (t.lastUsed >= frame - 400) continue;
      if (t.mesh) freeMesh(t);
      if (!t.hasTex()) layer.tiles.delete(k);
    }
  }

  // ---------------------------------------------------------------------------------------------- public update
  let lastSweep = 0;
  function update(camera, dtSec, now = performance.now()) {
    const out = { animating: false, visible: false, hideBase: false, pending: 0 };
    if (!state.enabled || state.suspended) { setGlobal(0); group.visible = false; state.visible = false; return out; }
    const g = sstep(params.startDist + 0.1, params.startDist - 0.25, camera.position.length());
    if (g <= 0.001) {                            // far away: nothing to draw, nothing to fetch
      if (group.visible) { loader.abortAll(); ready.length = 0; group.visible = false; }
      setGlobal(0); state.visible = false; state.hideBase = false; state.emitted = 0;
      return out;
    }
    const t0 = performance.now();
    state.frame++;
    setGlobal(g);
    group.visible = true;
    run(camera, dtSec * 1000, now);
    loader.prune(now, 700);
    loader.pump();
    upload(params.uploadBudgetMs);
    if (state.frame % 10 === 0) evict(state.frame);
    if (state.frame - lastSweep > 240) { lastSweep = state.frame; sweep(state.frame); }
    const dt = performance.now() - t0;
    state.lastSelectMs = dt; state.selectMs = state.selectMs * 0.95 + dt * 0.05;
    out.animating = animating; out.pending = loader.entries.size + ready.length; state.pending = out.pending;
    out.visible = shownA > 0 && g > 0.2;
    out.hideBase = state.hideBase;
    state.visible = out.visible;
    return out;
  }
  function setGlobal(g) { for (const l of layers) l.glob = g, l.u.uGlobal.value = g; }

  // views / tab hidden: stop all network work
  function suspend() { state.suspended = true; loader.abortAll(); ready.length = 0; state.visible = false; group.visible = false; }
  function resume() { state.suspended = false; }
  function setQuality(tier) { state.tier = tier; }
  function setEnabled(on) { state.enabled = !!on; if (!on) suspend(); else resume(); }

  // WebGL context loss: every texture is gone and decoded bitmaps may be closed, start from scratch.
  renderer.domElement.addEventListener('webglcontextlost', () => {
    loader.abortAll(); ready.length = 0;
    for (const layer of layers) { for (const t of layer.tiles.values()) { t.tex = { day: null, night: null }; t.disp.day = chan(); t.disp.night = chan(); t.mesh = null; t.mat = null; } layer.tiles.clear(); layer.roots = layer.src.roots > 0 ? rootTiles(layer.src).map(([z, x, y]) => layer.get(z, x, y)) : [layer.get(0, 0, 0)]; }
    while (group.children.length) group.remove(group.children[0]);
    state.cached = 0; state.bytes = 0;
  });

  /** Compile the tile program ahead of the first tile (a big shader: compiling it mid-zoom would hitch). */
  function warmup(scene, camera) {
    try {
      const t = layerA.get(3, 5, 1);
      ensureMesh(layerA, t);
      const prev = group.visible; group.visible = true; t.mesh.visible = true;
      const done = () => { t.mesh.visible = false; group.visible = prev; };
      if (renderer.compileAsync) renderer.compileAsync(scene, camera).then(done, done);
      else { renderer.compile(scene, camera); done(); }
    } catch (e) { console.warn('[tiles] warmup failed', e); }
  }

  function dispose() {
    loader.abortAll(); ready.length = 0;
    for (const layer of layers) for (const t of layer.tiles.values()) { freeTex(t); freeMesh(t); }
    root.remove(group);
  }

  return {
    update, suspend, resume, setQuality, setEnabled, warmup, dispose, params, state, group,
    get enabled() { return state.enabled && !state.suspended; },
    stats() { return { ...state, loader: { ...loader.stats, inflight: loader.inflight, queued: loader.entries.size - loader.inflight } }; },
    layers: { a: layerA, b: layerB },
    /** measuring / debugging: what is on screen */
    debug() {
      return layers.flatMap((l) => l.emit.map((t) => ({ key: t.key, dark: t.dark, vis: !!(t.mesh && t.mesh.visible), dayK: t.disp.day.k, dayCur: t.disp.day.cur && t.disp.day.cur.key, dayPrev: !!t.disp.day.prev, nightCur: t.disp.night.cur && t.disp.night.cur.key, nightK: t.disp.night.k, fail: t.fail })));
    },
  };
}
