# RunTheTown proxy (Cloudflare Worker)

One small server in front of the public services the app searches and reads streets from
(Photon, Nominatim, Overpass). It identifies itself properly, caches every answer at
Cloudflare's edge, and lets us change a provider without an app update. Nothing personal
passes through it: only the search text, a position and the map query.

Cost: Cloudflare's free plan allows 100,000 requests a day, far more than the app needs.

## Deploy (once, from this folder)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. In a terminal:

```
cd ~/RunTheTown/server
npx wrangler login
npx wrangler deploy
```

   `wrangler deploy` prints the worker's address, like
   `https://runthetown-proxy.<your-account>.workers.dev`.
3. Put Uri's e-mail address in `wrangler.toml` (`CONTACT_EMAIL`) and deploy again.
4. In `js/services.js` set `PROXY` to that address, run `node build.mjs`, commit and push.
   From then on every search and street download goes through the proxy.

## Check it works

```
curl "https://runthetown-proxy.<your-account>.workers.dev/search?q=tel%20aviv&limit=3"
```

The answer is Photon's JSON; a second call answers from the cache (header `X-Cache: HIT`).

## Limits worth setting in the dashboard (optional)

Security → WAF → Rate limiting rules: 60 requests per minute per IP on this worker keeps a
runaway client from using up the free quota.
