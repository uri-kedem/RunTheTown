// Elevation grid from the free Open-Meteo elevation API (~90 m DEM), sampled
// with bilinear interpolation.

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

export async function fetchElevationGrid(proj, radius, { n = 24, signal, fetchImpl = fetch } = {}) {
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
