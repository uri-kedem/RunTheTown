# Publishing RunTheTown (GitHub Pages)

The app is static files, so GitHub Pages hosts it for free over https — which is what
a phone needs for GPS, voice and the installable app (PWA).

## First time
1. On github.com, create a **public** repository called `RunTheTown` (no README, no .gitignore).
2. In Terminal on the Mac:
   ```
   cd ~/RunTheTown
   git init
   git add .
   git commit -m "RunTheTown"
   git branch -M main
   git remote add origin https://github.com/<your-user>/RunTheTown.git
   git push -u origin main
   ```
   (GitHub asks for your user name and a *personal access token* as the password:
   github.com → Settings → Developer settings → Personal access tokens.)
3. On github.com: repository → **Settings → Pages → Build and deployment**: Source
   "Deploy from a branch", branch `main`, folder `/ (root)`, Save.
4. After a minute the app is at `https://<your-user>.github.io/RunTheTown/`.
   Open it in Safari on the iPhone → Share → **Add to Home Screen**.

## Every update
```
cd ~/RunTheTown
python3 build.py        # rebuilds js/bundle.js and stamps the version into index.html and sw.js
git add . && git commit -m "update" && git push
```
Installed phones pick up the new version the next time the app is opened with a
connection (the service worker swaps the cached files).

## Notes
- `.nojekyll` tells GitHub Pages to serve every file as-is.
- Everything is relative paths, so the app also works at the repository sub-path and when
  opened from Finder (file://) — the service worker simply stays off there.
- A custom domain can be set under Settings → Pages later; the app needs no change.
