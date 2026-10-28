// Rasterizes parks/green areas and waterfronts into a grid, so any point can be
// asked "is this green?" / "is this by the water?" in constant time.

export class LandscapeGrid {
  constructor(proj, radius, cell = 25) {
    this.proj = proj;
    this.cell = cell;
    this.half = radius;
    this.n = Math.ceil((2 * radius) / cell);
    this.green = new Uint8Array(this.n * this.n);
    this.water = new Uint8Array(this.n * this.n);
    this.wild = new Uint8Array(this.n * this.n); // woods, scrub, heath: open country, where a bare path is a dirt trail
    this.closed = new Uint8Array(this.n * this.n); // army bases, railway land, quarries, prisons: no way through
    this.compound = new Uint8Array(this.n * this.n); // factories, hospitals, schools, campuses, garages: fenced, avoid
    this.body = null; // filled water areas (sea, lakes), from vector tiles
    this.dock = new Uint8Array(this.n * this.n); // marina basins and their quays: no running there
    this.sea = new Uint8Array(this.n * this.n); // land by the sea: beaches and seaside promenades (the best of all water)
    this.seaBody = null; // the sea itself (ocean polygons), filled
    this.lakeBody = null; // lakes, ponds, harbour basins (every other water polygon), filled
  }

  col(x) {
    return Math.floor((x + this.half) / this.cell);
  }
  row(y) {
    return Math.floor((y + this.half) / this.cell);
  }
  center(i) {
    return i * this.cell + this.cell / 2 - this.half;
  }

  layer(kind) {
    return kind === 'green' ? this.green : kind === 'wild' ? this.wild : kind === 'closed' ? this.closed : kind === 'compound' ? this.compound : kind === 'body' ? this.body : kind === 'sea' ? this.sea : kind === 'dock' ? this.dock : this.water;
  }

  // 1 if (x, y) lies well inside that layer: its cell and the four neighbours (a quay
  // at the water's edge is not "deep" in the water; a pontoon 30 m out is).
  deep(kind, x, y) {
    const c = this.col(x);
    const r = this.row(y);
    if (c < 1 || r < 1 || c >= this.n - 1 || r >= this.n - 1) return 0;
    const a = this.layer(kind);
    const n = this.n;
    return a[r * n + c] && a[r * n + c - 1] && a[r * n + c + 1] && a[(r - 1) * n + c] && a[(r + 1) * n + c] ? 1 : 0;
  }

  // 1 if (x, y) lies in that layer, else 0.
  at(kind, x, y) {
    const c = this.col(x);
    const r = this.row(y);
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return 0;
    return this.layer(kind)[r * this.n + c];
  }

  addFeatures(features) {
    for (const f of features) {
      const rings = f.rings.map((ring) => ring.map(([lat, lon]) => this.proj.toXY(lat, lon)));
      if (f.shape === 'body') {
        // Sea/lake polygons (clipped at tile edges, so their outlines aren't
        // real shores): fill them, then mark land near them in finish().
        this.body ||= new Uint8Array(this.n * this.n);
        this.fillPolygon(rings, this.body);
        if (f.kind === 'sea') {
          this.seaBody ||= new Uint8Array(this.n * this.n);
          this.fillPolygon(rings, this.seaBody);
        } else {
          this.lakeBody ||= new Uint8Array(this.n * this.n);
          this.fillPolygon(rings, this.lakeBody);
        }
        continue;
      }
      const arr = this.layer(f.kind);
      if (f.shape === 'area') {
        const closed = f.relation || rings.every((r) => samePoint(r[0], r[r.length - 1]));
        if (closed) this.fillPolygon(rings, arr);
      }
      if (f.buffer > 0) for (const r of rings) this.bufferLine(r, f.buffer, arr);
    }
  }

  // Satellite land cover (ESA WorldCover classes, one per cell) on top of the OSM
  // features: it fills in parks nobody drew, river banks and open country in towns
  // where the map is thin. OSM keeps the last word where it has one.
  addLandcover(lc) {
    if (!lc || lc.n !== this.n) return;
    const n = this.n;
    const k = lc.classes;
    const osmGreen = this.green.slice();
    // Built-up share within ~500 m (20 cells): tree cover with hardly any buildings
    // around is open country, where a bare path is a dirt trail (wild); a wood with
    // the town around it is a park. The integral image is kept for townShare().
    const built = new Float32Array((n + 1) * (n + 1)); // integral image
    this.builtSum = built;
    for (let r = 0; r < n; r++) {
      let row = 0;
      for (let c = 0; c < n; c++) {
        row += k[r * n + c] === 50 ? 1 : 0;
        built[(r + 1) * (n + 1) + c + 1] = built[r * (n + 1) + c + 1] + row;
      }
    }
    const builtFrac = (r, c, d = 20) => {
      const r0 = Math.max(0, r - d), r1 = Math.min(n, r + d + 1), c0 = Math.max(0, c - d), c1 = Math.min(n, c + d + 1);
      const s = built[r1 * (n + 1) + c1] - built[r0 * (n + 1) + c1] - built[r1 * (n + 1) + c0] + built[r0 * (n + 1) + c0];
      return s / ((r1 - r0) * (c1 - c0));
    };
    const isGreen = (v) => v === 10 || v === 20 || v === 30 || v === 90 || v === 95;
    // Green only where it is a patch, not a scattered street tree: the cell and its
    // four neighbours all green (so a park counts, a tree-lined avenue does not).
    const g4 = (r, c) => (r < 0 || c < 0 || r >= n || c >= n ? true : isGreen(k[r * n + c])); // outside the map counts as agreeing
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const v = k[i];
        if (isGreen(v) && g4(r, c - 1) && g4(r, c + 1) && g4(r - 1, c) && g4(r + 1, c)) this.green[i] = 1;
        // Water from space feeds the waterfront bonus only (never the harbour
        // detection: a coastline off by a pixel must not turn the beach into a dock).
        if (v === 80) {
          this.body ||= new Uint8Array(n * n);
          this.body[i] = 1;
        }
        // Open country: crops, bare ground, scrub, or trees/grass with no buildings near.
        const open = v === 40 || v === 60 || v === 20 || ((v === 10 || v === 30) && builtFrac(r, c) < 0.15);
        if (open && !osmGreen[i] && !this.closed[i]) this.wild[i] = 1;
      }
    }
  }

  // Share of built-up ground (from space) within ~100 m of (x, y): 0 in open country,
  // close to 1 in a town. null until land cover has been merged.
  townShare(x, y, d = 4) {
    if (!this.builtSum) return null;
    const n = this.n;
    const c = this.col(x);
    const r = this.row(y);
    if (c < 0 || r < 0 || c >= n || r >= n) return 0;
    const r0 = Math.max(0, r - d), r1 = Math.min(n, r + d + 1), c0 = Math.max(0, c - d), c1 = Math.min(n, c + d + 1);
    const b = this.builtSum;
    const sum = b[r1 * (n + 1) + c1] - b[r0 * (n + 1) + c1] - b[r1 * (n + 1) + c0] + b[r0 * (n + 1) + c0];
    return sum / ((r1 - r0) * (c1 - c0));
  }

  // "Along the water" = within ~75 m of a water body (3 cells), plus line buffers.
  // "By the sea" = within ~100 m of the sea itself (beaches are buffered separately).
  finish(reach = 3) {
    if (this.seaBody) this.flood(this.seaBody, this.sea, reach + 1);
    if (this.seaBody && this.lakeBody) this.markHarbours();
    if (this.body) this.flood(this.body, this.water, reach);
  }

  // A small water polygon that lies in or touches the sea is a harbour or marina basin
  // (the tiles call it a lake, and the ocean polygon usually covers it too): its rim,
  // 2 cells (~50 m) wide, is dock — quays and pontoons, not running routes. Big lagoons
  // and anything inland are left alone.
  markHarbours(maxCells = 800) {
    const n = this.n;
    const b = this.lakeBody;
    const sea = this.seaBody;
    const seen = new Uint8Array(n * n);
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let s0 = 0; s0 < n * n; s0++) {
      if (!b[s0] || seen[s0]) continue;
      // Flood this lake-class body.
      const cells = [s0];
      seen[s0] = 1;
      let touchesSea = !!sea[s0];
      // The whole body is visited even past the cap, so a big basin is never re-found
      // later as several small ones.
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        const r = (i / n) | 0;
        const c = i - r * n;
        for (const [dr, dc] of nb) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
          const j = rr * n + cc;
          if (sea[j]) touchesSea = true;
          if (!b[j] || seen[j]) continue;
          seen[j] = 1;
          cells.push(j);
        }
      }
      if (!touchesSea || cells.length > maxCells) continue;
      // Mark the basin and a 2-cell rim around it.
      for (const i of cells) {
        const r = (i / n) | 0;
        const c = i - r * n;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < n && cc < n) this.dock[rr * n + cc] = 1;
        }
      }
    }
  }

  flood(b, out, reach) {
    const n = this.n;
    let frontier = [];
    for (let i = 0; i < n * n; i++) if (b[i]) frontier.push(i);
    const dist = new Uint8Array(n * n);
    for (const i of frontier) dist[i] = 1;
    for (let step = 1; step <= reach && frontier.length; step++) {
      const next = [];
      for (const i of frontier) {
        const r = (i / n) | 0;
        const c = i - r * n;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
          const j = rr * n + cc;
          if (dist[j]) continue;
          dist[j] = step + 1;
          out[j] = 1;
          next.push(j);
        }
      }
      frontier = next;
    }
  }

  // Even-odd scanline fill over all segments of all rings (handles holes and
  // multipolygon relations whose rings are split across several ways).
  fillPolygon(rings, arr) {
    const segs = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        if (y1 === y2) continue;
        segs.push(x1, y1, x2, y2);
        minY = Math.min(minY, y1, y2);
        maxY = Math.max(maxY, y1, y2);
      }
    }
    if (!segs.length) return;
    const r0 = Math.max(0, this.row(minY));
    const r1 = Math.min(this.n - 1, this.row(maxY));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const y = this.center(r);
      xs.length = 0;
      for (let s = 0; s < segs.length; s += 4) {
        const y1 = segs[s + 1];
        const y2 = segs[s + 3];
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
          const x1 = segs[s];
          const x2 = segs[s + 2];
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] + this.half) / this.cell - 0.5));
        const c1 = Math.min(this.n - 1, Math.floor((xs[k + 1] + this.half) / this.cell - 0.5));
        for (let c = c0; c <= c1; c++) arr[r * this.n + c] = 1;
      }
    }
  }

  // Marks every cell within `buf` meters of the polyline.
  bufferLine(line, buf, arr) {
    const lim = this.half + buf;
    for (let i = 0; i + 1 < line.length; i++) {
      const [x1, y1] = line[i];
      const [x2, y2] = line[i + 1];
      if (Math.max(x1, x2) < -lim || Math.min(x1, x2) > lim) continue;
      if (Math.max(y1, y2) < -lim || Math.min(y1, y2) > lim) continue;
      const c0 = Math.max(0, this.col(Math.min(x1, x2) - buf));
      const c1 = Math.min(this.n - 1, this.col(Math.max(x1, x2) + buf));
      const r0 = Math.max(0, this.row(Math.min(y1, y2) - buf));
      const r1 = Math.min(this.n - 1, this.row(Math.max(y1, y2) + buf));
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy || 1;
      const b2 = buf * buf;
      for (let r = r0; r <= r1; r++) {
        const py = this.center(r);
        for (let c = c0; c <= c1; c++) {
          const px = this.center(c);
          const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
          const ex = x1 + t * dx - px;
          const ey = y1 + t * dy - py;
          if (ex * ex + ey * ey <= b2) arr[r * this.n + c] = 1;
        }
      }
    }
  }
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}
