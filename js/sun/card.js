// "Sun now" card for the Aurora tab + the lazy dashboard opener.
import { sdoUrl, sun, ensure, LITE, onSun, status, classOf } from './data.js';
import { esc, ensureSunCss } from './util.js';

let cssReady = false, thumb = null, thumbAt = 0;
export function openSunDashboard() { return import('./dashboard.js').then(m => m.openDashboard()); }
export { onSun };

/** Kick off the (tiny) data fetches; call when the card becomes visible. */
export function warmSunCard() { ensure(LITE); if (!cssReady) ensureSunCss().then(() => { cssReady = true; for (const fn of subsNudge) fn(); }); }
const subsNudge = new Set();
export const onSunCardReady = fn => { subsNudge.add(fn); return () => subsNudge.delete(fn); };

/** Card HTML. The thumbnail <img> is a persistent element (SDO sends no-store, so re-creating it would refetch every render):
 *  call adoptSunThumb(container) after setting innerHTML. */
export function sunCardHtml() {
  if (!cssReady) return '';
  const st = status(), cur = st.cur, c = cur ? cur.color : 'var(--text-dim)';
  return `<section class="tn-card sn-card" aria-label="Sun now" style="--c:${c}">
    <div class="sn-card-row">
      <button type="button" class="sn-thumb-btn" data-act="sun" aria-label="Open Sun dashboard"><span class="sn-thumb-slot" data-sun-slot></span></button>
      <div class="sn-card-main">
        <div class="sn-card-top"><span class="eyebrow">Sun now</span><span class="sn-pill">${esc(cur ? st.word : '…')}</span></div>
        <div class="sn-card-nums">
          <div><div class="sn-big mono">${cur ? esc(cur.label) : '—'}</div><div class="sn-cl">X-ray flare class</div></div>
          <div><div class="sn-big sm mono">${st.wind != null ? Math.round(st.wind) : '—'}<small> km/s</small></div><div class="sn-cl">solar wind</div></div>
        </div>
      </div>
    </div>
    <button type="button" class="tn-link sn-open" data-act="sun">Open Sun dashboard <span aria-hidden="true">→</span></button>
  </section>`;
}
export function adoptSunThumb(root) {
  const slot = root.querySelector('[data-sun-slot]'); if (!slot) return;
  if (!thumb || Date.now() - thumbAt > 15 * 60e3) {
    thumb = new Image(); thumb.alt = 'Latest NASA SDO image of the Sun (193 angstrom)'; thumb.decoding = 'async'; thumb.src = sdoUrl('0193', 512); thumbAt = Date.now();
    thumb.onerror = () => { thumb.style.visibility = 'hidden'; };
  }
  slot.append(thumb);
}
