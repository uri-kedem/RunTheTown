// Service worker: keeps the app shell (page, styles, script, artwork, Leaflet) on the
// phone so the installed app opens instantly and still opens with no signal. Map
// tiles, elevation and traffic lights are cached by the app itself (js/cache.js,
// IndexedDB), so they are passed straight through here.
// CACHE_VERSION is stamped by build.py from the bundle's hash: a new build means a
// new cache, and the old one is dropped on activation.
const CACHE_VERSION = '76c0c84d';
const CACHE = `rtt-shell-${CACHE_VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/bundle.js',
  './manifest.webmanifest',
  './img/logo.5e459302.png',
  './img/logo-white.0ef39459.png',
  './img/mark.2e286dc3.png',
  './img/mark-white.9eeeb348.png',
  './img/tour.5ad49c6a.png',
  './img/tour-white.0727a68d.png',
  './img/mark-orange.ae309202.png',
  './img/tour-orange.a8aa45ff.png',
  './img/mark-outline.ea7ffd72.png',
  './img/tour-outline.5fa6603a.png',
  './img/install-outline.2d915cdb.png',
  './img/terms-outline.3b878224.png',
  './img/install-icon.af1a2869.png',
  './img/terms-icon.d8a112dd.png',
  './img/favicon.1a6e36d1.png',
  './img/icon-180.d266ebe8.png',
  './img/icon-192.f5aabddb.png',
  './img/icon-512.a5709e23.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Fetch each file on its own so one failed CDN file does not block the install.
      // Straight from the network, past the browser's HTTP cache: the edge keeps files for
      // 10 minutes, and a fresh service worker must not install the previous build.
      Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('sw: could not cache', url, err)))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('rtt-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isShell = (url) => {
  if (url.origin === self.location.origin) return !/\/js\/(?!bundle\.js)/.test(url.pathname); // the page's own files
  return url.hostname === 'unpkg.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return; // tiles, Overpass, Open-Meteo, Nominatim: straight to the network

  // Page and script: network first (so a new build shows up), cache when offline.
  const navigation = req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/js/bundle.js') || url.pathname.endsWith('/css/style.css') || url.pathname.endsWith('/manifest.webmanifest');
  if (navigation) {
    event.respondWith(
      fetch(req).then((res) => {
        // Only a good answer is worth keeping: a 404 during a deploy or a 5xx must not
        // become what the app serves offline.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
    );
    return;
  }
  // Everything else in the shell (artwork, Leaflet, fonts): cache first.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
      return res;
    })),
  );
});
