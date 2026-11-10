// Telescope registry for the photo gallery (js/gallery/index.js).
//
// Image source: NASA Image and Video Library (https://images-api.nasa.gov, CORS-open, no key).
// Each telescope carries a search config that js/gallery/source.js turns into a paged, filtered feed:
//   search.sources   ordered list of API queries (paged one after the other; results de-duplicated)
//                    each is { keywords?, center?, q?, year_start?, ... } = raw API params
//   search.include   RegExp that title + keywords + description must match (guards q-based sources)
//   search.excludeTitle / excludeDesc   extra RegExps on top of COMMON_EXCLUDE
//   search.centers   RegExp of allowed NASA centres (default DEFAULT_CENTERS: drops HQ/KSC/JSC press + launch photos)
//   search.allowArt  keep artist concepts / illustrations (exoplanet missions have little else)
//   curated          nasa_ids shown first (and the only content when sources is [])
//   site             the mission's own site (linked from the footer: the NASA library is only a slice of what each mission publishes)
//   emptyNote        message when the library holds nothing worth showing
// Quality notes were measured 2026-11 by reading the top ~30 results of each query; see the per-telescope `quality`.
//
// NORAD ids: verified against data/sats.json. Swift (28485), TESS (43435) and SOHO (23726) are NOT in the
// catalog (checked 2026-11), so they carry `norad: null`; their ids are kept in `noradUnlisted` for the day they are.

// Title words that mean "photo of the hardware / people / event", not a science image.
export const COMMON_EXCLUDE = /engineer|clean[- ]?room|launch|lift[- ]?off|roll[- ]?out|\bmodels?\b|mirror|\bteam\b|briefing|\btests?\b|testing|technician|assembl|integrat|uncrat|conference|town hall|control room|history of|servicing mission|fairing|nose cone|astronaut|\bcrew|\bpress\b|screening|interview|portrait|\bworkers?\b|facility|shipping|transport|install|deployment|mating|cryocooler|poses for|packing|inspecting|kwajalein|sunshield|backplane|spacecraft (arrival|move|lift)|\bvideo\b/i;
// Artist impressions: excluded unless the telescope only produces those (Kepler, TESS).
export const ART_EXCLUDE = /artist|illustration|\bconcept\b|rendering/i;
// NASA centres whose uploads are science imagery. HQ / KSC / JSC / AFRC / SSC are event + launch photography.
export const DEFAULT_CENTERS = /^(JPL|GSFC|ARC|MSFC|STScI|SAO|CXC)/i;

const T = (o) => Object.freeze({ norad: null, curated: [], quality: '', suggest: ['galaxy', 'nebula', 'supernova'], ...o });

export const TELESCOPES = [
  T({
    key: 'hubble', site: 'https://science.nasa.gov/mission/hubble/', name: 'Hubble Space Telescope', short: 'Hubble', norad: 20580, accent: '#5ce1ff',
    agency: 'NASA / ESA', launch: 1990, orbit: 'Low Earth orbit · 540 km',
    bands: 'Ultraviolet · Visible · Near-infrared',
    blurb: 'Over three decades above the atmosphere, Hubble has given us the most recognisable portraits of the cosmos.',
    suggest: ['nebula', 'galaxy', 'Jupiter', 'supernova', 'star cluster'],
    search: {
      sources: [
        { keywords: 'Hubble Space Telescope', center: 'GSFC' },   // GSFC archive first: deep-sky classics
        { keywords: 'Hubble Space Telescope', center: 'JPL' },
        { keywords: 'Hubble Space Telescope' },                    // catch-all (STScI etc.), de-duplicated
      ],
      excludeTitle: /^hubble space telescope$|^hubble$/i,
    },
    quality: 'good: ~450 usable images, deep-sky classics first, then JPL planetary and multi-mission composites',
  }),
  T({
    key: 'jwst', site: 'https://science.nasa.gov/mission/webb/', name: 'James Webb Space Telescope', short: 'Webb', norad: null, accent: '#ffb347',
    agency: 'NASA / ESA / CSA', launch: 2021, orbit: 'Sun–Earth L2 · 1.5 million km',
    bands: 'Near- & mid-infrared · 0.6–28 µm',
    blurb: 'A 6.5 m gold mirror at L2, seeing the first galaxies, hidden nurseries and exoplanet atmospheres in infrared.',
    suggest: ['nebula', 'galaxy', 'dark matter'],
    // The NASA library holds very few Webb science images (most "JWST" hits are hardware/press photos), so this is curated.
    curated: ['carina_nebula', 'southern_ring_nebula', 'webb_first_deep_field', 'PIA25432', 'PIA26702', 'PIA26703', 'wasp-96_b_transmission_spectrum'],
    search: { sources: [] },
    quality: 'thin: the library has only ~7 real Webb science images; curated by nasa_id (search returns hardware/press photos)',
  }),
  T({
    key: 'chandra', site: 'https://chandra.si.edu/photo/', name: 'Chandra X-ray Observatory', short: 'Chandra', norad: 25867, accent: '#a78bff',
    agency: 'NASA', launch: 1999, orbit: 'Highly elliptical · up to 139,000 km',
    bands: 'X-ray · 0.1–10 keV',
    blurb: 'Sharper than any other X-ray telescope: exploded stars, black-hole jets and gas hotter than a million degrees.',
    suggest: ['supernova', 'black hole', 'Cassiopeia', 'galaxy cluster'],
    search: { sources: [{ keywords: 'Chandra X-ray Observatory' }], include: /chandra|\bCXC\b/i, excludeTitle: /^chandra\b/i },
    quality: 'very good: science-image dominated (JPL/CXC); History-of-Chandra MSFC archive filtered out',
  }),
  T({
    key: 'fermi', site: 'https://science.nasa.gov/mission/fermi/', name: 'Fermi Gamma-ray Space Telescope', short: 'Fermi', norad: 33053, accent: '#ff6fd8',
    agency: 'NASA / DOE / international', launch: 2008, orbit: 'Low Earth orbit · 550 km',
    bands: 'Gamma-ray · 8 keV–300 GeV',
    blurb: 'Maps the whole sky in gamma rays every three hours: blazars, pulsars, supernova remnants and the giant Fermi Bubbles.',
    suggest: ['blazar', 'pulsar', 'supernova', 'galaxy'],
    search: { sources: [{ keywords: 'Fermi' }], include: /fermi|gamma/i },
    quality: 'good but small: ~15 images, almost all gamma-ray maps and composites',
  }),
  T({
    key: 'swift', site: 'https://science.nasa.gov/mission/swift/', name: 'Neil Gehrels Swift Observatory', short: 'Swift', norad: null /* 28485: not in catalog */, noradUnlisted: 28485, accent: '#ffd166',
    agency: 'NASA / UK / Italy', launch: 2004, orbit: 'Low Earth orbit · ~450 km',
    bands: 'Gamma-ray · X-ray · UV · Optical',
    blurb: 'A rapid-response sentinel that slews within a minute to catch gamma-ray bursts and dying stars.',
    suggest: ['black hole', 'burst', 'supernova'],
    search: { sources: [{ keywords: 'Swift' }, { q: 'gamma ray burst', center: 'GSFC' }], include: /\bswift\b/i, centers: /^(JPL|GSFC)/i, excludeTitle: /diagram|^hubble|death spiral/i },
    quality: 'poor: only a handful of science images in the library (the rest is 2004 launch photos, filtered out)',
  }),
  T({
    key: 'nustar', site: 'https://science.nasa.gov/mission/nustar/', name: 'NuSTAR', short: 'NuSTAR', norad: 38358, accent: '#ff5c7a',
    agency: 'NASA', launch: 2012, orbit: 'Low Earth orbit · 600 km',
    bands: 'Hard X-ray · 3–79 keV',
    blurb: 'The first telescope to focus high-energy X-rays, revealing buried black holes and the radioactive glow of supernovae.',
    suggest: ['black hole', 'supernova', 'galaxy'],
    search: { sources: [{ keywords: 'NuSTAR' }], excludeTitle: /spacecraft|orbits|doll|journey|rocket|stargazer|inches|hitches/i },
    quality: 'good: ~25 usable images (JPL), launch/integration/illustration entries filtered out',
  }),
  T({
    key: 'tess', site: 'https://science.nasa.gov/mission/tess/', name: 'TESS', short: 'TESS', norad: null /* 43435: not in catalog */, noradUnlisted: 43435, accent: '#5ce1a5',
    agency: 'NASA / MIT', launch: 2018, orbit: 'High elliptical · 2:1 lunar resonance',
    bands: 'Optical – near-infrared · 600–1000 nm',
    blurb: 'Watches 200,000 bright stars for the tiny dips that betray transiting exoplanets. Its results are light curves, so the library shows what they revealed.',
    suggest: ['exoplanet', 'habitable zone'],
    search: { sources: [{ keywords: 'TESS', center: 'JPL' }, { q: 'tess', center: 'JPL' }], include: /\btess\b|\btoi\b/i, allowArt: true },
    quality: 'thin: ~3 items (TOI 700 diagrams/concepts); all launch photos filtered out',
  }),
  T({
    key: 'spitzer', site: 'https://science.nasa.gov/mission/spitzer/', name: 'Spitzer Space Telescope', short: 'Spitzer', norad: null, accent: '#ff8a65',
    agency: 'NASA / JPL', launch: 2003, retired: 2020, orbit: 'Earth-trailing solar orbit · retired Jan 2020',
    bands: 'Infrared · 3.6–160 µm',
    blurb: 'Retired in 2020 after 16 years of seeing through dust: star nurseries, brown dwarfs and the first exoplanet weather maps.',
    suggest: ['nebula', 'galaxy', 'exoplanet', 'Orion'],
    search: { sources: [{ keywords: 'Spitzer Space Telescope' }] },
    quality: 'excellent: large JPL set, nearly all science images',
  }),
  T({
    key: 'kepler', site: 'https://science.nasa.gov/mission/kepler/', name: 'Kepler Space Telescope', short: 'Kepler', norad: null, accent: '#7fa7ff',
    agency: 'NASA', launch: 2009, retired: 2018, orbit: 'Earth-trailing solar orbit · retired Oct 2018',
    bands: 'Visible light photometry',
    blurb: 'Retired in 2018 after finding thousands of planets. It measured starlight rather than taking pictures, so these are the worlds it uncovered.',
    suggest: ['habitable zone', 'Kepler-186', 'Earth-size'],
    search: {
      sources: [{ keywords: 'Kepler', center: 'JPL' }, { keywords: 'Kepler', center: 'ARC' }],
      include: /kepler|\bk2\b/i, allowArt: true,
      excludeDesc: /technicians|space farm|\bvips?\b|interview|clean room|table top|activities at|\bNBC\b/i,
    },
    quality: 'fair: ~45 artist concepts and charts of Kepler discoveries (no real "photos" exist); ARC event photos filtered out',
  }),
  T({
    key: 'ixpe', site: 'https://science.nasa.gov/mission/ixpe/', name: 'IXPE', short: 'IXPE', norad: 49954, accent: '#9ab8d8',
    agency: 'NASA / ASI', launch: 2021, orbit: 'Low Earth orbit · 600 km',
    bands: 'X-ray polarisation · 2–8 keV',
    blurb: 'Measures the polarisation of X-rays to map magnetic fields around black holes and neutron stars.',
    suggest: [],
    search: { sources: [] },
    emptyNote: 'The NASA image library has no IXPE science images yet, only launch photography. Chandra’s X-ray gallery is the closest match.',
    emptyLink: { key: 'chandra', label: 'See Chandra’s X-ray images' },
    quality: 'none: library holds only 2021 launch/prelaunch photos; shows an empty state pointing to Chandra',
  }),
  T({
    key: 'soho', site: 'https://soho.nascom.nasa.gov/', name: 'SOHO', short: 'SOHO', norad: null /* 23726: not in catalog (Sun–Earth L1) */, noradUnlisted: 23726, accent: '#ffcf5c',
    agency: 'ESA / NASA', launch: 1995, orbit: 'Sun–Earth L1 · 1.5 million km',
    bands: 'Extreme UV · Visible coronagraph',
    blurb: 'Parked at L1 since 1995, SOHO watches the Sun’s surface and corona, and has discovered more than 5,000 comets.',
    suggest: ['CME', 'comet', 'prominence'],
    search: { sources: [{ keywords: 'SOHO' }, { q: 'soho' }], include: /\bsoho\b/i, centers: /^(JPL|GSFC)/i, excludeTitle: /spacecraft|orbit/i },
    quality: 'fair: ~10 decent solar images (CMEs, prominences, comets)',
  }),
  T({
    key: 'sdo', site: 'https://sdo.gsfc.nasa.gov/', name: 'Solar Dynamics Observatory', short: 'SDO', norad: 36395, accent: '#ff9f5c',
    agency: 'NASA', launch: 2010, orbit: 'Geosynchronous · 36,000 km',
    bands: 'Extreme UV · UV · Visible magnetograms',
    blurb: 'Photographs the Sun every 0.75 seconds in 10 wavelengths: flares, prominences, coronal holes and sunspots.',
    suggest: ['prominence', 'flare', 'sunspot', 'coronal hole'],
    search: { sources: [{ keywords: 'Solar Dynamics Observatory' }, { keywords: 'SDO' }], excludeTitle: /spacecraft/i },
    quality: 'excellent: ~120 solar images (JPL + GSFC)',
  }),
];

const BY_KEY = new Map(TELESCOPES.map(t => [t.key, t]));
const BY_NORAD = new Map(TELESCOPES.filter(t => t.norad).map(t => [t.norad, t]));

export const getTelescope = key => BY_KEY.get(key) || null;
/** Registry entry for a satellite's NORAD id, or null. */
export const telescopeForNorad = id => BY_NORAD.get(+id) || null;
