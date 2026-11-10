// Keyboard help overlay (press ?). Shortcuts are listed here; the handlers live in shell.js, timebar.js and search.js.
import { plainKey } from './keys.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const K = (...k) => k.map(x => `<kbd class="kbd">${x}</kbd>`).join('<span class="hp-plus">/</span>');
const GROUPS = [
  { title: 'Navigate', rows: [
    [K('1'), 'Orbit view'], [K('2'), 'Sky view'], [K('3'), 'System view'],
    [K(isMac ? '⌘ K' : 'Ctrl K', '/'), 'Search satellites, planets, stars, launches'],
    [K('Esc'), 'Close a dialog, or clear the selection'],
    [K('?'), 'Show this help'],
  ] },
  { title: 'Time', rows: [
    [K('Space'), 'Pause or resume time'],
    [K('←', '→'), 'Step back or forward 10 min (1 day in System)'],
    [K('L'), 'Back to live'],
    [K('Drag'), 'Scrub the time bar; speed and reverse sit beside it'],
  ] },
  { title: 'Look around', rows: [
    [K('Drag'), 'Orbit the globe, pan the sky, rotate the system'],
    [K('Scroll'), 'Zoom (pinch on a touch screen)'],
    [K('Click'), 'Select an object for details'],
    [K('Tab', 'Enter'), 'Move between controls and activate them'],
  ] },
  { title: 'Ride along (Orbit view)', rows: [
    [K('R'), 'Ride with the selected satellite; R or Esc to exit'],
    [K('Drag'), 'Look around from orbit (springs back)'],
    [K('Scroll'), 'Change the field of view'],
  ] },
];

let root, open = false, lastFocus = null;

function build() {
  root = document.createElement('div');
  root.className = 'help-root'; root.hidden = true;
  root.innerHTML = `
    <div class="help-backdrop"></div>
    <div class="help-modal glass" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="hp-head"><h2 id="help-title">Keyboard shortcuts</h2><button class="sh-x" type="button" aria-label="Close help"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="hp-grid">${GROUPS.map(g => `
        <section><h3 class="eyebrow">${g.title}</h3>
          <dl>${g.rows.map(([k, d]) => `<div class="hp-row"><dt>${k}</dt><dd>${d}</dd></div>`).join('')}</dl></section>`).join('')}
      </div>
      <div class="hp-foot"><button class="btn hp-tour" type="button">Take the tour</button><span>Every view has a Share button: it copies a link to exactly what you are looking at.</span></div>
    </div>`;
  document.body.append(root);
  root.querySelector('.help-backdrop').addEventListener('click', () => closeHelp());
  root.querySelector('.sh-x').addEventListener('click', () => closeHelp());
  root.querySelector('.hp-tour').addEventListener('click', async () => {
    closeHelp(false);
    try { (await import('./tour.js')).startTour(); } catch (e) { console.error('[tour]', e); }
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Tab') { // focus trap
      const f = [...root.querySelectorAll('button')];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    }
  });
}

export function openHelp() {
  if (open) return;
  if (!root) build();
  open = true; lastFocus = document.activeElement;
  root.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => root.classList.add('show'));
  root.querySelector('.hp-tour').focus();
}
export function closeHelp(restore = true) {
  if (!open) return;
  open = false;
  root.classList.remove('show');
  document.body.classList.remove('modal-open');
  setTimeout(() => { if (!open) root.hidden = true; }, 180);
  if (restore && lastFocus?.focus) lastFocus.focus();
}

export function initHelp() {
  document.addEventListener('keydown', e => {
    if (open) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); closeHelp(); }
      return;
    }
    if (e.key === '?' && plainKey(e)) { e.preventDefault(); openHelp(); }
  }, true);
}
