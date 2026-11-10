// Small shared helpers for the Sun module.
import { fmtLocal, tzLabel } from '../util/time.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** HH:MM in the observer's zone. */
export const hm = ms => fmtLocal(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const hmz = ms => hm(ms) + ' ' + tzLabel(ms);
export const dayhm = ms => fmtLocal(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const ago = ms => { const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

let cssP = null;
/** Inject css/sun.css once (resolved relative to this module, so it works under any base path). */
export function ensureSunCss() {
  if (cssP) return cssP;
  cssP = new Promise(res => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('../../css/sun.css', import.meta.url).href;
    l.onload = l.onerror = () => res(); document.head.append(l);
  });
  return cssP;
}
