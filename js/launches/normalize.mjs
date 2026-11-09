// Pure helpers shared by the browser (js/launches/data.js) and scripts/fetch-launches.mjs (Node 20, no deps).
// Turns a Launch Library 2 launch object (any mode) into the slim record Zenith stores and caches.

export const API_VERSIONS = ['2.3.0', '2.2.0'];
export const API_BASE = 'https://ll.thespacedevs.com';

const STATUS_KEYS = { go: 'go', tbc: 'tbc', tbd: 'tbd', hold: 'hold', 'in flight': 'flight', success: 'success', failure: 'failure', 'partial failure': 'failure' };
export const statusKey = abbrev => STATUS_KEYS[String(abbrev || '').toLowerCase()] || 'tbd';

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

function pickWebcast(l) {
  const vids = Array.isArray(l.vid_urls) ? l.vid_urls.filter(v => v && /^https?:\/\//i.test(v.url || '')) : [];
  if (!vids.length) return null;
  vids.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return (vids.find(v => /youtube|youtu\.be|nasa|spacex|x\.com/i.test(v.url)) || vids[0]).url;
}

/** Slim launch record. `net` is epoch ms (or null). */
export function normalizeLaunch(l) {
  if (!l || !l.id) return null;
  const pad = l.pad || {}, loc = pad.location || {}, cfg = l.rocket?.configuration || {}, m = l.mission || {};
  const lat = Number(pad.latitude ?? loc.latitude), lon = Number(pad.longitude ?? loc.longitude);
  const net = Date.parse(l.net);
  const [rocketPart, ...rest] = String(l.name || '').split(' | ');
  const img = l.image || {};
  return {
    id: String(l.id),
    name: String(l.name || 'Launch'),
    mission: String(m.name || rest.join(' | ') || l.name || 'Launch'),
    rocket: String(cfg.name || rocketPart || 'Rocket'),
    rocketFull: String(cfg.full_name || cfg.name || rocketPart || ''),
    provider: String(l.launch_service_provider?.name || ''),
    providerAbbrev: String(l.launch_service_provider?.abbrev || ''),
    net: Number.isFinite(net) ? net : null,
    windowStart: Date.parse(l.window_start) || null,
    windowEnd: Date.parse(l.window_end) || null,
    precision: String(l.net_precision?.abbrev || 'MIN'),
    status: { abbrev: String(l.status?.abbrev || 'TBD'), name: String(l.status?.name || ''), key: statusKey(l.status?.abbrev) },
    pad: String(pad.name || ''),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    location: String(loc.name || ''),
    country: String(pad.country?.alpha_2_code || loc.country?.alpha_2_code || ''),
    image: img.thumbnail_url || img.image_url || null,
    imageCredit: img.credit || '',
    orbit: m.orbit ? { name: String(m.orbit.name || ''), abbrev: String(m.orbit.abbrev || '') } : null,
    missionType: String(m.type || ''),
    desc: clip(m.description, 700),
    webcast: pickWebcast(l),
    live: !!l.webcast_live,
    probability: Number.isFinite(l.probability) ? l.probability : null,
    failReason: clip(l.failreason, 200),
    info: Array.isArray(l.info_urls) && l.info_urls[0]?.url ? l.info_urls[0].url : null,
  };
}

export function normalizeList(json) {
  const out = [];
  for (const r of json?.results || []) { const n = normalizeLaunch(r); if (n && n.lat != null && n.lon != null) out.push(n); }
  return out;
}
