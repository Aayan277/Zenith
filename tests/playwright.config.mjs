// Playwright config for the Zenith smoke suite. Run from the repo root: `npm test`.
// The site is static: the web server is just http-server on the repo root (no build step).
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8350;
const CI = !!process.env.CI;

// CI installs Chromium for the pinned Playwright (`npx playwright install chromium`). If the locally installed browser
// is a different build, point PW_EXECUTABLE at it (e.g. /opt/pw-browsers/chromium).
const executablePath = process.env.PW_EXECUTABLE || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  outputDir: path.join(root, 'tests/test-results'),
  timeout: 120_000,                       // every test boots the app incl. three.js on SwiftShader (software GL)
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? +process.env.PW_WORKERS : 2,   // SwiftShader is CPU heavy: more workers just slow each other down
  retries: CI ? 2 : 0,   // GitHub runners are slow under SwiftShader; retry before failing a deploy
  forbidOnly: CI,
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never', outputFolder: path.join(root, 'tests/playwright-report') }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',              // so page.route() sees every request; the service-worker test opts back in
    launchOptions: {
      executablePath,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }],
  webServer: {
    command: `npx http-server -p ${PORT} -c-1 -s .`,
    cwd: root,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
