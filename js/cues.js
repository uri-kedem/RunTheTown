// Turn-by-turn cues from a route's geometry: where it turns at a junction,
// which way and how sharply, and onto which street. Used for the on-screen
// banner and the voice guide while running.

const LOOK_M = 18; // headings are measured over ~18 m before/after a point
const MIN_TURN = 30; // degrees: anything gentler is "keep going"
const MERGE_M = 25; // two cues closer than this become one

function headingDeg(dx, dy) {
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
const turnDelta = (a, b) => ((b - a + 540) % 360) - 180; // + = right, - = left

const COMPASS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function cueText(c) {
  const onto = c.street ? ` onto ${c.street}` : '';
  switch (c.type) {
    case 'depart':
      return `Head ${c.compass}${c.street ? ` on ${c.street}` : ''}`;
    case 'arrive':
      return 'You have arrived back at the start';
    case 'uturn':
      return 'Turn around';
    case 'slight':
      return `Bear ${c.dir}${onto}`;
    case 'sharp':
      return `Make a sharp ${c.dir}${onto}`;
    default:
      return `Turn ${c.dir}${onto}`;
  }
}

/**
 * @param g      Graph (x/y in meters, adjacency, edgeName/names)
 * @param route  { nodes, edges }
 * @returns [{ type, dir, angle, at (m along route), lat, lon, street, local, text }]
 */
export function buildCues(g, route) {
  const nodes = route.nodes;
  const n = nodes.length;
  if (n < 2) return [];
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) along[i] = along[i - 1] + g.len[route.edges[i - 1]];
  const total = along[n - 1];
  const nameOf = (e) => (e >= 0 && g.edgeName && g.edgeName[e] >= 0 ? g.names[g.edgeName[e]] : null);

  // Point roughly LOOK_M back / ahead of index i along the route.
  const back = (i) => {
    let j = i;
    while (j > 0 && along[i] - along[j] < LOOK_M) j--;
    return nodes[j];
  };
  const ahead = (i) => {
    let j = i;
    while (j < n - 1 && along[j] - along[i] < LOOK_M) j++;
    return nodes[j];
  };
  const degree = (v) => g.adjStart[v + 1] - g.adjStart[v];

  const cues = [];
  const first = ahead(0);
  const h0 = headingDeg(g.x[first] - g.x[nodes[0]], g.y[first] - g.y[nodes[0]]);
  const s0 = nameOf(route.edges[0]);
  cues.push({ type: 'depart', at: 0, idx: 0, compass: COMPASS8[Math.round(h0 / 45) % 8], street: s0?.name || null, local: s0?.local || null });

  for (let i = 1; i < n - 1; i++) {
    const v = nodes[i];
    const p = back(i);
    const q = ahead(i);
    const hIn = headingDeg(g.x[v] - g.x[p], g.y[v] - g.y[p]);
    const hOut = headingDeg(g.x[q] - g.x[v], g.y[q] - g.y[v]);
    const a = turnDelta(hIn, hOut);
    const abs = Math.abs(a);
    const junction = degree(v) >= 3;
    // Reversing direction (e.g. the out & back turnaround) is always a cue.
    if (abs >= 150 && (nodes[i - 1] === nodes[i + 1] || !junction)) {
      cues.push({ type: 'uturn', at: along[i], idx: i, angle: a });
      continue;
    }
    if (!junction || abs < MIN_TURN) continue;
    const type = abs < 60 ? 'slight' : abs < 135 ? 'turn' : 'sharp';
    const street = nameOf(route.edges[i]);
    cues.push({ type, dir: a > 0 ? 'right' : 'left', angle: a, at: along[i], idx: i, street: street?.name || null, local: street?.local || null });
  }

  // Merge cues that are very close (a staggered junction is one manoeuvre).
  const merged = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type !== 'depart' && c.at - prev.at < MERGE_M) {
      const sum = (prev.angle || 0) + (c.angle || 0);
      if (Math.abs(sum) < MIN_TURN) { merged.pop(); continue; } // a jog left-then-right: just go straight
      if (Math.abs(c.angle || 0) > Math.abs(prev.angle || 0)) merged[merged.length - 1] = { ...c, street: c.street || prev.street, local: c.local || prev.local };
      continue;
    }
    merged.push(c);
  }
  merged.push({ type: 'arrive', at: total, idx: n - 1 });
  for (const c of merged) {
    const v = nodes[c.idx];
    c.lat = g.lat[v];
    c.lon = g.lon[v];
    c.text = cueText(c);
  }
  return merged;
}
