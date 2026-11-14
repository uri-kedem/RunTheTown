// The runner's profile and run records (pure parts; the picture and the store need a browser).
// Run: node tests/test-journal.mjs
import { loadProfile, saveProfile, simplifyTrack, makeRun, matchShare, runGpx, usualPace } from '../js/journal.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const store = new Map();
const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
check(loadProfile(storage) === null, 'no profile at first');
const p = saveProfile({ name: '  Uri Kedem ', email: 'uri@example.com', photo: 'data:image/jpeg;base64,xx' }, storage);
const back = loadProfile(storage);
check(back.name === 'Uri Kedem' && back.photo === p.photo && back.since && !back.skipped, 'profile round-trips, trimmed');
check(!('email' in back) && !JSON.parse(store.get('rtt-profile')).email, 'an e-mail address is neither kept nor stored');
saveProfile({ name: '', photo: null, skipped: true }, storage);
check(loadProfile(storage).skipped === true, 'skipping is remembered');

// A straight 1 km track at 1 m steps: thinned to a few hundred points, ends kept.
const pts = [];
for (let i = 0; i <= 1000; i++) pts.push([32.08 + i / 110574, 34.78]);
const thin = simplifyTrack(pts);
check(thin.length <= 600 && thin[0] === pts[0] && thin[thin.length - 1] === pts[pts.length - 1] && thin.length > 50, `track thinned to ${thin.length} points, ends kept`);
check(simplifyTrack([[1, 1]]).length === 1 && simplifyTrack(null).length === 0, 'tiny or missing tracks are fine');

const run = makeRun({ route: { name: 'Park loop to the west', type: 'loop', distance: 5000, latlngs: pts.filter((_, i) => i % 20 === 0) }, track: pts, odometer: 4980, elapsed: 1500000, startedAt: '2026-11-06T06:00:00.000Z', start: { lat: 32.08, lon: 34.78, label: 'Hotel' }, settings: { units: 'km' }, finished: true });
check(run.id.startsWith('2026-11-06T06:00:00.000Z-') && run.distance === 4980 && run.elapsed === 1500000 && Math.abs(run.pace - 301.2) < 0.1 && run.name === 'Park loop to the west' && run.finished && run.start.label === 'Hotel' && run.track.length <= 600 && run.picture === null, 'run record from a live run');
check(makeRun({ route: null, track: [], odometer: 20, elapsed: 10000, startedAt: 'x', start: null, settings: null }).pace === null, 'no pace for a few metres');
// On the planned line: a track along the line, then 100 m off for the second half.
const line = pts.filter((_, i) => i % 20 === 0);
const half = pts.map(([la, lo], i) => (i < 500 ? [la, lo] : [la, lo + 100 / 111320]));
check(matchShare(pts, line) > 0.95 && Math.abs(matchShare(half, line) - 0.5) < 0.05 && matchShare([], line) === null, 'share of the track on the planned line');
check(run.onPlan > 0.95, 'the run record carries it');

// GPX: one track, every point with a timestamp. Fixes with a time (seconds since the start)
// keep it; older fixes without one get the time of the distance covered at the average pace.
{
  const timed = makeRun({ route: { name: 'Sea & <park>', type: 'loop', distance: 1000, latlngs: line }, track: pts.map((p, i) => [p[0], p[1], Math.round(i * 0.3)]), odometer: 1000, elapsed: 300000, startedAt: '2026-11-06T06:00:00.000Z', start: null, settings: { units: 'km' } });
  const gpx = runGpx(timed);
  const times = [...gpx.matchAll(/<time>([^<]+)<\/time>/g)].map((m) => m[1]);
  const trkpts = (gpx.match(/<trkpt /g) || []).length;
  check(gpx.startsWith('<?xml') && gpx.includes('<gpx version="1.1"') && gpx.includes('<name>Sea &amp; &lt;park&gt;</name>') && gpx.includes('<type>running</type>'), 'GPX 1.1 with the run name escaped');
  check(trkpts === timed.track.length && times.length === trkpts + 1 && times[1] === '2026-11-06T06:00:00.000Z' && times[times.length - 1] === '2026-11-06T06:05:00.000Z', `every point has its own time (${trkpts} points, last at the end of the run)`);
  const old = runGpx(run); // the record above: no time on the fixes, 25 minutes over 1 km
  const oldTimes = [...old.matchAll(/<time>([^<]+)<\/time>/g)].map((m) => Date.parse(m[1]));
  const mid = oldTimes[Math.floor((oldTimes.length + 1) / 2)];
  check(oldTimes[1] === Date.parse(run.time) && oldTimes[oldTimes.length - 1] === Date.parse(run.time) + 1500000 && Math.abs(mid - Date.parse(run.time) - 750000) < 60000, 'fixes without a time are spread over the run at the average pace');
  check(oldTimes.every((t, i) => !i || t >= oldTimes[i - 1]), 'timestamps never go backwards');
  const planned = runGpx({ name: 'Plan', time: '2026-11-06T06:00:00.000Z', elapsed: 0, track: [], latlngs: line });
  check((planned.match(/<trkpt /g) || []).length === line.length, 'a run without a GPS track exports the planned line');
}

// The usual pace: the median of the last ten real runs; a gentle default before any.
{
  const mk = (i, pace, distance = 5000) => ({ time: `2026-10-${String(1 + i).padStart(2, '0')}T06:00:00.000Z`, pace, distance });
  check(usualPace([]) === 360 && usualPace(null) === 360, 'no runs yet: 6:00 min/km');
  check(usualPace([mk(1, 330), mk(2, 20, 300)]) === 330, 'a few metres do not count');
  const many = [mk(1, 900), ...Array.from({ length: 10 }, (_, i) => mk(2 + i, 300 + i * 2))]; // an old slow walk, then ten runs
  check(usualPace(many) === 309, `median of the last ten runs (${usualPace(many)})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll journal tests passed');
process.exit(failures ? 1 : 0);
