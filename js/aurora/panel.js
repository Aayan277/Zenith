// Aurora tab of the left panel: verdict, chance at your location, Kp gauge + solar wind, 3-day Kp forecast with your
// night hours shaded, NOAA alerts in plain English, and "Alert me".
import * as state from '../state.js';
import * as clock from '../clock.js';
import { aur, loadSmall, loadOvation, onAurora } from './data.js';
import { assessNow, alertList } from './assess.js';
import { KP_COLORS, kpColor, gScale, G_NAME, kpAt } from './model.js';
import { PRESETS, getPrefs, setPrefs, enableAlerts } from './alerts.js';
import { isAuroraLayerOn, setAuroraLayerOn } from './layer.js';
import { bodyAlt } from '../tonight/astro.js';
import { fmtLocal, tzLabel } from '../util/time.js';
import { esc, skeleton, fmtTime } from '../tonight/util.js';
import { notifyPermission, askPermission } from '../ui/notify.js';
import { sunCardHtml, adoptSunThumb, warmSunCard, onSun, onSunCardReady, openSunDashboard } from '../sun/card.js'; // SUN: "Sun now" card

let el, shown = false, timer = 0, sig = '', pendingRender = 0;
const H = 3600e3;
const LVL = { good: 'Good chance', possible: 'Possible', unlikely: 'Unlikely', none: 'Not visible', unknown: 'Checking' };
const ERR = msg => `<div class="tn-err"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg><span>${esc(msg)}</span></div>`;
const head = (title, right = '') => `<div class="tn-card-head"><span class="eyebrow">${title}</span>${right ? `<span class="tn-right">${right}</span>` : ''}</div>`;
const ago = ms => { const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

// ---- Kp gauge ------------------------------------------------------------------------------------------------------
function arc(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.cos(a * Math.PI / 180), cy - r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function gauge(kp) {
  const cx = 74, cy = 70, r = 56;
  let segs = '';
  for (let i = 0; i < 9; i++) {
    const a0 = 180 - i * 20 - 1.6, a1 = 180 - (i + 1) * 20 + 1.6;
    const f = Math.max(0, Math.min(1, kp - i)), op = f >= 1 ? 1 : f > 0 ? 0.35 + 0.65 * f : 0.15;
    const c = KP_COLORS[i + 1];
    segs += `<path d="${arc(cx, cy, r, a0, a1)}" stroke="${c}" stroke-opacity="${op.toFixed(2)}"${f > 0 ? ` style="filter:drop-shadow(0 0 3px ${c})"` : ''}/>`;
  }
  const na = 180 - Math.min(9, Math.max(0, kp)) / 9 * 180, nr = r - 14;
  const nx = cx + nr * Math.cos(na * Math.PI / 180), ny = cy - nr * Math.sin(na * Math.PI / 180);
  const g = gScale(kp), col = kpColor(kp);
  return `<svg class="au-gauge" viewBox="0 0 148 92" role="img" aria-label="Kp index ${kp.toFixed(1)} of 9${g ? ', G' + g + ' storm' : ''}">
    <g fill="none" stroke-width="9" stroke-linecap="butt">${segs}</g>
    <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="3.2" fill="#fff" style="filter:drop-shadow(0 0 4px ${col})"/>
    <text x="${cx}" y="${cy - 9}" text-anchor="middle" class="au-gv" fill="${col}">${Number.isInteger(kp) ? kp : kp.toFixed(1)}</text>
    <text x="${cx}" y="${cy + 6}" text-anchor="middle" class="au-gl">Kp${g ? ' · G' + g : ''}</text>
    <text x="${cx - r}" y="${cy + 15}" text-anchor="middle" class="au-gt">0</text><text x="${cx + r}" y="${cy + 15}" text-anchor="middle" class="au-gt">9</text>
  </svg>`;
}

// ---- forecast chart ---------------------------------------------------------------------------------------------------
let nightMemo = { key: '', hours: [] };
function nightHours(t0, n, loc) {
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)},${t0}`;
  if (nightMemo.key === key) return nightMemo.hours;
  const hours = [];
  for (let i = 0; i < n; i++) { let a = 0; try { a = bodyAlt('Sun', t0 + i * H + H / 2, loc); } catch {} hours.push(a < -9); }
  nightMemo = { key, hours }; return hours;
}
function chart(now, loc) {
  const rows = aur.kp || [];
  const t0 = Math.floor(now / (3 * H)) * 3 * H, lastEnd = rows.length ? rows[rows.length - 1].t + 3 * H : t0 + 72 * H, T = Math.max(12 * H, Math.min(72 * H, lastEnd - t0)), W = 300, Hh = 118, padB = 18, padT = 6, ph = Hh - padB - padT;
  const x = t => (t - t0) / T * W, y = kp => padT + ph * (1 - Math.min(9, kp) / 9);
  const vis = rows.filter(r => r.t + 3 * H > t0 && r.t < t0 + T);
  if (!vis.length) return ERR('No forecast hours cover now.');
  let s = `<svg viewBox="0 0 ${W} ${Hh}" class="au-chart" role="img" aria-label="Kp forecast for the next 3 days. Shaded bands are dark hours at your location.">`;
  const nh = nightHours(Math.floor(t0 / H) * H, 75, loc), base = Math.floor(t0 / H) * H;
  let run = null;
  nh.forEach((dark, i) => {
    const xa = x(base + i * H), xb = x(base + (i + 1) * H);
    if (dark) run = run ? { a: run.a, b: xb } : { a: xa, b: xb };
    if ((!dark || i === nh.length - 1) && run) { const a = Math.max(0, run.a), b = Math.min(W, run.b); if (b > a) s += `<rect x="${a.toFixed(1)}" y="${padT}" width="${(b - a).toFixed(1)}" height="${ph}" class="night"/>`; run = null; }
  });
  s += `<line x1="0" x2="${W}" y1="${y(5)}" y2="${y(5)}" class="g5"/><text x="${W - 2}" y="${y(5) - 3}" text-anchor="end" class="tx">G1</text>`;
  s += `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="g0"/>`;
  for (const r of vis) {
    const xa = Math.max(0, x(r.t)), xb = Math.min(W, x(r.t + 3 * H)), c = kpColor(r.kp), h = Math.max(1.5, y(0) - y(r.kp));
    const cur = r.t <= now && now < r.t + 3 * H, label = `${fmtLocal(r.t, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}–${fmtTime(r.t + 3 * H)}: Kp ${r.kp.toFixed(1)}${r.kp >= 5 ? ' (G' + gScale(r.kp) + ')' : ''} · ${r.obs}`;
    s += `<rect x="${(xa + 0.8).toFixed(1)}" y="${(y(0) - h).toFixed(1)}" width="${Math.max(1, xb - xa - 1.6).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${c}" fill-opacity="${r.obs === 'predicted' ? 0.78 : 1}"${cur ? ` stroke="#fff" stroke-width="1.2"` : ''}><title>${esc(label)}</title></rect>`;
  }
  // Day ticks at the observer's local midnight.
  for (let i = 0; i <= 74; i++) {
    const t = base + i * H;
    if (t < t0 || t > t0 + T) continue;
    if (fmtLocal(t, { hour: '2-digit', hourCycle: 'h23' }) === '00' && t > t0) s += `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${padT}" y2="${y(0) + 3}" class="day"/>${x(t) > 40 ? `<text x="${(x(t) + 3).toFixed(1)}" y="${Hh - 4}" class="tx">${fmtLocal(t + 6 * H, { weekday: 'short' })}</text>` : ''}`;
  }
  s += `<text x="2" y="${Hh - 4}" class="tx">now</text></svg>`;
  return s;
}

// ---- sections ---------------------------------------------------------------------------------------------------------
function heroCard(a, now) {
  const v = a.verdict, ch = a.chance, lvl = v.level;
  const pill = LVL[lvl] || '';
  const chance = ch && a.live
    ? `<div class="au-chance"><div><div class="au-big mono">${Math.round(ch.here)}<small>%</small></div><div class="au-cl">overhead now</div></div>
       <div><div class="au-big mono sm">${Math.round(ch.horizon)}<small>%</small></div><div class="au-cl">on the ${state.get('location').lat >= 0 ? 'northern' : 'southern'} horizon</div></div>
       <div class="au-dk">${a.dark ? 'Dark sky' : a.sunAlt > -0.8 ? 'Daylight' : 'Twilight'}</div></div>`
    : aur.loading.ovation ? `<div class="au-chance">${'<div class="tn-skel" style="width:60px;height:34px;margin:0"></div>'.repeat(2)}</div>`
    : !a.live ? `<p class="au-small">Live chance is hidden while the clock is away from now. Showing the Kp forecast instead.</p>`
    : aur.errors.ovation ? `<p class="au-small">The live aurora map could not be loaded. <button type="button" class="tn-link" data-act="retry-ova">Retry</button></p>` : '';
  const on = isAuroraLayerOn();
  return `<section class="tn-card au-hero" data-lvl="${lvl}" aria-label="Aurora verdict">
    <div class="au-hero-top"><span class="eyebrow">Aurora at ${esc(state.get('location').name.split(',')[0])}</span><span class="au-pill">${pill}</span></div>
    <h3 class="au-verdict">${esc(v.title)}</h3>
    ${v.detail ? `<p class="au-detail">${esc(v.detail)}</p>` : ''}
    ${chance}
    <button type="button" class="au-sw" role="switch" aria-checked="${on}" data-act="globe"><i></i><span>Show oval on globe</span></button>
  </section>`;
}

function kpCard(now) {
  const cur = aur.kp ? kpAt(aur.kp, now) : null, w = aur.wind;
  if (!aur.kp) return `<section class="tn-card">${head('Geomagnetic activity')}${aur.errors.kp ? ERR('Kp data is unavailable right now.') : skeleton(3)}</section>`;
  if (!cur) return `<section class="tn-card">${head('Geomagnetic activity')}${ERR('No Kp reading covers this time.')}</section>`;
  const g = gScale(cur.kp);
  const bz = w && Number.isFinite(w.bz) ? w.bz : null, sp = w && Number.isFinite(w.speed) ? w.speed : null;
  const bzNote = bz == null ? '' : bz <= -5 ? 'southward: favorable' : bz < 0 ? 'slightly southward' : 'northward: quiet';
  const bzCol = bz == null ? '' : bz <= -5 ? 'var(--good)' : bz < 0 ? 'var(--warn)' : 'var(--text-dim)';
  return `<section class="tn-card" aria-label="Geomagnetic activity">${head('Geomagnetic activity', `3-hour Kp · ${cur.obs}`)}
    <div class="au-kprow">${gauge(cur.kp)}
      <div class="au-wind">
        <div class="au-g">${g ? `G${g} · ${G_NAME[g]} storm` : cur.kp >= 4 ? 'Active' : 'Quiet to unsettled'}</div>
        <dl>
          <div><dt>Solar wind</dt><dd class="mono">${sp == null ? '—' : Math.round(sp)}<small> km/s</small></dd></div>
          <div><dt>Bz</dt><dd class="mono" style="color:${bzCol}">${bz == null ? '—' : (bz > 0 ? '+' : bz < 0 ? '−' : '') + Math.abs(bz)}<small> nT</small></dd></div>
        </dl>
        ${bzNote ? `<div class="au-bzn">${bzNote}</div>` : ''}
      </div>
    </div></section>`;
}

function forecastCard(now, loc) {
  if (!aur.kp) return `<section class="tn-card">${head('3-day Kp forecast')}${aur.errors.kp ? ERR('Forecast is unavailable right now.') : '<div class="tn-skel" style="height:100px;width:100%"></div>'}</section>`;
  return `<section class="tn-card" aria-label="3-day Kp forecast">${head('3-day Kp forecast', `Times in ${tzLabel(now)}`)}${chart(now, loc)}
    <div class="tn-legend"><span><i class="sw ni"></i>Dark for you</span><span><i class="sw" style="background:${KP_COLORS[2]}"></i>Kp &lt; 4</span><span><i class="sw" style="background:${KP_COLORS[5]}"></i>G1+ (Kp ≥ 5)</span></div></section>`;
}

function alertsCard(now) {
  if (!aur.alerts) return `<section class="tn-card">${head('NOAA alerts')}${aur.errors.alerts ? ERR('NOAA alerts are unavailable right now.') : skeleton(3)}</section>`;
  const list = alertList(aur, Date.now());
  return `<section class="tn-card" aria-label="NOAA alerts">${head('NOAA alerts', 'SWPC')}
    ${list.length ? `<ul class="au-alerts">${list.map(a => `<li class="${a.active ? 'live' : ''}" style="--c:${a.g ? kpColor(4 + a.g) : a.kind === 'watch' ? 'var(--warn)' : 'var(--accent)'}">
        <div class="au-ah"><b>${esc(a.title)}</b><span class="mono">${a.active ? 'active' : 'past'} · ${ago(a.issued)}</span></div><p>${esc(a.text)}</p></li>`).join('')}</ul>`
      : `<p class="tn-empty">No geomagnetic watches or warnings right now.</p>`}</section>`;
}

function alertMeCard() {
  const p = getPrefs(), perm = notifyPermission();
  return `<section class="tn-card au-me" aria-label="Aurora alerts">
    <div class="tn-card-head"><span class="eyebrow">Alert me</span>
      <button type="button" class="au-sw sm" role="switch" aria-checked="${p.on}" data-act="alerts" aria-label="Alert me about aurora"><i></i></button></div>
    <div class="au-presets" role="radiogroup" aria-label="Alert threshold">${PRESETS.map(x => `<button type="button" role="radio" aria-checked="${p.preset === x.id}" class="au-preset" data-preset="${x.id}" title="${esc(x.hint)}">${esc(x.label)}</button>`).join('')}</div>
    <p class="au-small">${p.on ? 'Checking every 15 minutes while this tab is visible. ' : ''}Alerts only work while Zenith is open in a tab: there is no push server, so nothing reaches you once it is closed.</p>
    ${p.on && perm === 'default' ? `<button type="button" class="btn au-perm" data-act="perm">Allow browser notifications</button>` : ''}
    ${p.on && perm === 'denied' ? `<p class="au-small warn">Browser notifications are blocked for this site, so you will only see an in-app toast.</p>` : ''}
  </section>`;
}

function render() {
  if (!el) return;
  const now = clock.now(), loc = state.get('location');
  let h = '';
  try {
    if (!aur.kp && !aur.ovation && !aur.errors.kp && !aur.errors.ovation) h = `<section class="tn-card">${head('Aurora')}${skeleton(4)}</section><section class="tn-card">${skeleton(3)}</section>`;
    else {
      const a = assessNow(aur, loc, now);
      h = heroCard(a, now) + sunCardHtml() + kpCard(now) + forecastCard(now, loc) + alertsCard(now) + alertMeCard() +
        `<p class="tn-foot">Data: NOAA Space Weather Prediction Center${aur.updatedAt ? ` · updated ${ago(aur.updatedAt)}` : ''}${aur.ovation ? `<br>Aurora map: OVATION, forecast for ${fmtTime(aur.ovation.forecast)} ${tzLabel(aur.ovation.forecast)}` : ''}</p>`;
    }
  } catch (e) { console.error('[aurora panel]', e); h = `<section class="tn-card">${ERR('Something went wrong showing aurora data.')}</section>`; }
  if (h === sig) return;
  sig = h;
  const active = document.activeElement, fid = el.contains(active) ? (active.dataset.act || active.dataset.preset) : null, top = el.scrollTop;
  el.innerHTML = h; el.scrollTop = top; adoptSunThumb(el); // SUN
  if (fid) el.querySelector(`[data-act="${CSS.escape(fid)}"],[data-preset="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
}
const later = () => { clearTimeout(pendingRender); pendingRender = setTimeout(() => shown && render(), 250); };

export function mount(pane) {
  el = pane; el.classList.add('au-pane');
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-act],[data-preset]'); if (!b) return;
    const act = b.dataset.act;
    if (b.dataset.preset) { setPrefs({ preset: b.dataset.preset }); if (b.dataset.preset === 'local') loadOvation(); }
    else if (act === 'globe') { setAuroraLayerOn(!isAuroraLayerOn()); }
    else if (act === 'alerts') { await enableAlerts(!getPrefs().on); if (getPrefs().preset === 'local') loadOvation(); }
    else if (act === 'perm') { await askPermission(); }
    else if (act === 'retry-ova') loadOvation({ force: true });
    else if (act === 'sun') openSunDashboard(); // SUN
    sig = ''; render();
  });
  onAurora(later); onSun(later); onSunCardReady(later); // SUN
  for (const k of ['location', 'clock', 'aurora:globe', 'aurora:alerts']) state.on(k, later);
  render();
}
export function onShow() {
  shown = true; render();
  loadSmall(); loadOvation(); warmSunCard(); // SUN
  clearInterval(timer); timer = setInterval(() => { sig = ''; render(); }, 30000);
}
export function onHide() { shown = false; clearInterval(timer); timer = 0; }
