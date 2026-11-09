// "Tonight" panel: location, stargazing score, ISS + visible passes, sun & moon, clouds, aurora.
import * as state from '../state.js';
import * as clock from '../clock.js';
import { fetchWeather } from './weather.js';
import { learnZone } from '../util/time.js';
import { sunSequence, darkWindow, moonInfo, moonUpFraction, moonSvg, bodyAlt } from './astro.js';
import { computeScore, reasonText } from './score.js';
import { ensurePasses, getPasses } from './passes.js';
import { fetchKp, assess } from './aurora.js';
import { openLocationPicker, useMyLocation } from './location.js';
import { $, esc, clamp, fmtTime, zoneAbbr, relDay, countdown, dur, compass, magDots, magLabel, skeleton, polarSvg } from './util.js';

const ctx = {
  loc: null, weather: null, weatherErr: null, weatherPending: true,
  seq: null, win: null, moon: null, moonFrac: 0, score: null, reason: '', astroErr: null, computedAt: 0, computedReal: 0,
  passes: null, passesErr: null, passesPending: true, aurora: null, auroraErr: null, auroraPending: true,
  showAllPasses: false,
};
let root, token = 0;
const els = {};
const HEADLINERS = new Set([25544, 48274, 20580]);
// The list keeps headliners plus passes bright and high enough to be worth stepping outside for.
const worthIt = p => HEADLINERS.has(p.satId) || (p.mag <= 0.5 && p.maxEl >= 25);
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
let setSheet = () => {};
const CHEV = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
const PIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export async function init() {
  root = document.getElementById('panel-tonight');
  if (!root) return;
  root.className = 'tn-panel glass';
  root.setAttribute('aria-label', 'Tonight at your location');
  root.innerHTML = `
    <div class="tn-head">
      <button class="tn-handle" type="button" aria-label="Expand or collapse Tonight panel"><span></span></button>
      <span class="eyebrow">Tonight</span>
      <div class="tn-peek" id="tn-peek" aria-live="off"></div>
      <button class="tn-icon-btn tn-collapse" type="button" aria-label="Collapse panel" aria-expanded="true">${CHEV}</button>
    </div>
    <div class="tn-body scroll">
      <div id="tn-banner"></div>
      <div class="tn-loc" id="tn-loc"></div>
      <section class="tn-card tn-score" id="tn-score" aria-label="Tonight score"></section>
      <div class="tn-card tn-iss" id="tn-iss"></div>
      <section class="tn-card" id="tn-passes" aria-label="Upcoming passes"></section>
      <section class="tn-card" id="tn-sun" aria-label="Sun and Moon"></section>
      <section class="tn-card" id="tn-cloud" aria-label="Cloud cover"></section>
      <section class="tn-card" id="tn-aurora" aria-label="Aurora chance"></section>
      <p class="tn-foot">Data: CelesTrak · Open-Meteo · NOAA SWPC</p>
    </div>`;
  for (const id of ['banner', 'loc', 'score', 'iss', 'passes', 'sun', 'cloud', 'aurora']) els[id] = $('#tn-' + id, root);
  setupCollapse();
  ctx.loc = state.get('location');
  els.loc.addEventListener('click', e => { if (e.target.closest('[data-change]')) openLocationPicker(); });
  els.banner.addEventListener('click', onBanner);
  els.iss.addEventListener('click', () => { const p = nextIss(); if (p) selectSat(p.satId); });
  els.passes.addEventListener('click', e => {
    if (e.target.closest('[data-more]')) { ctx.showAllPasses = !ctx.showAllPasses; renderPasses(); return; }
    const r = e.target.closest('[data-sat]'); if (r) selectSat(+r.dataset.sat);
  });
  els.passes.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-sat]')) { e.preventDefault(); selectSat(+e.target.dataset.sat); } });
  els.iss.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === els.iss) { e.preventDefault(); const p = nextIss(); if (p) selectSat(p.satId); } });

  state.on('location', l => {
    const prev = ctx.loc; ctx.loc = l;
    // learnZone() patches only `tz`: re-render labels but do not refetch (prevents a loop).
    if (prev && prev.lat === l.lat && prev.lon === l.lon && prev.name === l.name) { renderAll(); return; }
    ctx.showAllPasses = false; refreshAll();
  });
  state.on('view', () => { if (isMobile()) setSheet(false); });
  state.on('selection', s => { root.classList.toggle('detail-open', !!s && isMobile()); if (s && isMobile()) setSheet(false); });
  root.classList.toggle('detail-open', !!state.get('selection') && isMobile());
  state.on('passes', p => { if (p !== ctx.passes) { ctx.passes = p; ctx.passesPending = false; renderIss(); renderPasses(); } });
  setInterval(() => { if (!document.hidden) tick(); }, 1000);
  refreshAll();
}

function selectSat(id) { state.set('selection', { kind: 'sat', id }); state.set('view', 'sky'); }
const nextIss = () => (ctx.passes || []).find(p => p.satId === 25544 && p.end > clock.now());

// ---------- collapse / bottom sheet ----------
function setupCollapse() {
  const btn = $('.tn-collapse', root), handle = $('.tn-handle', root);
  const mq = window.matchMedia('(max-width: 760px)');
  const set = open => {
    if (!root) return;
    root.classList.toggle('collapsed', !open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
    root.style.removeProperty('--drag');
  };
  setSheet = set;
  set(!mq.matches); // mobile starts at the compact peek
  btn.addEventListener('click', () => set(root.classList.contains('collapsed')));
  mq.addEventListener('change', () => set(!mq.matches));
  // Drag / tap on the header (mobile). The sheet height follows the finger between peek and expanded.
  let y0 = null, moved = 0, startCollapsed = false, peekH = 100, fullH = 600, startH = 0;
  const head = $('.tn-head', root);
  head.addEventListener('pointerdown', e => {
    if (!mq.matches || e.target.closest('.tn-collapse')) return;
    y0 = e.clientY; moved = 0; startCollapsed = root.classList.contains('collapsed'); head.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    peekH = parseFloat(getComputedStyle(root).getPropertyValue('--peek')) || 100;
    startH = root.offsetHeight;
    root.classList.remove('collapsed'); root.style.removeProperty('height'); fullH = root.offsetHeight; // expanded height from CSS
    if (startCollapsed) root.classList.add('collapsed');
    root.style.height = startH + 'px';
  });
  head.addEventListener('pointermove', e => {
    if (y0 == null) return;
    moved = e.clientY - y0;
    root.style.height = clamp(startH - moved, peekH, fullH) + 'px';
  });
  const end = () => {
    if (y0 == null) return;
    root.classList.remove('dragging'); root.style.removeProperty('height');
    if (Math.abs(moved) < 6) set(startCollapsed); // tap toggles
    else set(moved < 0);                          // drag up expands, down collapses
    y0 = null;
  };
  head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(root.classList.contains('collapsed')); } });
}
// tap on handle on mobile without pointer events fallback
// (pointerup path handles it; click is intentionally not bound to avoid double toggle)

// ---------- data flow ----------
function refreshAll() {
  const my = ++token, loc = ctx.loc;
  Object.assign(ctx, { weather: null, weatherErr: null, weatherPending: true, passes: null, passesErr: null, passesPending: true,
    aurora: null, auroraErr: null, auroraPending: true });
  computeAstro();
  renderAll();
  fetchWeather(loc.lat, loc.lon).then(w => {
    if (my !== token) return;
    ctx.weather = w; ctx.weatherPending = false; learnZone(w.tz);
    if (w.elevation != null && loc.source !== 'default' && !loc.elevM) { /* keep user's elevation untouched */ }
    computeAstro(); renderAll();
  }).catch(e => { if (my !== token) return; ctx.weatherErr = e; ctx.weatherPending = false; computeAstro(); renderAll(); });
  ensurePasses(true).catch(e => { if (my !== token) return; ctx.passesErr = e; ctx.passesPending = false; renderIss(); renderPasses(); });
  fetchKp().then(rows => { if (my !== token) return; ctx.aurora = rows; ctx.auroraPending = false; renderAurora(); })
    .catch(e => { if (my !== token) return; ctx.auroraErr = e; ctx.auroraPending = false; renderAurora(); });
  renderBanner();
}

function computeAstro() {
  const t = clock.now(); ctx.computedAt = t; ctx.computedReal = Date.now();
  try {
    ctx.astroErr = null;
    ctx.seq = sunSequence(ctx.loc, t);
    ctx.win = darkWindow(ctx.seq, t);
    ctx.moon = moonInfo(ctx.loc, t);
    ctx.moonFrac = ctx.win ? moonUpFraction(ctx.loc, ctx.win.start, ctx.win.end) : 0;
    ctx.score = computeScore({ hours: ctx.weather?.hours, win: ctx.win, moonFrac: ctx.moonFrac, moon: ctx.moon });
    ctx.reason = reasonText({ cloud: ctx.score.cloud, moon: ctx.moon, win: ctx.win, moonFrac: ctx.moonFrac });
  } catch (e) { console.error('[tonight astro]', e); ctx.astroErr = e; }
}

let lastScoreShown = 0;
function tick() {
  const t = clock.now();
  if (ctx.loc && (Math.abs(t - ctx.computedAt) > 90 * 60e3 && Date.now() - ctx.computedReal > 4000)) { computeAstro(); renderScore(); renderSun(); renderCloud(); }
  // passes window maintenance (location change handled in refreshAll)
  ensurePasses().catch(() => {});
  updateCountdown();
}

// ---------- rendering ----------
function renderAll() { renderLoc(); renderBanner(); renderScore(); renderIss(); renderPasses(); renderSun(); renderCloud(); renderAurora(); }
const safe = (fn, el) => { try { fn(); } catch (e) { console.error('[tonight render]', e); el.innerHTML = errorBlock('Something went wrong showing this card.'); } };
const errorBlock = msg => `<div class="tn-err"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg><span>${esc(msg)}</span></div>`;
const head = (title, right = '') => `<div class="tn-card-head"><span class="eyebrow">${title}</span>${right ? `<span class="tn-right">${right}</span>` : ''}</div>`;

function renderLoc() {
  const l = ctx.loc;
  els.loc.innerHTML = `<span class="tn-pin">${PIN}</span><span class="tn-place" title="${esc(l.name)}">${esc(l.name)}</span><span class="tn-coord mono">${Math.abs(l.lat).toFixed(1)}°${l.lat < 0 ? 'S' : 'N'}</span><button type="button" class="tn-link" data-change>change</button>`;
}

function renderBanner() {
  if (ctx.loc.source !== 'default' || lsGet('skywatch:tonight:prompted')) { els.banner.innerHTML = ''; return; }
  els.banner.innerHTML = `<div class="tn-banner"><p><b>Where are you?</b> Showing ${esc(ctx.loc.name)}. Set your location for accurate passes and weather.</p>
    <div class="tn-banner-actions"><button class="btn primary" data-act="geo" type="button">Use my location</button><button class="btn" data-act="pick" type="button">Choose city</button><button class="tn-link" data-act="dismiss" type="button">Not now</button></div></div>`;
}
async function onBanner(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  lsSet('skywatch:tonight:prompted', '1');
  if (b.dataset.act === 'dismiss') { els.banner.innerHTML = ''; return; }
  if (b.dataset.act === 'pick') { els.banner.innerHTML = ''; openLocationPicker(); return; }
  b.disabled = true; b.textContent = 'Locating…';
  try { await useMyLocation(); } catch (err) { state.emit('toast', err && err.code === 1 ? 'Location permission denied. Pick a city instead.' : 'Could not get your location'); els.banner.innerHTML = ''; openLocationPicker(); }
}

function renderPeek() {
  const el = $('#tn-peek', root); if (!el) return;
  const s = ctx.score, pending = ctx.weatherPending;
  const hue = s ? Math.round(clamp(s.score, 0, 100) * 1.3) : 0, C = 2 * Math.PI * 20;
  const p = nextIss(), now = clock.now();
  const iss = ctx.passesPending ? 'ISS pass…' : p ? (now >= p.start ? 'ISS overhead now' : 'ISS in ' + countdown(p.start - now)) : 'No ISS pass soon';
  el.innerHTML = `<div class="tn-pring"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" class="trk"/><circle cx="24" cy="24" r="20" class="val" style="stroke:hsl(${hue} 85% 62%);stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${(C * (1 - (pending || !s ? 0 : s.score) / 100)).toFixed(1)}"/></svg><b class="mono">${pending || !s ? '' : s.score}</b></div>
    <div class="tn-ptxt"><span class="tn-pword" style="color:hsl(${hue} 85% 68%)">${pending || !s ? 'Tonight' : s.word}</span><span class="tn-piss mono" data-peek-iss>${iss}</span></div>`;
}

function renderScore() {
  renderPeek();
  safe(() => {
    if (ctx.astroErr) { els.score.innerHTML = head('Tonight score') + errorBlock('Could not compute sky conditions.'); return; }
    if (!ctx.score) { els.score.innerHTML = head('Tonight score') + skeleton(3); return; }
    const s = ctx.score, pending = ctx.weatherPending, noWx = ctx.weatherErr;
    const C = 2 * Math.PI * 44;
    const show = pending ? 0 : s.score;
    const hue = Math.round(clamp(show, 0, 100) * 1.3); // 0 red -> 130 green
    const prevScore = +(els.score.dataset.score || 0);
    const html = `${head('Tonight score', ctx.win ? (ctx.win.start <= clock.now() + 1 && clock.now() < ctx.win.end ? 'Dark now' : 'Coming night') : '')}
      <div class="tn-score-row">
        <div class="tn-ring ${pending ? 'pending' : ''}" role="img" aria-label="Score ${pending ? 'loading' : s.score} out of 100">
          <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="trk"/>
            <circle cx="50" cy="50" r="44" class="val" style="stroke:hsl(${hue} 85% 62%);stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${(C * (1 - prevScore / 100)).toFixed(1)}" data-c="${C}"/></svg>
          <div class="tn-ring-num mono">${pending ? '' : prevScore}</div>
        </div>
        <div class="tn-score-txt">
          ${pending ? '<div class="tn-skel" style="width:70%;height:22px"></div>' + skeleton(2) : `
          <div class="tn-word" style="color:hsl(${hue} 85% 68%)">${s.word}</div>
          <div class="tn-reason">${esc(ctx.reason)}${noWx ? ' <span class="tn-dim">(forecast offline)</span>' : ''}</div>
          <div class="tn-facts mono">${s.cloud != null ? `<span>☁ ${Math.round(s.cloud)}%</span>` : ''}<span>☾ ${Math.round(ctx.moon.illum * 100)}%</span><span>● ${ctx.win ? ctx.win.hours.toFixed(1) : 0}h dark</span></div>`}
        </div>
      </div>`;
    els.score.innerHTML = html;
    if (!pending) animateRing(prevScore, s.score, hue, C);
  }, els.score);
}
function animateRing(from, to, hue, C) {
  const ring = $('.val', els.score), num = $('.tn-ring-num', els.score);
  els.score.dataset.score = String(to);
  if (!ring) return;
  const t0 = performance.now(), D = 1100;
  const step = now => {
    const k = clamp((now - t0) / D, 0, 1), e = 1 - Math.pow(1 - k, 3), v = from + (to - from) * e;
    ring.style.strokeDashoffset = (C * (1 - v / 100)).toFixed(1);
    num.textContent = Math.round(v);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function passInfoLine(p) { return `${compass(p.startAz)} → ${compass(p.endAz)}`; }

function renderIss() {
  renderPeek();
  safe(() => {
    const iss = els.iss;
    if (ctx.passesPending) { iss.innerHTML = head('Next ISS pass') + skeleton(3); iss.removeAttribute('tabindex'); iss.classList.remove('click'); return; }
    if (ctx.passesErr) { iss.innerHTML = head('Next ISS pass') + errorBlock('Pass prediction failed. Try changing location.'); return; }
    const p = nextIss();
    if (!p) { iss.innerHTML = head('Next ISS pass') + `<p class="tn-empty">No visible ISS pass in the next 3 days from here. Passes need a dark sky while the station is still in sunlight.</p>`; iss.classList.remove('click'); return; }
    iss.classList.add('click'); iss.tabIndex = 0; iss.setAttribute('role', 'button');
    const now = clock.now();
    iss.innerHTML = `${head('Next ISS pass', '<span class="tn-live-dot"></span>ISS')}
      <div class="tn-iss-main">
        <div class="tn-iss-txt">
          <div class="tn-count mono" data-count>${now >= p.start ? 'Overhead now' : 'in ' + countdown(p.start - now)}</div>
          <div class="tn-when">${relDay(p.start, now)} · <span class="mono">${fmtTime(p.start)} ${zoneAbbr(p.start)}</span></div>
        </div>
        ${polarSvg(p.track, 88)}
      </div>
      <dl class="tn-stats">
        <div><dt>Direction</dt><dd>${compass(p.startAz)} → ${compass(p.endAz)}</dd></div>
        <div><dt>Max elev.</dt><dd class="mono">${Math.round(p.maxEl)}°</dd></div>
        <div><dt>Visible</dt><dd class="mono">${dur(p.end - p.start)}</dd></div>
        <div><dt>Brightness</dt><dd>${magDots(p.mag)}<span class="tn-mag">${magLabel(p.mag)}</span></dd></div>
      </dl>`;
    iss.dataset.start = p.start;
  }, els.iss);
}
function updateCountdown() {
  const pk = $('[data-peek-iss]', root), pp = nextIss();
  if (pk && pp) { const n = clock.now(); pk.textContent = n >= pp.start ? 'ISS overhead now' : 'ISS in ' + countdown(pp.start - n); }
  const c = els.iss && $('[data-count]', els.iss); const p = nextIss();
  if (!c) { return; }
  if (!p) { renderIss(); return; }
  if (+els.iss.dataset.start !== p.start) { renderIss(); return; }
  const now = clock.now();
  c.textContent = now >= p.start ? 'Overhead now' : 'in ' + countdown(p.start - now);
}

function renderPasses() {
  safe(() => {
    const el = els.passes;
    const right = `Times in ${zoneAbbr(clock.now())}`;
    if (ctx.passesPending) { el.innerHTML = head('Upcoming passes', 'next 3 days') + skeleton(4); return; }
    if (ctx.passesErr) { el.innerHTML = head('Upcoming passes') + errorBlock('Could not predict passes.'); return; }
    const now = clock.now(), hero = nextIss();
    // The worker returns every naked-eye pass (mag <= 4.5); the list keeps the ones worth stepping outside for.
    const list = (ctx.passes || []).filter(p => p.end > now && p !== hero && worthIt(p));
    if (!list.length) { el.innerHTML = head('Upcoming passes', right) + `<p class="tn-empty">No other visible passes in the next 3 days.</p>`; return; }
    const shown = ctx.showAllPasses ? list : list.slice(0, 6);
    el.innerHTML = head('Upcoming passes', right) + `<div class="tn-passlist" role="group" aria-label="Upcoming passes">` + shown.map(p => `
      <div class="tn-pass" tabindex="0" role="button" data-sat="${p.satId}">
        <div class="tn-pt"><span class="tn-day">${relDay(p.start, now)}</span><span class="mono">${fmtTime(p.start)}</span></div>
        <div class="tn-pn"><b>${esc(shortName(p.name))}</b><span>${passInfoLine(p)} · ${dur(p.end - p.start)}</span></div>
        <div class="tn-pe"><span class="mono">${Math.round(p.maxEl)}°</span>${magDots(p.mag)}</div>
      </div>`).join('') + `</div>` + (list.length > 6 ? `<button class="tn-link tn-more" type="button" data-more>${ctx.showAllPasses ? 'Show fewer' : `Show all ${list.length}`}</button>` : '');
  }, els.passes);
}
const shortName = n => n.replace(/\s*\(.*\)/, m => /ZARYA/.test(m) ? '' : (/TIANHE/.test(m) ? ' Tiangong' : '')).replace('CSS', 'CSS').trim() || n;

function tfmt(ms) { return ms == null ? '—' : `${fmtTime(ms)}`; }
function renderSun() {
  safe(() => {
    const el = els.sun;
    if (ctx.astroErr) { el.innerHTML = head('Sun & Moon') + errorBlock('Could not compute sun and moon times.'); return; }
    if (!ctx.seq) { el.innerHTML = head('Sun & Moon') + skeleton(4); return; }
    const s = ctx.seq, m = ctx.moon;
    const rows = [['Sunset', s.sunset, 'sun'], ['Astro dusk', s.dusk, 'dusk'], ['Astro dawn', s.dawn, 'dawn'], ['Sunrise', s.sunrise, 'sun']];
    el.innerHTML = `${head('Sun & Moon', `Times in ${zoneAbbr(clock.now())}`)}
      <div class="tn-sun-grid">${rows.map(([l, t, k]) => `<div class="tn-sunrow ${k}"><span>${l}</span><b class="mono">${tfmt(t)}</b></div>`).join('')}</div>
      ${s.dusk ? '' : '<p class="tn-note">No full astronomical darkness at this latitude tonight.</p>'}
      <div class="tn-moon-row">
        ${moonSvg(m.phase, ctx.loc.lat, 56)}
        <div class="tn-moon-txt"><b>${m.name}</b><span class="mono">${Math.round(m.illum * 100)}% illuminated</span></div>
        <div class="tn-moon-times"><span>Moonrise <b class="mono">${tfmt(m.rise)}</b></span><span>Moonset <b class="mono">${tfmt(m.set)}</b></span></div>
      </div>`;
  }, els.sun);
}

function renderCloud() {
  safe(() => {
    const el = els.cloud;
    if (ctx.weatherPending) { el.innerHTML = head('Cloud cover', 'next 12 h') + `<div class="tn-skel" style="height:72px;width:100%"></div>`; return; }
    if (ctx.weatherErr || !ctx.weather) { el.innerHTML = head('Cloud cover') + errorBlock('Cloud forecast is unavailable right now.'); return; }
    const now = clock.now(), H = 3600e3;
    const base = Math.floor(now / H) * H;
    const byT = new Map(ctx.weather.hours.map(h => [h.t, h]));
    const hrs = [];
    for (let i = 0; i < 12; i++) { const t = base + i * H, h = byT.get(t) || ctx.weather.hours.find(x => Math.abs(x.t - t) < H / 2); if (h) hrs.push({ t, ...h }); }
    if (!hrs.length) { el.innerHTML = head('Cloud cover') + errorBlock('No forecast hours cover now.'); return; }
    const W = 300, Hh = 76, padB = 16, bw = W / hrs.length, ph = Hh - padB;
    const dark = hrs.map(h => bodyAlt('Sun', h.t + H / 2, ctx.loc) < -12);
    let svg = `<svg viewBox="0 0 ${W} ${Hh}" class="tn-cloudsvg" role="img" aria-label="Hourly cloud cover for the next 12 hours">`;
    hrs.forEach((h, i) => { if (dark[i]) svg += `<rect x="${i * bw}" y="0" width="${bw}" height="${ph}" class="night"/>`; });
    [25, 50, 75].forEach(v => { svg += `<line x1="0" x2="${W}" y1="${ph * (1 - v / 100)}" y2="${ph * (1 - v / 100)}" class="g"/>`; });
    const pts = hrs.map((h, i) => [i * bw + bw / 2, ph * (1 - h.cloud / 100)]);
    const low = hrs.map((h, i) => [i * bw + bw / 2, ph * (1 - h.low / 100)]);
    const area = (p) => `M${p[0][0] - bw / 2} ${ph} L${p[0][0] - bw / 2} ${p[0][1]} ` + p.map(q => `L${q[0]} ${q[1]}`).join(' ') + ` L${p[p.length - 1][0] + bw / 2} ${p[p.length - 1][1]} L${p[p.length - 1][0] + bw / 2} ${ph}Z`;
    svg += `<path d="${area(pts)}" class="a-hi"/><path d="${area(low)}" class="a-lo"/>`;
    svg += `<path d="M${pts.map(q => q.join(' ')).join(' L')}" class="ln"/>`;
    hrs.forEach((h, i) => {
      if (i % 3 === 0) svg += `<text x="${i * bw + 2}" y="${Hh - 3}" class="tx">${fmtTime(h.t).slice(0, 2)}</text>`;
      svg += `<rect x="${i * bw}" y="0" width="${bw}" height="${Hh - padB}" fill="transparent"><title>${fmtTime(h.t)}: ${h.cloud}% cloud (${h.low}% low)</title></rect>`;
    });
    svg += '</svg>';
    const avg = Math.round(hrs.reduce((a, h) => a + h.cloud, 0) / hrs.length);
    el.innerHTML = `${head('Cloud cover', `Next 12 h · ${zoneAbbr(now)}`)}${svg}
      <div class="tn-legend"><span><i class="sw hi"></i>Total</span><span><i class="sw lo"></i>Low cloud</span><span><i class="sw ni"></i>Dark hours</span><span class="mono tn-avg">avg ${avg}%</span></div>`;
  }, els.cloud);
}

function renderAurora() {
  safe(() => {
    const el = els.aurora;
    if (ctx.auroraPending) { el.innerHTML = head('Aurora chance') + skeleton(2); return; }
    if (ctx.auroraErr) { el.innerHTML = head('Aurora chance') + errorBlock('Space-weather data is unavailable right now.'); el.classList.remove('hot'); return; }
    const a = assess(ctx.aurora, clock.now(), ctx.loc.lat, ctx.loc.lon);
    el.classList.toggle('hot', a.hot);
    const lvl = { likely: 'Likely', possible: 'Possible', unlikely: 'Unlikely', none: 'Very unlikely', unknown: 'Unknown' }[a.level];
    el.innerHTML = `${head('Aurora chance', a.maxKp != null ? `Kp max <b class="mono">${a.maxKp.toFixed(1)}</b> · 24 h` : '')}
      <div class="tn-aur"><div class="tn-aur-lvl ${a.level}">${lvl}</div><p>${esc(a.text)}</p></div>
      <div class="tn-aur-meta mono">Geomagnetic lat ${a.mlat.toFixed(0)}°</div>`;
  }, els.aurora);
}
