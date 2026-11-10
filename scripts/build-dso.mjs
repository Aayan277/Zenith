#!/usr/bin/env node
// Builds data/sky/dso.json: the 110 Messier objects plus famous NGC / IC objects.
// Source table written from standard catalogue values (J2000 positions, visual magnitudes, major-axis sizes,
// rounded distances); no network access needed.  Run:  node scripts/build-dso.mjs
//
// Row format (pipe separated):
//   id | common name | type | RA (h m.m) | Dec (±d m) | mag | size arcmin | constellation abbr | distance ly | also known as | description
// type: G galaxy, EN emission nebula, PN planetary nebula, OC open cluster, GC globular cluster, SNR supernova remnant
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { G: 'galaxy', EN: 'emission nebula', PN: 'planetary nebula', OC: 'open cluster', GC: 'globular cluster', SNR: 'supernova remnant' };
const CON = {
  And: 'Andromeda', Aqr: 'Aquarius', Ara: 'Ara', Aur: 'Auriga', Cam: 'Camelopardalis', Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus',
  Cep: 'Cepheus', Cet: 'Cetus', CMa: 'Canis Major', CVn: 'Canes Venatici', Cnc: 'Cancer', Com: 'Coma Berenices', Crv: 'Corvus', Cyg: 'Cygnus', Dor: 'Dorado',
  Dra: 'Draco', Gem: 'Gemini', Her: 'Hercules', Hya: 'Hydra', Leo: 'Leo', Lep: 'Lepus', Lyr: 'Lyra', Mon: 'Monoceros', Oph: 'Ophiuchus', Ori: 'Orion',
  Peg: 'Pegasus', Per: 'Perseus', Psc: 'Pisces', Pup: 'Puppis', Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum', Ser: 'Serpens', Sge: 'Sagitta',
  Sgr: 'Sagittarius', Tau: 'Taurus', Tri: 'Triangulum', Tuc: 'Tucana', UMa: 'Ursa Major', Vir: 'Virgo', Vul: 'Vulpecula', Vel: 'Vela',
};

// Position angle (deg, N through E) and axis ratio b/a of the brighter galaxies (symbol shape only).
const SHAPE = {
  M31: [35, 0.32], M32: [0, 0.85], M110: [170, 0.55], M33: [23, 0.6], M49: [0, 0.8], M51: [163, 0.75], M58: [0, 0.75], M59: [0, 0.6], M60: [0, 0.8], M61: [0, 0.85],
  M63: [105, 0.55], M64: [120, 0.55], M65: [174, 0.35], M66: [173, 0.5], M74: [25, 0.9], M77: [70, 0.85], M81: [157, 0.55], M82: [65, 0.25], M83: [45, 0.85],
  M84: [135, 0.85], M85: [0, 0.7], M86: [127, 0.65], M87: [0, 0.9], M88: [135, 0.5], M89: [0, 0.95], M90: [150, 0.4], M94: [0, 0.8], M95: [10, 0.75], M96: [172, 0.6],
  M98: [153, 0.35], M99: [58, 0.85], M100: [153, 0.85], M101: [0, 0.95], M102: [128, 0.3], M104: [89, 0.4], M105: [0, 0.85], M106: [150, 0.5], M108: [80, 0.25], M109: [88, 0.6],
  'NGC 253': [51, 0.25], 'NGC 5128': [35, 0.7], 'NGC 4565': [135, 0.12], 'NGC 891': [22, 0.2], 'NGC 4631': [86, 0.2],
};

const ROWS = `
M1|Crab Nebula|SNR|5 34.5|+22 01|8.4|6|Tau|6500|NGC 1952|Remnant of the supernova that blazed in the daytime sky in 1054 AD, powered by a pulsar spinning 30 times a second.
M2||GC|21 33.5|-0 49|6.3|16|Aqr|37500|NGC 7089|One of the richest globular clusters, about 150,000 stars in a tight ball.
M3||GC|13 42.2|+28 23|6.2|18|CVn|34000|NGC 5272|Half a million stars; famous among astronomers for its many variable stars.
M4||GC|16 23.6|-26 32|5.6|36|Sco|7200|NGC 6121|The closest globular cluster to Earth, just west of red Antares.
M5||GC|15 18.6|+2 05|5.6|23|Ser|24500|NGC 5904|One of the oldest globular clusters, about 13 billion years old.
M6|Butterfly Cluster|OC|17 40.1|-32 15|4.2|25|Sco|1600|NGC 6405|A bright open cluster whose star pattern resembles a butterfly's wings.
M7|Ptolemy's Cluster|OC|17 53.9|-34 49|3.3|80|Sco|980|NGC 6475|A large, bright open cluster known since antiquity, at the tail of Scorpius.
M8|Lagoon Nebula|EN|18 03.8|-24 23|6.0|90|Sgr|4100|NGC 6523|A glowing stellar nursery bisected by a dark lane, visible to the naked eye from dark sites.
M9||GC|17 19.2|-18 31|7.7|12|Oph|25800|NGC 6333|A compact globular cluster near the centre of the Galaxy.
M10||GC|16 57.1|-4 06|6.6|20|Oph|14300|NGC 6254|A bright globular cluster, a neighbour of M12 in Ophiuchus.
M11|Wild Duck Cluster|OC|18 51.1|-6 16|6.3|14|Sct|6200|NGC 6705|One of the richest and most compact open clusters, with about 2,900 stars.
M12|Gumball Globular|GC|16 47.2|-1 57|6.7|16|Oph|15700|NGC 6218|A loose globular cluster that has lost many of its inner stars.
M13|Hercules Cluster|GC|16 41.7|+36 28|5.8|20|Her|22200|NGC 6205|The finest globular cluster of the northern sky, with several hundred thousand stars.
M14||GC|17 37.6|-3 15|7.6|12|Oph|30300|NGC 6402|A rich globular cluster; a nova was seen in it in 1938.
M15||GC|21 30.0|+12 10|6.2|18|Peg|33600|NGC 7078|One of the densest globulars, with a collapsed core and a planetary nebula inside.
M16|Eagle Nebula|EN|18 18.8|-13 47|6.0|35|Ser|7000|NGC 6611|Home of the Pillars of Creation, towers of gas and dust where stars are forming.
M17|Omega Nebula|EN|18 20.8|-16 11|6.0|11|Sgr|5500|NGC 6618|The Swan or Omega Nebula, one of the brightest star-forming regions in the sky.
M18||OC|18 19.9|-17 08|6.9|9|Sgr|4900|NGC 6613|A sparse open cluster in the Sagittarius star clouds.
M19||GC|17 02.6|-26 16|6.8|17|Oph|28700|NGC 6273|An oblate globular cluster, one of the most flattened known.
M20|Trifid Nebula|EN|18 02.6|-23 02|6.3|28|Sgr|4100|NGC 6514|An emission, reflection and dark nebula divided into three lobes by dust lanes.
M21||OC|18 04.6|-22 30|5.9|13|Sgr|4250|NGC 6531|A young open cluster only a few million years old, next to the Trifid.
M22|Sagittarius Cluster|GC|18 36.4|-23 54|5.1|32|Sgr|10600|NGC 6656|One of the brightest globular clusters, discovered in 1665.
M23||OC|17 57.0|-19 01|5.5|27|Sgr|2150|NGC 6494|A rich, bright open cluster of about 150 stars.
M24|Sagittarius Star Cloud|OC|18 17.0|-18 29|4.6|90|Sgr|10000||A dense patch of the Milky Way through a gap in the dust, seen as a glowing star cloud.
M25||OC|18 31.6|-19 15|4.6|32|Sgr|2000|IC 4725|A bright open cluster containing a Cepheid variable star.
M26||OC|18 45.2|-9 23|8.0|15|Sct|5000|NGC 6694|A small open cluster with a curious dark void near its centre.
M27|Dumbbell Nebula|PN|19 59.6|+22 43|7.5|8|Vul|1360|NGC 6853|The first planetary nebula ever discovered, a shell of gas shed by a dying star.
M28||GC|18 24.5|-24 52|6.8|11|Sgr|17900|NGC 6626|A globular cluster that contains the first millisecond pulsar found in one.
M29||OC|20 23.9|+38 31|6.6|7|Cyg|4000|NGC 6913|A small cluster of bright stars in the Cygnus Milky Way.
M30||GC|21 40.4|-23 11|7.2|12|Cap|26100|NGC 7099|A globular cluster with a dense, collapsed core and a stream of stars.
M31|Andromeda Galaxy|G|0 42.7|+41 16|3.4|190|And|2537000|NGC 224|The nearest large galaxy and the farthest thing most people can see unaided; it is heading toward the Milky Way.
M32||G|0 42.7|+40 52|8.1|8|And|2650000|NGC 221|A compact dwarf elliptical satellite of the Andromeda Galaxy.
M33|Triangulum Galaxy|G|1 33.9|+30 40|5.7|70|Tri|2730000|NGC 598|A face-on spiral, the third-largest galaxy of our Local Group; a test of dark-sky quality.
M34||OC|2 42.0|+42 47|5.5|35|Per|1500|NGC 1039|A scattered, bright open cluster that fills a binocular field.
M35||OC|6 09.0|+24 21|5.3|28|Gem|2800|NGC 2168|A rich open cluster at the foot of Castor, with fainter NGC 2158 beside it.
M36||OC|5 36.3|+34 08|6.0|12|Aur|4100|NGC 1960|The first of three open clusters in Auriga, young and compact.
M37||OC|5 52.4|+32 33|5.6|24|Aur|4500|NGC 2099|The richest of the Auriga clusters, with about 500 stars.
M38||OC|5 28.7|+35 51|6.4|21|Aur|4200|NGC 1912|A cross-shaped open cluster in Auriga.
M39||OC|21 32.2|+48 26|4.6|32|Cyg|1000|NGC 7092|A loose naked-eye cluster, best in binoculars.
M40|Winnecke 4|OC|12 22.4|+58 05|8.4|1|UMa|510||A close pair of unrelated stars that Messier took for a nebula.
M41||OC|6 46.0|-20 46|4.5|38|CMa|2300|NGC 2287|A bright open cluster just below Sirius, with a ruddy giant at its centre.
M42|Orion Nebula|EN|5 35.3|-5 23|4.0|85|Ori|1344|NGC 1976|The nearest massive star-forming region and the brightest nebula, visible to the naked eye in Orion's sword.
M43|De Mairan's Nebula|EN|5 35.6|-5 16|9.0|20|Ori|1600|NGC 1982|A detached part of the Orion Nebula, lit by a single hot star.
M44|Beehive Cluster|OC|8 40.4|+19 40|3.7|95|Cnc|600|NGC 2632|Praesepe: a bright, nearby open cluster, a naked-eye smudge in Cancer.
M45|Pleiades|OC|3 47.0|+24 07|1.6|110|Tau|444||The Seven Sisters, a bright young cluster wrapped in reflection nebulosity.
M46||OC|7 41.8|-14 49|6.1|27|Pup|5400|NGC 2437|A rich cluster with a planetary nebula, NGC 2438, superimposed on it.
M47||OC|7 36.6|-14 30|4.4|30|Pup|1600|NGC 2422|A bright, coarse open cluster next to M46.
M48||OC|8 13.7|-5 45|5.8|54|Hya|2500|NGC 2548|A large, sparse open cluster in Hydra.
M49||G|12 29.8|+8 00|8.4|9|Vir|56000000|NGC 4472|The brightest galaxy of the Virgo Cluster, a giant elliptical.
M50||OC|7 03.2|-8 23|5.9|15|Mon|3200|NGC 2323|A heart-shaped open cluster in Monoceros.
M51|Whirlpool Galaxy|G|13 29.9|+47 12|8.4|11|CVn|23000000|NGC 5194|A grand-design spiral interacting with its companion NGC 5195.
M52||OC|23 24.2|+61 36|6.9|13|Cas|5000|NGC 7654|A rich open cluster in Cassiopeia, pointed to by Alpha and Beta Cas.
M53||GC|13 12.9|+18 10|7.6|13|Com|58000|NGC 5024|A distant globular cluster near Alpha Comae Berenices.
M54||GC|18 55.1|-30 29|7.6|12|Sgr|87000|NGC 6715|A globular cluster that belongs to the Sagittarius dwarf galaxy, not to the Milky Way.
M55||GC|19 40.0|-30 58|6.3|19|Sgr|17300|NGC 6809|A large, loose globular cluster in southern Sagittarius.
M56||GC|19 16.6|+30 11|8.3|7|Lyr|32900|NGC 6779|A modest globular cluster midway between Albireo and Gamma Lyrae.
M57|Ring Nebula|PN|18 53.6|+33 02|8.8|1.4|Lyr|2300|NGC 6720|The classic smoke-ring planetary nebula between Beta and Gamma Lyrae.
M58||G|12 37.7|+11 49|9.7|6|Vir|62000000|NGC 4579|A barred spiral in the Virgo Cluster.
M59||G|12 42.0|+11 39|9.6|5|Vir|60000000|NGC 4621|An elliptical galaxy in the Virgo Cluster.
M60||G|12 43.7|+11 33|8.8|7|Vir|55000000|NGC 4649|A giant elliptical, interacting with the small spiral NGC 4647.
M61||G|12 21.9|+4 28|9.7|6|Vir|52000000|NGC 4303|A face-on starburst spiral on the edge of the Virgo Cluster.
M62||GC|17 01.2|-30 07|6.5|15|Oph|22500|NGC 6266|A lopsided globular cluster close to the Galactic centre.
M63|Sunflower Galaxy|G|13 15.8|+42 02|8.6|12|CVn|29000000|NGC 5055|A flocculent spiral with patchy, sunflower-like arms.
M64|Black Eye Galaxy|G|12 56.7|+21 41|8.5|10|Com|17000000|NGC 4826|A spiral with a dramatic dark dust lane in front of its bright nucleus.
M65||G|11 18.9|+13 05|9.3|10|Leo|35000000|NGC 3623|A spiral in the Leo Triplet.
M66||G|11 20.2|+12 59|8.9|9|Leo|36000000|NGC 3627|The brightest of the Leo Triplet, with distorted arms.
M67||OC|8 51.4|+11 49|6.1|30|Cnc|2700|NGC 2682|One of the oldest known open clusters, about 4 billion years.
M68||GC|12 39.5|-26 45|7.8|11|Hya|33600|NGC 4590|A globular cluster in Hydra.
M69||GC|18 31.4|-32 21|7.6|10|Sgr|29700|NGC 6637|A compact globular cluster in Sagittarius.
M70||GC|18 43.2|-32 18|7.9|8|Sgr|29400|NGC 6681|A small globular cluster near M69.
M71||GC|19 53.8|+18 47|8.2|7|Sge|12000|NGC 6838|A loose cluster once classed as an open cluster, in Sagitta.
M72||GC|20 53.5|-12 32|9.2|7|Aqr|55000|NGC 6981|A faint, distant globular cluster in Aquarius.
M73||OC|20 59.0|-12 38|9.0|3|Aqr|2500|NGC 6994|A group of four stars, an asterism rather than a true cluster.
M74|Phantom Galaxy|G|1 36.7|+15 47|9.4|10|Psc|32000000|NGC 628|A face-on grand-design spiral, notoriously difficult to see by eye.
M75||GC|20 06.1|-21 55|8.6|7|Sgr|67500|NGC 6864|A very compact, distant globular cluster.
M76|Little Dumbbell Nebula|PN|1 42.4|+51 34|10.1|2.7|Per|3400|NGC 650|A faint planetary nebula, the dimmest Messier object.
M77|Cetus A|G|2 42.7|-0 01|8.9|7|Cet|47000000|NGC 1068|A Seyfert galaxy with a bright, active nucleus.
M78||EN|5 46.7|+0 03|8.3|8|Ori|1600|NGC 2068|The brightest reflection nebula in the sky, in Orion.
M79||GC|5 24.2|-24 31|7.7|9|Lep|41000|NGC 1904|A globular cluster in Lepus, possibly from a captured dwarf galaxy.
M80||GC|16 17.0|-22 59|7.3|10|Sco|32600|NGC 6093|A dense globular cluster between Antares and Beta Scorpii.
M81|Bode's Galaxy|G|9 55.6|+69 04|6.9|27|UMa|12000000|NGC 3031|A bright grand-design spiral and the anchor of the M81 group.
M82|Cigar Galaxy|G|9 55.9|+69 41|8.4|11|UMa|12000000|NGC 3034|An edge-on starburst galaxy with streamers of glowing gas blowing from its core.
M83|Southern Pinwheel Galaxy|G|13 37.0|-29 52|7.5|13|Hya|15000000|NGC 5236|A barred spiral rich in star formation and supernovae.
M84||G|12 25.1|+12 53|9.1|6|Vir|60000000|NGC 4374|A lenticular galaxy in Markarian's Chain.
M85||G|12 25.4|+18 11|9.1|7|Com|60000000|NGC 4382|A lenticular galaxy at the northern edge of the Virgo Cluster.
M86||G|12 26.2|+12 57|8.9|9|Vir|52000000|NGC 4406|A galaxy approaching us faster than any other in Virgo.
M87|Virgo A|G|12 30.8|+12 24|8.6|8|Vir|53500000|NGC 4486|A giant elliptical with a famous jet and the first black hole ever imaged.
M88||G|12 32.0|+14 25|9.6|7|Com|47000000|NGC 4501|A bright spiral in the Virgo Cluster.
M89||G|12 35.7|+12 33|9.8|5|Vir|50000000|NGC 4552|A round elliptical with faint shells.
M90||G|12 36.8|+13 10|9.5|10|Vir|58000000|NGC 4569|A spiral galaxy racing toward us.
M91||G|12 35.4|+14 30|10.2|5|Com|63000000|NGC 4548|A barred spiral, the last of the Virgo objects Messier recorded.
M92||GC|17 17.1|+43 08|6.4|14|Her|26700|NGC 6341|A fine globular cluster in Hercules, often overshadowed by M13.
M93||OC|7 44.6|-23 52|6.2|22|Pup|3600|NGC 2447|A bright, wedge-shaped open cluster in Puppis.
M94||G|12 50.9|+41 07|8.2|11|CVn|16000000|NGC 4736|A starburst galaxy surrounded by a bright ring.
M95||G|10 44.0|+11 42|9.7|7|Leo|38000000|NGC 3351|A barred spiral in the Leo I group.
M96||G|10 46.8|+11 49|9.2|8|Leo|38000000|NGC 3368|The brightest spiral of the M96 group in Leo.
M97|Owl Nebula|PN|11 14.8|+55 01|9.9|3.4|UMa|2600|NGC 3587|A round planetary nebula with two dark 'eyes'.
M98||G|12 13.8|+14 54|10.1|10|Com|44000000|NGC 4192|A nearly edge-on spiral in Coma Berenices.
M99||G|12 18.8|+14 25|9.9|5|Com|50000000|NGC 4254|A face-on spiral with a lopsided arm pattern.
M100||G|12 22.9|+15 49|9.3|7|Com|55000000|NGC 4321|A grand-design spiral, used to calibrate the Hubble constant.
M101|Pinwheel Galaxy|G|14 03.2|+54 21|7.9|29|UMa|21000000|NGC 5457|A large, face-on spiral whose outer arms are faint.
M102|Spindle Galaxy|G|15 06.5|+55 46|9.9|5|Dra|44000000|NGC 5866|An edge-on lenticular galaxy with a sharp dust lane, usually identified with Messier's M102.
M103||OC|1 33.2|+60 39|7.4|6|Cas|8500|NGC 581|A small, triangular open cluster, the last of Messier's own discoveries.
M104|Sombrero Galaxy|G|12 40.0|-11 37|8.0|9|Vir|29000000|NGC 4594|A spiral with a bright bulge and a prominent dust lane, like a wide-brimmed hat.
M105||G|10 47.8|+12 35|9.3|5|Leo|32000000|NGC 3379|An elliptical in the Leo I group.
M106||G|12 19.0|+47 18|8.4|19|CVn|24000000|NGC 4258|A spiral with a supermassive black hole and a maser disc used to measure distance.
M107||GC|16 32.5|-13 03|7.9|13|Oph|20900|NGC 6171|A loose globular cluster in Ophiuchus.
M108||G|11 11.5|+55 40|10.0|8|UMa|46000000|NGC 3556|A nearly edge-on spiral near the Owl Nebula.
M109||G|11 57.6|+53 23|9.8|8|UMa|83000000|NGC 3992|A barred spiral near Gamma Ursae Majoris.
M110||G|0 40.4|+41 41|8.5|20|And|2690000|NGC 205|A dwarf elliptical satellite of the Andromeda Galaxy.
NGC 7000|North America Nebula|EN|20 58.8|+44 20|4.0|120|Cyg|2600|Caldwell 20|A huge emission nebula shaped like the North American continent, beside Deneb.
NGC 253|Sculptor Galaxy|G|0 47.6|-25 17|7.1|27|Scl|11400000|Caldwell 65|A dusty starburst spiral, the brightest galaxy in the Sculptor Group.
NGC 5128|Centaurus A|G|13 25.5|-43 01|6.8|26|Cen|12000000|Caldwell 77|An elliptical galaxy cut by a dark dust lane, with a powerful radio jet.
NGC 3372|Carina Nebula|EN|10 45.1|-59 41|1.0|120|Car|8500|Caldwell 92|One of the largest and brightest nebulae in the sky, home of the eruptive star Eta Carinae.
NGC 104|47 Tucanae|GC|0 24.1|-72 05|4.1|50|Tuc|14800|47 Tuc|The second-brightest globular cluster in the sky, beside the Small Magellanic Cloud.
NGC 5139|Omega Centauri|GC|13 26.8|-47 29|3.9|36|Cen|17000|Caldwell 80|The largest and brightest globular cluster, probably the core of a stripped dwarf galaxy.
NGC 869|Double Cluster|OC|2 20.7|+57 08|3.7|60|Per|7500|NGC 884|Two young open clusters, NGC 869 and NGC 884, side by side in Perseus.
IC 434|Horsehead Nebula|EN|5 40.9|-2 28|6.8|60|Ori|1375|Barnard 33|A dark nebula silhouetted against the glowing hydrogen of IC 434, below Alnitak.
NGC 7293|Helix Nebula|PN|22 29.6|-20 50|7.6|25|Aqr|650|Caldwell 63|One of the nearest planetary nebulae, nicknamed the Eye of God.
NGC 2237|Rosette Nebula|EN|6 33.8|+4 59|9.0|80|Mon|5200|NGC 2244|A big circular emission nebula around the young cluster NGC 2244.
LMC|Large Magellanic Cloud|G|5 23.6|-69 45|0.9|650|Dor|163000|Large Magellanic Cloud|A satellite galaxy of the Milky Way, a naked-eye cloud in the southern sky.
SMC|Small Magellanic Cloud|G|0 52.7|-72 48|2.7|320|Tuc|200000|Small Magellanic Cloud|A dwarf satellite galaxy of the Milky Way.
NGC 6543|Cat's Eye Nebula|PN|17 58.6|+66 38|8.1|0.35|Dra|3300|Caldwell 6|One of the most complex planetary nebulae known, with concentric shells and jets.
NGC 4565|Needle Galaxy|G|12 36.3|+25 59|9.6|16|Com|40000000|Caldwell 38|A beautiful edge-on spiral with a thin dust lane.
NGC 891|Silver Sliver Galaxy|G|2 22.6|+42 21|9.9|13|And|27000000|Caldwell 23|An edge-on spiral with a dark dust lane, in Andromeda.
NGC 6992|Veil Nebula|SNR|20 56.4|+31 43|7.0|60|Cyg|2100|Caldwell 33|The Eastern Veil: delicate filaments from a supernova about 10,000 years ago.
NGC 2070|Tarantula Nebula|EN|5 38.7|-69 05|8.0|40|Dor|160000|Caldwell 103|The most active star-forming region of the Local Group, inside the Large Magellanic Cloud.
NGC 2392|Eskimo Nebula|PN|7 29.2|+20 55|9.2|0.7|Gem|6500|Caldwell 39|A planetary nebula resembling a face in a fur parka.
NGC 6888|Crescent Nebula|EN|20 12.1|+38 21|7.4|18|Cyg|5000|Caldwell 27|A shell of gas blown by a Wolf-Rayet star.
NGC 2024|Flame Nebula|EN|5 41.7|-1 51|10.0|30|Ori|1350|Sh2-277|A glowing nebula next to Alnitak, veined with dark dust.
NGC 1499|California Nebula|EN|4 03.3|+36 25|6.0|145|Per|1000|Sh2-220|A huge, faint hydrogen nebula shaped like the state of California.
IC 1396|Elephant's Trunk Nebula|EN|21 39.1|+57 30|3.5|170|Cep|2400|Sh2-131|A large emission nebula that contains the dark Elephant's Trunk globule.
IC 2602|Southern Pleiades|OC|10 43.2|-64 24|1.9|100|Car|480|Caldwell 102|A bright southern open cluster with the star Theta Carinae.
`.trim().split('\n');

// Search phrase(s) for the NASA Image and Video Library (first is the primary).
const NASA_Q = {
  M1: ['Crab Nebula'], M8: ['Lagoon Nebula'], M13: ['Hercules cluster M13', 'Messier 13'], M16: ['Eagle Nebula'], M17: ['Omega Nebula', 'Swan Nebula'], M20: ['Trifid Nebula'], M27: ['Dumbbell Nebula'],
  M31: ['Andromeda galaxy', 'M31'], M33: ['Triangulum galaxy', 'M33'], M42: ['Orion Nebula', 'M42'], M45: ['Pleiades'], M44: ['Beehive cluster'], M51: ['Whirlpool galaxy', 'M51'], M57: ['Ring Nebula'],
  M64: ['Black Eye galaxy'], M63: ['Sunflower galaxy'], M74: ['M74 galaxy', 'Phantom galaxy'], M81: ['Bode galaxy', 'M81'], M82: ['Cigar galaxy', 'M82'], M83: ['Southern Pinwheel galaxy', 'M83'],
  M87: ['M87 galaxy', 'Virgo A'], M101: ['Pinwheel galaxy', 'M101'], M104: ['Sombrero galaxy'], M97: ['Owl Nebula'], M76: ['Little Dumbbell Nebula'],
  'NGC 7000': ['North America Nebula'], 'NGC 253': ['Sculptor galaxy', 'NGC 253'], 'NGC 5128': ['Centaurus A'], 'NGC 3372': ['Carina Nebula'], 'NGC 104': ['47 Tucanae'], 'NGC 5139': ['Omega Centauri'],
  'NGC 869': ['Double Cluster Perseus', 'NGC 869'], 'IC 434': ['Horsehead Nebula'], 'NGC 7293': ['Helix Nebula'], 'NGC 2237': ['Rosette Nebula'], LMC: ['Large Magellanic Cloud'], SMC: ['Small Magellanic Cloud'],
  'NGC 6543': ["Cat's Eye Nebula"], 'NGC 4565': ['NGC 4565'], 'NGC 891': ['NGC 891'], 'NGC 6992': ['Veil Nebula', 'Cygnus Loop'], 'NGC 2070': ['Tarantula Nebula'], 'NGC 2392': ['Eskimo Nebula'],
  'NGC 6888': ['Crescent Nebula'], 'NGC 2024': ['Flame Nebula'], 'NGC 1499': ['California Nebula'], 'IC 1396': ["Elephant's Trunk Nebula", 'IC 1396'], 'IC 2602': ['Southern Pleiades', 'IC 2602'],
};

const num = (s) => Number(String(s).trim());
function parseRa(s) { const [h, m] = s.trim().split(/\s+/).map(Number); return (h + m / 60) * 15; }
function parseDec(s) { const t = s.trim(); const neg = t.startsWith('-'); const [d, m] = t.replace(/^[+-]/, '').split(/\s+/).map(Number); return (neg ? -1 : 1) * (d + m / 60); }

const objects = ROWS.map((line, i) => {
  const f = line.split('|');
  if (f.length !== 11) throw new Error(`row ${i}: ${f.length} fields: ${line.slice(0, 40)}`);
  const [id, name, t, ra, dec, mag, size, con, dist, aka, desc] = f;
  if (!TYPES[t]) throw new Error('bad type ' + t + ' in ' + id);
  if (!CON[con]) throw new Error('bad con ' + con + ' in ' + id);
  const o = {
    id, name: name || '', type: TYPES[t], ra: +parseRa(ra).toFixed(3), dec: +parseDec(dec).toFixed(3),
    mag: num(mag), size: num(size), con: CON[con], conAbbr: con, dist: num(dist), desc,
  };
  if (aka) o.aka = aka;
  const sh = SHAPE[id]; if (sh) { o.pa = sh[0]; o.ratio = sh[1]; }
  const q = NASA_Q[id]; if (q) o.q = q;
  return o;
});

const messier = objects.filter(o => /^M\d+$/.test(o.id));
if (messier.length !== 110) throw new Error('expected 110 Messier objects, got ' + messier.length);
const ids = new Set(); for (const o of objects) { if (ids.has(o.id)) throw new Error('duplicate ' + o.id); ids.add(o.id); }

const out = { v: 1, source: 'Messier + selected NGC/IC objects; J2000; sizes are major-axis arcmin; distances in light-years', count: objects.length, objects };
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sky', 'dso.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}: ${objects.length} objects (${messier.length} Messier)`);
