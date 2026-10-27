// Builds a fake Overpass response for a synthetic city so the engine can be
// tested offline: a street grid, busy avenues, a park with footpaths, a river
// with a riverside promenade, and (separately) a hill for elevation.

export const CENTER = [32.08, 34.78];

// Options for bigger tests: `riverX` moves the river east, `fullGrid` extends
// east-west streets over the whole map, and `seaX` puts a coastline (with a
// beach promenade) at that x, with no streets west of it, like Tel Aviv.
export function syntheticOverpass({ size = 7000, spacing = 100, riverX = 2000, seaX = null, fullGrid = false } = {}) {
  const [lat0, lon0] = CENTER;
  const ky = 110574;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ll = (x, y) => [lat0 + y / ky, lon0 + x / kx];
  const elements = [];
  const nodeId = new Map();
  let nextNode = 1;
  let nextWay = 1;
  const node = (x, y) => {
    const key = `${Math.round(x)},${Math.round(y)}`;
    let id = nodeId.get(key);
    if (!id) {
      id = nextNode++;
      nodeId.set(key, id);
      const [lat, lon] = ll(x, y);
      elements.push({ type: 'node', id, lat, lon });
    }
    return id;
  };
  const half = size / 2;
  const way = (pts, tags) => elements.push({ type: 'way', id: nextWay++, nodes: pts.map(([x, y]) => node(x, y)), tags });
  const geomWay = (pts, tags) =>
    elements.push({ type: 'way', id: nextWay++, tags, geometry: pts.map(([x, y]) => { const [lat, lon] = ll(x, y); return { lat, lon }; }) });

  // Street names: avenues (busy) and streets; one in Hebrew only, like many in Tel Aviv.
  const streetName = (vertical, v, busy) => {
    const n = Math.round(v / 100);
    if (busy) return `${vertical ? 'North' : 'East'} Avenue ${n}`;
    if (vertical && n === 3) return 'רחוב הירקון';
    return `${vertical ? 'Elm' : 'Oak'} Street ${n}`;
  };
  const inPark = (x, y) => x > -1500 && x < -300 && y > 300 && y < 1100;
  const minX = seaX ?? -Infinity;
  // Street grid west of the river, broken inside the park.
  for (let v = -half; v <= (fullGrid ? half : riverX - 100); v += spacing) {
    const busy = Math.abs(v % 800) < 1;
    const hw = busy ? 'primary' : 'residential';
    for (const vertical of [true, false]) {
      if (vertical && (v > riverX - 100 || v < minX)) continue;
      let seg = [];
      for (let t = -half; t <= half; t += spacing) {
        const [x, y] = vertical ? [v, t] : [t, v];
        if (x > riverX - 100) break;
        if (x < minX) continue;
        if (inPark(x, y) && !busy) {
          if (seg.length > 1) way(seg, { highway: hw, name: streetName(vertical, v, busy) });
          seg = [];
          continue;
        }
        seg.push([x, y]);
      }
      if (seg.length > 1) way(seg, { highway: hw, name: streetName(vertical, v, busy) });
    }
  }
  // Footpaths through the park (finer grid, diagonal-ish).
  for (let x = -1500; x <= -300; x += 100) {
    const pts = [];
    for (let y = 300; y <= 1100; y += 50) pts.push([x, y]);
    way(pts, { highway: 'footway' });
  }
  for (let y = 300; y <= 1100; y += 100) {
    const pts = [];
    for (let x = -1500; x <= -300; x += 50) pts.push([x, y]);
    way(pts, { highway: 'footway' });
  }
  // Riverside promenade along the river bank.
  // Short connectors from the street grid to the promenade.
  for (let y = -half; y <= half; y += 100) way([[riverX - 100, y], [riverX - 50, y]], { highway: 'footway' });
  const prom = [];
  for (let y = -half; y <= half; y += 50) prom.push([riverX - 50, y]);
  way(prom, { highway: 'footway', name: 'River Promenade' });
  // The east bank has a park path too, joined by footbridges every kilometre: out on
  // one bank, back on the other makes a promenade loop (like the Yarkon).
  const east = [];
  for (let y = -half; y <= half; y += 50) east.push([riverX + 50, y]);
  way(east, { highway: 'path', bicycle: 'designated', foot: 'designated', name: 'East Bank Path' });
  for (let y = -half; y <= half; y += 1000) way([[riverX - 50, y], [riverX + 50, y]], { highway: 'footway', bridge: 'yes' });

  // A pedestrian street (car-free) between two grid streets, and a boulevard
  // whose walkway runs down the middle, like Rothschild.
  if (!fullGrid) {
    const ped = [];
    for (let x = -1000; x <= 0; x += 50) ped.push([x, 150]);
    way(ped, { highway: 'pedestrian', name: 'Market Lane' });
    way([[-1000, 100], [-1000, 150]], { highway: 'footway' });
    way([[0, 100], [0, 150]], { highway: 'footway' });
    const blvd = [];
    for (let y = -1400; y <= -200; y += 50) blvd.push([450, y]);
    way(blvd, { highway: 'footway', name: 'Founders Boulevard' });
    for (let y = -1400; y <= -200; y += 400) way([[400, y], [450, y]], { highway: 'footway' });

    // Tempting shortcuts a runner must never be sent down: a dirt track and an
    // unpaved path, both diagonals through the grid (every point a junction), plus
    // a mountain-bike trail and a paved path of the same shape (the paved one is fine).
    // Straight diagonals joined to the grid at their two ends only (their other vertices sit mid-block).
    const diag = (x0, y0, x1, y1) => { const pts = [[x0, y0]]; const n = Math.abs(x1 - x0) / 100; for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) / n) * (i + 0.5), y0 + ((y1 - y0) / n) * (i + 0.5)]); pts.push([x1, y1]); return pts; };
    way(diag(-800, -800, 800, 800), { highway: 'track', name: 'Dirt Track' });
    way(diag(-800, 800, 800, -800), { highway: 'path', surface: 'ground', name: 'Wadi Trail' });
    way(diag(900, -1500, 1500, -900), { highway: 'path', mtb_scale: '2', name: 'Singletrack' });
    way(diag(-1500, -900, -900, -1500), { highway: 'path', surface: 'asphalt', name: 'Garden Path' });
    // A wood south-east of the centre with a bare path (no surface tag) through it: a
    // dirt trail, left out. The same kind of bare path across the park is kept (penalised).
    geomWay([[900, -900], [1700, -900], [1700, -100], [900, -100], [900, -900]], { natural: 'wood' });
    way(diag(900, -900, 1700, -100), { highway: 'path', name: 'Wood Trail' });
    way(diag(-1500, 300, -700, 1100), { highway: 'path', name: 'Park Path' });

    // Places a runner cannot or should not pass: an army base south-west of the centre
    // with a paved footpath straight through it (a tempting short cut), a private service
    // road on the block east of it, and a factory compound with an alley through it.
    geomWay([[-1700, -1700], [-900, -1700], [-900, -900], [-1700, -900], [-1700, -1700]], { landuse: 'military' });
    way(diag(-1700, -1700, -900, -900), { highway: 'footway', surface: 'asphalt', name: 'Base Path' });
    way([[-800, -1200], [-700, -1200], [-600, -1200], [-500, -1200], [-400, -1200], [-300, -1200]].map(([x, y]) => [x, y - 50]), { highway: 'service', access: 'private', name: 'Private Drive' });
    geomWay([[300, -1700], [1100, -1700], [1100, -900], [300, -900], [300, -1700]], { landuse: 'industrial' });
    way(diag(300, -1700, 1100, -900), { highway: 'service', surface: 'asphalt', name: 'Factory Alley' });

    // A marina east of the river, off the boulevard, like Tel Aviv's: a basin with pontoons
    // (footways over the water), an unnamed dock quay along its edge (behind the clubhouses,
    // no way through) and the named promenade 80 m inland (the run).
    geomWay([[2100, -400], [2500, -400], [2500, 0], [2100, 0], [2100, -400]], { natural: 'water', leisure: 'marina', name: 'Town Marina' });
    const quay = []; for (let y = 0; y >= -400; y -= 50) quay.push([2080, y]);
    way(quay, { highway: 'footway' }); // the dock quay
    way([[2080, 0], [2100, 0]], { highway: 'footway' }); // the quay joins the boulevard
    const tayelet = []; for (let y = 0; y >= -400; y -= 50) tayelet.push([2020, y]);
    way(tayelet, { highway: 'footway', name: 'Marina Promenade' });
    way([[2020, 0], [2080, 0]], { highway: 'footway' });
    way([[2020, -400], [2080, -400]], { highway: 'footway' });
    for (const y of [-100, -250]) way([[2080, y], [2150, y], [2250, y], [2350, y], [2450, y]], { highway: 'footway', name: `Pontoon ${-y}` });

    // An Eilat-like quarter east of the river: its streets hang off a trunk road
    // (Route 90 runs through Eilat as the main boulevard) and reach the rest of
    // town only over the trunk's bridge. Without the trunk it would be stranded.
    const trunk = [];
    for (let x = 1900; x <= 3000; x += 100) trunk.push([x, 0]);
    way(trunk, { highway: 'trunk', name: 'Route 90 Boulevard' });
    way([[3000, 0], [3100, -100], [3200, -200]], { highway: 'trunk_link' }); // a slip road: never runnable
    for (let x = 2400; x <= 2800; x += 100) {
      way([[x, 0], [x, 100], [x, 200], [x, 300], [x, 400], [x, 500]], { highway: 'residential', name: `Palm Street ${x / 100}` });
      way([[x, 0], [x, -100], [x, -200], [x, -300], [x, -400], [x, -500]], { highway: 'residential', name: `Coral Street ${x / 100}` });
    }
    for (const y of [100, 300, 500, -100, -300, -500]) way([[2400, y], [2500, y], [2600, y], [2700, y], [2800, y]], { highway: 'residential', name: `Lagoon Row ${Math.abs(y) / 100}` });
  }

  // Traffic lights on the busy avenues (every 800 m) at every 4th junction
  // (every 400 m), like a real city where only some junctions are signalized.
  for (const [key, id] of nodeId) {
    const [x, y] = key.split(',').map(Number);
    const onAvenueX = Math.abs(x % 800) < 1;
    const onAvenueY = Math.abs(y % 800) < 1;
    if ((onAvenueX || onAvenueY) && Math.abs(x % 400) < 1 && Math.abs(y % 400) < 1 && x <= riverX - 100) {
      const el = elements.find((e) => e.type === 'node' && e.id === id);
      el.tags = { highway: 'traffic_signals' };
    }
  }

  // Coast: coastline just offshore and a beach promenade joined to the streets.
  if (seaX !== null) {
    const coast = [];
    const promenade = [];
    const x0 = Math.ceil(seaX / spacing) * spacing;
    for (let y = -half; y <= half; y += 200) coast.push([seaX - 60, y]);
    // A harbour basin cut into the coast (a water polygon lying in the sea, like Tel Aviv's
    // marina in the tiles) with an unnamed dock quay along its inner edge; the promenade
    // detours inland around it. Only in cities big enough to hold it.
    const harbour = half >= 3000 ? { y0: 2000, y1: 2300, x1: seaX + 100 } : null;
    const inHarbour = (y) => harbour && y >= harbour.y0 && y <= harbour.y1;
    for (let y = -half; y <= half; y += spacing) promenade.push([inHarbour(y) ? harbour.x1 + 60 : seaX - 20, y]);
    geomWay(coast, { natural: 'coastline' });
    // The beach promenade is mapped like Tel Aviv's: a shared foot-and-bike path with no
    // surface tag (a bike route, not a dirt trail).
    way(promenade, { highway: 'path', bicycle: 'designated', foot: 'designated' });
    for (let y = -half; y <= half; y += spacing) if (!inHarbour(y)) way([[seaX - 20, y], [x0, y]], { highway: 'footway' });
    if (harbour) {
      const { y0, y1, x1 } = harbour;
      geomWay([[seaX - 200, y0], [x1, y0], [x1, y1], [seaX - 200, y1], [seaX - 200, y0]], { natural: 'water' });
      const quay = []; for (let y = y0; y <= y1; y += 50) quay.push([x1 + 15, y]);
      way(quay, { highway: 'footway' }); // the dock quay, 15 m from the water
      way([[x1 + 15, y0], [x1 + 60, y0]], { highway: 'footway' });
      way([[x1 + 15, y1], [x1 + 60, y1]], { highway: 'footway' });
    }
  }

  // Landmarks (points of interest), a few with Hebrew-only names.
  const SIGHTS = [
    [-900, 700, 'City Museum', { tourism: 'museum' }],
    [-1300, 400, 'Park Fountain', { amenity: 'fountain' }], // not a sight
    [1850, 600, 'River Lookout', { tourism: 'viewpoint' }],
    [1850, -900, 'Old Bridge Monument', { historic: 'monument' }],
    [600, 1600, 'Grand Theatre', { amenity: 'theatre' }],
    [-600, -1200, 'Founders Memorial', { historic: 'memorial' }],
    [1200, -1700, 'Harbour Fort', { historic: 'fort' }],
    [-1800, -300, 'בית העם', { historic: 'monument' }], // local name only: a monument still counts
    [300, -600, 'Street Mural', { tourism: 'artwork' }],
    [-2200, 1500, 'Hilltop Castle', { historic: 'castle' }],
    [2400, 2400, 'Far Museum', { tourism: 'museum' }],
    [-100, 300, 'Corner Gallery', { tourism: 'gallery' }], // not a sight
    [900, 200, 'Clock Tower', { amenity: 'clock' }],
    [-2600, -2400, 'Southwest Ruins', { historic: 'ruins' }],
    [-400, 900, 'Great Synagogue', { amenity: 'place_of_worship' }], // not a sight
    [500, 400, 'Heritage Plaque: Architect X', { tourism: 'artwork' }], // not a sight
    [-700, -300, 'פסל הרחוב', { tourism: 'artwork' }], // artwork without an English name: not a sight
  ];
  for (const [x, y, name, tags] of SIGHTS) {
    const [lat, lon] = ll(x, y);
    elements.push({ type: 'node', id: nextNode++, lat, lon, tags: { name, ...tags } });
  }

  // Landscape features.
  geomWay([[-1500, 300], [-300, 300], [-300, 1100], [-1500, 1100], [-1500, 300]], { leisure: 'park' });
  // Running spots: the park's label point, and an athletics track (an oval
  // ~480 m around) with its stadium label, like Hadar Yosef.
  {
    const [plat, plon] = ll(-1000, 800);
    elements.push({ type: 'node', id: nextNode++, lat: plat, lon: plon, tags: { leisure: 'park', name: 'Central Park' } });
    const oval = [];
    const [tx, ty, half_, r] = [1250, 850, 50, 45];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * 2 * Math.PI;
      const sx = Math.cos(a) >= 0 ? half_ : -half_;
      oval.push([tx + sx + r * Math.cos(a), ty + r * Math.sin(a)]);
    }
    geomWay(oval, { leisure: 'track', sport: 'running' });
    const [slat, slon] = ll(tx, ty);
    elements.push({ type: 'node', id: nextNode++, lat: slat, lon: slon, tags: { leisure: 'stadium', name: 'Central Stadium' } });
  }
  const river = [];
  for (let y = -half; y <= half; y += 200) river.push([riverX, y]);
  geomWay(river, { waterway: 'river' });

  return { elements };
}

// Hill centred 2 km south-west of the centre, ~120 m high.
export function hillElevation(x, y) {
  const d2 = (x + 2000) ** 2 + (y + 2000) ** 2;
  return 10 + 120 * Math.exp(-d2 / (2 * 900 ** 2));
}
