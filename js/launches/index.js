// Rocket launches feature entry point. main.js: `import('./launches/index.js').then(m => m.init())`.
// Nothing here blocks first paint: the globe layer registers immediately (it is inert until the globe is ready),
// data loads when the browser is idle (or when the Launches tab / a launch selection asks for it).
import * as state from '../state.js';
import { loadLaunches, store, pending, onLaunches } from './data.js';
import { registerLaunchDetail } from './detail.js';
import { initLaunchGlobe, isLaunchLayerOn, setLaunchLayerOn } from './globe.js';
import { initReminders } from './reminders.js';

export { loadLaunches, isLaunchLayerOn, setLaunchLayerOn };

const idle = (fn, timeout = 6000) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 1500));
let started = false;

export async function init() {
  if (started) return; started = true;
  registerLaunchDetail();
  initLaunchGlobe();
  idle(() => { loadLaunches().catch(() => {}); initReminders(); });
  // Opening a launch from search / a notification: make sure the data is there.
  state.on('selection', s => { if (s?.kind === 'launch' && !store.loaded) loadLaunches().catch(() => {}); });
  // Refresh while the page stays open (the 30-min cache TTL makes this cheap; LL2 allows ~15 requests/hour).
  setInterval(() => { if (!document.hidden) loadLaunches().catch(() => {}); }, 31 * 60e3);
}

/** Entries for the command palette (js/ui/search.js). Call after loadLaunches(). */
export function searchEntries(norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) {
  return pending(Date.now(), 6 * 3600e3).map(l => {
    const key = norm([l.mission, l.name, l.rocket, l.rocketFull, l.provider, l.pad, 'launch rocket'].join(' '));
    return { kind: 'launch', id: l.id, name: `${l.mission}`, sub: `Launch · ${l.rocket}${l.provider ? ' · ' + l.provider : ''}`, color: '#ff9f5c', key, compact: key.replace(/ /g, ''), bonus: 30 };
  });
}
export { onLaunches, pending };
