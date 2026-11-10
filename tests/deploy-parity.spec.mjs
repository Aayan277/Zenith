// The tests serve the repo root, but GitHub Pages serves only what .github/workflows/pages.yml copies into _site.
// This test tours the app, records every same-origin file it loads, and checks that each one would be deployed.
// (Catches "works locally, 404 in production", e.g. a new data/*.json that nobody added to the `cp` list.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the "Assemble site" step: every `cp [-r] src... dest/` line -> list of deployed sources (files and directories). */
function deployedSources() {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  const step = yml.split('- name: Assemble site')[1]?.split(/\n\s*- name:/)[0] || '';
  const out = [];
  for (const line of step.split('\n')) {
    const m = line.trim().match(/^cp\s+(-\w+\s+)?(.+)\s+(\S+)$/);
    if (!m) continue;
    const dest = m[3].replace(/^_site\/?/, '').replace(/\/$/, '');
    for (const src of m[2].trim().split(/\s+/)) out.push({ src, deployed: path.posix.join(dest, path.posix.basename(src)) });
  }
  return out;
}

test('every local file the app loads is part of the deployed site (pages.yml "Assemble site")', async ({ page, app }) => {
  test.setTimeout(150_000);
  const loaded = new Set();
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.hostname === 'localhost' && r.status() < 400) loaded.add(decodeURIComponent(u.pathname).replace(/^\//, ''));
  });
  await app.open();
  // tour: every view, every panel tab, search, gallery, a launch + a sat + a body + a star + a constellation selection
  for (const v of ['sky', 'system', 'globe']) { await page.locator(`#topbar [data-view="${v}"]`).click(); await page.waitForTimeout(1200); }
  for (const t of ['launches', 'aurora', 'tonight']) { await page.locator(`.pt-tab[data-tab="${t}"]`).click(); await page.waitForTimeout(800); }
  await app.select({ kind: 'sat', id: 20580 });
  await app.select({ kind: 'body', id: 'Jupiter' });
  await app.select({ kind: 'craft', id: 'jwst' });
  await page.evaluate(async () => { (await import('/js/gallery/index.js')).openGallery('hubble'); });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.locator('#topbar [data-view="sky"]').click();
  await page.waitForTimeout(4000);                                      // sky lazy-loads its data (dso, constellations, ...)

  const deployed = deployedSources();
  expect(deployed.length, 'could not parse the Assemble site step').toBeGreaterThan(3);
  const isDeployed = f => f === '' || f === 'index.html' || deployed.some(d => f === d.deployed || f.startsWith(d.deployed + '/'));
  const missing = [...loaded].filter(f => f && !isDeployed(f)).sort();
  expect(missing, `served locally but NOT copied into _site by pages.yml:\n  ${missing.join('\n  ')}`).toEqual([]);
});
