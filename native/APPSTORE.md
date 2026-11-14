# RunTheTown — App Store listing and review notes

Everything App Store Connect asks for, ready to paste. Keep this file in sync with the app:
the privacy answers below describe what the app actually does (nothing leaves the phone except
map and route data requests, no accounts, no analytics, no ads).

Bundle ID: `com.urikedem.runthetown` · Version 1.0 (build 1) · iOS 15.0 or later · iPhone only, portrait.

## App information

**Name** (30 max): `RunTheTown`

**Subtitle** (30 max): `Scenic routes, voice guided`

**Primary category:** Health & Fitness · **Secondary:** Navigation

**Age rating:** 4+ (no objectionable content). Answer "No" to every content question;
"Unrestricted web access": No.

**Support URL:** https://uri-kedem.github.io/RunTheTown/support.html
**Privacy policy URL:** https://uri-kedem.github.io/RunTheTown/privacy.html
**Marketing URL (optional):** https://uri-kedem.github.io/RunTheTown/

**Copyright:** `2026 Uri Kedem`

## Promotional text (170 max, editable without a new build)

Pick a distance, and RunTheTown finds the run you would have chosen yourself: along the sea,
through the park, on the quiet streets. Then it talks you round, turn by turn.

## Description (4000 max)

RunTheTown plans the run and then runs it with you.

Tell it where you start and how far you want to go. It looks at the real streets and paths
around you and builds a loop that stays where running is good: the promenade and the beach,
park paths and river trails, quiet neighbourhood streets instead of main roads. From an inland
start it heads for the water when the water is in reach. In a small town it keeps you off the
through road and on the lanes nobody drives.

You get a few routes to choose from, each with a one-line reason: "Beach promenade and the
park", "Quiet streets, then the river path". Pick one and press start.

While you run, a voice guides you: "In 200 meters, turn left onto Rothschild Boulevard." It
calls the turns, counts the kilometres (or miles) with your pace, and points out what you are
passing when you want it to. Miss a turn and it quietly reroutes. Turn around early and it
guides you home along the way you came. Start running before you reach the start, and it
joins you to the route instead of nagging you back.

The guide keeps working with the screen locked and in your pocket, speaking over your music,
using the voices already on your phone.

Every run goes into your journal: distance, time, pace, splits and a picture of the route on
the map. Share a run card with friends or run the same route again.

What RunTheTown does not do: it does not ask you to create an account, does not store your
runs anywhere but on your phone, does not track you and shows no ads. Your location is used
to guide you and is never sent to us, because there is no "us" server: map and route data come
straight from public map services.

Works anywhere OpenStreetMap has streets, which is most of the world. Best on paths and
promenades, by design.

## Keywords (100 max, comma separated, no spaces)

```
running,run,route,planner,jogging,gps,voice,coach,navigation,scenic,trail,loop,pace,jog
```

## What's New in This Version

First release. Route planning that prefers promenades, parks and quiet streets; turn-by-turn
voice guidance that works with the screen locked; rerouting and turnaround detection; a run
journal with route pictures and shareable run cards; kilometres or miles; a choice of voices.

## Screenshots (6.7-inch required; 6.5-inch and 5.5-inch optional, Apple scales the 6.7)

Take them in the iOS Simulator (iPhone 16 Pro Max, 1320 × 2868 after Apple scales; the
Simulator saves the right size with Cmd-S). Five shots, in this order, with a short caption
added on top of each in the house navy:

1. The route choices sheet over the map, three routes drawn — "Pick a distance, get the scenic run"
2. The run screen mid-run with the next-turn card — "Turn by turn, in your ears"
3. The route-detail view showing a promenade-heavy loop — "Promenades and parks first"
4. The journal with a run picture — "Every run remembered"
5. The share card — "Share the run, not your data"

Use a real area with water and parks (Tel Aviv works: start at Habima Square, 8 km). Set the
Simulator location to the start (Features → Location → Custom Location) so the blue dot shows.

## App Privacy (the questionnaire)

**Do you or your third-party partners collect data from this app?** → **No.**

Reasoning, if Apple asks: location is processed on the device to plan and guide the run and to
request map tiles and street data for the surrounding area from public map services
(OpenStreetMap tile servers, Overpass API, Microsoft Planetary Computer / AWS Terrain tiles for
elevation). Those requests carry coordinates of the area being planned, like any map app, and
are not linked to an identity; the developer runs no server and receives nothing. Name and
photo entered in the profile stay in the app's local storage on the phone. The run
journal is stored on the phone only. No analytics SDK, no advertising SDK, no crash reporter,
no account.

If the reviewer insists that map-tile requests count as "collection" (they normally do not,
because the data is not retained by the developer), the fallback answer is: Location → Precise
Location → used for App Functionality → not linked to the user → not used for tracking.

**Privacy "nutrition label" summary:** Data Not Collected.

## App Review Information

**Sign-in required:** No. There is no account.

**Contact:** Uri Kedem · uri.kedem1@gmail.com · phone: (fill in)

**Notes for the reviewer** (paste into the Notes field):

> RunTheTown is a running route planner with turn-by-turn voice guidance. No account is needed;
> the app works straight away.
>
> To test the planner: on the first screen, type a start address (for example "Habima Square,
> Tel Aviv") or allow location, pick a distance such as 5 km and tap Plan. Three routes appear
> in the bottom sheet; tap one to see it on the map, then tap Start run.
>
> To test the guidance without running: in the Simulator or on a device, set a simulated
> location at the start of the route (Xcode → Debug → Simulate Location, or Features →
> Location in the Simulator) and move it along the route. The voice announces the next turn,
> the distance markers and the finish. The run then appears under "My runs" with a route picture.
>
> Background location (UIBackgroundModes: location) is required because the app is a running
> guide: the runner locks the phone and puts it in a pocket, and the app must keep receiving
> location fixes to announce turns and distances for the whole run. Location is only tracked
> between Start run and Finish. Background audio is required so the voice guidance can speak
> while the screen is locked and while the user listens to music. The purpose strings in the
> Info.plist explain this to the user, and the "Always" permission is requested only when a run
> starts.
>
> The app sends no data to the developer. It fetches map tiles and street data for the planned
> area from public OpenStreetMap services, the same way any map app does.

**Attachment (optional):** a 30-second screen recording of a planned route and the first two
voice prompts helps the reviewer a lot; record it in the Simulator with the simulated location
moving (Cmd-R in the Simulator records).

## Export compliance

`ITSAppUsesNonExemptEncryption` is `false` in the Info.plist (the app uses only HTTPS, which is
exempt), so App Store Connect does not ask the encryption questions on each upload.

## Pricing and availability

Free. All countries. No in-app purchases.

## Checklist before each upload

1. `npm test` passes.
2. `node build.mjs` → note the build number shown in Settings → About.
3. `npx cap sync ios`.
4. In Xcode: App target → General → bump **Build** (1, 2, 3 …) every upload; bump **Version**
   (1.0, 1.1 …) when the listing's "What's New" changes.
5. Product → Destination → Any iOS Device (arm64) → Product → Archive → Distribute App →
   App Store Connect → Upload.
6. In App Store Connect: TestFlight tab → the build appears after processing (5–30 min) →
   add internal testers (you and Max) → install through the TestFlight app.
7. When ready: App Store tab → version 1.0 → select the build → Submit for Review.
