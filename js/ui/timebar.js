// Time bar: sim clock, LIVE pill, scrubber (-12h..+48h), speed controls, keyboard shortcuts.
import * as state from '../state.js';
import { now, isLive, getRate, setTime, setRate, goLive } from '../clock.js';

const BACK_MIN = 12 * 60, FWD_MIN = 48 * 60, SPAN = BACK_MIN + FWD_MIN;
const SPEEDS = [1, 60, 600, 3600];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
      <div class="tb-time mono" id="tb-time">--:--:--</div>
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
      <div class="scrub-labels mono"><span>−12h</span><span id="tb-offset"></span><span>+48h</span></div>
    </div>
    <div class="tb-speed" role="group" aria-label="Playback speed">
      <button class="sp" id="tb-rev" title="Reverse" aria-label="Reverse time">${I.rev}</button>
      <button class="sp" id="tb-pause" title="Pause / play (Space)" aria-label="Pause">${I.pause}</button>
      ${SPEEDS.map(s => `<button class="sp mono" data-rate="${s}">${s}×</button>`).join('')}
    </div>`;
  for (const id of ['time', 'date', 'live', 'back', 'track', 'ticks', 'nowmark', 'range', 'offset', 'rev', 'pause']) $[id] = el.querySelector('#tb-' + id);
  $.speeds = [...el.querySelectorAll('[data-rate]')];
  $.nowmark.style.left = (BACK_MIN / SPAN * 100) + '%';
}

const offsetMin = () => (now() - Date.now()) / 60000;

function fmtOffset(m) {
  const a = Math.abs(m);
  if (a < 1) return 'now';
  const h = Math.floor(a / 60), mm = Math.round(a % 60);
  return (m < 0 ? '−' : '+') + (h ? h + 'h ' : '') + (mm || !h ? p2(mm) + 'm' : '').trim();
}

function frame() {
  const d = new Date(now());
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  if (t !== lastClock) { lastClock = t; $.time.textContent = t; }
  const ds = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (ds !== lastDate) { lastDate = ds; $.date.innerHTML = ds + '<span class="tb-tz"> · ' + tzLabel(d) + '</span>'; }
  const off = offsetMin();
  if (!dragging) {
    $.range.value = Math.max(0, Math.min(SPAN, Math.round(off + BACK_MIN)));
    paintRange();
    $.offset.textContent = fmtOffset(off);
  }
  requestAnimationFrame(frame);
}

function tzLabel(d) {
  const o = -d.getTimezoneOffset(), a = Math.abs(o);
  return 'UTC' + (o >= 0 ? '+' : '−') + Math.floor(a / 60) + (a % 60 ? ':' + p2(a % 60) : '');
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
function computeMarks() {
  const loc = state.get('location');
  const start = Date.now() - BACK_MIN * 60000, end = Date.now() + FWD_MIN * 60000;
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${Math.floor(Date.now() / 1800000)}`;
  if (key === marksKey) return;
  marksKey = key;
  const out = [];
  const d = new Date(start); d.setHours(24, 0, 0, 0);
  for (let t = d.getTime(); t < end; ) { out.push({ t, type: 'midnight', label: '00:00' }); const n = new Date(t); n.setDate(n.getDate() + 1); n.setHours(0, 0, 0, 0); t = n.getTime(); }
  const A = window.Astronomy;
  if (A) {
    try {
      const obs = new A.Observer(loc.lat, loc.lon, loc.elevM || 0);
      for (const [dir, type] of [[-1, 'sunset'], [1, 'sunrise']]) {
        let from = new Date(start);
        for (let i = 0; i < 5; i++) {
          const r = A.SearchRiseSet(A.Body.Sun, obs, dir, from, 2);
          if (!r || r.date.getTime() > end) break;
          if (r.date.getTime() >= start) out.push({ t: r.date.getTime(), type, label: `${type === 'sunset' ? 'Sunset' : 'Sunrise'} ${p2(r.date.getHours())}:${p2(r.date.getMinutes())}` });
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
function step(minutes) { setTime(now() + minutes * 60000); }

export function init() {
  el = document.getElementById('timebar');
  if (!el) return;
  build();
  syncControls();
  paintRange();

  $.range.addEventListener('pointerdown', () => { dragging = true; });
  const end = () => { dragging = false; };
  window.addEventListener('pointerup', end);
  $.range.addEventListener('blur', end);
  $.range.addEventListener('input', () => {
    const v = +$.range.value;
    paintRange();
    $.offset.textContent = fmtOffset(v - BACK_MIN);
    if (Math.abs(v - BACK_MIN) <= 1 && getRate() === 1) goLive();
    else setTime(Date.now() + (v - BACK_MIN) * 60000);
  });
  $.back.addEventListener('click', goLive);
  $.rev.addEventListener('click', reverse);
  $.pause.addEventListener('click', togglePause);
  $.speeds.forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.rate)));

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
    if (document.body.classList.contains('modal-open')) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(10); }
    else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); goLive(); }
  });

  state.on('clock', syncControls);
  state.on('location', () => { marksKey = ''; computeMarks(); });
  computeMarks();
  setInterval(computeMarks, 60000);
  requestAnimationFrame(frame);
}
