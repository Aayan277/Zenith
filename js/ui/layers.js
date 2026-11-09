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
  const fmt = n => n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toLocaleString('en-US');

  function render() {
    const f = state.get('filters');
    const c = counts();
    const on = Object.keys(state.CATEGORIES).filter(k => f[k]).length;
    badge.textContent = on;
    badge.dataset.all = on === Object.keys(state.CATEGORIES).length ? '1' : '0';
    pop.innerHTML = `
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
    const chip = e.target.closest('.chip'), act = e.target.closest('[data-act]');
    if (chip) state.patch('filters', { [chip.dataset.cat]: !state.get('filters')[chip.dataset.cat] });
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
  state.on('catalogReady', () => open && render());
  render(); // sets badge
}
