// RunTheTown's own small server: a Cloudflare Worker in front of the public search and map
// data services the app uses. Every phone used to call them directly, which their usage
// rules do not allow for an app with many users (Nominatim: one request a second for the
// whole app, no autocomplete; the public Overpass servers: not as an app's backend). Here
// the requests are made from one place, with a proper identification, cached at the edge
// so the same question is asked only once, and the provider behind each route can change
// without an app update.
//
// Routes (GET unless said otherwise, all answer JSON, CORS open):
//   /search?q=&lat=&lon=&lang=&limit=     place autocomplete (Photon today)
//   /nominatim/search?...  /nominatim/reverse?...  /nominatim/lookup?...   (Nominatim)
//   /overpass?data=<query>                 street data (the Overpass mirrors, in turn);
//                                          also POST with the form body data=<query>, as the app sends it
//   /                                      a one-line "ok" for monitoring
//   /account, /account/...                 the optional sign-in and what an account keeps
//                                          (accounts.js, which lists its own routes)
//
// Secrets and settings come from wrangler.toml / the dashboard: CONTACT_EMAIL (sent only with
// Nominatim requests, as its policy asks), ALLOWED_ORIGINS (who may call us), and those of
// the accounts (accounts.js).

import { accounts } from './accounts.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
// In the app's own order: the first has been the most dependable.
const OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// How the proxy names itself to the services behind it. The contact address goes to
// Nominatim alone, whose usage policy asks for one; the others get the name.
const AGENT = 'RunTheTown-proxy/1.0';
// How long an answer is kept at the edge. Places and streets change slowly.
// Each kind of answer is fresh for a while and kept for longer: on a day a public server
// does not answer, an older copy (of a search, of the streets and traffic lights) is far
// better than none.
const TTL = { search: 7 * 86400, searchKeep: 30 * 86400, nominatim: 30 * 86400, nominatimKeep: 90 * 86400, overpass: 3 * 86400, overpassKeep: 30 * 86400 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Accounts: the runner's own data, never cached, and only for the app itself.
    if (url.pathname === '/account' || url.pathname.startsWith('/account/')) {
      const answer = (body, status = 200) => json(body, status, { ...cors, 'Cache-Control': 'no-store' });
      if (!originAllowed(origin, env)) return answer({ error: 'origin not allowed' }, 403);
      return accounts(request, env, url, answer);
    }
    // Street-data queries are long: the app posts them as a form, like Overpass itself takes them.
    const posted = request.method === 'POST' && url.pathname === '/overpass';
    if (request.method !== 'GET' && !posted) return json({ error: 'GET only' }, 405, cors);
    if (!originAllowed(origin, env)) return json({ error: 'origin not allowed' }, 403, cors);
    try {
      if (url.pathname === '/') return new Response('RunTheTown proxy ok\n', { headers: cors });
      if (url.pathname === '/search') return await proxy(photonUrl(url), TTL.search, cors, { keep: TTL.searchKeep });
      if (/^\/nominatim\/(search|reverse|lookup)$/.test(url.pathname)) return await proxy(nominatimUrl(url, env, request), TTL.nominatim, cors, { contact: env.CONTACT_EMAIL, keep: TTL.nominatimKeep, waitMs: 6000 });
      if (url.pathname === '/overpass') return await overpass(posted ? new URLSearchParams(await request.text()).get('data') : url.searchParams.get('data'), cors, env);
      return json({ error: 'no such route' }, 404, cors);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 502, cors);
    }
  },
};

function originAllowed(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true; // not configured: open (fine while testing)
  if (!origin) return true; // the native app (no Origin header) and curl
  return allowed.includes(origin);
}
function corsHeaders(origin, env) {
  return {
    'Access-Control-Allow-Origin': originAllowed(origin, env) && origin ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (body, status, cors) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

// Only the parameters the app uses are passed on: nothing else reaches the provider.
function pick(url, keys) {
  const out = new URLSearchParams();
  // A track lookup names up to 50 places at once: that one parameter may be long.
  for (const k of keys) if (url.searchParams.has(k)) out.set(k, url.searchParams.get(k).slice(0, k === 'osm_ids' ? 800 : 300));
  return out;
}
function photonUrl(url) {
  const p = pick(url, ['q', 'lat', 'lon', 'lang', 'limit']);
  if (!p.get('q')) throw new Error('q missing');
  if (!p.get('limit') || +p.get('limit') > 15) p.set('limit', '12');
  // The position only leans the suggestions towards the runner: passed on to the nearest
  // kilometre, whatever the app sent (and nearby runners then share a cached answer).
  for (const k of ['lat', 'lon']) if (p.has(k) && Number.isFinite(+p.get(k))) p.set(k, (+p.get(k)).toFixed(2));
  return `${PHOTON}?${p}`;
}
function nominatimUrl(url, env, request) {
  const kind = url.pathname.split('/').pop();
  const p = pick(url, ['q', 'lat', 'lon', 'zoom', 'limit', 'viewbox', 'bounded', 'extratags', 'namedetails', 'polygon_geojson', 'osm_ids']);
  p.set('format', 'jsonv2');
  if (env.CONTACT_EMAIL) p.set('email', env.CONTACT_EMAIL);
  // Names in the phone's language, as when the phone asked Nominatim itself (only the
  // language, not the whole header, so one cached answer serves everyone who shares it).
  const lang = (request.headers.get('Accept-Language') || '').match(/^[a-z]{2,3}/i)?.[0]?.toLowerCase();
  if (lang) p.set('accept-language', lang);
  if (kind === 'search' && !p.get('q')) throw new Error('q missing');
  if (kind === 'lookup' && !p.get('osm_ids')) throw new Error('osm_ids missing');
  return `${NOMINATIM}/${kind}?${p}`;
}

// The answer from the edge cache when it is fresh, else from the provider (and kept). A
// provider gets a few seconds and, when it fails or does not answer, one more try: the
// runner is waiting with the keyboard open, and a search service that refuses one
// connection usually takes the next. When both tries fail, an older answer to the same
// question is better than none.
const TRIES = 2;
async function proxy(upstream, ttl, cors, { contact = '', keep = ttl, waitMs = 3500 } = {}) {
  const cache = caches.default;
  const key = new Request(upstream, { method: 'GET' });
  const hit = await cache.match(key);
  const age = hit ? Date.now() - Number(hit.headers.get('X-Fetched') || 0) : Infinity;
  if (hit && age < ttl * 1000) return withCors(hit, cors, 'HIT');
  let failure = 'upstream unreachable';
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(upstream, { signal: AbortSignal.timeout(waitMs), headers: { Accept: 'application/json', 'User-Agent': contact ? `${AGENT} (${contact})` : AGENT } });
      if (res.ok) {
        const body = await res.text();
        const out = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${keep}`, 'X-Fetched': String(Date.now()) } });
        await cache.put(key, out.clone());
        return withCors(out, cors, 'MISS');
      }
      failure = `upstream ${res.status}`;
      if (res.status < 500 && res.status !== 429) break; // its answer to this very question: asking again changes nothing
    } catch (err) {
      failure = err?.name === 'TimeoutError' ? 'upstream did not answer in time' : 'upstream unreachable';
    }
  }
  return hit ? withCors(hit, cors, 'STALE') : json({ error: failure }, 502, cors);
}
function withCors(res, cors, cacheState) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  h.set('X-Cache', cacheState);
  return new Response(res.body, { status: res.status, headers: h });
}

// Overpass: the query goes to the first mirror; when it has not answered in 6 s (or has
// refused) the next one is asked as well, and the first good answer wins. The public
// mirrors have slow hours: this keeps one slow server from costing the runner a minute.
// Cached by the query text, so a city asked for twice costs the servers one request; a
// copy older than three days is refreshed, and still served when the refresh fails.
const OVERPASS_HEDGE_MS = 6000;
const OVERPASS_GIVE_UP_MS = 45000; // the app itself waits 75 s, then asks the mirrors directly
async function overpass(data, cors, env) {
  if (!data) throw new Error('data missing');
  if (data.length > 20000) throw new Error('query too long');
  const cache = caches.default;
  const key = new Request(`https://cache.runthetown.invalid/overpass/${await sha256(data)}`, { method: 'GET' });
  const hit = await cache.match(key);
  const age = hit ? Date.now() - Number(hit.headers.get('X-Fetched') || 0) : Infinity;
  if (hit && age < TTL.overpass * 1000) return withCors(hit, cors, 'HIT');
  const tried = []; // what each mirror said, for the error when none answered
  const stop = new AbortController();
  const giveUp = AbortSignal.any([stop.signal, AbortSignal.timeout(OVERPASS_GIVE_UP_MS)]);
  const ask = async (base) => {
    const res = await fetch(base, { method: 'POST', signal: giveUp, body: `data=${encodeURIComponent(data)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': AGENT } });
    if (!res.ok) throw new Error(String(res.status));
    // The answer is passed on as the bytes it came in: a city's lights can be several
    // megabytes, and only its first and last lines need reading here.
    const body = await res.arrayBuffer();
    const text = new TextDecoder();
    if (!text.decode(body.slice(0, 200)).trimStart().startsWith('{')) throw new Error('not JSON'); // an HTML error page
    if (/"remark"\s*:\s*"[^"]*(error|timed out|out of memory)/i.test(text.decode(body.slice(-600)))) throw new Error('the server ran out of time');
    return { body, host: new URL(base).host };
  };
  const answer = await new Promise((resolve) => {
    let next = 0, waiting = 0, settled = false, timer = null;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const start = () => {
      clearTimeout(timer);
      if (settled || next >= OVERPASS.length) return;
      const base = OVERPASS[next++];
      waiting++;
      ask(base).then(finish, (err) => {
        tried.push(`${new URL(base).host}: ${err.message}`);
        waiting--;
        if (next < OVERPASS.length) start();
        else if (!waiting) finish(null);
      });
      timer = setTimeout(start, OVERPASS_HEDGE_MS);
    };
    start();
  });
  stop.abort(); // the mirrors still working on it are let go
  // No mirror answered: the older copy, when there is one, rather than nothing.
  if (!answer) return hit ? withCors(hit, cors, 'STALE') : json({ error: tried.join('; ') || 'no mirror answered' }, 502, cors);
  const out = new Response(answer.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL.overpassKeep}`, 'X-Upstream': answer.host, 'X-Fetched': String(Date.now()) } });
  await cache.put(key, out.clone());
  return withCors(out, cors, 'MISS');
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
