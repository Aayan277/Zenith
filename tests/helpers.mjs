// Shared test plumbing: network mocks (fixtures rebased to "now"), CDN disk cache, console-error policy, app boot.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, '.cache', 'cdn');
export const fx = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

const H = 3600e3, D = 24 * H;
const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
// 1x1 PNG for every image host (NASA library, SDO, launch photos).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64');

// ---- fixtures are captured/synthesised once, then shifted so their timestamps are relative to the test's "now" --------
const iso = ms => new Date(ms).toISOString();
export function openMeteoFixture(now = Date.now()) {
  const j = fx('open-meteo.json');
  const start = Math.floor(now / D) * D - D;                 // past_days=1: yesterday 00:00 (UTC, the fixture has offset 0)
  j.hourly.time = j.hourly.time.map((_, i) => iso(start + i * H).slice(0, 16));
  return j;
}
export function metNoFixture(now = Date.now()) {
  const j = fx('metno-complete.json');
  const ts = j.properties.timeseries;
  const delta = Math.ceil(now / H) * H - Date.parse(ts[0].time);
  for (const e of ts) e.time = iso(Date.parse(e.time) + delta).replace('.000', '');
  j.properties.meta.updated_at = iso(now).replace('.000', '');
  return j;
}
export function kpFixture(now = Date.now()) {
  const j = fx('kp.json');
  const delta = Math.floor((now - Date.UTC(2026, 10, 10, 18)) / (3 * H)) * 3 * H;
  return j.map(r => ({ ...r, time_tag: iso(Date.parse(r.time_tag + 'Z') + delta).slice(0, 19) }));
}
export function launchFixture(kind, now = Date.now()) {
  const j = fx(kind === 'previous' ? 'll2-previous.json' : 'll2-upcoming.json');
  const nets = j.results.map(r => Date.parse(r.net));
  const delta = kind === 'previous' ? now - 20 * H - Math.max(...nets) : now + 36 * H - Math.min(...nets);
  for (const r of j.results) for (const k of ['net', 'window_start', 'window_end']) if (r[k]) r[k] = iso(Date.parse(r[k]) + delta);
  return j;
}

// ---- which hosts are "data APIs" (mocked / failable) and which are CDN libraries (real network, cached on disk) ----
const CDN = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const IMAGE_HOSTS = new Set(['images-assets.nasa.gov', 'images.nasa.gov', 'sdo.gsfc.nasa.gov', 'thespacedevs-prod.nyc3.digitaloceanspaces.com', 'apod.nasa.gov']);
const json = (body, status = 200, extra = {}) => ({ status, contentType: 'application/json', headers: { ...CORS, ...extra }, body: JSON.stringify(body) });

async function serveCdn(route) {
  const url = route.request().url();
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const body = path.join(CACHE_DIR, key), meta = body + '.json';
  try {
    if (fs.existsSync(body) && fs.existsSync(meta)) {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      return await route.fulfill({ status: 200, body: fs.readFileSync(body), headers: { ...m, 'access-control-allow-origin': '*' } });
    }
  } catch { /* fall through to the network */ }
  try {
    const res = await route.fetch();
    const buf = await res.body();
    if (res.status() === 200) {
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = `${body}.${process.pid}.${Math.random().toString(36).slice(2)}`;
        fs.writeFileSync(tmp, buf); fs.writeFileSync(tmp + '.m', JSON.stringify({ 'content-type': res.headers()['content-type'] || 'application/octet-stream' }));
        fs.renameSync(tmp + '.m', meta); fs.renameSync(tmp, body);
      } catch { /* cache is best-effort */ }
    }
    return await route.fulfill({ response: res, body: buf });
  } catch { return route.abort('failed'); }
}

/**
 * Install network mocks on the page's context.
 * opts.fail:      500 | 429 | 'abort' -> EVERY data API (and image host) fails that way (resilience test).
 * opts.openMeteo: status code (or 'stall') for api.open-meteo.com/v1/forecast only.
 * opts.metno:     status code for api.met.no only.
 * Returns { calls: [{host, path, url}], unmocked: [urls], count(re) }.
 */
export async function installMocks(page, opts = {}) {
  const rec = { calls: [], unmocked: [] };
  rec.count = re => rec.calls.filter(c => re.test(c.url)).length;
  const failWith = status => status === 'abort' ? { abort: 'failed' } : json({ error: 'mock failure' }, status, status === 429 ? { 'retry-after': '120' } : {});

  await page.context().route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.fallback();
    if (CDN.has(u.hostname)) return serveCdn(route);

    const host = u.hostname, p = u.pathname;
    rec.calls.push({ host, path: p, url: req.url(), method: req.method(), headers: req.headers() });
    const done = r => (r.abort ? route.abort(r.abort) : route.fulfill(r));

    if (opts.fail) return done(failWith(opts.fail));

    if (IMAGE_HOSTS.has(host)) return route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG });

    if (host === 'api.open-meteo.com') {
      if (opts.openMeteo === 'stall') return;                                      // never answers: the app's own timeout must kick in
      if (opts.openMeteo) return done(failWith(opts.openMeteo));
      return route.fulfill(json(openMeteoFixture()));
    }
    if (host === 'api.met.no') {
      if (opts.metno) return done(failWith(opts.metno));
      return route.fulfill(json(metNoFixture()));
    }
    if (host === 'geocoding-api.open-meteo.com') return route.fulfill(json({ results: [] }));
    if (host === 'api.bigdatacloud.net') return route.fulfill(json({ city: 'Greenwich', countryCode: 'GB' }));
    if (host === 'services.swpc.noaa.gov') {
      if (p.endsWith('noaa-planetary-k-index-forecast.json')) return route.fulfill(json(kpFixture()));
      if (p.endsWith('/alerts.json')) return route.fulfill(json(fx('alerts.json')));
      if (p.endsWith('solar-wind-speed.json')) return route.fulfill(json(fx('wind-speed.json')));
      if (p.endsWith('solar-wind-mag-field.json')) return route.fulfill(json(fx('wind-mag.json')));
      if (p.endsWith('ovation_aurora_latest.json')) return route.fulfill(json(fx('ovation.json')));
      if (p.endsWith('xray-flares-latest.json')) return route.fulfill(json(fx('flare-latest.json')));
      return route.fulfill(json([]));                                              // other SWPC products (flares, regions, X-ray, cycle)
    }
    if (host === 'll.thespacedevs.com') return route.fulfill(json(launchFixture(/\/launches\/previous\//.test(p) ? 'previous' : 'upcoming')));
    if (host === 'images-api.nasa.gov') {
      const page_ = +u.searchParams.get('page') || 1;
      const f = fx('nasa-images.json');
      if (page_ > 1) f.collection.items = [];
      return route.fulfill(json(f));
    }
    rec.unmocked.push(req.url());
    return route.fulfill({ status: 404, headers: CORS, body: 'not mocked' });
  });
  return rec;
}

// ---- console / page error policy ------------------------------------------------------------------------------------
// Uncaught exceptions and console.error from OUR code fail the test. Allowlisted: the browser's own "Failed to load
// resource" line for a request to a third-party host (CDN hiccup, an image host, an API that the test made fail).
const NOISE = [
  { text: /Failed to load resource/i, url: u => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u) },
  { text: /net::ERR_(FAILED|ABORTED|BLOCKED_BY_CLIENT|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/i, url: u => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u) },
];
export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text(), url = m.location()?.url || '';
    if (NOISE.some(n => n.text.test(text) && n.url(url))) return;
    errors.push(`console.error: ${text}${url ? ` @ ${url}` : ''}`);
  });
  return errors;
}

// ---- the `app` fixture ------------------------------------------------------------------------------------------------
export const test = base.extend({
  app: async ({ page }, use) => {
    const errors = watchErrors(page);
    const app = {
      errors, mocks: null, allowErrors: false,
      /** Mock the network, load the app and wait until the boot overlay lifted. */
      async open(opts = {}) {
        app.mocks = await installMocks(page, opts);
        // The first-visit tour (js/ui/tour.js) covers the page with a click-blocking overlay: mark it seen unless a test wants it.
        if (!opts.tour) await page.addInitScript(() => { try { localStorage.setItem('zenith:tour', 'done'); } catch {} });
        if (opts.viewport) await page.setViewportSize(opts.viewport);
        await page.goto(opts.path || '/');
        await page.waitForSelector('#boot.done', { state: 'attached', timeout: 60_000 });
        return app;
      },
      /** Drive the app through its own state module (same URL => same module instance as the app's). */
      select: sel => page.evaluate(async s => { (await import('/js/state.js')).set('selection', s); }, sel),
      setView: v => page.evaluate(async x => { (await import('/js/state.js')).set('view', x); }, v),
    };
    await use(app);
    if (!app.allowErrors) expect(errors, 'uncaught page errors / console errors').toEqual([]);
  },
});
export { expect };
