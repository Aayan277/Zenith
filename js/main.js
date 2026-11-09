// Bootstraps the app. Each feature module exports init(); they are isolated so
// one failing module never takes down the others.
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

(async () => {
  const catalog = loadCatalog().catch(e => { console.error(e); toast('Could not load satellite data'); });
  await Promise.all([
    safeInit('shell',   () => import('./ui/shell.js')),
    safeInit('globe',   () => import('./globe/globe.js')),
    safeInit('sky',     () => import('./sky/sky.js')),
    safeInit('tonight', () => import('./tonight/tonight.js')),
  ]);
  await catalog;
  document.getElementById('boot').classList.add('done');
})();
