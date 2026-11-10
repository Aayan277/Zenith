// Bootstraps the app. Each feature module exports init(); they are isolated so
// one failing module never takes down the others.
// Boot order: shell + tonight panel paint first; the globe (three.js + textures) and the full
// satellite catalog stream in afterwards; the sky view initialises when first needed (or when idle).
import * as state from './state.js';
import { loadCatalog } from './data/catalog.js';

document.body.dataset.view = state.get('view');
state.on('view', v => { document.body.dataset.view = v; });

export function toast(msg, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
state.on('toast', toast);

async function safeInit(name, loader) {
  try {
    const mod = await loader();
    await mod.init?.();
  } catch (e) {
    console.error(`[init:${name}]`, e);
  }
}

const idle = (fn, timeout = 2500) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 300));

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// Sky view: init on first need (view switch, selection, focus request) or when the browser is idle.
let skyPromise = null;
// Solar System view: three.js scene, initialised only when the user opens it.
let systemPromise = null;
function ensureSystem() {
  return (systemPromise ||= safeInit('system', () => import('./system/system.js')));
}
function ensureSky() {
  return (skyPromise ||= safeInit('sky', () => import('./sky/sky.js')));
}

(async () => {
  loadCatalog().catch(e => { console.error(e); toast('Could not load satellite data'); });

  const shell = safeInit('shell', () => import('./ui/shell.js'));
  const tonight = safeInit('tonight', () => import('./tonight/tonight.js'));
  // Left-panel tabs (Tonight / Launches / Aurora). Their data loads when idle or on first open.
  safeInit('paneltabs', () => import('./ui/paneltabs.js').then(m => ({ init: m.initPanelTabs })));
  safeInit('launches',  () => import('./launches/index.js'));
  safeInit('aurora',    () => import('./aurora/index.js'));

  if (hasWebGL()) {
    safeInit('globe', () => import('./globe/globe.js'));
  } else {
    // Graceful degradation without console noise: no WebGL => no three.js download.
    const host = document.getElementById('view-globe');
    const msg = document.createElement('div');
    msg.className = 'globe-fallback';
    msg.textContent = 'The 3D orbit view needs WebGL, which is unavailable in this browser. The sky view still works.';
    host?.append(msg);
    console.warn('[globe] WebGL unavailable; use the Sky view');
  }

  state.on('view', v => { if (v === 'sky') ensureSky(); if (v === 'system') ensureSystem(); });
  if (state.get('view') === 'system') ensureSystem();
  state.on('selection', s => { if (s && s.kind !== 'sat') ensureSky(); });
  state.on('focus', () => ensureSky());
  if (state.get('view') === 'sky') ensureSky(); else idle(ensureSky, 4000);

  await Promise.all([shell, tonight]);
  document.getElementById('boot').classList.add('done');
})();

// Service worker: repeat visits are served from cache, and the app works offline with the last data.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const reg = () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('[sw]', e.message));
  if (document.readyState === 'complete') idle(reg); else addEventListener('load', () => idle(reg));
}
