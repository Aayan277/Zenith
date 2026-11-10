// Telescope photo gallery: a full-screen glass modal with a justified photo grid, search-within, a telescope switcher
// and a lightbox. Public API:
//   openGallery(key, { query } = {})   key = a TELESCOPES key ('hubble', 'jwst', …)
//   closeGallery(), isGalleryOpen()
//   telescopeForNorad(id)              re-exported from the registry
// Photos come from the NASA Image and Video Library (see source.js). Styles: css/gallery.css, injected on first open.
import * as state from '../state.js';
import { TELESCOPES, getTelescope, telescopeForNorad } from './telescopes.js';
import { createFeed } from './source.js';
import { createLightbox } from './lightbox.js';

export { TELESCOPES, getTelescope, telescopeForNorad };

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ico = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  close: ico('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  clear: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  globe: ico('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5S9.4 5.9 12 3.5z"/>'),
  image: ico('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="M4 17l5-4.5 3.5 3L16 12l4 4"/>'),
};
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

let cssPromise = null;
function loadCss() {
  if (cssPromise) return cssPromise;
  cssPromise = new Promise(res => {
    const href = new URL('../../css/gallery.css', import.meta.url).href;
    const existing = [...document.styleSheets].some(s => s.href === href) || document.querySelector(`link[href="${href}"]`);
    if (existing) return res();
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
    l.onload = l.onerror = () => res();
    document.head.appendChild(l);
    setTimeout(res, 2500);           // never block on a slow stylesheet
  });
  return cssPromise;
}

// ---- singleton UI state -------------------------------------------------------------------------------------------
let back = null, dlg, gridEl, scrollEl, footEl, countEl, searchEl, clearEl, tryEl, headEl, chipsEl, lb = null, io = null, ro = null;
let tel = null, feed = null, items = [], query = '', loading = false, errored = false, token = 0, searchTimer = 0, lastFocus = null;
let opening = null;

const isOpen = () => !!back && back.isConnected;
export const isGalleryOpen = isOpen;

export async function openGallery(key, { query: q = '' } = {}) {
  const t = getTelescope(key) || TELESCOPES[0];
  if (back && !back.isConnected) { io?.disconnect(); ro?.disconnect(); io = ro = null; lb = null; back = null; }   // modal-root was cleared by someone else
  if (isOpen()) { setTelescope(t, q); return; }
  if (opening) { await opening; return openGallery(key, { query: q }); }
  opening = loadCss(); await opening; opening = null;
  if (isOpen()) { setTelescope(t, q); return; }
  build();
  lastFocus = document.activeElement;
  document.body.classList.add('modal-open');
  window.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => back.classList.add('show'));
  setTelescope(t, q, true);
  setTimeout(() => (lb?.isOpen ? null : dlg.querySelector('.gal-search input')?.focus({ preventScroll: true })), 60);
  try { state.emit('gallery:open', t.key); } catch {}
}

export function closeGallery() {
  if (!isOpen()) return;
  token++; io?.disconnect(); ro?.disconnect(); io = ro = null;
  window.removeEventListener('keydown', onKey, true);
  document.body.classList.remove('modal-open');
  clearTimeout(searchTimer);
  const b = back; back = null; lb?.destroy(); lb = null;
  b.classList.remove('show');
  setTimeout(() => b.remove(), reduced() ? 0 : 260);
  try { lastFocus?.focus?.({ preventScroll: true }); } catch {}
  try { state.emit('gallery:close'); } catch {}
}

// ---- DOM ---------------------------------------------------------------------------------------------------------
function build() {
  const root = document.getElementById('modal-root') || document.body;
  back = document.createElement('div');
  back.className = 'gal-back';
  back.innerHTML = `
    <div class="gal glass" role="dialog" aria-modal="true" aria-labelledby="gal-title">
      <header class="gal-head">
        <div class="gal-id"></div>
        <div class="gal-head-actions">
          <button class="btn gal-locate" hidden>${ICON.globe}<span>Show on globe</span></button>
          <button class="gal-icon-btn gal-close" aria-label="Close gallery" title="Close (Esc)">${ICON.close}</button>
        </div>
      </header>
      <nav class="gal-chips" aria-label="Choose a telescope">${TELESCOPES.map(t => `<button class="gal-chip" style="--c:${t.accent}" data-k="${t.key}" aria-pressed="false"><i></i>${esc(t.short)}${t.retired ? '<span class="gal-ret">retired</span>' : ''}</button>`).join('')}</nav>
      <div class="gal-bar">
        <label class="gal-search"><span class="sr-only" style="position:absolute;left:-9999px">Search within photos</span>${ICON.search}
          <input type="search" autocomplete="off" spellcheck="false" aria-label="Search within these photos" placeholder="Search within photos…">
          <button class="gal-clear" type="button" aria-label="Clear search" hidden>${ICON.clear}</button></label>
        <div class="gal-try" aria-label="Suggestions"></div>
        <span class="gal-count mono" aria-live="polite"></span>
      </div>
      <div class="gal-scroll scroll" tabindex="-1">
        <div class="gal-grid" role="list"></div>
        <div class="gal-foot"></div>
      </div>
    </div>`;
  root.appendChild(back);
  dlg = back.querySelector('.gal');
  headEl = back.querySelector('.gal-id'); chipsEl = back.querySelector('.gal-chips');
  gridEl = back.querySelector('.gal-grid'); scrollEl = back.querySelector('.gal-scroll'); footEl = back.querySelector('.gal-foot');
  countEl = back.querySelector('.gal-count'); tryEl = back.querySelector('.gal-try');
  searchEl = back.querySelector('.gal-search input'); clearEl = back.querySelector('.gal-clear');

  back.addEventListener('mousedown', e => { if (e.target === back) closeGallery(); });
  back.querySelector('.gal-close').addEventListener('click', closeGallery);
  back.querySelector('.gal-locate').addEventListener('click', () => {
    const id = tel?.norad; if (!id) return;
    closeGallery();
    const sel = { kind: 'sat', id };
    state.set('view', 'globe'); state.set('selection', sel); state.emit('focus', sel);
  });
  chipsEl.addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) setTelescope(getTelescope(b.dataset.k), ''); });
  tryEl.addEventListener('click', onSuggest);
  searchEl.addEventListener('input', () => {
    clearEl.hidden = !searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(searchEl.value.trim()), 350);
  });
  clearEl.addEventListener('click', () => { searchEl.value = ''; clearEl.hidden = true; runSearch(''); searchEl.focus(); });
  gridEl.addEventListener('click', e => {
    const t = e.target.closest('.gal-tile:not(.skel)'); if (!t) return;
    lb.open(items, +t.dataset.i, { isDone: !!feed?.done, from: t });
  });
  footEl.addEventListener('click', e => {
    if (e.target.closest('[data-more]')) loadMore();
    else if (e.target.closest('[data-retry]')) { errored = false; loadMore(); }
    else if (e.target.closest('[data-clear]')) { searchEl.value = ''; clearEl.hidden = true; runSearch(''); }
    else { const s = e.target.closest('[data-sug]'); if (s) applyQuery(s.dataset.sug); else { const t = e.target.closest('[data-tel]'); if (t) setTelescope(getTelescope(t.dataset.tel), ''); } }
  });

  lb = createLightbox(dlg, {
    onNeedMore: () => loadMore(),
    onClose: (_r, from) => { try { (from && from.isConnected ? from : searchEl).focus({ preventScroll: true }); } catch {} },
  });

  io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) loadMore(); }, { root: scrollEl, rootMargin: '700px 0px' });
  io.observe(footEl);
  let lastW = 0;
  ro = new ResizeObserver(() => { const w = gridEl.clientWidth; if (Math.abs(w - lastW) > 1) { lastW = w; layout(); } });
  ro.observe(gridEl);
}

// ---- header + chips ---------------------------------------------------------------------------------------------
function paintHead() {
  const t = tel;
  dlg.style.setProperty('--g', t.accent);
  const meta = [
    ['Agency', t.agency], ['Launched', t.retired ? `${t.launch} · retired ${t.retired}` : String(t.launch)], ['Observes', t.bands], ['Orbit', t.orbit, 'opt'],
  ];
  headEl.innerHTML = `<div class="sw">
    <p class="eyebrow gal-eyebrow">Telescope photos</p>
    <h2 class="gal-title" id="gal-title">${esc(t.name)}</h2>
    <p class="gal-blurb">${esc(t.blurb)}</p>
    <dl class="gal-meta">${meta.map(([k, v, c]) => `<div${c ? ` class="${c}"` : ''}><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>`;
  chipsEl.querySelectorAll('.gal-chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === t.key)));
  chipsEl.querySelector(`[data-k="${t.key}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
  const loc = back.querySelector('.gal-locate');
  loc.hidden = !t.norad;
  searchEl.placeholder = `Search within ${t.short} photos…`;
  paintSuggest();
}
function paintSuggest() {
  tryEl.innerHTML = tel.suggest.length ? `<span class="eyebrow">Try</span>${tel.suggest.slice(0, 5).map(s => `<button class="gal-sug" data-sug="${esc(s)}" aria-pressed="${s.toLowerCase() === query.toLowerCase()}">${esc(s)}</button>`).join('')}` : '';
}
function onSuggest(e) { const s = e.target.closest('[data-sug]'); if (s) applyQuery(s.dataset.sug.toLowerCase() === query.toLowerCase() ? '' : s.dataset.sug); }
function applyQuery(q) { searchEl.value = q; clearEl.hidden = !q; runSearch(q); }

// ---- feed control ---------------------------------------------------------------------------------------------------
function setTelescope(t, q = '', first = false) {
  if (!first && t === tel && q === query) return;
  tel = t; query = q;
  searchEl.value = q; clearEl.hidden = !q;
  paintHead();
  resetFeed();
  if (!first) scrollEl.scrollTo({ top: 0, behavior: 'auto' });
}
function runSearch(q) { if (q === query) return; query = q; paintSuggest(); resetFeed(); scrollEl.scrollTo({ top: 0, behavior: 'auto' }); }

function resetFeed() {
  token++; loading = false; errored = false;
  items = []; gridEl.innerHTML = ''; footEl.innerHTML = '';
  countEl.textContent = '';
  feed = createFeed(tel, { query });
  if (!tel.search.sources.length && !tel.curated.length) { feed = null; renderEmpty(); return; }
  showSkeleton();
  loadMore();
}

async function loadMore() {
  if (!feed || loading || feed.done) return;
  const my = token; loading = true; errored = false;
  paintFoot();
  try {
    const r = await feed.next(items.length ? 24 : 30);
    if (my !== token) return;
    const first = !items.length && r.items.length > 0;
    if (first) gridEl.innerHTML = '';
    const start = items.length;
    items = items.concat(r.items);
    appendTiles(start, first);
  } catch (e) {
    if (my !== token) return;
    if (e?.name !== 'AbortError') { errored = true; console.warn('[gallery]', e); }
  }
  if (my !== token) return;
  loading = false;
  paintFoot(); paintCount();
  lb?.update(items, !!feed?.done);
  if (!items.length && (feed?.done) && !errored) renderEmpty();
  // re-arm the observer: if the footer is still on screen (short page / big viewport) fetch the next chunk
  if (io && !feed.done && !errored) { io.unobserve(footEl); io.observe(footEl); }
}

function paintCount() {
  if (!feed) { countEl.textContent = ''; return; }
  const n = items.length;
  countEl.textContent = n ? `${n.toLocaleString('en-US')}${feed.done ? '' : '+'} photo${n === 1 && feed.done ? '' : 's'}${query ? ` for “${query}”` : ''}` : '';
}

function paintFoot() {
  if (!tel) return;
  if (errored) { footEl.innerHTML = `<p>Couldn’t reach the NASA image library.</p><button class="btn" data-retry>Try again</button>`; return; }
  if (!items.length && !loading) { footEl.innerHTML = ''; return; }
  if (loading) { footEl.innerHTML = items.length ? '<span class="gal-spin" role="status" aria-label="Loading more photos"></span>' : ''; return; }
  const credit = `<p class="fine">Images: <a href="https://images.nasa.gov" target="_blank" rel="noopener">NASA Image and Video Library</a>. NASA imagery is generally public domain; credits are shown with each image.</p>`;
  if (feed && !feed.done) { footEl.innerHTML = `<button class="btn" data-more>Load more</button>${credit}`; return; }
  footEl.innerHTML = `<p>${items.length ? `That’s every ${esc(tel.short)} photo in NASA’s library${query ? ' for this search' : ''}.` : ''}${tel.site ? ` More from ${esc(tel.short)} at <a href="${esc(tel.site)}" target="_blank" rel="noopener">${esc(new URL(tel.site).hostname)}</a>.` : ''}</p>${credit}`;
}

function renderEmpty() {
  gridEl.innerHTML = '';
  const t = tel, searching = !!query && feed;
  const sugg = t.suggest.length && !t.emptyNote ? `<div class="gal-try">${t.suggest.slice(0, 4).map(s => `<button class="gal-sug" data-sug="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : '';
  gridEl.innerHTML = `<div class="gal-empty">
    <span class="ico">${ICON.image}</span>
    <h3>${searching ? `No ${esc(t.short)} photos match “${esc(query)}”` : `No ${esc(t.short)} photos yet`}</h3>
    <p>${searching ? 'Try a broader word, or clear the search to see everything we have.' : esc(t.emptyNote || 'NASA’s library has no science images filed under this telescope.')}</p>
    ${searching ? '<button class="btn" data-clear>Clear search</button>' : ''}
    ${!searching && t.emptyLink ? `<button class="btn primary" data-tel="${esc(t.emptyLink.key)}">${esc(t.emptyLink.label)}</button>` : ''}
    ${searching ? sugg : ''}</div>`;
  footEl.innerHTML = '';
  countEl.textContent = '';
  // the empty block lives in the grid; footer observer would re-fire forever otherwise
  gridEl.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', () => { searchEl.value = ''; clearEl.hidden = true; runSearch(''); }));
  gridEl.querySelectorAll('[data-sug]').forEach(b => b.addEventListener('click', () => applyQuery(b.dataset.sug)));
  gridEl.querySelectorAll('[data-tel]').forEach(b => b.addEventListener('click', () => setTelescope(getTelescope(b.dataset.tel), '')));
}

// ---- justified-row layout --------------------------------------------------------------------------------------------
const GAP = () => (gridEl.clientWidth < 600 ? 4 : 6);
const ROW_H = w => (w < 520 ? 130 : w < 900 ? 180 : 230);
const arOf = r => Math.max(0.55, Math.min(2.6, r.w / r.h || 1));
let tileEls = [];

function showSkeleton() {
  const fake = Array.from({ length: 28 }, (_, k) => ({ skel: true, w: [4, 3, 5, 3, 6, 4, 3, 5][k * 5 % 8] * 100, h: [3, 4, 3, 3, 4, 3, 5, 4][k * 3 % 8] * 100 }));
  tileEls = fake.map((r, k) => { const d = document.createElement('div'); d.className = 'gal-tile skel'; d.style.setProperty('--i', k); d.setAttribute('aria-hidden', 'true'); d._r = r; return d; });
  layout();
}

function appendTiles(start, first) {
  if (first) tileEls = [];
  for (let k = start; k < items.length; k++) {
    const r = items[k];
    const b = document.createElement('button');
    b.className = 'gal-tile' + (reduced() ? '' : ' pop');
    b.type = 'button'; b.dataset.i = k; b.setAttribute('role', 'listitem');
    b.style.setProperty('--i', Math.min(k - start, 14));
    b.setAttribute('aria-label', `${r.title}${r.date ? ', ' + r.date.slice(0, 4) : ''}. Open photo`);
    const im = document.createElement('img');
    im.alt = ''; im.decoding = 'async'; im.loading = 'lazy'; im.draggable = false;
    im.src = r.th;
    if (r.th2 && r.th2 !== r.th) im.srcset = `${r.th} ${r.thw || 640}w, ${r.th2} ${r.th2w || 1280}w`;
    im.sizes = '(max-width: 760px) 50vw, 340px';
    const done = () => b.classList.add('ld');
    im.addEventListener('load', done, { once: true });
    im.addEventListener('error', () => { b.classList.add('ld'); b.style.opacity = '.35'; }, { once: true });
    if (im.complete && im.naturalWidth) done();
    b.append(im);
    const cap = document.createElement('span'); cap.className = 'gal-cap';
    cap.innerHTML = `<b>${esc(r.title)}</b><span>${esc(r.date.slice(0, 4))}${r.credit ? ' · ' + esc(r.credit.split(/[,/;]/)[0].slice(0, 30)) : ''}</span>`;
    b.append(cap);
    b._r = r;
    tileEls.push(b);
  }
  layout();
}

function layout() {
  if (!gridEl || !tileEls.length) return;
  const W = gridEl.clientWidth; if (W < 50) return;
  const gap = GAP(), H = ROW_H(W);
  const rows = []; let cur = [], sum = 0;
  for (const el of tileEls) {
    const ar = arOf(el._r); cur.push([el, ar]); sum += ar;
    if (sum * H + gap * (cur.length - 1) >= W) { rows.push({ cur, sum, full: true }); cur = []; sum = 0; }
  }
  if (cur.length) rows.push({ cur, sum, full: false });
  const frag = document.createDocumentFragment();
  rows.forEach((row, idx) => {
    const d = document.createElement('div'); d.className = 'gal-row'; d.setAttribute('role', 'presentation');
    const avail = W - gap * (row.cur.length - 1);
    let h = avail / row.sum;
    if (!row.full) h = Math.min(H * 1.15, h);                 // last row: don't blow tiles up
    else h = Math.min(h, H * 1.5);
    let used = 0;
    row.cur.forEach(([el, ar], k) => {
      let w = Math.floor(ar * h);
      if (row.full && k === row.cur.length - 1) w = avail - used;  // absorb rounding so rows end flush
      used += w;
      el.style.width = w + 'px'; el.style.height = Math.round(h) + 'px';
      d.appendChild(el);
    });
    frag.appendChild(d);
  });
  gridEl.replaceChildren(frag);
}

// ---- keyboard: capture-phase so global shortcuts (/, Esc-to-deselect, timebar keys …) never fire under the modal ------------
function onKey(e) {
  if (!isOpen()) return;
  if (e.key === 'Tab') {                                     // focus trap
    const scope = lb?.isOpen ? lb.root : dlg;
    const f = [...scope.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (!scope.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    e.stopPropagation(); return;
  }
  if (lb?.isOpen) {
    const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea');
    if (!typing && lb.key(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); lb.close(); return; }
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (document.activeElement === searchEl && searchEl.value) { applyQuery(''); return; }
    closeGallery(); return;
  } else if (e.key === 'Enter' && e.target === searchEl) {
    e.preventDefault(); clearTimeout(searchTimer); runSearch(searchEl.value.trim());
  }
  e.stopPropagation();                                       // keep every other key away from the globe/timebar handlers
}
