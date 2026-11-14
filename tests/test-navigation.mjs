// Live-guidance tests with simulated GPS. Run: node tests/test-navigation.mjs
import { RouteEngine } from '../js/engine.js';
import { homeRoute } from '../js/planner.js';
import { Navigator, SimulatedRun, Voice, roundDist, paceShort, distText, paceText, lenText, MILE } from '../js/navigation.js';
import { loadSettings, saveSettings, houseVoices, DEFAULTS } from '../js/settings.js';
import { syntheticOverpass, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';
import { makeProjection } from '../js/geo.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const engine = new RouteEngine({ fetchImpl: makeMockMapBackend(syntheticOverpass()), fetchElevationImpl: async () => null, useCache: false, scanPauseMs: 0, cityScan: true });

check(roundDist(147) === 150 && roundDist(42) === 40 && roundDist(1234) === 1200, 'distance rounding');
check(paceShort(332) === '5:32', 'pace format');

// An out-and-back: the way home runs over the way out, so the first fix is as near the end of
// the route as its start. The run must begin at the start, whichever side the GPS jitter falls.
{
  const A = [32.08, 34.78], B = [32.08, 34.79]; // 940 m east and back
  const line = [];
  for (let i = 0; i <= 20; i++) line.push([A[0], A[1] + ((B[1] - A[1]) * i) / 20]);
  const outback = { name: 'Out & back', type: 'outback', latlngs: [...line, ...line.slice(0, -1).reverse()], cues: [], sights: [] };
  for (const side of [1, -1]) {
    const nav = new Navigator(outback, { now: () => 1000 });
    nav.start();
    nav.update({ lat: A[0] + (side * 2) / 110574, lon: A[1] + 15 / (111320 * Math.cos((A[0] * Math.PI) / 180)), accuracy: 5 });
    check(nav.begun && nav.progress < 60 && !nav.routeDone, `out-and-back joins at its start, jitter ${side > 0 ? 'north' : 'south'} (progress ${Math.round(nav.progress)} of ${Math.round(nav.total)})`);
  }
}

function simulate(route, { detour = null, speed = 3.0, dt = 2, noise = 4 } = {}) {
  let t = 0;
  const said = [];
  const sounds = [];
  const nav = new Navigator(route, { speak: (parts, o) => said.push({ t, at: nav.progress, text: parts.map((p) => p.text).join(''), langs: parts.map((p) => p.lang), ...o }), sound: (name) => sounds.push({ name, t }), now: () => t * 1000 });
  const sim = new SimulatedRun(route, { speed, noise });
  nav.start();
  let prev = 0, backJumps = 0, steps = 0;
  const proj = makeProjection(route.latlngs[0][0], route.latlngs[0][1]);
  while (!nav.routeDone && steps++ < 20000) {
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
  return { nav, said, sounds, backJumps, t };
}

for (const [km, prefs] of [[5, {}], [8, { sights: true }], [10, { water: true }]]) {
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: km, prefs, terrain: 'any' });
  for (const r of routes) {
    const { nav, said, backJumps, t } = simulate(r);
    console.log(`\n${r.name} (${r.type}, ${(r.distance / 1000).toFixed(2)} km): ${said.length} messages, ${Math.round(t / 60)} min`);
    said.slice(0, 7).forEach((s) => console.log(`    ${Math.round(s.at)}m  ${s.text}`));
    console.log(`    … ${said[said.length - 1].text}`);
    const turns = nav.cues.filter((c) => c.type !== 'arrive');
    check(nav.routeDone, 'route completed at the start');
    check(said.some((s) => /^Route complete/.test(s.text)) && !nav.finished, 'route completion is announced; the run itself goes on');
    check(!said.some((s) => / to go\./.test(s.text)), 'splits say distance and pace only, never what is left');
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
console.log("   route", r.name, Math.round(r.distance), "finished", off.nav.routeDone, "progress", Math.round(off.nav.progress), "backJumps", off.backJumps);
console.log('\nDetour: ' + off.said.filter((s) => /route/.test(s.text)).map((s) => s.text).join(' | '));
check(!off.said.some((s) => /off the route/.test(s.text)), 'no words about being off route');
check(off.sounds.filter((x) => x.name === 'offroute').length === 1, 'one recalculating chime when leaving the line');
check(off.said.some((s) => s.text === 'Back on route.'), 'back-on-route confirmation');
check(off.nav.routeDone && off.backJumps === 0, 'still finishes after a detour');

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
  check(nav.routeDone && backJumps === 0, 'lap route finishes without progress jumps');
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
  // 150 m straight off to the side of the road (not back along it, which would read as a turnaround).
  const side = ((nav.segHeading(nav.seg) + 90) * Math.PI) / 180;
  const off = proj.toLatLon(hx + 150 * Math.sin(side), hy + 150 * Math.cos(side));
  for (let k = 0; k < 12; k++) { t += 2; nav.update({ lat: off[0], lon: off[1], accuracy: 5 }); }
  check(nav.offRoute, 'runner 150 m off the line is off route');
  const joinIdx = nav.along.findIndex((a) => a >= nav.progress + 250);
  const fresh = rejoinRoute(area.graph, area.proj, { lat: off[0], lon: off[1] }, nav.route, joinIdx);
  check(!!fresh && fresh.latlngs.length > 2, 'a way back onto the route is found');
  if (fresh) {
    const d0 = Math.hypot(...(() => { const [x, y] = proj.toXY(fresh.latlngs[0][0], fresh.latlngs[0][1]); const [ox, oy] = proj.toXY(off[0], off[1]); return [x - ox, y - oy]; })());
    check(d0 < 200, `the new line starts near the runner (${Math.round(d0)} m)`);
    check(fresh.cues[0].type === 'depart' && fresh.cues.every((c, i) => !i || c.at >= fresh.cues[i - 1].at - 1), 'cues start with a departure and stay in order');
    check(fresh.distance < r.distance && fresh.distance > r.distance - nav.progress - 500, `the new run is the rest of the old one plus the way back (${(fresh.distance / 1000).toFixed(2)} km)`);
    // Distance and time ran on while the runner was off the line; the new route must not touch them.
    const odoBefore = nav.odometer, elapsedBefore = nav.elapsed;
    const v = nav.reroute(fresh);
    check(!v.offRoute && nav.progress === 0 && nav.odometer === odoBefore && nav.elapsed === elapsedBefore, 'after rerouting: back on the line, progress restarts, distance and time carry on');
    check(said.some((x) => /^Head (north|south|east|west)/.test(x)) && !said.some((x) => /New route/.test(x)), 'the new route is announced as a plain instruction');
    // Follow the new line to the end.
    const sim2 = new SimulatedRun(fresh, { speed: 3, noise: 0 });
    let steps = 0; while (!nav.routeDone && steps++ < 5000) { t += 2; nav.update(sim2.step(2)); }
    check(nav.routeDone, 'the run finishes on the new line');
  }
}

// Starting away from the route's first point. Close to the line (under 300 m): nothing is
// said, the run begins where the runner meets the route. Far away: one hint, no nagging.
{
  const said = [];
  const nav = new Navigator(r, { speak: (p) => said.push(p.map((x) => x.text).join('')), now: () => 0 });
  nav.start();
  const [la, lo] = r.latlngs[0];
  const offLine = (m) => [[m, 0], [0, m], [-m, 0], [0, -m]]
    .map(([dx, dy]) => { const [a, b] = nav.proj.toLatLon(dx, dy); return { lat: a, lon: b }; })
    .find((p) => { const [x, y] = nav.proj.toXY(p.lat, p.lon); return nav.snap(x, y, -Infinity, Infinity, 0).dist > m * 0.6; });
  const near = offLine(150);
  let v = nav.update({ ...near, accuracy: 5 }); v = nav.update({ ...near, accuracy: 5 });
  check(v.joining && !v.offRoute && said.length === 1 && /^Starting your/.test(said[0]), '150 m from the line: no "head to the start", the screen shows the way to the line');
  // Meet the route 400 m along it (not at its first point): the run begins there.
  const [mx, my] = (() => { let i = 0; while (nav.along[i + 1] < 400) i++; return nav.xy[i]; })();
  const [mla, mlo] = nav.proj.toLatLon(mx, my);
  v = nav.update({ lat: mla, lon: mlo, accuracy: 5 });
  check(nav.begun && !v.joining && Math.abs(nav.progress - nav.along.find((a) => a >= 400 - 1e-6 && a <= 400 + 400)) < 200, `the run begins where the runner met the route (${Math.round(nav.progress)} m along)`);
  check(!said.some((t) => /Head to the start/.test(t)), 'the runner was never urged to the start point');
  // Far from the route: one hint only.
  const said2 = [];
  const nav2 = new Navigator(r, { speak: (p) => said2.push(p.map((x) => x.text).join('')), now: () => 0 });
  nav2.start();
  const far = offLine(600);
  for (let k = 0; k < 4; k++) nav2.update({ lat: far.lat + k * 0.00005, lon: far.lon, accuracy: 5 });
  check(said2.filter((t) => /Head to the start of the route/.test(t)).length === 1 && !said2.some((t) => /^In \d+ meters/.test(t)), 'far from the route: told once where it is, no turn instructions');
}

// Voice picker: the phone's English voices, well-known ones first, enhanced over compact,
// the runner's choice applied and previewed.
{
  const mk = (name, lang, uri, local = true) => ({ name, lang, voiceURI: uri, localService: local });
  const voices = [
    mk('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha'), mk('Samantha', 'en-US', 'com.apple.voice.enhanced.en-US.Samantha'),
    mk('Carmit', 'he-IL', 'com.apple.voice.compact.he-IL.Carmit'), mk('Daniel', 'en-GB', 'com.apple.voice.compact.en-GB.Daniel'),
    mk('Karen', 'en-AU', 'com.apple.voice.compact.en-AU.Karen'), mk('Fred', 'en-US', 'com.apple.speech.synthesis.voice.Fred'),
    mk('Moira', 'en-IE', 'com.apple.voice.compact.en-IE.Moira'), mk('Aaron', 'en-US', 'com.apple.ttsbundle.siri_Aaron_en-US_compact'),
    mk('Google US English', 'en-US', 'Google US English', false), mk('Rishi', 'en-IN', 'com.apple.voice.compact.en-IN.Rishi'),
  ];
  const spoken = [];
  globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  const synth = { getVoices: () => voices, speak: (u) => spoken.push(u), cancel() {}, addEventListener() {} };
  const v = new Voice(synth);
  const opts = v.options(5);
  console.log('   voices offered: ' + opts.map((o) => `${o.name} (${o.accent})`).join(', '));
  check(opts.length === 5 && opts[0].name === 'Samantha' && opts[0].uri.includes('enhanced'), 'five voices, Samantha enhanced first');
  check(opts.map((o) => o.name).join() === 'Samantha,Daniel,Karen,Aaron,Moira', 'well-known phone voices, one per name, in the house order');
  check(opts[0].current && opts[1].accent === 'British', 'the current voice is marked and accents are named');
  v.setVoice(opts[2].uri);
  check(v.voices.en.name === 'Karen' && v.options(5).find((o) => o.current).name === 'Karen', 'the chosen voice is used and shown as current');
  v.preview(opts[1].uri);
  check(spoken.length === 1 && spoken[0].voice.name === 'Daniel' && /turn left/.test(spoken[0].text), 'preview speaks a sample cue with that voice');
  v.say([{ text: 'Turn right.' }]);
  check(spoken[spoken.length - 1].voice.name === 'Karen', 'directions use the chosen voice');
  v.setVoice(null);
  check(v.voices.en.name === 'Samantha', 'clearing the choice goes back to the default');
  delete globalThis.SpeechSynthesisUtterance;
}

// Turning around on purpose. Out-and-back: the runner heads back before the turnaround point
// and the guide switches to the return leg. Loop: the app is asked for the way back home.
{
  const { backRoute } = await import('../js/planner.js');
  const posOn = (route) => {
    const proj = makeProjection(route.latlngs[0][0], route.latlngs[0][1]);
    const xy = route.latlngs.map(([a, b]) => proj.toXY(a, b));
    const along = [0];
    for (let i = 1; i < xy.length; i++) along.push(along[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    return (d) => {
      let i = 0; while (i < xy.length - 2 && along[i + 1] < d) i++;
      const L = along[i + 1] - along[i] || 1; const t = Math.min(1, Math.max(0, (d - along[i]) / L));
      const [la, lo] = proj.toLatLon(xy[i][0] + (xy[i + 1][0] - xy[i][0]) * t, xy[i][1] + (xy[i + 1][1] - xy[i][1]) * t);
      return { lat: la, lon: lo, accuracy: 5 };
    };
  };
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {}, terrain: 'any' });
  const ob = routes.find((x) => x.type === 'outback');
  const loop = routes.find((x) => x.type === 'loop') || (await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 8, prefs: { sights: true }, terrain: 'any' })).find((x) => x.type === 'loop');
  check(!!ob && !!loop, 'an out-and-back and a loop to test turnarounds on');
  if (ob) {
    const said = []; let t = 0;
    const nav = new Navigator(ob, { speak: (p) => said.push(p.map((x) => x.text).join('')), now: () => t * 1000 });
    nav.start();
    const at = posOn(ob);
    let d = 0;
    while (d < 1000) { d += 6; t += 2; nav.update(at(d)); }
    const total = nav.total;
    let v = null;
    for (let k = 0; k < 60; k++) { d -= 6; t += 2; v = nav.update(at(d)); if (nav.turnarounds) break; }
    const back = 1000 - d;
    check(nav.turnarounds === 1 && back <= 120, `turning back on an out-and-back is noticed after ${Math.round(back)} m`);
    check(Math.abs(nav.progress - (total - d)) < 60 && !v.offRoute, 'progress jumps to the return leg at the matching point');
    check(said.some((x) => /^Turned around\? Following the route back/.test(x)) && !said.some((x) => /off the route/.test(x)), 'the switch is announced, no off-route warning');
    let steps = 0; while (!nav.routeDone && d > 0 && steps++ < 2000) { d -= 6; t += 2; nav.update(at(d)); }
    check(nav.routeDone, 'the run finishes back at the start on the return leg');
  }
  if (loop) {
    const said = []; let t = 0; let asked = null;
    const nav = new Navigator(loop, { speak: (p) => said.push(p.map((x) => x.text).join('')), now: () => t * 1000, onTurnaround: (w) => { asked = w; return true; } });
    nav.start();
    const at = posOn(loop);
    let d = 0;
    while (d < 1200) { d += 6; t += 2; nav.update(at(d)); }
    for (let k = 0; k < 60 && !asked; k++) { d -= 6; t += 2; nav.update(at(d)); }
    check(!!asked && asked.seg > 0, 'turning back on a loop asks the app for the way home');
    const fix = at(d);
    const way = backRoute(engine.area.graph, engine.area.proj, fix, loop, asked.seg);
    check(!!way && way.type === 'back' && Math.abs(way.distance - d) < 300 && way.cues[0].type === 'depart', `the way back is the part already run (${way && (way.distance / 1000).toFixed(2)} km)`);
    const end = way.latlngs[way.latlngs.length - 1];
    check(Math.abs(end[0] - loop.latlngs[0][0]) < 1e-4 && Math.abs(end[1] - loop.latlngs[0][1]) < 1e-4, 'it ends at the start');
    nav.reroute(way, { say: false });
    const at2 = posOn(way); let d2 = 0, steps = 0;
    while (!nav.routeDone && steps++ < 2000) { d2 += 6; t += 2; nav.update(at2(d2)); }
    check(nav.routeDone, 'the run finishes at the start the way it came');
  }
}

// Settings: miles, quiet mode, split toggles, warning distance.
{
  check(distText(120, 'mi') === '400 feet' && distText(420, 'mi') === 'a quarter mile' && distText(1609, 'mi') === 'one mile' && distText(3300, 'mi') === '2.1 miles', 'distances spoken in feet and miles');
  check(paceText(300, 'mi') === '8 minutes 3 seconds per mile' && lenText(MILE * 2, 'mi') === '2.0 mi' && lenText(200, 'mi') === '660 ft', 'pace per mile and lengths on screen');
  const said = []; let t = 0;
  const nav = new Navigator(r, { speak: (p) => said.push(p.map((x) => x.text).join('')), now: () => t * 1000, units: 'mi', warnM: 300 });
  nav.start();
  const sim = new SimulatedRun(r, { speed: 3, noise: 0 });
  let steps = 0; while (!nav.routeDone && steps++ < 5000) { t += 2; nav.update(sim.step(2)); }
  check(/Starting your \d\.\d mile run/.test(said[0]), 'run summary in miles');
  check(said.some((x) => /^1 mile\. Last mile \d+ minutes/.test(x)) && said.some((x) => /^2 miles\./.test(x)) && !said.some((x) => /kilometer/.test(x)), 'splits every mile, nothing in kilometres');
  check(said.some((x) => /^In (\d+ feet|a quarter mile), turn/.test(x)), 'turns announced in feet');
  nav.finish();
  check(said.some((x) => /Run finished\. \d\.\d miles in/.test(x)) && nav.finished, 'finish in miles, on End run');
  const quiet = []; t = 0;
  const nq = new Navigator(r, { speak: (p) => quiet.push(p.map((x) => x.text).join('')), now: () => t * 1000, quiet: true });
  nq.start(); const s2 = new SimulatedRun(r, { speed: 3, noise: 0 }); steps = 0; while (!nq.routeDone && steps++ < 5000) { t += 2; nq.update(s2.step(2)); }
  check(!quiet.some((x) => /^\d kilometers?\./.test(x)) && quiet.some((x) => /^Turn /.test(x)), 'quiet mode: no splits, turns still spoken');
  const noSplit = []; t = 0;
  const ns = new Navigator(r, { speak: (p) => noSplit.push(p.map((x) => x.text).join('')), now: () => t * 1000, splits: false });
  ns.start(); const s3 = new SimulatedRun(r, { speed: 3, noise: 0 }); steps = 0; while (!ns.routeDone && steps++ < 5000) { t += 2; ns.update(s3.step(2)); }
  check(!noSplit.some((x) => /^\d kilometers?\./.test(x)) && noSplit.length < quiet.length + 5, 'splits can be turned off on their own');
  // settings storage
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  check(JSON.stringify(loadSettings(storage)) === JSON.stringify(DEFAULTS), 'defaults when nothing is saved');
  saveSettings({ ...DEFAULTS, units: 'mi', warnM: 300, quiet: true, voice: 'u-zoe', junk: 1 }, storage);
  const back = loadSettings(storage);
  check(back.units === 'mi' && back.warnM === 300 && back.quiet && back.voice === 'u-zoe' && !('junk' in back), 'settings round-trip, unknown keys dropped');
  storage.setItem('rtt-settings', '{"units":"furlongs","warnM":999}'); const bad = loadSettings(storage);
  check(bad.units === 'km' && bad.warnM === 200, 'bad values fall back to defaults');
  storage.setItem('rtt-settings', '{}'); storage.setItem('rtt-voice', 'u-old');
  check(loadSettings(storage).voice === 'u-old', 'the old voice setting is carried over');
  const vs = [{ name: 'Zoe', lang: 'en-US', voiceURI: 'c.zoe' }, { name: 'Zoe (Premium)', lang: 'en-US', voiceURI: 'com.apple.voice.premium.en-US.Zoe' }, { name: 'Tom', lang: 'en-US', voiceURI: 'c.tom' }, { name: 'Tomas', lang: 'de-DE', voiceURI: 'c.tomas' }];
  const h = houseVoices(vs);
  check(h[0].voice.voiceURI.includes('premium') && h[0].quality === 'premium' && h[1].voice.voiceURI === 'c.tom' && h[1].quality === 'standard', 'house voices: Zoe Premium over compact, Tom found, Tomas not');
  check(houseVoices([])[0].voice === null, 'house voices missing are reported');
}

// Past the end of the route: the run goes on, distance and splits keep counting, nothing
// about being off route; standing still afterwards adds nothing.
{
  const [r] = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 5, prefs: {}, terrain: 'any' });
  const said = []; const sounds = []; let t = 0;
  const nav = new Navigator(r, { speak: (p) => said.push(p.map((x) => x.text).join('')), sound: (n) => sounds.push(n), now: () => t * 1000 });
  nav.start();
  const sim = new SimulatedRun(r, { speed: 3, noise: 0 });
  let steps = 0; while (!nav.routeDone && steps++ < 5000) { t += 2; nav.update(sim.step(2)); }
  const odoDone = nav.odometer;
  // Keep running 1.5 km straight on past the start, with GPS noise.
  const proj = makeProjection(r.latlngs[0][0], r.latlngs[0][1]);
  const end = sim.step(0);
  let [ex, ey] = proj.toXY(end.lat, end.lon);
  for (let i = 0; i < 250; i++) { t += 2; ex += 6; const [la, lo] = proj.toLatLon(ex + (Math.random() - 0.5) * 6, ey + (Math.random() - 0.5) * 6); nav.update({ lat: la, lon: lo, accuracy: 5 }); }
  const extra = nav.odometer - odoDone;
  check(extra > 1300 && extra < 1700, `distance keeps counting past the end (${Math.round(extra)} m for 1500 m run)`);
  check(!nav.finished && !nav.offRoute && sounds.length === 0, 'past the end: no off-route chime, the run is not over');
  check(said.filter((x) => /^\d+ kilometers?\./.test(x)).length >= Math.floor((nav.odometer) / 1000), 'splits keep coming past the end');
  // Then stand still for 5 minutes with 4 m jitter.
  const odoStop = nav.odometer;
  for (let i = 0; i < 150; i++) { t += 2; const [la, lo] = proj.toLatLon(ex + (Math.random() - 0.5) * 12, ey + (Math.random() - 0.5) * 12); nav.update({ lat: la, lon: lo, accuracy: 8 }); }
  check(nav.odometer - odoStop < 60, `standing still adds nothing (${Math.round(nav.odometer - odoStop)} m in 5 min)`);
  const elapsedBefore = nav.elapsed;
  nav.finish();
  t += 60;
  nav.tick();
  check(nav.finished && nav.elapsed === elapsedBefore && said.some((x) => /^Run finished/.test(x)), 'End run stops the clock and sums up');
}

// A detour on the way out of an out-and-back: the way home follows what was actually run.
{
  const { outbackReroute, rejoinRoute } = await import('../js/planner.js');
  const area = engine.area;
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 8, prefs: {}, terrain: 'any' });
  const ob = routes.find((x) => x.type === 'outback') || (await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {}, terrain: 'any' })).find((x) => x.type === 'outback');
  check(!!ob, 'an out-and-back to detour on');
  if (ob) {
    let t = 0;
    const nav = new Navigator(ob, { speak: () => {}, now: () => t * 1000 });
    nav.start();
    const sim = new SimulatedRun(ob, { speed: 3, noise: 0 });
    const track = [];
    while (sim.d < 900) { t += 2; const f = sim.step(2); track.push([f.lat, f.lon]); nav.update(f); }
    const proj = makeProjection(ob.latlngs[0][0], ob.latlngs[0][1]);
    const here = sim.step(0);
    const [hx, hy] = proj.toXY(here.lat, here.lon);
    const side = ((nav.segHeading(nav.seg) + 90) * Math.PI) / 180;
    const off = proj.toLatLon(hx + 150 * Math.sin(side), hy + 150 * Math.cos(side));
    for (let k = 0; k < 12; k++) { t += 2; track.push(off); nav.update({ lat: off[0], lon: off[1], accuracy: 5 }); }
    const joinIdx = nav.along.findIndex((a) => a >= nav.progress + 250);
    const fresh = outbackReroute(area.graph, area.proj, { lat: off[0], lon: off[1] }, nav.route, joinIdx, track);
    check(!!fresh, 'a matched out-and-back reroute is found');
    if (fresh) {
      const plain = rejoinRoute(area.graph, area.proj, { lat: off[0], lon: off[1] }, nav.route, joinIdx);
      const d = (a, b) => { const [x1, y1] = proj.toXY(a[0], a[1]); const [x2, y2] = proj.toXY(b[0], b[1]); return Math.hypot(x1 - x2, y1 - y2); };
      check(fresh.type === 'outback' && fresh.backMatched && d(fresh.latlngs[fresh.latlngs.length - 1], ob.latlngs[0]) < 30, 'it is still an out-and-back ending at the start');
      check(d(fresh.latlngs[0], off) < 200, 'it starts near the runner');
      // The last part of the new route is the first part of the run, backwards: every one of
      // the first 900 m of track points lies near the tail of the new line.
      const tail = fresh.latlngs.slice(-Math.ceil(fresh.latlngs.length / 2));
      const near = track.slice(0, 20).every((pt) => tail.some((q) => d(pt, q) < 60) || tail.some((q, i) => i && segDist(pt, tail[i - 1], q) < 40));
      check(near, 'the way home follows the way actually run out');
      // The planned stretch the runner skipped (between leaving and joining) is not run home.
      const skipped = ob.latlngs.slice(nav.seg + 2, joinIdx - 1);
      const homeOnSkipped = skipped.length ? skipped.filter((pt) => tail.some((q, i) => i && segDist(pt, tail[i - 1], q) < 15)).length / skipped.length : 0;
      check(homeOnSkipped < 0.5, `the skipped stretch is not on the way home (${Math.round(homeOnSkipped * 100)}% of it)`);
      check(Math.abs(fresh.distance - (plain?.distance ?? fresh.distance)) < 1500, `the matched route is about as long as a plain rejoin (${(fresh.distance / 1000).toFixed(2)} vs ${((plain?.distance ?? 0) / 1000).toFixed(2)} km)`);
      check(fresh.cues.some((c) => c.type === 'uturn' || /turn around/i.test(c.text || '')), 'the turnaround is still called');
      const v = nav.reroute(fresh, { say: false });
      check(!v.offRoute && nav.progress === 0, 'the navigator takes the new line');
      function segDist(p, a, b) {
        const [px, py] = proj.toXY(p[0], p[1]); const [ax, ay] = proj.toXY(a[0], a[1]); const [bx, by] = proj.toXY(b[0], b[1]);
        const dx = bx - ax, dy = by - ay; const L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        return Math.hypot(px - ax - u * dx, py - ay - u * dy);
      }
    }
  }
}

// "Take me back": from 40% along a loop, the shortest way to the start on the planner's
// streets, shorter than finishing the loop, ending at the start, with turn cues.
{
  const [r] = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {}, terrain: 'any' });
  const { graph: g, proj } = engine.area;
  const pts = r.latlngs;
  let d = 0, k = 1;
  for (; k < pts.length && d < r.distance * 0.4; k++) d += Math.hypot((pts[k][0] - pts[k - 1][0]) * 110574, (pts[k][1] - pts[k - 1][1]) * 111320 * Math.cos((pts[k][0] * Math.PI) / 180));
  const here = { lat: pts[k][0], lon: pts[k][1] };
  const home = homeRoute(g, proj, here, r);
  const end = home?.latlngs[home.latlngs.length - 1];
  const endGap = end ? Math.hypot((end[0] - pts[0][0]) * 110574, (end[1] - pts[0][1]) * 111320 * Math.cos((end[0] * Math.PI) / 180)) : Infinity;
  check(home && home.home && home.type === 'back' && home.distance < r.distance - d && endGap < 40 && home.cues.length >= 1, `way home: ${home ? Math.round(home.distance) : '-'} m instead of ${Math.round(r.distance - d)} m left, ends ${Math.round(endGap)} m from the start, ${home?.cues.length} cues`);
  check(homeRoute(g, proj, { lat: pts[0][0], lon: pts[0][1] }, r) === null, 'already at the start: nothing to do');
  // After a reroute the line begins where the runner rejoined it; the way home still goes to the run's start.
  const rerouted = { ...r, latlngs: r.latlngs.slice(k) };
  const home2 = homeRoute(g, proj, here, rerouted, { start: { lat: pts[0][0], lon: pts[0][1] } });
  check(home2 && Math.abs(home2.distance - home.distance) < 1 && homeRoute(g, proj, here, rerouted) === null, 'a rerouted line still leads home to the start the app remembers');
  // A navigator switched to it carries on: distance so far kept, the rest of the run is the way home.
  const nav = new Navigator(r, { now: () => 1000 });
  nav.start();
  nav.update({ lat: pts[0][0], lon: pts[0][1], accuracy: 5 });
  nav.odometer = 2400;
  const v = nav.reroute(home, { say: false });
  check(Math.abs(nav.total - home.distance) < 0.02 * home.distance && nav.odometer === 2400 && !nav.routeDone && nav.total - nav.progress > 0, `the run goes on along the way home (${Math.round(nav.total)} m to run, ${Math.round(home.distance)} m planned, remaining ${v.remaining})`);
}

// A sight's story (from Wikipedia, arriving after the run began) is read after the call-out.
{
  const A = [32.08, 34.78];
  const line = [];
  for (let i = 0; i <= 20; i++) line.push([A[0], A[1] + (0.01 * i) / 20]);
  const sight = { name: 'Old Lighthouse', kind: 'lighthouse', lat: A[0] + 0.0002, lon: A[1] + 0.005, at: 470 };
  const route = { name: 'Straight', type: 'loop', latlngs: line, cues: [], sights: [sight] };
  const said = [];
  const nav = new Navigator(route, { now: () => 1000, speak: (parts) => said.push(parts.map((p) => p.text).join('')) });
  nav.start();
  sight.story = 'The Old Lighthouse was built in 1868 and guided ships into the harbour for a century.';
  for (let m = 0; m <= 500; m += 50) nav.update({ lat: A[0], lon: A[1] + m / (111320 * Math.cos((A[0] * Math.PI) / 180)), accuracy: 5 });
  const i = said.findIndex((t) => /Old Lighthouse/.test(t) && /left|right|ahead/i.test(t));
  check(i >= 0 && said[i + 1] === sight.story, `the story follows the call-out (${said[i + 1]})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll navigation tests passed');
process.exit(failures ? 1 : 0);
