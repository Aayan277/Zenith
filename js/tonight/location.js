// Location picker modal: browser geolocation + Open-Meteo city search with keyboard nav.
import * as state from '../state.js';
import { esc } from './util.js';

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const REV = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

async function reverseName(lat, lon) {
  try {
    const r = await fetch(`${REV}?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (!r.ok) throw 0;
    const j = await r.json();
    const place = j.city || j.locality || j.principalSubdivision;
    const cc = j.countryCode || j.countryName;
    if (place) return cc ? `${place}, ${cc}` : place;
  } catch {}
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

export function setLocation(loc) { state.set('location', { elevM: 0, ...loc }); }

/** Ask the browser for a position. Resolves to the new location, or throws. */
export async function useMyLocation() {
  if (!navigator.geolocation) throw new Error('Geolocation is not supported by this browser');
  const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }));
  const lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
  const elevM = Math.round(pos.coords.altitude || 0);
  const name = await reverseName(lat, lon);
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(); // user is physically here
  const loc = { lat, lon, elevM, name, source: 'gps', tz };
  setLocation(loc);
  return loc;
}

export function closeModal() { const m = document.getElementById('modal-root'); if (m) m.innerHTML = ''; document.removeEventListener('keydown', onKey, true); }
let onKey = () => {};

export function openLocationPicker() {
  const root = document.getElementById('modal-root');
  if (!root) return;
  const prevFocus = document.activeElement;
  root.innerHTML = `
  <div class="tn-modal-back" data-close>
    <div class="tn-modal glass" role="dialog" aria-modal="true" aria-labelledby="tn-loc-title">
      <div class="tn-modal-head"><h2 id="tn-loc-title">Your location</h2><button class="tn-icon-btn" data-close aria-label="Close">${'&times;'}</button></div>
      <p class="tn-modal-sub">Passes, twilight and weather are computed for this spot.</p>
      <button class="btn primary tn-geo" type="button"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg><span>Use my location</span></button>
      <div class="tn-or"><span>or search a city</span></div>
      <input class="tn-search" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. Reykjavik, Tucson, Auckland" role="combobox" aria-expanded="false" aria-controls="tn-results" />
      <ul class="tn-results" id="tn-results" role="listbox"></ul>
      <p class="tn-modal-msg" aria-live="polite"></p>
    </div>
  </div>`;
  const q = root.querySelector('.tn-search'), list = root.querySelector('.tn-results'), msg = root.querySelector('.tn-modal-msg');
  const geoBtn = root.querySelector('.tn-geo');
  let items = [], sel = -1, timer = null, seq = 0;

  const render = () => {
    list.innerHTML = items.map((r, i) => `<li role="option" id="tn-r${i}" data-i="${i}" aria-selected="${i === sel}" class="${i === sel ? 'sel' : ''}">
      <b>${esc(r.name)}</b><span>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</span></li>`).join('');
    q.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    if (sel >= 0) q.setAttribute('aria-activedescendant', 'tn-r' + sel); else q.removeAttribute('aria-activedescendant');
  };
  const choose = r => {
    const name = [r.name, r.country_code || r.country].filter(Boolean).join(', ');
    setLocation({ lat: +r.latitude.toFixed(4), lon: +r.longitude.toFixed(4), elevM: Math.round(r.elevation || 0), name, source: 'search', tz: r.timezone });
    close();
  };
  const close = () => { closeModal(); prevFocus?.focus?.(); };
  const search = async () => {
    const text = q.value.trim(), my = ++seq;
    if (text.length < 2) { items = []; sel = -1; render(); msg.textContent = ''; return; }
    msg.textContent = 'Searching…';
    try {
      const res = await fetch(`${GEO}?name=${encodeURIComponent(text)}&count=6&language=en&format=json`);
      if (!res.ok) throw new Error();
      const j = await res.json();
      if (my !== seq) return;
      items = j.results || []; sel = items.length ? 0 : -1; render();
      msg.textContent = items.length ? '' : 'No matching places found.';
    } catch { if (my === seq) msg.textContent = 'Search is unavailable right now. Try "Use my location".'; }
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 240); });
  list.addEventListener('click', e => { const li = e.target.closest('li'); if (li) choose(items[+li.dataset.i]); });
  list.addEventListener('mousemove', e => { const li = e.target.closest('li'); if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; render(); } });
  geoBtn.addEventListener('click', async () => {
    geoBtn.disabled = true; msg.textContent = 'Waiting for your browser…';
    try { await useMyLocation(); close(); state.emit('toast', 'Location updated'); }
    catch (e) {
      geoBtn.disabled = false;
      msg.textContent = e && e.code === 1 ? 'Location permission was denied. Search for a city instead.' : (e && e.message) || 'Could not get your location.';
    }
  });
  root.querySelector('.tn-modal-back').addEventListener('click', e => { if (e.target.classList.contains('tn-modal-back') || e.target.closest('button[data-close]')) close(); });
  onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.target === q && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); choose(items[sel]); }
    }
    if (e.key === 'Tab') { // simple focus trap
      const f = [...root.querySelectorAll('button:not([disabled]), input')]; if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  q.focus();
}
