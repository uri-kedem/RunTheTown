// The offline pack: what is downloaded, how the map's requests are answered from the phone.
// Run: node tests/test-offline.mjs
import { offlineFetch, offlineKey, offlineKind, packTiles, styleFontStacks, styleResources, downloadPack, offlinePackAt } from '../js/offline.js';
import { vtTilesFor } from '../js/vectortiles.js';
import { packRadius } from '../js/engine.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// A cache and a network that remember what was asked of them.
const makeCache = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
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
