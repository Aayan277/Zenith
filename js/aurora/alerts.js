// "Alert me": while Zenith is open, check every 15 min (paused when the tab is hidden) and fire an in-app toast plus an
// optional browser Notification when the chosen threshold is crossed. Deduped per event. No push server exists, so this
// cannot reach you when Zenith is closed.
import * as state from '../state.js';
import { aur, loadSmall, loadOvation, onAurora } from './data.js';
import { conditionFor } from './assess.js';
import { lsGet, lsSet, toast, askPermission, browserNotify } from '../ui/notify.js';
import { setTabBadge } from '../ui/paneltabs.js';

export const PRESETS = [
  { id: 'local', label: 'Likely at my location', hint: 'Good chance of seeing it where you are, after dark' },
  { id: 'kp5',   label: 'Kp ≥ 5',               hint: 'A geomagnetic storm (G1 or stronger) is under way or forecast' },
  { id: 'watch', label: 'Any G-storm watch',    hint: 'NOAA issues a geomagnetic storm watch' },
];
const KEY = 'zenith:aurora:alerts', KEY_FIRED = 'zenith:aurora:fired', POLL = 15 * 60e3;
let prefs = { on: false, preset: 'local', ...(lsGet(KEY, {}) || {}) };
let fired = lsGet(KEY_FIRED, []);
let timer = 0, lastPoll = 0;

export const getPrefs = () => ({ ...prefs });
export function setPrefs(p) {
  prefs = { ...prefs, ...p }; lsSet(KEY, prefs);
  state.emit('aurora:alerts', prefs);
  schedule(); evaluate({ fire: prefs.on });
}
export async function enableAlerts(on) {
  if (on) {
    const perm = await askPermission();
    setPrefs({ on: true });
    toast(`Alerts on. ${perm === 'granted' ? 'You will get a toast and a browser notification' : 'You will get an in-app toast'} while Zenith is open in a tab — it cannot notify you once closed. Checks every 15 min.`, 9000);
    poll();
  } else setPrefs({ on: false });
}

/** Evaluate the current preset: updates the tab badge; fires (once per event) when `fire`. Returns the condition. */
export function evaluate({ fire = prefs.on } = {}) {
  let c = { on: false };
  try { c = conditionFor(prefs.preset, aur, state.get('location')); } catch (e) { console.warn('[aurora alerts]', e.message); }
  setTabBadge('aurora', c.on ? 'good' : false);
  if (fire && c.on && !fired.includes(c.key)) {
    fired.push(c.key); fired = fired.slice(-40); lsSet(KEY_FIRED, fired);
    toast(`${c.title}. ${c.body}`, 12000);
    browserNotify(c.title, c.body, { tag: 'aurora', onClick: () => { try { import('../ui/paneltabs.js').then(m => m.showTab('aurora')); } catch {} } });
  }
  return c;
}

async function poll() {
  lastPoll = Date.now();
  const needOva = prefs.on && prefs.preset === 'local';
  await Promise.all([loadSmall({ force: true }), needOva ? loadOvation({ force: true }) : null]);
  evaluate();
}
function schedule() {
  clearInterval(timer); timer = 0;
  if (!prefs.on) return;
  timer = setInterval(() => { if (!document.hidden) poll(); }, POLL);
}

export function initAlerts() {
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && prefs.on && Date.now() - lastPoll > POLL) poll(); });
  onAurora(() => evaluate());
  state.on('location', () => evaluate());
}
