// Map data from OpenFreeMap vector tiles (OpenStreetMap data, OpenMapTiles
// schema, served from a CDN). Much faster and more reliable than the public
// Overpass servers. Tiles are z14 (~2 km), decoded here with a small
// Mapbox-Vector-Tile reader, and turned into the same { nodes, roads,
// features } structure the graph builder uses.

export const VT_ZOOM = 14;
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const VT_CONCURRENCY = 6;
const VT_TIMEOUT_MS = 20000;
const WANTED = new Set(['transportation', 'transportation_name', 'park', 'landcover', 'landuse', 'water', 'waterway', 'poi']);

// ---------- Minimal protobuf + MVT decoding ----------

class Pbf {
  constructor(buf) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }
  varint() {
    let val = 0;
    let mul = 1;
    let b;
    do {
      b = this.buf[this.pos++];
      val += (b & 0x7f) * mul;
      mul *= 128;
    } while (b >= 0x80);
    return val;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error('bad wire type ' + wire);
  }
  string() {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  packed() {
    const end = this.varint() + this.pos;
    const out = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }
  sub() {
    const len = this.varint();
    const p = new Pbf(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return p;
  }
}

const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(p) {
  let v = null;
  while (p.pos < p.buf.length) {
    const tag = p.varint();
    const f = tag >> 3;
    const w = tag & 7;
    if (f === 1) v = p.string();
    else if (f === 2) { v = p.view.getFloat32(p.pos, true); p.pos += 4; }
    else if (f === 3) { v = p.view.getFloat64(p.pos, true); p.pos += 8; }
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) v = zigzag(p.varint());
    else if (f === 7) v = !!p.varint();
    else p.skip(w);
  }
  return v;
}

// Returns { layerName: { extent, features: [{ type, props, geom: [[x, y]...][] }] } }
export function decodeTile(buf, wanted = WANTED) {
  const p = new Pbf(buf);
  const layers = {};
  while (p.pos < p.buf.length) {
    const tag = p.varint();
    if (tag >> 3 !== 3) { p.skip(tag & 7); continue; }
    const lp = p.sub();
    let name = '';
    let extent = 4096;
    const keys = [];
    const values = [];
    const raw = [];
    while (lp.pos < lp.buf.length) {
      const t = lp.varint();
      const f = t >> 3;
      if (f === 1) name = lp.string();
      else if (f === 2) raw.push(lp.sub());
      else if (f === 3) keys.push(lp.string());
      else if (f === 4) values.push(readValue(lp.sub()));
      else if (f === 5) extent = lp.varint();
      else lp.skip(t & 7);
    }
    if (!wanted.has(name)) continue;
    const features = [];
    for (const fp of raw) {
      let type = 0;
      let tags = [];
      let cmds = [];
      while (fp.pos < fp.buf.length) {
        const t = fp.varint();
        const f = t >> 3;
        if (f === 2) tags = fp.packed();
        else if (f === 3) type = fp.varint();
        else if (f === 4) cmds = fp.packed();
        else fp.skip(t & 7);
      }
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      features.push({ type, props, geom: decodeGeometry(cmds) });
    }
    layers[name] = { extent, features };
  }
  return layers;
}

function decodeGeometry(cmds) {
  const parts = [];
  let cur = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >> 3;
    if (id === 7) {
      if (cur && cur.length) cur.push(cur[0]);
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]);
      y += zigzag(cmds[i++]);
      if (id === 1) {
        cur = [];
        parts.push(cur);
      }
      cur.push([x, y]);
    }
  }
  return parts;
}

// ---------- Tile math ----------

export function lonLatToTile(lon, lat, z = VT_ZOOM) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

// Global pixel coordinates (z14 tile * extent) -> [lat, lon]
function pixelToLatLon(gx, gy, worldSize) {
  const lon = (gx / worldSize) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / worldSize))) * 180) / Math.PI;
  return [lat, lon];
}

export function vtTilesFor(lat, lon, radius, z = VT_ZOOM) {
  const dLat = radius / 110574;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const [x0, y0] = lonLatToTile(lon - dLon, lat + dLat, z);
  const [x1, y1] = lonLatToTile(lon + dLon, lat - dLat, z);
  const [cx, cy] = lonLatToTile(lon, lat, z);
  const tiles = [];
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
      tiles.push({ z, x, y, key: `vt:${z}/${x}/${y}`, dist: Math.hypot(x + 0.5 - cx, y + 0.5 - cy), hasStart: x === Math.floor(cx) && y === Math.floor(cy) });
    }
  }
  return tiles.sort((a, b) => a.dist - b.dist);
}

// ---------- Fetching ----------

let tileUrlPromise = null;
async function tileUrlTemplate(fetchImpl) {
  tileUrlPromise ||= fetchImpl(TILEJSON)
    .then((r) => {
      if (!r.ok) throw new Error('tile service returned ' + r.status);
      return r.json();
    })
    .then((tj) => tj.tiles[0])
    .catch((err) => {
      tileUrlPromise = null;
      throw err;
    });
  return tileUrlPromise;
}

async function fetchBuffer(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (res.status === 204 || res.status === 404) return new ArrayBuffer(0); // empty tile (e.g. open sea)
    if (!res.ok) throw new Error('tile returned ' + res.status);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads (or reads from cache) the tiles. Returns { buffers: Map(key -> ArrayBuffer), failed: [keys] }. */
export async function fetchVectorTiles(tiles, { cache = null, onProgress = () => {}, fetchImpl = fetch } = {}) {
  const buffers = new Map();
  for (const t of tiles) {
    const hit = cache ? await cache.get(t.key) : null;
    if (hit) buffers.set(t.key, hit);
  }
  const queue = tiles.filter((t) => !buffers.has(t.key));
  const failed = [];
  let done = tiles.length - queue.length;
  onProgress(done, tiles.length);
  if (queue.length) {
    const template = await tileUrlTemplate(fetchImpl);
    let okCount = 0;
    const worker = async () => {
      while (queue.length) {
        // Circuit breaker: if the service is down (several failures, no
        // success at all), stop now so the caller can switch to the backup.
        if (!okCount && failed.length >= VT_CONCURRENCY) {
          failed.push(...queue.splice(0).map((q) => q.key));
          break;
        }
        const t = queue.shift();
        const url = template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
        let buf = null;
        for (let tryNo = 0; tryNo < 3 && !buf; tryNo++) {
          try {
            buf = await fetchBuffer(url, fetchImpl);
          } catch {
            await new Promise((r) => setTimeout(r, 400 * (tryNo + 1)));
          }
        }
        if (buf) {
          okCount++;
          buffers.set(t.key, buf);
          cache?.put(t.key, buf);
        } else failed.push(t.key);
        onProgress(++done, tiles.length);
      }
    };
    await Promise.all(Array.from({ length: VT_CONCURRENCY }, worker));
  }
  return { buffers, failed };
}

// ---------- Tiles -> roads and landscape ----------

// OpenMapTiles transportation class/subclass -> OSM-style highway value (null = not runnable).
// Runners stay on made surfaces: dirt tracks (OSM highway=track), bridleways, mountain-bike
// trails and anything tagged unpaved are left out of the network altogether. A bare
// "path" with no surface tag is kept, since many park paths are mapped that way, but it
// is marked rough (see roughFor) so routes only use it when there is nothing better.
// Trunk roads are kept when they are city streets (not slip roads, expressways or
// tunnels): in towns like Eilat the main boulevard is Route 90, and without it the
// side streets fall apart into islands. The planner prices them above primaries.
const isExpressway = (p) => p.ramp === 1 || p.ramp === '1' || p.expressway === 1 || p.expressway === '1' || p.brunnel === 'tunnel';
function highwayFor(p, long) {
  if (p.foot === 'no' || (p.access === 'no' && p.foot !== 'yes')) return null;
  if (p.mtb_scale !== undefined && p.mtb_scale !== null && p.mtb_scale !== '') return null; // a mountain-bike trail
  const unpaved = p.surface === 'unpaved';
  switch (p.class) {
    case 'primary':
    case 'secondary':
    case 'tertiary':
      return p.class;
    case 'trunk':
      return isExpressway(p) ? null : 'trunk';
    case 'minor':
      return unpaved ? null : 'residential';
    case 'service':
      if (long || unpaved || /^(parking_aisle|driveway|drive-through)$/.test(p.service || '')) return null;
      return 'service';
    case 'track':
      return p.surface === 'paved' && !long ? 'service' : null; // a paved farm/park track is just a small road
    case 'path': {
      const s = p.subclass || 'path';
      if (unpaved || s === 'bridleway') return null;
      if (s === 'steps') return long ? null : 'steps';
      if (/^(footway|cycleway|pedestrian|path)$/.test(s)) return s;
      return 'path';
    }
    default:
      return null; // motorways, trunks, rail, ferries...
  }
}
// 1 for a way whose surface is unknown and whose kind is usually a trail (highway=path).
const roughFor = (highway, p) => (highway === 'path' && p.surface !== 'paved' ? 1 : 0);
// Why a way was left out (for the audit of a loaded area).
function dropReason(p) {
  if (p.foot === 'no' || (p.access === 'no' && p.foot !== 'yes')) return 'no foot access';
  if (p.mtb_scale !== undefined && p.mtb_scale !== null && p.mtb_scale !== '') return 'mountain-bike trail';
  if (p.surface === 'unpaved') return `unpaved ${p.subclass || p.class}`;
  if (p.class === 'track') return 'dirt track';
  if (p.subclass === 'bridleway') return 'bridleway';
  if (p.class === 'service') return 'parking aisle / driveway';
  if (p.class === 'trunk') return p.brunnel === 'tunnel' ? 'trunk tunnel' : p.ramp ? 'trunk slip road' : 'expressway';
  if (/^(primary|secondary|tertiary|minor|path|track)$/.test(p.class)) return `${p.class} (not for this run length)`;
  return p.class; // motorway, rail, ferry...
}

// Liang-Barsky clip of segment a->b to the box [0, E]^2. Returns [t0, t1] or null.
function clipT(a, b, E) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks = [[-dx, a[0]], [dx, E - a[0]], [-dy, a[1]], [dy, E - a[1]]];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

/**
 * Builds { nodes, roads, features, stops } from decoded tiles. Roads are cut at
 * each tile's own border; the cut points from neighbouring tiles are merged so
 * streets stay connected across tiles.
 */
export function osmFromVectorTiles(tiles, buffers, { long = false } = {}) {
  const nodes = new Map();
  const roads = [];
  const features = [];
  const audit = { kept: {}, dropped: {} }; // ways by kind, and what was left out and why
  let wayId = 1;
  const borderIdx = new Map(); // "v|h:<border coord>:<rounded pos>" -> node id
  const sights = [];
  const namedLines = []; // street names: { name, local, pts: [[gx, gy]...] }
  const places = { tracks: [], parks: [], stadiums: [] }; // running spots: athletics tracks, named parks, stadium areas

  for (const t of tiles) {
    const buf = buffers.get(t.key);
    if (!buf || !buf.byteLength) continue;
    const layers = decodeTile(buf);
    const E = layers.transportation?.extent || layers.water?.extent || 4096;
    const world = E * 2 ** t.z;
    const ox = t.x * E;
    const oy = t.y * E;

    const nodeAt = (x, y, onBorder) => {
      let gx = ox + x;
      let gy = oy + y;
      if (onBorder) {
        // Cut points from both tiles land on the same border line, within ~1 px.
        const vertical = Math.abs(x) < 1e-3 || Math.abs(x - E) < 1e-3;
        const line = vertical ? Math.round(gx) : Math.round(gy);
        const pos = vertical ? gy : gx;
        const tag = vertical ? 'v' : 'h';
        let id = null;
        for (const d of [0, -1, 1]) {
          id = borderIdx.get(`${tag}${line}:${Math.round(pos) + d}`);
          if (id !== undefined) break;
        }
        if (id == null) {
          if (vertical) gx = line; else gy = line;
          id = Math.round(gx) * 2 ** 26 + Math.round(gy);
          borderIdx.set(`${tag}${line}:${Math.round(pos)}`, id);
          if (!nodes.has(id)) nodes.set(id, pixelToLatLon(gx, gy, world));
        }
        return id;
      }
      const id = Math.round(gx) * 2 ** 26 + Math.round(gy);
      if (!nodes.has(id)) nodes.set(id, pixelToLatLon(gx, gy, world));
      return id;
    };

    for (const f of layers.transportation?.features || []) {
      if (f.type !== 2) continue;
      const highway = highwayFor(f.props, long);
      if (!highway) {
        const why = dropReason(f.props);
        audit.dropped[why] = (audit.dropped[why] || 0) + 1;
        continue;
      }
      const rough = roughFor(highway, f.props);
      const kind = rough ? `${highway} (rough)` : highway;
      audit.kept[kind] = (audit.kept[kind] || 0) + 1;
      for (const line of f.geom) {
        let cur = null;
        const flush = () => {
          if (cur && cur.length > 1) roads.push({ id: wayId++, nodes: cur, tags: rough ? { highway, rough } : { highway } });
          cur = null;
        };
        for (let i = 0; i + 1 < line.length; i++) {
          const a = line[i];
          const b = line[i + 1];
          const tt = clipT(a, b, E);
          if (!tt) { flush(); continue; }
          const [t0, t1] = tt;
          const pa = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
          const pb = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
          if (!cur) cur = [nodeAt(pa[0], pa[1], t0 > 0)];
          const idB = nodeAt(pb[0], pb[1], t1 < 1);
          if (idB !== cur[cur.length - 1]) cur.push(idB);
          if (t1 < 1) flush();
        }
        flush();
      }
    }

    const toLatLon = (ring) => ring.map(([x, y]) => pixelToLatLon(ox + x, oy + y, world));
    for (const f of layers.park?.features || []) {
      if (f.type === 3) features.push({ kind: 'green', shape: 'area', buffer: 15, rings: f.geom.map(toLatLon), relation: true });
    }
    for (const f of layers.landcover?.features || []) {
      if (f.type !== 3) continue;
      const c = f.props.class;
      const s = f.props.subclass;
      if (c === 'sand' && s === 'beach') features.push({ kind: 'water', shape: 'area', buffer: 60, rings: f.geom.map(toLatLon), relation: true });
      else if (/^(wood|grass|wetland)$/.test(c) || /^(park|garden|meadow|forest|wood|scrub|heath|grassland|recreation_ground|village_green)$/.test(s || '')) {
        const rings = f.geom.map(toLatLon);
        features.push({ kind: 'green', shape: 'area', buffer: 0, rings, relation: true });
        // Open country (not a park): a path with no surface tag here is a dirt trail.
        if (c === 'wood' || c === 'wetland' || /^(forest|wood|scrub|heath|grassland)$/.test(s || '')) features.push({ kind: 'wild', shape: 'area', buffer: 20, rings, relation: true });
      }
    }
    for (const f of layers.water?.features || []) {
      if (f.type === 3) features.push({ kind: 'water', shape: 'body', buffer: 0, rings: f.geom.map(toLatLon), relation: true });
    }
    for (const f of layers.poi?.features || []) {
      if (f.type !== 1) continue;
      const [x, y] = f.geom[0]?.[0] || [];
      if (x === undefined || x < 0 || y < 0 || x >= E || y >= E) continue; // each POI once (own tile only)
      const [lat, lon] = pixelToLatLon(ox + x, oy + y, world);
      const cls = f.props.class;
      if (cls === 'park' || cls === 'stadium') {
        const { name, local } = namesOf(f.props);
        if (name) (cls === 'park' ? places.parks : places.stadiums).push({ name, local, lat, lon, rank: f.props.rank ?? 99 });
      }
      const sight = sightFromPoi(f.props);
      if (!sight) continue;
      sights.push({ ...sight, lat, lon });
    }
    // Athletics tracks are 'track' areas in the landuse layer (no names there).
    for (const f of layers.landuse?.features || []) {
      if (f.type !== 3 || (f.props.class !== 'track' && f.props.class !== 'stadium')) continue;
      const ring = f.geom[0];
      if (!ring || ring.length < 4) continue;
      let cx = 0, cy = 0;
      for (const [x, y] of ring) { cx += x; cy += y; }
      cx /= ring.length; cy /= ring.length;
      if (cx < 0 || cy < 0 || cx >= E || cy >= E) continue; // once, in its own tile
      places.tracks.push({ ring: toLatLon(ring), lat: pixelToLatLon(ox + cx, oy + cy, world)[0], lon: pixelToLatLon(ox + cx, oy + cy, world)[1], cls: f.props.class });
    }
    for (const f of layers.transportation_name?.features || []) {
      if (f.type !== 2) continue;
      const { name, local } = namesOf(f.props);
      if (!name) continue;
      // Keep only the pieces inside this tile (other tiles cover the rest).
      const inside = (p) => p[0] >= -16 && p[0] <= E + 16 && p[1] >= -16 && p[1] <= E + 16;
      for (const line of f.geom) {
        let run = [];
        for (let i = 0; i < line.length; i++) {
          const keep = inside(line[i]) || (i > 0 && inside(line[i - 1])) || (i + 1 < line.length && inside(line[i + 1]));
          if (keep) run.push([ox + line[i][0], oy + line[i][1]]);
          else if (run.length) { if (run.length > 1) namedLines.push({ name, local, pts: run }); run = []; }
        }
        if (run.length > 1) namedLines.push({ name, local, pts: run });
      }
    }
    for (const f of layers.waterway?.features || []) {
      if (f.type !== 2 || !/^(river|canal|stream)$/.test(f.props.class)) continue;
      const width = f.props.class === 'river' ? 40 : 10;
      features.push({ kind: 'water', shape: 'line', buffer: 60 + width / 2, rings: f.geom.map(toLatLon) });
    }
  }
  repairJunctions(nodes, roads);
  nameRoads(roads, namedLines);
  return { nodes, roads, features, stops: new Map(), sights: dedupeSights(sights), places, audit };
}

// ---------- Landmarks and street names ----------

// Landmarks worth a detour on a sightseeing run, by OSM tag value, with how
// interesting each kind is (0..1). Only the guidebook stuff: museums, monuments
// and memorials, castles and fortifications, historic sites, famous theatres,
// viewpoints, major attractions and notable public artwork. Neighbourhood
// synagogues and churches, commercial galleries, fountains and small parks
// are left out on purpose.
const SIGHT_WEIGHT = {
  museum: 1, castle: 1, palace: 1, fort: 0.95, city_gate: 0.9, monument: 0.9, archaeological_site: 0.9,
  cathedral: 0.9, ruins: 0.85, attraction: 0.85, lighthouse: 0.85, viewpoint: 0.8, theatre: 0.7,
  memorial: 0.6, aquarium: 0.6, zoo: 0.6, clock: 0.6, townhall: 0.55, town_hall: 0.55, artwork: 0.5,
};
// Kinds that only count when OpenStreetMap has an English name for them (a sign
// that the place is known beyond its neighbourhood).
const NEEDS_EN = new Set(['theatre', 'memorial', 'townhall', 'town_hall', 'artwork', 'clock', 'attraction', 'zoo', 'aquarium']);
// Artwork entries that are really plaques, signs, shops or street decoration.
const NOT_ARTWORK = /plaque|heritage|graffiti|sticker|poster|information|sign\b|mosaic bench|gallery|tattoo|studio|shop|store|^untitled|^unknown/i;
const SIGHT_LABEL = {
  museum: 'museum', castle: 'castle', palace: 'palace', fort: 'fort', city_gate: 'city gate', monument: 'monument',
  archaeological_site: 'historic site', cathedral: 'cathedral', ruins: 'ruins', attraction: 'attraction',
  lighthouse: 'lighthouse', viewpoint: 'viewpoint', theatre: 'theatre', memorial: 'memorial', aquarium: 'aquarium',
  zoo: 'zoo', clock: 'clock tower', townhall: 'town hall', town_hall: 'town hall', artwork: 'artwork',
};

function namesOf(p) {
  // OpenMapTiles' name_en falls back to the local name, so only a real translation counts as English.
  const en = p['name:en'] || (p.name_en && p.name_en !== p.name ? p.name_en : '') || '';
  const local = p.name || p['name:latin'] || en;
  return { name: en || local, local, en };
}

export function sightFromPoi(p) {
  const key = SIGHT_WEIGHT[p.subclass] !== undefined ? p.subclass : p.class;
  const weight = SIGHT_WEIGHT[key];
  if (!weight) return null;
  if (key === 'theatre' && p.subclass && p.subclass !== 'theatre') return null; // cinemas etc.
  if ((key === 'town_hall' || key === 'townhall') && p.subclass !== 'townhall') return null; // community centres
  const { name, local, en } = namesOf(p);
  if (!name) return null;
  if (NEEDS_EN.has(key) && !en) return null;
  if (key === 'artwork' && NOT_ARTWORK.test(name)) return null;
  if (key === 'museum' && /\bgallery\b/i.test(name) && !/museum/i.test(name)) return null; // commercial galleries
  return { name, local, kind: SIGHT_LABEL[key] || key, weight };
}

// One entry per landmark: the same place is often mapped twice (a building and
// a point, or a Hebrew-only duplicate), so anything within ~40 m of a better entry is dropped.
function dedupeSights(list) {
  const better = (a, b) => (a.name !== a.local) - (b.name !== b.local) || a.weight - b.weight;
  const sorted = [...list].sort((a, b) => better(b, a));
  const kept = [];
  for (const s of sorted) {
    const dup = kept.some((k) => Math.abs(k.lat - s.lat) < 0.00036 && Math.abs(k.lon - s.lon) < 0.00036 / Math.cos((s.lat * Math.PI) / 180));
    if (!dup) kept.push(s);
  }
  return kept;
}

// Gives each street the name of the named line it runs along (within ~5 m).
function nameRoads(roads, namedLines) {
  if (!namedLines.length) return;
  const CELL = 32;
  const NEAR = 10; // px
  const grid = new Map();
  namedLines.forEach((l, li) => {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, ay] = l.pts[i];
      const [bx, by] = l.pts[i + 1];
      for (let cx = Math.floor((Math.min(ax, bx) - NEAR) / CELL); cx <= Math.floor((Math.max(ax, bx) + NEAR) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - NEAR) / CELL); cy <= Math.floor((Math.max(ay, by) + NEAR) / CELL); cy++) {
          const k = cx * 1e7 + cy;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(li, i);
        }
      }
    }
  });
  const px = (id) => [Math.floor(id / 2 ** 26), id % 2 ** 26];
  for (const r of roads) {
    const votes = new Map();
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const [ax, ay] = px(r.nodes[i]);
      const [bx, by] = px(r.nodes[i + 1]);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const list = grid.get(Math.floor(mx / CELL) * 1e7 + Math.floor(my / CELL));
      if (!list) continue;
      let best = -1;
      let bestD = NEAR;
      for (let k = 0; k < list.length; k += 2) {
        const l = namedLines[list[k]];
        const [cx, cy] = l.pts[list[k + 1]];
        const [dx, dy] = l.pts[list[k + 1] + 1];
        const vx = dx - cx;
        const vy = dy - cy;
        const t = Math.max(0, Math.min(1, ((mx - cx) * vx + (my - cy) * vy) / (vx * vx + vy * vy || 1)));
        const d = Math.hypot(cx + t * vx - mx, cy + t * vy - my);
        if (d < bestD) {
          bestD = d;
          best = list[k];
        }
      }
      if (best >= 0) votes.set(best, (votes.get(best) || 0) + 1);
    }
    let win = -1;
    let n = 0;
    for (const [li, c] of votes) if (c > n) { n = c; win = li; }
    if (win >= 0 && n * 2 >= r.nodes.length - 1) {
      r.tags.name = namedLines[win].name;
      r.tags.local = namedLines[win].local;
    }
  }
}

// Tiles simplify street shapes slightly, so where a path meets a street mid-block
// (a "T"), the shared point can be missing and the path ends ~1 m short. Connect
// every dead end that lies within SNAP_PX (~4 m) of another street to that street.
const SNAP_PX = 8; // z14 pixel ≈ 0.5 m
function repairJunctions(nodes, roads) {
  const px = (id) => [Math.floor(id / 2 ** 26), id % 2 ** 26];
  const degree = new Map();
  for (const r of roads) {
    for (let i = 0; i < r.nodes.length; i++) {
      const d = i === 0 || i === r.nodes.length - 1 ? 1 : 2;
      degree.set(r.nodes[i], (degree.get(r.nodes[i]) || 0) + d);
    }
  }
  // Spatial hash of segments.
  const CELL = 64;
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 1e7 + cy;
  roads.forEach((r, ri) => {
    for (let si = 0; si + 1 < r.nodes.length; si++) {
      const [ax, ay] = px(r.nodes[si]);
      const [bx, by] = px(r.nodes[si + 1]);
      for (let cx = Math.floor((Math.min(ax, bx) - SNAP_PX) / CELL); cx <= Math.floor((Math.max(ax, bx) + SNAP_PX) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - SNAP_PX) / CELL); cy <= Math.floor((Math.max(ay, by) + SNAP_PX) / CELL); cy++) {
          const k = cellKey(cx, cy);
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(ri, si);
        }
      }
    }
  });

  const endRoad = new Map(); // dead-end node -> highway of its street
  for (const r of roads) {
    endRoad.set(r.nodes[0], r.tags.highway);
    endRoad.set(r.nodes[r.nodes.length - 1], r.tags.highway);
  }
  const splits = new Map(); // "ri:si" -> [[t, nodeId], ...]
  const connectors = [];
  for (const [id, deg] of degree) {
    if (deg !== 1) continue;
    const [x, y] = px(id);
    const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!list) continue;
    let best = null;
    for (let k = 0; k < list.length; k += 2) {
      const ri = list[k];
      const si = list[k + 1];
      const a = roads[ri].nodes[si];
      const b = roads[ri].nodes[si + 1];
      if (a === id || b === id) continue;
      const [ax, ay] = px(a);
      const [bx, by] = px(b);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
      if (d <= SNAP_PX && (!best || d < best.d)) best = { d, ri, si, t, a, b, qx: ax + t * dx, qy: ay + t * dy };
    }
    if (!best) continue;
    const highway = endRoad.get(id) || 'footway';
    const segLen = Math.hypot(...px(best.b).map((v, i) => v - px(best.a)[i]));
    let target;
    if (best.t * segLen < 2) target = best.a;
    else if ((1 - best.t) * segLen < 2) target = best.b;
    else {
      target = Math.round(best.qx) * 2 ** 26 + Math.round(best.qy);
      if (!nodes.has(target)) nodes.set(target, nodes.get(best.a) && interpolate(nodes.get(best.a), nodes.get(best.b), best.t));
      const key = best.ri + ':' + best.si;
      if (!splits.has(key)) splits.set(key, []);
      splits.get(key).push([best.t, target]);
    }
    if (target !== id) connectors.push({ id: -connectors.length - 1, nodes: [id, target], tags: { highway } });
  }
  // Insert split points into their streets (in order along each segment).
  const byRoad = new Map();
  for (const [key, pts] of splits) {
    const [ri, si] = key.split(':').map(Number);
    if (!byRoad.has(ri)) byRoad.set(ri, []);
    byRoad.get(ri).push([si, pts.sort((p, q) => p[0] - q[0])]);
  }
  for (const [ri, segs] of byRoad) {
    const r = roads[ri];
    segs.sort((p, q) => q[0] - p[0]); // back to front keeps indices valid
    for (const [si, pts] of segs) r.nodes.splice(si + 1, 0, ...pts.map((p) => p[1]).filter((n, i, arr) => arr.indexOf(n) === i));
  }
  roads.push(...connectors);
}

function interpolate(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
