# Zenith (codename skywatch) — architecture & module contracts

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
  State keys: `view`, `location {lat, lon, elevM, name, source, tz?}`, `selection`, `filters`, `highlightsOnly`, `catalogReady`.
  Events (not state): `clock`, `toast`, `focus` (`{kind,id}` — request the active view to fly/pan to an object),
  `passes` (emitted by tonight with computed pass list so the sky/globe can highlight them).
- `js/util/time.js` — observer-local time: `fmtLocal(ms, intlOpts)`, `tzLabel(ms)`, `tzOffsetMinutes(ms)`,
  `learnZone(ianaTz)`. ALL observer-facing times (sky header, rise/set, passes, sun/moon) use these, never the
  browser zone. The timebar shows observer time too.
- `js/clock.js` — simulated time. `now()` ms, `nowDate()`, `isLive()`, `getRate()`,
  `setTime(ms)`, `setRate(r)`, `goLive()`. Emits `clock` on change. Views read `now()` every frame.
- `js/data/catalog.js` — `loadCatalog()`, `loadFullCatalog()`, `isFullCatalog()`, `onCatalogUpdate(fn)`, `getSat(id)`, `allSats()`, `satrec(id)`.
  Two-stage load so the UI never waits for the 3.4 MB file:
  1. `data/sats-core.json` (~800 sats: stations, notable, bright, size L; ~45 KB gz) — `loadCatalog()` resolves when this is installed.
  2. `data/sats.json` (all ~18.7k sats, ~0.95 MB gz) is fetched when the browser is idle after stage 1 and then replaces the list.

  **Events** (via `state.on` / `state.emit`):
  - `catalog` `{ stage: 'core' | 'full', full: boolean, count }` — emitted once per stage, right after the lists are installed.
    **Anything that copied `allSats()` (propagator worker `init`, `SatLayer.setCatalog`, id→index maps) must re-read it on
    `catalog` with `stage === 'full'`.** After that event `allSats()` returns a NEW array (larger, ordered by category then id, so
    indices change); sat objects that existed in the core are reused by identity. `catalogReady` is a state key that is also re-set (and
    therefore re-emitted) on every stage, so cheap "refresh my counts/list" listeners keep working unchanged.
  - `onCatalogUpdate(fn)` is sugar for `state.on('catalog', fn)` and returns the unsubscribe function. Events are not replayed: if
    `isFullCatalog()` is already true, handle it immediately.
  Sat object shape is unchanged: `{ id, name, cat, l1, l2, bright?, size?, notable? }`; `cat` ∈ CATEGORIES keys.
  File format v2 (both files): `{ v: 2, generated, source, core?, sats: [[id, name, cat, l1, l2, flags, size, notable?], ...] }`,
  `flags` bit 1 = bright, bit 2 = notable (name in row[7]); `size` is `''` when unknown; `l1`/`l2` omit their `"1 NNNNN"`/`"2 NNNNN"`
  prefix (catalog.js rebuilds it). The core is a strict subset of the full file. The legacy object format is still accepted.
- `js/data/propagator.js` (owned by globe agent) — one Web Worker propagates the whole catalog;
  both views consume it:
  ```js
  import { onTick, getLatest } from './data/propagator.js';
  // tick = { time: ms, ids: Int32Array, ecef: Float32Array (x,y,z km, ECEF), sunlit: Uint8Array, count }
  // index i ↔ ids[i]. Positions are for `time` (sim clock, one tick interval ahead: interpolate). `ids` is the same
  // object for every tick of a catalog generation (identity changes when the catalog grows core → full).
  // ecef (0,0,0) = no position (layer-filtered out / decayed). ecef+sunlit buffers are pooled: don't keep them.
  // Tick rate adapts (~1 Hz at 1×, up to 10 Hz at high sim rates); nothing runs while the tab is hidden.
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
| `craft` | spacecraft key e.g. `'jwst'` | system |
| `world` | `'Earth'`, `'Pluto'` (heliocentric info) | system |
| `launch` | Launch Library id | launches |
| `dso` | Messier/NGC id e.g. `'M31'` | sky |
| `radiant` | meteor shower id e.g. `'Geminids'` | sky |
| `event` | sky event id | events |
| `event` | sky-event id, e.g. `meteor-geminids-2026`, `ecl-solar-2027-08-02` | events (`js/events/detail.js`) |

## Globe plug-ins

Other modules add layers to the orbit view through `js/globe/plugins.js` without touching `globe.js`:

```js
import { registerGlobeLayer } from './globe/plugins.js';
registerGlobeLayer({
  id: 'launches',
  init(ctx) {},                      // once, when the globe is ready (immediately if it already is)
  update(ctx, nowMs, dtMs) {},       // every RENDERED frame
  pick(ctx, x, y) { return null; },  // click at CSS px in the globe; return a selection {kind,id} to claim the click
  dispose() {},
});
// ctx = { THREE, scene, camera, renderer, root, coords, host, requestRender(ms = 300) }
```

- `root` is an Earth-fixed `THREE.Group` (radius 1 = 6371 km, +Y north; see `js/globe/coords.js`): add meshes there.
- `host` is `#view-globe`; use it for DOM labels and position them from `update()`.
- The globe renders at 60 fps while the camera moves or something animates and drops to ~20-30 fps when idle.
  `update()` only runs on rendered frames: call `ctx.requestRender(ms)` (e.g. from `update()` while your layer animates)
  to keep the full frame rate for `ms`, or after you change anything while the globe is idle.
- `pick` is asked on click before satellites; the first layer returning a selection wins (it is passed to `state.set('selection', …)`).
- Layers may be registered before or after the globe initialises. Exceptions in a layer are caught and logged.

## Data pipeline

`scripts/fetch-sats.mjs` (Node 20, no deps) builds `data/sats.json` and `data/sats-core.json` from CelesTrak groups
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


## Loading & performance contract

- **Boot order** (`js/main.js`): shell + tonight panel first (the boot overlay lifts when they are ready); globe (three.js + textures)
  and the satellite catalog load in parallel but never gate the UI; the sky view (`sky.js`) initialises on first need (view switch, non-sat
  selection, `focus`) or when idle. Without WebGL the globe module is not loaded at all (message shown, Sky view still works).
- **Textures** (`assets/textures/`, WebP): first load = `*-2k.webp` (≈0.6 MB). On desktop (≥900px, fine pointer, no save-data/slow connection,
  ≥4 GB, maxTextureSize ≥ 4096) `earth.js` swaps in `earth-day-4k.webp` / `earth-night-4k.webp` ≈1.5 s after the first frame, when idle.
  The canvas fades in via `body[data-earth="ready"]` (set by `earth.js`, styled in `css/base.css`). Re-generate with PIL
  (`Image.save(..., 'WEBP', quality=80-90, method=6)`); ImageMagick 6 ignores `-quality` for WebP.
- **Scripts**: `satellite.js` and `astronomy-engine` are `defer` classic scripts (they run before module scripts, so `window.satellite` /
  `window.Astronomy` exist when modules run). three comes from `three.module.min.js` via the import map. Critical modules are `modulepreload`ed.
- **Fonts** are self-hosted (`assets/fonts/*.woff2`, `@font-face` in `css/base.css`); the two latin files are preloaded.
- **Service worker** (`sw.js`, registered after `load`): precaches the shell, stale-while-revalidate for css/js/assets, cache-first for the
  pinned jsdelivr libs, network-first (3 s) with cache fallback for `data/*.json`, ignores other APIs. The cache name carries a build id:
  `.github/workflows/pages.yml` replaces `__BUILD__` in `sw.js` with the commit SHA + run id. When you add a module/asset that is needed
  offline on first visit, add it to `PRECACHE` in `sw.js` (anything else is cached on first use).
- **Deploy**: the Pages workflow minifies every `js/**/*.js`, `sw.js` and `css/*.css` in `_site` with esbuild (per file, no bundling), so
  keep modules plain ESM (no build-time imports).


## Sky events (`js/events/`) and calendar export

Left-panel tab **Events** (`js/events/panel.js`, `css/events.css`) plus the **Up tonight** card at the top of the Tonight tab
(`js/tonight/summary.js`). Everything is computed lazily with astronomy-engine, in `requestIdleCallback` slices (about 10 ms each),
and cached per location (2 decimals) + UTC day. The tab computes the next 12 months when it is first opened (~1 s of idle work).

```js
import { getShowers, activeShowers, upcomingEvents, ensureEvents, onEvents, getEvent, evaluateShower } from './events/index.js';
getShowers(2026)        // [{ id, name, peak (ms UTC), start, end, zhr, ra (deg), dec (deg), speed (km/s), parent, best, note, hw }]  sync, cached
activeShowers(ms)       // showers whose active range contains ms, + { daysFromPeak }; sync
await ensureEvents()    // compute / return cached events for state.location; concurrent calls share one run
upcomingEvents(fromMs, days = 365)  // SYNC: sorted events already computed for the current location ([] before ensureEvents resolves)
onEvents(fn)            // fn({ status: 'loading'|'ready', progress: 0..1, events }); returns unsubscribe
evaluateShower(shower, loc?, { from, to }?)  // { rate (est. meteors/hour here), rating: Excellent|Good|Fair|Poor, moonIllum, radiantAlt, bestStart, bestEnd, bestMs }
```

Event shape: `{ id, type: 'meteor'|'eclipse'|'moon'|'planet', sub, t (ms), title, line, badge, importance (0-10), vis: 'yes'|'part'|'no'|null,
visNote, viewMs (when it is best seen: the clock jumps here), focus: { kind, id }, rows, desc, ics?: { start, end }, shower? }`.
Showers use J2000 solar longitudes (IMO) converted to the equinox of date; rating = ZHR x peak profile x sin(radiant altitude) x Moon penalty over the
best 3 dark hours. Eclipses use `SearchLunarEclipse` / `SearchGlobalSolarEclipse` / `SearchLocalSolarEclipse`; planet events are oppositions,
greatest elongations, planet-planet and Moon-planet conjunctions within 2 degrees (daily scan, then refined), equinoxes and solstices.

Clicking an event (`goToEvent` in `js/events/ui.js`): `selection = { kind: 'event', id }`, `clock.setTime(viewMs)`, view -> `sky`, then
`state.emit('focus', ev.focus)` (sent twice, at 350 ms and 1600 ms, because the Sky view may still be initialising). `focus` is
`{ kind: 'body', id: 'Jupiter' }` for planets, Moon and Sun, and **`{ kind: 'radiant', id: 'Perseids' }`** for meteor showers (`id` = `showers.js` id; the Sky view
looks the radiant up with `getShowers(year)` / `activeShowers(ms)`).

**`js/util/ics.js`** (dependency-free): `buildIcs(spec | spec[])` -> RFC 5545 text (CRLF, lines folded at 75 octets, escaped, stable `UID`, `VALARM` 15 min before),
`downloadIcs(spec)` -> saves `zenith-<slug>.ics` through a Blob, `googleUrl(spec)` -> calendar.google.com template link, `icsEscape`, `foldLine`, `slug`.
`spec = { key?, title, start (ms), end?, allDay?, description?, location?, url?, link? }` (`link = { view, t, sel }` is turned into a share URL through
`js/ui/url.js linkPairs()` when the menu opens). **`js/events/calmenu.js`**: `calBtn(attrs)` HTML + `openCalMenu(anchorEl, spec | () => spec)` popover
("Apple / Outlook (.ics)", "Google Calendar", "Reminder 15 min before"; the reminder lives in the calendar app, so it fires with Zenith closed).
Used by the ISS card and pass list, the Launches hero card and detail, and Events (rows, hero, detail).
