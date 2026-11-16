// The offline pack: what is downloaded, how the map's requests are answered from the phone.
// Run: node tests/test-offline.mjs
import { offlineFetch, offlineKey, offlineKind, packTiles, styleFontStacks, styleResources, downloadPack, offlinePackAt } from '../js/offline.js';
import { vtTilesFor } from '../js/vectortiles.js';
import { packRadius } from '../js/engine.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// A cache and a network that remember what was asked of them.
const makeCache = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } }; };
const OFM = 'https://tiles.openfreemap.org';
const style = { sprite: `${OFM}/sprites/ofm_f384/ofm`, glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`, layers: [
  { id: 'a', layout: { 'text-font': ['Noto Sans Regular'] } },
  { id: 'b', layout: { 'text-font': ['literal', ['Noto Sans Bold']] } },
  { id: 'c', layout: { 'text-font': ['Noto Sans Regular'] } }, { id: 'd', layout: {} },
] };
function makeNet({ down = false, fail = () => false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (down || fail(url)) throw new Error('offline');
    const res = (body, status = 200) => ({ ok: status === 200, status, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
    if (/\/styles\//.test(url)) return res(JSON.stringify(style));
    if (/\/planet$/.test(url)) return res(JSON.stringify({ tiles: [`${OFM}/planet/20261110_001001_pt/{z}/{x}/{y}.pbf`] }));
    if (/\/fonts\/.*1536-1791/.test(url)) return res('', 404); // this font has no Arabic
    if (/\/14\/9777\/6646\.pbf/.test(url)) return res('', 404); // open sea
    if (/\.json$/.test(url)) return res(JSON.stringify({ icon: { x: 0, y: 0 } }));
    return res(`body of ${url}`);
  };
  return { calls, fetchImpl };
}

// Keys and kinds.
check(offlineKey(`${OFM}/planet/20261110_001001_pt/14/9777/6645.pbf`) === 'vt:14/9777/6645' && offlineKey(`${OFM}/planet/20261117_001001_pt/14/9777/6645.pbf`) === 'vt:14/9777/6645', 'a tile is known by its place, not by the weekly version in its address');
check(vtTilesFor(32.08, 34.78, 500)[0].key === offlineKey(`${OFM}/planet/x/14/${vtTilesFor(32.08, 34.78, 500)[0].x}/${vtTilesFor(32.08, 34.78, 500)[0].y}.pbf`), 'and under the same key the planner stores it');
check(offlineKey(`${OFM}/fonts/Noto Sans Regular/0-255.pbf`) === offlineKey(`${OFM}/fonts/Noto%20Sans%20Regular/0-255.pbf`), 'a font is the same file with spaces or %20 in its address');
check(offlineKind(`${OFM}/styles/liberty`) === 'style' && offlineKind(`${OFM}/planet`) === 'tilejson' && offlineKind(`${OFM}/fonts/Noto Sans Regular/0-255.pbf`) === 'glyph' && offlineKind(`${OFM}/sprites/ofm_f384/ofm@2x.png`) === 'sprite' && offlineKind(`${OFM}/planet/v/3/4/2.pbf`) === 'tile', 'the kinds of map files');

// Answering the map's requests.
{
  const cache = makeCache(), net = makeNet();
  const tile = `${OFM}/planet/20261110_001001_pt/14/9777/6645.pbf`;
  const a = await offlineFetch(tile, 'arrayBuffer', { cache, fetchImpl: net.fetchImpl });
  check(a.byteLength > 0 && cache.m.size === 0, 'a tile seen on the map is not kept (browsing does not fill the phone)');
  await offlineFetch(tile, 'arrayBuffer', { cache, fetchImpl: net.fetchImpl, store: true });
  const before = net.calls.length;
  const b = await offlineFetch(tile.replace('20261110', '20261117'), 'arrayBuffer', { cache, fetchImpl: net.fetchImpl });
  check(b.byteLength === a.byteLength && net.calls.length === before, 'a kept tile is answered from the phone, even under next week\'s address');
  const font = `${OFM}/fonts/Noto%20Sans%20Regular/0-255.pbf`;
  await offlineFetch(font, 'arrayBuffer', { cache, fetchImpl: net.fetchImpl });
  check(cache.m.has(`res:${font}`), 'fonts and icons are kept as they pass');
  const st1 = await offlineFetch(`${OFM}/styles/liberty`, 'json', { cache, fetchImpl: net.fetchImpl });
  const n1 = net.calls.length;
  const st2 = await offlineFetch(`${OFM}/styles/liberty`, 'json', { cache, fetchImpl: net.fetchImpl });
  await new Promise((r) => setTimeout(r, 5));
  check(st1.layers.length === 4 && st2.layers.length === 4 && net.calls.length === n1 + 1, 'the style comes from the phone at once and is refreshed in the background');
  const off = makeNet({ down: true });
  const st3 = await offlineFetch(`${OFM}/styles/liberty`, 'json', { cache, fetchImpl: off.fetchImpl });
  const t3 = await offlineFetch(tile, 'arrayBuffer', { cache, fetchImpl: off.fetchImpl });
  check(st3.layers.length === 4 && t3.byteLength > 0, 'with no connection: style and tile from the phone');
  let threw = false;
  try { await offlineFetch(`${OFM}/planet/v/14/1/1.pbf`, 'arrayBuffer', { cache, fetchImpl: off.fetchImpl }); } catch { threw = true; }
  check(threw, 'with no connection, a tile that was never kept fails (the map leaves it blank)');
  const sea = await offlineFetch(`${OFM}/planet/v/14/9777/6646.pbf`, 'arrayBuffer', { cache, fetchImpl: net.fetchImpl, store: true });
  check(sea.byteLength === 0 && cache.m.get('vt:14/9777/6646').byteLength === 0, 'a tile that does not exist (open sea) is an empty tile, kept as such');
}

// What a pack holds.
{
  const R = packRadius(5);
  check(R === packRadius(10) && packRadius(21) > R && R > 3000 && R < 6000, `a pack covers what a 10 km run can reach, more for a longer run (${R} m, ${packRadius(21)} m)`);
  const tiles = packTiles(32.08, 34.78, R);
  const byZ = (z) => tiles.filter((t) => t.z === z).length;
  check(byZ(14) === vtTilesFor(32.08, 34.78, R).length && byZ(14) > byZ(13) && byZ(13) >= byZ(12) && byZ(9) === 1 && byZ(0) === 1 && new Set(tiles.map((t) => t.key)).size === tiles.length, `tiles of every zoom, no doubles (${tiles.length}: ${byZ(14)} at street level)`);
  check(tiles.length < 300 && packTiles(32.08, 34.78, packRadius(42.2)).length < 3000, 'well inside OpenFreeMap\'s 3,000-tile limit, even for a marathon');
  check(JSON.stringify(styleFontStacks(style)) === JSON.stringify(['Noto Sans Regular', 'Noto Sans Bold']), 'the fonts of a style, each once');
  const res = styleResources(style);
  check(res.filter((u) => /sprites/.test(u)).length === 4 && res.some((u) => u.endsWith('/fonts/Noto Sans Bold/1280-1535.pbf')) && res.length === 4 + 2 * 7, `icons at both sizes and the fonts' letter ranges, Hebrew among them (${res.length} files)`);
}

// The download itself.
{
  const cache = makeCache(), net = makeNet(), said = [];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let loaded = null;
  const engine = { loadArea: async (lat, lon, radius) => { loaded = { lat, lon, radius }; for (const t of vtTilesFor(lat, lon, radius)) await cache.put(t.key, new ArrayBuffer(8)); } };
  const R = packRadius(10);
  const pack = await downloadPack({ lat: 32.08, lon: 34.78, radius: R, label: 'Hotel', engine, onStatus: (t) => said.push(t), fetchImpl: net.fetchImpl, cache, storage });
  const tiles = packTiles(32.08, 34.78, R);
  check(loaded?.radius === R && tiles.every((t) => cache.m.has(t.key)), 'the planner\'s area is loaded and every map tile of the pack is on the phone');
  const tileCalls = net.calls.filter((u) => /\/planet\/[^/]+\/\d+\//.test(u));
  check(tileCalls.length === tiles.length - vtTilesFor(32.08, 34.78, R).length && !tileCalls.some((u) => /\/14\//.test(u)), 'the street-level tiles the planner already fetched are not downloaded twice');
  check(cache.m.has(`res:${OFM}/styles/liberty`) && cache.m.has(`res:${OFM}/styles/dark`) && cache.m.has(`res:${OFM}/planet`) && cache.m.has(`res:${OFM}/sprites/ofm_f384/ofm@2x.png`) && cache.m.has(`res:${OFM}/fonts/Noto%20Sans%20Regular/1280-1535.pbf`), 'both styles, the tile index, the icons and the fonts are kept');
  check(pack.missing === 0 && pack.tiles === tiles.length && said.some((t) => /^Downloading the map… \d+ of \d+$/.test(t)), 'progress is reported; a font without Arabic letters is not a failure');
  check(offlinePackAt(32.081, 34.781, storage)?.label === 'Hotel' && offlinePackAt(32.3, 34.9, storage) === null && offlinePackAt(32.08, 34.78, storage, Date.now() + 15 * 86400000) === null, 'the pack is found for a start inside it, not elsewhere, not after 14 days');
  // Then, with no connection: the style, a tile and a font all come from the phone.
  const off = makeNet({ down: true });
  const st = await offlineFetch(`${OFM}/styles/dark`, 'json', { cache, fetchImpl: off.fetchImpl });
  const t0 = await offlineFetch(`${OFM}/planet/any/${tiles[0].z}/${tiles[0].x}/${tiles[0].y}.pbf`, 'arrayBuffer', { cache, fetchImpl: off.fetchImpl });
  check(st.glyphs && t0.byteLength > 0, 'offline afterwards: the map has its style and its tiles');
  // The map asks for the icon list as JSON; the download kept it as bytes.
  const icons = await offlineFetch(`${OFM}/sprites/ofm_f384/ofm@2x.json`, 'json', { cache, fetchImpl: off.fetchImpl }).catch(() => null);
  const asBytes = await offlineFetch(`${OFM}/styles/liberty`, 'arrayBuffer', { cache, fetchImpl: off.fetchImpl }).catch(() => null);
  check(icons === null ? false : true, 'a file kept as bytes is handed back as text when asked for as text') ;
  check(asBytes?.byteLength > 0, 'and a file kept as text is handed back as bytes');
  // A connection that drops half-way: no pack is recorded.
  const cache2 = makeCache(), store2 = new Map();
  const bad = makeNet({ fail: (u) => /\/1[0-3]\/\d+\/\d+\.pbf/.test(u) });
  let err = null;
  try { await downloadPack({ lat: 32.08, lon: 34.78, radius: R, engine: null, fetchImpl: bad.fetchImpl, cache: cache2, storage: { getItem: (k) => store2.get(k) ?? null, setItem: (k, v) => store2.set(k, v) } }); } catch (e) { err = e; }
  check(/did not finish/.test(err?.message || '') && store2.size === 0, 'a download that mostly failed says so and records no pack');
}

// A route downloaded to run later: the route is kept whole with its start, the map around
// it is on the phone, it is listed for 14 days, opens again with no connection, and
// deleting it frees the map pieces that only it needed.
{
  const { saveRouteForLater, savedRoutes, loadSavedRoute, deleteSavedRoute, routeCircle, MAX_SAVED_ROUTES } = await import('../js/offline.js');
  const cache = makeCache(), net = makeNet();
  const kv = new Map(), recs = new Map();
  const storage = { getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => kv.set(k, v) };
  const store = { put: async (id, r) => { recs.set(id, JSON.parse(JSON.stringify(r))); }, get: async (id) => recs.get(id) || null, remove: async (id) => { recs.delete(id); } };
  const engine = { loadArea: async (lat, lon, radius) => { for (const t of vtTilesFor(lat, lon, radius)) await cache.put(t.key, new ArrayBuffer(8)); } };
  const opts = { engine, fetchImpl: net.fetchImpl, cache, storage, store };
  // A 4 km there-and-back along the coast of Tel Aviv, and a loop 12 km away in Herzliya.
  const line = (lat0, lon0, km) => Array.from({ length: 41 }, (_, i) => [lat0 + (i / 40) * (km / 111.2), lon0 + 0.002 * Math.sin(i / 6)]);
  const coast = { name: 'Out & back along the sea', distance: 8000, type: 'outback', latlngs: line(32.08, 34.767, 4), cues: [{ type: 'depart', at: 0, text: 'Head north' }], highlights: ['75% on the seafront promenade'], stats: { distance: 8000 }, turnaround: [32.116, 34.767] };
  const north = { name: 'Park loop', distance: 5000, type: 'loop', latlngs: line(32.17, 34.84, 2), cues: [], highlights: [], stats: { distance: 5000 } };
  const circle = routeCircle(coast.latlngs);
  check(circle.radius > 2000 + 600 && circle.radius < 2000 + 1000 && Math.abs(circle.lat - (32.08 + 2 / 111.2)) < 1e-3, `the map kept is the route with room around it (a circle of ${circle.radius} m for a 4 km line)`);
  check(coast.latlngs.every(([la, lo]) => packTiles(circle.lat, circle.lon, circle.radius).some((t) => t.z === 14 && vtTilesFor(la, lo, 10)[0].key === t.key)), 'and holds every point of the route');
  const t0 = Date.parse('2026-11-16T10:00:00Z');
  const a = await saveRouteForLater({ route: coast, start: { lat: 32.08, lon: 34.767, label: 'Hotel' }, mode: 'run', now: t0, ...opts });
  const tilesA = packTiles(circle.lat, circle.lon, circle.radius);
  check(tilesA.every((t) => cache.m.has(t.key)) && cache.m.has(`res:${OFM}/styles/dark`), 'downloading a route puts its map on the phone, with the styles and fonts');
  check(savedRoutes(storage, t0).length === 1 && savedRoutes(storage, t0)[0].name === coast.name && savedRoutes(storage, t0)[0].until === t0 + 14 * 86400000 && a.id === savedRoutes(storage, t0)[0].id, 'it is listed, with the day it is kept until');
  check(offlinePackAt(32.08, 34.767, storage, t0) === null, 'and is not listed as a downloaded area as well');
  const back = await loadSavedRoute(a.id, { storage, store, now: t0 + 86400000 });
  check(back?.route?.latlngs?.length === 41 && back.route.cues[0].text === 'Head north' && back.route.turnaround[0] === 32.116 && back.start.label === 'Hotel' && back.mode === 'run', 'it opens again whole: the line, the directions, the start');
  // On screen a card carries its lines on the map and their tap handlers: none of that is stored.
  const onScreen = { ...north, _layers: { line: { on: () => {} } }, _storiesLoading: true };
  onScreen._layers.line.route = onScreen; // and they point back at the card
  const strict = { ...store, put: async (id, r) => { structuredClone(r); return store.put(id, r); } }; // as the phone's storage: what cannot be copied is refused
  const b = await saveRouteForLater({ route: onScreen, start: { lat: 32.17, lon: 34.84, label: 'Home' }, now: t0 + 3600000, ...opts, store: strict });
  check(!('_layers' in recs.get(b.id).route) && !('_storiesLoading' in recs.get(b.id).route) && recs.get(b.id).route.latlngs.length === 41 && '_layers' in onScreen, 'a card taken from the screen is stored as the route alone, and the card on screen is left as it was');
  check(savedRoutes(storage, t0 + 3600000).map((r) => r.name).join('|') === 'Park loop|Out & back along the sea', 'a second route is listed above it, newest first');
  // A third route over the same coast: deleting the first must leave the pieces it shares.
  const c = await saveRouteForLater({ route: { ...coast, name: 'Coast again' }, start: { lat: 32.08, lon: 34.767, label: 'Hotel' }, now: t0 + 7200000, ...opts });
  const freedShared = await deleteSavedRoute(a.id, { cache, storage, store, now: t0 + 7200000 });
  check(freedShared === 0 && tilesA.every((t) => cache.m.has(t.key)) && !recs.has(a.id) && savedRoutes(storage, t0 + 7200000).length === 2, 'deleting a route whose map another route also uses removes the route and keeps the map');
  const freed = await deleteSavedRoute(c.id, { cache, storage, store, now: t0 + 7200000 });
  const northTiles = packTiles(routeCircle(north.latlngs).lat, routeCircle(north.latlngs).lon, routeCircle(north.latlngs).radius);
  const onlyCoast = tilesA.filter((t) => !northTiles.some((u) => u.key === t.key));
  check(freed === onlyCoast.length && freed > 5 && onlyCoast.every((t) => !cache.m.has(t.key)) && northTiles.every((t) => cache.m.has(t.key)), `deleting the last route over an area frees its map pieces (${freed}) and no one else's`);
  check((await loadSavedRoute(c.id, { storage, store, now: t0 + 7200000 })) === null && (await deleteSavedRoute('no-such-route', { cache, storage, store })) === 0, 'a deleted route cannot be opened; deleting what is not there does nothing');
  check(savedRoutes(storage, t0 + 15 * 86400000).length === 0 && (await loadSavedRoute(b.id, { storage, store, now: t0 + 15 * 86400000 })) === null, 'after 14 days a route is no longer offered (its map has expired)');
  // The phone keeps a dozen at most, and says so rather than dropping one silently.
  for (let i = 0; i < MAX_SAVED_ROUTES - 1; i++) await saveRouteForLater({ route: { ...north, name: `Loop ${i}` }, start: { lat: 32.17, lon: 34.84, label: 'Home' }, now: t0 + 9000000 + i, ...opts });
  let full = '';
  try { await saveRouteForLater({ route: north, start: { lat: 32.17, lon: 34.84, label: 'Home' }, now: t0 + 9900000, ...opts }); } catch (err) { full = err.message; }
  check(savedRoutes(storage, t0 + 9900000).length === MAX_SAVED_ROUTES && /Delete one in Settings/.test(full), `the thirteenth is refused with a plain message: ${full}`);
  // With no connection the map cannot be fetched: nothing is listed.
  const kv2 = new Map();
  const storage2 = { getItem: (k) => kv2.get(k) ?? null, setItem: (k, v) => kv2.set(k, v) };
  let offline = '';
  try { await saveRouteForLater({ route: coast, start: { lat: 32.08, lon: 34.767, label: 'Hotel' }, engine: null, fetchImpl: makeNet({ down: true }).fetchImpl, cache: makeCache(), storage: storage2, store }); } catch (err) { offline = err.message; }
  check(offline && savedRoutes(storage2).length === 0, 'a download that fails lists no route');
}

// The dark map is repainted so its streets can be read (OpenFreeMap's dark style is black
// on black): every street and path must stand well off the ground, the bigger the road the
// lighter, paths lightest of all; a layer the style does not have is left alone.
{
  const { DARK_MAP_PAINT, paintDarkMap } = await import('../js/glmap.js');
  const has = new Set(['background', 'water', 'highway_minor', 'highway_major_inner', 'highway_path', 'highway_name_other']);
  const painted = {};
  paintDarkMap({ getLayer: (id) => (has.has(id) ? { id } : undefined), setPaintProperty: (id, k, v) => { painted[`${id}.${k}`] = v; } });
  // How light a colour is to the eye (0 black, 1 white), and the contrast of two colours.
  const light = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => (Math.max(light(a), light(b)) + 0.05) / (Math.min(light(a), light(b)) + 0.05);
  const ground = painted['background.background-color'];
  const [minor, major, path, name] = [painted['highway_minor.line-color'], painted['highway_major_inner.line-color'], painted['highway_path.line-color'], painted['highway_name_other.text-color']];
  console.log(`dark map: streets ${contrast(minor, ground).toFixed(1)}:1, main roads ${contrast(major, ground).toFixed(1)}:1, paths ${contrast(path, ground).toFixed(1)}:1, names ${contrast(name, ground).toFixed(1)}:1 against the ground`);
  check(contrast(minor, ground) >= 2 && contrast(major, ground) >= 4 && contrast(path, ground) >= 8, 'streets, main roads and paths stand off the dark ground');
  check(light(minor) < light(major) && light(major) < light(path), 'the bigger the road the lighter, and paths lightest');
  check(contrast(name, ground) >= 7, 'street names can be read');
  check(contrast(painted['water.fill-color'], ground) >= 1.15 && contrast(minor, painted['water.fill-color']) >= 1.6, 'water shows, and a street beside it still does');
  check(!Object.keys(painted).some((k) => k.startsWith('highway_motorway')) && DARK_MAP_PAINT.some(([id]) => id.startsWith('highway_motorway')), 'a layer the style does not have is skipped');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll offline tests passed');
process.exit(failures ? 1 : 0);
