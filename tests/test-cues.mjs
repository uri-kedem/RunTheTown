// Turn-by-turn cue tests. Run: node tests/test-cues.mjs
import { RouteEngine } from '../js/engine.js';
import { syntheticOverpass, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const engine = new RouteEngine({ fetchImpl: makeMockMapBackend(syntheticOverpass()), fetchElevationImpl: async () => null, useCache: false, scanPauseMs: 0 });

for (const [km, prefs] of [[5, {}], [8, { sights: true }], [10, { water: true }]]) {
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: km, prefs, terrain: 'any' });
  console.log(`\n${km} km ${JSON.stringify(prefs)}`);
  for (const r of routes) {
    const c = r.cues;
    console.log(`  ${r.name} (${r.type}) ${c.length} cues: ` + c.slice(0, 5).map((x) => `${Math.round(x.at)}m ${x.text}`).join(' | '));
    check(c[0].type === 'depart' && c[0].at === 0, 'starts with a depart cue');
    check(c[c.length - 1].type === 'arrive' && Math.abs(c[c.length - 1].at - r.distance) < 1, 'ends with arrive at route length');
    check(c.every((x, i) => i === 0 || x.at >= c[i - 1].at), 'cues in running order');
    check(c.every((x) => typeof x.text === 'string' && Number.isFinite(x.lat)), 'cues have text and position');
    const turns = c.filter((x) => x.type !== 'depart' && x.type !== 'arrive');
    check(turns.length >= 3 && turns.length <= r.distance / 60, `sensible number of turns (${turns.length})`);
    // The synthetic park's footpaths have no names, so a route through the park names fewer turns.
    if (r.stats.greenFrac < 0.3) check(turns.filter((x) => x.street).length >= turns.length * 0.5, 'most turns name a street');
    if (r.type === 'outback') check(turns.some((x) => x.type === 'uturn' && Math.abs(x.at - r.distance / 2) < r.distance * 0.1), 'out & back has a u-turn near halfway');
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nAll cue tests passed');
process.exit(failures ? 1 : 0);
