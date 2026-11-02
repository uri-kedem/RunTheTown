// Country mode: a village whose roads are unpaved lanes and dirt tracks, with one short
// paved stretch. A town never uses such ways; here they are the only way to run.
// Run: node tests/test-country.mjs
import { RouteEngine } from '../js/engine.js';
import { CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';
import { ElevationGrid } from '../js/elevation.js';

const flatElev = async (proj, radius) => new ElevationGrid(proj, radius, 4, new Float32Array(16).fill(50));

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// A hamlet: a 5 x 5 grid of gravel lanes 400 m apart, a dirt track ring beyond it, and a
// single 600 m paved residential street through the middle (too short for any run).
function hamlet() {
  const [lat0, lon0] = CENTER;
  const ky = 110574;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const elements = [];
  const ids = new Map();
  let nextId = 1;
  const node = (x, y) => {
    const key = `${x},${y}`;
    if (!ids.has(key)) { const id = nextId++; ids.set(key, id); elements.push({ type: 'node', id, lat: lat0 + y / ky, lon: lon0 + x / kx }); }
    return ids.get(key);
  };
  const way = (pts, tags) => elements.push({ type: 'way', id: nextId++, nodes: pts.map(([x, y]) => node(x, y)), tags });
  const S = 400;
  for (let i = -2; i <= 2; i++) {
    way([[i * S, -2 * S], [i * S, -S], [i * S, 0], [i * S, S], [i * S, 2 * S]], { highway: 'unclassified', surface: 'gravel', name: `Lane ${i + 3}` });
    way([[-2 * S, i * S], [-S, i * S], [0, i * S], [S, i * S], [2 * S, i * S]], { highway: 'unclassified', surface: 'gravel', name: `Row ${i + 3}` });
  }
  // Dirt track ring 1.2 km out (farm tracks, no surface tag), joined to the grid at four points.
  const R = 3 * S;
  way([[-R, -R], [0, -R], [R, -R], [R, 0], [R, R], [0, R], [-R, R], [-R, 0], [-R, -R]], { highway: 'track', name: 'Field Track' });
  for (const [a, b] of [[[0, -2 * S], [0, -R]], [[0, 2 * S], [0, R]], [[-2 * S, 0], [-R, 0]], [[2 * S, 0], [R, 0]]]) way([a, b], { highway: 'track' });
  // The one paved street: 600 m along Row 3 (y = 0), from x = -300 to 300.
  way([[-300, 0], [-100, 0], [100, 0], [300, 0]], { highway: 'residential', surface: 'asphalt', name: 'Main Street' });
  return { elements };
}

const engine = new RouteEngine({ fetchImpl: makeMockMapBackend(hamlet()), fetchElevationImpl: flatElev, useCache: false, scanPauseMs: 0 });

{
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {}, terrain: 'any' });
  console.log('   ' + routes.map((r) => `${r.name} ${(r.distance / 1000).toFixed(2)} km | ${r.highlights.join(' · ')}`).join('\n   '));
  check(routes.length >= 1, 'a village with only unpaved lanes still gets a run');
  check(routes.country === true, 'the plan says it is a country run');
  check(routes.every((r) => Math.abs(r.distance - 5000) / 5000 <= 0.1), 'runs are close to 5 km');
  check(routes.every((r) => r.stats.countryFrac > 0.5 && r.highlights.some((h) => /on unpaved lanes and tracks/.test(h))), 'cards say how much is on unpaved lanes and tracks');
  check(routes.every((r) => /^\d+% on unpaved lanes and tracks$/.test(r.highlights[0]) && /Country/.test(r.name)), 'the where-line and the name say country');
  const g = engine.area.graph;
  check(g.countryWays > 20 && g.allowCountry === false, `country ways parsed (${g.countryWays}) and switched off again after the plan`);
}

// Start on the dirt track ring itself (a farm track): still a run.
{
  const [lat0, lon0] = CENTER;
  const routes = await engine.plan({ lat: lat0 + 1200 / 110574, lon: lon0, distanceKm: 3, prefs: {}, terrain: 'any' });
  check(routes.length >= 1 && routes.country, 'a start on a farm track gets a country run');
}

// The synthetic city has a gravel wadi trail: a town run never uses it (tests in test-planner
// cover that); here we only make sure the city's plan is not flagged as country.
{
  const { syntheticOverpass } = await import('./synthetic-city.mjs');
  const city = new RouteEngine({ fetchImpl: makeMockMapBackend(syntheticOverpass()), fetchElevationImpl: flatElev, useCache: false, scanPauseMs: 0 });
  const routes = await city.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {}, terrain: 'any' });
  check(routes.length === 3 || routes.length >= 1, 'the city plans as before');
  check(routes.country === false && routes.every((r) => r.stats.countryFrac === 0), 'a town run touches no unpaved way');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll country-mode tests passed');
process.exit(failures ? 1 : 0);
