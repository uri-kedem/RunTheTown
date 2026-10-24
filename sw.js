// Service worker: keeps the app shell (page, styles, script, artwork, Leaflet) on the
// phone so the installed app opens instantly and still opens with no signal. Map
// tiles, elevation and traffic lights are cached by the app itself (js/cache.js,
// IndexedDB), so they are passed straight through here.
// CACHE_VERSION is stamped by build.py from the bundle's hash: a new build means a
// new cache, and the old one is dropped on activation.
const CACHE_VERSION = '2b232230';
const CACHE = `rtt-shell-${CACHE_VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/bundle.js',
  './manifest.webmanifest',
  './img/logo.png',
  './img/logo-white.png',
  './img/mark.png',
  './img/mark-white.png',
  './img/tour.png',
  './img/tour-white.png',
  './img/mark-orange.png',
  './img/tour-orange.png',
  './img/mark-outline.png',
  './img/tour-outline.png',
  './img/install-outline.png',
  './img/terms-outline.png',
  './img/install-icon.png',
  './img/terms-icon.png',
  './img/favicon.png',
  './img/icon-180.png',
  './img/icon-192.png',
  './img/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Fetch each file on its own so one failed CDN file does not block the install.
      Promise.all(SHELL.map((url) => cache.add(url).catch((err) => console.warn('sw: could not cache', url, err)))),
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
  const navigation = req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/js/bundle.js') || url.pathname.endsWith('/css/style.css');
  if (navigation) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }
  // Everything else in the shell (artwork, Leaflet, fonts): cache first.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    })),
  );
});
