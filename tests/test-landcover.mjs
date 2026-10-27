// Satellite land cover (ESA WorldCover classes) merged into the landscape grid, and
// its effect on routes. Run: node tests/test-landcover.mjs
import { LandscapeGrid } from '../js/landscape.js';
import { LandcoverGrid, LC, worldcoverItem, landcoverTileUrl } from '../js/landcover.js';
import { makeProjection } from '../js/geo.js';
import { RouteEngine } from '../js/engine.js';
import { ElevationGrid } from '../js/elevation.js';
import { syntheticOverpass, hillElevation, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

// WorldCover sheet names: 3°×3°, named by the south-west corner.
check(worldcoverItem(32.08, 34.78) === 'ESA_WorldCover_10m_2021_v200_N30E033', 'Tel Aviv is on sheet N30E033');
check(worldcoverItem(-33.87, 151.2) === 'ESA_WorldCover_10m_2021_v200_S36E150', 'Sydney is on sheet S36E150');
check(worldcoverItem(40.71, -74.0) === 'ESA_WorldCover_10m_2021_v200_N39W075', 'New York is on sheet N39W075');
check(/esa-worldcover.*N30E033.*assets=map/.test(landcoverTileUrl(13, 4887, 3324, worldcoverItem(32.08, 34.78))), 'tile URL names the collection, the sheet and the map asset');

// A grid with one OSM park; satellite classes painted by region.
{
  const proj = makeProjection(...CENTER);
  const radius = 2000;
  const cell = 25;
  const grid = new LandscapeGrid(proj, radius, cell);
  const xy = (x, y) => proj.toLatLon(x, y);
  grid.addFeatures([{ kind: 'green', shape: 'area', buffer: 0, relation: true, rings: [[xy(-1500, 300), xy(-300, 300), xy(-300, 1100), xy(-1500, 1100), xy(-1500, 300)]] }]);
  const n = grid.n;
  const classes = new Uint8Array(n * n).fill(LC.BUILT); // a town: built-up everywhere
  const paint = (x0, y0, x1, y1, v) => {
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = grid.center(c), y = grid.center(r); if (x >= x0 && x < x1 && y >= y0 && y < y1) classes[r * n + c] = v; }
  };
  paint(300, 300, 900, 900, LC.TREE); // a wooded park nobody drew in OSM, inside town
  paint(-1500, 300, -300, 1100, LC.GRASS); // the OSM park, seen as grass
  paint(1200, -1900, 1900, -600, LC.CROP); // fields at the edge of town
  paint(-2000, -2000, -800, -800, LC.TREE); // a forest at the edge of town, open country for 500 m around its heart
  paint(-200, -300, 1900, -250, LC.WATER); // a river (two cells wide)
  // Scattered street trees: every third cell in a block of streets.
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = grid.center(c), y = grid.center(r); if (x >= 1000 && x < 1800 && y >= 300 && y < 900 && (r + c) % 3 === 0) classes[r * n + c] = LC.TREE; }
  grid.addLandcover(new LandcoverGrid(proj, radius, cell, classes));
  grid.finish();
  const at = (kind, x, y) => grid.at(kind, x, y);
  check(at('green', 600, 600) === 1 && at('wild', 600, 600) === 0, 'an undrawn wooded park in town is green, not wild');
  check(at('green', -900, 700) === 1 && at('wild', -900, 700) === 0, 'the OSM park stays green and never wild, whatever the satellite says');
  check(at('wild', 1500, -1200) === 1 && at('green', 1500, -1200) === 0, 'fields are open country (a bare path there is a trail)');
  check(at('green', -1500, -1500) === 1 && at('wild', -1500, -1500) === 1 && at('wild', -900, -900) === 0, 'the heart of a forest is open country (wild); its edge by the town is a park');
  check(at('water', 800, -225) === 1 && at('water', 800, -200) === 1 && at('water', 800, -100) === 0, 'a river seen from space gives a waterfront within ~75 m of its bank, not beyond');
  check(!grid.lakeBody && !grid.dock.some((v) => v), 'satellite water never makes a harbour or a dock');
  let greenStreet = 0; for (let x = 1025; x < 1800; x += 50) for (let y = 325; y < 900; y += 50) greenStreet += at('green', x, y);
  check(greenStreet === 0, `scattered street trees do not turn streets green (${greenStreet} cells)`);
}

// Through the engine: a fake satellite layer that calls the synthetic city's south-east
// quarter woodland (no OSM park there) makes the routes offered there greener.
{
  const fakeElev = async (proj, radius) => {
    const n = 30;
    const step = (2 * radius) / (n - 1);
    const v = new Float32Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) v[r * n + c] = hillElevation(c * step - radius, r * step - radius);
    return new ElevationGrid(proj, radius, n, v);
  };
  const city = syntheticOverpass();
  const run = async (fetchLandcoverImpl) => {
    const eng = new RouteEngine({ fetchImpl: makeMockMapBackend(city), fetchElevationImpl: fakeElev, fetchLandcoverImpl, useCache: false, scanPauseMs: 0 });
    const rs = await eng.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: { green: true }, terrain: 'any' });
    return { rs, area: eng.area };
  };
  const plain = await run(async () => null);
  const woods = await run(async (proj, radius, cell) => {
    const n = Math.ceil((2 * radius) / cell);
    const classes = new Uint8Array(n * n).fill(LC.BUILT);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = c * cell + cell / 2 - radius, y = r * cell + cell / 2 - radius; if (x > 200 && x < 1700 && y < -200 && y > -1700) classes[r * n + c] = LC.TREE; }
    return new LandcoverGrid(proj, radius, cell, classes);
  });
  const best = (o) => Math.max(...o.rs.map((r) => r.stats.greenFrac));
  console.log(`\n6 km parks: greenest option ${(best(plain) * 100) | 0}% green on OSM alone, ${(best(woods) * 100) | 0}% with the satellite woods (landcover merged: ${woods.area.landcover})`);
  check(woods.area.landcover === true && plain.area.landcover === false, 'the area says whether land cover was merged');
  check(best(woods) >= best(plain) + 0.05, 'the satellite woodland draws a greener route');
  check(woods.rs.every((r) => Math.abs(r.distance / 1000 - 6) / 6 < 0.1), 'routes still fit the distance');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll land-cover checks passed');
process.exit(failures ? 1 : 0);
