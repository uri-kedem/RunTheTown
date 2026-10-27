// Elevation grid, sampled with bilinear interpolation. The heights come from the
// Terrarium terrain tiles on AWS (Mapzen/Nextzen data, ~30 m, no key, no rate limit;
// each 256 px tile encodes metres as R*256 + G + B/256 - 32768). The free Open-Meteo
// API is the fallback: it throttles after a few hundred points a minute, which is
// why routes on the phone kept coming back without a climb line.

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const API = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100;

export class ElevationGrid {
  constructor(proj, radius, n, values) {
    this.proj = proj;
    this.half = radius;
    this.n = n;
    this.step = (2 * radius) / (n - 1);
    this.values = values; // Float32Array n*n, row-major from (-half, -half)
  }

  at(x, y) {
    const fx = Math.max(0, Math.min(this.n - 1.001, (x + this.half) / this.step));
    const fy = Math.max(0, Math.min(this.n - 1.001, (y + this.half) / this.step));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const v = this.values;
    const n = this.n;
    const top = v[r * n + c] * (1 - tx) + v[r * n + c + 1] * tx;
    const bot = v[(r + 1) * n + c] * (1 - tx) + v[(r + 1) * n + c + 1] * tx;
    return top * (1 - ty) + bot * ty;
  }
}

export async function fetchElevationGrid(proj, radius, { n = 40, signal, fetchImpl = fetch } = {}) {
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      return await fetchTerrariumGrid(proj, radius, { n, signal, fetchImpl });
    } catch (err) {
      console.warn('Terrain tiles unavailable, trying Open-Meteo:', err);
    }
  }
  return fetchOpenMeteoGrid(proj, radius, { n: Math.min(n, 24), signal, fetchImpl });
}

// Web-Mercator tile numbers for a point.
export function tileXY(lat, lon, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  const k = 2 ** z;
  return [((lon + 180) / 360) * k, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * k];
}

async function fetchTerrariumGrid(proj, radius, { n, signal, fetchImpl }) {
  const z = radius <= 3500 ? 13 : radius <= 9000 ? 12 : 11; // ~16 / 32 / 64 m per pixel at mid latitudes
  const step = (2 * radius) / (n - 1);
  const need = new Map(); // "x/y" -> promise of ImageData
  const tileOf = (lat, lon) => {
    const [fx, fy] = tileXY(lat, lon, z);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const key = `${tx}/${ty}`;
    if (!need.has(key)) {
      need.set(key, (async () => {
        const res = await fetchImpl(`${TERRARIUM}/${z}/${tx}/${ty}.png`, { signal });
        if (!res.ok) throw new Error(`terrain tile ${res.status}`);
        const bmp = await createImageBitmap(await res.blob());
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      })());
    }
    return [key, (fx - tx) * 256, (fy - ty) * 256];
  };
  const samples = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const [lat, lon] = proj.toLatLon(c * step - radius, r * step - radius);
      samples.push(tileOf(lat, lon));
    }
  }
  const tiles = new Map();
  const keys = [...need.keys()];
  const imgs = await Promise.all(keys.map((k) => need.get(k))); // one failure fails the lot, cleanly
  keys.forEach((k, i) => tiles.set(k, imgs[i]));
  const values = new Float32Array(samples.length);
  samples.forEach(([key, px, py], i) => {
    const img = tiles.get(key);
    const x = Math.min(255, Math.max(0, Math.round(px)));
    const y = Math.min(255, Math.max(0, Math.round(py)));
    const o = (y * img.width + x) * 4;
    const d = img.data;
    const h = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
    values[i] = Number.isFinite(h) && h > -1000 ? h : 0;
  });
  return new ElevationGrid(proj, radius, n, values);
}

async function fetchOpenMeteoGrid(proj, radius, { n, signal, fetchImpl }) {
  const pts = [];
  const step = (2 * radius) / (n - 1);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) pts.push(proj.toLatLon(c * step - radius, r * step - radius));
  }
  const values = new Float32Array(pts.length);

  // One request at a time: the free API answers 429 to parallel bursts.
  for (let start = 0; start < pts.length; start += BATCH) {
    const chunk = pts.slice(start, start + BATCH);
    const url =
      `${API}?latitude=${chunk.map((p) => p[0].toFixed(5)).join(',')}` +
      `&longitude=${chunk.map((p) => p[1].toFixed(5)).join(',')}`;
    let data;
    for (let tryNo = 0; ; tryNo++) {
      const res = await fetchImpl(url, { signal });
      if (res.ok) {
        data = await res.json();
        break;
      }
      if (res.status !== 429 || tryNo >= 3) throw new Error(`Elevation service returned ${res.status}`);
      await new Promise((r) => setTimeout(r, 1200 * (tryNo + 1)));
    }
    data.elevation.forEach((e, k) => (values[start + k] = Number.isFinite(e) ? e : 0));
  }
  return new ElevationGrid(proj, radius, n, values);
}
