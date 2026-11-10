// Shared app state + tiny pub/sub store. Every module talks through this.
// Keep it dependency-free.

export const CATEGORIES = {
  stations:   { label: 'Space Stations', color: '#ffb347', size: 3.0 },
  starlink:   { label: 'Starlink',       color: '#7fa7ff', size: 1.0 },
  navigation: { label: 'Navigation',     color: '#5ce1a5', size: 1.4 },
  weather:    { label: 'Weather',        color: '#5cd6ff', size: 1.4 },
  science:    { label: 'Science',        color: '#e07bff', size: 1.8 },
  comms:      { label: 'Comms',          color: '#9ab8d8', size: 1.1 },
  earthobs:   { label: 'Earth Imaging',  color: '#ffe066', size: 1.3 },
  rocket:     { label: 'Rocket Bodies',  color: '#ff8a65', size: 1.0 },
  debris:     { label: 'Debris',         color: '#ff5c7a', size: 0.8 },
  other:      { label: 'Other',          color: '#b8c4d6', size: 1.0 },
};

const listeners = new Map(); // key -> Set<fn>

const state = {
  view: 'globe',            // 'globe' | 'sky' | 'system'
  // Observer location. `source`: 'gps' | 'search' | 'default'
  location: { lat: 51.4779, lon: -0.0015, elevM: 0, name: 'Greenwich, UK', source: 'default' },
  // Currently selected object or null.
  //   { kind: 'sat',  id: 25544 }
  //   { kind: 'body', id: 'Mars' }      (Sun, Moon, Mercury..Neptune)
  //   { kind: 'star', id: 32349 }       (HIP number)
  //   { kind: 'constellation', id: 'Ori' }
  selection: null,
  // Which satellite categories are visible (by CATEGORIES key).
  filters: { stations: true, starlink: true, navigation: true, weather: true, science: true,
             comms: true, earthobs: true, rocket: true, debris: false, other: true },
  // When true, only "notable" satellites are shown (named famous objects,
  // large radar cross-section, or bright). See sat.notable / sat.size in sats.json.
  highlightsOnly: false,
  catalogReady: false,
};

export function get(key) { return state[key]; }

export function set(key, value) {
  state[key] = value;
  emit(key, value);
}

export function patch(key, partial) {
  state[key] = { ...state[key], ...partial };
  emit(key, state[key]);
}

export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

// Generic events that are not state (e.g. 'focus-sat', 'toast').
export function emit(key, value) {
  const set_ = listeners.get(key);
  if (set_) for (const fn of set_) { try { fn(value); } catch (e) { console.error(`[state:${key}]`, e); } }
}

// ---- Detail providers -------------------------------------------------------
// The detail panel (js/ui/detail.js) renders whatever is selected by asking
// the provider registered for selection.kind. Providers are called repeatedly
// (~2x/sec) while selected so values can be live.
//   provider(selection, nowMs) -> {
//     title: string, subtitle?: string, color?: css color, icon?: 'sat'|'planet'|'star'|'moon'|'sun'|'constellation',
//     stats: [{ label, value, unit? }],      // big live numbers (2-6)
//     rows:  [{ label, value }],             // smaller key/value rows
//     note?: string,                         // short paragraph
//     actions?: [{ label, onClick }]
//   } | null
const providers = new Map();
export function registerDetailProvider(kind, fn) { providers.set(kind, fn); }
export function getDetail(selection, nowMs) {
  if (!selection) return null;
  const p = providers.get(selection.kind);
  return p ? p(selection, nowMs) : null;
}

// Persist location + filters
try {
  const saved = JSON.parse(localStorage.getItem('skywatch:prefs') || 'null');
  if (saved?.location) state.location = saved.location;
  if (saved?.filters) state.filters = { ...state.filters, ...saved.filters };
  if (typeof saved?.highlightsOnly === 'boolean') state.highlightsOnly = saved.highlightsOnly;
} catch {}
const persist = () => { if (state.location?.source === 'link') return; /* a shared link's place is temporary */ try { localStorage.setItem('skywatch:prefs', JSON.stringify({ location: state.location, filters: state.filters, highlightsOnly: state.highlightsOnly })); } catch {} };
on('location', persist);
on('filters', persist);
on('highlightsOnly', persist);

if (typeof window !== 'undefined') window.__skywatchState = state; // debugging
