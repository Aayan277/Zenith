#!/usr/bin/env node
// Manual post-deploy check: load the deployed site in headless Chromium and report console errors, uncaught
// exceptions and failed requests. Uses the REAL network (no mocks), so third-party failures show up as warnings.
//
//   node tests/live-check.mjs                       # https://aayan277.github.io/Zenith/
//   node tests/live-check.mjs http://localhost:8350/ --wait 15
//   PW_EXECUTABLE=/opt/pw-browsers/chromium node tests/live-check.mjs
//
// Exit code 1 when the page throws, logs console.error, or a same-origin request fails; 0 otherwise.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:/.test(a)) || 'https://aayan277.github.io/Zenith/';
const waitIdx = args.indexOf('--wait');
const waitS = waitIdx >= 0 ? Number(args[waitIdx + 1]) || 12 : 12;
const origin = new URL(url).origin;

const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('zenith:tour', 'done'); } catch {} });   // the first-visit tour blocks clicks
const page = await ctx.newPage();

const errors = [], warnings = [];
page.on('pageerror', e => errors.push(`uncaught: ${e.message}`));
page.on('console', m => {
  if (m.type() === 'error') {
    const loc = m.location()?.url || '';
    // The browser's own "Failed to load resource" line for a third-party host is a warning, not a site bug.
    (/Failed to load resource/.test(m.text()) && loc && !loc.startsWith(origin) ? warnings : errors).push(`console.error: ${m.text()}${loc ? ` @ ${loc}` : ''}`);
  }
});
page.on('requestfailed', r => (r.url().startsWith(origin) ? errors : warnings).push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
page.on('response', r => { if (r.status() >= 400) (r.url().startsWith(origin) ? errors : warnings).push(`HTTP ${r.status()}: ${r.url()}`); });

console.log(`Loading ${url} (waiting ${waitS}s after load)…`);
await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('#boot.done', { state: 'attached', timeout: 45_000 }).catch(() => errors.push('boot overlay never lifted (#boot.done) within 45s'));
for (const v of ['sky', 'system', 'globe']) {                              // visit each view once
  await page.locator(`#topbar [data-view="${v}"]`).click({ timeout: 5000 }).catch(() => errors.push(`could not switch to the ${v} view`));
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(waitS * 1000);

const sats = await page.evaluate(async () => { try { return (await import('./js/data/catalog.js')).allSats().length; } catch (e) { return `n/a (${e.message})`; } });
console.log(`title: ${await page.title()} | satellites loaded: ${sats}`);
await browser.close();

if (warnings.length) console.log(`\nWarnings (third-party / non-fatal), ${warnings.length}:\n  ${[...new Set(warnings)].join('\n  ')}`);
if (errors.length) { console.log(`\nERRORS, ${errors.length}:\n  ${[...new Set(errors)].join('\n  ')}`); process.exit(1); }
console.log('\nOK: no uncaught errors, no console errors, no failed same-origin requests.');
