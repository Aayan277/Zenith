# Skywatch — architecture & module contracts

Static site, no build step. Plain ES modules served by GitHub Pages.
Third-party code comes from CDNs pinned to exact versions (see `index.html`):

- `window.satellite` — satellite.js 5.0.0 (SGP4). Workers: `importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js')`
- `window.Astronomy` — astronomy-engine 2.1.19 (Sun/Moon/planets, rise/set, moon phase)
- `three` 0.160.0 via import map (`import * as THREE from 'three'`, addons from `three/addons/...`)

## Layout (index.html)

| Element | Owner | What |
|---|---|---|
| `#view-globe` | `js/globe/` | full-screen 3D Earth + satellites |
| `#view-sky` | `js/sky/` | full-screen "look up" sky dome for the observer |
| `#topbar` | `js/ui/shell.js` | logo, Orbit/Sky switch, search (⌘K / Ctrl+K, `/`), layer filter chips |
| `#panel-tonight` | `js/tonight/` | left panel: location, stargazing score, visible passes, moon/sun, clouds |
| `#panel-detail` | `js/ui/detail.js` | right panel: details for `state.selection` |
| `#timebar` | `js/ui/timebar.js` | bottom: LIVE, time scrubber (−12h..+48h), speed (1×, 10×, 60×, 600×, 3600×), reverse |
| `#modal-root` | anyone | modals (location picker lives in `js/tonight/location.js`) |

`body[data-view="globe"|"sky"]` selects the visible view. Views must pause their
render loop while hidden (listen to `state.on('view', …)`).

Each top-level module (`ui/shell.js`, `globe/globe.js`, `sky/sky.js`, `tonight/tonight.js`)
exports `async function init()`. `main.js` calls them independently; a crash in one
must not break the others. Do NOT import from `main.js` (circular). To show a toast:
`state.emit('toast', 'message')`.

## Shared modules (core — do not change signatures without the lead)

- `js/state.js` — `get/set/patch/on/emit`, `CATEGORIES` (key → {label, color, size}),
  `registerDetailProvider(kind, fn)`, `getDetail(selection, nowMs)`.
  State keys: `view`, `location {lat, lon, elevM, name, source}`, `selection`, `filters`, `catalogReady`.
  Events (not state): `clock`, `toast`, `focus` (`{kind,id}` — request the active view to fly/pan to an object),
  `passes` (emitted by tonight with computed pass list so the sky/globe can highlight them).
- `js/clock.js` — simulated time. `now()` ms, `nowDate()`, `isLive()`, `getRate()`,
  `setTime(ms)`, `setRate(r)`, `goLive()`. Emits `clock` on change. Views read `now()` every frame.
- `js/data/catalog.js` — `loadCatalog()`, `getSat(id)`, `allSats()`, `satrec(id)`.
  `data/sats.json`: `{ generated, source, sats: [{ id, name, cat, l1, l2, mag? }] }`, `cat` ∈ CATEGORIES keys.
- `js/data/propagator.js` (owned by globe agent) — one Web Worker propagates the whole catalog;
  both views consume it:
  ```js
  import { onTick, getLatest } from './data/propagator.js';
  // tick = { time: ms, ids: Int32Array, ecef: Float32Array (x,y,z km, ECEF), sunlit: Uint8Array, count }
  // index i ↔ ids[i]. Positions are for `time` (sim clock). Runs at ~10 Hz while any consumer is active.
  const off = onTick(tick => …);
  ```
  `getLatest()` returns the last tick or null. Also exports `ecefToTopo(ecefKm, lat, lon, elevM) -> {az, el, rangeKm}` (degrees).

## Coordinates

- Globe scene is Earth-fixed (ECEF): Earth radius 1 unit = 6371 km, +Y = north pole,
  lon 0 on +X… (globe agent documents its exact mapping in `js/globe/coords.js`).
- Sun direction from `Astronomy` (geocentric equatorial → rotate by GMST to ECEF).
- Sky view: horizontal coords (azimuth from North clockwise, elevation above horizon).

## Selection kinds & detail providers

| kind | id | provider registered by |
|---|---|---|
| `sat` | NORAD id (number) | globe (`js/globe/`) |
| `body` | `'Sun'`, `'Moon'`, `'Mercury'`…`'Neptune'` | sky |
| `star` | HIP number | sky |
| `constellation` | IAU abbrev e.g. `'Ori'` | sky |

## Data pipeline

`scripts/fetch-sats.mjs` (Node 20, no deps) builds `data/sats.json` from CelesTrak groups
(fallback: tle.ivanstanojevic.me). A scheduled GitHub Action runs it every 6h, commits,
and Pages redeploys. Star data in `data/sky/` (from d3-celestial, BSD-3), compacted by
`scripts/build-sky.mjs` into `data/sky/sky.json`.

## Style

Use tokens from `css/base.css` only (`--glass`, `--accent`, `--sun`, `--font`, `--mono` …).
Use the `.glass`, `.eyebrow`, `.btn`, `.mono` classes. Dark, cinematic, calm motion.
Each module owns its own stylesheet (`css/shell.css`, `css/globe.css`, `css/sky.css`, `css/tonight.css`).
Mobile (≤760px): side panels become bottom sheets; nothing may cause horizontal scroll.

## Dev

```
npx --yes http-server -p 8080 -c-1 .
```
Headless check: Playwright's Chromium is preinstalled (`require('playwright')`). WebGL works via SwiftShader (slow — that's fine).
