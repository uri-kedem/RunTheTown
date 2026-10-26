// Long-run tests (15 km to a marathon) through the full download path:
// vector tiles (or the Overpass backup) -> graph -> planner, with healthy and failing servers.
// Run: node tests/test-long-runs.mjs
import { RouteEngine, radiusFor } from '../js/engine.js';
import { vtTilesFor } from '../js/vectortiles.js';
import { ElevationGrid } from '../js/elevation.js';
import { syntheticOverpass, hillElevation, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';

const fakeElev = async (proj, radius) => {
  const n = 24;
  const step = (2 * radius) / (n - 1);
  const v = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) v[r * n + c] = hillElevation(c * step - radius, r * step - radius);
  return new ElevationGrid(proj, radius, n, v);
};

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
  return cond;
};

const t0 = Date.now();
const cities = {
  inland: syntheticOverpass({ size: 34000, spacing: 100, riverX: 14000, fullGrid: true }),
  coastal: syntheticOverpass({ size: 34000, spacing: 100, riverX: 14000, fullGrid: true, seaX: -900 }),
};
console.log(`built cities in ${Date.now() - t0} ms (${cities.inland.elements.length} / ${cities.coastal.elements.length} elements)`);

const conditions = {
  healthy: {},
  'tiles flaky (30%)': { vtFailRate: 0.3 },
  'tiles down -> backup': { vtDown: true, overpass: { deadServers: ['maps.mail.ru'] } },
  'no light data': { overpass: { deadServers: ['maps.mail.ru', 'overpass-api.de'] } },
};

const distances = [15, 21.1, 25, 30, 42.2];
const print = (r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(56)} ${String(r.ms).padStart(5)} ms  pieces ${r.tiles.padEnd(7)} ${r.routes}`);
const rows = [];
for (const [cityName, city] of Object.entries(cities)) {
  for (const [condName, cond] of Object.entries(conditions)) {
    for (const km of distances) {
      for (const prefs of [{}, { water: true, green: true }]) {
        const fetchImpl = makeMockMapBackend(city, { ...cond, seed: Math.round(km * 10) });
        const engine = new RouteEngine({ fetchImpl, fetchElevationImpl: fakeElev, useCache: false, scanPauseMs: 0 });
        const t = Date.now();
        let routes, err;
        try {
          routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: km, prefs, terrain: 'any' });
        } catch (e) {
          err = e.message;
        }
        const ms = Date.now() - t;
        const label = `${cityName} | ${condName} | ${km} km | ${prefs.water ? 'parks+water' : 'no prefs'}`;
        if (!err && condName.includes('backup')) check(engine.area.source === 'overpass', `${label}: should use the backup`);
        if (!err && !condName.includes('backup')) check(engine.area.source === 'vector', `${label}: should use vector tiles`);
        if (!err && condName === 'no light data') check(routes.stopsUnknown, `${label}: should report missing light data`);
        const ok =
          check(!err, `${label}: threw "${err}"`) &&
          check(routes.length >= 2 || routes.every((r) => r.stats.promFrac >= 0.6), `${label}: only ${routes.length} route(s), not landscape runs`) &&
          check(routes.every((r) => Math.abs(r.distance / 1000 - km) / km <= 0.1), `${label}: distance off (${routes.map((r) => (r.distance / 1000).toFixed(1)).join(', ')})`);
        check(ms < (condName.includes('backup') ? 30000 : 15000), `${label}: planning took ${ms} ms`);
        const row = {
          label,
          ok,
          ms,
          tiles: engine.area ? `${engine.area.tiles - engine.area.failedTiles}/${engine.area.tiles}` : '-',
          calls: `${fetchImpl.calls.tiles}t/${fetchImpl.calls.overpassTiles}o`,
          routes: routes ? routes.map((r) => `${r.type === 'outback' ? 'O&B ' : ''}${(r.distance / 1000).toFixed(1)}`).join(' / ') : err,
        };
        rows.push(row);
        print(row);
      }
    }
  }
}



// A marathon must stay a reasonable number of downloads.
const tiles42 = vtTilesFor(CENTER[0], CENTER[1], radiusFor(42200) * 1.05).length;
const tiles25 = vtTilesFor(CENTER[0], CENTER[1], radiusFor(25000) * 1.05).length;
console.log(`\nmap tiles: 25 km -> ${tiles25}, 42.2 km -> ${tiles42}`);
check(tiles42 <= 150, 'marathon needs at most 150 map tiles');

// Servers so overloaded that most pieces fail: a clear, friendly error (not a crash).
{
  const engine = new RouteEngine({ fetchImpl: makeMockMapBackend(cities.inland, { vtDown: true, overpass: { failRate: 0.97 } }), fetchElevationImpl: fakeElev, useCache: false, scanPauseMs: 0 });
  let msg = '';
  try {
    await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 25, prefs: {}, terrain: 'any' });
  } catch (e) {
    msg = e.message;
  }
  console.log(`\nall servers overloaded -> "${msg}"`);
  check(/overloaded/.test(msg), 'overloaded servers give a friendly message');
}

console.log(failures ? `\n${failures} check(s) failed` : `\nAll ${rows.length} long-run cases passed`);
process.exit(failures ? 1 : 0);
