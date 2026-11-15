# RunTheTown proxy (Cloudflare Worker)

One small server in front of the public services the app searches and reads streets from
(Photon, Nominatim, Overpass). It identifies itself properly, caches every answer at
Cloudflare's edge, and lets us change a provider without an app update. Nothing personal
passes through it: only the search text, a position and the map query.

Cost: Cloudflare's free plan allows 100,000 requests a day, far more than the app needs.

## Where it runs

Deployed on Nov 15, 2026 at `https://runthetown-proxy.runthetown.workers.dev` (Cloudflare
account of Uri, workers.dev subdomain `runthetown`). The app uses it: `PROXY` in
`js/services.js` holds this address.

## Deploy again after a change (from this folder)

```
cd ~/RunTheTown/server
npx wrangler deploy
```

`npx wrangler login` first if Wrangler says it is not logged in. `package.json` here exists
for its `name`: when an assistant runs Wrangler it does not ask questions and names a new
workers.dev subdomain after the project.

`CONTACT_EMAIL` in `wrangler.toml` is the contact address Nominatim's usage policy asks for.
It is sent with Nominatim requests only; Photon and the Overpass servers get the proxy's
name alone.

## Check it works

```
curl "https://runthetown-proxy.runthetown.workers.dev/search?q=tel%20aviv&limit=3"
```

The answer is Photon's JSON; a second call answers from the cache (header `X-Cache: HIT`).
A street-data answer names the server it came from (`X-Upstream`); when no server answered,
the error lists what each one said.

## What the app does when the proxy is down

Street data falls back to the public Overpass servers, which the app keeps behind the proxy
in its list. Search and place lookups have no second way: the search box says suggestions
are unavailable, and the map tap still sets a start.

## Limits worth setting in the dashboard (optional)

Security → WAF → Rate limiting rules: 60 requests per minute per IP on this worker keeps a
runaway client from using up the free quota.
