// Shared in-app toast + browser Notification helpers for launch reminders and aurora alerts.
// There is no push server: everything here only works while Zenith is open in a tab.
import * as state from '../state.js';

export const lsGet = (k, fb = null) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** Longer-lived toast than state.emit('toast') (3.2 s), for things the user should not miss. */
export function toast(msg, ms = 7000) {
  const host = document.getElementById('toasts');
  if (!host) { state.emit('toast', msg); return; }
  const el = document.createElement('div');
  el.className = 'toast toast-long'; el.setAttribute('role', 'status'); el.textContent = msg;
  host.append(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 450); }, ms);
}

export const canNotify = () => typeof Notification !== 'undefined';
export const notifyPermission = () => (canNotify() ? Notification.permission : 'unsupported');

/** Ask for permission (must be called from a user gesture). Resolves to 'granted' | 'denied' | 'default' | 'unsupported'. */
export async function askPermission() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Fire a browser notification if permitted. Returns true when shown. */
export function browserNotify(title, body, { tag, onClick } = {}) {
  if (!canNotify() || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag, icon: 'assets/apple-touch-icon.png', badge: 'assets/favicon.svg', silent: false });
    n.onclick = () => { try { window.focus(); onClick?.(); } catch {} n.close(); };
    return true;
  } catch { return false; }
}
