// Layers popover: category chips with live counts.
import * as state from '../state.js';
import { allSats } from '../data/catalog.js';

export function initLayers(bar) {
  const btn = bar.querySelector('#btn-layers');
  const pop = bar.querySelector('#layers-pop');
  const badge = bar.querySelector('#layers-badge');
  let open = false;

  const counts = () => {
    const c = {};
    for (const s of allSats()) c[s.cat] = (c[s.cat] || 0) + 1;
    return c;
  };
  const isHi = s => !!(s.notable || s.bright || s.size === 'L');
  const shownCount = () => {
    const f = state.get('filters'), hl = state.get('highlightsOnly');
    let n = 0;
    for (const s of allSats()) if (f[s.cat] && (!hl || isHi(s))) n++;
    return n;
  };
  const notableList = () => {
    const rank = s => s.id === 25544 ? 0 : s.id === 48274 ? 1 : s.id === 20580 ? 2 : s.cat === 'stations' ? 3 : 4;
    return allSats().filter(s => s.notable).sort((a, b) => rank(a) - rank(b) || a.notable.localeCompare(b.notable));
  };
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toLocaleString('en-US');

  function render() {
    const f = state.get('filters');
    const c = counts();
    const on = Object.keys(state.CATEGORIES).filter(k => f[k]).length;
    badge.textContent = on;
    badge.dataset.all = on === Object.keys(state.CATEGORIES).length ? '1' : '0';
    const hl = !!state.get('highlightsOnly');
    const notable = notableList();
    pop.innerHTML = `
      <button class="hl-switch${hl ? ' on' : ''}" data-act="hl" role="switch" aria-checked="${hl}">
        <span class="hl-text"><b>Highlights only</b>
          <small>Famous, large and bright objects \u2014 <span class="mono hl-n">${fmt(shownCount())}</span> shown</small></span>
        <span class="hl-track"><i></i></span>
      </button>
      ${notable.length ? `<div class="pop-head hl-head"><span class="eyebrow">Notable</span></div>
      <div class="hl-chips">${notable.map(s => `<button class="hl-chip" data-id="${s.id}" title="${esc(s.name)}">${esc(s.notable)}</button>`).join('')}</div>` : ''}
      <div class="pop-head"><span class="eyebrow">Satellite layers</span>
        <span class="pop-actions"><button class="link" data-act="all">All</button><i></i><button class="link" data-act="none">None</button></span></div>
      <div class="chips">
        ${Object.entries(state.CATEGORIES).map(([k, v]) => `
          <button class="chip${f[k] ? ' on' : ''}" data-cat="${k}" style="--c:${v.color}" aria-pressed="${!!f[k]}">
            <span class="dot"></span><span class="chip-label">${v.label}</span><span class="chip-n mono">${c[k] != null ? fmt(c[k]) : '–'}</span>
          </button>`).join('')}
      </div>`;
  }

  const setOpen = v => {
    open = v;
    btn.setAttribute('aria-expanded', String(v));
    if (v) { render(); pop.hidden = false; requestAnimationFrame(() => pop.classList.add('show')); }
    else { pop.classList.remove('show'); setTimeout(() => { if (!open) pop.hidden = true; }, 180); }
  };

  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(!open); });
  pop.addEventListener('click', e => {
    e.stopPropagation();
    const chip = e.target.closest('.chip'), act = e.target.closest('[data-act]'), jump = e.target.closest('.hl-chip');
    if (jump) {
      const sel = { kind: 'sat', id: +jump.dataset.id };
      state.set('selection', sel); state.emit('focus', sel);
    } else if (act && act.dataset.act === 'hl') state.set('highlightsOnly', !state.get('highlightsOnly'));
    else if (chip) state.patch('filters', { [chip.dataset.cat]: !state.get('filters')[chip.dataset.cat] });
    else if (act) {
      const val = act.dataset.act === 'all';
      state.patch('filters', Object.fromEntries(Object.keys(state.CATEGORIES).map(k => [k, val])));
    }
  });
  document.addEventListener('click', () => open && setOpen(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); btn.focus(); }
  });
  state.on('filters', () => { open ? render() : (badge.textContent = Object.keys(state.CATEGORIES).filter(k => state.get('filters')[k]).length); });
  state.on('highlightsOnly', () => open && render());
  state.on('catalogReady', () => open && render());
  render(); // sets badge
}
