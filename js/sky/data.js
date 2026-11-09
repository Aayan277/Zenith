// Loads data/sky/sky.json and prepares typed arrays / lookup textures.
import { raDecToVec, bvToTemp, tempToRGB, D2R } from './astro.js';

export const BV_BUCKETS = 28;
const BV_MIN = -0.3, BV_MAX = 2.0;
export const bvBucket = bv => Math.max(0, Math.min(BV_BUCKETS - 1, Math.round((bv - BV_MIN) / (BV_MAX - BV_MIN) * (BV_BUCKETS - 1))));

export const MW_W = 1024, MW_H = 512;

export async function loadSkyData() {
  const res = await fetch('data/sky/sky.json');
  if (!res.ok) throw new Error('sky.json ' + res.status);
  const raw = await res.json();
  const n = raw.stars.length;

  const stars = {
    n,
    vec: new Float32Array(n * 3),
    mag: new Float32Array(n),
    bv: new Float32Array(n),
    hip: new Int32Array(n),
    ra: new Float32Array(n), dec: new Float32Array(n),
    bucket: new Uint8Array(n),
    phase: new Float32Array(n),
    byHip: new Map(),
  };
  const tmp = [0, 0, 0];
  raw.stars.forEach((s, i) => {
    raDecToVec(s[0], s[1], tmp);
    stars.vec[i * 3] = tmp[0]; stars.vec[i * 3 + 1] = tmp[1]; stars.vec[i * 3 + 2] = tmp[2];
    stars.ra[i] = s[0]; stars.dec[i] = s[1];
    stars.mag[i] = s[2]; stars.bv[i] = s[3]; stars.hip[i] = s[4];
    stars.bucket[i] = bvBucket(s[3]);
    stars.phase[i] = (i * 2.399963) % (Math.PI * 2);
    stars.byHip.set(s[4], i);
  });

  // names: hip -> { name, bayer, flam, con }
  const names = new Map();
  for (const [hip, v] of Object.entries(raw.starNames)) names.set(+hip, { name: v[0], bayer: v[1], flam: v[2], con: v[3] });

  // Labelled stars: brightest named, sorted by mag
  const labelled = [];
  for (let i = 0; i < n; i++) { const nm = names.get(stars.hip[i]); if (nm && nm.name) labelled.push(i); }
  stars.labelled = labelled; // already sorted by magnitude

  // constellations
  const cons = raw.constellations.map(c => {
    const segs = c.lines.map(l => {
      const m = l.length / 2, a = new Float32Array(m * 3);
      for (let i = 0; i < m; i++) { raDecToVec(l[i * 2], l[i * 2 + 1], tmp); a[i * 3] = tmp[0]; a[i * 3 + 1] = tmp[1]; a[i * 3 + 2] = tmp[2]; }
      return a;
    });
    const lv = raDecToVec(c.label[0], c.label[1], [0, 0, 0]);
    return { id: c.id, name: c.name, labelRa: c.label[0], labelDec: c.label[1], label: lv, segs };
  });
  const consById = new Map(cons.map(c => [c.id, c]));

  // Milky Way intensity texture (equirectangular, lon -180..180 = RA wrapped)
  const mw = buildMilkyWay(raw.mw);

  return { stars, names, cons, consById, mw };
}

function buildMilkyWay(levels) {
  const cv = document.createElement('canvas'); cv.width = MW_W; cv.height = MW_H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, MW_W, MW_H);
  const X = lon => (lon + 180) / 360 * MW_W, Y = lat => (90 - lat) / 180 * MW_H;
  levels.forEach((polys, li) => {
    g.fillStyle = `rgba(255,255,255,${[0.16, 0.18, 0.2, 0.22, 0.26][li] || 0.2})`;
    for (const ring of polys) for (const off of [-360, 0, 360]) {
      g.beginPath();
      for (let i = 0; i < ring.length; i += 2) {
        const x = X(ring[i] + off), y = Y(ring[i + 1]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    }
  });
  // soften
  const cv2 = document.createElement('canvas'); cv2.width = MW_W; cv2.height = MW_H;
  const g2 = cv2.getContext('2d', { willReadFrequently: true });
  g2.filter = 'blur(9px)'; g2.drawImage(cv, 0, 0); g2.filter = 'none';
  const px = g2.getImageData(0, 0, MW_W, MW_H).data;
  const tex = new Float32Array(MW_W * MW_H);
  for (let i = 0; i < tex.length; i++) tex[i] = px[i * 4] / 255;
  // normalise to 0..1
  let mx = 0; for (let i = 0; i < tex.length; i++) if (tex[i] > mx) mx = tex[i];
  if (mx > 0) for (let i = 0; i < tex.length; i++) tex[i] = Math.min(1, tex[i] / mx);
  return { tex, canvas: cv2 };
}

// ---- Sprites ----------------------------------------------------------------
export function makeStarSprites() {
  const sprites = [];
  const S = 64;
  for (let b = 0; b < BV_BUCKETS; b++) {
    const bv = BV_MIN + (BV_MAX - BV_MIN) * b / (BV_BUCKETS - 1);
    let [r, g, bl] = tempToRGB(bvToTemp(bv));
    // pull toward white a little so faint stars stay legible
    r = r * 0.8 + 255 * 0.2; g = g * 0.8 + 255 * 0.2; bl = bl * 0.8 + 255 * 0.2;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d');
    const gr = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const rgb = (a, k = 1) => `rgba(${r * k | 0},${g * k | 0},${bl * k | 0},${a})`;
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.10, rgb(1, 1.0));
    gr.addColorStop(0.22, rgb(0.55));
    gr.addColorStop(0.45, rgb(0.14));
    gr.addColorStop(1, rgb(0));
    c.fillStyle = gr; c.fillRect(0, 0, S, S);
    sprites.push(cv);
  }
  return sprites;
}

export function makeGlowSprite(rgb, size = 128) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  const gr = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, `rgba(${rgb},0.9)`); gr.addColorStop(0.18, `rgba(${rgb},0.4)`);
  gr.addColorStop(0.5, `rgba(${rgb},0.1)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = gr; c.fillRect(0, 0, size, size);
  return cv;
}
