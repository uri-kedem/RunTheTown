// A fake map backend for offline tests:
//  - OpenFreeMap-style vector tiles (real MVT encoding, OpenMapTiles layers)
//    generated from an in-memory OSM dataset (the synthetic cities);
//  - the small Overpass "stops" query (traffic lights / crossings);
//  - the full Overpass tile queries (delegated to mock-overpass.mjs) for the backup path.
// Each part can be made flaky or down.

import { makeMockFetch } from './mock-overpass.mjs';

const E = 4096;
const TEMPLATE = 'https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf';

// ---------- tiny protobuf writer ----------
class W {
  constructor() { this.b = []; }
  varint(v) { while (v >= 0x80) { this.b.push((v % 128) | 0x80); v = Math.floor(v / 128); } this.b.push(v); return this; }
  tag(f, w) { return this.varint(f * 8 + w); }
  bytes(f, arr) { this.tag(f, 2).varint(arr.length); for (const x of arr) this.b.push(x); return this; }
  str(f, s) { return this.bytes(f, [...new TextEncoder().encode(s)]); }
  packed(f, vals) { const w = new W(); for (const v of vals) w.varint(v); return this.bytes(f, w.b); }
}
const zz = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

function encodeGeom(parts, closed) {
  const out = [];
  let cx = 0, cy = 0;
  for (const part of parts) {
    const pts = closed ? part.slice(0, -1) : part;
    out.push((1 & 7) | (1 << 3), zz(pts[0][0] - cx), zz(pts[0][1] - cy));
    [cx, cy] = pts[0];
    if (pts.length === 1) continue; // a point
    out.push((2 & 7) | ((pts.length - 1) << 3));
    for (const p of pts.slice(1)) { out.push(zz(p[0] - cx), zz(p[1] - cy)); [cx, cy] = p; }
    if (closed) out.push((7 & 7) | (1 << 3));
  }
  return out;
}

function encodeTile(layers) {
  const tile = new W();
  for (const [name, feats] of Object.entries(layers)) {
    if (!feats.length) continue;
    const keys = [], values = [], ki = new Map(), vi = new Map();
    const layer = new W().str(1, name);
    for (const f of feats) {
      const tags = [];
      for (const [k, v] of Object.entries(f.props)) {
        if (!ki.has(k)) { ki.set(k, keys.length); keys.push(k); }
        if (!vi.has(v)) { vi.set(v, values.length); values.push(v); }
        tags.push(ki.get(k), vi.get(v));
      }
      const fw = new W().packed(2, tags).tag(3, 0).varint(f.type).packed(4, encodeGeom(f.parts, f.type === 3));
      layer.bytes(2, fw.b);
    }
    for (const k of keys) layer.str(3, k);
    for (const v of values) layer.bytes(4, new W().str(1, String(v)).b);
    layer.tag(5, 0).varint(E).tag(15, 0).varint(2);
    tile.bytes(3, layer.b);
  }
  return new Uint8Array(tile.b).buffer;
}

// ---------- dataset -> tiles ----------
function globalPx(lat, lon, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n * E, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * E];
}

// OpenMapTiles' transportation attributes for an OSM way: class/subclass, and surface
// grouped as 'paved' / 'unpaved' (absent when OSM has no surface tag).
const UNPAVED = /^(unpaved|compacted|dirt|earth|fine_gravel|grass|gravel|ground|mud|sand|woodchips)$/;
const PAVED = /^(paved|asphalt|concrete|paving_stones|sett|cobblestone|wood)$/;
function classify(tags) {
  const h = tags.highway;
  let props = null;
  if (/^(primary|secondary|tertiary|trunk)$/.test(h)) props = { class: h };
  else if (h === 'trunk_link') props = { class: 'trunk', ramp: 1 };
  else if (h === 'motorway') props = { class: 'motorway' };
  else if (/^(residential|unclassified|living_street|road)$/.test(h)) props = { class: 'minor' };
  else if (h === 'service') props = { class: 'service' };
  else if (h === 'track') props = { class: 'track' };
  else if (/^(footway|cycleway|pedestrian|path|steps|bridleway)$/.test(h)) props = { class: 'path', subclass: h };
  if (!props) return null;
  if (UNPAVED.test(tags.surface || '')) props.surface = 'unpaved';
  else if (PAVED.test(tags.surface || '')) props.surface = 'paved';
  if (tags.mtb_scale) props.mtb_scale = tags.mtb_scale;
  return props;
}

export function makeMockMapBackend(dataset, { seaX = null, vtFailRate = 0, vtDown = false, overpass = {}, seed = 7 } = {}) {
  const z = 14;
  const nodes = new Map();
  for (const el of dataset.elements) if (el.type === 'node') nodes.set(el.id, el);
  const roads = [];
  const polys = [];
  const lines = [];
  for (const el of dataset.elements) {
    if (el.type !== 'way') continue;
    if (el.nodes && el.tags?.highway) {
      const props = classify(el.tags);
      if (!props) continue;
      const g = el.nodes.map((id) => { const n = nodes.get(id); return globalPx(n.lat, n.lon, z).map(Math.round); });
      roads.push({ props, g });
    } else if (el.geometry) {
      const g = el.geometry.map((p) => globalPx(p.lat, p.lon, z).map(Math.round));
      if (el.tags.leisure === 'park') polys.push({ layer: 'park', props: { class: 'park' }, g });
      else if (el.tags.natural === 'wood') polys.push({ layer: 'landcover', props: { class: 'wood', subclass: 'wood' }, g });
      else if (el.tags.leisure === 'track') polys.push({ layer: 'landuse', props: { class: 'track' }, g });
      else if (el.tags.waterway) lines.push({ layer: 'waterway', props: { class: el.tags.waterway }, g });
      else if (el.tags.natural === 'coastline') {
        // The sea west of the coastline, as an ocean polygon (like OpenMapTiles' water layer).
        const xs = g.map((p) => p[0]);
        const ys = g.map((p) => p[1]);
        const x = Math.max(...xs);
        polys.push({ layer: 'water', props: { class: 'ocean' }, g: [[x - 2e5, Math.min(...ys)], [x, Math.min(...ys)], [x, Math.max(...ys)], [x - 2e5, Math.max(...ys)], [x - 2e5, Math.min(...ys)]] });
      }
    }
  }
  const bbox = (g) => g.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  // Landmarks -> 'poi' layer points; named streets -> 'transportation_name' lines.
  const pois = [];
  for (const n of nodes.values()) {
    const t = n.tags;
    if (!t?.name) continue;
    const sub = t.tourism || t.historic || t.amenity || t.leisure;
    if (!sub) continue;
    const cls = { museum: 'museum', viewpoint: 'attraction', monument: 'monument', memorial: 'monument', castle: 'castle', fort: 'castle', ruins: 'monument', artwork: 'art_gallery', gallery: 'art_gallery', theatre: 'theatre', fountain: 'fountain', clock: 'attraction' }[sub] || sub;
    const props = { class: cls, subclass: sub === 'place_of_worship' ? 'jewish' : sub, name: t.name };
    if (/[a-z]/i.test(t.name)) props['name:en'] = t.name;
    pois.push({ props, g: [globalPx(n.lat, n.lon, z).map(Math.round)] });
  }
  const named = [];
  for (const el of dataset.elements) {
    if (el.type !== 'way' || !el.nodes || !el.tags?.name) continue;
    const props = { name: el.tags.name, class: 'minor' };
    if (/[a-z]/i.test(el.tags.name)) props['name:en'] = el.tags.name;
    named.push({ props, g: el.nodes.map((id) => { const n = nodes.get(id); return globalPx(n.lat, n.lon, z).map(Math.round); }) });
  }
  for (const r of [...roads, ...polys, ...lines, ...pois, ...named]) r.bb = bbox(r.g);

  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const overpassFetch = makeMockFetch(dataset, overpass);
  const calls = { tiles: 0, tileFails: 0, stops: 0, overpassTiles: 0 };

  // Place details (Nominatim + Wikidata), for the running spots of the synthetic city.
  const PLACE_INFO = {
    'Central Stadium': { name: 'Central Stadium', class: 'leisure', type: 'stadium', osm_type: 'way', osm_id: 1, extratags: { sport: 'athletics', website: 'https://example.org/central-stadium', opening_hours: 'Mo-Su 06:00-22:00', fee: 'no', wikidata: 'Q1' } },
    'Central Park': { name: 'Central Park', class: 'leisure', type: 'park', osm_type: 'relation', osm_id: 2, extratags: { wikipedia: 'en:Central Park (Testville)' } },
  };
  // The city-wide scan: stadiums and tracks by type, and track outlines by id.
  const trackWay = dataset.elements.find((el) => el.type === 'way' && el.tags?.leisure === 'track' && el.geometry);
  const stadiumNode = dataset.elements.find((el) => el.type === 'node' && el.tags?.leisure === 'stadium');
  const centroid = (g) => [g.reduce((a, p) => a + p.lat, 0) / g.length, g.reduce((a, p) => a + p.lon, 0) / g.length];
  const SCAN = {
    stadium: [
      stadiumNode && { type: 'stadium', osm_type: 'node', osm_id: stadiumNode.id, lat: String(stadiumNode.lat), lon: String(stadiumNode.lon), name: stadiumNode.tags.name, namedetails: { name: stadiumNode.tags.name, 'name:en': stadiumNode.tags.name }, extratags: { sport: 'athletics' } },
      // An athletics stadium 3 km away (no track outline), a football stadium and a basketball arena (not running spots).
      { type: 'stadium', osm_type: 'way', osm_id: 501, lat: String(32.08 + 0.001), lon: String(34.78 + 0.032), name: 'Riverside Athletics Stadium', namedetails: { name: 'אצטדיון האתלטיקה הנהר', 'name:en': 'Riverside Athletics Stadium' }, extratags: { sport: 'athletics' } },
      { type: 'stadium', osm_type: 'way', osm_id: 503, lat: String(32.08 - 0.02), lon: String(34.78 + 0.01), name: 'Football Ground', namedetails: { name: 'Football Ground' }, extratags: {} },
      { type: 'stadium', osm_type: 'way', osm_id: 502, lat: String(32.08 - 0.01), lon: String(34.78 - 0.01), name: 'Hoops Arena', namedetails: { name: 'Hoops Arena' }, extratags: { sport: 'basketball' } },
    ].filter(Boolean),
    'running track': trackWay ? [{ type: 'track', osm_type: 'way', osm_id: 777, lat: String(centroid(trackWay.geometry)[0]), lon: String(centroid(trackWay.geometry)[1]), name: '', namedetails: {}, extratags: { sport: 'running' } }] : [],
  };
  const fetchImpl = async (url, opts = {}) => {
    await new Promise((r) => setTimeout(r, 1));
    if (url.startsWith('https://nominatim.openstreetmap.org/lookup')) {
      calls.scan = (calls.scan || 0) + 1;
      const ids = new URL(url).searchParams.get('osm_ids') || '';
      const hit = ids.includes('W777') && trackWay ? [{ ...SCAN['running track'][0], geojson: { type: 'Polygon', coordinates: [trackWay.geometry.map((p) => [p.lon, p.lat])] } }] : [];
      return { ok: true, status: 200, json: async () => hit };
    }
    if (url.startsWith('https://nominatim.openstreetmap.org/search')) {
      const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
      if (SCAN[q]) { calls.scan = (calls.scan || 0) + 1; return { ok: true, status: 200, json: async () => SCAN[q] }; }
      calls.details = (calls.details || 0) + 1;
      const hit = PLACE_INFO[q];
      return { ok: true, status: 200, json: async () => (hit ? [hit] : []) };
    }
    if (url.startsWith('https://nominatim.openstreetmap.org/reverse')) return { ok: true, status: 200, json: async () => ({ error: 'Unable to geocode' }) };
    if (url.startsWith('https://www.wikidata.org/')) {
      return { ok: true, status: 200, json: async () => ({ entities: { Q1: { labels: { en: { value: 'Central Stadium' } }, claims: { P856: [{ mainsnak: { datavalue: { value: 'https://example.org/official' } } }] }, sitelinks: { enwiki: { title: 'Central Stadium' }, hewiki: { title: 'אצטדיון מרכזי' } } } } }) };
    }
    if (url === 'https://tiles.openfreemap.org/planet') {
      if (vtDown) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ tiles: [TEMPLATE] }) };
    }
    const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (m) {
      calls.tiles++;
      if (vtDown || rand() < vtFailRate) { calls.tileFails++; return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; }
      const [tx, ty] = [+m[2], +m[3]];
      const x0 = tx * E - 64, y0 = ty * E - 64, x1 = (tx + 1) * E + 64, y1 = (ty + 1) * E + 64;
      const hit = (o) => o.bb[0] <= x1 && o.bb[2] >= x0 && o.bb[1] <= y1 && o.bb[3] >= y0;
      const local = (g) => g.map(([x, y]) => [x - tx * E, y - ty * E]);
      const layers = { transportation: [], transportation_name: [], park: [], landcover: [], landuse: [], water: [], waterway: [], poi: [] };
      for (const p of pois) if (hit(p)) layers.poi.push({ type: 1, props: p.props, parts: [local(p.g)] });
      for (const nl of named) if (hit(nl)) layers.transportation_name.push({ type: 2, props: nl.props, parts: [local(nl.g)] });
      for (const r of roads) if (hit(r)) layers.transportation.push({ type: 2, props: r.props, parts: [local(r.g)] });
      for (const p of polys) if (hit(p)) layers[p.layer].push({ type: 3, props: p.props, parts: [local(p.g)] });
      for (const l of lines) if (hit(l)) layers.waterway.push({ type: 2, props: l.props, parts: [local(l.g)] });
      const buf = encodeTile(layers);
      return { ok: true, status: 200, arrayBuffer: async () => buf };
    }
    // Overpass: the stops-only query, or a full tile query (backup path).
    const query = decodeURIComponent(String(opts.body || '').replace(/^data=/, ''));
    if (!query.includes('way[')) {
      calls.stops++;
      if (overpass.deadServers?.includes(new URL(url).host) || rand() < (overpass.failRate || 0)) return { ok: false, status: 504, json: async () => ({}) };
      const [s0, w0, n0, e0] = query.match(/\[bbox:([^\]]+)\]/)[1].split(',').map(Number);
      const out = [];
      for (const n of nodes.values()) if (n.tags && n.lat >= s0 && n.lat <= n0 && n.lon >= w0 && n.lon <= e0) out.push(n);
      return { ok: true, status: 200, json: async () => ({ elements: out }) };
    }
    calls.overpassTiles++;
    return overpassFetch(url, opts);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
