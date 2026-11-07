# RunTheTown on iPhone (Capacitor shell)

The App Store version is the same web app wrapped in a native shell. The wrapper adds the
things a web page cannot do: the phone's own speech engine with every installed voice
(Zoe, Tom, Siri), GPS that keeps running with the screen locked, keep-awake, and the share
sheet with a picture. Everything else (planner, journal, settings) is unchanged.

Files in the repo:
- `capacitor.config.json` — app id `com.runthetown.app`, name RunTheTown, web files from `dist/`.
- `package.json` — Capacitor 7 and the plugins (background geolocation, text-to-speech,
  keep-awake, share, filesystem, app).
- `js/native.js` — the adapters (`NativeVoice`, `NativeGps`, `NativeScreenLock`, `nativeShare`),
  switched on automatically when the page runs inside the app (`Capacitor.isNativePlatform()`).
- `build.py` — also writes `dist/` (the page, bundle, styles, artwork), which `npx cap sync ios`
  copies into the Xcode project.
- `native/Info.plist.additions.xml` — the permission texts and background modes the app needs
  (`npx cap add ios` creates `ios/App/App/Info.plist`; these entries are merged into it).

## One-time setup on the Mac (needs Xcode and an Apple ID)
Run in Terminal, one line at a time, from the project folder:

    cd ~/RunTheTown
    npm install
    python3 build.py
    npx cap add ios --packagemanager SPM
    npx cap sync ios

`--packagemanager SPM` uses Swift Package Manager, so CocoaPods is not needed. Then tell
Claude the project exists: the Info.plist entries get merged, and `npx cap open ios` opens
Xcode. In Xcode: select the App target → Signing & Capabilities → Team = your Apple ID
(personal team is fine for your own phone) → plug in the iPhone → Run. The first run asks
to trust the developer certificate on the phone (Settings → General → VPN & Device
Management).

## Every later build
    cd ~/RunTheTown && python3 build.py && npx cap sync ios && npx cap open ios
then Run in Xcode. The web app is copied fresh into the project each time.

## What to test first on the phone
1. Settings → Voice: Zoe and Tom should be listed (and any Siri voice), with Play.
2. Start a run, lock the phone: the directions keep coming, the distance keeps counting.
3. Finish → Share this run: the share sheet with the picture.

## Known limits of this first shell
- Leaflet is still loaded from unpkg at launch (network needed at start, as before).
- The service worker does not run inside the app (not needed there).
- Push notifications, Sign in with Apple and a backend are not part of this step.
