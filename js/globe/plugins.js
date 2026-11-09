// Globe plug-ins: lets other modules add layers to the orbit view without editing globe.js.
//
//   import { registerGlobeLayer } from './globe/plugins.js';
//   registerGlobeLayer({
//     id: 'launches',
//     init(ctx) {},                       // once, when the globe is ready (or immediately if it already is)
//     update(ctx, nowMs, dtMs) {},        // every RENDERED frame (the globe drops to ~20-30 fps when idle)
//     pick(ctx, x, y) { return null; },   // click at CSS px (x, y) in the globe; return a selection {kind,id} to claim it
//     dispose() {},
//   });
//   ctx = { THREE, scene, camera, renderer, root, coords, host, requestRender(ms = 300) }
//     root  Earth-fixed THREE.Group (radius 1 = 6371 km, +Y north, see coords.js): add your meshes here.
//     host  #view-globe element, for DOM labels (position them from update()).
//     requestRender(ms)  keep the globe at full frame rate for ms (call from update() while animating).
// Layers registered before or after the globe initialises both work. Errors in a layer are caught and logged.

const layers = [];
let ctx = null;
const safe = (layer, fn, ...a) => { try { return layer[fn]?.(...a); } catch (e) { console.error(`[globe layer ${layer.id}] ${fn}`, e); } };

export function registerGlobeLayer(layer) {
  if (!layer || layers.includes(layer)) return;
  layers.push(layer);
  if (ctx) safe(layer, 'init', ctx);
}
export function unregisterGlobeLayer(layer) {
  const i = layers.indexOf(layer); if (i < 0) return;
  layers.splice(i, 1); safe(layer, 'dispose');
}

// ---- used by globe.js ----
export function attachGlobe(c) { ctx = c; for (const l of [...layers]) safe(l, 'init', ctx); }
export function updateLayers(nowMs, dtMs) { for (const l of layers) if (l.update) safe(l, 'update', ctx, nowMs, dtMs); }
export function pickLayers(x, y) {
  for (const l of layers) if (l.pick) { const s = safe(l, 'pick', ctx, x, y); if (s) return s; }
  return null;
}
