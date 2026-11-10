// Zenith smoke tests. Everything external is mocked from tests/fixtures (see helpers.mjs); CDN libraries are real but cached on disk.
// Heavy: the globe and system views run three.js on SwiftShader. Do not add screenshots; keep waits generous, assertions loose.
import { test, expect, installMocks, metNoFixture } from './helpers.mjs';

const GLOBE_MS = 90_000;
const vp = (page) => page.viewportSize();

test.describe('boot', () => {
  test('boots without errors; overlay lifts; topbar visible', async ({ page, app }) => {
    await app.open();
    await expect(page.locator('#boot')).toHaveClass(/done/);
    await expect.poll(() => page.locator('#boot').evaluate(el => getComputedStyle(el).opacity), { message: 'boot overlay fades out (the node stays in the DOM)' }).toBe('0');
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(page.locator('#topbar .seg button')).toHaveText(['Orbit', 'Sky', 'System']);
    await expect(page.locator('#timebar')).toBeVisible();
    // New third-party hosts must be mocked in helpers.mjs (otherwise tests start depending on the live internet).
    if (app.mocks.unmocked.length) test.info().annotations.push({ type: 'unmocked-requests', description: app.mocks.unmocked.join('\n') });
  });

  test('first visit shows the tour; Esc dismisses it and unblocks the UI; it is not shown again', async ({ page, app }) => {
    await app.open({ tour: true });
    await expect(page.locator('.tour-root.show')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.tour-root.show')).toHaveCount(0, { timeout: 5_000 });
    await page.locator('#topbar [data-view="sky"]').click({ timeout: 5_000 });          // not blocked any more
    await page.reload();
    await page.waitForSelector('#boot.done', { state: 'attached' });
    await page.waitForTimeout(3000);
    await expect(page.locator('.tour-root.show')).toHaveCount(0);
  });

  test('resilience: every data API failing with 500 still renders all views, no uncaught errors', async ({ page, app }) => {
    await app.open({ fail: 500 });
    await expect(page.locator('#topbar')).toBeVisible();
    // Orbit (local catalog files are not "APIs": they still load)
    await expect(page.locator('#view-globe canvas').first()).toBeVisible({ timeout: GLOBE_MS });
    // Tonight degrades to "forecast offline" instead of breaking
    await expect(page.locator('#panel-tonight')).toContainText(/forecast (offline|unavailable)|unavailable right now/i, { timeout: 30_000 });
    // other tabs show their error/empty states
    await page.locator('.pt-tab[data-tab="launches"]').click();
    await expect(page.locator('#pt-pane-launches')).toBeVisible();
    await expect(page.locator('#pt-pane-launches .lc-hero, #pt-pane-launches .tn-err, #pt-pane-launches .lc-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.pt-tab[data-tab="aurora"]').click();
    await expect(page.locator('#pt-pane-aurora')).toBeVisible();
    await expect(page.locator('#pt-pane-aurora .tn-err').first()).toBeVisible({ timeout: 30_000 });
    // Sky and System
    await page.locator('#topbar [data-view="sky"]').click();
    await expect(page.locator('#view-sky canvas').first()).toBeVisible();
    await page.locator('#topbar [data-view="system"]').click();
    await expect(page.locator('#view-system canvas').first()).toBeVisible({ timeout: GLOBE_MS });
    await app.select({ kind: 'craft', id: 'jwst' });
    await expect(page.locator('#panel-detail .dp-title')).toHaveText(/Webb/i);
  });

  test('resilience: every data API answering 429 behaves the same', async ({ page, app }) => {
    await app.open({ fail: 429 });
    await expect(page.locator('#panel-tonight')).toContainText(/forecast (offline|unavailable)|unavailable right now/i, { timeout: 30_000 });
    await page.locator('.pt-tab[data-tab="launches"]').click();
    await expect(page.locator('#pt-pane-launches .lc-hero, #pt-pane-launches .tn-err, #pt-pane-launches .lc-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('#topbar [data-view="sky"]').click();
    await expect(page.locator('#view-sky canvas').first()).toBeVisible();
  });
});

test.describe('orbit', () => {
  test('globe is ready, catalog grows core -> full (>10k), ISS shows a sane altitude', async ({ page, app }) => {
    test.setTimeout(180_000);
    const core = page.waitForResponse(r => /\/data\/sats-core\.json/.test(r.url()), { timeout: 60_000 }).catch(() => null);
    await app.open();
    await expect(page.locator('#view-globe canvas').first()).toBeVisible({ timeout: GLOBE_MS });
    await page.waitForFunction(() => !!window.__globe && !!window.__globe.renderer, null, { timeout: GLOBE_MS });
    expect(await core, 'core catalog was fetched first').toBeTruthy();
    const count = () => page.evaluate(async () => (await import('/js/data/catalog.js')).allSats().length);
    await expect.poll(count, { timeout: 60_000, message: 'catalog must grow past 10k (core, then full)' }).toBeGreaterThan(10_000);
    expect(await page.evaluate(async () => (await import('/js/data/catalog.js')).isFullCatalog())).toBe(true);

    await app.select({ kind: 'sat', id: 25544 });
    const panel = page.locator('#panel-detail');
    await expect(panel.locator('.dp-title')).toHaveText(/ISS|ZARYA|International Space Station/i);
    const alt = panel.locator('.dp-stat', { has: page.locator('.dp-stat-label', { hasText: /^Altitude$/ }) }).locator('.dp-val');
    await expect.poll(async () => parseFloat((await alt.textContent() || '').replace(/,/g, '')), { timeout: 20_000 }).toBeGreaterThan(300);
    const km = parseFloat((await alt.textContent()).replace(/,/g, ''));
    expect(km).toBeLessThan(500);
  });
});

test.describe('sky and system', () => {
  test('Sky: canvas renders frames, selecting Saturn opens its detail panel', async ({ page, app }) => {
    await app.open();
    await page.locator('#topbar [data-view="sky"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'sky');
    const canvas = page.locator('#view-sky canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(300); expect(box.height).toBeGreaterThan(300);
    await page.waitForFunction(() => (window.__skyFrames || 0) > 3, null, { timeout: 30_000 });
    await app.select({ kind: 'body', id: 'Saturn' });
    await expect(page.locator('#panel-detail .dp-title')).toHaveText('Saturn');
    await expect(page.locator('#panel-detail .dp-stat-label', { hasText: 'Altitude' })).toBeVisible();
  });

  test('System: view renders, JWST detail shows distance stats', async ({ page, app }) => {
    test.setTimeout(180_000);
    await app.open();
    await page.locator('#topbar [data-view="system"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'system');
    await expect(page.locator('#view-system canvas').first()).toBeVisible({ timeout: GLOBE_MS });
    await page.waitForFunction(() => !!window.__system && !!window.__system.renderer, null, { timeout: GLOBE_MS });
    await app.select({ kind: 'craft', id: 'jwst' });
    const panel = page.locator('#panel-detail');
    await expect(panel.locator('.dp-title')).toHaveText(/James Webb/i);
    for (const label of ['From the Sun', 'From Earth']) {
      const stat = panel.locator('.dp-stat', { has: page.locator('.dp-stat-label', { hasText: label }) }).locator('.dp-val');
      await expect.poll(async () => parseFloat(await stat.textContent()), { message: `${label} is a positive number`, timeout: 15_000 }).toBeGreaterThan(0);
    }
  });
});

test.describe('panel tabs', () => {
  test('Tonight shows the score card with a cloud figure', async ({ page, app }) => {
    await app.open();
    await expect(page.locator('#panel-tonight .tn-ring')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#panel-tonight .tn-word')).toBeVisible({ timeout: 30_000 });   // weather resolved (not the pending skeleton)
    await expect(page.locator('#panel-tonight .tn-facts').first()).toContainText('☁');          // cloud % came from the forecast
    await expect(page.locator('#panel-tonight')).not.toContainText('forecast offline');
  });

  test('Launches renders the next-launch hero from the fixture', async ({ page, app }) => {
    await app.open();
    await page.locator('.pt-tab[data-tab="launches"]').click();
    const hero = page.locator('#pt-pane-launches .lc-hero');
    await expect(hero).toBeVisible({ timeout: 30_000 });
    await expect(hero.locator('.lc-title')).not.toHaveText('');
    await expect(hero.locator('.lc-cd')).toBeVisible();
    await expect(page.locator('#pt-pane-launches .lc-row').first()).toBeVisible();
  });

  test('Aurora renders the Kp gauge', async ({ page, app }) => {
    await app.open();
    await page.locator('.pt-tab[data-tab="aurora"]').click();
    await expect(page.locator('#pt-pane-aurora .au-gauge')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#pt-pane-aurora .au-gauge')).toHaveAttribute('aria-label', /Kp index [\d.]+ of 9/);
  });
});

test.describe('search, gallery, time bar', () => {
  test('Ctrl+K, "hubble", first result is Hubble, Enter selects it', async ({ page, app }) => {
    await app.open();
    await page.locator('body').click({ position: { x: 700, y: 450 } });
    await page.keyboard.press('Control+k');
    const input = page.locator('.search-modal input');
    await expect(input).toBeVisible();
    await page.keyboard.type('hubble', { delay: 20 });
    const first = page.locator('.search-list .sr-item').first();
    await expect(first.locator('.sr-name')).toHaveText(/Hubble/i, { timeout: 30_000 });
    await expect(first).toHaveClass(/active/);
    await page.keyboard.press('Enter');
    await expect(page.locator('.search-root')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__skywatchState.selection?.id), { timeout: 10_000 }).toBe(20580);
    await expect(page.locator('#panel-detail .dp-title')).toHaveText(/Hubble/i);
  });

  test('Gallery: Hubble photos open and the grid renders (images-api fixture)', async ({ page, app }) => {
    await app.open();
    await page.evaluate(async () => (await import('/js/gallery/index.js')).openGallery('hubble'));
    await expect(page.locator('.gal .gal-title')).toHaveText(/Hubble/);
    const tiles = page.locator('.gal-grid .gal-tile:not(.skel)');
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    expect(await tiles.count()).toBeGreaterThanOrEqual(10);
    await expect(page.locator('.gal-count')).toContainText(/photos?/);
    expect(app.mocks.count(/images-api\.nasa\.gov\/search/)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.gal-back')).toHaveCount(0, { timeout: 5000 });
  });

  test('Time bar: ArrowRight steps +10 min, L returns to live', async ({ page, app }) => {
    await app.open();
    await page.locator('body').click({ position: { x: 700, y: 450 } });
    const clock = () => page.evaluate(async () => { const c = await import('/js/clock.js'); return { t: c.now(), live: c.isLive(), real: Date.now() }; });
    const a = await clock();
    expect(a.live).toBe(true);
    await page.keyboard.press('ArrowRight');
    const b = await clock();
    expect(b.live).toBe(false);
    expect(b.t - a.t).toBeGreaterThan(10 * 60e3 - 5_000);
    expect(b.t - a.t).toBeLessThan(10 * 60e3 + 8_000);
    await expect(page.locator('#tb-back')).toBeVisible();
    await page.keyboard.press('l');
    const c = await clock();
    expect(c.live).toBe(true);
    expect(Math.abs(c.t - c.real)).toBeLessThan(2_000);
    await expect(page.locator('#tb-back')).toBeHidden();
  });
});

test.describe('layout', () => {
  test('no horizontal scroll at 1440 (all three views)', async ({ page, app }) => {
    await app.open();
    for (const v of ['globe', 'sky', 'system']) {
      await page.locator(`#topbar [data-view="${v}"]`).click();
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth, b: document.body.scrollWidth })), v)
        .toEqual(expect.objectContaining({ s: 1440, c: 1440 }));
      expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth), `${v}: body fits`).toBe(true);
    }
  });

  test('no horizontal scroll at 390x844 (phone): collapsed and expanded sheet, every view and tab', async ({ page, app }) => {
    await app.open({ viewport: { width: 390, height: 844 } });
    const fits = async what => {
      const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth, b: document.body.scrollWidth }));
      expect(m.s, `${what}: documentElement.scrollWidth`).toBeLessThanOrEqual(m.c);
      expect(m.b, `${what}: body.scrollWidth`).toBeLessThanOrEqual(m.c);
    };
    await fits('boot');
    const bar = await page.locator('#topbar').boundingBox();
    expect(bar.x + bar.width).toBeLessThanOrEqual(391);
    for (const v of ['sky', 'system', 'globe']) { await page.locator(`#topbar [data-view="${v}"]`).click({ timeout: 10_000 }); await page.waitForTimeout(500); await fits(v); }
    // the left panel is a bottom sheet on phones: expand it (keyboard: Enter on the handle), then visit each tab
    await page.locator('.tn-handle').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#panel-tonight')).not.toHaveClass(/collapsed/);
    for (const t of ['launches', 'aurora', 'tonight']) { await page.locator(`.pt-tab[data-tab="${t}"]`).click({ timeout: 10_000 }); await page.waitForTimeout(800); await fits(`tab ${t}`); }
    await app.select({ kind: 'sat', id: 25544 });
    await page.waitForTimeout(800); await fits('detail panel open');
  });
});

test.describe('service worker', () => {
  test.use({ serviceWorkers: 'allow' });
  test('registers and activates', async ({ page, app }) => {
    await app.open();
    const info = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('sw not ready in 30s')), 30_000))]);
      return { scope: reg.scope, state: reg.active?.state, script: reg.active?.scriptURL };
    });
    expect(info.script).toMatch(/\/sw\.js$/);
    expect(info.scope).toMatch(/\/$/);
    expect(['activating', 'activated']).toContain(info.state);
  });
});

// ---- weather: Open-Meteo first, MET Norway on 429 / 5xx / timeout -------------------------------------------------
test.describe('weather fallback', () => {
  // These call fetchWeather() directly on a bare text page (fast; no three.js).
  const callWeather = (page, lat = 51.4779, lon = -0.0015) =>
    page.evaluate(async ([a, b]) => { const w = await (await import('/js/tonight/weather.js')).fetchWeather(a, b); return { ...w, hours: w.hours.length, first: w.hours[0], mid: w.hours[40] }; }, [lat, lon]);
  const shape = w => {
    expect(typeof w.tz).toBe('string'); if (w.source === 'open-meteo') expect(w.tz.length).toBeGreaterThan(2);
    expect(Number.isFinite(w.elevation)).toBe(true);
    expect(w.hours).toBeGreaterThan(60);
    for (const h of [w.first, w.mid]) { expect(Object.keys(h).sort()).toEqual(['cloud', 'low', 't', 'vis']); expect(h.cloud).toBeGreaterThanOrEqual(0); expect(h.cloud).toBeLessThanOrEqual(100); expect(h.t % 3600e3).toBe(0); }
  };

  test('Open-Meteo healthy: used, met.no never called', async ({ page, app }) => {
    app.mocks = await installMocks(page, {}); await page.goto('/tests/blank.html');
    const w = await callWeather(page);
    expect(w.source).toBe('open-meteo'); shape(w);
    expect(app.mocks.count(/api\.met\.no/)).toBe(0);
  });

  for (const status of [429, 500, 503]) {
    test(`Open-Meteo ${status} -> MET Norway, same shape, 2-decimal coords, no custom headers`, async ({ page, app }) => {
      app.mocks = await installMocks(page, { openMeteo: status }); await page.goto('/tests/blank.html');
      const w = await callWeather(page, 51.477912, -0.001534);
      expect(w.source).toBe('met.no'); expect(w.sourceLabel).toBe('MET Norway'); shape(w);
      const met = app.mocks.calls.filter(c => c.host === 'api.met.no');
      expect(met).toHaveLength(1);
      expect(met[0].url).toMatch(/\/locationforecast\/2\.0\/complete\?lat=51\.48&lon=0\.00$/);
      expect(Object.keys(met[0].headers).filter(h => /^(x-|authorization|content-type)/.test(h)), 'a custom header would force a CORS preflight, which met.no does not support').toEqual([]);
      // cached for ~30 min: a second call and a "reload" make no new requests
      await callWeather(page, 51.4779, -0.0015);
      expect(app.mocks.count(/api\.met\.no/)).toBe(1);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('zenith:weather:v1')));
      expect(Object.keys(stored)).toEqual(['51.48,0.00']);
    });
  }

  test('Open-Meteo never answers -> app timeout -> MET Norway', async ({ page, app }) => {
    test.setTimeout(60_000);
    app.mocks = await installMocks(page, { openMeteo: 'stall' }); await page.goto('/tests/blank.html');
    const t0 = Date.now();
    const w = await callWeather(page);
    expect(w.source).toBe('met.no'); shape(w);
    expect(Date.now() - t0).toBeGreaterThan(7_000); expect(Date.now() - t0).toBeLessThan(20_000);
  });

  test('both sources down: rejects (the Tonight card shows "forecast offline"); a stored copy is served stale', async ({ page, app }) => {
    app.mocks = await installMocks(page, { openMeteo: 500, metno: 500 }); await page.goto('/tests/blank.html');
    await expect(page.evaluate(async () => { try { await (await import('/js/tonight/weather.js')).fetchWeather(10, 10); return 'resolved'; } catch (e) { return 'rejected'; } })).resolves.toBe('rejected');
    // seed a 2-hour-old stored forecast for another location
    await page.evaluate(async () => {
      const w = (await import('/js/tonight/weather.js'));
      localStorage.setItem('zenith:weather:v1', JSON.stringify({ '20.00,20.00': { at: Date.now() - 2 * 3600e3, data: { tz: 'UTC', elevation: 1, hours: [{ t: 0, cloud: 5, low: 5, vis: 20000 }], source: 'open-meteo', sourceLabel: 'Open-Meteo', at: Date.now() - 2 * 3600e3 } } }));
      globalThis.__w = w;
    });
    const r = await page.evaluate(async () => (await globalThis.__w.fetchWeather(20, 20)));
    expect(r.stale).toBe(true); expect(r.source).toBe('open-meteo');
  });

  test('met.no mapping: hourly, gap-free, low/total clouds, estimated zone from longitude when the location has none', async ({ page, app }) => {
    app.mocks = await installMocks(page, {}); await page.goto('/tests/blank.html');
    const fixture = metNoFixture();
    const out = await page.evaluate(async f => {
      const m = await import('/js/tonight/weather.js'); const s = await import('/js/state.js');
      s.set('location', { lat: 40, lon: -74, elevM: 0, name: 'x', source: 'search' });   // no tz known
      const est = m.mapMetNo(f, -74);
      s.set('location', { lat: 40, lon: -74, elevM: 0, name: 'x', source: 'search', tz: 'America/New_York' });
      const known = m.mapMetNo(f, -74);
      return { est: { tz: est.tz, guess: est.tzGuess, e: est.tzEstimated, n: est.hours.length, ts: est.hours.map(h => h.t), low: est.hours.slice(0, 30).map(h => h.low) }, known: { tz: known.tz, e: known.tzEstimated } };
    }, fixture);
    expect(out.est.tz, 'estimated zones are not returned as tz (learnZone would persist them)').toBe(''); expect(out.est.guess).toBe('Etc/GMT+5'); expect(out.est.e).toBe(true);
    expect(out.known).toEqual({ tz: 'America/New_York', e: undefined });  // the location's own zone is passed through
    for (let i = 1; i < out.est.ts.length; i++) expect(out.est.ts[i] - out.est.ts[i - 1], `hour ${i}`).toBe(3600e3);
    expect(out.est.n).toBeGreaterThan(80);
    expect(out.est.low.some(v => v > 0)).toBe(true);
  });

  test('integration: Open-Meteo 429 -> Tonight card still shows a cloud figure, no "forecast offline"', async ({ page, app }) => {
    await app.open({ openMeteo: 429 });
    await expect(page.locator('#panel-tonight .tn-word')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#panel-tonight .tn-facts').first()).toContainText('☁');
    await expect(page.locator('#panel-tonight')).not.toContainText('forecast offline');
    expect(app.mocks.count(/api\.met\.no/)).toBe(1);
    // the cloud chart is drawn from the met.no hours too
    await expect(page.locator('#panel-tonight .tn-cloudsvg')).toBeVisible();
  });
});
