// "Add to calendar" popover shared by the Tonight tab, Launches and Events. One menu at a time.
//   openCalMenu(anchorEl, spec | () => spec)   spec: see js/util/ics.js (title, start, end, description, location, key, url)
//   calBtn(attrs?)                              HTML for the small icon button (give it a data attribute and handle the click yourself)
// Styles live in css/tonight.css (always loaded).
import * as state from '../state.js';
import { downloadIcs, googleUrl, SITE_URL, ALARM_MIN } from '../util/ics.js';

export const CAL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17M12 13.5v4M10 15.5h4"/></svg>';
export const calBtn = (extra = '', label = 'Add to calendar') =>
  `<button type="button" class="cal-btn" ${extra} aria-label="${label}" aria-haspopup="menu" title="${label}">${CAL_ICON}</button>`;

let menu = null, anchorEl = null, off = [];

export function closeCalMenu() {
  if (!menu) return;
  menu.remove(); menu = null;
  for (const f of off) f(); off = [];
  if (anchorEl?.isConnected) anchorEl.setAttribute('aria-expanded', 'false');
  anchorEl = null;
}

// Share link (optional): js/ui/url.js exports linkPairs(); build "<site>?view=sky&t=<time>&<selection>&loc=..." so the link reopens the
// same sky. spec.link = { view?, t?, sel? }. Resolves to null when the module or a usable pair set is not available.
async function shareUrl(spec) {
  try {
    const m = await import('../ui/url.js');
    if (typeof m.linkPairs !== 'function' || !spec.link) return null;
    const { view = 'sky', t, sel = null } = spec.link;
    const pairs = m.linkPairs({ time: false, loc: true, sel }).filter(([k]) => k !== 'view' && k !== 't' && k !== 'rate');
    const out = [];
    if (view !== 'globe') out.push(['view', view]);
    if (t != null) out.push(['t', new Date(Math.floor(t / 60000) * 60000).toISOString().slice(0, 16) + 'Z']);
    out.push(...pairs);
    return out.length ? SITE_URL + '?' + out.map(([k, v]) => `${k}=${v}`).join('&') : null;
  } catch { return null; }
}

export function openCalMenu(anchor, specOrFn) {
  closeCalMenu();
  const spec0 = typeof specOrFn === 'function' ? specOrFn() : specOrFn;
  if (!spec0 || spec0.start == null) return;
  const loc = state.get('location');
  const spec = { location: loc?.name || '', url: SITE_URL, ...spec0 };
  const shared = shareUrl(spec);
  anchorEl = anchor; anchor.setAttribute('aria-expanded', 'true');
  menu = document.createElement('div');
  menu.className = 'cal-menu glass'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Add to calendar');
  menu.innerHTML = `
    <div class="cal-title">${esc(spec.title)}</div>
    <button type="button" role="menuitem" class="cal-item" data-k="ics">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg>
      <span><b>Apple / Outlook</b><i>Download .ics file</i></span></button>
    <a role="menuitem" class="cal-item" data-k="g" target="_blank" rel="noopener noreferrer" href="${esc(googleUrl(spec))}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>
      <span><b>Google Calendar</b><i>Opens in a new tab</i></span></a>
    <p class="cal-note"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15zM10 20.5h4"/></svg>Reminder ${ALARM_MIN} min before. It fires even when Zenith is closed.</p>`;
  document.body.append(menu);
  shared.then(u => { if (u && menu && anchorEl === anchor) { spec.url = u; const g = menu.querySelector('[data-k="g"]'); if (g) g.href = googleUrl(spec); } });
  const place = () => {
    const r = anchor.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    let x = Math.min(innerWidth - w - 10, Math.max(10, r.right - w));
    let y = r.bottom + 8;
    if (y + h > innerHeight - 10) y = Math.max(10, r.top - h - 8);
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
  };
  place();
  requestAnimationFrame(() => menu && menu.classList.add('open'));
  const items = [...menu.querySelectorAll('.cal-item')];
  items[0].focus({ preventScroll: true });
  menu.addEventListener('click', async e => {
    const it = e.target.closest('.cal-item'); if (!it) return;
    if (it.dataset.k === 'ics') {
      const name = downloadIcs(spec);
      state.emit('toast', `Saved ${name}. Open it to add the event.`);
    }
    closeCalMenu();
  });
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = anchorEl; closeCalMenu(); a?.focus?.(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  const onDown = e => { if (menu && !menu.contains(e.target) && !anchor.contains(e.target)) closeCalMenu(); };
  const onRel = () => closeCalMenu();
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onRel);
  document.addEventListener('scroll', onRel, true);
  off.push(() => document.removeEventListener('pointerdown', onDown, true), () => window.removeEventListener('resize', onRel), () => document.removeEventListener('scroll', onRel, true));
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
