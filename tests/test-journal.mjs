// The runner's profile and run records (pure parts; the picture and the store need a browser).
// Run: node tests/test-journal.mjs
import { loadProfile, saveProfile, validEmail, simplifyTrack, makeRun, matchShare } from '../js/journal.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const store = new Map();
const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
check(loadProfile(storage) === null, 'no profile at first');
const p = saveProfile({ name: '  Uri Kedem ', email: 'uri@example.com', photo: 'data:image/jpeg;base64,xx' }, storage);
const back = loadProfile(storage);
check(back.name === 'Uri Kedem' && back.email === 'uri@example.com' && back.photo === p.photo && back.since && !back.skipped, 'profile round-trips, trimmed');
saveProfile({ name: '', email: '', photo: null, skipped: true }, storage);
check(loadProfile(storage).skipped === true, 'skipping is remembered');
check(validEmail('a@b.co') && !validEmail('a@b') && !validEmail('nope') && !validEmail(''), 'e-mail check');

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

console.log(failures ? `\n${failures} FAILED` : '\nAll journal tests passed');
process.exit(failures ? 1 : 0);
