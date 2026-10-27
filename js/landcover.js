// Land cover seen from space: ESA WorldCover 2021 (10 m, Sentinel-1/2), read as
// map tiles from Microsoft's Planetary Computer, which serves the raw class code of
// every pixel as a PNG grey value (10 = trees, 30 = grass, 50 = built-up, 80 = water…).
// It fills in what OpenStreetMap leaves out in small towns: a park nobody drew, a
// river bank, open country where a bare path is a dirt trail. The grid matches the
// LandscapeGrid cell for cell, so the two can be merged by index.
//
// Google's Dynamic World (near-real-time land cover) is only reachable through Earth
// Engine with a server-side key, so it needs a backend; this module is written so a
// second source can be dropped in with the same class codes.

import { tileXY } from './elevation.js';

export const LC = { NONE: 0, TREE: 10, SHRUB: 20, GRASS: 30, CROP: 40, BUILT: 50, BARE: 60, SNOW: 70, WATER: 80, WETLAND: 90, MANGROVE: 95, MOSS: 100 };

const PC_TILES = 'https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad';
const LC_ZOOM = 13; // ~16 m per pixel at mid latitudes: finer than the 25 m landscape cell

// WorldCover ships in 3°×3° sheets named by their south-west corner (N30E033 covers
// lat 30–33, lon 33–36).
export function worldcoverItem(lat, lon) {
  const la = Math.floor(lat / 3) * 3;
  const lo = Math.floor(lon / 3) * 3;
  const ns = la < 0 ? 'S' : 'N';
  const ew = lo < 0 ? 'W' : 'E';
  return `ESA_WorldCover_10m_2021_v200_${ns}${String(Math.abs(la)).padStart(2, '0')}${ew}${String(Math.abs(lo)).padStart(3, '0')}`;
}

export function landcoverTileUrl(z, x, y, item) {
  return `${PC_TILES}/${z}/${x}/${y}@1x.png?collection=esa-worldcover&item=${item}&assets=map`;
}

// One class code per landscape cell (same n, cell and origin as the LandscapeGrid).
export class LandcoverGrid {
  constructor(proj, radius, cell, classes) {
    this.proj = proj;
    this.half = radius;
    this.cell = cell;
    this.n = Math.ceil((2 * radius) / cell);
    this.classes = classes; // Uint8Array n*n, row-major from the south-west corner
  }
  at(x, y) {
    const c = Math.floor((x + this.half) / this.cell);
    const r = Math.floor((y + this.half) / this.cell);
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return 0;
    return this.classes[r * this.n + c];
  }
}

// Reads the class under every cell centre from the z13 tiles. Browser only (needs
// createImageBitmap); in Node it returns null and the planner runs on OSM alone.
export async function fetchLandcoverGrid(proj, radius, cell, { signal, fetchImpl = fetch, cache = null } = {}) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const n = Math.ceil((2 * radius) / cell);
  const need = new Map(); // "z/x/y/item" -> promise of Uint8Array(256*256) class codes
  const tileOf = (lat, lon) => {
    const [fx, fy] = tileXY(lat, lon, LC_ZOOM);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const item = worldcoverItem(lat, lon); // the sheet this very cell is on (tiles can straddle two)
    const key = `${LC_ZOOM}/${tx}/${ty}/${item}`;
    if (!need.has(key)) {
      need.set(key, (async () => {
        const cacheKey = 'lc:' + key;
        if (cache) {
          const hit = await cache.get(cacheKey);
          if (hit && hit.length === 256 * 256) return Uint8Array.from(hit);
        }
        const res = await fetchImpl(landcoverTileUrl(LC_ZOOM, tx, ty, item), { signal });
        if (!res.ok) throw new Error(`land-cover tile ${res.status}`);
        const bmp = await createImageBitmap(await res.blob());
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const out = new Uint8Array(c.width * c.height);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4]; // grey = the WorldCover class code
        if (cache) cache.put(cacheKey, Array.from(out));
        return out;
      })());
    }
    return [key, (fx - tx) * 256, (fy - ty) * 256];
  };
  const samples = new Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const [lat, lon] = proj.toLatLon(c * cell + cell / 2 - radius, r * cell + cell / 2 - radius);
      samples[r * n + c] = tileOf(lat, lon);
    }
  }
  const keys = [...need.keys()];
  const imgs = await Promise.all(keys.map((k) => need.get(k)));
  const tiles = new Map(keys.map((k, i) => [k, imgs[i]]));
  const classes = new Uint8Array(n * n);
  samples.forEach(([key, px, py], i) => {
    const img = tiles.get(key);
    const x = Math.min(255, Math.max(0, Math.floor(px)));
    const y = Math.min(255, Math.max(0, Math.floor(py)));
    classes[i] = img[y * 256 + x];
  });
  return new LandcoverGrid(proj, radius, cell, classes);
}
