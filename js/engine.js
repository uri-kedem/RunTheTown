// Ties it together: load an area (map + stops + elevation), then plan routes.
// Map data comes from OpenFreeMap vector tiles (fast CDN); traffic lights and
// crosswalks from a small Overpass query (best-effort); if the vector tiles
// fail, the full map falls back to Overpass. Tiles and elevation are cached
// on the device, so coming back to the same city is instant.

import { makeProjection, haversine } from './geo.js';
import { fetchTiles, tilesFor, parseOverpass, fetchStops, fetchUnlit, applySidewalkTags, wayMarks } from './osm.js';
import { vtTilesFor, fetchVectorTiles, osmFromVectorTiles } from './vectortiles.js';
import { fetchElevationGrid, ElevationGrid } from './elevation.js';
import { fetchLandcoverGrid } from './landcover.js';
import { LandscapeGrid } from './landscape.js';
import { Graph } from './graph.js';
import { applyPreferences, planLoops, planOneWay } from './planner.js';
import { findRunningPlaces, placeRoute } from './places.js';
import { lookupPlace } from './details.js';
import { scanSpots, mergeSpots } from './spots.js';
import { findCachedArea, saveArea, tileCache } from './cache.js';

export const MAX_DISTANCE_KM = 42.2;
export const LONG_RUN_M = 15000;
// Enough of the map must load to plan well; edge tiles may fail on busy servers.
const MIN_TILE_SHARE = 0.75;
// Traffic-light and elevation data never hold routes up for long: wait at most
// this long after the map is ready (they're saved for next time if they arrive later).
const STOPS_GRACE_MS = 4000;
const LANDSCAPE_CELL = 25; // metres; the land-cover grid is sampled on the same cells

// Loops reach ~0.3·D from the start; a little margin lets nearby starts reuse
// the area. Long runs grow the area more slowly (the download grows with the
// square of the radius), so their routes wind more instead of going farther.
// How far from the start the map is loaded. A there-and-back reaches ~0.4·D out, so
// 0.38·D (+300 m) keeps a seafront 3 km away within an 8 km run; long runs level off
// (the far side of a 20 km loop is never 8 km out on real streets).
export function radiusFor(distanceM) {
  const long = 0.32 * LONG_RUN_M + 300 + 0.2 * Math.max(0, distanceM - LONG_RUN_M);
  return Math.round(Math.min(0.38 * distanceM + 300, long));
}

/** The area an offline pack covers: what a run of this distance (10 km at least) can reach from the start. */
export const packRadius = (distanceKm) => radiusFor(Math.max(10, Math.min(MAX_DISTANCE_KM, distanceKm || 0)) * 1000);

export class RouteEngine {
  constructor({ fetchImpl = (...a) => fetch(...a), fetchElevationImpl = fetchElevationGrid, fetchLandcoverImpl = fetchLandcoverGrid, useCache = true, scanPauseMs = 1050, cityScan = false } = {}) {
    // The city-wide stadium scan asks Nominatim several times per start. Its usage policy
    // forbids that from an app on many phones, so the scan is off until the queries go
    // through a server of our own; the loaded map still provides the tracks it covers.
    this.cityScan = cityScan;
    this.area = null;
    this.scanPauseMs = scanPauseMs;
    this.fetchImpl = fetchImpl;
    this.fetchElevation = fetchElevationImpl;
    this.fetchLandcover = fetchLandcoverImpl;
    this.useCache = useCache && typeof indexedDB !== 'undefined';
  }

  covers(lat, lon, radius, mode) {
    const a = this.area;
    if (!a || (a.mode !== mode && a.mode !== 'full')) return false;
    return haversine(a.lat, a.lon, lat, lon) + radius <= a.radius;
  }

  async loadArea(lat, lon, needed, onStatus = () => {}) {
    const mode = needed > radiusFor(LONG_RUN_M) ? 'long' : 'full';
    if (this.covers(lat, lon, needed, mode)) return this.area;
    // A download already running for an area that covers this one (e.g. the
    // running-spot preview started when the start point was set): join it.
    const p = this.pending;
    if (p && (p.mode === mode || p.mode === 'full') && haversine(p.lat, p.lon, lat, lon) + needed <= p.radius) {
      p.onStatus = onStatus;
      return p.promise;
    }
    const pend = { lat, lon, radius: Math.round(needed * 1.05), mode, onStatus };
    pend.promise = this.loadAreaNow(lat, lon, needed, (t) => pend.onStatus(t)).finally(() => {
      if (this.pending === pend) this.pending = null;
    });
    this.pending = pend;
    return pend.promise;
  }

  async loadAreaNow(lat, lon, needed, onStatus = () => {}) {
    const mode = needed > radiusFor(LONG_RUN_M) ? 'long' : 'full';
    const long = mode === 'long';
    const radius = Math.round(needed * 1.05);
    const proj = makeProjection(lat, lon);
    const cache = this.useCache ? tileCache : null;

    // 1) Map from vector tiles, stops from Overpass, elevation: all in parallel.
    const vtiles = vtTilesFor(lat, lon, radius);
    const progress = (done, total) => onStatus(done < total ? `Downloading map… ${done} of ${total} pieces` : 'Map downloaded');
    // Lights and elevation are optional: once the map is ready, wait for them at
    // most STOPS_GRACE_MS (they're cached for next time if they arrive later).
    const stopsPromise = this.loadStops(lat, lon, radius, long);
    const elevPromise = this.loadElevation(lat, lon, radius, proj);
    // Land cover from space (ESA WorldCover): optional like the lights, a few small tiles.
    const lcPromise = this.fetchLandcover(proj, radius, LANDSCAPE_CELL, { fetchImpl: this.fetchImpl, cache: this.useCache ? tileCache : null }).catch((err) => {
      console.warn('Land cover unavailable:', err);
      return null;
    });
    const vt = await fetchVectorTiles(vtiles, { cache, fetchImpl: this.fetchImpl, onProgress: progress }).catch(() => ({
      buffers: new Map(),
      failed: vtiles.map((t) => t.key),
    }));
    const grace = new Promise((r) => setTimeout(() => r(null), STOPS_GRACE_MS));
    const [stopPoints, elev, landcover] = await Promise.all([Promise.race([stopsPromise, grace]), Promise.race([elevPromise, grace]), Promise.race([lcPromise, grace])]);

    let osm;
    let source = 'vector';
    let tiles = vtiles.length;
    let failedTiles = vt.failed.length;
    const startOk = !vt.failed.includes(vtiles.find((t) => t.hasStart)?.key);
    if (startOk && 1 - failedTiles / tiles >= MIN_TILE_SHARE) {
      osm = osmFromVectorTiles(vtiles, vt.buffers, { long });
      osm.stopPoints = stopPoints || [];
      if (stopPoints?.docks?.length) osm.features.push(...stopPoints.docks); // marina basins: their quays leave the network
      if (stopPoints?.sidewalks?.length) applySidewalkTags(osm, stopPoints.sidewalks, proj); // the sidewalk tag, where mapped
      // No answer about lights and crossings: the graph marks the junctions of main roads as
      // likely lights, so a route is still steered round them.
      osm.stopsUnknown = stopPoints === null;
    } else {
      // 2) Backup: the full map from Overpass (slower, but has everything).
      source = 'overpass';
      onStatus('Map tiles unavailable, trying backup map servers…');
      const otiles = tilesFor(lat, lon, radius, mode);
      const { elements, failed } = await fetchTiles(otiles, mode, {
        cache,
        fetchImpl: this.fetchImpl,
        onProgress: (d, t) => onStatus(d < t ? `Downloading map (backup)… ${d} of ${t} pieces` : 'Map downloaded'),
      });
      const startTile = otiles.find((t) => t.contains(lat, lon));
      tiles = otiles.length;
      failedTiles = failed.length;
      if ((startTile && failed.includes(startTile.key)) || 1 - failedTiles / tiles < MIN_TILE_SHARE) {
        throw new Error(
          `The map servers are overloaded (${tiles - failedTiles} of ${tiles} map pieces loaded). ` +
            'Press "Find my routes" again: pieces that loaded are saved, so the next try is faster.',
        );
      }
      osm = parseOverpass({ elements });
    }

    if (!osm.roads.length) throw new Error('No streets or paths found around here.');
    onStatus('Reading the landscape…');
    await new Promise((r) => setTimeout(r, 0));
    const grid = new LandscapeGrid(proj, radius, LANDSCAPE_CELL);
    grid.addFeatures(osm.features);
    grid.addLandcover(landcover); // satellite fills what the map leaves out
    grid.finish();
    const graph = new Graph(osm, proj, grid, elev);
    graph.stopsKnown = source === 'overpass' || stopPoints !== null; // cards say so when the lights could not be fetched (they are then estimated)
    const built = {
      lat, lon, radius, mode, proj, graph, grid, elev, source, tiles, failedTiles,
      stopsKnown: source === 'overpass' || stopPoints !== null,
      osmPlaces: osm.places || null,
      audit: osm.audit || null, // ways kept and left out, by kind (for checks)
      landcover: !!landcover, // satellite land cover was merged in
    };
    // Two loads can be in flight (the spot preview and a bigger plan): a smaller map must
    // not replace a bigger one that already covers it when it happens to finish last.
    const cur = this.area;
    if (!(cur && cur.radius > radius && (cur.mode === mode || cur.mode === 'full') && haversine(cur.lat, cur.lon, lat, lon) + radius <= cur.radius)) this.area = built;
    return built;
  }

  // Traffic lights & crosswalks: from the device cache, else one small query.
  async loadStops(lat, lon, radius, long) {
    const key = `stops3:${long ? 'long' : 'full'}:${lat.toFixed(2)}:${lon.toFixed(2)}`;
    if (this.useCache) {
      const hit = await tileCache.get(key);
      if (hit && haversine(hit.lat, hit.lon, lat, lon) + radius <= hit.radius) return Object.assign(hit.points, { docks: hit.docks || [], sidewalks: hit.sidewalks || [] });
    }
    const r = Math.round(radius + 1500); // a bit extra so nearby starts reuse it
    const points = await fetchStops(lat, lon, r, { long, fetchImpl: this.fetchImpl });
    if (points && this.useCache) tileCache.put(key, { lat, lon, radius: r, points: Array.from(points), docks: points.docks || [], sidewalks: points.sidewalks || [] });
    return points;
  }

  // The ways the map says are unlit: from the device cache, else one query. Null when the
  // servers do not answer.
  async loadUnlit(lat, lon, radius) {
    const key = `unlit1:${lat.toFixed(2)}:${lon.toFixed(2)}`;
    const last = this.unlitLast; // the answer of this session, for the next plan from the same start
    if (last && haversine(last.lat, last.lon, lat, lon) + radius <= last.radius) return last.ways;
    if (this.useCache) {
      const hit = await tileCache.get(key);
      if (hit && haversine(hit.lat, hit.lon, lat, lon) + radius <= hit.radius) return hit.ways;
    }
    const r = Math.round(radius + 1500); // a bit extra so nearby starts reuse it
    const ways = await fetchUnlit(lat, lon, r, { fetchImpl: this.fetchImpl });
    if (ways) this.unlitLast = { lat, lon, radius: r, ways };
    if (ways && this.useCache) tileCache.put(key, { lat, lon, radius: r, ways });
    return ways;
  }

  // A run after dark (prefs.dark): the unlit ways are laid on the area's graph, so the
  // planner can prefer the lit ones. `asked` is the request started alongside the map
  // download; it is waited for at most STOPS_GRACE_MS more (it is kept on the phone when
  // it arrives later, for the next plan). The backup map carries the lit tag itself.
  async lightUp(area, asked) {
    if (!asked || area.source === 'overpass') return;
    const ways = await Promise.race([asked, new Promise((r) => setTimeout(() => r(null), STOPS_GRACE_MS))]);
    if (ways) area.graph.setUnlit(wayMarks(ways, area.proj));
  }

  // Elevation is optional: on failure, routes are planned without hills.
  async loadElevation(lat, lon, radius, proj) {
    if (this.useCache) {
      const hit = await findCachedArea(lat, lon, radius);
      if (hit?.elev) {
        const p = makeProjection(hit.lat, hit.lon);
        const grid = new ElevationGrid(p, hit.radius, hit.elev.n, hit.elev.values instanceof Float32Array ? hit.elev.values : Float32Array.from(hit.elev.values));
        // Re-centre: sample through the cached grid's own projection.
        return { at: (x, y) => { const [la, lo] = proj.toLatLon(x, y); const [cx, cy] = p.toXY(la, lo); return grid.at(cx, cy); } };
      }
    }
    try {
      const elev = await this.fetchElevation(proj, radius);
      if (this.useCache) saveArea({ lat, lon, radius, elev: { n: elev.n, values: elev.values } });
      return elev;
    } catch (err) {
      console.warn('Elevation unavailable:', err);
      return null;
    }
  }

  async plan({ lat, lon, distanceKm, prefs, terrain, onStatus = () => {}, turnWeight = 1 }) {
    const D = Math.min(MAX_DISTANCE_KM, distanceKm) * 1000;
    const unlit = prefs?.dark ? this.loadUnlit(lat, lon, radiusFor(D)).catch(() => null) : null;
    const area = await this.loadArea(lat, lon, radiusFor(D), onStatus);
    await this.lightUp(area, unlit);
    const g = area.graph;
    g.turnWeight = turnWeight;
    const routes = await this.design(g, prefs, terrain, () => {
      onStatus('Designing routes…');
      return planLoops(g, {
        startXY: area.proj.toXY(lat, lon),
        distance: D,
        prefs,
        terrain,
        onProgress: (p) => onStatus(`Designing routes… ${Math.round(p * 100)}%`),
      });
    });
    routes.country = routes.some((r) => r.stats?.countryFrac > 0.2);
    routes.village = !!g.village;
    routes.partialMap = area.failedTiles > 0;
    routes.stopsUnknown = !area.stopsKnown;
    // Running spots nearby (tracks, big parks), with how far they are from the start.
    onStatus('Looking for running tracks and parks…');
    routes.places = await this.spotsNear(lat, lon, Math.max(4000, 0.6 * D));
    this.lastPlan = { lat, lon, distanceKm: Math.min(MAX_DISTANCE_KM, distanceKm), prefs };
    return routes;
  }

  /**
   * A one-way run from (lat, lon) to (toLat, toLon): the map is loaded around the middle of
   * the two, wide enough for both and for a scenic way round when the distance asked for
   * is longer than the way there. The cards come from planOneWay (the best way, the
   * shortest safe way, a longer way for the wished distance). Two points further apart
   * than the longest run are refused.
   */
  async planOneWay({ lat, lon, toLat, toLon, destName = null, distanceKm = 0, prefs = {}, terrain = 'any', onStatus = () => {}, turnWeight = 1 }) {
    const apart = haversine(lat, lon, toLat, toLon);
    if (apart > MAX_DISTANCE_KM * 1000) throw new Error(`The finish is ${(apart / 1000).toFixed(0)} km away, further than the longest run (${MAX_DISTANCE_KM} km). Pick a nearer one.`);
    if (apart < 150) throw new Error('The finish is right at the start. Pick a place further away.');
    const D = Math.min(MAX_DISTANCE_KM * 1000, Math.max(distanceKm * 1000, apart));
    // Half the gap plus room at both ends, plus a share of any extra distance asked for (a
    // longer way round reaches out sideways), but never a bigger map than the longest loop's.
    const needed = Math.min(radiusFor(MAX_DISTANCE_KM * 1000) * 2, Math.max(1500, apart / 2 + 600 + 0.2 * (D - apart)));
    const cLat = (lat + toLat) / 2;
    const cLon = (lon + toLon) / 2;
    const unlit = prefs?.dark ? this.loadUnlit(cLat, cLon, needed).catch(() => null) : null;
    const area = await this.loadArea(cLat, cLon, needed, onStatus);
    await this.lightUp(area, unlit);
    const g = area.graph;
    g.turnWeight = turnWeight;
    const routes = await this.design(g, prefs, terrain, () => {
      onStatus('Designing the way there…');
      return planOneWay(g, { startXY: area.proj.toXY(lat, lon), destXY: area.proj.toXY(toLat, toLon), distance: D, prefs, terrain, destName });
    });
    routes.country = routes.some((r) => r.stats?.countryFrac > 0.2);
    routes.village = !!g.village;
    routes.partialMap = area.failedTiles > 0;
    routes.stopsUnknown = !area.stopsKnown;
    routes.places = [];
    this.lastPlan = { lat, lon, distanceKm: D / 1000, prefs };
    return routes;
  }

  // Runs one planning request with the preferences on the graph, in country mode when the
  // paved network cannot carry it. Returns what `plan()` returned.
  async design(g, prefs, terrain, plan) {
    const design = () => {
      applyPreferences(g, { prefs, terrain });
      return plan();
    };
    // Made surfaces first. In a village or open country the paved network may not reach the
    // start or carry the distance: then the unpaved lanes and dirt tracks are switched on
    // (country mode) and the run says so on its cards.
    // In a village the lanes and tracks are the streets: on from the start, so the one paved
    // through-road does not become the run.
    g.allowCountry = g.village && g.countryWays > 0;
    let routes;
    try {
      routes = await design();
    } catch (err) {
      if (!g.countryWays || g.allowCountry) throw err;
      g.allowCountry = true;
      routes = await design();
    } finally {
      g.allowCountry = false;
    }
    return routes;
  }

  /**
   * Streets and paths of the map already loaded whose name matches what was typed: the
   * name, or a word in it, begins with `text` (English or the local name). They need no
   * connection and no search service, so the search box can offer them at once, and still
   * offer them when the service is slow or down. `near` ([lat, lon]) puts the closest
   * first. Returns [{ name, local, lat, lon }] (a point on the street), at most `limit`.
   */
  streetsNamed(text, { near = null, limit = 4 } = {}) {
    const area = this.area;
    const q = String(text || '').trim().toLowerCase();
    if (!area || q.length < 2) return [];
    const g = area.graph;
    const mid = (e) => [(g.lat[g.ea[e]] + g.lat[g.eb[e]]) / 2, (g.lon[g.ea[e]] + g.lon[g.eb[e]]) / 2];
    if (!area.streets) {
      // Once per map: every named street with its stretches.
      const byName = new Map(); // name id -> its edges
      for (let e = 0; e < g.m; e++) {
        const id = g.edgeName[e];
        if (id < 0) continue;
        let list = byName.get(id);
        if (!list) byName.set(id, (list = []));
        list.push(e);
      }
      area.streets = [...byName].map(([id, edges]) => ({ name: g.names[id].name, local: g.names[id].local, edges }));
    }
    const begins = (s) => { const t = String(s || '').toLowerCase(); return t.startsWith(q) ? 2 : t.includes(' ' + q) ? 1 : 0; };
    const hits = [];
    for (const s of area.streets) {
      const rank = Math.max(begins(s.name), begins(s.local));
      if (!rank) continue;
      // The point of the street to offer: the one nearest the runner (a long street passes
      // many places; theirs is the stretch by them), or its middle when no place is given.
      let at = mid(s.edges[s.edges.length >> 1]);
      let far = 0;
      if (near) {
        far = Infinity;
        for (const e of s.edges) {
          const p = mid(e);
          const d = haversine(near[0], near[1], p[0], p[1]);
          if (d < far) { far = d; at = p; }
        }
      }
      hits.push({ name: s.name, local: s.local, lat: at[0], lon: at[1], rank, far });
    }
    hits.sort((a, b) => b.rank - a.rank || a.far - b.far || a.name.localeCompare(b.name));
    return hits.slice(0, limit).map(({ name, local, lat, lon }) => ({ name, local, lat, lon }));
  }

  // Stadiums and athletics tracks within ~8 km, from one quick scan (no map download). Cached per start.
  scanSpots(lat, lon) {
    if (!this.cityScan) return Promise.resolve([]);
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    this.scanMemo ||= new Map();
    if (!this.scanMemo.has(key)) {
      const p = scanSpots(lat, lon, { fetchImpl: this.fetchImpl, pauseMs: this.scanPauseMs });
      this.scanMemo.set(key, p);
      // A scan that failed (offline, busy servers) is not remembered: the next ask tries again.
      p.then((spots) => { if (spots.failed && this.scanMemo.get(key) === p) this.scanMemo.delete(key); });
    }
    return this.scanMemo.get(key);
  }

  /**
   * Running spots around a point, nearest first: the scanned stadiums and tracks,
   * plus parks and tracks from the loaded map (when it covers them), merged.
   */
  async spotsNear(lat, lon, within, { scanned = null } = {}) {
    const fromTiles = this.area ? await findRunningPlaces(this.area) : [];
    const scan = scanned || (await this.scanSpots(lat, lon));
    const merged = mergeSpots(scan, fromTiles.map((p) => ({ ...p })));
    const g = this.area?.graph;
    for (const p of merged) {
      if (p.node === undefined && g) {
        // A scanned track: tie it to the map when the map covers it, so a route can run there.
        const [x, y] = this.area.proj.toXY(p.lat, p.lon);
        p.node = g.nearest(x, y, { maxDist: 300 });
      }
      if (p.node === undefined) p.node = -1;
      if (!p.entry) p.entry = p.node >= 0 ? [g.lat[p.node], g.lon[p.node]] : [p.lat, p.lon];
      p.fromStart = haversine(lat, lon, p.entry[0], p.entry[1]);
    }
    return merged.filter((p) => p.fromStart <= within).sort((a, b) => a.fromStart - b.fromStart);
  }

  /**
   * Tracks, stadiums and parks around a start point, before any route is asked
   * for: loads the map for a typical run around it (reused by the plan later).
   */
  async previewSpots(lat, lon, { distanceKm = 8, onStatus = () => {} } = {}) {
    const scanned = this.scanSpots(lat, lon);
    await this.loadArea(lat, lon, radiusFor(Math.min(MAX_DISTANCE_KM, distanceKm) * 1000), onStatus).catch(() => null);
    return this.spotsNear(lat, lon, 8500, { scanned: await scanned });
  }

  // A lap route at a running spot: for the last plan, or for a given start and distance.
  // Null for a spot without a lap outline (a stadium known only by name).
  routeAtPlace(place, plan = this.lastPlan) {
    if (!place.ring || !this.area) return null;
    return placeRoute(this.area, place, plan);
  }

  // Website, Wikipedia page, hours and entry rules of a running spot (looked up once, then cached).
  async placeDetails(place) {
    const key = `place:${place.lat.toFixed(4)},${place.lon.toFixed(4)}`;
    this.detailsMemo ||= new Map();
    if (this.detailsMemo.has(key)) return this.detailsMemo.get(key);
    const job = (async () => {
      if (this.useCache) {
        const hit = await tileCache.get(key);
        if (hit) return hit;
      }
      const d = await lookupPlace(place, { fetchImpl: this.fetchImpl });
      if (this.useCache && Object.keys(d).length) tileCache.put(key, d);
      if (d.failed && this.detailsMemo.get(key) === job) this.detailsMemo.delete(key); // offline: ask again next time
      return d;
    })();
    this.detailsMemo.set(key, job);
    return job;
  }
}
