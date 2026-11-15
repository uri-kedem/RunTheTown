// Where the app's outside services live. With PROXY empty the app talks to the public
// servers itself, as it always has. With PROXY set to the address of our own server
// (server/worker.js on Cloudflare; see server/README.md), place search, Nominatim and the
// street data go through it: one well-behaved caller with a cache, which is what those
// services' usage rules ask of an app on many phones, and a provider can then be changed
// without an app update. Map tiles, elevation, land cover and Wikipedia are unaffected.
export const PROXY = 'https://runthetown-proxy.runthetown.workers.dev';

export const PUBLIC_OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Place autocomplete (Photon) with the query string already built: `?q=…&limit=…`. */
export const searchUrl = (query) => (PROXY ? `${PROXY}/search${query}` : `https://photon.komoot.io/api/${query}`);
/** A Nominatim call: `nominatimUrl('/search?format=jsonv2&q=…')`. */
export const nominatimUrl = (path) => (PROXY ? `${PROXY}/nominatim${path}` : `https://nominatim.openstreetmap.org${path}`);
/**
 * The Overpass servers to try in turn. With the proxy it comes first and the public servers
 * stay behind it, so a day the proxy is down does not leave the app without its backup map.
 */
export const overpassEndpoints = () => (PROXY ? [`${PROXY}/overpass`, ...PUBLIC_OVERPASS] : PUBLIC_OVERPASS);
/**
 * How many of those servers share the first try: the two main public ones take turns;
 * the proxy takes every request (it spreads them over the public servers itself).
 */
export const OVERPASS_HOMES = PROXY ? 1 : 2;
