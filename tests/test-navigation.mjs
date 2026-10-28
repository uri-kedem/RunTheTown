// Live-guidance tests with simulated GPS. Run: node tests/test-navigation.mjs
import { RouteEngine } from '../js/engine.js';
import { Navigator, SimulatedRun, roundDist, paceShort } from '../js/navigation.js';
import { syntheticOverpass, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';
import { makeProjection } from '../js/geo.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const engine = new RouteEngine({ fetchImpl: makeMockMapBackend(syntheticOverpass()), fetchElevationImpl: async () => null, useCache: false, scanPauseMs: 0 });

check(roundDist(147) === 150 && roundDist(42) === 40 && roundDist(1234) === 1200, 'distance rounding');
check(paceShort(332) === '5:32', 'pace format');

function simulate(route, { detour = null, speed = 3.0, dt = 2, noise = 4 } = {}) {
  let t = 0;
  const said = [];
  const nav = new Navigator(route, { speak: (parts, o) => said.push({ t, at: nav.progress, text: parts.map((p) => p.text).join(''), langs: parts.map((p) => p.lang), ...o }), now: () => t * 1000 });
  const sim = new SimulatedRun(route, { speed, noise });
  nav.start();
  let prev = 0, backJumps = 0, steps = 0;
  const proj = makeProjection(route.latlngs[0][0], route.latlngs[0][1]);
  while (!nav.finished && steps++ < 20000) {
    t += dt;
    let fix = sim.step(dt);
    if (detour && sim.d > detour.from && sim.d < detour.to) {
      // Run parallel to the route, `detour.off` m to the side.
      const [x, y] = proj.toXY(fix.lat, fix.lon);
      [fix.lat, fix.lon] = proj.toLatLon(x + detour.off, y + detour.off);
    }
    const v = nav.update(fix);
    if (v.progress < prev - 1) backJumps++;
    prev = v.progress;
  }
  return { nav, said, backJumps, t };
}

for (const [km, prefs] of [[5, {}], [8, { sights: true }], [10, { water: true }]]) {
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: km, prefs, terrain: 'any' });
  for (const r of routes) {
    const { nav, said, backJumps, t } = simulate(r);
    console.log(`\n${r.name} (${r.type}, ${(r.distance / 1000).toFixed(2)} km): ${said.length} messages, ${Math.round(t / 60)} min`);
    said.slice(0, 7).forEach((s) => console.log(`    ${Math.round(s.at)}m  ${s.text}`));
    console.log(`    … ${said[said.length - 1].text}`);
    const turns = nav.cues.filter((c) => c.type !== 'arrive');
    check(nav.finished, 'run finishes at the start');
    check(backJumps === 0, 'progress never jumps backwards');
    check(turns.every((c) => c.now), `every turn announced (${turns.length})`);
    const nowMsgs = said.filter((s) => s.priority === 2 && !/Starting|paused|Resuming/.test(s.text));
    check(nowMsgs.every((s) => { const c = turns.find((c) => c.now && Math.abs(c.at - s.at) < 45); return !!c; }), 'turn instructions come just before the junction');
    const splits = said.filter((s) => /^\d+ kilometers?\./.test(s.text));
    check(Math.abs(splits.length - Math.floor(r.distance / 1000)) <= 1, `km splits (${splits.length})`);
    check(splits.slice(1).every((s) => /Last kilometer 5 minutes/.test(s.text)), 'split pace is ~5:33/km at 3 m/s');
    if (r.sights?.length) check(said.filter((s) => /^(On your|Just ahead)/.test(s.text)).length === r.sights.length, `all ${r.sights.length} sights called out`);
    if (r.type === 'outback') check(said.some((s) => /Turn around/.test(s.text)), 'turnaround announced');
    const heb = said.find((s) => s.langs.includes('he'));
    if (heb) check(heb.langs.includes('en'), `Hebrew street name spoken inside an English sentence: "${heb.text}"`);
  }
}

// Off route and back.
const [r] = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {}, terrain: 'any' });
const off = simulate(r, { detour: { from: 1500, to: 1800, off: 90 } });
if (process.env.DBG) off.said.forEach((s) => console.log("   dbg", Math.round(s.at), s.text));
console.log("   route", r.name, Math.round(r.distance), "finished", off.nav.finished, "progress", Math.round(off.nav.progress), "backJumps", off.backJumps);
const warn = off.said.filter((s) => /off the route/.test(s.text));
console.log('\nDetour: ' + off.said.filter((s) => /route/.test(s.text)).map((s) => s.text).join(' | '));
check(warn.length >= 1 && warn.length <= 3, 'off-route warning given (not spammed)');
check(/to your (left|right)|behind you|ahead of you/.test(warn[0]?.text), 'warning says which way the route is');
check(off.said.some((s) => s.text === 'Back on route.'), 'back-on-route confirmation');
check(off.nav.finished && off.backJumps === 0, 'still finishes after a detour');

// Bad GPS: wild fixes are ignored.
const bad = new Navigator(r, { speak: () => {} });
bad.start();
bad.update({ lat: r.latlngs[0][0], lon: r.latlngs[0][1], accuracy: 5 });
bad.update({ lat: r.latlngs[0][0] + 0.01, lon: r.latlngs[0][1], accuracy: 400 });
check(!bad.offRoute && bad.odometer === 0, 'inaccurate fixes are ignored');

// Laps at the track: lap counts are announced and the run finishes back at the start.
{
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {}, terrain: 'any' });
  const track = routes.places.find((p) => p.kind === 'track');
  const r = engine.routeAtPlace(track, { lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {} }); // 6 km: several laps
  const { nav, said, backJumps } = simulate(r, { noise: 3 });
  console.log(`\n${r.name} (${(r.distance / 1000).toFixed(2)} km, ${r.place.laps} laps): ` + said.filter((s) => /Lap|arrived|Turn/.test(s.text)).map((s) => s.text).join(' | '));
  check(nav.finished && backJumps === 0, 'lap route finishes without progress jumps');
  check(said.filter((s) => /^Lap \d+ of \d+\.$/.test(s.text)).length === r.place.laps, 'every lap announced once');
  check(said.some((s) => /^Lap 1 of/.test(s.text)) && said.findIndex((s) => /^Lap 1 of/.test(s.text)) < said.findIndex((s) => /^Lap 2 of/.test(s.text)), 'laps in order');
  check(said.some((s) => /onto the track/i.test(s.text)) && said.some((s) => /Laps done\. Head back the same way/.test(s.text)) && !said.some((s) => /Turn around/.test(s.text)), 'the track is announced in words: onto the track, laps done, head back');
}

// Rerouting: a runner 150 m off the line gets a new line from where they are that joins
// the old route further on; distance and time run so far carry on.
{
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {}, terrain: 'any' });
  const r = routes[0];
  const { rejoinRoute } = await import('../js/planner.js');
  const area = engine.area;
  let t = 0;
  const said = [];
  const nav = new Navigator(r, { speak: (parts) => said.push(parts.map((p) => p.text).join('')), now: () => t * 1000 });
  nav.start();
  // Run the first 800 m on the line, then step 150 m to the side and stay there.
  const sim = new SimulatedRun(r, { speed: 3, noise: 0 });
  while (sim.d < 800) { t += 2; nav.update(sim.step(2)); }
  const proj = makeProjection(r.latlngs[0][0], r.latlngs[0][1]);
  const here = sim.step(0);
  const [hx, hy] = proj.toXY(here.lat, here.lon);
  const off = proj.toLatLon(hx + 150, hy + 20);
  for (let k = 0; k < 12; k++) { t += 2; nav.update({ lat: off[0], lon: off[1], accuracy: 5 }); }
  check(nav.offRoute, 'runner 150 m off the line is off route');
  const joinIdx = nav.along.findIndex((a) => a >= nav.progress + 250);
  const fresh = rejoinRoute(area.graph, area.proj, { lat: off[0], lon: off[1] }, nav.route, joinIdx);
  check(!!fresh && fresh.latlngs.length > 2, 'a way back onto the route is found');
  if (fresh) {
    const d0 = Math.hypot(...(() => { const [x, y] = proj.toXY(fresh.latlngs[0][0], fresh.latlngs[0][1]); return [x - hx - 150, y - hy - 20]; })());
    check(d0 < 200, `the new line starts near the runner (${Math.round(d0)} m)`);
    check(fresh.cues[0].type === 'depart' && fresh.cues.every((c, i) => !i || c.at >= fresh.cues[i - 1].at - 1), 'cues start with a departure and stay in order');
    check(fresh.distance < r.distance && fresh.distance > r.distance - nav.progress - 500, `the new run is the rest of the old one plus the way back (${(fresh.distance / 1000).toFixed(2)} km)`);
    // Distance and time ran on while the runner was off the line; the new route must not touch them.
    const odoBefore = nav.odometer, elapsedBefore = nav.elapsed;
    const v = nav.reroute(fresh);
    check(!v.offRoute && nav.progress === 0 && nav.odometer === odoBefore && nav.elapsed === elapsedBefore, 'after rerouting: back on the line, progress restarts, distance and time carry on');
    check(said.some((x) => /^New route from here/.test(x)), 'the new route is announced');
    // Follow the new line to the end.
    const sim2 = new SimulatedRun(fresh, { speed: 3, noise: 0 });
    let steps = 0; while (!nav.finished && steps++ < 5000) { t += 2; nav.update(sim2.step(2)); }
    check(nav.finished, 'the run finishes on the new line');
  }
}

// Starting away from the route start: guided to it.
{
  const said = [];
  const nav = new Navigator(r, { speak: (p) => said.push(p.map((x) => x.text).join('')), now: () => 0 });
  nav.start();
  const [la, lo] = r.latlngs[0];
  // Stand ~150 m from the start in a direction that is not on the route.
  const away = [[0.0014, 0], [0, 0.0016], [-0.0014, 0], [0, -0.0016]]
    .map(([dla, dlo]) => ({ lat: la + dla, lon: lo + dlo }))
    .find((p) => { const [x, y] = nav.proj.toXY(p.lat, p.lon); return nav.snap(x, y, -Infinity, Infinity, 0).dist > 80; });
  nav.update({ ...away, accuracy: 5 });
  nav.update({ ...away, accuracy: 5 });
  check(said.some((t) => /Head to the start of the route\. It's \d+ meters (to the|ahead|behind|to your)/.test(t)), 'runner away from the start is told where it is'); check(!said.some((t) => /^In \d+ meters/.test(t)), 'no turn instructions while not on the route');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll navigation tests passed');
process.exit(failures ? 1 : 0);
