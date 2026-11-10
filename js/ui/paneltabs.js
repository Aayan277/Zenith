// Turns the left #panel-tonight into a tabbed panel: Tonight | Launches | Aurora | Events.
// The Tonight content is left exactly as js/tonight/tonight.js renders it; the other tabs mount lazily
// (their JS + CSS load the first time the tab opens, or when something asks for it).
import * as state from '../state.js';

const TABS = [
  { id: 'tonight',  label: 'Tonight' },
  { id: 'launches', label: 'Launches', css: 'css/launches.css', load: () => import('../launches/panel.js') },
  { id: 'aurora',   label: 'Aurora',   css: 'css/aurora.css',   load: () => import('../aurora/panel.js') },
  { id: 'events',   label: 'Events',   css: 'css/events.css',   load: () => import('../events/panel.js') },
];
let root, strip, panes = {}, current = 'tonight', badges = {};
const mounted = {};

export function ensureCss(href) {
  const have = document.querySelector(`link[rel="stylesheet"][href$="${href}"]`);
  if (have) return Promise.resolve();
  return new Promise(res => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
    l.onload = l.onerror = () => res();
    document.head.append(l);
  });
}

export function currentTab() { return current; }

/** kind: false | true | 'good' | 'warn'. Shows a small dot on the tab. */
export function setTabBadge(id, kind) {
  badges[id] = kind;
  const b = strip?.querySelector(`.pt-tab[data-tab="${id}"] .pt-badge`);
  if (!b) return;
  b.hidden = !kind; b.dataset.kind = kind === true ? 'good' : kind || '';
  const tab = strip.querySelector(`.pt-tab[data-tab="${id}"]`);
  if (tab) tab.setAttribute('aria-label', kind ? `${TABS.find(t => t.id === id).label}, alert active` : TABS.find(t => t.id === id).label);
}

async function mount(id) {
  const t = TABS.find(x => x.id === id);
  if (!t?.load || mounted[id]) return mounted[id];
  mounted[id] = Promise.all([t.load(), t.css ? ensureCss(t.css) : 0]).then(([mod]) => { mod.mount(panes[id]); return mod; }).catch(e => {
    console.error(`[tab:${id}]`, e);
    panes[id].innerHTML = '<div class="tn-card"><div class="tn-err"><span>Could not load this section.</span></div></div>';
    delete mounted[id];
  });
  return mounted[id];
}

export async function showTab(id, { focus = false } = {}) {
  if (!TABS.some(t => t.id === id) || !root) return;
  const prev = current; current = id;
  root.dataset.tab = id;
  for (const t of TABS) {
    const btn = strip.querySelector(`.pt-tab[data-tab="${t.id}"]`), on = t.id === id;
    btn.setAttribute('aria-selected', String(on)); btn.tabIndex = on ? 0 : -1;
    if (t.id !== 'tonight') panes[t.id].hidden = !on;
  }
  const body = root.querySelector('.tn-body');
  if (body) body.setAttribute('aria-hidden', String(id !== 'tonight'));
  if (focus) strip.querySelector(`.pt-tab[data-tab="${id}"]`).focus();
  if (prev !== id) { const pm = await mounted[prev]; pm?.onHide?.(); }
  const mod = await mount(id);
  if (current === id) mod?.onShow?.();
  if (id !== 'tonight') state.emit('panel:tab', id);
}

function build() {
  const head = root.querySelector('.tn-head'), body = root.querySelector('.tn-body');
  strip = document.createElement('div');
  strip.className = 'pt-tabs'; strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Panel sections');
  strip.innerHTML = TABS.map(t => `<button type="button" role="tab" class="pt-tab" id="pt-tab-${t.id}" data-tab="${t.id}" aria-selected="${t.id === 'tonight'}"
      aria-controls="${t.id === 'tonight' ? 'tn-body' : 'pt-pane-' + t.id}" tabindex="${t.id === 'tonight' ? 0 : -1}"><span>${t.label}</span><i class="pt-badge" hidden></i></button>`).join('');
  head.insertBefore(strip, head.querySelector('.tn-peek') || head.querySelector('.tn-collapse'));
  body.id = 'tn-body'; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', 'pt-tab-tonight');
  for (const t of TABS.slice(1)) {
    const p = document.createElement('div');
    p.className = 'pt-pane scroll'; p.id = 'pt-pane-' + t.id; p.hidden = true;
    p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'pt-tab-' + t.id);
    body.after(p); panes[t.id] = p;
  }
  // The head doubles as a drag handle on phones (tonight.js); keep tab taps out of that gesture.
  strip.addEventListener('pointerdown', e => e.stopPropagation());
  strip.addEventListener('click', e => { const b = e.target.closest('.pt-tab'); if (b) showTab(b.dataset.tab); });
  strip.addEventListener('keydown', e => {
    const i = TABS.findIndex(t => t.id === current);
    const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (j >= 0) { e.preventDefault(); showTab(TABS[j].id, { focus: true }); }
  });
  root.classList.add('pt-on');
  for (const [id, k] of Object.entries(badges)) setTabBadge(id, k);
  // Warm the CSS for the other tabs so the first switch does not flash unstyled content.
  for (const t of TABS) if (t.css) setTimeout(() => ensureCss(t.css), 1200);
  // Opening a launch from search / a notification jumps to the Launches tab.
  state.on('selection', s => { if (s?.kind === 'launch' && current !== 'launches') showTab('launches'); });
}

/** Call once. Waits for tonight.js to render the panel, then adds the tabs. */
export function initPanelTabs() {
  root = document.getElementById('panel-tonight');
  if (!root) return Promise.resolve();
  return new Promise(resolve => {
    const ready = () => root.querySelector('.tn-head') && root.querySelector('.tn-body');
    const go = async () => { try { await ensureCss('css/paneltabs.css'); build(); } catch (e) { console.error('[paneltabs]', e); } resolve(); };
    if (ready()) { go(); return; }
    const mo = new MutationObserver(() => { if (ready()) { mo.disconnect(); clearTimeout(to); go(); } });
    mo.observe(root, { childList: true });
    const to = setTimeout(() => { mo.disconnect(); resolve(); }, 15000);
  });
}
