// Zenith service worker. Scope = the directory it is served from (/Zenith/ on GitHub Pages); all URLs are relative.
//  - shell + first-load assets are precached at install
//  - css / js / fonts / textures / pinned CDN libs: stale-while-revalidate (CDN libs are version-pinned: cache-first)
//  - data/*.json (satellite TLEs, sky catalog): network-first (3 s), falling back to the last cached copy (offline)
//  - everything else (weather, geocoding, NOAA APIs) is not intercepted
// VERSION is replaced with the commit SHA by .github/workflows/pages.yml so every deploy gets a fresh cache.
const VERSION = '__BUILD__';
const CACHE = 'zenith-' + VERSION;
const PRECACHE = [
 "index.html",
 "assets/favicon.svg",
 "assets/fonts/space-grotesk-latin.woff2",
 "assets/fonts/jetbrains-mono-latin.woff2",
 "assets/textures/earth-clouds-2k.webp",
 "assets/textures/earth-day-2k.webp",
 "assets/textures/earth-night-2k.webp",
 "assets/textures/earth-water-2k.webp",
 "assets/textures/milkyway-2k.webp",
 "data/sats-core.json",
 "data/sky/sky.json",
 "data/sky/constellations.json",
 "data/launches.json",
 "css/aurora.css",
 "css/base.css",
 "css/gallery.css",
 "css/globe.css",
 "css/launches.css",
 "css/paneltabs.css",
 "css/shell.css",
 "css/sky.css",
 "css/sun.css",
 "css/tonight.css",
 "js/aurora/alerts.js",
 "js/aurora/assess.js",
 "js/aurora/data.js",
 "js/aurora/index.js",
 "js/aurora/layer.js",
 "js/aurora/model.js",
 "js/aurora/panel.js",
 "js/clock.js",
 "js/data/catalog.js",
 "js/data/propagator.js",
 "js/gallery/index.js",
 "js/gallery/lightbox.js",
 "js/gallery/source.js",
 "js/gallery/telescopes.js",
 "js/globe/coords.js",
 "js/globe/detail.js",
 "js/globe/earth.js",
 "js/globe/globe.js",
 "js/globe/overlays.js",
 "js/globe/plugins.js",
 "js/globe/sats.js",
 "js/launches/data.js",
 "js/launches/detail.js",
 "js/launches/globe.js",
 "js/launches/index.js",
 "js/launches/panel.js",
 "js/launches/reminders.js",
 "js/launches/util.js",
 "js/main.js",
 "js/sky/astro.js",
 "js/sky/aurora.js",
 "js/sky/data.js",
 "js/sky/details.js",
 "js/sky/sats.js",
 "js/sky/sky.js",
 "js/state.js",
 "js/sun/card.js",
 "js/sun/dashboard.js",
 "js/sun/data.js",
 "js/sun/index.js",
 "js/sun/util.js",
 "js/tonight/astro.js",
 "js/tonight/aurora.js",
 "js/tonight/location.js",
 "js/tonight/passes.js",
 "js/tonight/score.js",
 "js/tonight/tonight.js",
 "js/tonight/util.js",
 "js/tonight/weather.js",
 "js/ui/detail.js",
 "js/ui/layers.js",
 "js/ui/notify.js",
 "js/ui/paneltabs.js",
 "js/ui/search.js",
 "js/ui/shell.js",
 "js/ui/timebar.js",
 "js/util/governor.js",
 "js/util/time.js",
 "js/workers/passes.worker.js",
 "js/workers/propagate.worker.js",
 "js/launches/normalize.mjs"
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // allSettled: one missing file must not block the install. 'reload' bypasses the HTTP cache (Pages: max-age=600).
    await Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('zenith-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const store = async (req, res) => { if (res && (res.ok || res.type === 'opaque')) { try { await (await caches.open(CACHE)).put(req, res.clone()); } catch {} } return res; };

function networkFirst(req, ms) {
  return new Promise(async resolve => {
    let done = false;
    const fallback = async () => (await caches.match(req)) || Response.error();
    const t = setTimeout(async () => { if (!done) { const c = await caches.match(req); if (c) { done = true; resolve(c); } } }, ms);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (!done) { done = true; clearTimeout(t); resolve(res); }
      await store(req, res);
    } catch {
      if (!done) { done = true; clearTimeout(t); resolve(await fallback()); }
    }
  });
}

function staleWhileRevalidate(req, evt) {
  return caches.match(req).then(hit => {
    const fresh = fetch(new Request(req, { cache: 'no-cache' })).then(res => store(req, res)).catch(() => null);
    if (hit) { evt.waitUntil(fresh); return hit; }
    return fresh.then(r => r || Response.error());
  });
}

function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => store(req, res)));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
    if (url.pathname.endsWith('/sw.js')) return;
    if (/\/data\/[^?]*\.json$/.test(url.pathname)) return e.respondWith(networkFirst(req, 3000));
    if (req.mode === 'navigate') {
      // app shell: cached index.html first, refreshed in the background
      return e.respondWith(caches.match(new URL('index.html', self.registration.scope).href).then(hit => hit || staleWhileRevalidate(req, e)).then(r => { e.waitUntil(fetch(new Request(req, { cache: 'no-cache' })).then(res => store(new URL('index.html', self.registration.scope).href, res)).catch(() => {})); return r; }));
    }
    return e.respondWith(staleWhileRevalidate(req, e));
  }
  if (url.hostname === 'cdn.jsdelivr.net') return e.respondWith(cacheFirst(req));
});
