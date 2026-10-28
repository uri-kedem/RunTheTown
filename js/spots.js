// City-wide scan for athletics stadiums and running tracks, done as soon as the start
// point is known and before any map tiles are downloaded: two small Nominatim
// searches inside ~8 km of the start, then one lookup for the track outlines
// (so laps can be planned on them). Big parks still come from the map tiles.

import { haversine } from './geo.js';

const NOMINATIM_SCAN = 'https://nominatim.openstreetmap.org';
const SCAN_KM = 8; // half-size of the box scanned around the start
const SCAN_TIMEOUT_MS = 8000;
const NOT_RUNNING_SPORT = /^(cycling|motor|motocross|karting|horse_racing|equestrian|basketball|tennis|swimming|skateboard|ice_hockey|ice_skating|volleyball|handball|baseball|cricket|golf|shooting|bowls|boules|climbing|table_tennis|badminton|gymnastics|boxing|judo)$/;
const ATHLETICS_NAME = /athletic|running|אתלטיקה|ריצה/i; // stadiums are kept only when they are for runners
const NOT_RUNNING_NAME = /velodrome|cycl|ולודרום|אופניים|motor|kart|speedway|horse|equestrian|greyhound|ice rink|skat|tennis|basketball|arena|hall|היכל|טניס|כדורסל/i;

const scanWait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanGetJson(url, fetchImpl, timeoutMs = SCAN_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('status ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const scanNames = (e) => {
  const nd = e.namedetails || {};
  const local = nd.name || e.name || '';
  const en = nd['name:en'] || '';
  return { name: en || local, local: local || en };
};

/** Perimeter (m) of a lon/lat ring. */
export function ringLength(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return s;
}

/**
 * Turns an OSM track outline (GeoJSON from Nominatim) into a lap ring: closed,
 * lat/lon, counter-clockwise, scaled to ~400 m when the outline is the outer
 * edge of the oval. Returns { ring, lapM } or null when it isn't a runnable loop.
 */
export function lapFromGeojson(geojson) {
  if (!geojson) return null;
  let line = geojson.type === 'Polygon' ? geojson.coordinates[0] : geojson.type === 'LineString' ? geojson.coordinates : geojson.type === 'MultiPolygon' ? geojson.coordinates[0]?.[0] : null;
  if (!line || line.length < 8) return null;
  line = line.slice();
  const a = line[0];
  const b = line[line.length - 1];
  if (haversine(a[1], a[0], b[1], b[0]) > 15) return null; // an open line, not a loop
  line[line.length - 1] = a;
  const P = ringLength(line);
  if (P < 250 || P > 700) return null;
  // Local metres around the centroid.
  let clat = 0, clon = 0;
  for (let i = 0; i < line.length - 1; i++) { clat += line[i][1]; clon += line[i][0]; }
  clat /= line.length - 1; clon /= line.length - 1;
  const kx = 111320 * Math.cos((clat * Math.PI) / 180);
  const ky = 110574;
  let xy = line.slice(0, -1).map(([lo, la]) => [(lo - clon) * kx, (la - clat) * ky]);
  // Area check: a real oval, not a long thin strip.
  let area = 0;
  for (let i = 0; i < xy.length; i++) { const p = xy[i], q = xy[(i + 1) % xy.length]; area += p[0] * q[1] - q[0] * p[1]; }
  if (Math.abs(area) / 2 / (P * P) < 0.03) return null;
  if (area < 0) xy = xy.reverse(); // counter-clockwise, as laps are run
  const k = P > 460 ? 400 / P : 1;
  xy = xy.map(([x, y]) => [x * k, y * k]);
  const ring = [...xy, xy[0]].map(([x, y]) => [clat + y / ky, clon + x / kx]);
  return { ring, lapM: Math.round(ringLength(ring.map(([la, lo]) => [lo, la])) / 10) * 10 };
}

/**
 * Stadiums and athletics tracks within ~8 km of (lat, lon):
 * [{ kind: 'track' | 'stadium', name, local, lat, lon, sport, osm, ring?, lapM? }], nearest first.
 * Never throws: with no network it returns [].
 */
export async function scanSpots(lat, lon, { fetchImpl = (...a) => fetch(...a), pauseMs = 1050 } = {}) {
  try {
    const dLat = SCAN_KM / 110.574;
    const dLon = SCAN_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
    const vb = `&viewbox=${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)},${(lat - dLat).toFixed(5)}&bounded=1`;
    const q = (text) => `${NOMINATIM_SCAN}/search?format=jsonv2&limit=40&extratags=1&namedetails=1&q=${encodeURIComponent(text)}${vb}`;
    const stadiums = (await scanGetJson(q('stadium'), fetchImpl)) || [];
    await scanWait(pauseMs); // Nominatim allows one request per second
    const trackHits = (await scanGetJson(q('running track'), fetchImpl)) || [];
    const keepTrack = (e) => e.type === 'track' && !NOT_RUNNING_SPORT.test(e.extratags?.sport || '') && !NOT_RUNNING_NAME.test(scanNames(e).name + ' ' + scanNames(e).local);
    const wanted = trackHits.filter(keepTrack).slice(0, 50);
    let outlines = [];
    if (wanted.length) {
      await scanWait(pauseMs);
      const ids = wanted.map((e) => `${e.osm_type[0].toUpperCase()}${e.osm_id}`).join(',');
      outlines = (await scanGetJson(`${NOMINATIM_SCAN}/lookup?format=jsonv2&extratags=1&namedetails=1&polygon_geojson=1&osm_ids=${ids}`, fetchImpl)) || [];
    }
    const spots = [];
    for (const e of outlines) {
      const lap = lapFromGeojson(e.geojson);
      if (!lap) continue;
      const { name, local } = scanNames(e);
      spots.push({ kind: 'track', name: name || 'Athletics track', local: local || name || 'Athletics track', lat: +e.lat, lon: +e.lon, sport: e.extratags?.sport || null, osm: `${e.osm_type}/${e.osm_id}`, ...lap, source: 'scan' });
    }
    for (const e of stadiums) {
      if (e.type !== 'stadium') continue;
      const { name, local } = scanNames(e);
      if (!name) continue;
      const sport = e.extratags?.sport || null;
      if ((sport && NOT_RUNNING_SPORT.test(sport)) || NOT_RUNNING_NAME.test(name + ' ' + local)) continue;
      const athletics = /^(athletics|running)$/.test(sport || '') || ATHLETICS_NAME.test(name + ' ' + local);
      const s = { kind: 'stadium', name, local, lat: +e.lat, lon: +e.lon, sport, osm: `${e.osm_type}/${e.osm_id}`, source: 'scan' };
      // A track inside this stadium takes the stadium's name; the stadium itself is then not listed twice.
      const inside = spots.find((t) => t.kind === 'track' && haversine(t.lat, t.lon, s.lat, s.lon) < 300);
      if (inside) {
        if (/^Athletics track$/.test(inside.name) || athletics) { inside.name = name; inside.local = local; }
        inside.sport = inside.sport || sport;
        continue;
      }
      // Football and other stadiums without a running track are not running spots.
      if (athletics) spots.push(s);
    }
    for (const s of spots) s.fromStart = haversine(lat, lon, s.lat, s.lon);
    return spots.sort((a, b) => a.fromStart - b.fromStart);
  } catch {
    return Object.assign([], { failed: true }); // an empty list that says why, so the caller can retry later
  }
}

/** Merges scan spots with the tile-based places (parks, tracks with a map node): one entry per spot. */
export function mergeSpots(scanned, tilePlaces) {
  const out = [...tilePlaces];
  for (const s of scanned) {
    const dup = out.find((p) => haversine(p.lat, p.lon, s.lat, s.lon) < 200);
    if (dup) {
      if (!dup.ring && s.ring) { dup.ring = s.ring; dup.lapM = s.lapM; }
      if (/^Athletics track$/.test(dup.name) && !/^Athletics track$/.test(s.name)) { dup.name = s.name; dup.local = s.local; }
      continue;
    }
    out.push(s);
  }
  return out;
}
