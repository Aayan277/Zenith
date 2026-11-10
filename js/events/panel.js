// Events tab of the left panel: the next 12 months of sky events for the observer, grouped by month, with filters and a hero card.
// Computed lazily when the tab opens (js/events/index.js), in idle slices, cached per location.
import * as state from '../state.js';
import * as clock from '../clock.js';
import { ensureEvents, onEvents, eventStatus, upcomingEvents } from './index.js';
import { openCalMenu, calBtn } from './calmenu.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { esc, evIcon, evColor, chip, chipTone, fmtWhen, fmtDate, calSpec, goToEvent } from './ui.js';
import './detail.js';

const FILTERS = [['all', 'All'], ['meteor', 'Meteors'], ['eclipse', 'Eclipses'], ['moon', 'Moon'], ['planet', 'Planets']];
const FILTER_KEY = 'zenith:events:filter';
let el, shown = false, filter = 'all', timer = 0, sig = '', events = [], unsub = null;
try { const f = sessionStorage.getItem(FILTER_KEY); if (FILTERS.some(x => x[0] === f)) filter = f; } catch {}

const ymKey = ms => fmtLocal(ms, { year: 'numeric', month: '2-digit' });                      // locale dependent but stable as a group key
const ymLabel = ms => fmtLocal(ms, { month: 'long', year: 'numeric' });
const dayNum = ms => fmtLocal(ms, { day: 'numeric' });
const wkday = ms => fmtLocal(ms, { weekday: 'short' });

const ERR = msg => `<div class="tn-card"><div class="tn-err"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg><span>${esc(msg)}</span></div></div>`;

function pickHero(list, now) {
  const fut = list.filter(e => e.t >= now - 3 * 3600e3);
  return fut.find(e => e.importance >= 6 && e.vis !== 'no') || fut.find(e => e.importance >= 5 && e.vis !== 'no') || fut.find(e => e.importance >= 4 && e.vis !== 'no') || fut[0] || null;
}

function visChip(ev, short = false) {
  const t = ev.vis === 'no' ? ['no', 'Not visible'] : ev.vis === 'part' ? ['part', ev.type === 'meteor' ? 'Poor sky' : short ? 'Partly' : 'Partly visible'] : ev.vis === 'yes' ? ['yes', ev.type === 'meteor' ? '' : 'Visible'] : null;
  return t && t[1] ? `<span class="ev-vis ${t[0]}">${t[1]}</span>` : '';
}

function heroHtml(ev, now) {
  const c = evColor(ev), v = ev.viewMs ?? ev.t;
  return `<article class="ev-hero" style="--c:${c}" data-id="${esc(ev.id)}" tabindex="0" role="button" aria-label="${esc(ev.title)}, open in sky">
    <div class="ev-hero-glow"></div>
    <div class="ev-hero-top"><span class="eyebrow">Next big event</span><span class="ev-chip big ${chipTone(ev.t, now)}" data-chip="${ev.t}">${esc(chip(ev.t, now))}</span></div>
    <div class="ev-hero-main"><span class="ev-hero-ic">${evIcon(ev, 34)}</span>
      <div class="ev-hero-txt"><h3>${esc(ev.title)}</h3><p>${esc(ev.line)}</p></div></div>
    <div class="ev-hero-when mono">${esc(fmtWhen(ev.t))}</div>
    <p class="ev-hero-vis">${visChip(ev)}${esc(ev.visNote || '')}</p>
    <div class="ev-hero-btns"><button type="button" class="btn primary" data-act="go" data-id="${esc(ev.id)}">View in sky</button>${calBtn(`data-act="cal" data-id="${esc(ev.id)}"`)}</div>
  </article>`;
}

function rowHtml(ev, now, selId) {
  return `<div class="ev-row ${ev.vis === 'no' ? 'dim' : ''}${selId === ev.id ? ' sel' : ''}" role="button" tabindex="0" data-act="go" data-id="${esc(ev.id)}" style="--c:${evColor(ev)}" aria-label="${esc(ev.title)}, ${esc(chip(ev.t, now))}">
    <span class="ev-date"><b class="mono">${esc(dayNum(ev.t))}</b><i>${esc(wkday(ev.t))}</i></span>
    <span class="ev-ic">${evIcon(ev, 20)}</span>
    <span class="ev-txt"><b>${esc(ev.title)}</b><span>${esc(ev.line)}</span></span>
    <span class="ev-end"><span class="ev-chip ${chipTone(ev.t, now)} mono" data-chip="${ev.t}">${esc(chip(ev.t, now))}</span>${ev.type === 'meteor' ? `<span class="ev-rate ${esc(ev.badge)}">${esc(ev.badge)}</span>` : (ev.vis === 'yes' && ev.type !== 'eclipse') ? '' : visChip(ev, true)}</span>
    ${calBtn(`data-act="cal" data-id="${esc(ev.id)}"`)}
  </div>`;
}

function render() {
  if (!el) return;
  const now = Date.now(), st = eventStatus(), selId = state.get('selection')?.kind === 'event' ? state.get('selection').id : null;
  const loc = state.get('location');
  let h;
  if (st.status !== 'ready' && !events.length) {
    const pct = Math.round(st.progress * 100);
    h = `<div class="tn-card ev-loading"><div class="ev-load-t"><span class="eyebrow">Scanning the sky</span><span class="mono">${pct}%</span></div>
      <div class="ev-bar"><i style="width:${Math.max(4, pct)}%"></i></div>
      <p class="tn-empty">Working out eclipses, meteor showers, Moon phases and planet events for ${esc((loc.name || 'your location').split(',')[0])}…</p></div>
      <div class="tn-card">${'<div class="tn-skel" style="width:90%"></div><div class="tn-skel" style="width:70%"></div>'.repeat(3)}</div>`;
  } else {
    const all = events.filter(e => e.t >= now - 3 * 3600e3);
    const list = filter === 'all' ? all : all.filter(e => e.type === filter);
    const hero = pickHero(list, now);
    const rest = list.filter(e => e !== hero);
    const groups = [];
    for (const e of rest) {
      const k = ymKey(e.t); let g = groups[groups.length - 1];
      if (!g || g.k !== k) groups.push(g = { k, label: ymLabel(e.t), items: [] });
      g.items.push(e);
    }
    h = `<div class="ev-filters" role="group" aria-label="Filter events">${FILTERS.map(([k, l]) => `<button type="button" class="ev-f${filter === k ? ' on' : ''}" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
      ${hero ? heroHtml(hero, now) : `<div class="tn-card"><p class="tn-empty">Nothing in this category in the next 12 months.</p></div>`}
      ${groups.map(g => `<section class="ev-group" aria-label="${esc(g.label)}"><h4 class="ev-month"><span class="eyebrow">${esc(g.label)}</span><span>${g.items.length}</span></h4>${g.items.map(e => rowHtml(e, now, selId)).join('')}</section>`).join('')}
      <p class="tn-foot">Times in ${esc(tzLabel(now))} for ${esc((loc.name || 'your location').split(',')[0])}${st.status === 'loading' ? ' · updating…' : ''}<br>Astronomy Engine · IMO / IAU shower data</p>`;
  }
  if (h === sig) return;
  sig = h;
  const active = document.activeElement, fid = el.contains(active) ? (active.dataset.id ? `[data-act="${active.dataset.act}"][data-id="${CSS.escape(active.dataset.id)}"]` : active.dataset.f ? `[data-f="${active.dataset.f}"]` : '') : '';
  const top = el.scrollTop;
  el.innerHTML = h;
  el.scrollTop = top;
  if (fid) el.querySelector(fid)?.focus({ preventScroll: true });
}

function tickChips() {
  if (!shown || !el) return;
  const now = Date.now();
  for (const n of el.querySelectorAll('[data-chip]')) { const t = chip(+n.dataset.chip, now); if (n.textContent !== t) n.textContent = t; }
}

const byId = id => events.find(e => e.id === id);

export function mount(pane) {
  el = pane; el.classList.add('ev-pane');
  el.addEventListener('click', e => {
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; try { sessionStorage.setItem(FILTER_KEY, filter); } catch {} sig = ''; render(); return; }
    const cal = e.target.closest('[data-act="cal"]');
    if (cal) { e.stopPropagation(); const ev = byId(cal.dataset.id); if (ev) openCalMenu(cal, () => calSpec(ev)); return; }
    const go = e.target.closest('[data-act="go"]');
    if (go) { const ev = byId(go.dataset.id); if (ev) goToEvent(ev); return; }
    const hero = e.target.closest('.ev-hero');
    if (hero) { const ev = byId(hero.dataset.id); if (ev) goToEvent(ev); }
  });
  el.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.ev-row,.ev-hero')) { e.preventDefault(); const ev = byId(e.target.dataset.id); if (ev) goToEvent(ev); }
  });
  state.on('selection', () => shown && render());
  state.on('location', () => { sig = ''; events = []; if (shown) { render(); ensureEvents().then(sync); } });
  render();
}

function sync() { events = upcomingEvents(Date.now() - 3 * 3600e3, 372); sig = ''; render(); }

export function onShow() {
  shown = true;
  unsub?.(); unsub = onEvents(p => { if (!shown) return; if (p.status === 'ready') sync(); else render(); });
  const st = eventStatus();
  if (st.status === 'ready') sync(); else { render(); ensureEvents().then(sync); }
  clearInterval(timer); timer = setInterval(tickChips, 30e3);
}
export function onHide() { shown = false; unsub?.(); unsub = null; clearInterval(timer); timer = 0; }
