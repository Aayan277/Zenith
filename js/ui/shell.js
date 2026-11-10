// App shell: top bar (logo, Orbit/Sky switch, search, layers). Also boots detail + timebar.
import * as state from '../state.js';
import { initSearch, openSearch } from './search.js';
import { initLayers } from './layers.js';
import { initHelp } from './help.js';
import { plainKey } from './keys.js';
import { SHARE_ICON, toggleShare } from './share.js';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const ICON = {
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 4.8-9 4.8-9-4.8z"/><path d="M3 12.2l9 4.8 9-4.8"/><path d="M3 16.6l9 4.8 9-4.8" opacity=".55"/></svg>',
};

const LOGO = `
<svg class="logo-mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ce1ff"/><stop offset="1" stop-color="#a78bff"/></linearGradient></defs>
  <circle cx="16" cy="16" r="12.5" fill="none" stroke="url(#lg)" stroke-width="1.4"/>
  <circle cx="16" cy="16" r="6.5" fill="none" stroke="url(#lg)" stroke-width="1" opacity=".5" stroke-dasharray="2 2.4"/>
  <path d="M16 1.2v3.6M16 27.2v3.6M1.2 16h3.6M27.2 16h3.6" stroke="url(#lg)" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>
  <g class="logo-sat"><circle cx="24.8" cy="7.2" r="2" fill="#ffb347"/><circle cx="24.8" cy="7.2" r="3.8" fill="#ffb347" opacity=".18"/></g>
  <circle cx="16" cy="16" r="3.6" fill="#5ce1ff" opacity=".22"/>
  <path d="M16 11.6l1 3.4 3.4 1-3.4 1-1 3.4-1-3.4-3.4-1 3.4-1z" fill="#e8eefc"/>
</svg>`;

export async function init() {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  const kbd = isMac ? '⌘K' : 'Ctrl K';
  bar.innerHTML = `
    <a class="tb-brand" href="./" aria-label="Zenith">${LOGO}<span class="tb-word">Zenith</span></a>
    <div class="seg glass" role="tablist" aria-label="View">
      <span class="seg-hi" aria-hidden="true"></span>
      <button role="tab" data-view="globe" aria-selected="true">Orbit</button>
      <button role="tab" data-view="sky" aria-selected="false">Sky</button>
      <button role="tab" data-view="system" aria-selected="false">System</button>
    </div>
    <div class="tb-right">
      <button class="tb-btn glass tb-search" id="btn-search">
        ${ICON.search}<span class="tb-label">Search</span><kbd class="kbd">${kbd}</kbd>
      </button>
      <button class="tb-btn glass" id="btn-share" aria-haspopup="dialog" aria-expanded="false">
        ${SHARE_ICON}<span class="tb-label">Share</span>
      </button>
      <div class="tb-layers-wrap">
        <button class="tb-btn glass" id="btn-layers" aria-haspopup="true" aria-expanded="false">
          ${ICON.layers}<span class="tb-label">Layers</span><span class="tb-badge" id="layers-badge"></span>
        </button>
        <div class="popover glass" id="layers-pop" role="dialog" aria-label="Layers" hidden></div>
      </div>
      <button class="tb-btn tb-help glass" id="btn-help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
    </div>`;

  // --- view switch with sliding highlight
  const seg = bar.querySelector('.seg');
  const tabs = [...seg.querySelectorAll('button')];
  const syncSeg = v => {
    const i = Math.max(0, tabs.findIndex(t => t.dataset.view === v));
    seg.style.setProperty('--i', i);
    tabs.forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
  };
  tabs.forEach(t => t.addEventListener('click', () => state.set('view', t.dataset.view)));
  seg.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const cur = tabs.findIndex(t => t.dataset.view === state.get('view'));
      const next = tabs[(cur + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      state.set('view', next.dataset.view); next.focus();
    }
  });
  state.on('view', syncSeg);
  syncSeg(state.get('view'));

  initSearch();
  bar.querySelector('#btn-search').addEventListener('click', () => openSearch());
  initLayers(bar);
  initHelp();
  const shareBtn = bar.querySelector('#btn-share');
  shareBtn.addEventListener('click', () => toggleShare(shareBtn));
  bar.querySelector('#btn-help').addEventListener('click', () => import('./help.js').then(m => m.openHelp()));

  // 1 / 2 / 3 switch views
  const VIEWS = { 1: 'globe', 2: 'sky', 3: 'system' };
  document.addEventListener('keydown', e => {
    if (VIEWS[e.key] && !e.shiftKey && plainKey(e)) { e.preventDefault(); state.set('view', VIEWS[e.key]); }
  });

  // Accessible names: on wide screens the visible text ("Search Ctrl K", "Layers 9") is the name, so it always
  // matches what is shown. When the text labels are hidden (compact layout) the buttons need explicit labels.
  {
    const mqS = matchMedia('(max-width: 1100px)'), mqL = matchMedia('(max-width: 760px)');
    const shBtn = bar.querySelector('#btn-share');
    const sBtn = bar.querySelector('#btn-search'), lBtn = bar.querySelector('#btn-layers'), badge = bar.querySelector('#layers-badge');
    const sync = () => {
      if (mqS.matches) { sBtn.setAttribute('aria-label', 'Search'); shBtn.setAttribute('aria-label', 'Share link'); } else { sBtn.removeAttribute('aria-label'); shBtn.removeAttribute('aria-label'); }
      if (mqL.matches) lBtn.setAttribute('aria-label', `Layers ${badge.textContent}`.trim()); else lBtn.removeAttribute('aria-label');
    };
    mqS.addEventListener('change', sync); mqL.addEventListener('change', sync);
    new MutationObserver(sync).observe(badge, { childList: true, characterData: true, subtree: true });
    sync();
  }

  // detail panel + time bar (isolated so one failing doesn't stop the other)
  for (const name of ['detail', 'timebar']) {
    try { const m = await import(`./${name}.js`); await m.init?.(); }
    catch (e) { console.error(`[ui:${name}]`, e); }
  }
  // First-visit tour (once, never from a shared link). Loaded only when it is going to run.
  try { if (!localStorage.getItem('zenith:tour')) import('./tour.js').then(m => m.maybeStartTour()).catch(e => console.error('[ui:tour]', e)); } catch {}
}
