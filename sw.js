// Service worker: keeps the app shell (page, styles, script, artwork, Leaflet) on the
// phone so the installed app opens instantly and still opens with no signal. Map
// tiles, elevation and traffic lights are cached by the app itself (js/cache.js,
// IndexedDB), so they are passed straight through here.
// CACHE_VERSION is stamped by build.py from the bundle's hash: a new build means a
// new cache, and the old one is dropped on activation.
const CACHE_VERSION = 'dd4b67ed';
const CACHE = `rtt-shell-${CACHE_VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/bundle.js',
  './js/vendor/capacitor.js',
  './manifest.webmanifest',
  './img/logo.5e459302.png',
  './img/logo-white.0ef39459.png',
  './img/mark.5b2d9fd6.png',
  './img/mark-white.bd6889b0.png',
  './img/tour.8f4e7cfb.png',
  './img/tour-white.408aa8e9.png',
  './img/mark-orange.4d07c951.png',
  './img/tour-orange.2f5ac823.png',
  './img/mark-outline.570c9973.png',
  './img/tour-outline.da8b5f9d.png',
  './img/install-outline.18f1e068.png',
  './img/terms-outline.5cd3bd29.png',
  './img/install-icon.92c58148.png',
  './img/terms-icon.07c4c41a.png',
  './img/favicon.e34a6874.png',
  './img/icon-180.1901e532.png',
  './img/icon-192.7de3f5f2.png',
  './img/icon-512.3c491c08.png',
  './js/vendor/maplibre-gl.css',
  './js/vendor/maplibre-gl.js',
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
