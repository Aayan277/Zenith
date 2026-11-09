// "Notify me" for launches. Honest by design: reminders fire only while Zenith is open in a tab
// (in-app toast + a browser Notification when permitted). There is no push server.
import * as state from '../state.js';
import { lsGet, lsSet, toast, askPermission, browserNotify, notifyPermission } from '../ui/notify.js';
import { getLaunch } from './data.js';

export const LEAD_MIN = 10;
const KEY = 'zenith:launches:notify', KEY_FIRED = 'zenith:launches:fired';
let armed = lsGet(KEY, {});            // id -> { net, name }
let fired = lsGet(KEY_FIRED, {});      // `${id}@${net}` -> 1
let timer = 0;

const save = () => lsSet(KEY, armed);
export const isArmed = id => !!armed[id];
export const armedCount = () => Object.keys(armed).length;

export async function toggleReminder(l) {
  if (armed[l.id]) {
    delete armed[l.id]; save(); state.emit('launches:notify', l.id);
    toast('Reminder removed.', 3000);
    return false;
  }
  const perm = await askPermission();           // user gesture: this click
  armed[l.id] = { net: l.net, name: `${l.rocket} · ${l.mission}` }; save(); ensureTimer();
  state.emit('launches:notify', l.id);
  const how = perm === 'granted' ? 'You will get a toast and a browser notification' : 'You will get an in-app toast (browser notifications are ' + (perm === 'unsupported' ? 'not supported here' : 'off') + ')';
  toast(`Reminder set for T−${LEAD_MIN} min. ${how} — but only while Zenith stays open in a tab. There is no push server.`, 9000);
  check();
  return true;
}

function check() {
  const real = Date.now();
  let changed = false;
  for (const [id, a] of Object.entries(armed)) {
    const l = getLaunch(id);
    const net = l?.net ?? a.net;
    if (l && l.net && l.net !== a.net) { a.net = l.net; changed = true; }   // schedule slipped: follow it
    if (l && (l.status.key === 'success' || l.status.key === 'failure')) { delete armed[id]; changed = true; continue; }
    if (net == null) continue;
    if (real > net + 30 * 60e3) { delete armed[id]; changed = true; continue; }    // too late to matter
    const k = `${id}@${net}`;
    if (!fired[k] && real >= net - LEAD_MIN * 60e3 && real <= net + 5 * 60e3) {
      fired[k] = 1; lsSet(KEY_FIRED, fired); changed = true;
      const mins = Math.max(0, Math.round((net - real) / 60e3));
      const title = `Launch in ${mins} min`, body = l ? `${l.rocket} · ${l.mission} from ${l.location || l.pad}` : a.name;
      toast(`${title}: ${body}`, 12000);
      browserNotify(title, body, { tag: 'launch-' + id, onClick: () => { state.set('selection', { kind: 'launch', id }); } });
    }
  }
  if (changed) { save(); state.emit('launches:notify', null); }
  if (!Object.keys(armed).length) { clearInterval(timer); timer = 0; }
}
function ensureTimer() { if (!timer) timer = setInterval(check, 15000); }

export function initReminders() { if (Object.keys(armed).length) { ensureTimer(); check(); } }
export const reminderPermission = notifyPermission;
