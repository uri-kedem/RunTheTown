// Path network: nodes/edges built from OSM ways, with per-edge landscape
// attributes, a spatial index for snapping, and Dijkstra shortest paths.

import { haversine } from './geo.js';
import { STOP, stopKind, isBikeRoute, sidewalkKind } from './osm.js';

// Extra "virtual meters" for having to stop: a traffic light is worth a ~250 m
// detour, a crosswalk ~50 m. Runners hate stopping more than running a bit more.
export const STOP_COST = [0, 50, 250];

// Extra "virtual meters" for turning at a junction, so routes follow long
// straight streets and promenades instead of zig-zagging through a grid.
// A bend in a road with no choice (degree 2) costs nothing.
export const TURN_COST = { slight: 16, turn: 50, sharp: 120, uturn: 600 };

// Road classes, from most to least runner-friendly. TRUNK is an urban arterial
// (OSM highway=trunk with sidewalks, e.g. Route 90 through Eilat): kept so the
// network stays connected, but priced so routes only touch it when they must.
export const HW = { PATH: 0, STEPS: 1, LOCAL: 2, TERTIARY: 3, SECONDARY: 4, PRIMARY: 5, TRUNK: 6 };

// Promenades, esplanades, boardwalks, quays and boulevards, in a few languages.
const PROMENADE_NAME = /promenade|esplanade|boardwalk|tayelet|טיילת|\bquay\b|embankment|riverside|seafront|seawall|waterfront|strand\b|malec[oó]n|lungomare|passeig|paseo mar|corniche|boulevard|\bblvd|sderot|שדרות|\bavenue\b/i;
// 1 = a proper promenade or car-free street, 0.5 = a quiet street named like one.
function promenadeOf(tags) {
  const h = tags.highway;
  if (h === 'steps') return 0;
  if (h === 'pedestrian') return 1;
  const nm = `${tags['name:en'] || ''} ${tags.name || ''} ${tags.local || ''}`;
  // A car-free bike route (shared foot-and-bike path, cycleway open to walkers) is a made,
  // continuous path: along the water or through a park it is the promenade itself (see the
  // Graph constructor, which raises it to 1 there); elsewhere it is still a good run.
  const bike = tags.bike || isBikeRoute(h, tags.bicycle, tags.foot) ? 0.6 : 0;
  if (!PROMENADE_NAME.test(nm)) return bike;
  if (/^(footway|path|cycleway|track|living_street)$/.test(h)) return 1; // the walkway of a boulevard, a tayelet
  if (/^(residential|unclassified|road)$/.test(h)) return 0.5;
  return bike; // a busy road called "Avenue" is still a busy road
}

function highwayClass(tag) {
  if (/^(footway|path|pedestrian|track|cycleway|bridleway|living_street)$/.test(tag)) return HW.PATH;
  if (tag === 'steps') return HW.STEPS;
  if (/^tertiary/.test(tag)) return HW.TERTIARY;
  if (/^secondary/.test(tag)) return HW.SECONDARY;
  if (/^primary/.test(tag)) return HW.PRIMARY;
  if (/^trunk/.test(tag)) return HW.TRUNK;
  return HW.LOCAL;
}

export class Graph {
  constructor(osm, proj, grid, elev) {
    const idx = new Map();
    const lat = [];
    const lon = [];
    const ea = [];
    const eb = [];
    const ehw = [];
    const nodeIndex = (id) => {
      let i = idx.get(id);
      if (i === undefined) {
        const p = osm.nodes.get(id);
        if (!p) return -1;
        i = lat.length;
        idx.set(id, i);
        lat.push(p[0]);
        lon.push(p[1]);
      }
      return i;
    };
    const crossWays = []; // footway=crossing ways: [kind, node indices]
    const ename = [];
    const eprom = [];
    const erough = []; // 1 = a bare path of unknown surface (likely a trail), used only when nothing better exists
    const ebike = []; // 1 = part of a bike route (shared foot-and-bike path, cycleway open to walkers)
    this.names = []; // [{ name, local }], indexed by edge name id
    const nameIdx = new Map();
    let skippedWild = 0;
    let skippedClosed = 0;
    let skippedAfloat = 0;
    let noSidewalk = 0;
    // Where the town is, by the map itself: the nodes of small streets and footpaths, in
    // 60 m cells. A car road with none of these beside it runs through open country.
    const SMALL_RE = /^(residential|living_street|pedestrian|footway|path|cycleway|steps)$/;
    const smallCells = new Set();
    const cellKey = (x, y) => `${Math.floor(x / 60)}:${Math.floor(y / 60)}`;
    if (grid?.builtSum) {
      for (const road of osm.roads) {
        if (!SMALL_RE.test(road.tags.highway)) continue;
        for (const id of road.nodes) {
          const p = osm.nodes.get(id);
          if (p) {
            const [x, y] = proj.toXY(p[0], p[1]);
            smallCells.add(cellKey(x, y));
          }
        }
      }
    }
    const nearSmallStreet = (x, y) => {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (smallCells.has(cellKey(x + 60 * dx, y + 60 * dy))) return true;
      return false;
    };
    for (let road of osm.roads) {
      // A bare path (no surface tag) through woods or scrub is a dirt trail: not in the
      // network at all. Any way that runs mostly through closed ground (army base, railway
      // land, quarry, prison) is out too, and a small way (alley, footpath, service road)
      // inside a fenced compound (factory, hospital, school, campus) is a last resort.
      if (grid) {
        const small = /^(service|footway|path|cycleway|pedestrian|steps|living_street|residential|unclassified|road)$/.test(road.tags.highway);
        let cnt = 0;
        let wild = 0;
        let closed = 0;
        let compound = 0;
        let afloat = 0;
        let dock = 0;
        const canFloat = /^(footway|service|path|steps)$/.test(road.tags.highway); // pontoons, jetties, piers
        // A quay: a footway, service road or stairs hugging a marina basin (a promenade or
        // a named path past the marina is a different kind of way and stays).
        const canDock = /^(footway|service|steps|living_street)$/.test(road.tags.highway) && !PROMENADE_NAME.test(road.tags.name || '');
        for (const id of road.nodes) {
          const p = osm.nodes.get(id);
          if (!p) continue;
          const [x, y] = proj.toXY(p[0], p[1]);
          cnt++;
          if (grid.at('wild', x, y)) wild++;
          if (grid.at('closed', x, y)) closed++;
          if (grid.at('compound', x, y)) compound++;
          if (canFloat && grid.body && grid.deep('body', x, y)) afloat++;
          if (canDock && grid.at('dock', x, y)) dock++;
        }
        // A footway or service road that lies over the water is a marina pontoon, jetty or
        // pier: not a running route (a promenade along the edge keeps most nodes on land).
        if (cnt >= 2 && canFloat && afloat / cnt >= 0.6) {
          skippedAfloat++;
          continue;
        }
        if (cnt >= 2 && canDock && dock / cnt >= 0.6) {
          skippedAfloat++; // quays count with the pontoons
          continue;
        }
        if (cnt && road.tags.rough && wild / cnt >= 0.5) {
          skippedWild++;
          continue;
        }
        if (cnt && small && closed / cnt >= 0.5) {
          skippedClosed++;
          continue;
        }
        if (cnt && small && compound / cnt >= 0.5) road = { ...road, tags: { ...road.tags, rough: 1 } };
      }
      let cls = highwayClass(road.tags.highway);
      // A car road through open country has no sidewalk: outside a town — built-up share
      // from space under 20% around a node AND no side street or footpath within ~60 m of
      // it, for most of the road — a tertiary, secondary or primary road is priced as a
      // last resort (HW.TRUNK), kept only so a runner can cross a river or reach the next
      // quarter over the one bridge. Bridges keep their class.
      const sw = sidewalkKind(road.tags); // the map's own word, where the tag exists
      if (sw === 'no' && cls >= HW.TERTIARY && cls < HW.TRUNK && !(road.tags.bridge && road.tags.bridge !== 'no')) {
        cls = HW.TRUNK;
        noSidewalk++;
      } else if (sw !== 'yes' && grid?.builtSum && cls >= HW.TERTIARY && cls < HW.TRUNK && !(road.tags.bridge && road.tags.bridge !== 'no')) {
        let out = 0, cnt = 0;
        for (const id of road.nodes) {
          const p = osm.nodes.get(id);
          if (!p) continue;
          const [x, y] = proj.toXY(p[0], p[1]);
          cnt++;
          if (grid.townShare(x, y) < 0.2 && !nearSmallStreet(x, y)) out++;
        }
        if (cnt && out / cnt >= 0.6) {
          cls = HW.TRUNK;
          noSidewalk++;
        }
      }
      let nid = -1;
      const nm = road.tags['name:en'] || road.tags.name;
      if (nm) {
        const key = nm;
        nid = nameIdx.get(key);
        if (nid === undefined) {
          nid = this.names.length;
          nameIdx.set(key, nid);
          this.names.push({ name: nm, local: road.tags.local || road.tags.name || nm });
        }
      }
      const rough = road.tags.rough ? 1 : 0;
      const prom = rough ? 0 : promenadeOf(road.tags);
      const bike = !rough && (road.tags.bike || isBikeRoute(road.tags.highway, road.tags.bicycle, road.tags.foot)) ? 1 : 0;
      const isCrossing = road.tags.footway === 'crossing' || road.tags.cycleway === 'crossing';
      const crossNodes = isCrossing ? [] : null;
      let prev = -1;
      for (const id of road.nodes) {
        const cur = nodeIndex(id);
        if (crossNodes && cur >= 0) crossNodes.push(cur);
        if (cur >= 0 && prev >= 0 && cur !== prev) {
          ea.push(prev);
          eb.push(cur);
          ehw.push(cls);
          ename.push(nid);
          eprom.push(prom);
          erough.push(rough);
          ebike.push(bike);
        }
        prev = cur;
      }
      if (crossNodes) crossWays.push([stopKind(road.tags) || STOP.CROSSING, crossNodes]);
    }

    const n = lat.length;
    const m = ea.length;
    this.n = n;
    this.m = m;
    this.skippedWild = skippedWild; // bare paths left out for running through open country
    this.skippedClosed = skippedClosed; // ways left out for running through closed ground
    this.skippedAfloat = skippedAfloat; // pontoons, jetties and piers left out (over the water)
    this.noSidewalk = noSidewalk; // country roads priced as a last resort (no sidewalk)
    this.lat = Float64Array.from(lat);
    this.lon = Float64Array.from(lon);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [x, y] = proj.toXY(lat[i], lon[i]);
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = elev ? elev.at(x, y) : 0;
    }
    this.hasElevation = !!elev;
    this.ea = Int32Array.from(ea);
    this.eb = Int32Array.from(eb);
    this.hw = Uint8Array.from(ehw);
    this.edgeName = Int32Array.from(ename);
    this.len = new Float32Array(m);
    this.green = new Float32Array(m);
    this.water = new Float32Array(m);
    this.sea = new Float32Array(m); // by the sea (beach, seaside promenade): the best water there is
    // Smooth running: promenades, esplanades, boardwalks, boulevard walkways,
    // pedestrian streets, and car-free paths along the water or through parks.
    this.prom = Float32Array.from(eprom);
    this.rough = Uint8Array.from(erough);
    this.bike = Uint8Array.from(ebike); // bike routes: continuous made paths (promenades, park paths)
    this.nodeRough = new Uint8Array(n).fill(1); // 1 = the node sits on bare paths only (start points avoid these)
    for (let e = 0; e < m; e++) if (!erough[e]) this.nodeRough[ea[e]] = this.nodeRough[eb[e]] = 0;
    for (let e = 0; e < m; e++) {
      const a = ea[e];
      const b = eb[e];
      this.len[e] = Math.max(0.5, haversine(lat[a], lon[a], lat[b], lon[b]));
      if (grid) {
        let g = 0;
        let w = 0;
        let sea = 0;
        for (const t of [0.15, 0.5, 0.85]) {
          const px = this.x[a] + (this.x[b] - this.x[a]) * t;
          const py = this.y[a] + (this.y[b] - this.y[a]) * t;
          g += grid.at('green', px, py);
          w += grid.at('water', px, py);
          sea += grid.at('sea', px, py);
        }
        this.green[e] = g / 3;
        this.water[e] = Math.max(w, sea) / 3;
        this.sea[e] = sea / 3;
        if (ehw[e] === HW.PATH && !erough[e]) {
          // A bike route along the water or through a park is the promenade / park path itself.
          const bike = ebike[e] && (this.water[e] >= 0.5 || this.green[e] >= 0.5) ? 1 : 0;
          this.prom[e] = Math.max(this.prom[e], this.water[e] >= 0.5 ? 1 : 0, this.green[e] >= 0.5 ? 0.7 : 0, bike);
        }
      }
    }

    // CSR adjacency.
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      deg[ea[e] + 1]++;
      deg[eb[e] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjNode = new Int32Array(2 * m);
    this.adjEdge = new Int32Array(2 * m);
    this.adjFwd = new Uint8Array(2 * m);
    const fill = deg.slice(0, n);
    for (let e = 0; e < m; e++) {
      let k = fill[ea[e]]++;
      this.adjNode[k] = eb[e];
      this.adjEdge[k] = e;
      this.adjFwd[k] = 1;
      k = fill[eb[e]]++;
      this.adjNode[k] = ea[e];
      this.adjEdge[k] = e;
      this.adjFwd[k] = 0;
    }

    // Heading of each arc (tail -> head), for turn costs.
    this.arcHead = new Float32Array(2 * m);
    for (let u = 0; u < n; u++) {
      for (let k = deg[u]; k < deg[u + 1]; k++) {
        const v = this.adjNode[k];
        this.arcHead[k] = (Math.atan2(this.x[v] - this.x[u], this.y[v] - this.y[u]) * 180) / Math.PI;
      }
    }

    this.buildSpatialIndex();
    this.attachSights(osm.sights || [], proj);
    this.computeStops(osm.stops || new Map(), idx, crossWays, osm.stopPoints || [], proj);
    this.labelComponents();
    this.stopWeight = 1;
    this.turnWeight = 1;

    this.costF = new Float32Array(m).fill(1);
    this.costB = new Float32Array(m).fill(1);
    this.penalty = new Float32Array(m).fill(1);
    // Search state lives on arcs (u -> v), so the cost of a path can depend on
    // how it turns at each junction.
    this.dist = new Float64Array(2 * m);
    this.prevArc = new Int32Array(2 * m);
    this.stamp = new Uint32Array(2 * m);
    this.nodeStamp = new Uint32Array(n);
    this.nodePrev = new Int32Array(n);
    this.curStamp = 0;
    this.heap = new MinHeap(4096);
  }

  degree(v) {
    return this.adjStart[v + 1] - this.adjStart[v];
  }

  // Virtual meters for continuing from arc kIn (into node v) along arc kOut (out of v).
  turnCost(kIn, kOut) {
    const v = this.adjNode[kIn];
    const deg = this.adjStart[v + 1] - this.adjStart[v];
    if (this.adjEdge[kOut] === this.adjEdge[kIn]) return deg === 1 ? 0 : TURN_COST.uturn * this.turnWeight;
    if (deg < 3) return 0;
    let a = this.arcHead[kOut] - this.arcHead[kIn];
    if (a > 180) a -= 360;
    else if (a < -180) a += 360;
    const abs = a < 0 ? -a : a;
    if (abs < 30) return 0;
    const c = abs < 60 ? TURN_COST.slight : abs < 135 ? TURN_COST.turn : TURN_COST.sharp;
    return c * this.turnWeight;
  }

  // Works out, for every arc (u -> v), whether arriving at v means stopping:
  //  - traffic light: when coming off a sidewalk/crossing, or at a junction
  //    (a mid-block pedestrian light doesn't stop someone running along the road);
  //  - crosswalk: only when actually crossing (arriving via a footway/crossing),
  //    not when running along the road past a zebra;
  //  - unmarked junction with a busy road, entered from a smaller street: likely a crossing.
  computeStops(stopsById, idx, crossWays, stopPoints = [], proj = null) {
    const n = this.n;
    const stop = new Uint8Array(n);
    for (const [id, kind] of stopsById) {
      const i = idx.get(id);
      if (i !== undefined) stop[i] = Math.max(stop[i], kind);
    }
    // Stops given by position (vector-tile mode): match to the street point within 4 m.
    for (const [la, lo, kind] of stopPoints) {
      const [x, y] = proj.toXY(la, lo);
      const i = this.nearest(x, y, { maxDist: 4 });
      if (i >= 0) stop[i] = Math.max(stop[i], kind);
    }
    const onRoad = new Uint8Array(n);
    const busy = new Uint8Array(n);
    for (let e = 0; e < this.m; e++) {
      const h = this.hw[e];
      if (h >= HW.LOCAL) onRoad[this.ea[e]] = onRoad[this.eb[e]] = 1;
      if (h >= HW.SECONDARY) busy[this.ea[e]] = busy[this.eb[e]] = 1;
    }
    // Crossing ways whose road node isn't tagged: the crossing is where they meet the road.
    for (const [kind, nodes] of crossWays) {
      for (const v of nodes) if (onRoad[v] && stop[v] < kind) stop[v] = kind;
    }
    this.stop = stop;
    this.arcKind = new Uint8Array(2 * this.m);
    this.arcStop = new Float32Array(2 * this.m);
    for (let u = 0; u < n; u++) {
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const v = this.adjNode[k];
        const h = this.hw[this.adjEdge[k]];
        const fromPath = h === HW.PATH || h === HW.STEPS;
        const junction = this.adjStart[v + 1] - this.adjStart[v] >= 3;
        let kind = STOP.NONE;
        if (stop[v] === STOP.SIGNAL) kind = fromPath || junction ? STOP.SIGNAL : STOP.NONE;
        else if (stop[v] === STOP.CROSSING) kind = fromPath ? STOP.CROSSING : STOP.NONE;
        else if (busy[v] && junction && h < HW.SECONDARY) kind = STOP.CROSSING;
        this.arcKind[k] = kind;
        this.arcStop[k] = STOP_COST[kind];
      }
    }
  }

  // Landmarks, each tied to the nearest walkable point within 120 m.
  attachSights(sights, proj) {
    this.sights = [];
    for (const s of sights) {
      const [x, y] = proj.toXY(s.lat, s.lon);
      const node = this.nearest(x, y, { maxDist: 120 });
      if (node >= 0) this.sights.push({ ...s, x, y, node });
    }
  }

  // Stop kind when running from u to v along edge e.
  stopOnArc(u, e, v) {
    for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
      if (this.adjEdge[k] === e && this.adjNode[k] === v) return this.arcKind[k];
    }
    return 0;
  }

  labelComponents() {
    const comp = new Int32Array(this.n).fill(-1);
    const sizes = [];
    const stack = [];
    for (let s = 0; s < this.n; s++) {
      if (comp[s] >= 0) continue;
      const id = sizes.length;
      let size = 0;
      comp[s] = id;
      stack.push(s);
      while (stack.length) {
        const u = stack.pop();
        size++;
        for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
          const v = this.adjNode[k];
          if (comp[v] < 0) {
            comp[v] = id;
            stack.push(v);
          }
        }
      }
      sizes.push(size);
    }
    this.comp = comp;
    this.compSize = sizes;
  }

  buildSpatialIndex(cell = 100) {
    this.sCell = cell;
    this.sIndex = new Map();
    for (let i = 0; i < this.n; i++) {
      const key = this.cellKey(Math.floor(this.x[i] / cell), Math.floor(this.y[i] / cell));
      let list = this.sIndex.get(key);
      if (!list) this.sIndex.set(key, (list = []));
      list.push(i);
    }
  }

  cellKey(cx, cy) {
    return cx * 100003 + cy;
  }

  // Best node near (x, y). `scoreFn(node, dist)` returns a cost; lower wins.
  nearest(x, y, { maxDist = 600, filter = null, scoreFn = null } = {}) {
    const cell = this.sCell;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const ring = Math.ceil(maxDist / cell);
    let best = -1;
    let bestScore = Infinity;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const list = this.sIndex.get(this.cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (const i of list) {
          if (filter && !filter(i)) continue;
          const d = Math.hypot(this.x[i] - x, this.y[i] - y);
          if (d > maxDist) continue;
          const s = scoreFn ? scoreFn(i, d) : d;
          if (s < bestScore) {
            bestScore = s;
            best = i;
          }
        }
      }
    }
    return best;
  }

  // Cost of running along arc k (length x preference cost x reuse penalty, plus any stop).
  arcCost(k) {
    const e = this.adjEdge[k];
    return this.len[e] * (this.adjFwd[k] ? this.costF[e] : this.costB[e]) * this.penalty[e] + this.arcStop[k] * this.stopWeight;
  }

  /**
   * Dijkstra from src to dst over costF/costB * penalty + stops + turns.
   * `fromArc` is the arc the runner arrived at src on (so the first turn counts).
   * Returns { nodes, edges, lastArc } or null.
   */
  shortestPath(src, dst, { fromArc = -1 } = {}) {
    if (src === dst) return { nodes: [src], edges: [], lastArc: fromArc };
    const stampV = ++this.curStamp;
    const { dist, prevArc, stamp, heap, adjStart, adjNode } = this;
    heap.clear();
    for (let k = adjStart[src]; k < adjStart[src + 1]; k++) {
      const c = this.arcCost(k) + (fromArc >= 0 ? this.turnCost(fromArc, k) : 0);
      stamp[k] = stampV;
      dist[k] = c;
      prevArc[k] = -1;
      heap.push(c, k);
    }
    let found = -1;
    while (heap.size) {
      const d = heap.topKey();
      const k = heap.pop();
      if (d > dist[k]) continue;
      const v = adjNode[k];
      if (v === dst) {
        found = k;
        break;
      }
      for (let k2 = adjStart[v]; k2 < adjStart[v + 1]; k2++) {
        const nd = d + this.arcCost(k2) + this.turnCost(k, k2);
        if (stamp[k2] !== stampV || nd < dist[k2]) {
          stamp[k2] = stampV;
          dist[k2] = nd;
          prevArc[k2] = k;
          heap.push(nd, k2);
        }
      }
    }
    if (found < 0) return null;
    const nodes = [dst];
    const edges = [];
    let k = found;
    while (k >= 0) {
      const e = this.adjEdge[k];
      edges.push(e);
      nodes.push(this.other(e, nodes[nodes.length - 1]));
      k = prevArc[k];
    }
    nodes.reverse();
    edges.reverse();
    return { nodes, edges, lastArc: found };
  }

  // Full Dijkstra tree from src (same costs as shortestPath). Returns the nodes
  // in settling order and, per node, the arc it was first reached by.
  shortestTree(src) {
    const stampV = ++this.curStamp;
    const { dist, prevArc, stamp, heap, adjStart, adjNode, nodeStamp, nodePrev } = this;
    heap.clear();
    nodeStamp[src] = stampV;
    nodePrev[src] = -1;
    const order = [src];
    for (let k = adjStart[src]; k < adjStart[src + 1]; k++) {
      const c = this.arcCost(k);
      stamp[k] = stampV;
      dist[k] = c;
      prevArc[k] = -1;
      heap.push(c, k);
    }
    while (heap.size) {
      const d = heap.topKey();
      const k = heap.pop();
      if (d > dist[k]) continue;
      const v = adjNode[k];
      if (nodeStamp[v] !== stampV) {
        nodeStamp[v] = stampV;
        nodePrev[v] = k;
        order.push(v);
      }
      for (let k2 = adjStart[v]; k2 < adjStart[v + 1]; k2++) {
        const nd = d + this.arcCost(k2) + this.turnCost(k, k2);
        if (stamp[k2] !== stampV || nd < dist[k2]) {
          stamp[k2] = stampV;
          dist[k2] = nd;
          prevArc[k2] = k;
          heap.push(nd, k2);
        }
      }
    }
    return { order, prevArc: nodePrev.slice() };
  }

  other(e, v) {
    return this.ea[e] === v ? this.eb[e] : this.ea[e];
  }

  // Edge joining two adjacent nodes (cheapest by length if parallel edges exist).
  edgeBetween(u, v) {
    let best = -1;
    for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
      if (this.adjNode[k] === v && (best < 0 || this.len[this.adjEdge[k]] < this.len[best])) best = this.adjEdge[k];
    }
    return best;
  }
}

class MinHeap {
  constructor(cap) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.size = 0;
  }
  clear() {
    this.size = 0;
  }
  topKey() {
    return this.keys[0];
  }
  push(key, val) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.size++;
    const { keys, vals } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const val = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}
