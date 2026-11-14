// RunTheTown's own small server: a Cloudflare Worker in front of the public search and map
// data services the app uses. Every phone used to call them directly, which their usage
// rules do not allow for an app with many users (Nominatim: one request a second for the
// whole app, no autocomplete; the public Overpass servers: not as an app's backend). Here
// the requests are made from one place, with a proper identification, cached at the edge
// so the same question is asked only once, and the provider behind each route can change
// without an app update.
//
// Routes (all GET, all answer JSON, CORS open):
//   /search?q=&lat=&lon=&lang=&limit=     place autocomplete (Photon today)
//   /nominatim/search?...  /nominatim/reverse?...  /nominatim/lookup?...   (Nominatim)
//   /overpass?data=<query>                 street data (the Overpass mirrors, in turn)
//   /                                      a one-line "ok" for monitoring
//
// Secrets and settings come from wrangler.toml / the dashboard: CONTACT_EMAIL (sent with
// Nominatim requests, as its policy asks), ALLOWED_ORIGINS (who may call us).

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// How long an answer is kept at the edge. Places and streets change slowly.
const TTL = { search: 7 * 86400, nominatim: 30 * 86400, overpass: 3 * 86400 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, cors);
    if (!originAllowed(origin, env)) return json({ error: 'origin not allowed' }, 403, cors);
    try {
      if (url.pathname === '/') return new Response('RunTheTown proxy ok\n', { headers: cors });
      if (url.pathname === '/search') return await proxy(photonUrl(url), TTL.search, cors, env);
      if (/^\/nominatim\/(search|reverse|lookup)$/.test(url.pathname)) return await proxy(nominatimUrl(url, env), TTL.nominatim, cors, env);
      if (url.pathname === '/overpass') return await overpass(url, cors, env);
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (body, status, cors) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

// Only the parameters the app uses are passed on: nothing else reaches the provider.
function pick(url, keys) {
  const out = new URLSearchParams();
  for (const k of keys) if (url.searchParams.has(k)) out.set(k, url.searchParams.get(k).slice(0, 300));
  return out;
}
function photonUrl(url) {
  const p = pick(url, ['q', 'lat', 'lon', 'lang', 'limit']);
  if (!p.get('q')) throw new Error('q missing');
  if (!p.get('limit') || +p.get('limit') > 15) p.set('limit', '12');
  return `${PHOTON}?${p}`;
}
function nominatimUrl(url, env) {
  const kind = url.pathname.split('/').pop();
  const p = pick(url, ['q', 'lat', 'lon', 'zoom', 'limit', 'viewbox', 'bounded', 'extratags', 'namedetails', 'polygon_geojson', 'osm_ids']);
  p.set('format', 'jsonv2');
  if (env.CONTACT_EMAIL) p.set('email', env.CONTACT_EMAIL);
  if (kind === 'search' && !p.get('q')) throw new Error('q missing');
  if (kind === 'lookup' && !p.get('osm_ids')) throw new Error('osm_ids missing');
  return `${NOMINATIM}/${kind}?${p}`;
}

// The answer from the edge cache when it is there, else from the provider (and kept).
async function proxy(upstream, ttl, cors, env, { init = {} } = {}) {
  const cache = caches.default;
  const key = new Request(upstream, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return withCors(hit, cors, 'HIT');
  const res = await fetch(upstream, {
    ...init,
    headers: { Accept: 'application/json', 'User-Agent': `RunTheTown-proxy/1.0 (${env.CONTACT_EMAIL || 'no contact set'})`, ...(init.headers || {}) },
  });
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

// Overpass: the query is sent to the mirrors in turn until one answers. Cached by the
// query text, so a city asked for twice costs the servers one request.
async function overpass(url, cors, env) {
  const data = url.searchParams.get('data');
  if (!data) throw new Error('data missing');
  if (data.length > 20000) throw new Error('query too long');
  const cache = caches.default;
  const key = new Request(`https://cache.runthetown.invalid/overpass/${await sha256(data)}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return withCors(hit, cors, 'HIT');
  let last = 'no mirror answered';
  for (const base of OVERPASS) {
    try {
      const res = await fetch(base, { method: 'POST', body: `data=${encodeURIComponent(data)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `RunTheTown-proxy/1.0 (${env.CONTACT_EMAIL || 'no contact set'})` } });
      if (!res.ok) { last = `${base}: ${res.status}`; continue; }
      const body = await res.text();
      if (!body.trim().startsWith('{')) { last = `${base}: not JSON`; continue; } // an HTML error page
      const out = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL.overpass}` } });
      await cache.put(key, out.clone());
      return withCors(out, cors, 'MISS');
    } catch (err) {
      last = `${base}: ${err.message}`;
    }
  }
  return json({ error: last }, 502, cors);
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
