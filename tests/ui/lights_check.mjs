// A check against the real world, run by hand (it needs the network):
//   node tests/ui/lights_check.mjs [lat lon [radius-m]]
// Loads a real area, asks Overpass for its mapped traffic lights, and compares them with
// the lights the graph guesses from the streets alone (Graph.likelySignals), which is what
// the planner falls back on when the lights cannot be fetched. Prints how many guesses sit
// on a real light and how many real light junctions the guess finds.
import { RouteEngine } from '../../js/engine.js';
import { fetchStops, STOP } from '../../js/osm.js';

const [lat, lon, radius] = [Number(process.argv[2] || 32.0800), Number(process.argv[3] || 34.7800), Number(process.argv[4] || 3000)];
const NEAR_M = 35; // a guess and a light this close are the same junction

const engine = new RouteEngine({ useCache: false, fetchElevationImpl: async () => null, fetchLandcoverImpl: async () => null });
const area = await engine.loadArea(lat, lon, radius, () => {});
const g = area.graph;
let stops = null;
for (let i = 0; i < 4 && !stops; i++) stops = await fetchStops(lat, lon, radius, { timeoutMs: 70000 });
if (!stops) { console.log('The street-data servers did not answer: nothing to compare with. Try again later.'); process.exit(2); }

const inArea = ([x, y]) => Math.hypot(x, y) <= radius;
const real = stops.filter((p) => p[2] === STOP.SIGNAL).map(([la, lo]) => area.proj.toXY(la, lo)).filter(inArea);
const guess = g.likelySignals().map((v) => [g.x[v], g.y[v]]).filter(inArea);
// Several lights (or several guessed nodes) at one junction count once.
const cluster = (pts) => {
  const out = [];
  for (const p of pts) if (!out.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= NEAR_M)) out.push(p);
  return out;
};
const near = (p, pts) => pts.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= NEAR_M);
const realJ = cluster(real);
const guessJ = cluster(guess);
const right = guessJ.filter((p) => near(p, real)).length;
const found = realJ.filter((p) => near(p, guess)).length;
console.log(`area ${lat},${lon} r=${radius} m: ${g.n} street points, map source ${area.source}`);
console.log(`mapped light junctions: ${realJ.length}   guessed junctions: ${guessJ.length}`);
console.log(`guesses on a real light: ${right} of ${guessJ.length} (${Math.round((100 * right) / Math.max(1, guessJ.length))}%)`);
console.log(`real light junctions found: ${found} of ${realJ.length} (${Math.round((100 * found) / Math.max(1, realJ.length))}%)`);
