// The proxy (server/worker.js) driven in Node: a stand-in for Cloudflare's edge cache and
// for the public servers behind it, so every route is asked the way the app asks it.
import worker from '../server/worker.js';
import { PROXY, searchUrl, nominatimUrl, overpassEndpoints, OVERPASS_HOMES, PUBLIC_OVERPASS } from '../js/services.js';

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

// Cloudflare's cache: answers kept by address.
const kept = new Map();
globalThis.caches = { default: { match: async (req) => kept.get(req.url)?.clone(), put: async (req, res) => { kept.set(req.url, res); } } };

// The servers behind the proxy. `upstream(url, init)` answers; every call is noted.
const realFetch = globalThis.fetch;
let upstream = async () => new Response('{}');
const asked = [];
globalThis.fetch = async (url, init = {}) => { asked.push({ url: String(url), init }); return upstream(String(url), init); };

const env = { CONTACT_EMAIL: 'runs@example.org', ALLOWED_ORIGINS: 'https://uri-kedem.github.io,capacitor://localhost,http://localhost:8080' };
const call = (path, init = {}) => worker.fetch(new Request(`https://proxy.test${path}`, init), env);
const okJson = (v) => new Response(JSON.stringify(v), { status: 200 });
const fromHost = (a) => new URL(a.url).host;

// The app's addresses.
{
  check(/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(PROXY), 'the app is pointed at the proxy');
  check(searchUrl('?q=x') === `${PROXY}/search?q=x` && nominatimUrl('/reverse?lat=1') === `${PROXY}/nominatim/reverse?lat=1`, 'search and place lookups go through it');
  const list = overpassEndpoints();
  check(list[0] === `${PROXY}/overpass` && PUBLIC_OVERPASS.every((u) => list.includes(u)) && OVERPASS_HOMES === 1, 'street data asks the proxy first and keeps the public servers behind it');
}

// Search: only the app's parameters reach Photon, and the same question is asked once.
{
  upstream = async () => okJson({ features: [{ properties: { name: 'Tel Aviv' } }] });
  const a = await call('/search?q=tel%20aviv&limit=12&lang=en&lat=32.08&lon=34.77&secret=1');
  const body = await a.json();
  check(a.status === 200 && body.features.length === 1 && a.headers.get('X-Cache') === 'MISS', 'search answers with Photon\'s JSON');
  check(!/example\.org/.test(asked[0].url + asked[0].init.headers['User-Agent']), 'the contact address is not sent to the search service');
  check(asked.length === 1 && asked[0].url.startsWith('https://photon.komoot.io/api/?') && asked[0].url.includes('q=tel+aviv') && !asked[0].url.includes('secret'), 'only the known parameters are passed on');
  const b = await call('/search?q=tel%20aviv&limit=12&lang=en&lat=32.08&lon=34.77');
  check(b.headers.get('X-Cache') === 'HIT' && asked.length === 1, 'the second ask is answered from the cache');
  check((await call('/search?limit=3')).status === 502, 'a search without text is refused');
}

// Nominatim: contact address, the phone's language, a long list of tracks kept whole.
{
  asked.length = 0;
  upstream = async () => okJson([]);
  await call('/nominatim/search?format=jsonv2&limit=40&extratags=1&namedetails=1&q=stadium&viewbox=34.69,32.15,34.86,32.01&bounded=1', { headers: { 'Accept-Language': 'en-US,en;q=0.9,he;q=0.8' } });
  const u = new URL(asked[0].url);
  check(u.origin === 'https://nominatim.openstreetmap.org' && u.pathname === '/search' && u.searchParams.get('viewbox') === '34.69,32.15,34.86,32.01' && u.searchParams.get('bounded') === '1', 'the city scan reaches Nominatim as the app wrote it');
  check(u.searchParams.get('email') === 'runs@example.org' && /runs@example\.org/.test(asked[0].init.headers['User-Agent']), 'with the contact address, as its rules ask');
  check(u.searchParams.get('accept-language') === 'en', 'and names in the phone\'s language');
  const ids = Array.from({ length: 50 }, (_, i) => `W${1234567890 + i}`).join(',');
  await call(`/nominatim/lookup?format=jsonv2&polygon_geojson=1&osm_ids=${ids}`);
  check(new URL(asked[1].url).searchParams.get('osm_ids') === ids, 'a lookup of fifty tracks is passed on whole');
  check((await call('/nominatim/details?x=1')).status === 404, 'other Nominatim pages are not offered');
}

// Who may call.
{
  upstream = async () => okJson({ features: [] });
  check((await call('/search?q=haifa', { headers: { Origin: 'https://example.com' } })).status === 403, 'another website is turned away');
  const phone = await call('/search?q=haifa', { headers: { Origin: 'capacitor://localhost' } });
  check(phone.status === 200 && phone.headers.get('Access-Control-Allow-Origin') === 'capacitor://localhost', 'the iPhone app is let in');
  check((await call('/search?q=haifa')).status === 200, 'and a caller with no origin (the native shell, curl)');
  check((await call('/search?q=haifa', { method: 'POST', body: 'x' })).status === 405, 'only street data may be posted');
}

// Street data: posted as the app posts it, the mirrors in turn, cached by the query.
{
  const query = '[out:json][timeout:25][bbox:32.07,34.76,32.09,34.78];(node["highway"="traffic_signals"];);out geom qt;';
  const post = (q) => call('/overpass', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  asked.length = 0;
  upstream = async (url, init) => {
    if (url.includes('maps.mail.ru')) return new Response('busy', { status: 504 });
    if (url.includes('overpass-api.de')) return new Response('<html>error</html>', { status: 200 });
    return okJson({ elements: [{ type: 'node', id: 1 }], asked: decodeURIComponent(String(init.body).replace(/^data=/, '')) });
  };
  const a = await post(query);
  const body = await a.json();
  check(a.status === 200 && body.elements.length === 1 && body.asked === query, 'a posted street query is answered, word for word');
  check(asked.length === 3 && fromHost(asked[0]) === 'maps.mail.ru' && a.headers.get('X-Upstream') === fromHost(asked[2]), 'a mirror that refuses or sends an error page is passed over');
  check(asked.every((c) => !/example\.org/.test(c.url + c.init.headers['User-Agent'] + c.init.body)), 'nor to the street-data servers');
  const b = await post(query);
  check(b.headers.get('X-Cache') === 'HIT' && asked.length === 3, 'the same query again costs the mirrors nothing');
  const g = await call('/overpass?data=' + encodeURIComponent(query));
  check(g.headers.get('X-Cache') === 'HIT', 'asked by address, it is the same cached answer');

  // A slow first mirror: the second is asked as well after a few seconds, and wins.
  asked.length = 0;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms >= 1000 ? ms / 100 : ms, ...rest); // the suite does not wait out real seconds
  upstream = (url, init) => new Promise((resolve, reject) => {
    if (!url.includes('maps.mail.ru')) return resolve(okJson({ elements: [] }));
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const t = Date.now();
  const slow = await post(query + ' ');
  check(slow.status === 200 && slow.headers.get('X-Upstream') === 'overpass-api.de' && Date.now() - t < 2000, 'a mirror that hangs does not hold the answer up');
  globalThis.setTimeout = realTimeout;

  // An answer that is JSON but says the server gave up half-way is not passed on or kept.
  asked.length = 0;
  upstream = async (url) => (url.includes('maps.mail.ru')
    ? new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' }), { status: 200 })
    : okJson({ elements: [{ type: 'node', id: 3 }] }));
  const gaveUp = await post(query + ' remark');
  check(gaveUp.status === 200 && (await gaveUp.json()).elements.length === 1 && gaveUp.headers.get('X-Upstream') === 'overpass-api.de', 'a mirror that ran out of time is passed over like one that refused');

  upstream = async () => new Response('down', { status: 521 });
  const none = await post(query + '  ');
  const err = await none.json();
  check(none.status === 502 && PUBLIC_OVERPASS.every((u) => err.error.includes(new URL(u).host)), 'no mirror answering: an error that says what each one said');
  check((await post('')).status === 502 && (await post('x'.repeat(20001))).status === 502, 'an empty or endless query is refused');

  // An answer older than three days is asked for again; when no mirror answers, the old
  // one is served rather than nothing (the lights of last week beat no lights).
  const realNow = Date.now;
  const lights = query + ' lights';
  upstream = async () => okJson({ elements: [{ type: 'node', id: 7 }] });
  await post(lights);
  Date.now = () => realNow() + 4 * 86400 * 1000;
  asked.length = 0;
  upstream = async () => new Response('down', { status: 521 });
  const stale = await post(lights);
  check(stale.status === 200 && stale.headers.get('X-Cache') === 'STALE' && (await stale.json()).elements[0].id === 7 && asked.length === PUBLIC_OVERPASS.length, 'four days on with every mirror down: the older answer is served');
  upstream = async () => okJson({ elements: [{ type: 'node', id: 8 }] });
  const fresh = await post(lights);
  check(fresh.headers.get('X-Cache') === 'MISS' && (await fresh.json()).elements[0].id === 8, 'and replaced as soon as a mirror answers again');
  asked.length = 0;
  check((await post(lights)).headers.get('X-Cache') === 'HIT' && asked.length === 0, 'the new answer is fresh for three days');
  Date.now = realNow;
}

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILED` : '\nAll proxy tests passed');
process.exit(failures ? 1 : 0);
