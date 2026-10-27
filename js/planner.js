// Loop planner: designs candidate loops in many directions, fits each to the
// target distance, scores them against the runner's preferences and returns
// the best few distinct options.

import { HW } from './graph.js';
import { bearingName, bearingNameFine } from './geo.js';
import { buildCues } from './cues.js';

const BASE_COST = [0.85, 2.5, 1.0, 1.25, 1.6, 2.2, 3.2]; // by HW class (path, steps, local, tertiary, secondary, primary, trunk)
const QUIET_COST = [0.7, 2.5, 0.95, 1.6, 2.4, 3.5, 5.0];
// A bare path with no surface tag (most likely a dirt trail) counts as three times its
// length, so it is only ever used when there is no made surface to run on at all.
export const ROUGH_COST = 3;

export function applyPreferences(g, { prefs = {}, terrain = 'any' }) {
  const table = prefs.quiet ? QUIET_COST : BASE_COST;
  g.stopWeight = prefs.avoidStops === false ? 0 : 1; // avoid lights & crosswalks (on by default)
  for (let e = 0; e < g.m; e++) {
    let c = table[g.hw[e]];
    if (g.rough[e]) c = BASE_COST[HW.PATH] * ROUGH_COST; // no landscape bonus can make a trail attractive
    else {
      // Parks and waterfronts always pull the route in (more when asked for);
      // promenades, boardwalks and park paths most of all: they are the point of the app.
      c *= 1 - (prefs.green ? 0.5 : 0.25) * g.green[e];
      c *= 1 - (prefs.water ? 0.55 : 0.25) * g.water[e];
      c *= 1 - 0.3 * g.sea[e]; // the seaside beats a river bank or a lake shore
      c *= 1 - 0.45 * g.prom[e];
    }
    let f = c;
    let b = c;
    if (g.hasElevation && terrain !== 'any') {
      const grade = (g.z[g.eb[e]] - g.z[g.ea[e]]) / g.len[e];
      if (terrain === 'flat') {
        const k = 1 + 15 * Math.abs(grade);
        f *= k;
        b *= k;
      } else {
        // Hilly: reward climbing (whichever direction goes up).
        if (grade > 0) f *= Math.max(0.45, 1 - 10 * grade);
        else b *= Math.max(0.45, 1 + 10 * grade);
      }
    }
    g.costF[e] = f;
    g.costB[e] = b;
  }
}

// How much the seaside lifts a route: full credit once ~30% of it runs by the sea
// (a 10 km run with 3 km of beach promenade), so it beats a run along a river bank.
export function seaBoost(seaFrac) {
  return 1.2 * Math.min(1, seaFrac / 0.3);
}

function nodeAttrs(g) {
  if (g._nodeGreen) return;
  g._nodeGreen = new Float32Array(g.n);
  g._nodeWater = new Float32Array(g.n);
  g._nodeProm = new Float32Array(g.n);
  g._nodeSea = new Float32Array(g.n);
  for (let e = 0; e < g.m; e++) {
    for (const v of [g.ea[e], g.eb[e]]) {
      g._nodeGreen[v] = Math.max(g._nodeGreen[v], g.green[e]);
      g._nodeWater[v] = Math.max(g._nodeWater[v], g.water[e]);
      g._nodeSea[v] = Math.max(g._nodeSea[v], g.sea[e]);
      g._nodeProm[v] = Math.max(g._nodeProm[v], g.prom[e]);
    }
  }
}

const sleep = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param g        Graph (preferences already applied with applyPreferences)
 * @param opts     { startXY: [x, y], distance: meters, prefs, terrain, count, bearings, onProgress }
 */
export async function planLoops(g, opts) {
  const { startXY, distance: D, prefs = {}, terrain = 'any', count = 3, bearings = 10, onProgress } = opts;
  nodeAttrs(g);

  const maxComp = Math.max(...g.compSize);
  // The start goes on the nearest street or made path; a bare path (unknown surface)
  // is used only when nothing better lies within ~250 m more.
  const start = g.nearest(startXY[0], startXY[1], {
    maxDist: 800,
    filter: (i) => g.compSize[g.comp[i]] >= Math.min(300, maxComp * 0.5),
    scoreFn: (i, d) => d + (g.nodeRough[i] ? 250 : 0),
  });
  if (start < 0) throw new Error('No runnable paths found near the start point. Try moving the pin onto a street.');
  const comp = g.comp[start];

  const snapScore = (i, d) =>
    d - (prefs.green ? 160 * g._nodeGreen[i] : 0) - (prefs.water ? 160 * g._nodeWater[i] : 0) - 120 * g._nodeProm[i];
  const sx = g.x[start];
  const sy = g.y[start];

  // Two families of candidates: round loops in evenly spaced directions, and
  // loops stretched toward attractive places (water/parks) within reach.
  const jobs = [];
  for (let b = 0; b < bearings; b++) jobs.push({ bearing: (360 / bearings) * b, dir: b % 2 ? 1 : -1 });
  const anchors = findAnchors(g, { start, comp, D, prefs });
  for (const [k, anchor] of anchors.filter((a) => a.band === 0).entries()) {
    jobs.push({ anchor, dir: k % 2 ? 1 : -1 });
  }
  // Triangles through two attractive points, so the loop can run *along* a
  // river or park rather than just touching it.
  const pairs = [];
  const seenPairs = new Set();
  for (let i = 0; i < anchors.length; i++) {
    for (let j = 0; j < anchors.length; j++) {
      if (i === j || anchors[i].sector === anchors[j].sector) continue;
      const A = anchors[i];
      const B = anchors[j];
      const est = 1.25 * (A.d + B.d) + 1.05 * Math.hypot(A.dx - B.dx, A.dy - B.dy);
      const cross = A.dx * B.dy - A.dy * B.dx;
      if (cross < 0) continue; // each unordered pair once, in one direction
      const key = A.node + ':' + B.node;
      if (seenPairs.has(key) || A.node === B.node) continue;
      seenPairs.add(key);
      if (Math.abs(est - D) / D < 0.15) pairs.push({ pair: [A.node, B.node], est: Math.abs(est - D) });
    }
  }
  pairs.sort((p, q) => p.est - q.est);
  for (const p of pairs.slice(0, 20)) jobs.push(p);

  const candidates = [];
  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    let cand;
    if (job.pair) {
      const route = routeThrough(g, [start, ...job.pair, start]);
      if (route) {
        const err = Math.abs(route.length - D) / D;
        if (err < 0.1) cand = { ...route, err };
      }
    } else {
      cand = fitLoop(g, { start, sx, sy, comp, D, snapScore, ...job });
    }
    if (cand) candidates.push(cand);
    onProgress?.((j + 1) / jobs.length);
    await sleep();
  }
  // A town hemmed in by sea, desert or a border (Eilat, say) may fit no round loop
  // of this size, while a long thin loop along its main axis fits fine: try those
  // before giving up on loops altogether.
  if (candidates.length < count) {
    for (let b = 0; b < bearings; b++) {
      const cand = fitLoop(g, { start, sx, sy, comp, D, snapScore, bearing: (360 / bearings) * b + 180 / bearings, dir: b % 2 ? 1 : -1, thin: true });
      if (cand) candidates.push(cand);
      await sleep();
    }
  }
  if (prefs.sights) {
    onProgress?.(1);
    candidates.push(...(await sightseeingTours(g, { start, comp, D })));
  }
  const outbacks = outAndBacks(g, { start, D, prefs, terrain });
  // Promenade loops: the scenic way out, then a different scenic way back (the other
  // bank of the river, the parallel park path) — a loop where a there-and-back was the
  // only landscape run before.
  candidates.push(...(await promenadeLoops(g, { start, D, prefs, terrain })));
  if (!candidates.length && !outbacks.length) {
    throw new Error("Couldn't build a route here. Try a shorter distance or another start point.");
  }

  for (const c of candidates) {
    c.stats = routeStats(g, c, D, prefs);
    c.score = scoreRoute(c.stats, prefs, terrain);
  }
  candidates.sort((a, b) => b.score - a.score);

  // Option 1 is the promenade run: of every loop and there-and-back, the one with the
  // most promenade, boardwalk, park path and waterfront under its feet (loops win ties;
  // a there-and-back is fine when that is where the promenade is). Then the best
  // distinct loops fill the remaining slots, so the runner always gets `count` options.
  const chosen = [];
  const promenadeOf = (r) => {
    const s = r.stats;
    // With a landscape picked, that landscape counts as much as the promenade itself.
    const landscape = prefs.water ? s.waterFrac : prefs.green ? s.greenFrac : 0.5 * Math.max(s.waterFrac, s.greenFrac);
    // The seaside counts on top: when the beach is within reach, that is the run to offer,
    // even with a few plain kilometres to get there (Ramat Aviv: the Yarkon is 1 km
    // away, the sea 3 km — the beach promenade is the run).
    return s.promFrac + landscape + seaBoost(s.seaFrac) - (r.type === 'outback' ? 0.08 : 0);
  };
  const pool = [...candidates, ...outbacks].filter((r) => r.stats.distErr <= 0.08);
  // Landscape runs only: when any run keeps LANDSCAPE_SHARE of its length on park paths,
  // boardwalks and promenades, nothing else is offered — a run that is 80% streets is no
  // fun, even if it touches the beach. Fewer than `count` options is fine then.
  const scenicPool = prefs.sights ? [] : pool.filter((r) => r.stats.promFrac >= LANDSCAPE_SHARE).sort((a, b) => promenadeOf(b) - promenadeOf(a));
  if (scenicPool.length) {
    for (const limit of [0.5, 0.7]) {
      for (const r of scenicPool) {
        if (chosen.length >= count) break;
        if (!chosen.includes(r) && chosen.every((o) => overlap(g, r, o) < limit)) chosen.push(r);
      }
    }
    return finish(g, chosen, start, prefs);
  }
  const promenade = pool.slice().sort((a, b) => promenadeOf(b) - promenadeOf(a))[0];
  if (promenade && promenadeOf(promenade) >= 0.25 && !prefs.sights) chosen.push(promenade); // a tour is ranked by its landmarks instead
  for (const limit of [0.45, 0.7, 1.01]) {
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.includes(c)) continue;
      if (chosen.every((o) => overlap(g, c, o) < limit)) chosen.push(c);
    }
  }
  for (const o of outbacks) {
    if (chosen.length >= count) break;
    if (!chosen.includes(o) && chosen.every((c) => overlap(g, o, c) < 0.7)) chosen.push(o);
  }
  if (!chosen.length) chosen.push(...outbacks.slice(0, count));
  // Order: the promenade run first, then by score.
  chosen.sort((a, b) => (chosen[0] === promenade && (a === promenade || b === promenade) ? (a === promenade ? -1 : 1) : b.score - a.score));
  return finish(g, chosen, start, prefs);
}

// A run is a landscape run when this share of it is park path, boardwalk or promenade.
export const LANDSCAPE_SHARE = 0.6;

function finish(g, chosen, start, prefs) {
  const out = chosen.map((c) => describe(g, c, start, prefs));
  // Keep names distinct: fall back to a finer compass direction, then a suffix.
  const used = new Set();
  for (const r of out) {
    if (used.has(r.name)) r.name = `${r.theme} to the ${bearingNameFine(r.heading)}`;
    if (used.has(r.name)) r.name += ' (alt)';
    used.add(r.name);
  }
  return out;
}

// There-and-back routes: follow the most scenic path out to a turnaround point
// at half the distance, then return the same way. Uses one full Dijkstra tree
// (preference-weighted), measuring real length and scenic length along it.
function outAndBacks(g, { start, D, prefs, terrain, count = 3 }) {
  const { order, prevArc } = g.shortestTree(start);
  const L = new Float64Array(g.n);
  const S = new Float64Array(g.n);
  const Sea = new Float64Array(g.n);
  const half = D / 2;
  const cands = [];
  for (const u of order) {
    if (u === start) continue;
    const e = g.adjEdge[prevArc[u]];
    const p = g.other(e, u);
    L[u] = L[p] + g.len[e];
    S[u] = S[p] + g.len[e] * scenicOf(g, e, prefs);
    Sea[u] = Sea[p] + g.len[e] * g.sea[e];
    if (Math.abs(L[u] - half) <= 0.0125 * D) cands.push(u);
  }
  // Most scenic first; a turnaround on the seaside ranks above any river or park bank.
  const rank = (u) => S[u] / L[u] + seaBoost(Sea[u] / L[u]);
  cands.sort((a, b) => rank(b) - rank(a));

  const picked = [];
  const sectorsUsed = new Set();
  for (const u of cands) {
    if (picked.length >= count) break;
    const sector = Math.round(
      ((Math.atan2(g.x[u] - g.x[start], g.y[u] - g.y[start]) * 180) / Math.PI + 360) / 45,
    ) % 8;
    if (sectorsUsed.has(sector)) continue;
    const out = [u];
    while (out[out.length - 1] !== start) {
      const v = out[out.length - 1];
      out.push(g.other(g.adjEdge[prevArc[v]], v));
    }
    out.reverse(); // start ... turnaround
    const nodes = out.concat(out.slice(0, -1).reverse());
    const edges = [];
    let length = 0;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const e = g.edgeBetween(nodes[i], nodes[i + 1]);
      edges.push(e);
      length += g.len[e];
    }
    const route = { nodes, edges, length, type: 'outback', turnaround: u };
    if (picked.some((o) => overlap(g, route, o) > 0.5)) continue;
    route.stats = routeStats(g, route, D, prefs);
    if (route.stats.roughFrac > 0.1 || route.stats.trunkFrac > 0.1) continue; // not a there-and-back on a trail of unknown surface or along an arterial
    route.score = scoreRoute({ ...route.stats, repeatFrac: 0 }, prefs, terrain);
    sectorsUsed.add(sector);
    picked.push(route);
  }
  return picked;
}

// Loops made of a scenic leg out (the out-and-back tree) and a different way back:
// turnarounds a little short of half the distance, in every direction, the outbound
// edges priced ×4 for the return. Kept when the loop fits the distance, repeats little
// and stays a landscape run (LANDSCAPE_SHARE of promenade / park path).
async function promenadeLoops(g, { start, D, prefs, terrain, perSector = 3, maxLoops = 4 }) {
  const { order, prevArc } = g.shortestTree(start);
  const L = new Float64Array(g.n);
  const S = new Float64Array(g.n);
  const Sea = new Float64Array(g.n);
  const bySector = new Map();
  for (const u of order) {
    if (u === start) continue;
    const e = g.adjEdge[prevArc[u]];
    const p = g.other(e, u);
    L[u] = L[p] + g.len[e];
    S[u] = S[p] + g.len[e] * scenicOf(g, e, prefs);
    Sea[u] = Sea[p] + g.len[e] * g.sea[e];
    // The way back is usually a little longer than the way out (it is the second choice).
    if (L[u] < 0.4 * D || L[u] > 0.5 * D) continue;
    if (S[u] / L[u] < LANDSCAPE_SHARE) continue; // only a scenic leg out can make a landscape loop
    const sector = Math.round(((Math.atan2(g.x[u] - g.x[start], g.y[u] - g.y[start]) * 180) / Math.PI + 360) / 45) % 8;
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(u);
  }
  const rank = (u) => S[u] / L[u] + seaBoost(Sea[u] / L[u]);
  const loops = [];
  for (const [, us] of bySector) {
    us.sort((a, b) => rank(b) - rank(a));
    let tried = 0;
    for (let k = 0; k < us.length && tried < perSector; k++) {
      const u = us[k];
      // Spread the tries along the leg: skip turnarounds within 5% of D of one already tried.
      if (us.slice(0, k).some((v) => tried && Math.abs(L[v] - L[u]) < 0.05 * D)) continue;
      tried++;
      const out = [u];
      while (out[out.length - 1] !== start) out.push(g.other(g.adjEdge[prevArc[out[out.length - 1]]], out[out.length - 1]));
      out.reverse();
      const outEdges = [];
      for (let i = 0; i + 1 < out.length; i++) outEdges.push(g.edgeBetween(out[i], out[i + 1]));
      const saved = outEdges.map((e) => g.penalty[e]);
      for (const e of outEdges) g.penalty[e] *= 4;
      const back = g.shortestPath(u, start, { fromArc: -1 });
      outEdges.forEach((e, i) => (g.penalty[e] = saved[i]));
      if (!back) continue;
      const nodes = out.concat(back.nodes.slice(1));
      const edges = outEdges.concat(back.edges);
      let length = 0;
      for (const e of edges) length += g.len[e];
      if (Math.abs(length - D) / D > 0.08) continue;
      const route = { nodes, edges, length, type: 'loop', turnaround: u };
      route.stats = routeStats(g, route, D, prefs);
      if (route.stats.repeatFrac > 0.25 || route.stats.promFrac < LANDSCAPE_SHARE || route.stats.roughFrac > 0.1 || route.stats.trunkFrac > 0.1) continue;
      if (loops.some((o) => overlap(g, route, o) > 0.6)) continue;
      route.score = scoreRoute(route.stats, prefs, terrain);
      loops.push(route);
      if (loops.length >= maxLoops) return loops;
      await sleep();
    }
  }
  return loops;
}

// Attractive nodes (water or green, per preferences) that a loop of length D can
// reach: one per compass sector and distance band (band 0 ≈ 0.28·D away is
// used for single-anchor loops; all bands feed the two-anchor triangles).
function findAnchors(g, { start, comp, D, prefs }) {
  const sx = g.x[start];
  const sy = g.y[start];
  const ideals = [0.28 * D, 0.12 * D, 0.16 * D, 0.2 * D, 0.24 * D, 0.32 * D, 0.36 * D];
  const slots = new Array(8 * ideals.length).fill(null);
  for (let i = 0; i < g.n; i++) {
    if (g.comp[i] !== comp) continue;
    // Promenades, waterfronts and parks always draw loops toward them (a little more when asked for).
    const attr = Math.max(g._nodeWater[i] * (prefs.water ? 1 : 0.85), g._nodeGreen[i] * (prefs.green ? 1 : 0.85), g._nodeProm[i] >= 1 ? 1 : 0);
    if (attr < 0.66) continue;
    const dx = g.x[i] - sx;
    const dy = g.y[i] - sy;
    const d = Math.hypot(dx, dy);
    if (d < 0.1 * D || d > 0.4 * D) continue;
    const sector = Math.floor(((Math.atan2(dx, dy) / (2 * Math.PI) + 1) % 1) * 8);
    const seaBonus = g._nodeSea[i] >= 0.66 ? 0.1 * D : 0; // the seaside wins its slot over a river or park nearby
    for (let band = 0; band < ideals.length; band++) {
      const score = Math.abs(d - ideals[band]) - seaBonus;
      const k = sector * ideals.length + band;
      if (!slots[k] || score < slots[k].score) slots[k] = { node: i, score, d, dx, dy, sector, band };
    }
  }
  return slots.filter(Boolean);
}

// Fits a 4-point loop (start, side, far, side) to distance D. Without an anchor
// the shape is a square whose size is tuned; with an anchor the far point is
// pinned to it and only the loop's width is tuned.
function fitLoop(g, { start, sx, sy, comp, bearing, anchor, dir, D, snapScore, thin = false }) {
  let ux, uy, a, b;
  const P = D / 1.25; // ~25% road detour over straight lines
  if (thin) {
    // A long, narrow loop along one direction: out on one street, back on a parallel one.
    // Perimeter ≈ 4·√(a² + b²); with b = a/5 that gives a ≈ P/4.08.
    const rad = (bearing * Math.PI) / 180;
    ux = Math.sin(rad);
    uy = Math.cos(rad);
    a = P / 4.08;
    b = a / 5;
  } else if (anchor) {
    a = anchor.d / 2;
    ux = anchor.dx / anchor.d;
    uy = anchor.dy / anchor.d;
    b = Math.sqrt(Math.max((P / 4) ** 2 - a * a, (0.2 * a) ** 2));
    bearing = (Math.atan2(ux, uy) * 180) / Math.PI;
  } else {
    const rad = (bearing * Math.PI) / 180;
    ux = Math.sin(rad);
    uy = Math.cos(rad);
    a = b = P / 5.657; // square inscribed in a circle
  }
  const px = -uy * dir;
  const py = ux * dir;
  let best = null;

  for (let iter = 0; iter < 6; iter++) {
    const cx = sx + ux * a;
    const cy = sy + uy * a;
    const targets = [
      [cx + px * b, cy + py * b],
      anchor ? null : [cx + ux * a, cy + uy * a],
      [cx - px * b, cy - py * b],
    ];
    const waypoints = [start];
    let missed = 0; // targets with no street within reach (sea, desert, outside the map)
    for (const t of targets) {
      const w = t
        ? g.nearest(t[0], t[1], {
            maxDist: Math.max(250, Math.min(a, b) * 0.4),
            filter: (i) => g.comp[i] === comp,
            scoreFn: snapScore,
          })
        : anchor.node;
      if (w < 0) missed++;
      else if (w !== waypoints[waypoints.length - 1]) waypoints.push(w);
    }
    waypoints.push(start);
    if (waypoints.length < 4) {
      // Targets that fell in the sea or the desert: pull the loop in. Targets that
      // snapped onto one another (a tiny loop): push it out.
      const k = missed ? 0.75 : 1.3;
      b *= k;
      if (!anchor) a *= k;
      continue;
    }

    const route = routeThrough(g, waypoints);
    if (!route) break;
    const err = Math.abs(route.length - D) / D;
    if (!best || err < best.err) best = { ...route, err, bearing };
    if (err < 0.04) break;
    const k = Math.min(1.8, Math.max(0.5, D / route.length));
    if (anchor) {
      // Only width is free; perimeter grows roughly with sqrt(a^2 + b^2).
      const target = Math.sqrt(a * a + b * b) * k;
      b = Math.sqrt(Math.max(target * target - a * a, (0.1 * a) ** 2));
    } else {
      a *= k;
      b *= k;
    }
  }
  if (!best || best.err > 0.1) return null;
  return best;
}

// Routes through all waypoints, discouraging re-use of streets already run,
// then trims out-and-back spurs.
function routeThrough(g, waypoints) {
  const touched = [];
  let nodes = [waypoints[0]];
  let ok = true;
  let fromArc = -1;
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const p = g.shortestPath(waypoints[i], waypoints[i + 1], { fromArc });
    if (!p) {
      ok = false;
      break;
    }
    fromArc = p.lastArc;
    for (const e of p.edges) {
      touched.push(e, g.penalty[e]);
      g.penalty[e] *= 4;
    }
    nodes = nodes.concat(p.nodes.slice(1));
  }
  for (let i = touched.length - 2; i >= 0; i -= 2) g.penalty[touched[i]] = touched[i + 1]; // undo in reverse order
  if (!ok) return null;

  // Remove immediate backtracks: ... X Y X ... -> ... X ...
  const stack = [];
  for (const v of nodes) {
    if (stack.length >= 2 && stack[stack.length - 2] === v) stack.pop();
    else if (stack[stack.length - 1] !== v) stack.push(v);
  }
  if (stack.length < 4) return null;
  const edges = [];
  let length = 0;
  for (let i = 0; i + 1 < stack.length; i++) {
    const e = g.edgeBetween(stack[i], stack[i + 1]);
    edges.push(e);
    length += g.len[e];
  }
  return { nodes: stack, edges, length };
}

// How scenic an edge is (0..1) for the runner's preferences. With no landscape
// preference, any park or waterfront counts.
export function scenicOf(g, e, prefs = {}) {
  if (g.rough[e] || g.hw[e] === HW.TRUNK) return 0; // a dirt trail or an arterial along the water is no asset for a runner
  if (!prefs.green && !prefs.water) return Math.min(1, Math.max(g.green[e], g.water[e], g.prom[e]) + 0.5 * g.sea[e]);
  return Math.min(1, (prefs.green ? g.green[e] : 0) + (prefs.water ? g.water[e] : 0) + 0.5 * g.prom[e] + 0.5 * g.sea[e]);
}

export function routeStats(g, route, D, prefs = {}) {
  let total = 0, green = 0, water = 0, sea = 0, quiet = 0, busy = 0, trunk = 0, gain = 0, loss = 0, repeated = 0, scenic = 0, prom = 0, rough = 0;
  let signals = 0, crossings = 0;
  const seen = new Set();
  for (let i = 0; i < route.edges.length; i++) {
    const e = route.edges[i];
    const L = g.len[e];
    total += L;
    green += L * g.green[e];
    water += L * g.water[e];
    sea += L * g.sea[e];
    scenic += L * scenicOf(g, e, prefs);
    prom += L * g.prom[e];
    if (g.rough[e]) rough += L;
    if (g.hw[e] === HW.PATH || g.hw[e] === HW.LOCAL) quiet += L;
    if (g.hw[e] >= HW.SECONDARY) busy += L;
    if (g.hw[e] === HW.TRUNK) trunk += L;
    if (seen.has(e)) repeated += L;
    seen.add(e);
    const kind = g.stopOnArc(route.nodes[i], e, route.nodes[i + 1]);
    if (kind === 2) signals++;
    else if (kind === 1) crossings++;
    const dz = g.z[route.nodes[i + 1]] - g.z[route.nodes[i]];
    if (dz > 0) gain += dz;
    else loss -= dz;
  }
  const sights = passedSights(g, route);
  const turns = buildCues(g, route).filter((c) => c.type !== 'depart' && c.type !== 'arrive').length;
  return {
    sights,
    turns,
    turnsPerKm: turns / (total / 1000),
    sightsValue: sights.reduce((a, x) => a + x.weight, 0),
    distance: total,
    distErr: Math.abs(total - D) / D,
    greenFrac: green / total,
    waterFrac: water / total,
    seaFrac: sea / total, // by the sea (beach, seaside promenade)
    quietFrac: quiet / total,
    busyFrac: busy / total,
    trunkFrac: trunk / total, // arterials (highway=trunk): tolerated for connectivity, never sought
    repeatFrac: repeated / total,
    scenicFrac: scenic / total,
    promFrac: prom / total,
    roughFrac: rough / total,
    signals,
    crossings,
    stopsKnown: g.stopsKnown !== false, // false when the traffic-light query failed (busy servers)
    stopsPerKm: (signals + crossings) / (total / 1000),
    gain,
    loss,
    gainPerKm: gain / (total / 1000),
  };
}

export function scoreRoute(s, prefs, terrain) {
  let score = 0;
  if (prefs.green) score += s.greenFrac;
  if (prefs.water) score += s.waterFrac;
  if (prefs.quiet) score += 0.8 * s.quietFrac;
  if (!prefs.green && !prefs.water && !prefs.quiet) score += 0.5 * (s.greenFrac + s.waterFrac) + 0.3 * s.quietFrac;
  score -= 0.6 * s.busyFrac;
  score -= 0.8 * s.trunkFrac; // on top of "busy": a trunk road is a last resort, like a trail
  score += 1.0 * s.promFrac; // promenades, boardwalks, park paths: the best running there is
  score += 0.6 * s.seaFrac; // and the seaside above every other waterfront
  score -= 1.5 * s.roughFrac; // trails of unknown surface: a last resort
  score -= 4 * s.distErr;
  score -= 1.2 * s.repeatFrac;
  if (prefs.avoidStops !== false) {
    const km = s.distance / 1000;
    score -= 0.08 * (s.signals / km) + 0.02 * (s.crossings / km);
  }
  if (prefs.sights) score += 0.12 * Math.min(8, s.sightsValue);
  score -= 0.05 * Math.max(0, s.turnsPerKm - 1); // fluent routes: few turns
  if (terrain === 'flat') score -= 0.6 * Math.min(1, s.gainPerKm / 30);
  if (terrain === 'hilly') score += 0.8 * Math.min(1, s.gainPerKm / 40);
  return score;
}

function overlap(g, a, b) {
  const setB = new Set(b.edges);
  let shared = 0;
  for (const e of new Set(a.edges)) if (setB.has(e)) shared += g.len[e];
  return shared / Math.min(a.length, b.length);
}

function describe(g, route, start, prefs = {}) {
  const s = route.stats;
  let cx = 0, cy = 0;
  for (const v of route.nodes) {
    cx += g.x[v];
    cy += g.y[v];
  }
  cx = cx / route.nodes.length - g.x[start];
  cy = cy / route.nodes.length - g.y[start];
  const headingDeg = (Math.atan2(cx, cy) * 180) / Math.PI;
  const heading = bearingName(headingDeg);

  let theme = 'City loop';
  if (s.seaFrac >= 0.2) theme = 'Seaside loop';
  else if (s.waterFrac >= 0.25 && s.waterFrac >= s.greenFrac) theme = 'Waterfront loop';
  else if (s.greenFrac >= 0.25) theme = 'Park loop';
  else if (s.promFrac >= 0.4) theme = 'Promenade loop';
  else if (s.quietFrac >= 0.75) theme = 'Quiet streets loop';
  if (g.hasElevation && s.gainPerKm >= 25) theme = 'Hilly ' + theme.toLowerCase();
  const outback = route.type === 'outback';
  if (outback) {
    theme = 'Out & back';
    if (s.seaFrac >= 0.15) theme += ' along the sea'; // reaching the beach is the point, even with a plain way there
    else if (s.waterFrac >= 0.25 && s.waterFrac >= s.greenFrac) theme += ' along the water';
    else if (s.greenFrac >= 0.25) theme += ' through the green';
  }

  if (prefs.sights && s.sights.length >= 2) theme = outback ? 'Sightseeing out & back' : 'Sightseeing loop';
  // The card states the facts a runner plans around: climb and descent, traffic lights
  // and road crossings (plus the landmarks on a sightseeing tour). The landscape mix
  // shapes the route and its name, but is not listed as percentages.
  const highlights = [];
  // Landmarks are only mentioned (card, map pins, voice) when sightseeing was asked for.
  const sights = prefs.sights ? s.sights : [];
  if (sights.length) highlights.push(sightsText(sights));
  if (outback) highlights.push('Same way there and back');
  if (g.hasElevation) highlights.push(climbText(s));
  highlights.push(stopsText(s));

  // Elevation profile, downsampled to ~80 points.
  const profile = [];
  let d = 0;
  const step = Math.max(1, Math.floor(route.nodes.length / 80));
  for (let i = 0; i < route.nodes.length; i++) {
    if (i > 0) d += g.len[route.edges[i - 1]];
    if (i % step === 0 || i === route.nodes.length - 1) profile.push([d, g.z[route.nodes[i]]]);
  }

  return {
    name: `${theme} to the ${heading}`,
    theme,
    heading: headingDeg,
    distance: s.distance,
    stats: s,
    score: route.score,
    highlights,
    profile,
    latlngs: route.nodes.map((v) => [g.lat[v], g.lon[v]]),
    sights: sights.map(({ name, local, kind, lat, lon, at, side }) => ({ name, local, kind, lat, lon, at, side })),
    cues: buildCues(g, route),
    hasElevation: g.hasElevation,
    type: outback ? 'outback' : 'loop',
    turnaround: outback ? [g.lat[route.turnaround], g.lon[route.turnaround]] : null,
  };
}

function sightsText(list) {
  const names = list.map((x) => x.name);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3} more` : '';
  return `Passes ${list.length} sight${list.length > 1 ? 's' : ''}: ${shown}${more}`;
}

/** "45 m climb · 42 m descent" */
export function climbText(s) {
  return `${Math.round(s.gain)} m climb · ${Math.round(s.loss ?? 0)} m descent`;
}

/**
 * "2 traffic lights · 5 road crossings" (crossings = streets to cross on foot, lit or not).
 * When the traffic-light data could not be fetched, the card says so rather than claiming none.
 */
export function stopsText(s) {
  const n = (k, one, many) => (k === 0 ? `no ${many}` : k === 1 ? `1 ${one}` : `${k} ${many}`);
  // When the traffic-light source is down, the card simply says nothing about lights.
  const t = s.stopsKnown === false
    ? n(s.crossings, 'road crossing', 'road crossings')
    : `${n(s.signals, 'traffic light', 'traffic lights')} · ${n(s.crossings, 'road crossing', 'road crossings')}`;
  return t[0].toUpperCase() + t.slice(1);
}

// ---------- Sightseeing ----------

const SIGHT_PASS_M = 60; // a sight counts as "passed" within 60 m of the route

/**
 * Landmarks the route passes, in running order, each with how far along the
 * route it comes (m) and on which side ('left' / 'right' / 'ahead').
 */
export function passedSights(g, route) {
  if (!g.sights?.length) return [];
  const nodes = route.nodes;
  // Distance along the route at each node.
  const along = new Float64Array(nodes.length);
  for (let i = 1; i < nodes.length; i++) along[i] = along[i - 1] + g.len[route.edges[i - 1]];
  const out = [];
  for (const sg of g.sights) {
    let best = -1;
    let bestD = SIGHT_PASS_M;
    for (let i = 0; i < nodes.length; i++) {
      const v = nodes[i];
      const dx = g.x[v] - sg.x;
      if (dx > bestD || dx < -bestD) continue;
      const d = Math.hypot(dx, g.y[v] - sg.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) continue;
    const a = nodes[Math.max(0, best - 1)];
    const b = nodes[Math.min(nodes.length - 1, best + 1)];
    const dirX = g.x[b] - g.x[a];
    const dirY = g.y[b] - g.y[a];
    const vx = sg.x - g.x[nodes[best]];
    const vy = sg.y - g.y[nodes[best]];
    const cross = dirX * vy - dirY * vx;
    const side = Math.hypot(vx, vy) < 12 ? 'ahead' : cross > 0 ? 'left' : 'right';
    out.push({ ...sg, at: along[best], side });
  }
  return out.sort((p, q) => p.at - q.at);
}

/**
 * Loops that visit landmarks: for slices of the compass around the start, pick
 * the most interesting sights that fit the distance, visit them in a sweep,
 * route through them, then stretch or trim the loop to the target distance.
 */
async function sightseeingTours(g, { start, comp, D }) {
  const sx = g.x[start];
  const sy = g.y[start];
  const pool = [];
  for (const sg of g.sights || []) {
    if (g.comp[sg.node] !== comp || sg.node === start) continue;
    const dx = g.x[sg.node] - sx;
    const dy = g.y[sg.node] - sy;
    const d = Math.hypot(dx, dy);
    if (d < 120 || d > 0.45 * D) continue;
    pool.push({ ...sg, d, ang: (Math.atan2(dx, dy) + 2 * Math.PI) % (2 * Math.PI) });
  }
  if (!pool.length) return [];
  const est = (stops) => {
    let L = 0;
    let px = sx;
    let py = sy;
    for (const p of stops) {
      L += Math.hypot(g.x[p.node] - px, g.y[p.node] - py);
      px = g.x[p.node];
      py = g.y[p.node];
    }
    return 1.3 * (L + Math.hypot(px - sx, py - sy));
  };
  const seen = new Set();
  const tours = [];
  for (let a0 = 0; a0 < 360; a0 += 30) {
    for (const width of [90, 150, 210, 300]) {
      const lo = (a0 * Math.PI) / 180;
      const span = (width * Math.PI) / 180;
      const inWin = pool.filter((p) => ((p.ang - lo + 2 * Math.PI) % (2 * Math.PI)) <= span);
      if (!inWin.length) continue;
      const rel = (p) => (p.ang - lo + 2 * Math.PI) % (2 * Math.PI);
      // Greedy: most interesting first, keep if the sweep still fits the distance.
      let stops = [];
      for (const p of [...inWin].sort((x, y) => y.weight - x.weight)) {
        const trial = [...stops, p].sort((x, y) => rel(x) - rel(y));
        if (est(trial) <= D * 1.05) stops = trial;
        if (stops.length >= 10) break;
      }
      if (!stops.length) continue;
      const key = stops.map((p) => p.node).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      tours.push(stops);
    }
  }
  const out = [];
  for (const stops of tours) {
    const route = fitTour(g, start, stops.map((p) => p.node), D);
    if (route) out.push(route);
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

// Routes start -> stops -> start, then lengthens a short tour by bending its
// longest leg outward (or drops the last stop if too long), up to 4 tries.
function fitTour(g, start, stopNodes, D) {
  let stops = [...stopNodes];
  let extra = null; // { after: index in stops, x, y }
  let best = null;
  for (let iter = 0; iter < 5; iter++) {
    const wps = [start, ...stops];
    if (extra) {
      const w = g.nearest(extra.x, extra.y, { maxDist: 400, filter: (i) => g.comp[i] === g.comp[start] });
      if (w >= 0) wps.splice(extra.after + 1, 0, w);
    }
    wps.push(start);
    const route = routeThrough(g, wps.filter((v, i) => i === 0 || v !== wps[i - 1]));
    if (!route) return best;
    const err = (route.length - D) / D;
    if (!best || Math.abs(err) < Math.abs(best.err)) best = { ...route, err: Math.abs(err), errSigned: err, type: 'sightseeing' };
    if (Math.abs(err) < 0.06) break;
    if (err > 0) {
      if (stops.length <= 1) break;
      stops = stops.slice(0, -1); // too long: drop the last (least central) stop
      extra = null;
      continue;
    }
    // Too short: bend the longest leg outward to add the missing distance.
    const pts = [start, ...stops, start];
    let li = 0;
    let lmax = -1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = Math.hypot(g.x[pts[i + 1]] - g.x[pts[i]], g.y[pts[i + 1]] - g.y[pts[i]]);
      if (l > lmax) { lmax = l; li = i; }
    }
    const a = pts[li];
    const b = pts[li + 1];
    const mx = (g.x[a] + g.x[b]) / 2;
    const my = (g.y[a] + g.y[b]) / 2;
    const deficit = (-err * D) / 1.3 + (extra ? extra.h * 0.5 : 0);
    const half = Math.max(lmax / 2, 1);
    const h = Math.sqrt(Math.max(0, (half + deficit / 2) ** 2 - half * half));
    // Outward = away from the start (or perpendicular if the leg touches it).
    let ox = mx - g.x[start];
    let oy = my - g.y[start];
    if (Math.hypot(ox, oy) < 50) { ox = -(g.y[b] - g.y[a]); oy = g.x[b] - g.x[a]; }
    const n = Math.hypot(ox, oy) || 1;
    extra = { after: li, x: mx + (ox / n) * h, y: my + (oy / n) * h, h };
  }
  return best && best.err <= 0.12 ? best : null;
}
