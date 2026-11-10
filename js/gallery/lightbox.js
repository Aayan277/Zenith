// Full-size image viewer inside the gallery modal: prev/next (buttons, arrows, swipe), click-to-zoom + drag-pan,
// trimmed description with a "more" toggle, credit, "Open on NASA" and download links.
import { nasaUrl } from './source.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ico = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  prev: ico('<path d="M15 5l-7 7 7 7"/>'), next: ico('<path d="M9 5l7 7-7 7"/>'), close: ico('<path d="M6 6l12 12M18 6L6 18"/>'),
  ext: ico('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  dl: ico('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
};
const TRIM = 280, MAX_ZOOM = 3;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtDate = iso => { const d = new Date(iso + 'T12:00:00Z'); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); };

export function createLightbox(host, { onClose, onNeedMore } = {}) {
  const el = document.createElement('div');
  el.className = 'gal-lb'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Image viewer');
  el.innerHTML = `
    <div class="lb-stage">
      <img class="lb-img" alt="" draggable="false" decoding="async">
      <span class="lb-spin" aria-hidden="true"></span>
      <button class="gal-icon-btn lb-nav prev" aria-label="Previous image" data-lb="prev">${I.prev}</button>
      <button class="gal-icon-btn lb-nav next" aria-label="Next image" data-lb="next">${I.next}</button>
      <span class="lb-hint">Click to zoom · drag to pan · ← → to browse · Esc to close</span>
    </div>
    <aside class="lb-info scroll" aria-live="polite">
      <p class="eyebrow lb-count mono"></p>
      <h3 class="lb-title"></h3>
      <p class="lb-date"></p>
      <p class="lb-desc"></p>
      <button class="lb-more" aria-expanded="false" hidden>More</button>
      <p class="lb-credit"></p>
      <div class="lb-actions">
        <a class="btn primary lb-nasa" target="_blank" rel="noopener">${I.ext}Open on NASA</a>
        <a class="btn lb-dl" target="_blank" rel="noopener" download>${I.dl}Download</a>
      </div>
    </aside>
    <button class="gal-icon-btn lb-close" aria-label="Close viewer" data-lb="close">${I.close}</button>`;
  host.appendChild(el);
  const $ = s => el.querySelector(s);
  const stage = $('.lb-stage'), img = $('.lb-img'), spin = $('.lb-spin'), prevB = $('.lb-nav.prev'), nextB = $('.lb-nav.next');
  const more = $('.lb-more'), descEl = $('.lb-desc');

  let items = [], i = -1, open = false, expanded = false, done = false, token = 0, lastFocus = null, waiting = false;
  let z = 1, tx = 0, ty = 0;

  // ---- zoom / pan -----------------------------------------------------------
  function bounds() {  // pan limits (px) so the image can't be dragged off-screen
    const sw = stage.clientWidth, sh = stage.clientHeight, nw = img.naturalWidth || sw, nh = img.naturalHeight || sh;
    const fit = Math.min(sw / nw, sh / nh), dw = nw * fit * z, dh = nh * fit * z;
    return { x: Math.max(0, (dw - sw) / 2), y: Math.max(0, (dh - sh) / 2) };
  }
  function applyZoom(animate) {
    const b = bounds(); tx = Math.max(-b.x, Math.min(b.x, tx)); ty = Math.max(-b.y, Math.min(b.y, ty));
    img.classList.toggle('anim', !!animate && !reduced());
    img.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
    stage.classList.toggle('zoomed', z > 1);
  }
  function zoomAt(clientX, clientY, target) {
    const r = stage.getBoundingClientRect(), px = clientX - (r.left + r.width / 2), py = clientY - (r.top + r.height / 2);
    const nz = Math.max(1, Math.min(MAX_ZOOM, target));
    if (nz === 1) { tx = ty = 0; } else { tx = (tx - px) * (nz / z) + px; ty = (ty - py) * (nz / z) + py; }
    z = nz; applyZoom(true);
  }
  const resetZoom = () => { z = 1; tx = ty = 0; applyZoom(false); };

  // pointer: tap = toggle zoom, drag = pan (zoomed) or swipe (not zoomed)
  let ptr = null;
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.button > 0) return;
    ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, tx, ty, moved: false, t: performance.now() };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    if (!ptr.moved && Math.hypot(dx, dy) > 6) { ptr.moved = true; if (z > 1) stage.classList.add('dragging'); }
    if (ptr.moved && z > 1) { tx = ptr.tx + dx; ty = ptr.ty + dy; applyZoom(false); }
  });
  const endPtr = e => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y, p = ptr; ptr = null;
    stage.classList.remove('dragging');
    if (!p.moved) { if (e.type === 'pointerup') zoomAt(e.clientX, e.clientY, z > 1 ? 1 : 2.4); return; }
    if (z === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);
  stage.addEventListener('wheel', e => {
    if (!open) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, z * Math.exp(-e.deltaY * 0.0022));
  }, { passive: false });
  new ResizeObserver(() => { if (open) applyZoom(false); }).observe(stage);

  // ---- showing an item ------------------------------------------------------
  function trimDesc(s) {
    if (s.length <= TRIM + 40) return { short: s, long: s };
    const cut = s.slice(0, TRIM).replace(/\s+\S*$/, '');
    return { short: cut + '…', long: s };
  }
  function paintInfo(r) {
    $('.lb-count').textContent = `${i + 1} / ${items.length}${done ? '' : '+'}`;
    $('.lb-title').textContent = r.title;
    $('.lb-date').textContent = r.date ? `Published ${fmtDate(r.date)}${r.center ? ' · ' + r.center.replace(/\s*\(.*\)/, '') : ''}` : '';
    const t = trimDesc(r.desc || '');
    descEl.textContent = expanded ? t.long : t.short;
    more.hidden = t.short === t.long; more.textContent = expanded ? 'Less' : 'More'; more.setAttribute('aria-expanded', String(expanded));
    $('.lb-credit').innerHTML = `${r.credit ? `<b>Credit:</b> ${esc(r.credit)}<br>` : ''}<b>Source:</b> NASA Image and Video Library`;
    $('.lb-nasa').href = nasaUrl(r.id);
    const dl = $('.lb-dl'); dl.href = r.dl; dl.setAttribute('download', r.id);
    $('.lb-info').scrollTop = 0;
  }
  const preload = r => { if (r) { const p = new Image(); p.decoding = 'async'; p.src = r.lg; } };

  function show(n, anchorEl) {
    if (n < 0 || n >= items.length) return;
    i = n; expanded = false; waiting = false;
    const r = items[i], my = ++token;
    paintInfo(r); resetZoom();
    img.alt = r.title;
    // instant: the already-cached grid thumbnail (blurred), then swap in the large image when it has decoded
    img.classList.remove('on', 'soft'); img.classList.add('soft');
    img.src = r.th; requestAnimationFrame(() => img.classList.add('on'));
    spin.classList.add('on');
    const big = new Image(); big.decoding = 'async'; big.src = r.lg;
    const fin = () => { if (my !== token) return; img.src = r.lg; img.classList.remove('soft'); spin.classList.remove('on'); preload(items[i + 1]); preload(items[i - 1]); };
    (big.decode ? big.decode().then(fin, fin) : (big.onload = big.onerror = fin));
    prevB.disabled = i === 0;
    nextB.disabled = i === items.length - 1 && done;
    if (i >= items.length - 3 && !done) onNeedMore?.();
    if (anchorEl) anchorEl.focus?.({ preventScroll: true });
  }
  function go(d) {
    const n = i + d;
    if (n < 0) return;
    if (n >= items.length) { if (!done) { waiting = true; spin.classList.add('on'); onNeedMore?.(); } return; }
    show(n);
  }

  more.addEventListener('click', () => { expanded = !expanded; paintInfo(items[i]); });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-lb]'); if (!b) return;
    if (b.dataset.lb === 'prev') go(-1); else if (b.dataset.lb === 'next') go(1); else api.close();
  });

  const api = {
    get isOpen() { return open; },
    open(list, index, { isDone = false, from = null } = {}) {
      items = list; done = isDone; lastFocus = from || document.activeElement;
      open = true; el.hidden = false;
      requestAnimationFrame(() => el.classList.add('show'));
      show(index);
      $('.lb-close').focus({ preventScroll: true });
    },
    /** More items arrived (or the feed finished) while the viewer is open. */
    update(list, isDone) {
      items = list; done = isDone;
      if (!open) return;
      $('.lb-count').textContent = `${i + 1} / ${items.length}${done ? '' : '+'}`;
      nextB.disabled = i === items.length - 1 && done;
      if (waiting && items.length > i + 1) { waiting = false; show(i + 1); }
      else if (waiting && done) { waiting = false; spin.classList.remove('on'); }
    },
    close() {
      if (!open) return;
      open = false; waiting = false; token++; el.classList.remove('show'); resetZoom();
      setTimeout(() => { if (!open) { el.hidden = true; img.removeAttribute('src'); } }, reduced() ? 0 : 250);
      onClose?.(items[i], lastFocus);
    },
    /** Key handling while open (called from the gallery's window-level capture handler). Returns true if consumed. */
    key(e) {
      if (!open) return false;
      switch (e.key) {
        case 'ArrowRight': go(1); return true;
        case 'ArrowLeft': go(-1); return true;
        case 'Home': show(0); return true;
        case 'End': show(items.length - 1); return true;
        case 'Escape': api.close(); return true;
        case '+': case '=': zoomAt(...centre(), z * 1.5); return true;
        case '-': case '_': zoomAt(...centre(), z / 1.5); return true;
        case '0': resetZoom(); return true;
      }
      return false;
    },
    get root() { return el; },
    destroy() { open = false; token++; el.remove(); },
  };
  const centre = () => { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return api;
}
