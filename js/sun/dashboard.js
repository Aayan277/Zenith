// Sun dashboard modal: SDO imagery with wavelength tabs, GOES X-ray chart, flares, active regions, solar cycle, effects on Earth.
// Lives in #modal-root. Esc closes, Tab is trapped inside, focus returns to the opener.
import { FILTERS, BANDS, sdoUrl, getFilter, setFilter, sun, onSun, ensure, invalidate, loadXray, loadCycle, status, classOf, classColor, fmtFlux, FULL } from './data.js';
import { esc, hm, hmz, dayhm, ago, ensureSunCss } from './util.js';
import { fmtLocal, tzLabel, tzOffsetMinutes } from '../util/time.js';

const H = 3600e3;
const ICON_SUN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_R = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>';

let root = null, opener = null, unsub = null, raf = 0, io = null;
const sigs = {};

export async function openDashboard() {
  if (root) { root.querySelector('.sn-modal')?.focus(); return; }
  await ensureSunCss();
  const host = document.getElementById('modal-root'); if (!host) return;
  opener = document.activeElement;
  root = document.createElement('div');
  root.className = 'sn-back'; root.dataset.sunDash = '';
  root.innerHTML = shell();
  host.append(root);
  const modal = root.querySelector('.sn-modal');

  root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onTabKeys);
  document.addEventListener('keydown', onEsc, true);
  setImage(true);
  render();
  unsub = onSun(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); });
  ensure(FULL); loadXray();
  const cyc = root.querySelector('[data-sec="cycle-wrap"]');
  if ('IntersectionObserver' in window) { io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { loadCycle(); io.disconnect(); } }, { root: root.querySelector('.sn-scroll'), rootMargin: '0px 0px 120px 0px' }); io.observe(cyc); }
  else loadCycle();
  requestAnimationFrame(() => { modal.classList.add('in'); root.classList.add('in'); modal.focus({ preventScroll: true }); });
}

export function close() {
  if (!root) return;
  const r = root; root = null;
  document.removeEventListener('keydown', onEsc, true);
  unsub?.(); unsub = null; io?.disconnect(); cancelAnimationFrame(raf);
  for (const k of Object.keys(sigs)) delete sigs[k];
  r.classList.remove('in'); r.classList.add('out');
  setTimeout(() => r.remove(), 200);
  try { opener?.focus?.({ preventScroll: true }); } catch {}
}

function onEsc(e) {
  if (e.key !== 'Escape' || !root) return;
  e.preventDefault(); e.stopPropagation(); close();   // keeps the detail panel's own Esc handler from also clearing the selection
}
function onTabKeys(e) {
  if (e.key !== 'Tab') return;
  const f = [...root.querySelectorAll('button, a[href], [tabindex="0"], input, select')].filter(x => !x.disabled && x.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || a === root.querySelector('.sn-modal'))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  else if (!root.contains(a)) { e.preventDefault(); first.focus(); }
}
function onClick(e) {
  const b = e.target.closest('[data-close],[data-refresh],[data-f],[data-retry],[data-aurora],[data-loadcycle]'); if (!b) return;
  if (b.dataset.close !== undefined) close();
  else if (b.dataset.refresh !== undefined) { invalidate(); ensure(FULL); loadXray({ force: true }); if (sun.cycle || sun.loading.cycle) loadCycle(); b.classList.add('spin'); setTimeout(() => b.classList.remove('spin'), 900); }
  else if (b.dataset.f !== undefined) { setFilter(+b.dataset.f); setImage(); }
  else if (b.dataset.retry === 'xray') loadXray({ force: true });
  else if (b.dataset.retry === 'cycle' || b.dataset.loadcycle !== undefined) loadCycle();
  else if (b.dataset.retry === 'data') { invalidate(); ensure(FULL); }
  else if (b.dataset.aurora !== undefined) { close(); import('../ui/paneltabs.js').then(m => m.showTab('aurora', { focus: false })); }
}

// ---- shell -------------------------------------------------------------------------------------------------------------
function shell() {
  const tabs = FILTERS.map((f, i) => `<button type="button" role="tab" class="sn-tab" id="sn-tab-${i}" data-f="${i}" style="--tc:${f.color}" aria-selected="false" aria-controls="sn-expl" tabindex="-1"><i></i><span>${f.label}</span></button>`).join('');
  return `<div class="sn-modal glass" role="dialog" aria-modal="true" aria-labelledby="sn-title" tabindex="-1">
    <header class="sn-head">
      <span class="sn-sunicon" aria-hidden="true">${ICON_SUN}</span>
      <div class="sn-titles"><h2 id="sn-title">Sun dashboard</h2><p class="sn-sub" data-sec="sub">Live from NASA SDO and NOAA SWPC</p></div>
      <button type="button" class="sn-iconbtn" data-refresh aria-label="Refresh data" title="Refresh">${ICON_R}</button>
      <button type="button" class="sn-iconbtn" data-close aria-label="Close dashboard (Esc)" title="Close (Esc)">${ICON_X}</button>
    </header>
    <div class="sn-scroll scroll">
      <section class="sn-hero" aria-label="Sun imagery">
        <figure class="sn-fig">
          <div class="sn-frame"><img class="sn-img" alt="" decoding="async"><span class="sn-ring" aria-hidden="true"></span></div>
          <figcaption data-sec="cap"></figcaption>
        </figure>
        <div class="sn-side">
          <div class="sn-tabs" role="tablist" aria-label="SDO wavelength">${tabs}</div>
          <div class="sn-expl" id="sn-expl" role="tabpanel" aria-live="polite" data-sec="expl"></div>
          <div class="sn-kpis" data-sec="kpis"></div>
        </div>
      </section>
      <section class="sn-sec" aria-labelledby="sn-h-xray">
        <div class="sn-sec-head"><h3 id="sn-h-xray">GOES X-ray flux · last 24 hours</h3><span class="sn-sec-meta" data-sec="xmeta"></span></div>
        <div class="sn-chartwrap" data-sec="xray"></div>
      </section>
      <section class="sn-sec" aria-labelledby="sn-h-fl">
        <div class="sn-sec-head"><h3 id="sn-h-fl">Latest flares</h3><span class="sn-sec-meta" data-sec="fmeta"></span></div>
        <div data-sec="flares"></div>
      </section>
      <section class="sn-sec" aria-labelledby="sn-h-ar">
        <div class="sn-sec-head"><h3 id="sn-h-ar">Sunspot regions</h3><span class="sn-sec-meta" data-sec="rmeta"></span></div>
        <div data-sec="regions"></div>
      </section>
      <section class="sn-sec" aria-labelledby="sn-h-cy" data-sec="cycle-wrap">
        <div class="sn-sec-head"><h3 id="sn-h-cy">Solar cycle · monthly sunspot number</h3><span class="sn-sec-meta" data-sec="cmeta"></span></div>
        <div class="sn-chartwrap" data-sec="cycle"></div>
      </section>
      <section class="sn-sec sn-effects" aria-labelledby="sn-h-ef">
        <div class="sn-sec-head"><h3 id="sn-h-ef">Effects on Earth</h3></div>
        <div class="sn-fx">
          <div><b style="--c:var(--good)">Aurora</b><p>Fast solar wind, coronal holes and CMEs (clouds of plasma, arriving 1–3 days after big eruptions) can trigger geomagnetic storms that push the aurora toward the equator.</p></div>
          <div><b style="--c:var(--warn)">Radio blackouts</b><p>M- and X-class flares ionise the sunlit upper atmosphere within minutes, degrading shortwave radio and GPS accuracy on the day side.</p></div>
          <div><b style="--c:var(--accent)">Satellites</b><p>Storms heat and swell the upper atmosphere, dragging low satellites down faster and sometimes disturbing their electronics.</p></div>
        </div>
        <button type="button" class="btn primary sn-cta" data-aurora>See the aurora forecast <span aria-hidden="true">→</span></button>
      </section>
      <p class="sn-foot">Images: NASA Solar Dynamics Observatory. Data: NOAA Space Weather Prediction Center (GOES, SWPC). Times in ${esc(tzLabel())}.</p>
    </div>
  </div>`;
}

// ---- image + tabs ------------------------------------------------------------------------------------------------------
function setImage(first) {
  const f = FILTERS[getFilter()], img = root.querySelector('.sn-img'), frame = root.querySelector('.sn-frame');
  root.querySelectorAll('.sn-tab').forEach((t, i) => { const on = i === getFilter(); t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
  root.querySelector('#sn-expl').setAttribute('aria-labelledby', 'sn-tab-' + getFilter());
  root.querySelector('[data-sec="expl"]').innerHTML = `<h4 style="--tc:${f.color}"><i></i>${esc(f.label)} · ${esc(f.name)}</h4><p>${esc(f.blurb)}</p>`;
  root.querySelector('[data-sec="cap"]').textContent = `NASA SDO · ${f.id.startsWith('HMI') ? 'HMI' : 'AIA'} ${f.label} · ${f.name}`;
  const url = sdoUrl(f.id, 1024);
  frame.classList.add('loading'); frame.classList.remove('fail');
  const pre = new Image();
  pre.onload = () => { if (!root) return; img.src = url; img.alt = `Latest NASA SDO image of the Sun in ${f.name.toLowerCase()} (${f.label})`; frame.classList.remove('loading'); };
  pre.onerror = () => { if (!root) return; frame.classList.remove('loading'); frame.classList.add('fail'); };
  pre.src = url;
  if (!first) root.querySelector('.sn-tab[aria-selected="true"]')?.focus({ preventScroll: true });
  root.querySelector('.sn-tabs').onkeydown = e => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'Home' ? -99 : e.key === 'End' ? 99 : 0;
    if (!d) return; e.preventDefault();
    setFilter(d === -99 ? 0 : d === 99 ? FILTERS.length - 1 : getFilter() + d); setImage();
  };
}

// ---- sections ----------------------------------------------------------------------------------------------------------
const ERRBOX = (msg, retry) => `<div class="sn-err"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg><span>${esc(msg)}</span><button type="button" class="tn-link" data-retry="${retry}">Retry</button></div>`;
const SKEL = h => `<div class="sn-skel" style="height:${h}px" aria-busy="true" aria-label="Loading"></div>`;
function put(key, html, after) {
  const el = root?.querySelector(`[data-sec="${key}"]`); if (!el) return;
  if (sigs[key] === html) return; sigs[key] = html; el.innerHTML = html; after?.(el);
}

function render() {
  if (!root) return;
  const st = status(), now = Date.now();
  const t = Math.min(...['flareNow', 'wind', 'flares', 'regions'].map(k => sun.t[k] || Infinity));
  put('sub', Number.isFinite(t) ? `Live from NASA SDO and NOAA SWPC · data updated ${ago(t)}` : 'Live from NASA SDO and NOAA SWPC');

  // KPI tiles
  const cur = st.cur;
  put('kpis', [
    kpi('Flare class now', cur ? cur.label : '—', cur ? `${st.word} · ${fmtFlux(cur.flux)} W/m²` : 'loading', cur ? cur.color : ''),
    kpi('Largest · 24 h', st.big ? st.big.c : sun.flares ? 'None' : '—', st.big ? hmz(st.big.m) : '', st.big ? classColor(st.big.c) : ''),
    kpi('Sunspot groups', sun.regions ? String(st.groups.length) : '—', sun.regions ? `${st.spots} spots · ${st.live.length} regions` : ''),
    kpi('Solar wind', st.wind != null ? String(Math.round(st.wind)) : '—', st.wind != null ? 'km/s · ' + (st.wind > 600 ? 'fast' : st.wind > 450 ? 'elevated' : 'calm') : ''),
  ].join('') + ((sun.errors.flareNow && !sun.flareNow) ? ERRBOX('NOAA data is unreachable right now.', 'data') : ''));

  // X-ray chart
  if (sun.xray) put('xray', xrayChart(now), bindXray);
  else put('xray', sun.errors.xray ? ERRBOX('The X-ray flux feed could not be loaded.', 'xray') : SKEL(260));
  put('xmeta', sun.xray ? `0.1–0.8 nm · updated ${ago(sun.t.xray)}` : '');

  // Flares
  put('flares', flaresHtml(), null);
  put('fmeta', sun.flares ? `${sun.flares.length} in the last 7 days` : '');

  // Regions
  put('regions', regionsHtml());
  put('rmeta', sun.regions ? `Region table of ${esc(sun.regionsDate)} (UTC)` : '');

  // Cycle
  if (sun.cycle) put('cycle', cycleChart(now), bindCycle);
  else put('cycle', sun.errors.cycle ? ERRBOX('The solar cycle history could not be loaded.', 'cycle') : sun.loading.cycle ? SKEL(230) : `<div class="sn-lazy"><button type="button" class="btn" data-loadcycle>Load solar cycle history</button><span>about 145 KB, loaded when you scroll here</span></div>`);
}
const kpi = (l, v, sub, c = '') => `<div class="sn-kpi"${c ? ` style="--c:${c}"` : ''}><span class="eyebrow">${l}</span><b class="mono">${esc(v)}</b><span class="sn-kpi-sub">${esc(sub)}</span></div>`;

function flaresHtml() {
  if (!sun.flares) return sun.errors.flares ? ERRBOX('Flare list unavailable right now.', 'data') : SKEL(120);
  const list = sun.flares.slice(-8).reverse(), cnt = { X: 0, M: 0, C: 0 };
  for (const f of sun.flares) if (cnt[f.c[0]] !== undefined) cnt[f.c[0]]++;
  if (!list.length) return '<p class="sn-empty">No flares recorded in the last 7 days.</p>';
  return `<div class="sn-chips" role="list" aria-label="Flares in the last 7 days by class">${['X', 'M', 'C'].map(k => `<span role="listitem" style="--c:${BANDS.find(b => b.k === k).color}"><i></i>${k}-class <b class="mono">${cnt[k]}</b></span>`).join('')}</div>
  <ul class="sn-flares">${list.map(f => `<li style="--c:${classColor(f.c)}"><span class="sn-fc mono">${esc(f.c)}</span><span class="sn-ft mono">${esc(dayhm(f.m))}</span><span class="sn-fd mono">${Math.max(1, Math.round((f.e - f.b) / 60e3))} min</span><span class="sn-fa">${esc(ago(f.m))}</span></li>`).join('')}</ul>`;
}

const MAGHI = /D|G/;
function regionsHtml() {
  if (!sun.regions) return sun.errors.regions ? ERRBOX('Sunspot region table unavailable right now.', 'data') : SKEL(160);
  const rows = sun.regions.filter(r => r.status !== 'd').sort((a, b) => (b.m || 0) - (a.m || 0) || (b.x || 0) - (a.x || 0) || (b.spots || 0) - (a.spots || 0)).slice(0, 12);
  if (!rows.length) return '<p class="sn-empty">No numbered regions on the disk today.</p>';
  const prob = (v, c) => v == null ? '<span class="sn-p0">—</span>' : `<span class="sn-prob mono" style="--p:${Math.min(100, v)};--c:${c}" title="${v}%"><i></i><b>${v}</b></span>`;
  return `<div class="sn-tablewrap"><table class="sn-table"><caption class="sr-only">Numbered sunspot regions with flare probabilities, percent in the next 24 hours</caption>
  <thead><tr><th scope="col">Region</th><th scope="col">Location</th><th scope="col" class="r">Spots</th><th scope="col" class="r">Area<small>µh</small></th><th scope="col">Class</th><th scope="col">Magnetic</th><th scope="col" title="Probability of a C, M or X flare in 24 h">C %</th><th scope="col">M %</th><th scope="col">X %</th></tr></thead>
  <tbody>${rows.map(r => `<tr><th scope="row" class="mono">AR ${esc(r.n)}</th><td class="mono">${esc(r.loc || '—')}</td><td class="r mono">${r.spots ?? '—'}</td><td class="r mono">${r.area ?? '—'}</td><td class="mono">${esc(r.cls || '—')}</td>
    <td class="mono${MAGHI.test(r.mag) ? ' hot' : ''}">${esc(r.mag || '—')}</td><td>${prob(r.c, BANDS[2].color)}</td><td>${prob(r.m, BANDS[3].color)}</td><td>${prob(r.x, BANDS[4].color)}</td></tr>`).join('')}</tbody></table></div>
  <p class="sn-note">Flare chances are NOAA's forecast for the next 24 hours. A beta-gamma-delta ("D") magnetic layout is the classic sign of a region that can produce big flares.</p>`;
}

// ---- charts ------------------------------------------------------------------------------------------------------------
const f1 = x => x.toFixed(1);
function bandGradient(id, T, ph) {
  const stops = [...BANDS].reverse().map((b, i) => `<stop offset="${i * 0.2}" stop-color="${b.color}"/><stop offset="${(i + 1) * 0.2}" stop-color="${b.color}"/>`).join('');
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${T + ph}">${stops}</linearGradient>`;
}
function xrayChart(now) {
  const d = sun.xray, W = 820, Ht = 280, L = 52, R = 34, T = 12, B = 28, pw = W - L - R, ph = Ht - T - B;
  const t1 = d.t[d.t.length - 1], t0 = t1 - 24 * H;
  const x = t => L + (t - t0) / (t1 - t0) * pw;
  const y = f => T + ph * (1 - (Math.log10(Math.max(1e-8, Math.min(1e-3, f))) + 8) / 5);
  let i0 = 0; while (i0 < d.t.length && d.t[i0] < t0) i0++;
  let line = '', first = true;
  for (let i = i0; i < d.t.length; i++) { line += `${first ? 'M' : 'L'}${f1(x(d.t[i]))} ${f1(y(d.f[i]))}`; first = false; }
  const xe = x(d.t[d.t.length - 1]), xs = x(d.t[i0]);
  let s = `<svg class="sn-svg" viewBox="0 0 ${W} ${Ht}" role="img" tabindex="0" aria-label="GOES X-ray flux over the last 24 hours on a log scale with A, B, C, M and X flare class bands. Use left and right arrow keys to read values." data-chart="xray">
    <defs>${bandGradient('snxg', T, ph)}</defs>`;
  for (const b of BANDS) {
    const ya = y(b.hi), yb = y(b.lo);
    s += `<rect x="${L}" y="${f1(ya)}" width="${pw}" height="${f1(yb - ya)}" fill="${b.color}" opacity=".075"/>`;
    s += `<text x="${W - R + 10}" y="${f1((ya + yb) / 2 + 4)}" class="sn-band" fill="${b.color}">${b.k}</text>`;
  }
  for (let e = -8; e <= -3; e++) {
    const yy = y(10 ** e);
    s += `<line x1="${L}" x2="${L + pw}" y1="${f1(yy)}" y2="${f1(yy)}" class="sn-grid${e === -8 || e === -3 ? ' edge' : ''}"/><text x="${L - 8}" y="${f1(yy + 3.5)}" text-anchor="end" class="sn-tick">10<tspan dy="-4" font-size="7">−${-e}</tspan></text>`;
  }
  // x ticks at multiples of 4 local hours
  const off = tzOffsetMinutes(t0) * 60e3;
  for (let t = Math.ceil((t0 + off) / (4 * H)) * 4 * H - off; t <= t1; t += 4 * H) {
    const xx = x(t), mid = fmtLocal(t, { hour: '2-digit', hourCycle: 'h23' }) === '00';
    s += `<line x1="${f1(xx)}" x2="${f1(xx)}" y1="${T}" y2="${T + ph + 4}" class="sn-grid v${mid ? ' day' : ''}"/><text x="${f1(xx)}" y="${Ht - 8}" text-anchor="middle" class="sn-tick${mid ? ' bold' : ''}">${mid ? fmtLocal(t, { weekday: 'short' }) : fmtLocal(t, { hour: '2-digit', hourCycle: 'h23' }) + ':00'}</text>`;
  }
  s += `<path d="${line} L${f1(xe)} ${T + ph} L${f1(xs)} ${T + ph}Z" fill="url(#snxg)" opacity=".14"/>`;
  s += `<path d="${line}" pathLength="1" class="sn-line" stroke="url(#snxg)" fill="none"/>`;
  // flare markers
  const inView = (sun.flares || []).filter(f => f.m >= t0 && f.m <= t1), labelled = new Set(), placed = [];
  for (const f of [...inView].sort((a, b) => b.flux - a.flux)) { if (f.flux < 1e-6) break; const xx = x(f.m); if (placed.every(px => Math.abs(px - xx) > 36)) { placed.push(xx); labelled.add(f); } }
  for (const f of inView) {
    const xx = x(f.m), yy = y(f.flux), big = f.flux >= 1e-5, c = classColor(f.c);
    s += `<g class="sn-mk"><circle cx="${f1(xx)}" cy="${f1(yy)}" r="${big ? 4.2 : 3}" fill="#0a0f1c" stroke="${c}" stroke-width="1.6"><title>${esc(f.c)} flare · ${esc(dayhm(f.m))} ${esc(tzLabel(f.m))}</title></circle>${labelled.has(f) ? `<text x="${f1(xx)}" y="${f1(yy - 8)}" text-anchor="middle" class="sn-mkl" fill="${c}">${esc(f.c)}</text>` : ''}</g>`;
  }
  const lastY = y(d.f[d.f.length - 1]);
  s += `<circle cx="${f1(xe)}" cy="${f1(lastY)}" r="3.4" class="sn-now"/><circle cx="${f1(xe)}" cy="${f1(lastY)}" r="3.4" class="sn-now pulse"/>`;
  s += `<g class="sn-cross" style="display:none"><line y1="${T}" y2="${T + ph}"/><circle r="4.5"/></g><rect class="sn-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/>`;
  s += `</svg><div class="sn-tip" role="status" style="display:none"></div><span class="sr-only" aria-live="polite" data-sr></span>`;
  // stash geometry for the hover binder
  xrayGeom = { d, x, y, W, T, ph, L, pw, i0 };
  return s;
}
let xrayGeom = null, cycleGeom = null;

function bindHover(wrap, g) {
  const svg = wrap.querySelector('svg'), tip = wrap.querySelector('.sn-tip'), cross = svg.querySelector('.sn-cross'), sr = wrap.querySelector('[data-sr]');
  const line = cross.querySelector('line'), dot = cross.querySelector('circle');
  let idx = -1;
  const show = (i, keyboard) => {
    i = Math.max(g.lo, Math.min(g.hi, i)); idx = i;
    const px = g.px(i), py = g.py(i), r = svg.getBoundingClientRect(), sc = r.width / g.W;
    line.setAttribute('x1', px); line.setAttribute('x2', px); dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    dot.style.stroke = g.color(i);
    cross.style.display = '';
    tip.innerHTML = g.html(i); tip.style.display = '';
    const tw = tip.offsetWidth, left = Math.max(4, Math.min(r.width - tw - 4, px * sc - tw / 2));
    tip.style.left = left + 'px'; tip.style.top = Math.max(0, py * sc - tip.offsetHeight - 14) + 'px';
    if (keyboard) sr.textContent = g.text(i);
  };
  const hide = () => { cross.style.display = 'none'; tip.style.display = 'none'; idx = -1; };
  svg.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); show(g.nearest((e.clientX - r.left) / r.width * g.W)); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', e => {
    const k = e.key, step = e.shiftKey ? g.big : g.small;
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); show((idx < 0 ? g.hi : idx) + (k === 'ArrowLeft' ? -step : step), true); }
    else if (k === 'Home') { e.preventDefault(); show(g.lo, true); } else if (k === 'End') { e.preventDefault(); show(g.hi, true); }
    else if (k === 'Escape' && idx >= 0) { e.stopPropagation(); hide(); }
  });
}
const bisect = (arr, v, lo = 0, hi = arr.length - 1) => { while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };

function bindXray(wrap) {
  const g0 = xrayGeom, { d, x, y, i0 } = g0; const xs = new Float64Array(d.t.length - i0).map((_, k) => x(d.t[i0 + k]));
  bindHover(wrap, {
    W: g0.W, lo: 0, hi: xs.length - 1, small: 3, big: 30,
    nearest: px => { const i = bisect(xs, px); return i > 0 && px - xs[i - 1] < xs[i] - px ? i - 1 : i; },
    px: i => xs[i], py: i => y(d.f[i0 + i]), color: i => (classOf(d.f[i0 + i]) || {}).color,
    html: i => { const c = classOf(d.f[i0 + i]); return `<b class="mono" style="color:${c.color}">${c.label}</b><span class="mono">${fmtFlux(c.flux)} W/m²</span><em>${esc(dayhm(d.t[i0 + i]))} ${esc(tzLabel(d.t[i0 + i]))}</em>`; },
    text: i => { const c = classOf(d.f[i0 + i]); return `${c.label}, ${dayhm(d.t[i0 + i])}`; },
  });
}

// Solar cycle ----------------------------------------------------------------------------------------------------------
function smooth13(obs) {
  return obs.map((p, i) => {
    if (i < 6 || i > obs.length - 7) return [p[0], null];
    let s = 0; for (let k = -6; k <= 6; k++) s += obs[i + k][1] * (Math.abs(k) === 6 ? 0.5 : 1);
    return [p[0], s / 12];
  });
}
const monthYear = ms => new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(ms);
function cycleChart(now) {
  const c = sun.cycle, W = 820, Ht = 250, L = 44, R = 16, T = 16, B = 28, pw = W - L - R, ph = Ht - T - B;
  const t0 = Date.UTC(new Date(now).getUTCFullYear() - 25, 0, 1);
  const obs = c.obs.filter(p => p[0] >= t0 - 8 * 30 * 864e5), pred = c.pred.filter(p => p[0] > obs[obs.length - 1][0]);
  const sm = smooth13(obs);
  const tEnd = Math.max(obs[obs.length - 1][0], pred.length ? pred[pred.length - 1][0] : 0, now + 2 * 365 * 864e5);
  const maxV = Math.max(...obs.map(p => p[1]), ...pred.map(p => p[3] || p[1])), ymax = Math.ceil(maxV / 50) * 50;
  const x = t => L + (t - t0) / (tEnd - t0) * pw, y = v => T + ph * (1 - v / ymax);
  const vis = obs.map((p, i) => ({ i, t: p[0], v: p[1], s: sm[i][1] })).filter(p => p.t >= t0);
  const CYC25 = Date.UTC(2019, 11, 1);
  const peak = (a, b) => vis.filter(p => p.s != null && p.t >= a && p.t <= b).reduce((m, p) => (!m || p.s > m.s ? p : m), null);
  const p25 = peak(CYC25, now), p24 = peak(Date.UTC(2011, 0, 1), Date.UTC(2017, 0, 1));
  let s = `<svg class="sn-svg" viewBox="0 0 ${W} ${Ht}" role="img" tabindex="0" data-chart="cycle" aria-label="Monthly sunspot number over the last 25 years${p25 ? `. Solar cycle 25 peaked near ${Math.round(p25.s)} in ${monthYear(p25.t)}` : ''}. Use left and right arrow keys to read values.">
    <defs><linearGradient id="snca" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb347" stop-opacity=".35"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></linearGradient></defs>`;
  for (let v = 0; v <= ymax; v += 50) s += `<line x1="${L}" x2="${L + pw}" y1="${f1(y(v))}" y2="${f1(y(v))}" class="sn-grid${v === 0 ? ' edge' : ''}"/><text x="${L - 8}" y="${f1(y(v) + 3.5)}" text-anchor="end" class="sn-tick">${v}</text>`;
  for (let yr = Math.ceil(new Date(t0).getUTCFullYear() / 5) * 5; Date.UTC(yr, 0, 1) <= tEnd; yr += 5) { const xx = x(Date.UTC(yr, 0, 1)); s += `<line x1="${f1(xx)}" x2="${f1(xx)}" y1="${T}" y2="${T + ph + 4}" class="sn-grid v"/><text x="${f1(xx)}" y="${Ht - 8}" text-anchor="middle" class="sn-tick">${yr}</text>`; }
  // cycle 25 shading
  s += `<rect x="${f1(x(CYC25))}" y="${T}" width="${f1(L + pw - x(CYC25))}" height="${ph}" fill="#ffb347" opacity=".045"/><text x="${f1(x(CYC25) + 6)}" y="${T + 11}" class="sn-cl25">CYCLE 25</text>`;
  if (pred.length) {
    const up = pred.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p[0]))} ${f1(y(p[3] ?? p[1]))}`).join(''), dn = [...pred].reverse().map(p => `L${f1(x(p[0]))} ${f1(y(p[2] ?? p[1]))}`).join('');
    s += `<path d="${up}${dn}Z" fill="#a78bff" opacity=".16"/><path d="${pred.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p[0]))} ${f1(y(p[1]))}`).join('')}" fill="none" stroke="#a78bff" stroke-width="1.6" stroke-dasharray="4 4" opacity=".9"/>`;
  }
  s += `<path d="${vis.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p.t))} ${f1(y(p.v))}`).join('')}" fill="none" stroke="#8da2c8" stroke-width="1" opacity=".45"/>`;
  const sv = vis.filter(p => p.s != null), seg = (arr, c) => arr.length ? `<path d="${arr.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p.t))} ${f1(y(p.s))}`).join('')}" pathLength="1" class="sn-line" fill="none" stroke="${c}"/>` : '';
  const a24 = sv.filter(p => p.t < CYC25), a25 = sv.filter(p => p.t >= CYC25 - 31 * 864e5);
  if (a25.length) s += `<path d="${a25.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p.t))} ${f1(y(p.s))}`).join('')}L${f1(x(a25[a25.length - 1].t))} ${T + ph}L${f1(x(a25[0].t))} ${T + ph}Z" fill="url(#snca)"/>`;
  s += seg(a24, '#c3cde0') + seg(a25, '#ffb347');
  const mark = (p, label, c, anchor) => p ? `<g><circle cx="${f1(x(p.t))}" cy="${f1(y(p.s))}" r="4" fill="#0a0f1c" stroke="${c}" stroke-width="1.8"/><text x="${f1(x(p.t))}" y="${f1(y(p.s) - 11)}" text-anchor="${anchor || 'middle'}" class="sn-mkl big" fill="${c}">${label} · ${Math.round(p.s)}</text></g>` : '';
  s += mark(p24, 'Cycle 24 peak', '#c3cde0') + mark(p25, 'Cycle 25 peak', '#ffb347');
  const xn = x(now); s += `<line x1="${f1(xn)}" x2="${f1(xn)}" y1="${T}" y2="${T + ph}" class="sn-nowline"/><text x="${f1(xn + 4)}" y="${T + ph - 5}" class="sn-tick">now</text>`;
  s += `<g class="sn-cross" style="display:none"><line y1="${T}" y2="${T + ph}"/><circle r="4.5"/></g><rect class="sn-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/></svg><div class="sn-tip" role="status" style="display:none"></div><span class="sr-only" aria-live="polite" data-sr></span>
  <div class="sn-legend"><span><i style="background:#8da2c8;opacity:.6"></i>Monthly</span><span><i style="background:#ffb347"></i>13-month smoothed, cycle 25</span><span><i style="background:#c3cde0"></i>Earlier cycles</span><span><i class="dash"></i>NOAA prediction (band = range)</span></div>`;
  cycleGeom = { vis, pred, x, y, W, p25 };
  return s;
}
function bindCycle(wrap) {
  const { vis, x, y, W } = cycleGeom, xs = vis.map(p => x(p.t));
  bindHover(wrap, {
    W, lo: 0, hi: vis.length - 1, small: 1, big: 12,
    nearest: px => { const i = bisect(xs, px); return i > 0 && px - xs[i - 1] < xs[i] - px ? i - 1 : i; },
    px: i => xs[i], py: i => y(vis[i].v), color: () => '#ffb347',
    html: i => `<b class="mono" style="color:#ffb347">${vis[i].v.toFixed(0)}</b><span class="mono">${vis[i].s != null ? 'smoothed ' + vis[i].s.toFixed(0) : 'sunspot no.'}</span><em>${esc(monthYear(vis[i].t))}</em>`,
    text: i => `${monthYear(vis[i].t)}, sunspot number ${vis[i].v.toFixed(0)}`,
  });
  const m = root.querySelector('[data-sec="cmeta"]'), c = sun.cycle, last = c.obs[c.obs.length - 1];
  if (m) m.textContent = `latest ${monthYear(last[0])}: ${last[1].toFixed(0)}${cycleGeom.p25 ? ` · cycle 25 peak ${Math.round(cycleGeom.p25.s)} (${monthYear(cycleGeom.p25.t)})` : ''}`;
}
