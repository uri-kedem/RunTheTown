// Where the app's outside services live. With PROXY empty the app talks to the public
// servers itself, as it always has. With PROXY set to the address of our own server
// (server/worker.js on Cloudflare; see server/README.md), place search, Nominatim and the
// street data go through it: one well-behaved caller with a cache, which is what those
// services' usage rules ask of an app on many phones, and a provider can then be changed
// without an app update. Map tiles, elevation, land cover and Wikipedia are unaffected.
export const PROXY = '';

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
/** The Overpass servers to try in turn (through the proxy there is only one). */
export const overpassEndpoints = () => (PROXY ? [`${PROXY}/overpass`] : PUBLIC_OVERPASS);
