// Vector-tile specifics: decoding, stitching streets across tile borders, and
// repairing "T" junctions whose shared point the tiles simplified away.
// Run: node tests/test-vectortiles.mjs
import { osmFromVectorTiles, vtTilesFor, fetchVectorTiles } from '../js/vectortiles.js';
import { Graph } from '../js/graph.js';
import { makeProjection } from '../js/geo.js';
import { makeMockMapBackend } from './mock-vectortiles.mjs';
import { CENTER } from './synthetic-city.mjs';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const ky = 110574, kx = 111320 * Math.cos((CENTER[0] * Math.PI) / 180);
const ll = (x, y) => ({ lat: CENTER[0] + y / ky, lon: CENTER[1] + x / kx });

async function build(elements, radius = 1500) {
  const fetchImpl = makeMockMapBackend({ elements });
  const tiles = vtTilesFor(CENTER[0], CENTER[1], radius);
  const { buffers } = await fetchVectorTiles(tiles, { fetchImpl });
  const osm = osmFromVectorTiles(tiles, buffers);
  const g = new Graph(osm, makeProjection(...CENTER), null, null);
  return { osm, g, parts: g.compSize.length, tiles: tiles.length };
}

// 1) A street crossing several tile borders (long segments, no vertex near the borders).
{
  const els = [];
  let id = 1;
  const pts = [-1400, -300, 800, 1400].map((x) => { els.push({ type: 'node', id, ...ll(x, 37) }); return id++; });
  els.push({ type: 'way', id: 1, nodes: pts, tags: { highway: 'residential' } });
  const { g, parts, tiles } = await build(els);
  let len = 0; for (let e = 0; e < g.m; e++) len += g.len[e];
  console.log(`\nstreet across tile borders (${tiles} tiles)`);
  check(parts === 1, `stays one connected street (${parts} part(s))`);
  check(Math.abs(len - 2800) < 10, `length preserved (${len.toFixed(1)} m vs 2800 m)`);
}

// 2) A footpath ending 1.5 m short of a street, mid-block (simplified-away junction).
{
  const els = [];
  els.push({ type: 'node', id: 1, ...ll(-300, 0) }, { type: 'node', id: 2, ...ll(300, 0) });
  els.push({ type: 'node', id: 3, ...ll(40, 1.5) }, { type: 'node', id: 4, ...ll(40, 200) });
  els.push({ type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } });
  els.push({ type: 'way', id: 2, nodes: [3, 4], tags: { highway: 'footway' } });
  const { parts } = await build(els);
  console.log('\nT-junction with the shared point missing');
  check(parts === 1, `path gets connected to the street (${parts} part(s))`);
}

// 3) A path that really ends 30 m away from the street must NOT be joined.
{
  const els = [];
  els.push({ type: 'node', id: 1, ...ll(-300, 0) }, { type: 'node', id: 2, ...ll(300, 0) });
  els.push({ type: 'node', id: 3, ...ll(40, 30) }, { type: 'node', id: 4, ...ll(40, 200) });
  els.push({ type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } });
  els.push({ type: 'way', id: 2, nodes: [3, 4], tags: { highway: 'footway' } });
  const { parts } = await build(els);
  console.log('\npath that genuinely ends 30 m away');
  check(parts === 2, `stays separate (${parts} part(s))`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
