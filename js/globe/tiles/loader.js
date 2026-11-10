// Tile download + decode: priority queue, bounded concurrency, stale requests cancelled with AbortController, off-main-thread
// decode through createImageBitmap (imageOrientation 'flipY', so the bitmap can be uploaded as-is).
//
//   const loader = new TileLoader({ concurrency: 6, urlOf, onReady(item, decoded), onFail(item, err, permanent) })
//   loader.want(key, priority, nowMs, tile, kind)   lower priority number loads first; urlOf(tile, kind) builds the URL
//   loader.prune(nowMs, graceMs)         drops queued items / aborts in-flight ones that nobody asked for in the last graceMs
//   loader.abortAll()                    view hidden: stop everything
//   loader.stats                         counters for measurement

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return { img: await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }), flipped: true };
    } catch { /* old engines: fall back to an <img> (main thread decode) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const im = new Image(); im.decoding = 'async'; im.src = url;
    await im.decode();
    return { img: im, flipped: false };
  } finally { URL.revokeObjectURL(url); }
}

export class TileLoader {
  constructor({ concurrency = 6, urlOf, onReady, onFail }) {
    this.max = concurrency; this.urlOf = urlOf; this.onReady = onReady; this.onFail = onFail;
    this.entries = new Map();            // key -> { item, prio, wanted, ctrl|null }
    this.inflight = 0;
    this.stats = { requested: 0, done: 0, failed: 0, aborted: 0, bytes: 0, maxInflight: 0, byHost: {} };
  }
  has(key) { return this.entries.has(key); }
  /** (Re)request a tile image; the item is only built the first time. */
  want(key, prio, now, tile, kind) {
    const e = this.entries.get(key);
    if (e) { e.prio = prio; e.wanted = now; return; }
    this.entries.set(key, { item: { key, url: this.urlOf(tile, kind), tile, kind }, prio, wanted: now, ctrl: null });
  }
  prune(now, graceMs) {
    for (const [key, e] of this.entries) {
      if (now - e.wanted <= graceMs) continue;
      if (e.ctrl) { e.aborted = true; e.ctrl.abort(); this.stats.aborted++; } else this.entries.delete(key);
    }
  }
  abortAll() {
    for (const [key, e] of this.entries) {
      if (e.ctrl) { e.aborted = true; e.ctrl.abort(); this.stats.aborted++; } else this.entries.delete(key);
    }
  }
  pump() {
    while (this.inflight < this.max) {
      let best = null;
      for (const e of this.entries.values()) if (!e.ctrl && (!best || e.prio < best.prio)) best = e;
      if (!best) return;
      this._start(best);
    }
  }
  _start(e) {
    const { item } = e;
    e.ctrl = new AbortController();
    this.inflight++; this.stats.requested++;
    this.stats.maxInflight = Math.max(this.stats.maxInflight, this.inflight);
    let host = ''; try { host = new URL(item.url).hostname; } catch {}
    this.stats.byHost[host] = (this.stats.byHost[host] || 0) + 1;
    (async () => {
      try {
        const res = await fetch(item.url, { signal: e.ctrl.signal, mode: 'cors', credentials: 'omit' });
        if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
        const blob = await res.blob();
        this.stats.bytes += blob.size;
        const decoded = await decode(blob);
        this.stats.done++;
        if (e.aborted) { try { decoded.img.close?.(); } catch {} } else this.onReady(item, decoded);
      } catch (err) {
        if (e.aborted || err?.name === 'AbortError') { /* stale: nothing to report */ }
        else { this.stats.failed++; this.onFail(item, err, err?.status >= 400 && err?.status < 500); }
      } finally {
        this.inflight--;
        this.entries.delete(item.key);
        this.pump();
      }
    })();
  }
}
