// "More photos" for a deep-sky object: a photo-grid modal fed by NASA Image and Video Library search results.
// It reuses the gallery's look (css/gallery.css classes), its feed/filter code (js/gallery/source.js) and its lightbox
// (js/gallery/lightbox.js) by import; js/gallery itself is untouched.
//   openSearchGallery(title, query, { queries?, kicker?, blurb?, include?, meta? })
import { createFeed } from '../gallery/source.js';
import { createLightbox } from '../gallery/lightbox.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ico = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON_CLOSE = ico('<path d="M6 6l12 12M18 6L6 18"/>');
const ICON_IMG = ico('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="M4 17l5-4.5 3.5 3L16 12l4 4"/>');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

let cssPromise = null;
function loadCss() {
  if (cssPromise) return cssPromise;
  cssPromise = new Promise(res => {
    const href = new URL('../../css/gallery.css', import.meta.url).href;
    if ([...document.styleSheets].some(s => s.href === href) || document.querySelector(`link[href="${href}"]`)) return res();
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
    l.onload = l.onerror = () => res();
    document.head.appendChild(l);
    setTimeout(res, 2500);
  });
  return cssPromise;
}

let cur = null;      // the open instance
export const isOpen = () => !!cur && cur.back.isConnected;
export function closeSearchGallery() { cur?.close(); }

export async function openSearchGallery(title, query, opts = {}) {
  if (cur) cur.close(true);
  await loadCss();
  const queries = (opts.queries?.length ? opts.queries : [query]).filter(Boolean);
  const tel = {   // a synthetic "telescope" for createFeed
    key: 'dso', short: title, name: title, curated: [], suggest: [],
    search: { sources: queries.map(q => ({ q })), include: opts.include || null },
  };
  const root = document.getElementById('modal-root') || document.body;
  const back = document.createElement('div');
  back.className = 'gal-back';
  const meta = (opts.meta || []).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  back.innerHTML = `
    <div class="gal glass" role="dialog" aria-modal="true" aria-labelledby="dsog-title" style="--g:#ffa680">
      <header class="gal-head">
        <div class="gal-id"><div class="sw">
          <p class="eyebrow gal-eyebrow">Deep-sky photos${opts.kicker ? ` · ${esc(opts.kicker)}` : ''}</p>
          <h2 class="gal-title" id="dsog-title">${esc(title)}</h2>
          ${opts.blurb ? `<p class="gal-blurb">${esc(opts.blurb)}</p>` : ''}
          ${meta ? `<dl class="gal-meta">${meta}</dl>` : ''}
        </div></div>
        <div class="gal-head-actions"><button class="gal-icon-btn gal-close" aria-label="Close gallery" title="Close (Esc)">${ICON_CLOSE}</button></div>
      </header>
      <div class="gal-bar"><span class="gal-count mono" aria-live="polite"></span></div>
      <div class="gal-scroll scroll" tabindex="-1"><div class="gal-grid" role="list"></div><div class="gal-foot"></div></div>
    </div>`;
  root.appendChild(back);
  const dlg = back.querySelector('.gal'), gridEl = back.querySelector('.gal-grid'), scrollEl = back.querySelector('.gal-scroll'),
    footEl = back.querySelector('.gal-foot'), countEl = back.querySelector('.gal-count');
  const lastFocus = document.activeElement;
  const feed = createFeed(tel, { query: '' });
  let items = [], loading = false, errored = false, closed = false, tileEls = [], io = null, ro = null;

  const lb = createLightbox(dlg, {
    onNeedMore: () => loadMore(),
    onClose: (_r, from) => { try { (from && from.isConnected ? from : back.querySelector('.gal-close')).focus({ preventScroll: true }); } catch {} },
  });

  function close(quick) {
    if (closed) return; closed = true;
    io?.disconnect(); ro?.disconnect();
    window.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('modal-open');
    lb.destroy();
    back.classList.remove('show');
    setTimeout(() => back.remove(), quick || reduced() ? 0 : 260);
    try { lastFocus?.focus?.({ preventScroll: true }); } catch {}
    if (cur === inst) cur = null;
  }
  const inst = { back, close };
  cur = inst;

  function onKey(e) {
    if (closed) return;
    if (e.key === 'Tab') {
      const scope = lb.isOpen ? lb.root : dlg;
      const f = [...scope.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (!scope.contains(a)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      e.stopPropagation(); return;
    }
    if (lb.isOpen) {
      if (lb.key(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); lb.close(); return; }
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    e.stopPropagation();
  }

  // ---- layout (justified rows, same rules as the telescope gallery) ----
  const GAP = () => (gridEl.clientWidth < 600 ? 4 : 6);
  const ROW_H = w => (w < 520 ? 130 : w < 900 ? 180 : 230);
  const arOf = r => Math.max(0.55, Math.min(2.6, r.w / r.h || 1));
  function layout() {
    if (!tileEls.length) return;
    const W = gridEl.clientWidth; if (W < 50) return;
    const gap = GAP(), H = ROW_H(W), rows = []; let c = [], sum = 0;
    for (const el of tileEls) { const ar = arOf(el._r); c.push([el, ar]); sum += ar; if (sum * H + gap * (c.length - 1) >= W) { rows.push({ c, sum, full: true }); c = []; sum = 0; } }
    if (c.length) rows.push({ c, sum, full: false });
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const d = document.createElement('div'); d.className = 'gal-row'; d.setAttribute('role', 'presentation');
      const avail = W - gap * (row.c.length - 1);
      let h = avail / row.sum; h = row.full ? Math.min(h, H * 1.5) : Math.min(H * 1.15, h);
      let used = 0;
      row.c.forEach(([el, ar], k) => {
        let w = Math.floor(ar * h); if (row.full && k === row.c.length - 1) w = avail - used; used += w;
        el.style.width = w + 'px'; el.style.height = Math.round(h) + 'px'; d.appendChild(el);
      });
      frag.appendChild(d);
    }
    gridEl.replaceChildren(frag);
  }
  function showSkeleton() {
    tileEls = Array.from({ length: 24 }, (_, k) => { const d = document.createElement('div'); d.className = 'gal-tile skel'; d.style.setProperty('--i', k); d.setAttribute('aria-hidden', 'true'); d._r = { w: [4, 3, 5, 3, 6, 4, 3, 5][k * 5 % 8] * 100, h: [3, 4, 3, 3, 4, 3, 5, 4][k * 3 % 8] * 100 }; return d; });
    layout();
  }
  function appendTiles(start, first) {
    if (first) tileEls = [];
    for (let k = start; k < items.length; k++) {
      const r = items[k], b = document.createElement('button');
      b.className = 'gal-tile' + (reduced() ? '' : ' pop'); b.type = 'button'; b.dataset.i = k; b.setAttribute('role', 'listitem');
      b.style.setProperty('--i', Math.min(k - start, 14));
      b.setAttribute('aria-label', `${r.title}${r.date ? ', ' + r.date.slice(0, 4) : ''}. Open photo`);
      const im = document.createElement('img'); im.alt = ''; im.decoding = 'async'; im.loading = 'lazy'; im.draggable = false; im.src = r.th;
      if (r.th2 && r.th2 !== r.th) im.srcset = `${r.th} ${r.thw || 640}w, ${r.th2} ${r.th2w || 1280}w`;
      im.sizes = '(max-width: 760px) 50vw, 340px';
      const done = () => b.classList.add('ld');
      im.addEventListener('load', done, { once: true });
      im.addEventListener('error', () => { b.classList.add('ld'); b.style.opacity = '.35'; }, { once: true });
      if (im.complete && im.naturalWidth) done();
      b.append(im);
      const cap = document.createElement('span'); cap.className = 'gal-cap';
      cap.innerHTML = `<b>${esc(r.title)}</b><span>${esc(r.date.slice(0, 4))}${r.credit ? ' · ' + esc(r.credit.split(/[,/;]/)[0].slice(0, 30)) : ''}</span>`;
      b.append(cap); b._r = r; tileEls.push(b);
    }
    layout();
  }

  // ---- feed ----
  const credit = `<p class="fine">Images: <a href="https://images.nasa.gov" target="_blank" rel="noopener">NASA Image and Video Library</a>. NASA imagery is generally public domain; credits are shown with each image.</p>`;
  function paintFoot() {
    if (errored) { footEl.innerHTML = `<p>Couldn’t reach the NASA image library.</p><button class="btn" data-retry>Try again</button>`; return; }
    if (loading) { footEl.innerHTML = items.length ? '<span class="gal-spin" role="status" aria-label="Loading more photos"></span>' : ''; return; }
    if (!items.length) { footEl.innerHTML = ''; return; }
    footEl.innerHTML = !feed.done ? `<button class="btn" data-more>Load more</button>${credit}` : `<p>That’s every photo of ${esc(title)} we found in NASA’s library.</p>${credit}`;
  }
  function paintCount() { const n = items.length; countEl.textContent = n ? `${n}${feed.done ? '' : '+'} photo${n === 1 && feed.done ? '' : 's'} of ${title}` : ''; }
  function renderEmpty() {
    gridEl.innerHTML = `<div class="gal-empty"><span class="ico">${ICON_IMG}</span><h3>No photos of ${esc(title)} in NASA’s library</h3><p>The library mostly holds Hubble, Spitzer, Chandra and Webb releases; fainter objects often have none.</p>
      <a class="btn" target="_blank" rel="noopener" href="https://images.nasa.gov/search?q=${encodeURIComponent(query)}&media=image">Search images.nasa.gov</a></div>`;
    footEl.innerHTML = ''; countEl.textContent = '';
  }
  async function loadMore() {
    if (closed || loading || feed.done) return;
    loading = true; errored = false; paintFoot();
    try {
      const r = await feed.next(items.length ? 24 : 30);
      if (closed) return;
      const first = !items.length && r.items.length > 0;
      if (first) gridEl.innerHTML = '';
      const start = items.length; items = items.concat(r.items); appendTiles(start, first);
    } catch (e) { if (closed) return; errored = true; console.warn('[sky gallery]', e); }
    if (closed) return;
    loading = false; paintFoot(); paintCount(); lb.update(items, !!feed.done);
    if (!items.length && feed.done && !errored) renderEmpty();
    if (io && !feed.done && !errored) { io.unobserve(footEl); io.observe(footEl); }
  }

  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.querySelector('.gal-close').addEventListener('click', () => close());
  gridEl.addEventListener('click', e => { const t = e.target.closest('.gal-tile:not(.skel)'); if (t) lb.open(items, +t.dataset.i, { isDone: !!feed.done, from: t }); });
  footEl.addEventListener('click', e => { if (e.target.closest('[data-more]')) loadMore(); else if (e.target.closest('[data-retry]')) { errored = false; loadMore(); } });
  io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) loadMore(); }, { root: scrollEl, rootMargin: '700px 0px' });
  io.observe(footEl);
  let lastW = 0;
  ro = new ResizeObserver(() => { const w = gridEl.clientWidth; if (Math.abs(w - lastW) > 1) { lastW = w; layout(); } });
  ro.observe(gridEl);

  document.body.classList.add('modal-open');
  window.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => back.classList.add('show'));
  setTimeout(() => { if (!lb.isOpen) back.querySelector('.gal-close')?.focus({ preventScroll: true }); }, 60);
  showSkeleton();
  loadMore();
  return inst;
}
