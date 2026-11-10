// Imagery sources and their tilings. Everything here is pure math / data (no three.js, no DOM).
//
//   bm     NASA GIBS Blue Marble: Shaded Relief + Bathymetry (public domain). EPSG:4326, 512 px tiles, "500m" matrix set.
//          GIBS tile matrix (GetCapabilities): level z has tiles of 288/2^z degrees, matrices 2x1, 3x2, 5x3, 10x5, 20x10 ... 160x80
//          for z = 0..7 (z 7 is the last level of the 500m set: ~0.0044 deg/px, ~490 m). Levels 0-2 overhang the globe, so the
//          quadtree starts at z 3 (10 x 5 tiles of 36 deg).
//   night  NASA GIBS VIIRS Black Marble 2016 (PNG, same 500m matrix set, levels 3..7). Only requested for tiles that are (partly) dark.
//   s2     EOX Sentinel-2 cloudless 2016 (CC BY 4.0), EPSG:3857 "GoogleMapsCompatible", 256 px tiles, z 0..15+. Only used above
//          the finest GIBS level (z >= 9, ~300 m/px and finer) and only between +-85.05 deg (Web Mercator limit): the polar caps
//          fall back to the GIBS layer.
//
// Tile (z, x, y): x grows east, y grows south, like the WMTS TileCol / TileRow of both services.

const D2R = Math.PI / 180;
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/';
const EOX = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/';

export const MERC_MAX_LAT = Math.atan(Math.sinh(Math.PI)) / D2R;     // 85.0511 deg
const mercY = (latRad) => Math.log(Math.tan(Math.PI / 4 + latRad / 2));       // radians of "northing" (unit sphere)
const mercLat = (y) => Math.atan(Math.sinh(y));

// GIBS 500m: 288 deg at level 0, halving each level.
const gibsDeg = (z) => 288 / (1 << z);

export const SOURCES = {
  bm: {
    id: 'bm', scheme: '4326', tilePx: 512, roots: 3, minRender: 3, maxZ: 7,
    url: (z, x, y) => `${GIBS}BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/500m/${z}/${y}/${x}.jpeg`,
  },
  night: {
    id: 'night', scheme: '4326', tilePx: 512, roots: 3, minRender: 3, maxZ: 7,
    url: (z, x, y) => `${GIBS}VIIRS_Black_Marble/default/2016-01-01/500m/${z}/${y}/${x}.png`,
  },
  s2: {
    id: 's2', scheme: '3857', tilePx: 256, roots: 0, minRender: 9, maxZ: 15,
    url: (z, x, y) => `${EOX}${z}/${y}/${x}.jpg`,
  },
};

/** Tile counts at level z. */
export function matrix(src, z) {
  if (src.scheme === '3857') { const n = 2 ** z; return { cols: n, rows: n }; }
  const d = gibsDeg(z);
  return { cols: Math.ceil(360 / d - 1e-9), rows: Math.ceil(180 / d - 1e-9) };
}

/** Geographic bounds of a tile in degrees, plus (for 3857) the Mercator northing of its north/south edges. */
export function bounds(src, z, x, y) {
  if (src.scheme === '3857') {
    const n = 2 ** z;
    const lonW = x / n * 360 - 180, lonE = (x + 1) / n * 360 - 180;
    const yN = Math.PI * (1 - 2 * y / n), yS = Math.PI * (1 - 2 * (y + 1) / n);
    return { lonW, lonE, latN: mercLat(yN) / D2R, latS: mercLat(yS) / D2R, yN, yS, merc: true };
  }
  const d = gibsDeg(z);
  const lonW = -180 + x * d, latN = 90 - y * d;
  return { lonW, lonE: lonW + d, latN, latS: latN - d, merc: false };
}

/** Latitude (deg) at fraction v (0 = north edge, 1 = south edge) of a tile: linear in latitude (4326) or in Mercator northing (3857). */
export function latAt(b, v) {
  if (b.merc) return mercLat(b.yN + (b.yS - b.yN) * v) / D2R;
  return b.latN + (b.latS - b.latN) * v;
}

/** Angular size (radians) of one texel of the tile, measured along a meridian (the larger of the two directions). */
export function texelRad(src, z, latMidDeg) {
  if (src.scheme === '3857') return (2 * Math.PI / (src.tilePx * 2 ** z)) * Math.cos(latMidDeg * D2R);
  return gibsDeg(z) * D2R / src.tilePx;
}

/** Roots of the quadtree: [z, x, y] list. */
export function rootTiles(src) {
  const z = src.roots, { cols, rows } = matrix(src, z), out = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out.push([z, x, y]);
  return out;
}
