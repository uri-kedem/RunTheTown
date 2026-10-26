# RunTheTown — MVP

Arrive somewhere new, open the app and get running loops that match your distance,
landscape (parks, waterfront, quiet streets) and terrain (flat / any / hilly), or a sightseeing tour through
the city's landmarks, then run them with spoken turn-by-turn directions.

## The site

- **Logo:** the RTT logo (a sprinter forming the R) lives in `img/`: `logo.png` on light backgrounds (cover),
  `logo-white.png` on the dark rail and the app's top pill, `mark-white.png` / `mark.png` (the R with the
  runner, cut from the logo) as the Running-mode icon in the toolbar and on the cover card, `tour-white.png` /
  `tour.png` (the runner before the cathedral) as the Sightseeing-tour icon in the same two places, and
  `favicon.png` (the R mark on a dark tile) as the browser icon. To change the artwork, replace those files;
  nothing else references it.
- **Cover page:** headline, what the app does, and two ways in: **Running mode** and **Sightseeing tour**.
- **Two modes, not one option:** Running mode shows the landscape options (parks & green, waterfront, quiet
  streets) and nothing about sights. The Sightseeing tour is a mode of its own: the landscape row becomes
  "Mode · Sightseeing" (locked on) and the other options are put away, so tour routes are planned for the
  landmarks only (distance and terrain still apply). Switching mode resets the landscape options.
- **Side toolbar:** a permanent rail on wide screens, a drawer behind the menu button on phones, with
  Running mode, Sightseeing tour and Terms & policy. The logo goes back to the cover.
- **Terms & policy:** safety (routes come from map data and can be wrong; run at your own risk), what happens
  with your location (used on the device; coordinates go to the map and place services, never to a RunTheTown
  server), no account or tracking, the services used, fair use. Plain-language MVP text: have it reviewed by a
  lawyer before a public launch.

## Run it

**On your Mac:** double-click `index.html`, and it opens in your browser. No server or install needed.
(`start.command` also works if you prefer serving it at http://localhost:8080.)

**After changing code in `js/`:** run `python3 build.py` to regenerate `js/bundle.js`, which is the
single file `index.html` loads.

**On your phone:** browsers only allow GPS on `https://` sites, so to test outdoors deploy
the folder to any static host. The quickest is drag-and-drop onto https://app.netlify.com/drop,
or GitHub Pages. No build step is needed. Without GPS you can still search for a place or tap the map.

## Installing it on a phone (PWA)
The app installs from the browser, no store needed: `manifest.webmanifest` (name, icons,
standalone display) and `sw.js` (a service worker that keeps the page, styles, script,
artwork and Leaflet on the phone, so the installed app opens instantly and offline; map
pieces are cached by the app itself in IndexedDB). `build.py` stamps every build's hash into
`index.html` (`bundle.js?v=…`) and into the service worker's cache name, so installed
phones swap to the new build on their next online open. iPhone: Safari → Share → Add to
Home Screen (the in-app "Install on your phone" page shows the steps for the device; Chrome
on Android and desktop gets a real Install button). Icons: `img/icon-180.png` (iOS),
`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`. Hosting steps are in `DEPLOY.md`
(GitHub Pages). Known limit of a web app on iPhone: GPS stops when the phone is locked, so
the app keeps the screen awake during a run; a native wrapper (Capacitor) is the next step
for locked-screen guidance and the app stores.

## How it works

0. **Running mode** asks how you want to run: **Run the streets** (loops from here, the flow below) or
   **Run in laps** (the tracks, stadiums and park loops within 8 km are listed; tap one, say how far, and
   the app plans the way there, the laps and the way back as the one route on offer).
1. **Start point** comes from GPS, a tap on the map, or the search box. Search suggests places as you type
   (Photon, built on OpenStreetMap). It handles hotels, streets and landmarks, in English or Hebrew, and
   ranks results near you first.
2. **Distance:** type the number of kilometers, from 1 up to a marathon (42.2 km).
3. **Map data** comes from **OpenFreeMap vector tiles**: OpenStreetMap streets, paths, parks and water,
   served from a CDN (`js/vectortiles.js`, a small built-in tile decoder). A 25 km run is 64 tiles (~6 MB),
   which loads in about 1–3 s; a marathon is 132 tiles (~10 MB). Streets are stitched across tile borders,
   and "T" junctions whose meeting point the tiles simplified away are reconnected. In Tel Aviv that
   raised the connected street network from 70% to 98% (66% to 93% for long runs).
   - **Traffic lights and crosswalks** aren't in the tiles, so they come from one small Overpass query.
     The app waits at most 4 s for them after the map is ready. If the servers are down, routes avoid
     busy junctions instead, the app says so, and the data is saved when it does arrive.
   - **Backup:** if the tile service is down (it gives up quickly after a few failures), the full map
     comes from the public Overpass servers in tiles (`js/osm.js`), which is slower but complete.
   - **Made surfaces only.** Dirt tracks (OSM `highway=track`), bridleways, mountain-bike and hiking
     trails and anything tagged unpaved never enter the network, from the tiles or from the Overpass
     backup. A bare `highway=path` with no surface tag is kept when it crosses a park or a town, but it
     counts as three times its length, so it is only used when there is no made path at all; the same
     bare path through woods or scrub (open country, from the landscape grid) is dropped as a dirt
     trail. This came from a Haifa check where a loop had been sent down an unmarked wadi track.
     Out-and-backs with more than 10% of bare path are not offered, and the start pin snaps to a street
     or made path rather than a bare one (within 250 m).
   - **Trunk roads stay in, priced high.** OSM tags many urban arterials `highway=trunk` (Route 90 is
     Eilat's main boulevard, HaTmarim). Leaving them out broke Eilat's network into islands, so the
     only thing offered from the hotel strip was an out-and-back along the beach. Trunk roads that are
     city streets (not slip roads, expressways or tunnels) are kept as a class above primary roads, about
     three times the cost of a side street, and routes are also penalised for every metre on them: they
     connect the network but are never run along by choice; a trunk along the water earns no "scenic"
     credit and no out-and-back with more than 10% trunk is offered (Tiberias' lakeside Route 90).
     Motorways are never used. With the fix, Eilat gives three loops at 8, 10 and 12 km with 1–4% trunk.
   - **No private or closed ground.** Ways tagged `access=private` (or `no`) are out, like `foot=no`.
     Any small way (alley, footpath, service road, side street) that runs mostly through an army base,
     railway land, a quarry or a prison (`landuse`/`military`/`amenity=prison` polygons, grid layer
     `closed`) is out of the network. Inside a fenced compound — factory, hospital, school, campus,
     garages (grid layer `compound`) — such ways count as a last resort, like a bare path.
   - **Nothing over the water.** A footway, service road, path or stairs with most of its nodes deep
     inside a water body (`LandscapeGrid.deep`: the cell and its four neighbours are water) is a marina
     pontoon, jetty or pier and is dropped (`Graph.skippedAfloat`) — the Tel Aviv marina by the Hilton
     used to show up in routes. Marina basins also mark a `dock` layer (the basin plus a ~50 m rim):
     a harbour is found from the tiles alone — a small water polygon that lies in or touches the sea
     (`LandscapeGrid.markHarbours`; Tel Aviv's marina is a `lake` polygon inside the ocean polygon) —
     and, when the traffic-light query answers in time, from `leisure=marina` in Overpass too. An
     unnamed footway, service road, stairs or living street with 60% of its nodes on the dock is the
     dock quay (Tel Aviv's runs behind the clubhouses with no way through) and is dropped; the named
     promenade inland stays. Checked on the real Tel Aviv tiles (scratch test, 4 tiles around the Hilton).
   - **Bike routes are promenades.** A car-free bike route — a cycleway open to walkers, or a footway,
     path or pedestrian street with `bicycle=designated` (OpenFreeMap tiles carry `bicycle`/`foot`) — is
     a made, continuous path (`tags.bike`, `Graph.bike`): never a "rough" trail even with no surface tag
     (Tel Aviv's Yarkon and tayelet sections are `highway=path` + `bicycle=designated`), promenade credit
     0.6 anywhere and 1 along the water or through a park. Long bike routes trace the boardwalks, so the
     planner now follows them end to end.
   - **Landscape runs only.** When any candidate (loop or there-and-back, within 8% of the distance)
     keeps at least 60% of its length on park paths, boardwalks and promenades (`promFrac`,
     `LANDSCAPE_SHARE`), nothing else is offered — fewer than three options then, and the results
     note says so. A run that is 80% streets is no fun even if it touches the beach. A Sightseeing
     tour is exempt (landmarks rank it).
   - **The sea first.** The `sea` grid layer (ocean polygons + beaches, ~100 m inland) is kept apart from
     rivers and lakes: seaside edges cost ×0.7 on top of the water bonus, score `+0.6·seaFrac`, and the
     first option gets `seaBoost` (+1.2 once 30% of the run is by the sea) — so from Ramat Aviv the beach
     promenade beats the Yarkon bank whenever the run is long enough to reach it (8 km and up); the map is
     loaded to 0.38·D + 300 m so a there-and-back can get there. Routes are named "Seaside loop" /
     "Out & back along the sea".
   - Long runs (over 15 km) also skip service alleys and steps.
4. **On-device cache:** map tiles, traffic lights and elevation are saved in the browser for 14 days
   (`js/cache.js`), so coming back to a city is instant.
5. **Landscape grid:** parks are filled and waterfronts are buffered onto a 25 m grid, so every path segment
   knows whether it's green or along the water (`js/landscape.js`).
6. **Elevation** comes from the Terrarium terrain tiles on AWS (Mapzen data, ~30 m, no key, no rate
   limit: 4 PNG tiles decoded in the browser, `js/elevation.js`); Open-Meteo is the fallback. Open-Meteo
   used to be the only source and throttled after one plan, which is why cards on the phone came back
   without a climb line.
7. **Route design** (`js/planner.js`): exactly three options, and the first one is always the
   **promenade run**: of every loop and there-and-back found, the one with the most promenade, boardwalk,
   park path and waterfront under its feet (a there-and-back is fine when that is where the promenade
   is; on a Sightseeing tour the landmarks rank first instead). Every route prefers promenades, parks
   and waterfronts in the search itself (costs ×0.55 on promenades, ×0.75 in parks and along water,
   more when the landscape is picked) and in the ranking (promenade share weighs most).
   - round loops in 10 directions, resized until they hit the target distance;
   - when fewer than three round loops fit (a town hemmed in by sea and desert, like Eilat), long thin
     loops along the town's axis are tried before falling back to an out-and-back;
   - with parks or waterfront picked, loops stretched toward attractive places, plus triangles through two
     of them so the route runs *along* the beach or park;
   - **scenic out & back:** the most scenic path out to a turnaround at half the distance, then back the
     same way. It's offered as an extra option only when it's clearly more scenic than every loop, for
     example when a loop would have to come back through plain streets. The map marks the turnaround.
8. **Fewer stops:** traffic lights, crosswalks and stop signs come from OpenStreetMap. Each one counts as
   extra "virtual distance" when searching for routes: about 250 m for a traffic light and 50 m for a
   crosswalk. It only counts when the runner actually has to stop, so running along a road past a
   zebra crossing is free, while crossing the road at it isn't.
   - **Tapping a route** opens a pop-up with its name, distance, the facts below and one button, "Start run
     with voice guidance" (a demo run without GPS is a small link under it).
   - **The route card** states what a runner plans around: metres of climb and descent, the number of
     traffic lights and the number of road crossings (marked crosswalks and busy roads to cross), plus the
     landmarks on a sightseeing tour, and the elevation profile. The landscape mix shapes the route and
     its name ("Park loop", "Waterfront loop") but is not shown as percentages. When the traffic-light
     query failed (busy Overpass servers) the card leaves traffic lights out and lists only the road
     crossings, with no notice; when elevation could not be fetched, the climb line is left out.
9. **Sightseeing:** landmarks come from the same map tiles, but only the guidebook kind: museums,
   monuments and memorials, castles, palaces and forts, historic and archaeological sites, famous theatres,
   viewpoints, major attractions and notable public art. Neighbourhood synagogues and churches, commercial
   galleries, community centres, fountains, plaques and small parks are left out, and the smaller kinds only
   count when OpenStreetMap has a real English name for them (a sign the place is known beyond its block).
   In the Sightseeing tour, the planner builds tours through the best landmarks in each direction, sized
   to the distance, cards list the sights passed, the map shows them as star pins and the voice guide calls
   them out. In Running mode, landmarks are not mentioned at all.
   (Tel Aviv check, Oct 19: from Rothschild the 8 km tour passes Jaffa Clock Tower, Napoleon Canons,
   the Jaffa Antiquities Museum, Nachum Gutman Museum and the Lechi Museum.)
9b. **Fluent routes (few turns):** the route search runs on street *arcs* rather than points, so every
   turn at a junction has a cost in "virtual meters" (bear 16 m, turn 50 m, sharp 120 m, U-turn 600 m;
   a bend in a road with no choice costs nothing). Routes follow long streets and promenades instead of
   zig-zagging through a grid. Ranking also penalises turns per km.
   In the grid test city this cut turns by about a quarter; in Tel Aviv an 8 km loop went from 3.1 to
   1.7–2.4 turns per km.
9c. **Promenades, esplanades and boardwalks:** pedestrian streets, named promenades, esplanades, boardwalks,
   quays, boulevard walkways (Rothschild, Ben Gurion…) and car-free paths along the water or through parks
   are always preferred (30% "shorter" in the search, whatever the landscape choice), and loops are
   stretched toward them.
9d. **Running spots:** as soon as the start point is known, and before any route is asked for, the app
   marks the running tracks and athletics stadiums within about 8 km (`js/spots.js`: two small Nominatim
   searches by type, then one lookup for the track outlines, which become 400 m lap rings; football
   stadiums, velodromes, basketball halls and the like are left out), and lists the nearest with their
   distance. The map around the start is
   downloaded in the background meanwhile (reused by the route search) and adds the big parks (over 15 ha
   of contiguous green with at least 1.5 km of paths inside, each with a smooth inner loop) and ties the
   tracks to the streets. "Run laps here" works right away for any spot with a lap outline: it first asks
   how many kilometers you want (no default), shows what that means there ("9 laps of the 400 m track ·
   2.1 km to get there and back · 7.8 km in total") and then builds the route. An athletics stadium known
   only by name shows its details and website. (Tel Aviv, from Rothschild: Hadar Yosef with its 430 m lap, the Tel Aviv
   University track, a 290 m school track and the Ramat Hasharon athletics stadium, found in under 4 s.) A park gets a smooth inner loop planned on its own paths (1.5–5 km). "Run laps here" turns a spot
   into a full route: run there, do the laps that fill your distance, run back the same way; the voice guide
   counts laps. (Tel Aviv: Yarkon Park / Ganei Yehoshua gets a 3.1 km loop, 100% in the park; Hadar Yosef
   athletics stadium is a 400 m track.)
   Tapping a spot also shows its **website**, Wikipedia page, opening hours, entry (free / fee / members
   only) and phone when known (`js/details.js`): the place is looked up in OpenStreetMap through Nominatim
   (with its extra tags), and when OSM has no website, Wikidata's official-website entry is used. There is
   always a Google Maps link, and a web-search link when nothing else was found. Lookups happen on tap and
   are cached. (Hadar Yosef → nsc.org.il, the National Sport Center; Yarkon Park → its Wikipedia page.)
10. **Turn-by-turn cues** (`js/cues.js`): every real junction where the route turns gets "turn left onto
   X", "bear right", "sharp left" or "turn around", with street names. Small left-right jogs are merged
   into "keep going".
11. **Live guidance** (`js/navigation.js`), via "Start run with voice guidance":
   - follows GPS along the route (snapping keeps to the right leg on out & backs and crossings);
   - speaks "In 200 meters, turn left onto Rothschild Boulevard", then "Turn left…" at the junction,
     chaining close turns ("…, then turn right");
   - says when you're off the route and which way it is (left / right / behind), and confirms when you're back;
   - gives kilometer splits with pace and distance to go, and calls out sights ("On your right: Habima Theatre");
   - English voice, with Hebrew-only names read by a Hebrew voice;
   - keeps the screen awake (Wake Lock) and has Mute / Pause / End (two taps);
   - **Demo run**: a simulated runner (×1 / ×6 / ×15 speed) to try it at a desk.
12. **Ranking:** preference match, distance accuracy, busy roads, stops, back-tracking and climbing. The 3 best
   distinct loops are shown, plus the out & back when it qualifies.

## Tested in Tel Aviv (Oct 2026)

Live runs on real OpenStreetMap data:

- **From Rothschild Blvd, 10 km, parks + water:** loops via Jaffa Port and the beach promenade, and via the
  promenade and back through central Tel Aviv. The out & back runs along the Ben Gurion Blvd green median
  to the port. All routes were within 3% of 10 km and 86–98% on paths or quiet streets.
- **From a Hayarkon St beach hotel, 8 km, parks:** loops north along the promenade to the port and the
  Yarkon River, south toward Jaffa, and inland; elevation 0–51 m.
- First download of an area took 15–26 s on Overpass. With vector tiles the map loads in 0.5–4 s.
- **Long runs (live, Oct 18):** the old Overpass-only version failed on 25 km (the servers refused or
  timed out). With vector tiles, from Hayarkon St: **25 km in 7 s** in total (routes 23.8–25.1 km) and a
  **marathon in 11 s** (42.6–43.0 km), even with the light-data server down. From Rabin Square, 15 km
  parks + water, lights available: best loop 70% along the water and 66% green, 3–4 traffic lights.
- **Stop avoidance, from Dizengoff Center, 8 km:** ignoring stops gave 24–50 traffic lights per route.
  Avoiding them gave **6–9 lights and 4–6 crosswalks** at the same distance. Routes use quiet side
  streets to reach the promenade instead of Dizengoff and King George.

## Files

| File | What it does |
|---|---|
| `index.html`, `css/style.css` | Cover page, side toolbar, terms page, and the mobile-first app UI (side panel on desktop) |
| `js/app.js` | Map (Leaflet), location, autocomplete search, distance input, results |
| `js/engine.js` | Loads an area (cache or download) and runs the planner |
| `js/cache.js` | Saves downloaded areas on the device (IndexedDB) |
| `js/vectortiles.js` | OpenFreeMap tile download, tile decoder, street stitching and junction repair |
| `js/osm.js` | Overpass: traffic lights/crosswalks query, and the backup full-map download |
| `js/landscape.js` | Green/water raster grid |
| `js/elevation.js` | Elevation grid |
| `js/graph.js` | Path network, spatial index, arc-based Dijkstra with turn and stop costs, promenade tagging |
| `js/planner.js` | Loops, scenic out & back, sightseeing tours, scoring, naming |
| `js/cues.js` | Turn-by-turn instructions from the route shape |
| `js/places.js` | Running spots: athletics tracks, big parks with an inner loop, lap routes |
| `js/details.js` | Website / Wikipedia / hours of a running spot (Nominatim + Wikidata) |
| `js/spots.js` | City-wide scan for stadiums and athletics tracks with lap outlines (Nominatim) |
| `js/navigation.js` | Live guidance: GPS following, voice, splits, off-route, wake lock, demo run |
| `js/bundle.js`, `build.py` | All modules bundled into one script so the page opens from Finder |
| `tests/` | Offline tests (`npm test`): `test-vectortiles.mjs` (tile stitching, junction repair), `test-planner.mjs` (planner, preferences, stops, sightseeing filter, promenades, running spots, fewer turns), `test-cues.mjs` (turn instructions), `test-navigation.mjs` (simulated GPS runs: every turn announced on time, splits, sights, detours, out & back), `test-details.mjs` (website lookups, with the real response shapes seen for Hadar Yosef), `test-spots.mjs` (the stadium/track scan and lap outlines), `test-long-runs.mjs` (80 cases: 15–42.2 km × inland/coastal × healthy / flaky tiles / tiles down / no light data). `mock-vectortiles.mjs` serves real-format vector tiles generated from synthetic cities; `mock-overpass.mjs` fakes Overpass. |

- **Oct 19 (v0.7) live checks:** from Rothschild, 8 km: 1.7–2.4 turns/km, 41–66% on promenades, best
  loop 63% along the water. From the Yarkon area: the park loop and the Hadar Yosef track are found and
  turned into lap routes with correct cues. Planning takes 2.5–6 s including the download.

## Known limits of the MVP

- Traffic-light data depends on the public Overpass servers, which are often overloaded. Routes still
  work without it (busy junctions are avoided instead).
- Uses free public services (OpenFreeMap, Overpass, Open-Meteo, Photon, Esri tiles). That's fine for testing;
  a launch should use paid plans or its own backend (e.g. self-hosted tiles plus a preprocessed traffic-light
  extract per city).
- No safety data yet (lighting, crime, traffic volume).
- **Live guidance needs the screen on and the page open.** A web page can't keep GPS and voice running
  when the phone is locked or another app is in front; that needs a native app (or a watch via Garmin/Strava).
- GPS and voice need `https://` on a phone (see "On your phone" above).
- No automatic re-routing yet: when you're off the route, the app guides you back to it.
- Whether a track is free to use isn't in the map tiles. Tracks are shown when they're mapped; check
  opening hours on site.
- Promenades are recognised by name and by being car-free paths along water or parks; an unnamed
  esplanade away from water counts only as a normal path.

## Next steps

1. Field-test in a few cities and tune the scoring weights.
2. GPX export (works with any watch) → Garmin Courses API ("Send to Garmin").
3. Native wrapper (e.g. Capacitor) for locked-screen guidance; cues exported to Garmin courses.
4. An LLM-written route description ("Harbor loop, flat, two water fountains").
