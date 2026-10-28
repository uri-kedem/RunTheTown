// City-wide stadium/track scan. Run: node tests/test-spots.mjs
import { scanSpots, lapFromGeojson, mergeSpots, ringLength } from '../js/spots.js';
import { RouteEngine } from '../js/engine.js';
import { syntheticOverpass, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const json = (v) => ({ ok: true, status: 200, json: async () => v });

// A 400 m oval outline (lon/lat), like Hadar Yosef's way/416897753.
const oval = (clat, clon, half = 84.39, r = 36.5, n = 40) => {
  const kx = 111320 * Math.cos((clat * Math.PI) / 180), ky = 110574;
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; const sx = Math.cos(a) >= 0 ? half : -half; pts.push([clon + (sx + r * Math.cos(a)) / kx, clat + (r * Math.sin(a)) / ky]); }
  pts.push(pts[0]);
  return pts;
};
{
  const lap = lapFromGeojson({ type: 'Polygon', coordinates: [oval(32.1048, 34.8224)] });
  check(lap && Math.abs(lap.lapM - 400) <= 20, `a 400 m oval outline becomes a ~400 m lap (${lap?.lapM})`);
  const ring = lap.ring;
  let signed = 0;
  for (let i = 0; i < ring.length - 1; i++) signed += ring[i][1] * ring[i + 1][0] - ring[i + 1][1] * ring[i][0];
  check(signed > 0, 'laps run counter-clockwise');
  check(ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1], 'ring is closed');
  check(lapFromGeojson({ type: 'LineString', coordinates: oval(32.1, 34.8).slice(0, 20) }) === null, 'an open line is not a lap');
  check(lapFromGeojson({ type: 'Polygon', coordinates: [oval(32.1, 34.8, 20, 10)] }) === null, 'a playground loop (too small) is not a lap');
  const big = lapFromGeojson({ type: 'Polygon', coordinates: [oval(32.1, 34.8, 100, 40)] }); // ~650 m outer edge
  check(big && big.lapM === 400, 'an outer-edge outline (~500 m) is scaled to the 400 m lane');
}
// The scan, with the real response shapes (Tel Aviv, Oct 19): stadiums by type, tracks by type, outlines by id.
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('q=stadium')) return json([
      { type: 'stadium', osm_type: 'way', osm_id: 91609721, lat: '32.1049', lon: '34.8222', namedetails: { name: 'אצטדיון האתלטיקה הדר יוסף', 'name:en': 'Hadar Yosef Stadium' }, extratags: { sport: 'athletics', wikidata: 'Q863824' } },
      { type: 'stadium', osm_type: 'way', osm_id: 1, lat: '32.0518', lon: '34.7616', namedetails: { name: 'אצטדיון בלומפילד', 'name:en': 'Bloomfield Stadium' }, extratags: {} },
      { type: 'stadium', osm_type: 'way', osm_id: 2, lat: '32.1054', lon: '34.8241', namedetails: { name: 'ולודרום', 'name:en': 'Velodrome' }, extratags: { sport: 'cycling' } },
      { type: 'stadium', osm_type: 'way', osm_id: 3, lat: '32.0023', lon: '34.7974', namedetails: { name: 'היכל טוטו חולון' }, extratags: { sport: 'basketball' } },
      { type: 'stadium', osm_type: 'way', osm_id: 4, lat: '32.1336', lon: '34.8439', namedetails: { name: 'אצטדיון אתלטיקה רמת השרון', 'name:en': 'Ramat Hasharon Athletics stadium' }, extratags: { sport: 'athletics' } },
    ]);
    if (url.includes('q=running')) return json([
      { type: 'track', osm_type: 'way', osm_id: 416897753, lat: '32.1048', lon: '34.8224', namedetails: {}, extratags: { sport: 'running' } },
      { type: 'track', osm_type: 'way', osm_id: 985688986, lat: '32.1171', lon: '34.8027', namedetails: {}, extratags: {} },
      { type: 'track', osm_type: 'way', osm_id: 1369587580, lat: '32.0669', lon: '34.7617', namedetails: {}, extratags: { sport: 'cycling' } },
    ]);
    if (url.includes('/lookup')) {
      check(url.includes('W416897753') && url.includes('W985688986') && !url.includes('W1369587580'), 'outlines are fetched for running tracks only');
      return json([
        { osm_type: 'way', osm_id: 416897753, lat: '32.1048', lon: '34.8224', namedetails: {}, extratags: { sport: 'running' }, geojson: { type: 'Polygon', coordinates: [oval(32.1048, 34.8224)] } },
        { osm_type: 'way', osm_id: 985688986, lat: '32.1171', lon: '34.8027', namedetails: {}, extratags: {}, geojson: { type: 'Polygon', coordinates: [oval(32.1171, 34.8027)] } },
      ]);
    }
    throw new Error('unexpected ' + url);
  };
  const spots = await scanSpots(32.0632, 34.7706, { fetchImpl, pauseMs: 0 });
  console.log('scan:', spots.map((s) => `${s.kind} ${s.name} ${s.lapM || ''} ${Math.round(s.fromStart)}m`).join(' | '));
  check(calls.length === 3 && calls.every((u) => u.includes('nominatim')), 'three requests: stadiums, tracks, outlines');
  const hadar = spots.find((s) => s.name === 'Hadar Yosef Stadium');
  check(hadar && hadar.kind === 'track' && hadar.ring && hadar.local === 'אצטדיון האתלטיקה הדר יוסף', 'the track inside the athletics stadium carries its name and a lap ring');
  check(spots.filter((s) => s.name === 'Hadar Yosef Stadium').length === 1, 'stadium and its track are one entry');
  check(!spots.some((s) => s.name === 'Bloomfield Stadium'), 'a football stadium is not a running spot');
  check(spots.some((s) => s.kind === 'stadium' && s.name === 'Ramat Hasharon Athletics stadium' && !s.ring), 'an athletics stadium without an outline is listed by name, without laps');
  check(!spots.some((s) => /Velodrome|טוטו/.test(s.name)), 'velodrome and basketball hall are left out');
  check(spots.some((s) => s.kind === 'track' && s.name === 'Athletics track' && s.lapM), 'an unnamed track is listed as an athletics track');
  check(spots.every((s, i) => !i || s.fromStart >= spots[i - 1].fromStart), 'nearest first');
  const offline = await scanSpots(32.06, 34.77, { fetchImpl: async () => { throw new Error('offline'); }, pauseMs: 0 });
  check(offline.length === 0, 'offline: empty, no exception');
}
// Merging with tile-based places: same spot once, the tile entry (with a map node) wins and gains the ring.
{
  const tile = [{ kind: 'track', name: 'Athletics track', local: 'Athletics track', lat: 32.1048, lon: 34.8225, node: 12, lapM: 400, ring: [[0, 0]] }];
  const scan = [{ kind: 'track', name: 'Hadar Yosef Stadium', local: 'x', lat: 32.1048, lon: 34.8224, lapM: 400, ring: [[1, 1]] }, { kind: 'stadium', name: 'Ramat Hasharon Athletics stadium', local: 'y', lat: 32.1336, lon: 34.8439 }];
  const m = mergeSpots(scan, tile);
  check(m.length === 2 && m[0].node === 12 && m[0].name === 'Hadar Yosef Stadium' && m[0].ring[0][0] === 0, 'duplicate merged: map node kept, name taken from the scan');
}
// Through the engine on the synthetic city: the scan alone gives pins before the map is loaded.
{
  const fetchImpl = makeMockMapBackend(syntheticOverpass());
  const eng = new RouteEngine({ fetchImpl, fetchElevationImpl: async () => null, useCache: false, scanPauseMs: 0 });
  const early = await eng.spotsNear(CENTER[0], CENTER[1], 8500, { scanned: await eng.scanSpots(CENTER[0], CENTER[1]) });
  console.log('before the map:', early.map((s) => `${s.kind} ${s.name} node=${s.node}`).join(' | '), '| tiles:', fetchImpl.calls.tiles);
  check(fetchImpl.calls.tiles === 0 && early.length === 2 && early.every((s) => s.node === -1), 'stadium and track shown before any tile is downloaded');
  const later = await eng.previewSpots(CENTER[0], CENTER[1], { distanceKm: 5 });
  check(later.length === 3 && later.find((s) => s.kind === 'track').node >= 0 && later.some((s) => s.kind === 'park'), 'after the map loads: track tied to the streets, park added');
  const lap = eng.routeAtPlace(later.find((s) => s.kind === 'track'), { lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {} });
  check(lap && lap.highlights.some((h) => /to get there and back/.test(h)), 'lap route runs there and back once the map is loaded');

  // A track far from the start (4.6 km, well past half the run): the way there and back
  // is still planned — the app first loads the map out to the spot (new graph, so the
  // spot's node is found again) — and the card says the run comes out longer than asked.
  const ky = 110574, kx = 111320 * Math.cos((CENTER[0] * Math.PI) / 180);
  const far = { lat: CENTER[0] - 2400 / ky, lon: CENTER[1] - 2400 / kx };
  const small = await eng.previewSpots(far.lat, far.lon, { distanceKm: 4 }); // a 4 km map: the track is outside it
  const track = small.find((s) => s.kind === 'track');
  check(!!track, `the track is listed from the far start (${(track?.fromStart / 1000).toFixed(1)} km away)`);
  const before = eng.routeAtPlace(track, { lat: far.lat, lon: far.lon, distanceKm: 8, prefs: {} });
  const toPlace = Math.hypot(2400 + 1250, 2400 + 850);
  await eng.loadArea(far.lat, far.lon, toPlace + 600);
  const after = eng.routeAtPlace(track, { lat: far.lat, lon: far.lon, distanceKm: 8, prefs: {} });
  console.log('   far start, 8 km:', before?.highlights.join(' | '), ' -> after loading the map:', after?.highlights.join(' | '), `(${(after?.distance / 1000).toFixed(1)} km)`);
  check(after && after.highlights.some((h) => /to get there and back/.test(h)) && after.place.laps >= 1, 'the way there and back is planned to a track past half the run');
  check(after && after.distance > 8000 && after.highlights.some((h) => /Longer than asked/.test(h)), 'and the card says the run comes out longer than asked');
}
console.log(failures ? `\n${failures} FAILED` : '\nAll spots tests passed');
process.exit(failures ? 1 : 0);
