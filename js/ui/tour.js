// First-visit tour: a spotlight on five parts of the UI, one short caption each. Shown once (localStorage zenith:tour),
// never when the page was opened from a shared link, never on phones. Also startable from the help overlay.
import { isFromLink } from './url.js';

const KEY = 'zenith:tour';
const STEPS = [
  { sel: '#topbar .seg', title: 'Three ways to look', text: 'Orbit is the 3D globe of live satellites, Sky is the dome overhead from your spot, and System is the planets around the Sun. Keys 1, 2 and 3 switch.', side: 'below' },
  { sel: '#panel-tonight', title: 'Tonight, at your location', text: 'Stargazing score, visible satellite passes, Moon and twilight. Launches, Aurora and more are one tab away. Set your city for accurate times.', side: 'right' },
  { sel: '#btn-search', title: 'Search anything', text: 'Satellites, planets, stars, constellations and rocket launches. Press Ctrl K or / from anywhere.', side: 'below' },
  { sel: '#timebar', title: 'Time is yours', text: 'Drag the scrubber to see the sky later tonight or tomorrow, speed time up, or press L to return to live. Space pauses.', side: 'above' },
  { sel: '#btn-layers', title: 'Choose what you see', text: 'Filter satellite types, show only the famous ones, and toggle the aurora oval and launch pads. Every view has a Share button for links.', side: 'below' },
];

const lsGet = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const lsSet = v => { try { localStorage.setItem(KEY, v); } catch {} };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let root, hole, card, idx = 0, steps = [], lastFocus = null, active = false;

function visible(el) { const r = el?.getBoundingClientRect(); return !!r && r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; }

function show(i) {
  idx = i;
  const s = steps[i], el = document.querySelector(s.sel);
  const r = el.getBoundingClientRect(), pad = 8;
  const box = { x: Math.max(4, r.left - pad), y: Math.max(4, r.top - pad), w: Math.min(innerWidth - 8, r.width + pad * 2), h: Math.min(innerHeight - 8, r.height + pad * 2) };
  Object.assign(hole.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
  const last = i === steps.length - 1;
  card.querySelector('.tour-step').textContent = `${i + 1} / ${steps.length}`;
  card.querySelector('h3').textContent = s.title;
  card.querySelector('p').textContent = s.text;
  card.querySelector('.tour-next').textContent = last ? 'Done' : 'Next';
  card.querySelector('.tour-back').hidden = i === 0;
  card.querySelectorAll('.tour-dots i').forEach((d, n) => d.classList.toggle('on', n === i));
  // Place the caption beside the spotlight, clamped to the viewport.
  const cw = Math.min(330, innerWidth - 24), ch = card.offsetHeight || 190;
  let x, y;
  if (s.side === 'right' && box.x + box.w + 16 + cw < innerWidth) { x = box.x + box.w + 16; y = box.y + 12; }
  else if (s.side === 'above' || box.y + box.h + 16 + ch > innerHeight) { x = box.x + box.w / 2 - cw / 2; y = box.y - ch - 16; }
  else { x = box.x + box.w / 2 - cw / 2; y = box.y + box.h + 16; }
  if (y < 12) y = Math.min(innerHeight - ch - 12, box.y + box.h + 16);
  card.style.width = cw + 'px';
  card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, x)) + 'px';
  card.style.top = Math.max(12, Math.min(innerHeight - ch - 12, y)) + 'px';
  card.querySelector('.tour-next').focus({ preventScroll: true });
}

function next() { if (idx >= steps.length - 1) end(); else show(idx + 1); }
function back() { if (idx > 0) show(idx - 1); }

function end() {
  if (!active) return;
  active = false;
  lsSet('done');
  document.removeEventListener('keydown', onKey, true);
  removeEventListener('resize', onResize);
  document.body.classList.remove('modal-open');
  const r = root; root = null;
  r.classList.remove('show');
  setTimeout(() => r.remove(), reduced() ? 0 : 250);
  if (lastFocus?.focus) lastFocus.focus({ preventScroll: true });
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
  else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest?.('.tour-skip, .tour-back'))) { e.preventDefault(); e.stopPropagation(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const f = [...card.querySelectorAll('button:not([hidden])')], i = f.indexOf(document.activeElement);
    f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
  } else if (e.key === ' ') e.stopPropagation();
}
const onResize = () => { if (!active) return; const s = steps[idx]; if (visible(document.querySelector(s.sel))) show(idx); };

/** Start the tour now (from the help overlay, or automatically on the first visit). */
export function startTour() {
  if (active) return;
  steps = STEPS.filter(s => visible(document.querySelector(s.sel)));
  if (steps.length < 2) return;
  active = true; lastFocus = document.activeElement; lsSet('seen');
  root = document.createElement('div');
  root.className = 'tour-root' + (reduced() ? ' no-motion' : '');
  root.innerHTML = `
    <div class="tour-block"></div>
    <div class="tour-hole" aria-hidden="true"></div>
    <div class="tour-card glass" role="dialog" aria-label="Zenith tour" aria-live="polite">
      <div class="tour-top"><span class="eyebrow tour-step"></span><span class="tour-dots">${steps.map(() => '<i></i>').join('')}</span></div>
      <h3></h3><p></p>
      <div class="tour-actions"><button class="link tour-skip" type="button">Skip tour</button><span class="tour-gap"></span>
        <button class="btn tour-back" type="button">Back</button><button class="btn primary tour-next" type="button">Next</button></div>
    </div>`;
  document.body.append(root);
  hole = root.querySelector('.tour-hole'); card = root.querySelector('.tour-card');
  root.querySelector('.tour-skip').addEventListener('click', end);
  root.querySelector('.tour-next').addEventListener('click', next);
  root.querySelector('.tour-back').addEventListener('click', back);
  root.querySelector('.tour-block').addEventListener('click', e => e.stopPropagation());
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', onResize);
  show(0);
  requestAnimationFrame(() => root?.classList.add('show'));
}

/** First visit only: after the boot overlay lifts. Desktop only; skipped for shared links. */
export function maybeStartTour() {
  if (lsGet() || isFromLink() || matchMedia('(max-width: 760px)').matches) return;
  const go = () => {
    if (lsGet() || document.body.classList.contains('modal-open') || document.hidden) return;
    startTour();
  };
  const boot = document.getElementById('boot');
  const delay = () => setTimeout(go, 1800);
  if (!boot || boot.classList.contains('done')) delay();
  else new MutationObserver((_, mo) => { if (boot.classList.contains('done')) { mo.disconnect(); delay(); } }).observe(boot, { attributes: true, attributeFilter: ['class'] });
}
