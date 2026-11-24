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

## Accounts (the optional sign-in)

`accounts.js` adds the `/account` routes to the same Worker: sign-in with a code sent by
e-mail, with Google and with Apple (never a password), and a copy of the runner's profile and
run journal. The data lives in a Cloudflare D1 database (`schema.sql`). The whole thing is
exercised without a network by `node tests/test-accounts.mjs`.

**Nothing is switched on until it is set up here.** The app asks `/account/ways` which ways of
signing in are available and offers only those; with none, the app has no sign-in at all. So
a way is switched on (or off) on the server, with no new version of the app.

### 1. The database (once)

```
cd ~/RunTheTown/server
npx wrangler d1 create runthetown
```

Wrangler prints a `database_id`. Put it in `wrangler.toml` (the block is there, commented
out), then create the tables and deploy:

```
npx wrangler d1 execute runthetown --remote --file=schema.sql
npx wrangler deploy
```

`schema.sql` can be run again at any time; it only creates what is missing.

### 2. A way to sign in

| Way | What it needs | Settings |
| --- | --- | --- |
| E-mail code | A domain name of our own and a free account at Resend (resend.com) with that domain verified; no mail service delivers codes to strangers from an address on a domain we do not own | `MAIL_FROM` in `wrangler.toml`, for example `RunTheTown <signin@the-domain>`; the key with `npx wrangler secret put RESEND_API_KEY` |
| Google, website | A Google Cloud project with an OAuth client of type "Web application"; Authorized JavaScript origins `https://uri-kedem.github.io` and `http://localhost:8080`; the consent screen published ("In production"), or only listed test users can sign in | `GOOGLE_WEB_CLIENT_ID` |
| Google, iPhone | In the same project, an OAuth client of type "iOS" with the bundle id `com.urikedem.runthetown` | `GOOGLE_IOS_CLIENT_ID` |
| Apple, iPhone | The paid Apple Developer Program; the Sign in with Apple capability on the App ID and in the Xcode project (`native/configure-ios.rb` does not add it yet: a free personal team cannot sign an app that has it) | `APPLE_APP_ID = "com.urikedem.runthetown"` |
| Apple, website | A Services ID with the site's domain and return address; the page's side is not built yet | `APPLE_SERVICES_ID` |

In the iPhone app Google is offered only when Apple is too (App Review guideline 4.8).

### What is kept, and for how long

- `users`: the e-mail address (when proved), Google's and Apple's id for the person, the
  profile (name, two small photos). Until the runner deletes the account.
- `sessions`: a SHA-256 hash of each signed-in phone's key. A phone not seen for 400 days is
  signed out.
- `codes`: a hash of the last code sent to an address; it works for 10 minutes and 5 guesses.
- `runs`: the run journal without the map pictures; a deleted run stays as an empty row so
  the runner's other phone learns of it.
- `limits`: counters (codes per address and per network, guesses per network).

"Delete my account" removes the user, every session and every run in one go. Still to do
when Apple sign-in is set up: Apple asks that an account deletion also revokes the Sign in
with Apple grant (`/auth/revoke`, which needs the app's private key); check Apple's current
wording then.

### Limits of the free plan (checked Nov 23, 2026)

Workers: 100,000 requests a day. D1: 5 million rows read and 100,000 written a day, 500 MB
per database. A run without its picture is 10 to 60 KB, so 500 MB is some ten thousand runs.
