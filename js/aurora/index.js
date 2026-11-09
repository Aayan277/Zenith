// Aurora feature entry point. main.js: `import('./aurora/index.js').then(m => m.init())`.
// Nothing here blocks first paint: the small NOAA products (Kp, alerts, solar wind: ~55 KB) load when the browser is idle;
// the OVATION grid (~920 KB JSON, cached as 65 KB) loads when the globe layer is on, the Aurora tab opens, or an
// alert on "likely at my location" is enabled.
import { loadSmall, loadOvation } from './data.js';
import { initAuroraGlobe, isAuroraLayerOn, setAuroraLayerOn } from './layer.js';
import { initAlerts, evaluate, getPrefs } from './alerts.js';

export { isAuroraLayerOn, setAuroraLayerOn };
const idle = (fn, timeout = 6000) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 1500));
let started = false;

export async function init() {
  if (started) return; started = true;
  initAuroraGlobe();
  initAlerts();
  idle(async () => {
    await loadSmall().catch(() => {});
    const p = getPrefs();
    if (p.on && p.preset === 'local') await loadOvation().catch(() => {});
    evaluate();
  });
  // Keep the data and badge fresh while the page stays open (visible tab only).
  setInterval(() => { if (!document.hidden) { loadSmall(); if (isAuroraLayerOn()) loadOvation(); } }, 15 * 60e3);
}
