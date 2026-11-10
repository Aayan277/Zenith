// Detail panel for state.selection. Renders whatever the registered provider returns, twice a second.
import * as state from '../state.js';
import { now } from '../clock.js';
import { getSat, isFullCatalog } from '../data/catalog.js';
import { SHARE_ICON } from './share.js';

const svg = (inner, extra = '') => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${inner}</svg>`;
const ICONS = {
  rocket: svg('<path d="M12 2.5c3 2 4.5 5.2 4.5 9V15h-9v-3.5c0-3.8 1.5-7 4.5-9z"/><circle cx="12" cy="9.5" r="1.6"/><path d="M7.5 13.5L5 16.5V19l2.5-1.5M16.5 13.5l2.5 3V19l-2.5-1.5M10 18.5l2 3 2-3"/>'),
  sat: svg('<rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M4 7l4 4M6 5l4 4M16 15l4 4M14 17l4 4M12 12l-5.5 5.5M12 12l5.5-5.5" opacity=".9"/><path d="M3.5 20.5l3-3"/>'),
  planet: svg('<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-20 12 12)"/>'),
  star: svg('<path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/>'),
  moon: svg('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/>'),
  constellation: svg('<circle cx="5" cy="17" r="1.5"/><circle cx="10" cy="8" r="1.5"/><circle cx="17" cy="12" r="1.5"/><circle cx="19" cy="5" r="1.5"/><path d="M6 15.7l3.2-6.4M11.4 8.6l4.2 2.6M17.6 10.6l.9-4"/>'),
};
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let panel, card, selSince = 0, sel = null, sig = '', timer = 0, hideTimer = 0, latestActions = [];
const tweens = new WeakMap();

function defaultIcon(sel) {
  return { sat: 'sat', body: 'planet', star: 'star', constellation: 'constellation' }[sel.kind] || 'sat';
}

// ---- animated numbers -------------------------------------------------------
const NUM = /^([+-−]?)(\d[\d,]*)(\.\d+)?$/;
function parseNum(v) {
  const m = NUM.exec(String(v).trim());
  if (!m) return null;
  return { n: parseFloat(m[1].replace('−', '-') + m[2].replace(/,/g, '') + (m[3] || '')), dec: (m[3] || '.').length - 1, comma: m[2].includes(','), minus: m[1] === '−' };
}
function fmtNum(n, p) {
  let s = Math.abs(n).toFixed(p.dec);
  if (p.comma) { const [a, b] = s.split('.'); s = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : ''); }
  return (n < 0 ? (p.minus ? '−' : '-') : '') + s;
}
function setValue(el, v) {
  v = String(v ?? '');
  if (el.dataset.raw === v) return;
  const prev = parseNum(el.dataset.raw ?? ''), next = parseNum(v);
  el.dataset.raw = v;
  const t = tweens.get(el); if (t) cancelAnimationFrame(t);
  if (!prev || !next || prev.dec !== next.dec || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = v; return; }
  const from = prev.n, to = next.n, t0 = performance.now(), dur = 420;
  const step = t => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = k >= 1 ? v : fmtNum(from + (to - from) * e, next);
    if (k < 1) tweens.set(el, requestAnimationFrame(step));
  };
  tweens.set(el, requestAnimationFrame(step));
}

// ---- rendering ---------------------------------------------------------------
function header(d, loading) {
  return `
    <header class="dp-head">
      <span class="dp-icon">${ICONS[d.icon] || ICONS.sat}</span>
      <div class="dp-titles"><h2 class="dp-title">${esc(d.title)}</h2>${d.subtitle ? `<p class="dp-sub">${esc(d.subtitle)}</p>` : ''}</div>
      <div class="dp-btns">
        <button class="dp-share" aria-label="Share link to this object" aria-haspopup="dialog" aria-expanded="false" title="Share a link">${SHARE_ICON}</button>
        <button class="dp-close" aria-label="Close details" title="Close (Esc)">${ICON_CLOSE}</button>
      </div>
    </header>`;
}

function renderLoading() {
  const s = sel;
  const sat = s.kind === 'sat' ? getSat(s.id) : null;
  const d = { title: sat?.notable || sat?.name || (s.kind === 'body' ? String(s.id) : `${s.kind} ${s.id}`), subtitle: 'Locating…', icon: defaultIcon(s) };
  const k = 'loading|' + d.title;
  if (sig === k) return;
  sig = k;
  panel.style.setProperty('--dp-accent', 'var(--accent)');
  card.innerHTML = header(d) + `
    <div class="dp-body"><div class="dp-stats">${'<div class="dp-stat sk"><span class="sk-bar w40"></span><span class="sk-bar w80"></span></div>'.repeat(4)}</div>
    <div class="dp-rows">${'<div class="dp-row sk"><span class="sk-bar w30"></span><span class="sk-bar w40"></span></div>'.repeat(3)}</div></div>`;
}

// Kinds a provider is registered for. Anything else (e.g. 'gallery') has no detail card.
const KNOWN = new Set(['sat', 'body', 'star', 'constellation', 'craft', 'world', 'launch']);

function renderUnavailable() {
  const s = sel, k = 'na|' + s.kind + '|' + s.id;
  if (sig === k) return;
  sig = k;
  const sat = s.kind === 'sat';
  const d = { title: sat ? `Satellite ${s.id}` : KNOWN.has(s.kind) ? `${s.kind[0].toUpperCase()}${s.kind.slice(1)} ${s.id}` : 'Nothing to show', icon: defaultIcon(s),
    subtitle: sat ? 'Not in the catalog' : 'No details available' };
  panel.style.setProperty('--dp-accent', 'var(--text-faint)');
  card.innerHTML = header(d) + `<div class="dp-body"><p class="dp-note">${sat ? 'This satellite is not in the current catalog. It may have decayed, or the number may be wrong.' : 'There is nothing to display for this selection. Close this panel to carry on.'}</p></div>`;
}

function render() {
  if (!sel) return;
  // Selections that are really "open something else": the telescope-photo gallery.
  if (sel.kind === 'gallery') {
    const id = sel.id; state.set('selection', null);
    import('../gallery/index.js').then(m => m.openGallery(!id || id === 'all' ? 'hubble' : id)).catch(e => console.error('[detail:gallery]', e));
    return;
  }
  let d = null;
  try { d = state.getDetail(sel, now()); } catch (e) { console.error('[detail]', e); }
  if (!d) {
    // Providers register when their module loads: show the skeleton first, then give up gracefully.
    const waited = performance.now() - selSince;
    const limit = !KNOWN.has(sel.kind) ? 1200 : sel.kind === 'sat' ? (isFullCatalog() ? 2500 : 40000) : 15000;
    if (waited > limit && !(sel.kind === 'sat' && getSat(sel.id))) renderUnavailable(); else renderLoading();
    return;
  }
  try { renderDetail(d); } catch (e) { console.error('[detail]', e); renderUnavailable(); }
}

function renderDetail(d) {
  const stats = (d.stats || []).slice(0, 6), rows = d.rows || [], actions = d.actions || [];
  const icon = d.icon || defaultIcon(sel);
  const k = JSON.stringify([sel.kind, sel.id, d.title, d.subtitle, d.color, icon, stats.map(s => [s.label, s.unit]), rows.map(r => r.label), !!d.note, actions.map(a => a.label), d.media?.src || '']);
  latestActions = actions;
  if (k !== sig) {
    sig = k;
    panel.style.setProperty('--dp-accent', d.color || 'var(--accent)');
    card.innerHTML = header({ ...d, icon }) + `
      <div class="dp-body scroll">
        ${d.media?.src ? `<figure class="dp-media">${d.media.href ? `<a href="${esc(d.media.href)}" target="_blank" rel="noopener">` : ''}<img src="${esc(d.media.src)}" alt="${esc(d.media.alt || '')}" loading="lazy" decoding="async">${d.media.href ? '</a>' : ''}${d.media.caption ? `<figcaption>${esc(d.media.caption)}</figcaption>` : ''}</figure>` : ''}
        ${stats.length ? `<div class="dp-stats" data-n="${stats.length}">${stats.map(s => `
          <div class="dp-stat"><span class="dp-stat-label eyebrow">${esc(s.label)}</span>
            <span class="dp-stat-line"><span class="dp-val mono"></span>${s.unit ? `<span class="dp-unit">${esc(s.unit)}</span>` : ''}</span></div>`).join('')}</div>` : ''}
        ${rows.length ? `<dl class="dp-rows">${rows.map(r => `<div class="dp-row"><dt>${esc(r.label)}</dt><dd class="mono"></dd></div>`).join('')}</dl>` : ''}
        ${d.note ? '<p class="dp-note"></p>' : ''}
        ${actions.length ? `<div class="dp-actions">${actions.map((a, i) => `<button class="btn${i === 0 ? ' primary' : ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
      </div>`;
  }
  const vals = card.querySelectorAll('.dp-val');
  stats.forEach((s, i) => vals[i] && setValue(vals[i], s.value));
  const dds = card.querySelectorAll('.dp-row dd');
  rows.forEach((r, i) => { if (dds[i] && dds[i].textContent !== String(r.value ?? '')) dds[i].textContent = r.value ?? ''; });
  const note = card.querySelector('.dp-note');
  if (note && note.textContent !== d.note) note.textContent = d.note;
}

function show() {
  clearTimeout(hideTimer);
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));
  clearInterval(timer);
  timer = setInterval(render, 500);
}
function hide() {
  clearInterval(timer);
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  hideTimer = setTimeout(() => { if (!sel) { panel.hidden = true; card.innerHTML = ''; sig = ''; } }, 400);
}

export function init() {
  panel = document.getElementById('panel-detail');
  if (!panel) return;
  panel.hidden = true;
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'Object details');
  panel.innerHTML = '<div class="dp-card glass"></div>';
  card = panel.firstElementChild;

  card.addEventListener('click', e => {
    if (e.target.closest('.dp-close')) { state.set('selection', null); return; }
    const sh = e.target.closest('.dp-share');
    if (sh) { import('./share.js').then(m => m.toggleShare(sh)).catch(err => console.error('[detail:share]', err)); return; }
    const b = e.target.closest('[data-a]');
    if (b) { try { latestActions[+b.dataset.a]?.onClick?.(); } catch (err) { console.error(err); } }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sel && !e.defaultPrevented) { state.set('selection', null); }
  });

  state.on('selection', s => {
    const was = sel;
    sel = s;
    if (!s) { hide(); return; }
    sig = ''; selSince = performance.now();
    if (was && (was.kind !== s.kind || was.id !== s.id)) { card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap'); }
    show();
    render();
  });
  state.on('catalogReady', () => sel && render());
  if (state.get('selection')) { sel = state.get('selection'); selSince = performance.now(); show(); render(); }
}
