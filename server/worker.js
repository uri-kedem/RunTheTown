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
//
// Secrets and settings come from wrangler.toml / the dashboard: CONTACT_EMAIL (sent only with
// Nominatim requests, as its policy asks), ALLOWED_ORIGINS (who may call us).

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
const TTL = { search: 7 * 86400, nominatim: 30 * 86400, overpass: 3 * 86400 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Street-data queries are long: the app posts them as a form, like Overpass itself takes them.
    const posted = request.method === 'POST' && url.pathname === '/overpass';
    if (request.method !== 'GET' && !posted) return json({ error: 'GET only' }, 405, cors);
    if (!originAllowed(origin, env)) return json({ error: 'origin not allowed' }, 403, cors);
    try {
      if (url.pathname === '/') return new Response('RunTheTown proxy ok\n', { headers: cors });
      if (url.pathname === '/search') return await proxy(photonUrl(url), TTL.search, cors);
      if (/^\/nominatim\/(search|reverse|lookup)$/.test(url.pathname)) return await proxy(nominatimUrl(url, env, request), TTL.nominatim, cors, { contact: env.CONTACT_EMAIL });
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
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

// The answer from the edge cache when it is there, else from the provider (and kept).
async function proxy(upstream, ttl, cors, { contact = '' } = {}) {
  const cache = caches.default;
  const key = new Request(upstream, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return withCors(hit, cors, 'HIT');
  const res = await fetch(upstream, { headers: { Accept: 'application/json', 'User-Agent': contact ? `${AGENT} (${contact})` : AGENT } });
  if (!res.ok) return json({ error: `upstream ${res.status}` }, 502, cors);
  const body = await res.text();
  const out = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } });
  await cache.put(key, out.clone());
  return withCors(out, cors, 'MISS');
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
// Cached by the query text, so a city asked for twice costs the servers one request.
const OVERPASS_HEDGE_MS = 6000;
const OVERPASS_GIVE_UP_MS = 45000; // the app itself waits 75 s, then asks the mirrors directly
async function overpass(data, cors, env) {
  if (!data) throw new Error('data missing');
  if (data.length > 20000) throw new Error('query too long');
  const cache = caches.default;
  const key = new Request(`https://cache.runthetown.invalid/overpass/${await sha256(data)}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return withCors(hit, cors, 'HIT');
  const tried = []; // what each mirror said, for the error when none answered
  const stop = new AbortController();
  const giveUp = AbortSignal.any([stop.signal, AbortSignal.timeout(OVERPASS_GIVE_UP_MS)]);
  const ask = async (base) => {
    const res = await fetch(base, { method: 'POST', signal: giveUp, body: `data=${encodeURIComponent(data)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': AGENT } });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.text();
    if (!body.slice(0, 200).trimStart().startsWith('{')) throw new Error('not JSON'); // an HTML error page
    if (/"remark"\s*:\s*"[^"]*(error|timed out|out of memory)/i.test(body.slice(-600))) throw new Error('the server ran out of time');
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
  if (!answer) return json({ error: tried.join('; ') || 'no mirror answered' }, 502, cors);
  const out = new Response(answer.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL.overpass}`, 'X-Upstream': answer.host } });
  await cache.put(key, out.clone());
  return withCors(out, cors, 'MISS');
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
