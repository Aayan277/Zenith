// Time bar: sim clock, LIVE pill, scrubber, speed controls, keyboard shortcuts.
// Two modes: normal (-12h..+48h, 1x..3600x) and System view (+-2 years, month ticks, 1 day/s..1 month/s).
import * as state from '../state.js';
import { fmtLocal, tzLabel, tzOffsetMinutes } from '../util/time.js';
import { now, isLive, getRate, setTime, setRate, goLive } from '../clock.js';
import { plainKey } from './keys.js';

const DAY_MIN = 1440;
const MODES = {
  normal: { back: 12 * 60, fwd: 48 * 60, step: 1, stepKey: 10, left: '−12h', right: '+48h',
    speeds: [[1, '1×', ''], [60, '60×', ''], [600, '600×', ''], [3600, '3600×', '']] },
  system: { back: 730 * DAY_MIN, fwd: 730 * DAY_MIN, step: DAY_MIN, stepKey: DAY_MIN, left: '', right: '',
    speeds: [[1, '1×', 'Real time'], [86400, '1 day/s', '1 day per second'], [604800, '1 wk/s', '1 week per second'], [2629800, '1 mo/s', '1 month per second']] },
};
let mode = MODES.normal, BACK_MIN = mode.back, FWD_MIN = mode.fwd, SPAN = BACK_MIN + FWD_MIN;
const p2 = n => String(n).padStart(2, '0');

const I = {
  rev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11 6.5v11L3.5 12zM20.5 6.5v11L13 12z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>',
  live: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
};

let el, $ = {}, dragging = false, prevRate = 1, lastClock = '', lastDate = '', marks = [], marksKey = '';

function build() {
  el.classList.add('glass');
  el.innerHTML = `
    <div class="tb-clock">
      <div class="tb-timerow"><span class="tb-time mono" id="tb-time">--:--:--</span><span class="tb-zone mono" id="tb-zone"></span></div>
      <div class="tb-date" id="tb-date"></div>
    </div>
    <div class="tb-status">
      <span class="live-pill" id="tb-live"><i></i>LIVE</span>
      <button class="btn back-live" id="tb-back" hidden>${I.live}<span>Back to live</span></button>
    </div>
    <div class="tb-scrub">
      <div class="scrub-track" id="tb-track">
        <div class="scrub-ticks" id="tb-ticks"></div>
        <div class="scrub-now" id="tb-nowmark" title="Now"></div>
        <input type="range" id="tb-range" min="0" max="${SPAN}" step="1" value="${BACK_MIN}" aria-label="Time offset from now" />
      </div>
      <div class="scrub-labels mono"><span id="tb-lo">−12h</span><span id="tb-offset"></span><span id="tb-hi">+48h</span></div>
    </div>
    <div class="tb-speed" role="group" aria-label="Playback speed">
      <button class="sp" id="tb-rev" title="Reverse" aria-label="Reverse time">${I.rev}</button>
      <button class="sp" id="tb-pause" title="Pause / play (Space)" aria-label="Pause">${I.pause}</button>
      <span class="sp-rates" id="tb-rates"></span>
    </div>`;
  for (const id of ['time', 'zone', 'date', 'live', 'back', 'track', 'ticks', 'nowmark', 'range', 'offset', 'rev', 'pause', 'lo', 'hi', 'rates']) $[id] = el.querySelector('#tb-' + id);
  setMode(state.get('view') === 'system' ? 'system' : 'normal', true);
}

// Switch the scrubber range / speeds. System view: +-2 years in whole days with month ticks.
function setMode(name, force = false) {
  const m = MODES[name];
  if (!force && m === mode) return;
  mode = m; BACK_MIN = m.back; FWD_MIN = m.fwd; SPAN = BACK_MIN + FWD_MIN;
  el.dataset.mode = name;
  $.range.max = SPAN; $.range.step = m.step;
  $.nowmark.style.left = (BACK_MIN / SPAN * 100) + '%';
  $.range.setAttribute('aria-label', name === 'system' ? 'Date, two years either side of today' : 'Time offset from now');
  $.rates.innerHTML = m.speeds.map(([r, label, title]) => `<button class="sp mono" data-rate="${r}"${title ? ` title="${title}" aria-label="${title}"` : ''}>${label}</button>`).join('');
  $.speeds = [...el.querySelectorAll('[data-rate]')];
  marksKey = ''; lastSec = -1;
  if (!force) { computeMarks(); syncControls(); frame(); }
  else $.ticks.innerHTML = '';
  paintLabels();
}
const monthYear = ms => fmtLocal(ms, { month: 'short', year: 'numeric' });
// Absolute month labels in System mode, fixed hour labels otherwise.
function paintLabels() {
  if (mode === MODES.system) {
    $.lo.textContent = monthYear(Date.now() - BACK_MIN * 60000);
    $.hi.textContent = monthYear(Date.now() + FWD_MIN * 60000);
  } else { $.lo.textContent = mode.left; $.hi.textContent = mode.right; }
}
// Centre label: the offset ("+3h 20m") normally, the simulated month ("Mar 2027") in System mode.
function centreLabel(off) { return mode === MODES.system ? (Math.abs(off) < 720 ? 'Today' : monthYear(now())) : fmtOffset(off); }

const offsetMin = () => (now() - Date.now()) / 60000;

function fmtOffset(m) {
  const a = Math.abs(m);
  if (a < 1) return 'now';
  const sign = m < 0 ? '−' : '+';
  // Far jumps (System view: ±1 month / year) read better in days or years.
  if (a >= 365 * 1440) return sign + (a / (365.25 * 1440)).toFixed(a >= 3650 * 1440 ? 0 : 1) + ' yr';
  if (a >= 3 * 1440) return sign + Math.round(a / 1440) + ' days';
  const h = Math.floor(a / 60), mm = Math.round(a % 60);
  return (m < 0 ? '−' : '+') + (h ? h + 'h ' : '') + (mm || !h ? p2(mm) + 'm' : '').trim();
}

const placeName = () => (state.get('location')?.name || '').split(',')[0].trim();
let lastSec = -1;
// Repaint cadence: smooth while scrubbing or fast-forwarding, ~4 Hz in normal
// playback (the clock only shows seconds), and nothing while the tab is hidden.
let pending = false;
function schedule() {
  if (pending || document.hidden) return;
  pending = true;
  const go = () => { pending = false; frame(); };
  if (dragging || Math.abs(getRate()) > 1) requestAnimationFrame(go); else setTimeout(go, 250);
}
function frame() {
  const ms = now(), sec = Math.floor(ms / 1000);
  if (sec !== lastSec) {  // observer-local time, refreshed once per second
    lastSec = sec;
    const t = fmtLocal(ms, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (t !== lastClock) { lastClock = t; $.time.textContent = t; }
    const ds = fmtLocal(ms, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const z = tzLabel(ms), pl = placeName();
    if (ds + z + pl !== lastDate) {
      lastDate = ds + z + pl;
      $.zone.textContent = z;
      $.date.textContent = '';
      $.date.append(ds, Object.assign(document.createElement('span'), { className: 'tb-place', textContent: pl ? ' · ' + pl : '' }));
    }
  }
  const off = offsetMin();
  if (!dragging) {
    $.range.value = Math.max(0, Math.min(SPAN, Math.round(off + BACK_MIN)));
    paintRange();
    const lbl = centreLabel(off);
    if ($.offset.textContent !== lbl) $.offset.textContent = lbl;
  }
  schedule();
}

function paintRange() {
  const pct = $.range.value / SPAN * 100;
  $.range.style.setProperty('--p', pct + '%');
}

function syncControls() {
  const live = isLive(), r = getRate();
  $.live.hidden = !live;
  $.back.hidden = live;
  el.classList.toggle('is-live', live);
  el.classList.toggle('is-paused', r === 0);
  $.pause.innerHTML = r === 0 ? I.play : I.pause;
  $.pause.setAttribute('aria-label', r === 0 ? 'Play' : 'Pause');
  $.pause.classList.toggle('active', r === 0);
  $.rev.classList.toggle('active', r < 0);
  $.speeds.forEach(b => b.classList.toggle('active', Math.abs(r) === +b.dataset.rate));
}

// ---- sunset / midnight tick marks ----------------------------------------------
function computeMonthMarks() {
  const start = Date.now() - BACK_MIN * 60000, end = Date.now() + FWD_MIN * 60000;
  const key = 'm' + Math.floor(Date.now() / 86400000);
  if (key === marksKey) return;
  marksKey = key; paintLabels();
  const d0 = new Date(start), out = [];
  for (let y = d0.getUTCFullYear(), mo = d0.getUTCMonth() + 1; ; mo++) {
    const t = Date.UTC(y, mo, 1);
    if (t >= end) break;
    if (t < start) continue;
    const jan = new Date(t).getUTCMonth() === 0;
    out.push(`<i class="tick month${jan ? ' year' : ''}" style="left:${((t - start) / (end - start) * 100).toFixed(2)}%" title="${new Date(t).toLocaleDateString('en-US', jan ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' })}"></i>`);
  }
  $.ticks.innerHTML = out.join('');
}
function computeMarks() {
  if (mode === MODES.system) { computeMonthMarks(); return; }
  const loc = state.get('location');
  const start = Date.now() - BACK_MIN * 60000, end = Date.now() + FWD_MIN * 60000;
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${loc.tz || ''},${Math.floor(Date.now() / 1800000)}`;
  if (key === marksKey) return;
  marksKey = key; paintLabels();
  const out = [];
  // Local (observer) midnights: shift by the zone offset, floor to day, shift back.
  const DAY = 86400000;
  let t = start;
  for (let guard = 0; guard < 6; guard++) {
    const off = tzOffsetMinutes(t, loc) * 60000;
    const mid = Math.floor((t + off) / DAY) * DAY + DAY - off;
    if (mid >= end) break;
    out.push({ t: mid, type: 'midnight', label: '00:00' });
    t = mid + 3600000;
  }
  const A = window.Astronomy;
  if (A) {
    try {
      const obs = new A.Observer(loc.lat, loc.lon, loc.elevM || 0);
      for (const [dir, type] of [[-1, 'sunset'], [1, 'sunrise']]) {
        let from = new Date(start);
        for (let i = 0; i < 5; i++) {
          const r = A.SearchRiseSet(A.Body.Sun, obs, dir, from, 2);
          if (!r || r.date.getTime() > end) break;
          if (r.date.getTime() >= start) out.push({ t: r.date.getTime(), type, label: `${type === 'sunset' ? 'Sunset' : 'Sunrise'} ${fmtLocal(r.date.getTime(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}` });
          from = new Date(r.date.getTime() + 3600000);
        }
      }
    } catch (e) { /* polar day/night etc. — ignore */ }
  }
  marks = out;
  $.ticks.innerHTML = out.map(m => {
    const left = (m.t - start) / (end - start) * 100;
    return `<i class="tick ${m.type}" style="left:${left.toFixed(2)}%" title="${m.label}"></i>`;
  }).join('');
}

// ---- actions -----------------------------------------------------------------------
function setSpeed(v) {
  const dir = getRate() < 0 ? -1 : 1;
  prevRate = dir * v;
  setRate(prevRate);
}
function togglePause() {
  const r = getRate();
  if (r === 0) setRate(prevRate || 1);
  else { prevRate = r; setRate(0); }
}
function reverse() {
  const r = getRate();
  if (r === 0) { prevRate = -Math.abs(prevRate || 1); setRate(prevRate); }
  else { prevRate = -r; setRate(-r); }
}
function step(sign) { setTime(now() + sign * mode.stepKey * 60000); }

export function init() {
  el = document.getElementById('timebar');
  if (!el) return;
  build();
  // Publish the real rendered height as --timebar-h so panels/sheets stay clear of the bar.
  const publish = () => { const h = el.offsetHeight; if (h > 0) document.documentElement.style.setProperty('--timebar-h', h + 'px'); };
  publish();
  if (window.ResizeObserver) new ResizeObserver(publish).observe(el); else window.addEventListener('resize', publish);
  syncControls();
  paintRange();

  $.range.addEventListener('pointerdown', () => { dragging = true; });
  const end = () => { dragging = false; };
  window.addEventListener('pointerup', end);
  $.range.addEventListener('blur', end);
  $.range.addEventListener('input', () => {
    const v = +$.range.value;
    paintRange();
    $.offset.textContent = mode === MODES.system ? (v === BACK_MIN ? 'Today' : monthYear(Date.now() + (v - BACK_MIN) * 60000)) : fmtOffset(v - BACK_MIN);
    if (Math.abs(v - BACK_MIN) <= (mode.step > 1 ? 0 : 1) && getRate() === 1) goLive();
    else setTime(Date.now() + (v - BACK_MIN) * 60000);
  });
  $.back.addEventListener('click', goLive);
  $.rev.addEventListener('click', reverse);
  $.pause.addEventListener('click', togglePause);
  $.rates.addEventListener('click', e => { const b = e.target.closest('[data-rate]'); if (b) setSpeed(+b.dataset.rate); });
  state.on('view', v => setMode(v === 'system' ? 'system' : 'normal'));

  document.addEventListener('keydown', e => {
    if (!plainKey(e)) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); goLive(); }
  });

  state.on('clock', syncControls);
  state.on('location', () => { marksKey = ''; computeMarks(); });
  computeMarks();
  setInterval(computeMarks, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) frame(); });
  requestAnimationFrame(frame);
}
