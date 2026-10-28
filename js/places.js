// Running spots: athletics tracks (400 m ovals) and big parks with a smooth
// inner loop, found in the loaded area and offered as ready-made lap routes.

import { planLoops, applyPreferences, routeStats, passedSights, climbText, stopsText } from './planner.js';
import { buildCues, cueText } from './cues.js';
import { haversine } from './geo.js';

const TRACK_MIN_PERIM = 250; // m: smaller "tracks" are playground loops
const TRACK_MAX_PERIM = 700;
const PARK_MIN_AREA = 150000; // m²: 15 ha, a park you can run around
const PARK_MIN_PATHS = 1500; // m of car-free paths inside
const MAX_TRACKS = 4;
const MAX_PARKS = 4;
const ATHLETICS = /athletic|running|track|אתלטיקה|ריצה/i;
const NOT_RUNNING = /velodrome|cycl|ולודרום|אופניים|motor|kart|speedway|horse|equestrian|greyhound|ice rink|skat/i;

const perimeter = (xy) => {
  let s = 0;
  for (let i = 1; i < xy.length; i++) s += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  return s;
};
const polyArea = (xy) => {
  let s = 0;
  for (let i = 1; i < xy.length; i++) s += xy[i - 1][0] * xy[i][1] - xy[i][0] * xy[i - 1][1];
  return Math.abs(s) / 2;
};

/**
 * Finds tracks and running parks in a loaded area. Cached on the area.
 * Each place: { kind: 'track' | 'park', name, local, lat, lon, node, lapM,
 *               ring (closed lat/lon loop, starting at the entrance), loop (park: described route) }
 */
export async function findRunningPlaces(area) {
  if (area.runningPlaces) return area.runningPlaces;
  const { graph: g, grid, proj } = area;
  const src = area.osmPlaces || { tracks: [], parks: [], stadiums: [] };
  const places = [];

  // ---- Athletics tracks ----
  const tracks = [];
  for (const t of src.tracks) {
    const xy = t.ring.map(([la, lo]) => proj.toXY(la, lo));
    if (Math.hypot(xy[0][0] - xy[xy.length - 1][0], xy[0][1] - xy[xy.length - 1][1]) > 1) xy.push(xy[0]);
    const P = perimeter(xy);
    const A = polyArea(xy);
    if (P < TRACK_MIN_PERIM || P > TRACK_MAX_PERIM || A < 3000 || A > 40000 || A / (P * P) < 0.03) continue;
    let cx = 0, cy = 0;
    for (let i = 0; i < xy.length - 1; i++) { cx += xy[i][0]; cy += xy[i][1]; }
    cx /= xy.length - 1; cy /= xy.length - 1;
    if (tracks.some((o) => Math.hypot(o.cx - cx, o.cy - cy) < 150)) continue;
    // The stadium or arena this oval belongs to (name, and whether it's for runners at all).
    let name = 'Athletics track';
    let local = name;
    let bestD = 400;
    for (const st of src.stadiums) {
      const d = haversine(st.lat, st.lon, t.lat, t.lon);
      if (d < bestD) { bestD = d; name = st.name; local = st.local; }
    }
    if (NOT_RUNNING.test(name + ' ' + local)) continue; // a velodrome, a kart track...
    // A stadium outline only counts when it's an athletics stadium.
    if (t.cls === 'stadium' && !ATHLETICS.test(name + ' ' + local)) continue;
    const node = g.nearest(cx, cy, { maxDist: 300 });
    if (node < 0) continue;
    // The landuse area is the whole oval; the lap is run on the inside lane (~400 m).
    const k = P > 420 ? 400 / P : 1;
    const lap = xy.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    const lapM = Math.round(perimeter(lap) / 10) * 10;
    // Start the lap at the point nearest the way in.
    let s = 0, best = Infinity;
    for (let i = 0; i < lap.length - 1; i++) {
      const d = Math.hypot(lap[i][0] - g.x[node], lap[i][1] - g.y[node]);
      if (d < best) { best = d; s = i; }
    }
    let open = lap.slice(0, -1);
    // Laps go counter-clockwise, as on every athletics track.
    let signed = 0;
    for (let i = 0; i < open.length; i++) { const a = open[i], b = open[(i + 1) % open.length]; signed += a[0] * b[1] - b[0] * a[1]; }
    if (signed < 0) { open = open.reverse(); s = open.length - 1 - s; }
    const ringXY = [...open.slice(s), ...open.slice(0, s), open[s]];
    const ring = ringXY.map(([x, y]) => proj.toLatLon(x, y));
    tracks.push({ kind: 'track', name, local, lat: t.lat, lon: t.lon, cx, cy, node, lapM, ring, entry: proj.toLatLon(g.x[node], g.y[node]) });
  }
  tracks.sort((a, b) => Math.hypot(a.cx, a.cy) - Math.hypot(b.cx, b.cy));
  places.push(...tracks.slice(0, MAX_TRACKS));

  // ---- Running parks: contiguous green areas with paths inside, named by their park POI ----
  const n = grid.n;
  const green = grid.green;
  const label = new Int32Array(n * n).fill(-1);
  const blobs = [];
  const cellOf = (x, y) => {
    const c = grid.col(x);
    const r = grid.row(y);
    return c < 0 || r < 0 || c >= n || r >= n ? -1 : r * n + c;
  };
  const flood = (c0) => {
    const id = blobs.length;
    const cells = [];
    const stack = [c0];
    label[c0] = id;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const r = (c / n) | 0;
      const col = c - r * n;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = col + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const k = rr * n + cc;
        if (green[k] && label[k] < 0) { label[k] = id; stack.push(k); }
      }
    }
    blobs.push({ id, cells, area: cells.length * grid.cell * grid.cell, pois: [], paths: 0 });
    return id;
  };
  for (const p of src.parks) {
    const [x, y] = proj.toXY(p.lat, p.lon);
    let c = cellOf(x, y);
    if (c < 0) continue;
    if (!green[c]) {
      // The label point can sit on a path or pond: look a few cells around.
      const r0 = (c / n) | 0, c0 = c - r0 * n;
      c = -1;
      for (let d = 1; d <= 4 && c < 0; d++) {
        for (let dr = -d; dr <= d && c < 0; dr++) for (let dc = -d; dc <= d; dc++) {
          const rr = r0 + dr, cc = c0 + dc;
          if (rr >= 0 && cc >= 0 && rr < n && cc < n && green[rr * n + cc]) { c = rr * n + cc; break; }
        }
      }
      if (c < 0) continue;
    }
    const id = label[c] >= 0 ? label[c] : flood(c);
    blobs[id].pois.push({ ...p, x, y });
  }
  const big = blobs.filter((b) => b.area >= PARK_MIN_AREA);
  if (big.length) {
    for (let e = 0; e < g.m; e++) {
      if (g.hw[e] !== 0) continue; // paths only
      const a = g.ea[e], b = g.eb[e];
      const c = cellOf((g.x[a] + g.x[b]) / 2, (g.y[a] + g.y[b]) / 2);
      if (c >= 0 && label[c] >= 0) blobs[label[c]].paths += g.len[e];
    }
  }
  const parks = big.filter((b) => b.paths >= PARK_MIN_PATHS).sort((a, b) => b.area - a.area).slice(0, MAX_PARKS);
  if (parks.length) {
    // The preview plans on a private view of the graph: own costs and penalties, the
    // same streets. A route search the runner starts meanwhile (the preview runs for
    // seconds, with awaits) keeps its own preferences untouched.
    const gp = Object.create(g);
    gp.costF = g.costF.slice();
    gp.costB = g.costB.slice();
    gp.penalty = new Float32Array(g.m).fill(1);
    gp.stopWeight = g.stopWeight;
    // The search's visit stamps must stay one counter for both views (they share the
    // scratch arrays), or one search would mistake the other's marks for its own.
    Object.defineProperty(gp, 'curStamp', { get: () => g.curStamp, set: (v) => { g.curStamp = v; } });
    applyPreferences(gp, { prefs: { green: true }, terrain: 'any' });
    for (const b of parks) {
      // Name: the park's own label (best rank, nearest the middle of the green), not a sub-garden's.
      let mx = 0, my = 0;
      for (const c of b.cells) { mx += grid.center(c % n); my += grid.center((c / n) | 0); }
      mx /= b.cells.length; my /= b.cells.length;
      const poi = [...b.pois].sort((p, q) => p.rank - q.rank || Math.hypot(p.x - mx, p.y - my) - Math.hypot(q.x - mx, q.y - my))[0];
      const entry = g.nearest(poi.x, poi.y, { maxDist: 500, filter: (i) => { const c = cellOf(g.x[i], g.y[i]); return c >= 0 && label[c] === b.id; } });
      if (entry < 0) continue;
      // Keep the loop inside the park: paths elsewhere cost 6x.
      for (let e = 0; e < g.m; e++) {
        const c = cellOf((g.x[g.ea[e]] + g.x[g.eb[e]]) / 2, (g.y[g.ea[e]] + g.y[g.eb[e]]) / 2);
        gp.penalty[e] = c >= 0 && label[c] === b.id ? 1 : 6;
      }
      const D = Math.max(1500, Math.min(5000, 2.2 * Math.sqrt(b.area), 0.6 * b.paths));
      let loop = null;
      try {
        const routes = await planLoops(gp, { startXY: [g.x[entry], g.y[entry]], distance: D, prefs: { green: true }, terrain: 'any', count: 1, bearings: 8 });
        loop = routes.find((r) => r.type === 'loop' && r.stats.greenFrac >= 0.5 && r.stats.distErr < 0.15) || null;
      } catch {}
      if (!loop) continue;
      const lapM = Math.round(loop.distance / 10) * 10;
      places.push({
        kind: 'park', name: poi.name, local: poi.local, lat: poi.lat, lon: poi.lon, node: entry, lapM,
        areaKm2: b.area / 1e6, pathsKm: b.paths / 1000, ring: loop.latlngs, loop, entry: [g.lat[entry], g.lon[entry]],
      });
    }
  }
  area.runningPlaces = places;
  return places;
}

const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(m)} m`);

/**
 * A complete route for a running spot: from the start to the place, `laps`
 * laps of it, and back the same way; or laps only when it's too far to run to.
 * Returns the same shape as the planner's routes (card + navigation ready).
 */
export function placeRoute(area, place, { lat, lon, distanceKm, prefs = {} }) {
  const { graph: g, proj } = area;
  const D = distanceKm * 1000;
  const [sx, sy] = proj.toXY(lat, lon);
  const startNode = g.nearest(sx, sy, { maxDist: 1500, scoreFn: (i, d) => d + (g.nodeRough[i] ? 250 : 0) });
  // The spot's way in, found on THIS graph (the spot may have been listed on an earlier,
  // smaller map; node ids do not carry over).
  const [px, py] = proj.toXY(place.lat, place.lon);
  const placeNode = g.nearest(px, py, { maxDist: 400 });
  // The way there and back is always part of the run when one exists: a runner who picks
  // a track 3 km away wants the route to it, even if the run comes out longer than asked.
  let leg = null;
  if (startNode >= 0 && placeNode >= 0 && startNode !== placeNode) {
    const p = g.shortestPath(startNode, placeNode);
    if (p) {
      let L = 0;
      for (const e of p.edges) L += g.len[e];
      leg = { ...p, length: L };
    }
  }
  const legLen = leg ? leg.length : 0;
  const laps = Math.max(1, Math.round((D - 2 * legLen) / place.lapM));
  const latlngs = [];
  const cues = [];
  const sights = [];
  let along = 0;
  const headingAt = (arr, from, dir) => {
    // Direction of travel over ~18 m from index `from`, forwards (+1) or backwards (-1).
    let i = from, d = 0;
    while (i + dir >= 0 && i + dir < arr.length && d < 18) { d += haversine(arr[i][0], arr[i][1], arr[i + dir][0], arr[i + dir][1]); i += dir; }
    const [a, b] = dir > 0 ? [arr[from], arr[i]] : [arr[i], arr[from]];
    return (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
  };
  const addPiece = (pts, pieceCues, pieceSights, { continuous = false, label = null } = {}) => {
    // A gap between pieces (street node -> track edge) becomes a short connector, with no
    // turn cue of its own: the join is announced in words by the piece it leads to.
    if (latlngs.length) {
      const last = latlngs[latlngs.length - 1];
      if (haversine(last[0], last[1], pts[0][0], pts[0][1]) > 5) addPiece([last, pts[0]], [], [], { continuous: true });
    }
    const base = latlngs.length ? latlngs.length - 1 : 0;
    const atBase = along;
    if (label && latlngs.length >= 1) {
      // Onto the track, off the track: said in words, not as a bearing-based turn.
      cues.push({ type: 'turn', dir: null, angle: 0, at: atBase, idx: base, lat: pts[0][0], lon: pts[0][1], street: null, text: label });
    } else if (!continuous && latlngs.length >= 2 && pts.length >= 2) {
      // The turn where one piece joins the next.
      let a = headingAt(pts, 0, 1) - headingAt(latlngs, latlngs.length - 1, -1);
      a = ((a + 540) % 360) - 180;
      const abs = Math.abs(a);
      if (abs >= 30) {
        const type = abs >= 150 ? 'uturn' : abs < 60 ? 'slight' : abs < 135 ? 'turn' : 'sharp';
        const c = { type, dir: a > 0 ? 'right' : 'left', angle: a, at: atBase, idx: base, lat: pts[0][0], lon: pts[0][1], street: null };
        c.text = cueText(c);
        cues.push(c);
      }
    }
    if (!latlngs.length) latlngs.push(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      along += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      latlngs.push(pts[i]);
    }
    for (const c of pieceCues) {
      if (c.type === 'depart' || c.type === 'arrive') continue;
      cues.push({ ...c, idx: base + c.idx, at: atBase + c.at });
    }
    for (const s of pieceSights) sights.push({ ...s, at: atBase + s.at });
    return atBase;
  };
  const legPts = leg ? leg.nodes.map((v) => [g.lat[v], g.lon[v]]) : null;
  const withSights = !!prefs.sights;
  if (leg) addPiece(legPts, buildCues(g, leg), withSights ? passedSights(g, leg) : []);
  const lapCues = place.kind === 'park' ? place.loop.cues : [];
  const lapSights = place.kind === 'park' && withSights ? place.loop.sights : [];
  const onto = place.kind === 'track' ? 'Onto the track' : `Into ${place.name}`;
  for (let k = 0; k < laps; k++) {
    const at = addPiece(place.ring, lapCues, k === 0 ? lapSights : [], { continuous: k > 0, label: k === 0 && leg ? onto : null }); // lap to lap: no turn, just carry on
    if (laps > 1) cues.push({ type: 'lap', lap: k + 1, laps, at, idx: latlngs.length - place.ring.length, lat: place.ring[0][0], lon: place.ring[0][1], text: `Lap ${k + 1} of ${laps}` });
  }
  if (leg) {
    const back = { nodes: [...leg.nodes].reverse(), edges: [...leg.edges].reverse() };
    addPiece(legPts.slice().reverse(), buildCues(g, back), withSights ? passedSights(g, back) : [], { label: `${laps > 1 ? 'Laps done. ' : ''}Head back the same way` });
  }
  cues.sort((a, b) => a.at - b.at);
  const first = leg ? buildCues(g, leg)[0] : null;
  cues.unshift({ type: 'depart', at: 0, idx: 0, compass: first?.compass || 'out', street: first?.street || null, lat: latlngs[0][0], lon: latlngs[0][1], text: first ? first.text : 'Head out' });
  cues.push({ type: 'arrive', at: along, idx: latlngs.length - 1, lat: latlngs[latlngs.length - 1][0], lon: latlngs[latlngs.length - 1][1], text: leg ? 'You have arrived back at the start' : 'Run complete' });

  // Stats for the card: legs from the graph, laps from the place.
  const legStats = leg ? routeStats(g, leg, legLen) : null;
  const lapStats = place.kind === 'park' ? place.loop.stats : { greenFrac: 0, waterFrac: 0, promFrac: 1, quietFrac: 1, busyFrac: 0, roughFrac: 0, signals: 0, crossings: 0, turns: 0, gain: 0, loss: 0 };
  const total = along;
  const mix = (key) => ((legStats ? 2 * legLen * legStats[key] : 0) + laps * place.lapM * lapStats[key]) / total;
  const sum = (key) => (legStats ? 2 * legStats[key] : 0) + laps * lapStats[key];
  // There and back along the same leg: what is climbed one way is descended the other.
  const legClimb = legStats ? legStats.gain + (legStats.loss || 0) : 0;
  const stats = {
    distance: total, distErr: Math.abs(total - D) / D, greenFrac: mix('greenFrac'), waterFrac: mix('waterFrac'), promFrac: mix('promFrac'),
    quietFrac: mix('quietFrac'), busyFrac: mix('busyFrac'), repeatFrac: leg ? legLen / total : 0, signals: sum('signals'), crossings: sum('crossings'),
    turns: sum('turns'), turnsPerKm: sum('turns') / (total / 1000), gain: legClimb + laps * lapStats.gain, loss: legClimb + laps * (lapStats.loss || 0), gainPerKm: (legClimb + laps * lapStats.gain) / (total / 1000), sights, sightsValue: 0,
    stopsPerKm: (sum('signals') + sum('crossings')) / (total / 1000), scenicFrac: mix('greenFrac'), roughFrac: mix('roughFrac'), stopsKnown: g.stopsKnown !== false,
  };
  const what = place.kind === 'track' ? `${laps} lap${laps > 1 ? 's' : ''} of the ${fmtKm(place.lapM)} track` : `${laps} loop${laps > 1 ? 's' : ''} of ${fmtKm(place.lapM)} inside the park`;
  const highlights = [what];
  if (leg) highlights.push(`${fmtKm(legLen)} to get there and back the same way`);
  else highlights.push(startNode < 0 ? 'No street found near your start: starts at the track' : placeNode < 0 ? `No way in found on the map: starts at ${place.name}` : `Starts at ${place.name}`);
  if (leg && total > 1.15 * D) highlights.push(`Longer than asked: the way there alone is ${fmtKm(legLen)}`);
  if (place.kind === 'track') highlights.push(leg && g.hasElevation ? climbText(stats) : 'Car-free and flat');
  else if (g.hasElevation) highlights.push(climbText(stats));
  highlights.push(stopsText(stats)); // the lights and crossings on the way there and back (none on the track itself)
  if (sights.length) highlights.push(`Passes ${sights.length} sight${sights.length > 1 ? 's' : ''}`);
  return {
    name: place.kind === 'track' ? `Laps at ${place.name}` : `${place.name} loop${laps > 1 ? 's' : ''}`,
    theme: place.kind === 'track' ? 'Track laps' : 'Park loops',
    heading: 0, distance: total, stats, score: 0, highlights, profile: [], latlngs, sights, cues,
    hasElevation: false, type: 'laps', turnaround: null, place: { kind: place.kind, name: place.name, lat: place.lat, lon: place.lon, laps, lapM: place.lapM },
  };
}
