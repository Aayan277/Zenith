// Share popover: link + Copy, optional "Include time" / "Include my location", and a one-line preview.
// Opened from the top bar button and from the detail panel header (openShare(anchorElement)).
import * as state from '../state.js';
import * as clock from '../clock.js';
import { buildUrl, describeLink, getShareLoc, setShareLoc } from './url.js';

const I = {
  share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.3 10.8l7.4-4M8.3 13.2l7.4 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
export const SHARE_ICON = I.share;

let pop, input, copyBtn, native, live, anchor = null, open = false;
let optTime = false, optLoc = false, copiedTimer = 0, lastFocus = null;

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const opts = () => ({ time: optTime, loc: optLoc });

function build() {
  pop = document.createElement('div');
  pop.className = 'share-pop glass'; pop.hidden = true;
  pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Share link');
  pop.innerHTML = `
    <div class="sh-head"><span class="eyebrow">Share this view</span><button class="sh-x" type="button" aria-label="Close">${I.close}</button></div>
    <div class="sh-link">
      <input type="text" readonly spellcheck="false" aria-label="Link" />
      <button class="btn primary sh-copy" type="button">${I.copy}<span>Copy</span></button>
    </div>
    <button class="btn sh-native" type="button" hidden>${I.share}<span>Share…</span></button>
    <div class="sh-opts">
      <button class="sh-opt" type="button" role="switch" data-opt="time"><span class="sh-opt-text"><b>Include time</b><small></small></span><span class="hl-track"><i></i></span></button>
      <button class="sh-opt" type="button" role="switch" data-opt="loc"><span class="sh-opt-text"><b>Include my location</b><small></small></span><span class="hl-track"><i></i></span></button>
    </div>
    <p class="sh-preview"></p>
    <span class="sh-live" aria-live="polite"></span>`;
  document.body.append(pop);
  input = pop.querySelector('input'); copyBtn = pop.querySelector('.sh-copy'); native = pop.querySelector('.sh-native'); live = pop.querySelector('.sh-live');
  if (typeof navigator.share === 'function') native.hidden = false;

  pop.querySelector('.sh-x').addEventListener('click', () => closeShare());
  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', () => input.select());
  copyBtn.addEventListener('click', copy);
  native.addEventListener('click', async () => {
    try { await navigator.share({ title: 'Zenith', text: describeLink(opts()), url: input.value }); } catch { /* cancelled */ }
  });
  pop.addEventListener('click', e => {
    const b = e.target.closest('.sh-opt');
    if (!b || b.disabled) return;
    if (b.dataset.opt === 'time') optTime = !optTime;
    else { optLoc = !optLoc; setShareLoc(optLoc); }
    refresh();
  });
  // Close on outside click (capture, so the Layers popover's stopPropagation cannot hide it from us) and on Esc.
  document.addEventListener('click', e => {
    if (!open || pop.contains(e.target) || (anchor && anchor.contains(e.target))) return;
    closeShare(false);
  }, true);
  document.addEventListener('keydown', e => {
    if (!open || e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    closeShare();
  }, true);
  for (const k of ['selection', 'view', 'location']) state.on(k, () => open && refresh());
  addEventListener('resize', () => open && place());
}

function refresh() {
  const l = state.get('location');
  const hasLoc = l && l.source !== 'default';
  if (!hasLoc) optLoc = false;
  const o = opts();
  input.value = buildUrl(o, { keepOthers: false });
  pop.querySelector('.sh-preview').innerHTML = `<span class="sh-opens">Opens:</span> ${esc(describeLink(o))}`;
  const bt = pop.querySelector('[data-opt="time"]'), bl = pop.querySelector('[data-opt="loc"]');
  bt.setAttribute('aria-checked', String(optTime)); bt.classList.toggle('on', optTime);
  bt.querySelector('small').textContent = clock.isLive() ? (optTime ? 'Freezes the moment you share' : 'Opens live') : (optTime ? 'Opens at this time' : 'Opens live instead');
  bl.setAttribute('aria-checked', String(optLoc)); bl.classList.toggle('on', optLoc); bl.disabled = !hasLoc;
  bl.querySelector('small').textContent = !hasLoc ? 'No location set yet' : optLoc ? `Shares ${(l.name || 'your location').split(',')[0]}${l.source === 'gps' ? ' (about 1 km)' : ''}` : 'Off: they see their own sky';
  copyBtn.querySelector('span').textContent = 'Copy';
  copyBtn.classList.remove('done');
}

function place() {
  if (matchMedia('(max-width: 760px)').matches || !anchor) { pop.style.top = pop.style.right = pop.style.left = ''; return; }
  const r = anchor.getBoundingClientRect();
  pop.style.left = 'auto';
  pop.style.top = Math.round(Math.min(r.bottom + 10, innerHeight - pop.offsetHeight - 12)) + 'px';
  pop.style.right = Math.max(12, Math.round(innerWidth - r.right)) + 'px';
}

async function copy() {
  const text = input.value;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  if (!ok) { try { input.focus(); input.select(); ok = document.execCommand('copy'); } catch {} }
  copyBtn.querySelector('span').textContent = ok ? 'Copied' : 'Press Ctrl C';
  copyBtn.classList.toggle('done', ok);
  copyBtn.firstElementChild.outerHTML = ok ? I.check : I.copy;
  live.textContent = ok ? 'Link copied' : 'Copy failed. Select the link and press Ctrl C.';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { if (open) { copyBtn.querySelector('span').textContent = 'Copy'; copyBtn.classList.remove('done'); copyBtn.firstElementChild.outerHTML = I.copy; } }, 3000);
}

export function openShare(anchorEl) {
  if (!pop) build();
  if (open) { closeShare(false); }
  anchor = anchorEl || null;
  lastFocus = document.activeElement;
  optTime = !clock.isLive();
  optLoc = getShareLoc();
  pop.hidden = false; open = true;
  anchor?.setAttribute?.('aria-expanded', 'true');
  refresh(); place();
  requestAnimationFrame(() => { pop.classList.add('show'); place(); });
  copyBtn.focus();
}

export function closeShare(restore = true) {
  if (!open) return;
  open = false;
  pop.classList.remove('show');
  anchor?.setAttribute?.('aria-expanded', 'false');
  setTimeout(() => { if (!open) pop.hidden = true; }, 180);
  if (restore && lastFocus?.focus) lastFocus.focus();
}

export function toggleShare(anchorEl) { if (open && anchor === anchorEl) closeShare(); else openShare(anchorEl); }
