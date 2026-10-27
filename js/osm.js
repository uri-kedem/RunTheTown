// Fetches runnable paths and landscape features from OpenStreetMap (Overpass API).
// fetchTiles downloads raw JSON per tile (cacheable); parseOverpass turns it into data.

// Public Overpass servers differ a lot in speed and rate limits. Map data is
// downloaded in tiles on a fixed grid, spread over two main servers with
// fallbacks, and each tile is cached on the device (see cache.js).
export const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const ATTEMPT_TIMEOUT_MS = 75000;

const RUNNABLE =
  'footway|path|pedestrian|living_street|residential|service|cycleway|steps|unclassified|' +
  'tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|trunk|road';

// Surfaces as OSM tags them, grouped the way OpenMapTiles does (paved / unpaved).
const UNPAVED = /^(unpaved|compacted|dirt|earth|fine_gravel|grass|grass_paver|gravel|gravel_turf|ground|ice|mud|pebblestone|rock|salt|sand|snow|soil|stone|woodchips)$/;
const PAVED = /^(paved|asphalt|chipseal|cobblestone|concrete|concrete:lanes|concrete:plates|metal|paving_stones|sett|unhewn_cobblestone|wood|bricks?|tiles|rubber|tartan)$/;
export function surfaceKind(tags = {}) {
  const s = String(tags.surface || '').split(';')[0].trim().toLowerCase();
  return UNPAVED.test(s) ? 'unpaved' : PAVED.test(s) ? 'paved' : null;
}
/**
 * The way as the runner's network sees it: null when it is not for running on
 * (dirt tracks, bridleways, mountain-bike or hiking trails, anything unpaved),
 * otherwise { highway, rough } where rough marks a bare path of unknown surface.
 */
export function runnableTags(tags) {
  const h = tags.highway;
  if (!h || h === 'bridleway' || tags.mtb_scale || tags.sac_scale) return null;
  // A trunk road is kept only as a city street: not an expressway, slip road or tunnel.
  if (h === 'trunk' && (tags.motorroad === 'yes' || tags.expressway === 'yes' || (tags.tunnel && tags.tunnel !== 'no'))) return null;
  const surf = surfaceKind(tags);
  if (surf === 'unpaved') return null;
  if (h === 'track') return surf === 'paved' ? { highway: 'service', rough: 0 } : null;
  // A shared foot-and-bike path (bicycle=designated) is a made surface: promenades, boardwalks
  // and park paths are mapped that way, and they run on for kilometres.
  const bike = isBikeRoute(h, tags.bicycle, tags.foot);
  return { highway: h, rough: h === 'path' && surf !== 'paved' && !bike ? 1 : 0, bike };
}

// 1 for a car-free way that is part of a bike route: a cycleway open to walkers, or a
// footway / path / pedestrian street where bikes are designated. Long continuous bike
// routes trace the promenades and boardwalks of a city.
export function isBikeRoute(highway, bicycle, foot) {
  if (foot === 'no') return 0;
  if (highway === 'cycleway') return 1;
  if (/^(footway|path|pedestrian|living_street)$/.test(highway || '') && /^(designated|yes)$/.test(bicycle || '')) return 1;
  return 0;
}
// Long runs cover a much bigger area. They skip separately-mapped sidewalks
// (the street itself is the route), service alleys, tracks and steps, and keep
// only traffic lights as stops. In a city like Tel Aviv that cuts the data
// several times over.
const RUNNABLE_LONG =
  'footway|path|pedestrian|living_street|residential|cycleway|unclassified|' +
  'tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|trunk';

// Tile size in degrees of latitude (longitude is scaled to keep tiles ~square).
export const TILE_DEG = { full: 0.03, long: 0.06 };

function toBbox(s, w, n, e) {
  return [s, w, n, e].map((v) => v.toFixed(5)).join(',');
}

export function bboxFor(lat, lon, radius) {
  const dLat = radius / 110574;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  return toBbox(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
}

// Grid tiles covering the circle (lat, lon, radius), nearest first.
export function tilesFor(lat, lon, radius, mode = 'full') {
  const size = TILE_DEG[mode];
  const sizeLon = size / Math.cos((lat * Math.PI) / 180);
  const dLat = radius / 110574;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const tiles = [];
  for (let iy = Math.floor((lat - dLat) / size); iy <= Math.floor((lat + dLat) / size); iy++) {
    for (let ix = Math.floor((lon - dLon) / sizeLon); ix <= Math.floor((lon + dLon) / sizeLon); ix++) {
      const s = iy * size;
      const w = ix * sizeLon;
      const cy = s + size / 2;
      const cx = w + sizeLon / 2;
      tiles.push({
        key: `${mode}:${size}:${ix}:${iy}`,
        s, w, n: s + size, e: w + sizeLon,
        contains: (la, lo) => la >= s && la < s + size && lo >= w && lo < w + sizeLon,
        dist: Math.hypot((cy - lat) * 110574, (cx - lon) * 111320 * Math.cos((lat * Math.PI) / 180)),
      });
    }
  }
  return tiles.sort((a, b) => a.dist - b.dist);
}

// One request per tile: runnable ways, the stops on them, their nodes, and the
// parks/water features of the tile.
export function tileQuery(t, mode = 'full') {
  const long = mode === 'long';
  const ways = long
    ? `way["highway"~"^(${RUNNABLE_LONG})$"]["footway"!~"^(sidewalk|crossing)$"]`
    : `way["highway"~"^(${RUNNABLE})$"]["service"!~"^(parking_aisle|driveway|drive-through)$"]`;
  const stops = long
    ? 'node(w.r)["highway"="traffic_signals"];out qt;'
    : 'node(w.r)["highway"~"^(traffic_signals|crossing|stop)$"];out qt;node(w.r)["crossing"];out qt;';
  return (
    `[out:json][timeout:90][bbox:${toBbox(t.s, t.w, t.n, t.e)}];` +
    `${ways}["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"]["area"!="yes"]->.r;.r out body qt;` +
    stops +
    '.r >;out skel qt;' +
    '(way["leisure"~"^(park|garden|nature_reserve|recreation_ground|golf_course|marina)$"];' +
    'relation["leisure"~"^(park|garden|nature_reserve)$"];' +
    'way["landuse"~"^(forest|grass|meadow|recreation_ground|village_green|military|railway|quarry|industrial|garages)$"];relation["landuse"~"^(forest|military)$"];' +
    'way["amenity"~"^(hospital|school|college|university|prison)$"];way["military"];' +
    'way["natural"~"^(wood|scrub|heath|grassland|wetland|water|beach|coastline)$"];relation["natural"~"^(wood|water)$"];' +
    'way["waterway"~"^(river|canal|stream|riverbank)$"];);out geom qt;'
  );
}

async function attempt(url, query, outerSignal, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  outerSignal?.addEventListener('abort', onAbort);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`map server returned ${res.status}`), { status: res.status });
    const json = await res.json();
    if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error('map server timed out');
    return json;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Downloads tiles with a small worker pool: two workers per main server, each
 * falling back to the other servers if its own is slow or refuses. Cached tiles
 * are skipped. Returns { elements, failed: [tile keys] } and never throws for
 * individual tile failures (the caller decides if enough of the map loaded).
 */
export async function fetchTiles(tiles, mode, { cache = null, onProgress = () => {}, signal, fetchImpl = fetch } = {}) {
  const results = new Map();
  for (const t of tiles) {
    const hit = cache ? await cache.get(t.key) : null;
    if (hit) results.set(t.key, hit);
  }
  const queue = tiles.filter((t) => !results.has(t.key));
  const failed = [];
  let done = tiles.length - queue.length;
  onProgress(done, tiles.length);

  // A server that just failed or timed out is tried last for a while, so one
  // slow server doesn't make every remaining piece wait for its timeout.
  const coolOff = new Map(); // url -> time until which it's deprioritised
  const isCool = (url) => (coolOff.get(url) || 0) > Date.now();

  const worker = async (home) => {
    while (queue.length) {
      const t = queue.shift();
      const base = [ENDPOINTS[home], ENDPOINTS[1 - home], ...ENDPOINTS.slice(2)];
      const order = [...base.filter((u) => !isCool(u)), ...base.filter(isCool)];
      let json = null;
      for (let i = 0; i < order.length && !json; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          json = await attempt(order[i], tileQuery(t, mode), signal, fetchImpl);
        } catch (err) {
          if (err.name === 'AbortError' && signal?.aborted) throw err;
          coolOff.set(order[i], Date.now() + 60000);
          await wait(err.status === 429 ? 2500 : 500); // back off before the next server
        }
      }
      if (json) {
        results.set(t.key, json.elements);
        cache?.put(t.key, json.elements);
      } else {
        failed.push(t.key);
      }
      onProgress(++done, tiles.length);
    }
  };
  await Promise.all([worker(0), worker(1), worker(0), worker(1)]);

  // Ways and relations crossing tile borders come back from several tiles: keep one copy.
  const seen = new Set();
  const elements = [];
  for (const t of tiles) {
    for (const el of results.get(t.key) || []) {
      const key = el.type[0] + el.id + (el.tags ? 't' : '');
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }
  return { elements, failed };
}

const GREEN = {
  leisure: /^(park|garden|nature_reserve|recreation_ground|golf_course)$/,
  landuse: /^(forest|grass|meadow|recreation_ground|village_green)$/,
  natural: /^(wood|scrub|heath|grassland|wetland)$/,
};

// Seaside features (coastline, beaches) also count as 'sea' — see seaFeature().
export function classifyFeature(tags = {}) {
  if (tags.natural === 'coastline') return { kind: 'water', shape: 'line', buffer: 110 };
  if (tags.waterway) {
    const width = parseFloat(tags.width) || (tags.waterway === 'river' ? 40 : 10);
    return { kind: 'water', shape: 'line', buffer: 60 + width / 2 };
  }
  if (tags.natural === 'beach') return { kind: 'water', shape: 'area', buffer: 60 };
  if (tags.natural === 'water' || tags.leisure === 'marina') return { kind: 'water', shape: 'edge', buffer: 70 };
  for (const [k, re] of Object.entries(GREEN)) {
    if (tags[k] && re.test(tags[k])) return { kind: 'green', shape: 'area', buffer: 15 };
  }
  return null;
}

// A marina basin and its quays (within ~35 m of the water): docks, where a footway or
// service road is a quay or a pontoon, not a running route (see Graph).
export const DOCK = { kind: 'dock', shape: 'area', buffer: 35 };

export function ringsOf(el) {
  let rings = [];
  if (el.type === 'way' && el.geometry) rings = [el.geometry.filter(Boolean).map((p) => [p.lat, p.lon])];
  else if (el.members) rings = el.members.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry.filter(Boolean).map((p) => [p.lat, p.lon]));
  return rings.filter((r) => r.length >= 2);
}

// What the sidewalk tag says: 'no' (none at all), 'yes' (one side or both, or mapped
// separately), or null when the tag is missing or unclear.
export function sidewalkKind(tags = {}) {
  const v = tags.sidewalk || tags['sidewalk:both'];
  if (!v) return null;
  if (/^(no|none)$/.test(v)) return tags['sidewalk:left'] === 'yes' || tags['sidewalk:right'] === 'yes' ? 'yes' : 'no';
  if (/^(both|left|right|separate|yes|lane)$/.test(v)) return 'yes';
  return null;
}

// Stamps the sidewalk tag from Overpass onto the tile roads it runs along (tile roads carry
// no sidewalk tag): a road whose nodes mostly lie within ~12 m of a tagged way takes its answer.
export function applySidewalkTags(osm, sidewalks, proj) {
  if (!sidewalks?.length) return 0;
  const CELL = 12;
  const key = (x, y) => `${Math.round(x / CELL)}:${Math.round(y / CELL)}`;
  const marks = new Map(); // cell -> 'no' | 'yes'
  for (const sw of sidewalks) {
    const xy = sw.pts.map(([la, lo]) => proj.toXY(la, lo));
    for (let i = 0; i < xy.length; i++) {
      const [x0, y0] = xy[i];
      marks.set(key(x0, y0), sw.no ? 'no' : 'yes');
      if (i + 1 < xy.length) {
        const [x1, y1] = xy[i + 1];
        const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2));
        for (let k = 1; k < steps; k++) marks.set(key(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps), sw.no ? 'no' : 'yes');
      }
    }
  }
  let stamped = 0;
  for (const road of osm.roads) {
    if (road.tags.sidewalk || !/^(tertiary|secondary|primary|trunk|unclassified)/.test(road.tags.highway)) continue;
    let no = 0, yes = 0, cnt = 0;
    for (const id of road.nodes) {
      const p = osm.nodes.get(id);
      if (!p) continue;
      const [x, y] = proj.toXY(p[0], p[1]);
      cnt++;
      let hit = null;
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) hit = marks.get(key(x + dx * CELL, y + dy * CELL)) || null;
      if (hit === 'no') no++;
      else if (hit === 'yes') yes++;
    }
    if (cnt && no / cnt >= 0.5) { road.tags = { ...road.tags, sidewalk: 'no' }; stamped++; }
    else if (cnt && yes / cnt >= 0.5) { road.tags = { ...road.tags, sidewalk: 'yes' }; stamped++; }
  }
  return stamped;
}

// The sea apart from other water: land within reach of the coastline or a beach.
export function seaFeature(tags = {}) {
  if (tags.natural === 'coastline') return { kind: 'sea', shape: 'line', buffer: 110 };
  if (tags.natural === 'beach') return { kind: 'sea', shape: 'area', buffer: 60 };
  return null;
}

// Open country (woods, scrub, heath, nature reserves): a bare path here is a dirt trail.
export function wildFeature(tags = {}) {
  if (/^(wood|scrub|heath|grassland|wetland)$/.test(tags.natural || '') || tags.landuse === 'forest' || tags.leisure === 'nature_reserve') return { kind: 'wild', shape: 'area', buffer: 20 };
  // Land a runner cannot pass through (its paths leave the network) and fenced compounds
  // (their small paths and alleys are a last resort).
  if (/^(military|railway|quarry)$/.test(tags.landuse || '') || tags.military || tags.amenity === 'prison') return { kind: 'closed', shape: 'area', buffer: 5 };
  if (tags.leisure === 'marina') return DOCK;
  if (/^(industrial|garages)$/.test(tags.landuse || '') || /^(hospital|school|college|university)$/.test(tags.amenity || '')) return { kind: 'compound', shape: 'area', buffer: 0 };
  return null;
}

// Turns Overpass JSON into { nodes: Map(id -> [lat, lon]), roads: [...], features: [...] }.
// A feature carries `rings`: arrays of [lat, lon] (all member lines for relations).
// Where a runner may have to stop: 2 = traffic light, 1 = crosswalk/stop sign, 0 = none.
export const STOP = { NONE: 0, CROSSING: 1, SIGNAL: 2 };
export function stopKind(tags = {}) {
  if (tags.crossing === 'no') return STOP.NONE;
  if (tags.highway === 'traffic_signals' || tags.crossing === 'traffic_signals') return STOP.SIGNAL;
  if (/^(pelican|toucan|puffin|pegasus)$/.test(tags.crossing_ref || '')) return STOP.SIGNAL;
  if (tags['crossing:signals'] === 'yes') return STOP.SIGNAL;
  if (tags.highway === 'crossing' || tags.highway === 'stop' || tags.crossing) return STOP.CROSSING;
  return STOP.NONE;
}

export function parseOverpass(json) {
  const nodes = new Map();
  const stops = new Map(); // node id -> STOP kind
  const roads = [];
  const features = [];
  for (const el of json.elements || []) {
    if (el.type !== 'node') continue;
    nodes.set(el.id, [el.lat, el.lon]);
    if (el.tags) {
      const k = stopKind(el.tags);
      if (k > (stops.get(el.id) || 0)) stops.set(el.id, k);
    }
  }
  for (const el of json.elements || []) {
    if (el.type === 'way' && el.nodes && !el.geometry && el.tags?.highway) {
      const run = runnableTags(el.tags);
      if (run) roads.push({ id: el.id, nodes: el.nodes, tags: run.rough || run.bike || run.highway !== el.tags.highway ? { ...el.tags, highway: run.highway, rough: run.rough, bike: run.bike } : el.tags });
      continue;
    }
    if (el.type !== 'way' && el.type !== 'relation') continue;
    const cls = classifyFeature(el.tags);
    const wild = wildFeature(el.tags); // open country, closed ground, fenced compounds
    const sea = seaFeature(el.tags);
    if (!cls && !wild) continue;
    let rings = [];
    if (el.type === 'way' && el.geometry) {
      rings = [el.geometry.filter(Boolean).map((p) => [p.lat, p.lon])];
    } else if (el.members) {
      rings = el.members
        .filter((m) => m.type === 'way' && m.geometry)
        .map((m) => m.geometry.filter(Boolean).map((p) => [p.lat, p.lon]));
    }
    rings = rings.filter((r) => r.length >= 2);
    if (rings.length) {
      if (cls) features.push({ ...cls, rings, relation: el.type === 'relation' });
      if (wild) features.push({ ...wild, rings, relation: el.type === 'relation' });
      if (sea) features.push({ ...sea, rings, relation: el.type === 'relation' });
    }
  }
  return { nodes, stops, roads, features };
}

/**
 * Traffic lights and crosswalks for an area (vector tiles don't carry them).
 * One small query, raced on the two main servers. Best-effort: returns
 * [[lat, lon, kind], ...] or null if the servers don't answer in time.
 */
export async function fetchStops(lat, lon, radius, { long = false, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const sel = long
    ? 'node["highway"="traffic_signals"];'
    : '(node["highway"~"^(traffic_signals|crossing|stop)$"];node["crossing"];);';
  // Marina basins come along (vector tiles don't tell a harbour from a lake): the
  // quays and pontoons around them are not running routes.
  // Roads that say whether they have a sidewalk come along too (the tiles drop the tag).
  const query = `[out:json][timeout:25][bbox:${bboxFor(lat, lon, radius)}];(${sel}way["leisure"="marina"];relation["leisure"="marina"];way["highway"~"^(tertiary|secondary|primary|trunk|unclassified)$"]["sidewalk"];);out geom qt;`;
  const ctrls = [];
  const one = async (url) => {
    const ctrl = new AbortController();
    ctrls.push(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('status ' + res.status);
      const json = await res.json();
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error('timed out');
      return json;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const json = await Promise.any(ENDPOINTS.slice(0, 2).map(one));
    ctrls.forEach((c) => c.abort());
    const out = [];
    const docks = [];
    const sidewalks = []; // [{ no: true|false, pts: [[lat, lon], …] }] from the sidewalk tag
    for (const el of json.elements || []) {
      const k = el.type === 'node' && el.tags ? stopKind(el.tags) : 0;
      if (k) out.push([el.lat, el.lon, k]);
      if (el.type !== 'node' && el.tags?.leisure === 'marina') {
        const rings = ringsOf(el);
        if (rings.length) docks.push({ ...DOCK, rings, relation: el.type === 'relation' });
      }
      if (el.type === 'way' && el.tags?.sidewalk && el.geometry) {
        const sw = sidewalkKind(el.tags);
        if (sw) sidewalks.push({ no: sw === 'no', pts: el.geometry.filter(Boolean).map((p) => [p.lat, p.lon]) });
      }
    }
    out.docks = docks;
    out.sidewalks = sidewalks;
    return out;
  } catch {
    return null;
  }
}
