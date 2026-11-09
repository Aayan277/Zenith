// Frame governor + visibility helpers shared by the globe and sky views.
//
//   const loop = createLoop(cb, { interval })
//     cb(ts, dtSec)      called when a frame should be drawn
//     interval()         ms between frames while idle; 0 = every display frame (busy)
//   loop.start() / loop.stop() / loop.wake(ms)   wake = full rate for `ms`, now
//
// Idle frames are scheduled with a timer that arms the next rAF, so the browser does not
// wake the main thread / compositor 60 times a second for nothing. The loop never runs while
// the document is hidden (the owner restarts it from onVisibility).

export const isHidden = () => typeof document !== 'undefined' && document.hidden;

const visSubs = new Set();
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { const h = document.hidden; for (const fn of [...visSubs]) { try { fn(h); } catch (e) { console.error(e); } } });
}
/** fn(hidden:boolean) on every visibility change. Returns an unsubscribe function. */
export function onVisibility(fn) { visSubs.add(fn); return () => visSubs.delete(fn); }

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reducedMotion = () => !!(mq && mq.matches);

/** requestIdleCallback with a timer fallback. */
export function idle(fn, timeout = 1500) {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout });
  return setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 60);
}

export function createLoop(cb, { interval = () => 0 } = {}) {
  let raf = 0, timer = 0, running = false, lastRender = 0, wakeUntil = 0;
  function arm() {
    if (!running || raf || timer) return;
    const now = performance.now();
    const iv = now < wakeUntil ? 0 : interval();
    if (iv > 0) {
      const wait = iv - (now - lastRender) - 8;
      if (wait > 4) { timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(tick); }, wait); return; }
    }
    raf = requestAnimationFrame(tick);
  }
  function tick(ts) {
    raf = 0;
    if (!running) return;
    if (isHidden()) { running = false; return; }
    const now = performance.now();
    const dt = Math.min(0.1, lastRender ? (now - lastRender) / 1000 : 0.016);
    lastRender = now;
    try { cb(ts, dt); } catch (e) { console.error('[loop]', e); }
    arm();
  }
  return {
    get running() { return running; },
    start() { if (running) return; running = true; lastRender = 0; arm(); },
    stop() { running = false; cancelAnimationFrame(raf); clearTimeout(timer); raf = 0; timer = 0; },
    wake(ms = 400) {
      wakeUntil = Math.max(wakeUntil, performance.now() + ms);
      if (running && timer) { clearTimeout(timer); timer = 0; arm(); }
    },
  };
}

/**
 * Adaptive quality: feed it the timestamp of every rendered frame (ts) and whether the loop is in full-rate
 * (busy) mode. Only intervals between two consecutive busy frames count (idle frames are slow on purpose).
 * Sustained mean > ~21 ms steps `tier` down (0 = best); a long cooldown later it tries one step back up, and a
 * failed attempt doubles the cooldown. `apply(tier)` must re-configure the renderer.
 */
export class QualityGovernor {
  constructor(tiers, apply, { pinned = false, name = 'view' } = {}) {
    this.tiers = tiers; this.apply = apply; this.pinned = pinned; this.name = name;
    this.tier = 0; this.buf = new Float32Array(40); this.n = 0; this.i = 0;
    this.prevBusy = false; this.prevTs = 0; this.grace = 0; this.downAt = 0; this.cool = 20000;
  }
  reset() { this.prevTs = 0; this.prevBusy = false; }
  sample(ts, busyNow) {
    const dtMs = ts - this.prevTs, now = performance.now();
    const ok = this.prevBusy && busyNow && this.prevTs > 0 && now > this.grace;
    this.prevTs = ts; this.prevBusy = busyNow;
    if (!ok || this.pinned || dtMs > 1500) return;
    this.buf[this.i] = Math.min(dtMs, 120); this.i = (this.i + 1) % this.buf.length; if (this.n < this.buf.length) this.n++;
    if (this.n < 8) return;
    let sum = 0; for (let k = 0; k < this.n; k++) sum += this.buf[k];
    const mean = sum / this.n;
    if ((mean > 45) || (mean > 21 && this.n >= this.buf.length)) {
      if (this.tier < this.tiers - 1) {
        this.tier++;
        if (this.downAt && now - this.downAt < 90000) this.cool = Math.min(300000, this.cool * 2);
        this.downAt = now; this._changed();
      } else this.n = 0;
    } else if (this.n >= this.buf.length && mean < 17.8 && this.tier > 0 && now - this.downAt > this.cool) {
      this.tier--; this.downAt = now; this._changed();
    }
  }
  _changed() {
    this.n = 0; this.i = 0; this.grace = performance.now() + 700;
    console.info(`[${this.name}] quality tier ${this.tier}`);
    this.apply(this.tier);
  }
}
