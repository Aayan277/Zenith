// Command-palette search: satellites, solar-system bodies, constellations, bright stars.
import * as state from '../state.js';
import { allSats, getSat } from '../data/catalog.js';

const BODIES = [
  ['Sun', '#ffb347'], ['Moon', '#dfe6f5'], ['Mercury', '#b8b2a8'], ['Venus', '#f2dca0'],
  ['Mars', '#ff7a59'], ['Jupiter', '#e6c9a0'], ['Saturn', '#ead9a6'], ['Uranus', '#8fe3e6'], ['Neptune', '#6f8fff'],
];
// Friendly aliases for the objects people actually look for.
const ALIASES = {
  25544: ['iss', 'international space station', 'space station', 'zarya'],
  48274: ['tiangong', 'css', 'chinese station', 'china space station', 'chinese space station', 'tianhe'],
  20580: ['hubble', 'hst', 'hubble space telescope'],
};
const STAR_COLOR = '#ffffff', CON_COLOR = '#a78bff';

let items = [], builtFor = -1, extra = null, extraPromise = null;
let root, input, list, open = false, results = [], active = 0, lastFocus = null;

const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sat2item(s) {
  const cat = state.CATEGORIES[s.cat] || state.CATEGORIES.other;
  const display = s.notable || s.name;          // `notable` = friendly display name (may be absent)
  const aliases = (ALIASES[s.id] || []).map(norm);
  const key = norm([display, s.name, ...aliases].join(' '));
  return { kind: 'sat', id: s.id, name: display, aliases, sub: `${cat.label} · NORAD ${s.id}`, color: cat.color, key, compact: key.replace(/ /g, ''),
           bonus: (aliases.length ? 150 : 0) + (s.notable ? 40 : 0) + (s.cat === 'stations' ? 60 : 0) + (s.bright ? 25 : 0) + (s.cat === 'starlink' ? -40 : 0) + (s.cat === 'debris' ? -30 : 0), cat: s.cat };
}

// Optional extras from data/sky/*.json (stars + constellations). Format-tolerant.
function loadExtra() {
  if (extraPromise) return extraPromise;
  extraPromise = (async () => {
    const out = [];
    try {
      const r = await fetch('data/sky/constellations.json');
      if (r.ok) {
        const j = await r.json();
        for (const f of j.features || []) {
          const p = f.properties || {};
          const name = p.en || p.name; if (!name) continue;
          const id = f.id || p.desig;
          const key = norm(name + ' ' + id);
          out.push({ kind: 'constellation', id, name, sub: `Constellation · ${id}`, color: CON_COLOR, key, compact: key.replace(/ /g, ''), bonus: -5 });
        }
      }
    } catch {}
    try {
      const r = await fetch('data/sky/sky.json');
      if (r.ok) {
        const j = await r.json();
        const stars = Array.isArray(j) ? j : (j.stars || j.named || []);
        // Packed sky.json: stars = [[ra, dec, mag, bv, hip]], starNames = { hip: [name, bayer, flam, con] }
        const names = !Array.isArray(j) && j.starNames ? j.starNames : null;
        if (names) {
          for (const r of stars) {
            if (!Array.isArray(r)) continue;
            const n = names[r[4]]; if (!n || !n[0]) continue;
            const key = norm(n[0]);
            out.push({ kind: 'star', id: r[4], name: n[0], sub: `Star · mag ${Number(r[2]).toFixed(1)}${n[3] ? ' · ' + n[3] : ''}`,
                       color: STAR_COLOR, key, compact: key.replace(/ /g, ''), bonus: 10 - r[2] * 3 });
          }
        }
        for (const s of stars) {
          if (Array.isArray(s)) continue; // packed rows handled above
          const name = s.name || s.proper; const hip = s.hip ?? s.id;
          if (!name || hip == null) continue;
          const mag = s.mag ?? s.m;
          const key = norm(name);
          out.push({ kind: 'star', id: hip, name, sub: `Star${mag != null ? ' · mag ' + Number(mag).toFixed(1) : ''}${s.con || s.c ? ' · ' + (s.con || s.c) : ''}`,
                     color: STAR_COLOR, key, compact: key.replace(/ /g, ''), bonus: 10 - (mag ?? 3) * 3 });
        }
        if (!Array.isArray(j) && Array.isArray(j.constellations)) { /* constellations.json already covers these */ }
      }
    } catch {}
    // Rocket launches (mission, rocket, provider, pad)
    try {
      const m = await import('../launches/index.js');
      await m.loadLaunches();
      out.push(...m.searchEntries(norm));
    } catch {}
    extra = out; builtFor = -1;
    if (open) update();
  })();
  return extraPromise;
}

function build() {
  const sats = allSats();
  if (builtFor === sats.length && items.length) return;
  builtFor = sats.length;
  const bodies = BODIES.map(([n, color]) => {
    const key = norm(n);
    return { kind: 'body', id: n, name: n, sub: n === 'Sun' ? 'Star' : n === 'Moon' ? 'Natural satellite' : 'Planet', color, key, compact: key, bonus: 80 };
  });
  items = [...bodies, ...(extra || []), ...sats.map(sat2item)];
}

function score(it, q, qc, isNum) {
  if (isNum && it.kind === 'sat' && String(it.id).startsWith(q)) return 900 - String(it.id).length + q.length;
  const k = it.key;
  let s = -1;
  if (it.aliases?.length && it.aliases.some(a => a === q || (q.length >= 3 && a.startsWith(q)))) s = 1000;
  else if (k === q) s = 1000;
  else if (k.startsWith(q)) s = 900 - Math.min(k.length - q.length, 80);
  else {
    const i = k.indexOf(' ' + q);
    if (i >= 0) s = 700 - i;
    else {
      const j = k.indexOf(q);
      if (j >= 0) s = 500 - j;
      else if (qc.length > 2) {
        const c = it.compact, m = c.indexOf(qc);
        if (m >= 0) s = 420 - m;
        else if (qc.length >= 3) { // subsequence
          let p = -1, gaps = 0;
          for (let n = 0; n < qc.length; n++) { const f = c.indexOf(qc[n], p + 1); if (f < 0) return -1; gaps += f - p - 1; p = f; }
          s = 200 - Math.min(gaps, 150);
        }
      }
    }
  }
  return s < 0 ? -1 : s + it.bonus;
}

function popular() {
  const out = [];
  const pick = (id, re) => allSats().find(s => s.id === id) || allSats().find(s => re.test(s.name));
  for (const [id, re] of [[25544, /^ISS/], [48274, /TIANHE|CSS/], [20580, /^HST/]]) {
    const s = pick(id, re); if (s) out.push(sat2item(s));
  }
  for (const n of ['Moon', 'Jupiter']) out.push(items.find(i => i.kind === 'body' && i.name === n));
  return out.filter(Boolean);
}

function search(qraw) {
  const q = norm(qraw);
  if (!q) return { head: 'Popular', list: popular() };
  const qc = q.replace(/ /g, ''), isNum = /^\d{3,}$/.test(q);
  const hits = [];
  for (const it of items) { const s = score(it, q, qc, isNum); if (s >= 0) hits.push([s, it]); }
  hits.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
  return { head: hits.length ? `${hits.length.toLocaleString('en-US')} result${hits.length === 1 ? '' : 's'}` : '', list: hits.slice(0, 40).map(h => h[1]), q };
}

function hl(name, q) {
  if (!q) return esc(name);
  const i = name.toLowerCase().indexOf(q.toLowerCase().trim());
  if (i < 0 || !q.trim()) return esc(name);
  const n = q.trim().length;
  return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + n)) + '</mark>' + esc(name.slice(i + n));
}

function update() {
  build();
  const r = search(input.value);
  results = r.list;
  active = Math.min(active, Math.max(0, results.length - 1));
  if (!results.length) {
    list.innerHTML = `<div class="sr-empty">${input.value ? 'No matches' : 'Loading catalog…'}</div>`;
    return;
  }
  list.innerHTML = `<div class="sr-head eyebrow">${r.head}</div>` + results.map((it, i) => `
    <div class="sr-item${i === active ? ' active' : ''}" role="option" data-i="${i}" id="sr-${i}">
      <span class="sr-dot" style="--c:${it.color}"></span>
      <span class="sr-name">${hl(it.name, r.q ? input.value : '')}</span>
      <span class="sr-sub">${esc(it.sub)}</span>
      <svg class="sr-ret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5v6a3 3 0 0 1-3 3H5"/><path d="M9 10l-4 4 4 4"/></svg>
    </div>`).join('');
  input.setAttribute('aria-activedescendant', 'sr-' + active);
}

function setActive(i, scroll = true) {
  if (!results.length) return;
  active = (i + results.length) % results.length;
  list.querySelectorAll('.sr-item').forEach((el, n) => el.classList.toggle('active', n === active));
  input.setAttribute('aria-activedescendant', 'sr-' + active);
  if (scroll) list.querySelector('.sr-item.active')?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const it = results[i]; if (!it) return;
  const sel = { kind: it.kind, id: it.id };
  if (it.kind === 'sat' && it.cat && state.get('filters')[it.cat] === false) state.patch('filters', { [it.cat]: true });
  closeSearch(false);
  state.set('selection', sel);
  state.emit('focus', sel);
}

export function openSearch(prefill = '') {
  if (open) { input.focus(); return; }
  open = true;
  lastFocus = document.activeElement;
  root.hidden = false;
  input.value = prefill; active = 0;
  loadExtra();
  update();
  requestAnimationFrame(() => root.classList.add('show'));
  input.focus();
  document.body.classList.add('modal-open');
}

export function closeSearch(restore = true) {
  if (!open) return;
  open = false;
  root.classList.remove('show');
  document.body.classList.remove('modal-open');
  setTimeout(() => { if (!open) root.hidden = true; }, 180);
  if (restore && lastFocus?.focus) lastFocus.focus(); else input.blur();
}

export function initSearch() {
  const host = document.getElementById('modal-root') || document.body;
  root = document.createElement('div');
  root.className = 'search-root'; root.hidden = true;
  root.innerHTML = `
    <div class="search-backdrop"></div>
    <div class="search-modal glass" role="dialog" aria-modal="true" aria-label="Search">
      <div class="search-input-row">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input type="text" role="combobox" aria-expanded="true" aria-controls="sr-list" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="Search satellites, planets, stars…" aria-label="Search" />
        <kbd class="kbd">esc</kbd>
      </div>
      <div class="search-list scroll" id="sr-list" role="listbox"></div>
      <div class="search-foot"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> navigate</span><span><kbd class="kbd">↵</kbd> select</span></div>
    </div>`;
  host.append(root);
  input = root.querySelector('input'); list = root.querySelector('.search-list');

  input.addEventListener('input', () => { active = 0; update(); list.scrollTop = 0; });
  root.querySelector('.search-backdrop').addEventListener('click', () => closeSearch());
  list.addEventListener('mousemove', e => { const el = e.target.closest('.sr-item'); if (el && +el.dataset.i !== active) setActive(+el.dataset.i, false); });
  list.addEventListener('click', e => { const el = e.target.closest('.sr-item'); if (el) choose(+el.dataset.i); });
  root.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') { e.preventDefault(); input.focus(); }
  });

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); open ? closeSearch() : openSearch(); }
    else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); closeSearch(); }
  });
  state.on('catalogReady', () => { builtFor = -1; if (open) update(); });
}
