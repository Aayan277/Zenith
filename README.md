# Zenith

Live satellites, stars and planets above you. See what is overhead tonight.

Zenith is a static web app (no build step, no backend) that propagates ~18,000 satellites in
your browser and shows them on a 3D globe or as a "look up" sky dome for your location.

> **Screenshot:** _coming soon_ (`docs/screenshot.png`)

**Live site:** https://aayan277.github.io/zenith/

## Features

- **Orbit view**: 3D Earth with every tracked satellite, coloured by category, day/night terminator and clouds.
- **Sky view**: what is above your horizon right now: satellites, stars, constellations, planets, Sun and Moon.
- **Tonight panel**: stargazing score, visible ISS passes, Moon and Sun times, cloud forecast.
- **Search** (`Ctrl/⌘ K` or `/`): satellites, planets, stars and constellations.
- **Layers**: toggle categories (stations, Starlink, navigation, weather, science, comms, imaging, rocket bodies, debris).
- **Time machine**: scrub from −12 h to +48 h, run at 1× / 60× / 600× / 3600×, or reverse.
- **Detail panel** with live altitude, speed, position and next pass for the selected object.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl/⌘ K`, `/` | Open search |
| `Esc` | Close search / popover / details |
| `Space` | Pause / resume time |
| `←` / `→` | Step −10 / +10 minutes |
| `L` | Back to live |

## Run locally

No build step. Serve the folder with any static server:

```sh
npx --yes http-server -p 8080 -c-1 .
# open http://localhost:8080
```

Refresh the satellite catalog yourself (Node 20+, zero dependencies):

```sh
node scripts/fetch-sats.mjs                    # full CelesTrak refresh
node scripts/fetch-sats.mjs --fallback-only --max-pages 60 --allow-small   # test the fallback source
```

Flags: `--out <file>`, `--allow-small` (write even if < 2000 satellites), `--fallback-only`,
`--max-pages N` (cap fallback requests), `--max-age-days N` (fallback staleness cut-off, default 30), `--quiet`.

## Data sources

- **Satellites**: [CelesTrak](https://celestrak.org) GP data (TLE). Groups are fetched sequentially, 1 s apart,
  and classified into categories with first-match-wins priority (stations, science, weather, navigation, earth imaging,
  Starlink, comms, debris, everything else). Rocket bodies (`R/B`) are always "rocket". Objects in CelesTrak's `visual`
  group are flagged `bright`.
- **Fallback**: [tle.ivanstanojevic.me](https://tle.ivanstanojevic.me) if CelesTrak is unreachable or returns fewer than
  2000 objects. Records older than 30 days are dropped and categories are guessed from names.
- **Sky data**: d3-celestial. **Positions**: astronomy-engine and satellite.js (SGP4).

See [CREDITS.md](CREDITS.md) for everything else.

## How the data refresh works

`.github/workflows/pages.yml` deploys on every push to `main` and also every 6 hours on a schedule. Each
deploy runs `scripts/fetch-sats.mjs` to write fresh TLEs straight into the built site, so orbits stay current
without committing a ~3 MB file to git every few hours. If the fetch fails, the committed `data/sats.json` + `data/sats-core.json`
snapshot is deployed instead (refresh it occasionally with `node scripts/fetch-sats.mjs`).
The script refuses to overwrite the catalog with a suspiciously small result.

## Deploy to GitHub Pages

1. Push the repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (or run the *Deploy to GitHub Pages* workflow). The site appears at
   `https://<user>.github.io/<repo>/`.
4. In **Settings → Actions → General**, make sure workflow permissions allow the data bot to push
   (the workflow requests `contents: write` itself).

## License

[MIT](LICENSE). Data and assets carry their own licenses; see [CREDITS.md](CREDITS.md).
