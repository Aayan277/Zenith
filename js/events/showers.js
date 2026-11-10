// Major meteor showers (IAU working list / IMO calendar values). Static table + per-year peak dates.
//  sl     solar longitude of the peak, J2000.0 (IMO convention). Converted to the equinox of date to find the instant.
//  start/end  [month, day] of the active range (start may be in the previous year for the Quadrantids)
//  zhr    zenithal hourly rate at peak (ideal sky, radiant at zenith)
//  ra/dec radiant at peak, degrees (J2000; drift over the active range is ignored)
//  speed  atmospheric entry speed, km/s
//  hw     half-width of the peak profile in hours (rate halves this far from the peak)
//  best   plain-language best viewing hours
const A = () => window.Astronomy;

export const SHOWERS = [
  { id: 'Quadrantids',      name: 'Quadrantids',        sl: 283.15, start: [12, 28], end: [1, 12],  zhr: 110, ra: 230, dec: 49,  speed: 41, parent: '2003 EH1 (asteroid)',        hw: 4,   best: 'After midnight to dawn', note: 'Sharp, short peak of a few hours; blue-ish medium-speed meteors.' },
  { id: 'Lyrids',           name: 'Lyrids',             sl: 32.32,  start: [4, 14],  end: [4, 30],  zhr: 18,  ra: 271, dec: 34,  speed: 49, parent: 'C/1861 G1 Thatcher',        hw: 12,  best: 'Late night to dawn', note: 'Occasional bright fireballs and persistent trains.' },
  { id: 'Eta Aquariids',    name: 'Eta Aquariids',      sl: 45.5,   start: [4, 19],  end: [5, 28],  zhr: 50,  ra: 338, dec: -1,  speed: 66, parent: '1P/Halley',                 hw: 48,  best: 'The 2 hours before dawn', note: 'Fast meteors with long trains. Better from the southern hemisphere and the tropics.' },
  { id: 'Delta Aquariids',  name: 'Southern Delta Aquariids', sl: 125.0, start: [7, 12], end: [8, 23], zhr: 25, ra: 340, dec: -16, speed: 41, parent: '96P/Machholz',              hw: 72,  best: 'After midnight', note: 'Broad, gentle maximum. Best from the southern hemisphere and low northern latitudes.' },
  { id: 'Perseids',         name: 'Perseids',           sl: 140.0,  start: [7, 17],  end: [8, 24],  zhr: 100, ra: 48,  dec: 58,  speed: 59, parent: '109P/Swift-Tuttle',         hw: 30,  best: 'After midnight to dawn', note: 'The year\'s most popular shower: fast, bright, many fireballs, in warm summer nights.' },
  { id: 'Draconids',        name: 'Draconids',          sl: 195.4,  start: [10, 6],  end: [10, 10], zhr: 10,  ra: 262, dec: 54,  speed: 20, parent: '21P/Giacobini-Zinner',      hw: 12,  best: 'Early evening', note: 'Slow meteors; the radiant is highest in the evening. Rare outbursts can reach hundreds per hour.' },
  { id: 'Orionids',         name: 'Orionids',           sl: 208.0,  start: [10, 2],  end: [11, 7],  zhr: 20,  ra: 95,  dec: 16,  speed: 66, parent: '1P/Halley',                 hw: 36,  best: 'After midnight to dawn', note: 'Fast, often with trains. Debris from Halley\'s comet, like the Eta Aquariids.' },
  { id: 'S. Taurids',       name: 'Southern Taurids',   sl: 223.0,  start: [9, 20],  end: [11, 20], zhr: 5,   ra: 52,  dec: 13,  speed: 27, parent: '2P/Encke',                  hw: 120, best: 'Around local midnight', note: 'Few meteors but many slow, bright fireballs.' },
  { id: 'N. Taurids',       name: 'Northern Taurids',   sl: 230.0,  start: [10, 20], end: [12, 10], zhr: 5,   ra: 58,  dec: 22,  speed: 29, parent: '2P/Encke',                  hw: 120, best: 'Around local midnight', note: 'Few meteors but many slow, bright fireballs.' },
  { id: 'Leonids',          name: 'Leonids',            sl: 235.27, start: [11, 6],  end: [11, 30], zhr: 15,  ra: 152, dec: 22,  speed: 71, parent: '55P/Tempel-Tuttle',         hw: 14,  best: 'After midnight to dawn', note: 'The fastest of the major showers. Storms in 1833, 1966 and 1999-2002.' },
  { id: 'Geminids',         name: 'Geminids',           sl: 262.2,  start: [12, 4],  end: [12, 20], zhr: 150, ra: 112, dec: 33,  speed: 35, parent: '3200 Phaethon (asteroid)',  hw: 18,  best: 'Around 2 AM, local midnight to dawn', note: 'Usually the richest shower of the year: bright, multicoloured, medium-speed.' },
  { id: 'Ursids',           name: 'Ursids',             sl: 270.7,  start: [12, 17], end: [12, 26], zhr: 10,  ra: 217, dec: 76,  speed: 33, parent: '8P/Tuttle',                 hw: 10,  best: 'Before dawn', note: 'A quiet shower for northern observers, with a circumpolar radiant.' },
];
export const showerById = id => SHOWERS.find(s => s.id === id || s.name === id) || null;

const PRECESSION_DEG_PER_YEAR = 0.013969;
const cache = new Map();

/** Peak instant (ms, UTC) of a shower in a given calendar year (the Sun passes each longitude once a year). */
export function peakMs(sh, year) {
  const ym = year + 0.5;
  const target = (((sh.sl + PRECESSION_DEG_PER_YEAR * (ym - 2000)) % 360) + 360) % 360;
  const t = A().SearchSunLongitude(target, new Date(Date.UTC(year, 0, 1)), 360);
  return t ? t.date.getTime() : null;
}

/**
 * Showers whose peak falls in `year` (UTC), sorted by peak.
 * @returns {{id:string,name:string,peak:number,start:number,end:number,zhr:number,ra:number,dec:number,speed:number,parent:string,best:string,note:string,hw:number}[]}
 */
export function showersForYear(year) {
  if (cache.has(year)) return cache.get(year);
  const out = [];
  for (const sh of SHOWERS) {
    const peak = peakMs(sh, year); if (peak == null) continue;
    const wraps = sh.start[0] > sh.end[0];             // Quadrantids: Dec 28 (previous year) to Jan 12
    const start = Date.UTC(wraps ? year - 1 : year, sh.start[0] - 1, sh.start[1]);
    const end = Date.UTC(year, sh.end[0] - 1, sh.end[1], 23, 59, 59);
    out.push({ id: sh.id, name: sh.name, peak, start, end, zhr: sh.zhr, ra: sh.ra, dec: sh.dec, speed: sh.speed, parent: sh.parent, best: sh.best, note: sh.note, hw: sh.hw });
  }
  out.sort((a, b) => a.peak - b.peak);
  cache.set(year, out);
  return out;
}
