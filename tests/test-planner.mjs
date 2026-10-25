// Offline engine test on a synthetic city. Run: node tests/test-planner.mjs
import { RouteEngine } from '../js/engine.js';
import { stopsText } from '../js/planner.js';
import { parseOverpass } from '../js/osm.js';
import { ElevationGrid } from '../js/elevation.js';
import { syntheticOverpass, hillElevation, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';

const city = syntheticOverpass();
const fakeElev = async (proj, radius) => {
  const n = 30;
  const step = (2 * radius) / (n - 1);
  const v = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) v[r * n + c] = hillElevation(c * step - radius, r * step - radius);
  return new ElevationGrid(proj, radius, n, v);
};

const engine = new RouteEngine({ fetchImpl: makeMockMapBackend(city), fetchElevationImpl: fakeElev, useCache: false, scanPauseMs: 0 });
let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};
const fmt = (r) =>
  `${r.type === 'outback' ? '[O&B] ' : ''}lights ${r.stats.signals} cross ${r.stats.crossings} | ${(r.distance / 1000).toFixed(2)} km | green ${(r.stats.greenFrac * 100) | 0}% water ${(r.stats.waterFrac * 100) | 0}% ` +
  `prom ${(r.stats.promFrac * 100) | 0}% busy ${(r.stats.busyFrac * 100) | 0}% repeat ${(r.stats.repeatFrac * 100) | 0}% gain ${Math.round(r.stats.gain)} m | ${r.name}`;

const loopsOnly = (rs) => rs.filter((r) => r.type === 'loop');
async function run(label, opts, { all = false } = {}) {
  const t = Date.now();
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], ...opts });
  console.log(`\n${label} (${Date.now() - t} ms)`);
  routes.forEach((r) => console.log('   ' + fmt(r)));
  return all ? routes : loopsOnly(routes); // loop checks ignore the extra out-and-back
}

const best = (rs, key) => Math.max(...rs.map((r) => r.stats[key]));

for (const km of [3, 5, 10, 15]) {
  const rs = await run(`${km} km, no preferences`, { distanceKm: km, prefs: {}, terrain: 'any' }, { all: true });
  check(rs.length === 3, 'returns exactly 3 options');
  const promOf = (r) => r.stats.promFrac + 0.5 * Math.max(r.stats.waterFrac, r.stats.greenFrac);
  check(promOf(rs[0]) >= Math.max(...rs.map(promOf)) - 0.09, 'the first option is the promenade / park / waterfront run');
  check(rs.every((r) => Math.abs(r.distance / 1000 - km) / km < 0.08), 'all within 8% of target distance');
  check(loopsOnly(rs).every((r) => r.stats.repeatFrac < 0.2), 'little back-tracking on the loops');
}

const plain = await run('6 km plain', { distanceKm: 6, prefs: {}, terrain: 'any' });
check(plain.some((r) => r.stats.promFrac >= 0.15), 'plain routes use the pedestrian street / boulevard walkway (promenades)');
check(plain.every((r) => !r.highlights.some((h) => /%|turn/.test(h))), 'cards show no landscape percentages or turn counts');
check(plain.every((r) => r.highlights.some((h) => /^\d+ m climb · \d+ m descent$/.test(h)) && r.highlights.some((h) => /traffic light/.test(h) && /road crossing/.test(h))), 'cards state climb & descent, traffic lights and road crossings');
console.log('   card: ' + plain[0].highlights.join(' | '));
check(stopsText({ stopsKnown: false, signals: 0, crossings: 2 }) === '2 road crossings' && !/light|unknown/.test(stopsText({ stopsKnown: false, signals: 0, crossings: 0 })), 'with the traffic-light source down, the card says nothing about lights');

// Unmarked tracks: the city has a dirt track, an unpaved wadi trail, a mountain-bike
// singletrack and a bare (surface-less) trail through a wood, all cutting diagonally
// through the grid. No route may use them; the paved garden path of the same shape is fine.
{
  const ky = 110574, kx = 111320 * Math.cos((CENTER[0] * Math.PI) / 180);
  const xy = ([la, lo]) => [(lo - CENTER[1]) * kx, (la - CENTER[0]) * ky];
  const onLine = (p, a, b) => { const [x, y] = p; const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (Math.abs(cross) / len > 3) return false; const t = ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (len * len); return t > -0.01 && t < 1.01; };
  // ... plus the footpath through the army base, the private drive and (as a last resort only) the factory alley.
  const BAD = [[[-800, -800], [800, 800]], [[-800, 800], [800, -800]], [[900, -1500], [1500, -900]], [[900, -900], [1700, -100]], [[-1700, -1700], [-900, -900]], [[-800, -1250], [-300, -1250]], [[300, -1700], [1100, -900]]];
  const GOOD = [[-1500, -900], [-900, -1500]];
  const usesLine = (r, [a, b]) => { const pts = r.latlngs.map(xy); let n = 0; for (let i = 1; i < pts.length; i++) if (onLine(pts[i - 1], a, b) && onLine(pts[i], a, b) && Math.abs(pts[i][0] - pts[i - 1][0]) > 50 && Math.abs(pts[i][1] - pts[i - 1][1]) > 50) n++; return n; };
  let bad = 0, good = 0, tested = 0;
  for (const km of [4, 6, 8, 12]) for (const prefs of [{}, { green: true }, { quiet: true }]) {
    const rs = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: km, prefs, terrain: 'any' });
    for (const r of rs) { tested++; for (const L of BAD) bad += usesLine(r, L); good += usesLine(r, GOOD); }
  }
  check(bad === 0, `no route uses the dirt track, the unpaved trail, the singletrack, the wood trail, the army-base path, the private drive or the factory alley (${tested} routes checked)`);
  console.log(`   the paved garden path of the same shape is allowed (used in ${good} segments)`);
  const area = engine.area || engine.lastArea;
  const g = area?.graph;
  if (g) {
    let rough = 0; for (let e = 0; e < g.m; e++) rough += g.rough[e];
    console.log(`   graph: ${g.m} edges, ${rough} rough (bare paths of unknown surface), ${g.skippedWild} bare paths dropped in open country`);
    check(rough > 0 && g.skippedWild >= 1, 'the bare park path stays (penalised) while the bare wood trail is dropped');
    check(g.skippedClosed >= 1, `the path through the army base is not in the network (${g.skippedClosed} ways dropped on closed ground)`);
    console.log(`   dropped as private: ${area?.audit?.dropped?.private ?? 'n/a'}`);
  }
}

// Trunk roads (highway=trunk). The quarter east of the river hangs off "Route 90
// Boulevard", a trunk, like Eilat's streets hang off Route 90: routes from there must
// exist (the trunk keeps the network in one piece), while routes from the centre, where
// the grid offers alternatives, must not run along it. Its slip road is never used.
{
  const ky = 110574, kx = 111320 * Math.cos((CENTER[0] * Math.PI) / 180);
  const ll = (x, y) => [CENTER[0] + y / ky, CENTER[1] + x / kx];
  const xy = ([la, lo]) => [(lo - CENTER[1]) * kx, (la - CENTER[0]) * ky];
  const [la, lo] = ll(2600, 300);
  let quarter = [];
  try { quarter = await engine.plan({ lat: la, lon: lo, distanceKm: 5, prefs: {}, terrain: 'any' }); } catch (err) { console.log('   ' + err.message); }
  console.log(`\n5 km from the trunk-road quarter: ${quarter.map(fmt).join('\n   ') || 'no route'}`);
  check(quarter.length >= 1 && quarter.every((r) => Math.abs(r.distance - 5000) / 5000 < 0.1), `routes exist from the quarter that hangs off the trunk (${quarter.length} options)`);
  check(quarter.length >= 1 && quarter.some((r) => r.type === 'loop'), 'at least one of them is a loop (over the trunk bridge into town)');
  check(quarter.every((r) => r.stats.trunkFrac < 0.35), 'the trunk is used only to get in and out, not run along');
  const onSlip = (r) => r.latlngs.map(xy).some(([x, y]) => x > 3050 && y < -50);
  check(!quarter.some(onSlip), 'no route uses the trunk slip road');
  const g = engine.area.graph;
  let trunkEdges = 0; for (let e = 0; e < g.m; e++) if (g.hw[e] === 6) trunkEdges++;
  check(trunkEdges >= 10 && trunkEdges <= 14, `the trunk is in the network (${trunkEdges} edges), its slip road is not`);
  const centre = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 8, prefs: {}, terrain: 'any' });
  check(centre.every((r) => r.stats.trunkFrac === 0), 'routes from the centre never run along the trunk');
}
const green = await run('6 km parks', { distanceKm: 6, prefs: { green: true }, terrain: 'any' });
check(best(green, 'greenFrac') >= best(plain, 'greenFrac') - 0.05, 'park preference finds (about) the greenest routes');
check(green.every((r) => r.stats.greenFrac > 0.25), 'all park options are >25% green');
// The river is 1.9 km from the start, so test a distance that can reach it.
const plain10 = await run('10 km plain', { distanceKm: 10, prefs: {}, terrain: 'any' });
const water = await run('10 km waterfront', { distanceKm: 10, prefs: { water: true }, terrain: 'any' });
// Max possible here without repeating streets is ~33% (grid streets out and back).
check(water[0].stats.waterFrac > 0.25, 'waterfront preference gives >25% along water');
check(best(water, 'waterFrac') > best(plain10, 'waterFrac'), 'waterfront preference beats no preference');
const quiet = await run('6 km quiet', { distanceKm: 6, prefs: { quiet: true }, terrain: 'any' });
check(quiet[0].stats.busyFrac <= plain[0].stats.busyFrac + 0.01, 'quiet preference does not add busy roads');
const flat = await run('8 km flat', { distanceKm: 8, prefs: {}, terrain: 'flat' });
const hilly = await run('8 km hilly', { distanceKm: 8, prefs: {}, terrain: 'hilly' });
check(hilly[0].stats.gain > flat[0].stats.gain * 1.5, 'hilly gives clearly more climbing than flat');

// Out & back: the river is too far for a loop to spend much time on it, so the
// promenade option (first) is a there-and-back along the water.
const ob = await run('6 km waterfront (out & back expected)', { distanceKm: 6, prefs: { water: true }, terrain: 'any' }, { all: true });
const outback = ob.find((r) => r.type === 'outback');
check(!!outback, 'offers an out-and-back option');
check(ob.length === 3, 'still exactly 3 options');
check(outback && Math.abs(outback.distance - 6000) / 6000 < 0.03, 'out-and-back within 3% of distance');
check(ob[0] === outback && outback.stats.waterFrac >= Math.max(...ob.filter((r) => r.type === 'loop').map((r) => r.stats.waterFrac)) + 0.1, 'the out-and-back along the water comes first, clearly more waterfront than the loops');
check(outback && outback.turnaround, 'out-and-back has a turnaround point');
const lat0 = outback.latlngs[0], latN = outback.latlngs[outback.latlngs.length - 1];
check(Math.abs(lat0[0] - latN[0]) < 1e-9 && Math.abs(lat0[1] - latN[1]) < 1e-9, 'out-and-back returns to start');
const noOb = await run('6 km parks (park is close, loops are scenic)', { distanceKm: 6, prefs: { green: true }, terrain: 'any' }, { all: true });
console.log('   out & back offered:', noOb.some((r) => r.type === 'outback'));

// Stop avoidance, precise check: two ways from A to B. The direct street is
// 1000 m with 3 signalized junctions; a parallel street is 1300 m with none.
{
  const ky = 110574, kx = 111320 * Math.cos((CENTER[0] * Math.PI) / 180);
  const ll = (x, y) => ({ lat: CENTER[0] + y / ky, lon: CENTER[1] + x / kx });
  const els = [];
  let id = 1;
  const node = (x, y, tags) => { els.push({ type: 'node', id, ...ll(x, y), ...(tags ? { tags } : {}) }); return id++; };
  const A = node(0, 0), B = node(1000, 0);
  const sigs = [250, 500, 750].map((x) => node(x, 0, { highway: 'traffic_signals' }));
  const sideStubs = [250, 500, 750].map((x) => node(x, -100)); // make the signal nodes real junctions
  const p1 = node(0, 150), p2 = node(1000, 150);
  els.push({ type: 'way', id: 1, nodes: [A, ...sigs, B], tags: { highway: 'residential' } });
  els.push({ type: 'way', id: 2, nodes: [A, p1, p2, B], tags: { highway: 'residential' } });
  sigs.forEach((sgn, i) => els.push({ type: 'way', id: 10 + i, nodes: [sgn, sideStubs[i]], tags: { highway: 'residential' } }));
  const { Graph } = await import('../js/graph.js');
  const { makeProjection } = await import('../js/geo.js');
  const g = new Graph(parseOverpass({ elements: els }), makeProjection(...CENTER), null, null);
  const len = (p) => p.edges.reduce((a, e) => a + g.len[e], 0);
  g.stopWeight = 0;
  const direct = g.shortestPath(0, 4); // A is index 0, B is index 4 (order of first appearance)
  g.stopWeight = 1;
  const avoid = g.shortestPath(0, 4);
  console.log(`\nstop avoidance: ignoring -> ${Math.round(len(direct))} m, avoiding -> ${Math.round(len(avoid))} m`);
  check(Math.abs(len(direct) - 1000) < 5, 'without avoidance takes the short street with 3 lights');
  check(Math.abs(len(avoid) - 1300) < 5, 'with avoidance takes the 300 m longer street with no lights');
}

// Whole-route check: same request with and without avoiding stops.
const withStops = await run('8 km, ignoring stops', { distanceKm: 8, prefs: { avoidStops: false }, terrain: 'any' });
const noStops = await run('8 km, avoiding stops', { distanceKm: 8, prefs: {}, terrain: 'any' });
const sig = (rs) => rs.reduce((a, r) => a + r.stats.signals, 0) / rs.length;
console.log(`   avg traffic lights per route: ignoring ${sig(withStops).toFixed(1)}, avoiding ${sig(noStops).toFixed(1)}`);
check(sig(noStops) <= sig(withStops), 'avoiding never adds traffic lights');
check(noStops.every((r) => Math.abs(r.distance - 8000) / 8000 < 0.08), 'still within 8% of distance');

// Messy city: break ways into single segments and drop 25% of them.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const messy = () => {
  const json = syntheticOverpass();
  const out = [];
  let wayId = 1e6;
  for (const el of json.elements) {
    if (el.type === 'way' && el.nodes) {
      for (let i = 0; i + 1 < el.nodes.length; i++) {
        if (rand() > 0.25) out.push({ ...el, id: wayId++, nodes: [el.nodes[i], el.nodes[i + 1]] });
      }
    } else out.push(el);
  }
  return { elements: out };
};
const messyEngine = new RouteEngine({ fetchImpl: makeMockMapBackend(messy()), fetchElevationImpl: fakeElev, useCache: false, scanPauseMs: 0 });
for (const km of [4, 8, 12]) {
  const t = Date.now();
  const rs = loopsOnly(await messyEngine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: km, prefs: { green: true, quiet: true }, terrain: 'any' }));
  console.log(`\nmessy city ${km} km (${Date.now() - t} ms)`);
  rs.forEach((r) => console.log('   ' + fmt(r)));
  check(rs.length >= 2, 'finds at least 2 options');
  check(rs.every((r) => Math.abs(r.distance / 1000 - km) / km < 0.1), 'all within 10% of target');
  check(rs.every((r) => r.stats.repeatFrac < 0.25), 'limited back-tracking');
}

// Sightseeing: only landmarks worth a detour, English names where available.
{
  const plain = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 8, prefs: {}, terrain: 'any' });
  const tour = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 8, prefs: { sights: true }, terrain: 'any' });
  console.log('\n8 km sightseeing');
  tour.forEach((r) => console.log(`   ${fmt(r)} | ${r.sights.map((x) => x.name).join(', ')}`));
  const names = tour.flatMap((r) => r.sights.map((x) => x.name));
  const kinds = new Set(tour.flatMap((r) => r.sights.map((x) => x.kind)));
  check(tour.some((r) => r.theme.startsWith('Sightseeing')), 'offers sightseeing routes');
  check(Math.max(...tour.map((r) => r.sights.length)) >= 3, 'best tour passes at least 3 landmarks');
  check(Math.max(...tour.map((r) => r.sights.length)) > Math.max(...plain.map((r) => r.sights.length)), 'more landmarks than without the preference');
  check(!names.some((n) => /Fountain|Gallery|Synagogue|Plaque|פסל/.test(n)), 'fountains, galleries, synagogues, plaques and unnamed art are not sights');
  check([...kinds].every((k) => /museum|monument|memorial|castle|fort|ruins|viewpoint|theatre|artwork|clock tower/.test(k)), `only landmark kinds (${[...kinds].join(', ')})`);
  check(tour.every((r) => Math.abs(r.distance - 8000) / 8000 < 0.1), 'tours within 10% of the distance');
}

// Running spots: the athletics track and the big park, each with a lap route.
{
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 8, prefs: {}, terrain: 'any' });
  const places = routes.places;
  console.log('\nrunning spots: ' + places.map((p) => `${p.kind} ${p.name} (${p.lapM} m lap, ${Math.round(p.fromStart)} m away)`).join(' | '));
  const track = places.find((p) => p.kind === 'track');
  const park = places.find((p) => p.kind === 'park');
  check(track && track.name === 'Central Stadium' && track.lapM === 400, 'finds the athletics track, named after its stadium, 400 m lap');
  check(park && park.name === 'Central Park' && park.lapM >= 1500 && park.lapM <= 5000 && park.loop.stats.greenFrac >= 0.9, 'finds the park with an inner loop on its paths');
  check(!places.some((p) => p.name === 'Park Fountain'), 'no stray places');
  const stadium = places.find((p) => p.kind === 'stadium');
  check(stadium && stadium.name === 'Riverside Athletics Stadium' && !stadium.ring && engine.routeAtPlace(stadium) === null, 'an athletics stadium known only by name is listed (3 km away), without a lap route');
  check(!places.some((p) => /Hoops|Football/.test(p.name)), 'basketball arenas and football stadiums are not running spots');
  for (const p of places.filter((q) => q.ring)) {
    const r = engine.routeAtPlace(p);
    const laps = r.cues.filter((c) => c.type === 'lap');
    console.log(`   ${r.name}: ${(r.distance / 1000).toFixed(2)} km, ${r.place.laps} laps, ${r.cues.length} cues, ${r.latlngs.length} points | ${r.highlights.join(' · ')}`);
    check(Math.abs(r.distance - 8000) / 8000 < 0.12, `${p.kind} lap route close to 8 km`);
    check(r.place.laps >= 2 && laps.length === r.place.laps, `${p.kind} route has a lap cue per lap`);
    check(r.cues[0].type === 'depart' && r.cues[r.cues.length - 1].type === 'arrive' && r.cues.every((c, i) => !i || c.at >= r.cues[i - 1].at), `${p.kind} cues in order`);
    check(r.highlights.some((h) => /to get there and back/.test(h)), `${p.kind} route runs there and back`);
    check(r.latlngs.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])), `${p.kind} route has valid points`);
  }
}

// Running spots before any search: the preview loads the map once; the plan reuses it.
{
  const fetchImpl = makeMockMapBackend(syntheticOverpass());
  const eng = new RouteEngine({ fetchImpl, fetchElevationImpl: fakeElev, useCache: false, scanPauseMs: 0 });
  const [spots, routes] = await Promise.all([
    eng.previewSpots(CENTER[0], CENTER[1], { distanceKm: 5 }),
    eng.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {}, terrain: 'any' }),
  ]);
  console.log(`\npreview: ${spots.map((p) => `${p.kind} ${p.name}`).join(', ')} | tiles fetched: ${fetchImpl.calls.tiles}`);
  check(spots.length === 3 && spots.some((p) => p.kind === 'track' && p.ring) && spots.some((p) => p.kind === 'park') && spots.some((p) => p.kind === 'stadium'), 'preview finds the track, the park and the far stadium');
  check(fetchImpl.calls.tiles <= 30, 'preview and plan share one map download');
  const lap = eng.routeAtPlace(spots.find((p) => p.kind === 'track'), { lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {} });
  check(lap.type === 'laps' && Math.abs(lap.distance - 5000) / 5000 < 0.15 && lap.sights.length === 0, 'lap route from the preview, no sight callouts without the option');
  check(routes.every((r) => r.sights.length === 0 && !r.highlights.some((h) => /sight/.test(h))), 'plain routes mention no sights');
}

// Fluent routes: turn costs in the search should cut the number of turns.
{
  const turnsFor = async (turnWeight) => {
    let turns = 0, km = 0;
    for (const [d, prefs] of [[5, {}], [6, { quiet: true }], [8, { green: true }], [8, { sights: true }], [10, { water: true }], [12, {}]]) {
      const rs = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: d, prefs, terrain: 'any', turnWeight });
      for (const r of rs) { turns += r.stats.turns; km += r.distance / 1000; }
    }
    return turns / km;
  };
  const without = await turnsFor(0);
  const withTurns = await turnsFor(1);
  console.log(`\nturns per km: without turn costs ${without.toFixed(2)}, with ${withTurns.toFixed(2)}`);
  check(withTurns < without * 0.88, 'turn costs give at least 12% fewer turns');
  check(withTurns < 2, 'under 2 turns per km on the grid city');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
