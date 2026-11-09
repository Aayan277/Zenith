// Launches tab of the left panel: next-launch hero card, upcoming list, recent launches.
import * as state from '../state.js';
import * as clock from '../clock.js';
import { store, onLaunches, loadLaunches, pending } from './data.js';
import { esc, statusOf, parts, p2, short, fmtLocalFull, fmtUtc, fmtDay, fmtClock, hasClock, precisionNote, isDone, fmtAgo, ICON } from './util.js';
import { isArmed, toggleReminder, LEAD_MIN } from './reminders.js';
import { showPad, openWebcast } from './detail.js';
import { dayKey } from '../tonight/util.js';
import { tzLabel } from '../util/time.js';

let el, timer = 0, shown = false, showAll = false, sig = '';
const MAX = 10;

const skel = (n, w = 90) => Array.from({ length: n }, (_, i) => `<div class="tn-skel" style="width:${w - i * 14}%"></div>`).join('');

function relDay(ms, now) {
  const a = dayKey(ms), b = dayKey(now);
  if (a === b) return 'Today';
  if (a === dayKey(now + 86400000)) return 'Tomorrow';
  return fmtDay(ms);
}
const pill = l => { const s = statusOf(l); return `<span class="lc-pill" style="--c:${s.color}" title="${esc(l.status.name)}">${esc(s.label)}</span>`; };

function heroHtml(l, now) {
  const armed = isArmed(l.id), clk = hasClock(l);
  const { sign, d, h, m, s } = parts(l.net - now);
  const cell = (n, u) => `<div class="lc-cell"><b class="mono" data-cd="${u}">${p2(n)}</b><span>${u}</span></div>`;
  const place = [l.pad, l.location].filter(Boolean).join(' · ');
  return `<article class="lc-hero" data-id="${esc(l.id)}" style="--c:${statusOf(l).color}">
    <div class="lc-hero-img">${l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
    <div class="lc-hero-body">
      <div class="lc-hero-top"><span class="eyebrow">Next launch</span>${pill(l)}</div>
      <h3 class="lc-title"><button type="button" class="lc-open" data-open="${esc(l.id)}">${esc(l.mission)}</button></h3>
      <p class="lc-sub">${esc(l.rocketFull || l.rocket)}${l.provider ? ' · ' + esc(l.provider) : ''}</p>
      <div class="lc-cd" role="timer" aria-label="Time to launch" data-sign="${sign}">
        <span class="lc-t">${sign < 0 ? 'T−' : 'T+'}</span>${cell(d, 'days')}${cell(h, 'hrs')}${cell(m, 'min')}${cell(s, 'sec')}
      </div>
      <div class="lc-when mono">${l.net == null ? 'Date TBD' : clk ? `${esc(fmtLocalFull(l.net))}${/^(UTC|GMT)$/.test(tzLabel(l.net)) ? '' : ` <i>·</i> ${esc(fmtUtc(l.net, false))}`}` : `${esc(fmtDay(l.net))} <i>·</i> ${esc(precisionNote(l))}`}</div>
      ${place ? `<div class="lc-pad">${ICON.pin}<span>${esc(place)}</span></div>` : ''}
      <div class="lc-btns">
        ${l.webcast ? `<button type="button" class="btn primary" data-act="watch" data-id="${esc(l.id)}">${ICON.play}<span>${l.live ? 'Watch live' : 'Watch'}</span></button>` : ''}
        <button type="button" class="btn" data-act="pad" data-id="${esc(l.id)}">${ICON.pin}<span>Show pad</span></button>
        <button type="button" class="btn lc-bell${armed ? ' on' : ''}" data-act="bell" data-id="${esc(l.id)}" aria-pressed="${armed}" aria-label="${armed ? 'Remove reminder' : `Remind me ${LEAD_MIN} minutes before launch`}" title="${armed ? 'Reminder on (tap to remove)' : `Notify me at T−${LEAD_MIN} min`}">${armed ? ICON.bellOn : ICON.bell}</button>
      </div>
    </div>
  </article>`;
}

function rowHtml(l, now, selId) {
  const st = statusOf(l), clk = hasClock(l), armed = isArmed(l.id);
  const dt = l.net - now;
  return `<button type="button" class="lc-row${selId === l.id ? ' sel' : ''}" data-open="${esc(l.id)}" aria-label="${esc(l.mission)}, ${esc(l.rocket)}, ${esc(st.label)}">
    <span class="lc-rd"><span class="tn-day">${l.net == null ? 'TBD' : relDay(l.net, now)}</span><span class="mono">${l.net != null && clk ? fmtClock(l.net) : 'TBD'}</span></span>
    <span class="lc-rn"><b>${esc(l.mission)}</b><span>${esc(l.rocket)}${l.provider ? ' · ' + esc(l.provider) : ''}</span></span>
    <span class="lc-re"><span class="mono" data-short="${l.net ?? ''}">${l.net == null ? '—' : dt > 0 ? short(dt) : 'now'}</span><span class="lc-st"><i style="background:${st.color}"></i>${esc(st.label)}${armed ? `<em class="lc-bellmini" title="Reminder on">${ICON.bellOn}</em>` : ''}</span></span>
  </button>`;
}
function recentHtml(l, now) {
  const st = statusOf(l);
  return `<button type="button" class="lc-row lc-recent" data-open="${esc(l.id)}">
    <span class="lc-rd"><span class="tn-day">${l.net ? relDay(l.net, now) : ''}</span><span class="mono">${l.net ? fmtClock(l.net) : ''}</span></span>
    <span class="lc-rn"><b>${esc(l.mission)}</b><span>${esc(l.rocket)}${l.provider ? ' · ' + esc(l.provider) : ''}</span></span>
    <span class="lc-re"><span class="lc-st"><i style="background:${st.color}"></i>${esc(st.label)}</span></span>
  </button>`;
}

function render() {
  if (!el) return;
  const now = clock.now(), selId = state.get('selection')?.kind === 'launch' ? state.get('selection').id : null;
  let h;
  if (!store.loaded) {
    h = store.error
      ? `<div class="tn-card"><div class="tn-err"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg><span>Could not load the launch schedule.</span></div><button type="button" class="tn-link" data-act="retry">Try again</button></div>`
      : `<div class="tn-card lc-skel"><div class="tn-skel" style="height:96px;width:100%"></div>${skel(3)}</div><div class="tn-card">${skel(4)}</div>`;
  } else {
    const list = pending(now), hero = list[0], rest = list.slice(1);
    const vis = showAll ? rest : rest.slice(0, MAX);
    const recents = store.previous.filter(l => l.net != null).sort((a, b) => b.net - a.net).slice(0, 5);
    const src = store.source === 'live' ? `Updated ${fmtAgo(store.updatedAt)}` : store.source === 'cache' ? `Saved ${fmtAgo(store.updatedAt)}` : `Snapshot from ${fmtAgo(store.updatedAt)}`;
    h = `${store.note ? `<p class="lc-note">${esc(store.note)}</p>` : ''}
      ${hero ? heroHtml(hero, now) : `<div class="tn-card"><p class="tn-empty">No upcoming launches in the schedule right now.</p></div>`}
      ${rest.length ? `<section class="tn-card lc-list" aria-label="Upcoming launches">
        <div class="tn-card-head"><span class="eyebrow">Upcoming</span><span class="tn-right">${rest.length} scheduled · your time</span></div>
        ${vis.map(l => rowHtml(l, now, selId)).join('')}
        ${rest.length > MAX ? `<button type="button" class="tn-link tn-more" data-act="more">${showAll ? 'Show fewer' : `Show all ${rest.length}`}</button>` : ''}
      </section>` : ''}
      ${recents.length ? `<section class="tn-card lc-list" aria-label="Recent launches">
        <div class="tn-card-head"><span class="eyebrow">Recent</span></div>${recents.map(l => recentHtml(l, now)).join('')}
      </section>` : ''}
      <div class="lc-foot"><span>${esc(src)}${store.loading ? ' · refreshing…' : ''}</span>
        <button type="button" class="lc-refresh" data-act="refresh" aria-label="Refresh launches" ${store.loading ? 'disabled' : ''}>${ICON.refresh}</button></div>
      <p class="tn-foot">Data: Launch Library 2 · The Space Devs<br>Reminders only work while Zenith is open in a tab.</p>`;
  }
  const key = h + selId;
  if (key === sig) return;
  sig = key;
  // Keep scroll + focus through re-renders.
  const active = document.activeElement, focusId = el.contains(active) ? (active.dataset.open || active.dataset.act) : null;
  const top = el.scrollTop;
  el.innerHTML = h;
  el.scrollTop = top;
  if (focusId) el.querySelector(`[data-open="${CSS.escape(focusId)}"],[data-act="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
}

function tick() {
  if (!el || !shown) return;
  const now = clock.now();
  const hero = el.querySelector('.lc-hero');
  if (hero) {
    const l = pending(now)[0];
    if (!l || l.id !== hero.dataset.id) { sig = ''; render(); return; }
    const { sign, d, h, m, s } = parts(l.net - now);
    const vals = { days: d, hrs: h, min: m, sec: s };
    for (const b of hero.querySelectorAll('[data-cd]')) { const t = p2(vals[b.dataset.cd]); if (b.textContent !== t) b.textContent = t; }
    const cd = hero.querySelector('.lc-cd');
    if (+cd.dataset.sign !== sign) { cd.dataset.sign = sign; cd.querySelector('.lc-t').textContent = sign < 0 ? 'T−' : 'T+'; }
  }
  for (const n of el.querySelectorAll('[data-short]')) {
    const net = +n.dataset.short; if (!net) continue;
    const t = net - now > 0 ? short(net - now) : 'now'; if (n.textContent !== t) n.textContent = t;
  }
}

function openLaunch(id) {
  const l = [...store.upcoming, ...store.previous].find(x => x.id === id); if (!l) return;
  state.set('selection', { kind: 'launch', id });
  showPad(l);
}

export function mount(pane) {
  el = pane; el.classList.add('lc-pane');
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act],[data-open]');
    if (!b) { const hero = e.target.closest('.lc-hero'); if (hero && !e.target.closest('a,button')) openLaunch(hero.dataset.id); return; }
    const act = b.dataset.act, id = b.dataset.id || b.dataset.open;
    const l = id && [...store.upcoming, ...store.previous].find(x => x.id === id);
    if (act === 'watch' && l) openWebcast(l);
    else if (act === 'pad' && l) { state.set('selection', { kind: 'launch', id }); showPad(l); }
    else if (act === 'bell' && l) toggleReminder(l);
    else if (act === 'more') { showAll = !showAll; render(); }
    else if (act === 'refresh' || act === 'retry') loadLaunches({ force: true });
    else if (b.dataset.open) openLaunch(b.dataset.open);
  });
  onLaunches(() => { sig = ''; render(); });
  state.on('selection', () => shown && render());
  state.on('launches:notify', () => { sig = ''; render(); });
  state.on('location', () => { sig = ''; shown && render(); });
  render();
}
export function onShow() {
  shown = true; render();
  if (!store.loaded || !store.updatedAt || Date.now() - store.updatedAt > 30 * 60e3) loadLaunches();
  clearInterval(timer); timer = setInterval(tick, 1000);
}
export function onHide() { shown = false; clearInterval(timer); timer = 0; }
