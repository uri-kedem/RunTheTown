// Offline: the map and the streets of an area kept on the phone, so a run can be planned
// and followed with no connection (a traveller's roaming, a tunnel of bad signal). Two parts:
//
//   - offlineFetch(): every request the map makes to OpenFreeMap (style, fonts, icons,
//     tiles) goes through here. What is on the phone is used; what is not comes from the
//     network. Small things (style, fonts, icons) are kept as they pass; map tiles are kept
//     only by a download the runner asked for, so browsing the map does not fill the phone.
//   - downloadPack(): the runner's "Download this area": the streets, heights and land
//     cover the planner needs (through the engine, which keeps them for 14 days anyway) and
//     the map picture for the same area at every zoom.
//   - saveRouteForLater(): the runner's "Download for later" on a route they chose: the
//     route itself, kept whole, with the map around it. It is listed (savedRoutes), opened
//     again to run with no connection (loadSavedRoute) and deleted from Settings
//     (deleteSavedRoute), which also frees the map pieces only that route needed.
//
// Everything lives in the same on-phone store as the planner's tiles (cache.js) and expires
// with it after 14 days. OpenFreeMap allows offline copies of up to 3,000 tiles.

import { tileCache, routeStore } from './cache.js';
import { haversine } from './geo.js';
import { vtTilesFor, lonLatToTile, VT_ZOOM } from './vectortiles.js';

const OFM = 'https://tiles.openfreemap.org';
export const OFFLINE_STYLES = [`${OFM}/styles/liberty`, `${OFM}/styles/dark`];
const OFFLINE_TILEJSON = `${OFM}/planet`;
const OFFLINE_MAX_TILES = 3000;
const OFFLINE_DAYS = 14;
const OFFLINE_INFO_KEY = 'rtt-offline';
// Letters the map's labels are written in, as the font files are cut: Latin, Latin
// extended, Greek, Cyrillic, Hebrew, Arabic, punctuation. (Chinese, Japanese and Korean
// are drawn with the phone's own fonts and need no download.)
const OFFLINE_GLYPH_RANGES = ['0-255', '256-511', '768-1023', '1024-1279', '1280-1535', '1536-1791', '8192-8447'];

/** What a URL is to the map: 'tile' | 'style' | 'tilejson' | 'glyph' | 'sprite' | 'other'. */
export function offlineKind(url) {
  if (/\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf/.test(url)) return 'tile';
  if (/\/styles\/[^/]+$/.test(url)) return 'style';
  if (/\/planet$/.test(url)) return 'tilejson';
  if (/\/fonts\//.test(url)) return 'glyph';
  if (/\/sprites\//.test(url)) return 'sprite';
  return 'other';
}

/**
 * The key a URL is stored under. A map tile is known by its place (zoom, column, row),
 * not by the weekly version in its address, and under the same key the planner uses, so
 * the streets the planner downloaded are the picture the map shows, and the other way round.
 */
export function offlineKey(url) {
  const m = url.match(/\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf/);
  // A font's name has spaces in it: the same file is asked for with them and with %20.
  return m ? `vt:${m[1]}/${m[2]}/${m[3]}` : `res:${url.replace(/ /g, '%20')}`;
}

/**
 * Fetches a map resource, from the phone when it is there. `type` is MapLibre's: 'json',
 * 'string', 'arrayBuffer' or 'image'. `store`: keep what came from the network (default:
 * everything but tiles). Style and tile index are answered from the phone at once and
 * refreshed in the background, so a new map version is picked up on the next open.
 */
export async function offlineFetch(url, type = 'arrayBuffer', { signal = null, fetchImpl = (...a) => fetch(...a), cache = tileCache, store = null } = {}) {
  const kind = offlineKind(url);
  const key = offlineKey(url);
  const text = type === 'json' || type === 'string';
  const keep = store ?? kind !== 'tile';
  const fromNetwork = async (sig) => {
    const res = await fetchImpl(url, sig ? { signal: sig } : {});
    // No such tile (open sea): an empty one, as the planner treats it.
    if ((res.status === 204 || res.status === 404) && kind === 'tile') { const empty = new ArrayBuffer(0); if (keep) cache.put(key, empty); return empty; }
    if (!res.ok) throw new Error(`map server returned ${res.status}`);
    const body = text ? await res.text() : await res.arrayBuffer();
    if (keep) cache.put(key, body);
    return body;
  };
  const cached = await cache.get(key);
  let body;
  if (cached != null) {
    // Kept as text or as bytes, whichever way it first came: handed back the way it is asked for.
    body = typeof cached === 'string' ? (text ? cached : new TextEncoder().encode(cached).buffer) : (text ? new TextDecoder().decode(cached) : cached);
    if (kind === 'style' || kind === 'tilejson') fromNetwork(null).catch(() => {}); // a fresh copy for next time
  } else {
    body = await fromNetwork(signal);
  }
  return type === 'json' ? JSON.parse(body) : body;
}

/** The map tiles of a pack: every zoom from the whole-city view down to street level. */
export function packTiles(lat, lon, radius) {
  const tiles = [];
  const seen = new Set();
  const add = (t) => { if (!seen.has(t.key)) { seen.add(t.key); tiles.push({ z: t.z, x: t.x, y: t.y, key: t.key }); } };
  // Street level and the four zooms above it cover the area; further out, the one tile
  // the start is in (so zooming out still shows the region).
  for (let z = VT_ZOOM; z >= VT_ZOOM - 4; z--) for (const t of vtTilesFor(lat, lon, radius, z)) add(t);
  for (let z = VT_ZOOM - 5; z >= 0; z--) {
    const [x, y] = lonLatToTile(lon, lat, z);
    add({ z, x: Math.floor(x), y: Math.floor(y), key: `vt:${z}/${Math.floor(x)}/${Math.floor(y)}` });
  }
  return tiles;
}

/** The fonts a style writes its labels in (each a comma-joined stack, as the font URL wants it). */
export function styleFontStacks(style) {
  const stacks = new Set();
  const visit = (v) => {
    if (!Array.isArray(v)) return;
    if (v.length && v.every((x) => typeof x === 'string') && !/^(literal|step|case|match|coalesce|interpolate|get|to-string|format|concat)$/.test(v[0])) stacks.add(v.join(','));
    else v.forEach(visit);
  };
  for (const l of style.layers || []) visit(l.layout?.['text-font']);
  return [...stacks];
}

/** The small files a style needs besides tiles: its icons and its fonts. */
export function styleResources(style) {
  const urls = [];
  if (typeof style.sprite === 'string') for (const ext of ['.json', '.png', '@2x.json', '@2x.png']) urls.push(style.sprite + ext);
  if (style.glyphs) {
    for (const stack of styleFontStacks(style)) {
      for (const range of OFFLINE_GLYPH_RANGES) urls.push(style.glyphs.replace('{fontstack}', stack).replace('{range}', range)); // the address as the map itself writes it
    }
  }
  return urls;
}

/** The pack on this phone that covers a point (and has not expired), or null. */
export function offlinePackAt(lat, lon, storage = globalThis.localStorage, now = Date.now()) {
  try {
    const packs = JSON.parse(storage?.getItem(OFFLINE_INFO_KEY) || '[]');
    const R = 6371000, rad = Math.PI / 180;
    const far = (p) => 2 * R * Math.asin(Math.sqrt(Math.sin(((p.lat - lat) * rad) / 2) ** 2 + Math.cos(lat * rad) * Math.cos(p.lat * rad) * Math.sin(((p.lon - lon) * rad) / 2) ** 2));
    return packs.find((p) => now - p.time < OFFLINE_DAYS * 86400000 && far(p) <= p.radius * 0.5) || null;
  } catch {
    return null;
  }
}
function rememberPack(pack, storage = globalThis.localStorage) {
  try {
    const now = Date.now();
    const packs = JSON.parse(storage?.getItem(OFFLINE_INFO_KEY) || '[]').filter((p) => now - p.time < OFFLINE_DAYS * 86400000);
    storage?.setItem(OFFLINE_INFO_KEY, JSON.stringify([pack, ...packs].slice(0, 8)));
  } catch {
    /* the pack is on the phone all the same */
  }
}

/**
 * Downloads an area for offline use: what the planner needs (through `engine.loadArea`),
 * the map tiles of every zoom, both map styles with their icons and fonts. `onStatus(text)`
 * reports progress. Resolves to { lat, lon, radius, label, time, tiles, missing }; throws
 * when the streets themselves could not be loaded (the pack would be of no use).
 */
export async function downloadPack({ lat, lon, radius, label = '', engine = null, onStatus = () => {}, fetchImpl = (...a) => fetch(...a), cache = tileCache, storage = globalThis.localStorage, remember = true }) {
  const tiles = packTiles(lat, lon, radius);
  if (tiles.length > OFFLINE_MAX_TILES) throw new Error('This area is too large to download in one go. Pick a shorter distance.');
  // 1) The planner's own data: streets, heights, land cover (it keeps them as it loads them).
  if (engine) await engine.loadArea(lat, lon, radius, onStatus);
  // 2) The map's styles, icons and fonts.
  onStatus('Downloading the map style…');
  const small = new Set();
  for (const url of OFFLINE_STYLES) {
    const style = await offlineFetch(url, 'json', { fetchImpl, cache, store: true });
    for (const u of styleResources(style)) small.add(u);
  }
  const index = await offlineFetch(OFFLINE_TILEJSON, 'json', { fetchImpl, cache, store: true });
  const template = index.tiles[0];
  // Six at a time; resolves to how many could not be fetched.
  const fetchAll = async (jobs, text) => {
    let done = 0, failed = 0;
    const queue = [...jobs];
    const worker = async () => {
      while (queue.length) {
        const job = queue.shift();
        try { await job(); } catch { failed++; }
        onStatus(`${text} ${++done} of ${jobs.length}`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return failed;
  };
  // A font does not have every range of letters: a missing file here is normal.
  await fetchAll([...small].map((u) => () => offlineFetch(u, 'arrayBuffer', { fetchImpl, cache, store: true })), 'Downloading map fonts and icons…');
  // 3) The map picture: every tile of the area that is not on the phone yet.
  const todo = [];
  for (const t of tiles) if ((await cache.get(t.key)) == null) todo.push(t);
  const missing = await fetchAll(todo.map((t) => () => offlineFetch(template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y), 'arrayBuffer', { fetchImpl, cache, store: true })), 'Downloading the map…');
  if (todo.length && missing > 0.2 * todo.length) throw new Error('The download did not finish. Try again on a better connection.');
  const pack = { lat, lon, radius: Math.round(radius), label, time: Date.now(), tiles: tiles.length, missing };
  if (remember) rememberPack(pack, storage); // a route's own download is listed with the route instead
  return pack;
}

// ---------- Routes downloaded to run later ----------

const SAVED_ROUTES_KEY = 'rtt-routes';
export const MAX_SAVED_ROUTES = 12;
const ROUTE_MARGIN_M = 700; // map kept around the route: room to wander off it and be led back

/** The circle that holds a route ([[lat, lon], …]) with room around it: { lat, lon, radius }. */
export function routeCircle(latlngs, margin = ROUTE_MARGIN_M) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const [la, lo] of latlngs) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  const lat = (s + n) / 2, lon = (w + e) / 2;
  let far = 0;
  for (const [la, lo] of latlngs) far = Math.max(far, haversine(lat, lon, la, lo));
  return { lat, lon, radius: Math.round(Math.max(1200, far + margin)) };
}

// The route card as plain data. What the app hangs on a card for the screen (its lines on the
// map, flags; their names begin with "_") is left out: it cannot be stored and means nothing later.
const routeData = (route) => JSON.parse(JSON.stringify(route, (k, v) => (k.startsWith('_') ? undefined : v)));

function readSaved(storage) {
  try {
    const list = JSON.parse(storage?.getItem(SAVED_ROUTES_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
const fresh = (r, now) => now - r.time < OFFLINE_DAYS * 86400000;

/**
 * The routes on this phone, newest first: [{ id, name, distance, type, label, time, until,
 * lat, lon, radius }]. A route is kept as long as its map is: 14 days.
 */
export function savedRoutes(storage = globalThis.localStorage, now = Date.now()) {
  return readSaved(storage).filter((r) => fresh(r, now)).map((r) => ({ ...r, until: r.time + OFFLINE_DAYS * 86400000 }));
}

/**
 * Downloads a route to run later: the map around it (what the planner needs to lead the
 * runner back onto it, and the map picture) and the route card itself with its start.
 * `start`: { lat, lon, label }; `dest`: the finish of a one-way run, or null; `mode`: 'run'
 * or 'tour'. Resolves to the list entry; throws when the phone already holds
 * MAX_SAVED_ROUTES or the map could not be downloaded.
 */
export async function saveRouteForLater({ route, start, dest = null, mode = 'run', engine = null, onStatus = () => {}, fetchImpl = (...a) => fetch(...a), cache = tileCache, storage = globalThis.localStorage, store = routeStore, now = Date.now() }) {
  const all = readSaved(storage);
  // Routes past their 14 days leave the phone as the list is rewritten.
  for (const r of all) if (!fresh(r, now)) await store.remove(r.id);
  const list = all.filter((r) => fresh(r, now));
  if (list.length >= MAX_SAVED_ROUTES) throw new Error(`You have ${MAX_SAVED_ROUTES} downloaded routes, which is the most the app keeps. Delete one in Settings first.`);
  const circle = routeCircle(route.latlngs);
  const pack = await downloadPack({ ...circle, label: route.name, engine, onStatus, fetchImpl, cache, storage, remember: false });
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = { id, name: route.name, distance: route.distance, type: route.type, label: start?.label || '', time: now, ...circle };
  await store.put(id, { ...entry, mode, start, dest, route: routeData(route) });
  storage?.setItem(SAVED_ROUTES_KEY, JSON.stringify([entry, ...list]));
  return { ...entry, until: now + OFFLINE_DAYS * 86400000, missing: pack.missing };
}

/** A downloaded route, whole: { id, name, mode, start, dest, route, lat, lon, radius, … }, or null. */
export async function loadSavedRoute(id, { storage = globalThis.localStorage, store = routeStore, now = Date.now() } = {}) {
  if (!savedRoutes(storage, now).some((r) => r.id === id)) return null;
  return store.get(id);
}

/**
 * Deletes a downloaded route: the route, and the map pieces only it needed (a piece that
 * another downloaded route or a downloaded area also covers stays). Resolves to how many
 * map pieces were freed.
 */
export async function deleteSavedRoute(id, { cache = tileCache, storage = globalThis.localStorage, store = routeStore, now = Date.now() } = {}) {
  const all = readSaved(storage);
  const gone = all.find((r) => r.id === id);
  if (!gone) return 0;
  const rest = all.filter((r) => r.id !== id && fresh(r, now));
  const needed = new Set();
  let areas = [];
  try { areas = JSON.parse(storage?.getItem(OFFLINE_INFO_KEY) || '[]').filter((p) => fresh(p, now)); } catch { /* none */ }
  for (const other of [...rest, ...areas]) for (const t of packTiles(other.lat, other.lon, other.radius)) needed.add(t.key);
  let freed = 0;
  for (const t of packTiles(gone.lat, gone.lon, gone.radius)) {
    if (needed.has(t.key)) continue;
    await cache.remove?.(t.key);
    freed++;
  }
  await store.remove(id);
  storage?.setItem(SAVED_ROUTES_KEY, JSON.stringify(rest));
  return freed;
}
