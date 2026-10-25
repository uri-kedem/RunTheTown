// UI: map, start point, preferences and route results.

import { RouteEngine, MAX_DISTANCE_KM } from './engine.js';
import { haversine } from './geo.js';
import { Navigator, Voice, ScreenLock, GpsSource, SimulatedRun, paceShort } from './navigation.js';
import { fallbackLinks } from './details.js';

const COLORS = ['#2563eb', '#ea580c', '#9333ea', '#0891b2', '#16a34a', '#db2777'];
const DEFAULT_VIEW = { center: [32.0853, 34.7818], zoom: 13 }; // Tel Aviv until we know better
const $ = (id) => document.getElementById(id);

const state = {
  start: null, // { lat, lon, label }
  distanceKm: 5,
  prefs: { green: false, water: false, quiet: false, sights: false },
  terrain: 'any',
  routes: [],
  selected: 0,
  spots: [], // running spots around the start, found before any search
  mode: 'run', // 'run' | 'tour'
  runStyle: 'streets', // Running mode: 'streets' (loops from here) | 'laps' (a track, stadium or park loop nearby)
};

const engine = new RouteEngine();
let busy = false; // a route search is running
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

// ---------- Map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
// Map tiles: Esri first. OpenStreetMap's own tile servers refuse pages opened
// from a file (they answer with "Access blocked" images rather than errors,
// so a fallback can't detect it), and their policy discourages app use anyway.
const TILE_SOURCES = [
  {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' },
  },
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  },
];
let tileSource = 0;
function addTiles() {
  let errors = 0;
  const layer = L.tileLayer(TILE_SOURCES[tileSource].url, TILE_SOURCES[tileSource].opts).addTo(map);
  layer.on('tileerror', () => {
    if (++errors >= 4 && tileSource < TILE_SOURCES.length - 1) {
      layer.remove();
      tileSource++;
      addTiles();
    }
  });
}
addTiles();
if (isDesktop()) L.control.zoom({ position: 'topright' }).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
let startMarker = null;

function mapPadding() {
  if (isDesktop()) return { paddingTopLeft: [420, 40], paddingBottomRight: [40, 40] };
  return { paddingTopLeft: [24, 130], paddingBottomRight: [24, $('sheet').offsetHeight + 24] };
}

map.on('click', (e) => {
  if (state.routes.length) return; // while viewing results, taps select routes instead
  setStart(e.latlng.lat, e.latlng.lng, 'Dropped pin');
});

function setStart(lat, lon, label, { pan = true } = {}) {
  state.start = { lat, lon, label };
  if (!startMarker) {
    startMarker = L.marker([lat, lon], {
      draggable: true,
      icon: L.divIcon({ className: '', html: '<div class="start-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 1000,
    }).addTo(map);
    startMarker.on('dragend', () => {
      const p = startMarker.getLatLng();
      showPrefs();
      setStart(p.lat, p.lng, 'Dropped pin', { pan: false });
    });
  } else {
    startMarker.setLatLng([lat, lon]);
  }
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 14));
  $('startLine').innerHTML = `Starting from <b>${escapeHtml(label)}</b>`;
  updateGoButton();
  previewSpots();
}

// Tracks, stadiums and parks around the start, shown before any route is asked
// for. The map it downloads is the one the route search will use anyway.
let previewToken = 0;
function previewSpots() {
  const { start } = state;
  if (!start) return;
  const token = ++previewToken;
  const hint = $('spotsHint');
  hint.hidden = false;
  hint.textContent = 'Looking for running tracks and parks nearby…';
  clearTimeout(previewSpots.timer);
  const show = (spots, final) => {
    if (token !== previewToken) return; // the start moved meanwhile
    state.spots = spots;
    if (!state.routes.length) drawPlaces(spots, $('spotsPrefs'));
    hint.hidden = false;
    hint.textContent = spots.length
      ? `${spots.length} running spot${spots.length > 1 ? 's' : ''} within 8 km · tap one to plan your laps`
      : final ? 'No athletics tracks or stadiums within 8 km of here' : 'Looking for running tracks and parks nearby…';
    $('spotsEmpty').hidden = !(final && !spots.length);
  };
  previewSpots.timer = setTimeout(async () => {
    try {
      // 1) Stadiums and tracks city-wide, from a quick lookup: pins within seconds.
      const scanned = await engine.scanSpots(start.lat, start.lon);
      if (token !== previewToken) return;
      show(await engine.spotsNear(start.lat, start.lon, 8500, { scanned }), false);
      // 2) Then the map around the start: parks with their loops, and streets to run to the spots.
      show(await engine.previewSpots(start.lat, start.lon, { distanceKm: Math.max(5, state.distanceKm || 5) }), true);
    } catch {
      if (token === previewToken) hint.hidden = true;
    }
  }, 350);
}

function updateGoButton() {
  $('goBtn').disabled = busy || !state.start || !state.distanceValid;
}

// ---------- Location ----------
function locate({ quiet = false } = {}) {
  if (!navigator.geolocation) return quiet || toast('Location is not available in this browser.');
  $('locateBtn').classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('locateBtn').classList.remove('busy');
      setStart(pos.coords.latitude, pos.coords.longitude, 'Your location');
    },
    () => {
      $('locateBtn').classList.remove('busy');
      if (!quiet) toast("Couldn't get your location. Search for a place or tap the map instead.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}
$('locateBtn').addEventListener('click', () => {
  showPrefs();
  locate();
});

// ---------- Search with autocomplete (Photon, built on OpenStreetMap) ----------
const searchInput = $('searchInput');
const list = $('searchResults');
const ac = { items: [], active: -1, timer: null, controller: null, query: '' };

const ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  hotel: '<svg viewBox="0 0 24 24"><path d="M3 20V6M3 14h18v6M21 14v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="10.5" r="1.8"/></svg>',
  street: '<svg viewBox="0 0 24 24"><path d="M8 3 5 21M16 3l3 18M12 4v3M12 10v4M12 17v3"/></svg>',
  city: '<svg viewBox="0 0 24 24"><path d="M4 21V9l5-3v15M9 21V4l6 3v14M15 21v-9l5 2v7M3 21h18"/></svg>',
  park: '<svg viewBox="0 0 24 24"><path d="M12 22v-6M7 16h10l-5-13-5 13z"/></svg>',
  loc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
};

function iconFor(p) {
  const v = p.osm_value || '';
  if (/hotel|hostel|guest_house|motel|apartment/.test(v)) return ICONS.hotel;
  if (p.osm_key === 'highway' || p.type === 'street') return ICONS.street;
  if (/park|garden|beach|nature/.test(v)) return ICONS.park;
  if (/city|town|village|suburb|neighbourhood|quarter/.test(v) || p.type === 'city' || p.type === 'district') return ICONS.city;
  return ICONS.pin;
}

function photonToItem(f) {
  const p = f.properties || {};
  const streetLine = [p.street, p.housenumber].filter(Boolean).join(' ');
  const main = p.name || streetLine || p.city || 'Unnamed place';
  const secondary = [p.name ? streetLine : '', p.district || p.locality, p.city !== main ? p.city : '', p.country]
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i)
    .join(', ');
  const [lon, lat] = f.geometry.coordinates;
  return { main, secondary, lat, lon, icon: iconFor(p) };
}

// Bold the parts of the suggestion that match what was typed.
function highlight(text, query) {
  const words = query.trim().split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return escapeHtml(text);
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return text
    .split(re)
    .map((part, i) => (i % 2 ? `<b>${escapeHtml(part)}</b>` : escapeHtml(part)))
    .join('');
}

async function fetchSuggestions(q) {
  ac.controller?.abort();
  ac.controller = new AbortController();
  const c = state.start ? { lat: state.start.lat, lng: state.start.lon } : map.getCenter();
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=12&lang=en&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`;
  try {
    const res = await fetch(url, { signal: ac.controller.signal });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (searchInput.value.trim() !== q) return; // user kept typing
    // Long streets come back once per OSM segment: keep one of each.
    const seen = new Set();
    const items = (data.features || []).map(photonToItem).filter((it) => {
      const key = `${it.main}|${it.secondary}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    renderSuggestions(items.slice(0, 6), q);
  } catch (err) {
    if (err.name === 'AbortError') return;
    renderSuggestions([], q, "Suggestions unavailable. Press Enter to search.");
  }
}

function renderSuggestions(items, q, emptyText = 'No matching places') {
  ac.items = items;
  ac.query = q;
  ac.active = -1;
  list.innerHTML = '';
  if (!q) {
    // Empty box: offer the runner's own location first, like a maps app.
    ac.items = [{ main: 'Your location', secondary: 'Use GPS', icon: ICONS.loc, isLocation: true }];
  }
  if (!ac.items.length) {
    list.innerHTML = `<li class="muted">${escapeHtml(emptyText)}</li>`;
  }
  ac.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.id = `sugg-${i}`;
    li.setAttribute('role', 'option');
    li.innerHTML = `<span class="ico${it.isLocation ? ' loc' : ''}">${it.icon}</span>
      <span class="txt"><span class="main">${it.isLocation ? escapeHtml(it.main) : highlight(it.main, q)}</span>
      <small>${escapeHtml(it.secondary || '')}</small></span>`;
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box
    li.addEventListener('click', () => chooseSuggestion(i));
    li.addEventListener('mousemove', () => setActive(i));
    list.appendChild(li);
  });
  if (q && items.length) list.insertAdjacentHTML('beforeend', '<li class="powered" role="presentation">Search by Photon · © OpenStreetMap</li>');
  openList();
}

function openList() {
  list.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}
function closeList() {
  list.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}
function setActive(i) {
  ac.active = i;
  [...list.querySelectorAll('li[role=option]')].forEach((li, k) => li.classList.toggle('active', k === i));
  if (i >= 0) searchInput.setAttribute('aria-activedescendant', `sugg-${i}`);
}

function chooseSuggestion(i) {
  const it = ac.items[i];
  if (!it) return;
  closeList();
  searchInput.blur();
  showPrefs();
  if (it.isLocation) {
    searchInput.value = '';
    $('clearBtn').hidden = true;
    return locate();
  }
  searchInput.value = it.main;
  $('clearBtn').hidden = false;
  setStart(it.lat, it.lon, it.main);
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  $('clearBtn').hidden = !searchInput.value;
  clearTimeout(ac.timer);
  if (!q) return renderSuggestions([], '');
  if (q.length < 2) return;
  ac.timer = setTimeout(() => fetchSuggestions(q), 220);
});
searchInput.addEventListener('focus', () => {
  if (!searchInput.value.trim()) renderSuggestions([], '');
  else if (ac.items.length) openList();
});
searchInput.addEventListener('blur', () => setTimeout(closeList, 120));
searchInput.addEventListener('keydown', (e) => {
  const n = ac.items.length;
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault();
    if (list.hidden) openList();
    setActive((ac.active + 1) % n);
  } else if (e.key === 'ArrowUp' && n) {
    e.preventDefault();
    setActive((ac.active - 1 + n) % n);
  } else if (e.key === 'Escape') {
    closeList();
  }
});
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (ac.active >= 0) return chooseSuggestion(ac.active);
  const q = searchInput.value.trim();
  if (!q) return;
  if (ac.items.length && ac.query === q && !ac.items[0].isLocation) return chooseSuggestion(0);
  // Fallback: a single geocode with Nominatim.
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await res.json();
    if (!hit) return toast('No places found for that search.');
    ac.items = [{ main: hit.display_name.split(', ')[0], lat: +hit.lat, lon: +hit.lon }];
    chooseSuggestion(0);
  } catch {
    toast('Search is unavailable right now. Tap the map to set your start.');
  }
});
$('clearBtn').addEventListener('click', () => {
  searchInput.value = '';
  $('clearBtn').hidden = true;
  searchInput.focus();
  renderSuggestions([], '');
});

// ---------- Preferences ----------
const MIN_KM = 1;
const LONG_RUN_KM = 15;
state.distanceValid = true;

// The runner types the distance. Accepts "10", "7.5" or "7,5".
function readDistance() {
  const raw = $('distanceInput').value.trim().replace(',', '.');
  const v = Number(raw);
  const ok = raw !== '' && Number.isFinite(v) && v >= MIN_KM && v <= MAX_DISTANCE_KM;
  state.distanceValid = ok;
  if (ok) state.distanceKm = Math.round(v * 10) / 10;
  $('distanceBox').classList.toggle('invalid', !ok && raw !== '');
  const msg = $('distanceMsg');
  msg.classList.toggle('error', !ok);
  if (!ok) msg.textContent = raw === '' ? 'Type how many kilometers you want to run' : `Enter a distance between ${MIN_KM} and ${MAX_DISTANCE_KM} km`;
  else if (v > LONG_RUN_KM) msg.textContent = 'Long run: the first map download for this area takes a few seconds longer.';
  else msg.textContent = '';
  updateGoButton();
}
$('distanceInput').addEventListener('input', readDistance);
$('distanceInput').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
$('distanceInput').addEventListener('focus', (e) => e.target.select());
$('distanceBox').addEventListener('click', () => $('distanceInput').focus());

$('landscape').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.pref === 'sights') return; // sightseeing is a mode (the Sightseeing tour), not a toggle
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  state.prefs[b.dataset.pref] = on;
});
$('terrain').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.terrain = b.dataset.terrain;
  for (const x of $('terrain').children) {
    x.classList.toggle('on', x === b);
    x.setAttribute('aria-checked', String(x === b));
  }
});

// ---------- Planning ----------
$('goBtn').addEventListener('click', async () => {
  readDistance();
  if (!state.start || busy || !state.distanceValid) return;
  busy = true;
  $('goBtn').disabled = true;
  status('Getting ready…');
  try {
    const routes = await engine.plan({
      lat: state.start.lat,
      lon: state.start.lon,
      distanceKm: state.distanceKm,
      prefs: { ...state.prefs },
      terrain: state.terrain,
      onStatus: status,
    });
    state.routes = routes;
    showRoutes(routes);
    if (routes.partialMap) toast('A few edge pieces of the map didn\u2019t load, so routes stay within the part that did.');
    else if (routes.stopsUnknown) toast('Traffic-light data is unavailable right now (busy servers), so routes avoid busy junctions instead.');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong. Please try again.');
  } finally {
    busy = false;
    updateGoButton();
    status(null);
  }
});

function showRoutes(routes) {
  $('prefsView').hidden = true;
  $('resultsView').hidden = false;
  const bits = [`${state.distanceKm} km`];
  const p = state.prefs;
  if (p.green) bits.push('parks');
  if (p.water) bits.push('waterfront');
  if (p.quiet) bits.push('quiet');
  if (p.sights) bits.push('sightseeing');
  if (state.terrain !== 'any') bits.push(state.terrain);
  $('resultsSub').textContent = `${bits.join(' · ')} · from ${state.start.label}`;

  const cards = $('cards');
  cards.innerHTML = '';
  routes.forEach((r, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.style.setProperty('--c', COLORS[i]);
    // The card: name, distance, then the facts (climb & descent, traffic lights & road crossings,
    // landmarks on a tour) and the elevation profile. No landscape percentages.
    card.innerHTML = `
      <div class="card-top"><span class="swatch"></span><span class="card-name">${escapeHtml(r.name)}</span>${r.type === 'outback' ? '<span class="badge">Out &amp; back</span>' : r.type === 'laps' ? '<span class="badge laps">Laps</span>' : ''}</div>
      <div class="card-dist">${(r.distance / 1000).toFixed(2)}<small>km</small></div>
      <ul>${r.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>
      ${r.hasElevation ? profileSvg(r.profile) : ''}`;
    card.addEventListener('click', () => { selectRoute(i, { fit: true }); openRouteAsk(i); });
    cards.appendChild(card);
  });
  drawRoutes();
  drawPlaces(routes.places || []);
  selectRoute(0, { fit: true });
}

// ---------- Running spots: athletics tracks and big parks ----------
const fmtKmShort = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(m / 10) * 10} m`);
const PLACE_ICON = {
  track: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="6"/><rect x="7.5" y="9.5" width="9" height="5" rx="2.5"/></svg>',
  stadium: '<svg viewBox="0 0 24 24"><path d="M3 9c0-2 4-3.5 9-3.5s9 1.5 9 3.5v6c0 2-4 3.5-9 3.5S3 17 3 15z"/><path d="M3 9c0 2 4 3.5 9 3.5s9-1.5 9-3.5"/></svg>',
  park: '<svg viewBox="0 0 24 24"><path d="M12 3 6 11h3l-3 5h5v4h2v-4h5l-3-5h3z"/></svg>',
};
const placesLayer = L.layerGroup().addTo(map); // pins stay while routes come and go
let drawnPlaces = []; // what the pins and the list currently show
function placeText(p) {
  if (p.kind === 'track') return `${fmtKmShort(p.lapM)} athletics track`;
  if (p.kind === 'stadium') return `${p.sport && p.sport !== 'multi' ? p.sport + ' ' : ''}stadium`;
  return `park loop of ${fmtKmShort(p.lapM)}`;
}
function drawPlaces(places, list = $('places')) {
  placesLayer.clearLayers();
  drawnPlaces = places;
  for (const el of [$('places'), $('spotsPrefs')]) { el.innerHTML = ''; el.hidden = true; }
  list.innerHTML = '';
  list.hidden = !places.length;
  places.forEach((p, i) => {
    const marker = L.marker(p.entry, {
      icon: L.divIcon({ className: '', html: `<div class="place-pin ${p.kind}">${PLACE_ICON[p.kind]}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      zIndexOffset: 600,
    })
      .bindPopup(placePopup(p, i, null), { maxWidth: 280 })
      .addTo(placesLayer);
    p._marker = marker;
    // Website and details are looked up the first time the pin is opened.
    marker.on('popupopen', () => {
      if (p._details) return;
      engine.placeDetails(p).then((d) => {
        p._details = d || {};
        marker.setPopupContent(placePopup(p, i, p._details));
      });
    });
    if (i >= 6) return; // the nearest few in the list, all on the map
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `place ${p.kind}`;
    row.innerHTML = `<i>${PLACE_ICON[p.kind]}</i><span><b>${escapeHtml(p.name)}</b><small>${placeText(p)} · ${fmtKmShort(p.fromStart)} away</small></span>`;
    row.addEventListener('click', () => {
      map.setView(p.entry, Math.max(map.getZoom(), 15));
      if (list === $('spotsPrefs') && state.runStyle === 'laps' && p.ring) runAtPlace(i);
      else marker.openPopup();
    });
    list.appendChild(row);
  });
}
// Popup for a running spot: name, what it is, links (website, Wikipedia, map), hours, entry.
function placePopup(p, i, d) {
  const links = fallbackLinks(p);
  const ext = (href, label, cls = '') => `<a class="place-link ${cls}" href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`;
  let info;
  if (!d) info = '<div class="place-info muted">Looking up its website…</div>';
  else {
    const bits = [];
    if (d.website) bits.push(ext(d.website, `Website · ${escapeHtml(d.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, ''))}`, 'site'));
    if (d.wikipedia) bits.push(ext(d.wikipedia.url, 'Wikipedia'));
    if (!d.website && !d.wikipedia) bits.push(ext(links.search, 'Search the web'));
    bits.push(ext(links.maps, 'Google Maps'));
    const facts = [];
    if (d.hours) facts.push(`Hours: ${escapeHtml(d.hours)}`);
    if (d.fee === 'free') facts.push('Free entry');
    else if (d.fee === 'paid') facts.push('Entry fee');
    if (d.access === 'private') facts.push('Members only');
    if (d.phone) facts.push(`<a href="tel:${escapeHtml(d.phone.replace(/[^+\d]/g, ''))}">${escapeHtml(d.phone)}</a>`);
    info = `<div class="place-info"><div class="place-links">${bits.join('')}</div>${facts.length ? `<div class="place-facts">${facts.join(' · ')}</div>` : ''}</div>`;
  }
  return `<div class="place-pop"><b>${escapeHtml(p.name)}</b>${p.local && p.local !== p.name ? ` <span dir="auto">${escapeHtml(p.local)}</span>` : ''}
    <small>${placeText(p)} · ${fmtKmShort(p.fromStart)} from your start</small>${info}
    ${p.ring ? `<button type="button" class="place-run" data-i="${i}">${p.kind === 'park' ? 'Run loops here' : 'Run laps here'}</button>` : '<div class="place-note">No running track outline on the map for this stadium</div>'}</div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.place-run');
  if (!b) return;
  runAtPlace(+b.dataset.i);
});
// "Run laps here": first ask how far, then build the lap route (there, laps, back) and show it as a card.
let askedPlace = null;
function runAtPlace(i) {
  const place = drawnPlaces[i];
  if (!place || !state.start) return;
  map.closePopup?.();
  askedPlace = place;
  $('lapsAskTitle').textContent = place.kind === 'park' ? `Loops in ${place.name}` : `Laps at ${place.name}`;
  $('lapsKm').value = '';
  $('lapsMsg').textContent = place.lapM ? `One ${place.kind === 'park' ? 'loop' : 'lap'} is ${place.lapM >= 1000 ? (place.lapM / 1000).toFixed(1) + ' km' : place.lapM + ' m'}` : '';
  $('lapsMsg').classList.remove('error');
  $('lapsGo').disabled = true;
  $('lapsAsk').hidden = false;
  setTimeout(() => $('lapsKm').focus(), 50);
}
function readLapsKm() {
  const raw = $('lapsKm').value.trim().replace(',', '.');
  const v = Number(raw);
  const ok = raw !== '' && Number.isFinite(v) && v >= MIN_KM && v <= MAX_DISTANCE_KM;
  $('lapsGo').disabled = !ok;
  $('lapsBox').classList.toggle('invalid', !ok && raw !== '');
  const msg = $('lapsMsg');
  msg.classList.toggle('error', !ok && raw !== '');
  if (!ok && raw !== '') msg.textContent = `Enter a distance between ${MIN_KM} and ${MAX_DISTANCE_KM} km`;
  else if (ok && askedPlace?.ring && state.start) {
    // What that distance means here: the real plan (laps, plus the way there and back).
    const r = engine.routeAtPlace(askedPlace, { lat: state.start.lat, lon: state.start.lon, distanceKm: v, prefs: { ...state.prefs } });
    msg.textContent = r ? `${r.highlights[0]}${r.highlights[1]?.includes('there and back') ? ` · ${r.highlights[1]}` : ''} · ${(r.distance / 1000).toFixed(1)} km in total` : '';
  }
  return ok ? Math.round(v * 10) / 10 : null;
}
function closeLapsAsk() {
  $('lapsAsk').hidden = true;
  askedPlace = null;
}
function planLaps() {
  const km = readLapsKm();
  const place = askedPlace;
  if (km == null || !place || !state.start) return;
  closeLapsAsk();
  // The chosen distance becomes the app's distance too, so the next search matches.
  $('distanceInput').value = String(km);
  readDistance();
  const route = engine.routeAtPlace(place, { lat: state.start.lat, lon: state.start.lon, distanceKm: km, prefs: { ...state.prefs } });
  if (!route) return toast('The map around this spot isn\u2019t loaded yet. Set your start closer to it and try again.');
  route.place.wantedKm = km;
  // The lap run is the one route on offer; the spots stay on the map.
  const routes = Object.assign([route], { places: drawnPlaces });
  state.routes = routes;
  showRoutes(routes);
  selectRoute(0, { fit: true });
}
$('lapsKm').addEventListener('input', readLapsKm);
$('lapsKm').addEventListener('keydown', (e) => { if (e.key === 'Enter') planLaps(); if (e.key === 'Escape') closeLapsAsk(); });
$('lapsBox').addEventListener('click', () => $('lapsKm').focus());
$('lapsQuick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('lapsKm').value = b.dataset.km;
  readLapsKm();
});
$('lapsGo').addEventListener('click', planLaps);
$('lapsCancel').addEventListener('click', closeLapsAsk);
$('lapsAsk').addEventListener('click', (e) => { if (e.target === $('lapsAsk')) closeLapsAsk(); });

function drawRoutes() {
  routeLayer.clearLayers();
  state.routes.forEach((r, i) => {
    const casing = L.polyline(r.latlngs, { color: '#fff', weight: 9, opacity: 0.9, lineJoin: 'round' });
    const line = L.polyline(r.latlngs, { color: COLORS[i], weight: 5, opacity: 0.9, lineJoin: 'round' });
    for (const l of [casing, line]) l.on('click', () => { selectRoute(i); openRouteAsk(i); });
    r._layers = { casing, line };
    casing.addTo(routeLayer);
    line.addTo(routeLayer);
  });
  kmLayer = L.layerGroup().addTo(routeLayer);
}

let kmLayer = null;
function selectRoute(i, { fit = false } = {}) {
  state.selected = i;
  state.routes.forEach((r, k) => {
    const on = k === i;
    r._layers.line.setStyle({ opacity: on ? 1 : 0.35, weight: on ? 6 : 4 });
    r._layers.casing.setStyle({ opacity: on ? 0.95 : 0 });
    if (on) {
      r._layers.casing.bringToFront();
      r._layers.line.bringToFront();
    }
  });
  [...$('cards').children].forEach((c, k) => c.classList.toggle('on', k === i));
  const card = $('cards').children[i];
  if (card && !isDesktop()) card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  drawKmMarkers(state.routes[i], COLORS[i]);
  if (fit) map.fitBounds(L.latLngBounds(state.routes[i].latlngs), mapPadding());
}

function drawKmMarkers(route, color, layer = kmLayer) {
  layer.clearLayers();
  drawSights(route, layer);
  if (route.turnaround) {
    L.marker(route.turnaround, {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: `<div style="background:#fff;color:${color};font:800 11px Inter,sans-serif;padding:3px 7px;border-radius:8px;border:2px solid ${color};white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.25)">Turn around</div>`,
        iconSize: [84, 22],
        iconAnchor: [42, 30],
      }),
    }).addTo(layer);
  }
  let d = 0;
  let nextKm = 1;
  const pts = route.latlngs;
  for (let k = 1; k < pts.length; k++) {
    const seg = haversine(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
    while (d + seg >= nextKm * 1000 && nextKm * 1000 < route.distance - 150) {
      const t = (nextKm * 1000 - d) / seg;
      const lat = pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t;
      const lon = pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t;
      L.marker([lat, lon], {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: `<div style="background:${color};color:#fff;font:700 10px Inter,sans-serif;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)">${nextKm}</div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      }).addTo(layer);
      nextKm++;
    }
    d += seg;
  }
}

// Landmarks along the route: a star pin with the name (names hidden when crowded).
function drawSights(route, layer) {
  const list = route.sights || [];
  const labels = list.length <= 12;
  for (const sg of list) {
    const html = `<div class="sight-pin"><i>★</i>${labels ? `<span>${escapeHtml(sg.name)}</span>` : ''}</div>`;
    L.marker([sg.lat, sg.lon], { icon: L.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 500 })
      .bindPopup(`<b>${escapeHtml(sg.name)}</b>${sg.local && sg.local !== sg.name ? `<br><span dir="auto">${escapeHtml(sg.local)}</span>` : ''}<br><small>${escapeHtml(sg.kind || '')} · ${(sg.at / 1000).toFixed(1)} km into the run</small>`)
      .addTo(layer);
  }
}

function showPrefs() {
  $('prefsView').hidden = false;
  $('resultsView').hidden = true;
  state.routes = [];
  routeLayer.clearLayers();
  drawPlaces(state.spots || [], $('spotsPrefs'));
}
$('backBtn').addEventListener('click', showPrefs);

// ---------- Small helpers ----------
function profileSvg(profile) {
  if (!profile || profile.length < 2) return '';
  const W = 300;
  const H = 44;
  const maxD = profile[profile.length - 1][0] || 1;
  const zs = profile.map((p) => p[1]);
  const lo = Math.min(...zs);
  const hi = Math.max(...zs);
  const span = Math.max(hi - lo, 20); // keep flat routes looking flat
  const pts = profile.map(([d, z]) => [(d / maxD) * W, H - 4 - ((z - lo) / span) * (H - 10)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return `<svg class="profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Elevation profile, ${Math.round(lo)}–${Math.round(hi)} m">
    <path class="area" d="${line}L${W},${H}L0,${H}Z"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
}

function status(text) {
  $('status').hidden = !text;
  if (text) $('statusText').textContent = text;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Live navigation ----------
const voice = new Voice();
const screenLock = new ScreenLock();
const navLayer = L.layerGroup();
const nav = { active: null }; // { navigator, source, route, color, demo, ... }
const DEMO_RATES = [1, 6, 15];

// The route pop-up: name, distance, the facts, and the Start button.
function openRouteAsk(i) {
  const r = state.routes[i];
  if (!r) return;
  $('routeAskName').textContent = r.name;
  $('routeAskDist').textContent = (r.distance / 1000).toFixed(2);
  $('routeAskFacts').innerHTML = r.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  $('routeAsk').hidden = false;
}
function closeRouteAsk() {
  $('routeAsk').hidden = true;
}
$('routeAskClose').addEventListener('click', closeRouteAsk);
$('routeAsk').addEventListener('click', (e) => { if (e.target === $('routeAsk')) closeRouteAsk(); });
$('startRunBtn').addEventListener('click', () => { closeRouteAsk(); startRun({ demo: false }); });
$('demoRunBtn').addEventListener('click', () => { closeRouteAsk(); startRun({ demo: true }); });

// Running mode: run the streets (loops from here) or run in laps (a spot nearby).
function setRunStyle(style) {
  state.runStyle = style;
  $('prefsView').dataset.style = style;
  for (const b of $('runStyle').querySelectorAll('button')) {
    const on = b.dataset.style === style;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  if (style === 'laps' && state.start && !state.spots.length && !$('spotsEmpty').hidden) toast('No running spots were found near this start.');
}
$('runStyle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-style]');
  if (b) setRunStyle(b.dataset.style);
});
setRunStyle('streets');

function arrowSvg(type, dir) {
  const flip = dir === 'left' ? ' transform="translate(24 0) scale(-1 1)"' : '';
  const P = {
    straight: '<path d="M12 21V4"/><path d="m6 10 6-6 6 6"/>',
    turn: '<path d="M7 21v-8a4 4 0 0 1 4-4h9"/><path d="m15 4 5 5-5 5"/>',
    slight: '<path d="M8 21v-8l9-9"/><path d="M10 4h7v7"/>',
    sharp: '<path d="M6 21V9a4 4 0 0 1 7-2.6L19 15"/><path d="M19 9v6h-6"/>',
    uturn: '<path d="M6 21V9a5 5 0 0 1 10 0v9"/><path d="m11 14 5 5 5-5"/>',
    arrive: '<path d="M6 21V4h11l-2.5 4.5L17 13H6"/>',
  };
  const key = type === 'depart' || type === 'lap' ? 'straight' : P[type] ? type : 'turn';
  return `<svg viewBox="0 0 24 24"><g${type === 'uturn' || type === 'arrive' || type === 'depart' ? '' : flip}>${P[key]}</g></svg>`;
}

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50} m`);

async function startRun({ demo }) {
  const route = state.routes[state.selected];
  if (!route || nav.active) return;
  voice.unlock(); // must happen inside the tap
  const clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const navigator_ = new Navigator(route, {
    speak: (parts, opts) => voice.say(parts, opts),
    now: demo ? () => clock.t : () => Date.now(),
  });
  const n = (nav.active = { navigator: navigator_, route, color: COLORS[state.selected], demo, clock, follow: true, rate: 6 });

  document.body.classList.add('navigating');
  $('navView').hidden = false;
  $('navFinish').hidden = true;
  $('navDemo').hidden = !demo;
  $('navDemo').textContent = `DEMO ×${n.rate}`;
  $('navCaption').textContent = '';
  setPaused(false);
  map.removeLayer(routeLayer);
  navLayer.clearLayers().addTo(map);
  L.polyline(route.latlngs, { color: '#fff', weight: 11, opacity: 0.95, lineJoin: 'round' }).addTo(navLayer);
  L.polyline(route.latlngs, { color: n.color, weight: 7, opacity: 1, lineJoin: 'round' }).addTo(navLayer);
  n.doneLine = L.polyline([], { color: '#94a3b8', weight: 7, opacity: 1, lineJoin: 'round' }).addTo(navLayer);
  const extras = L.layerGroup().addTo(navLayer);
  drawKmMarkers(route, n.color, extras);
  n.userMarker = L.marker(route.latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000, interactive: false }).addTo(navLayer);
  map.setView(route.latlngs[0], 17);

  voice.onSay = (text) => ($('navCaption').textContent = text);
  const locked = await screenLock.acquire();
  $('navNote').textContent = locked
    ? 'Screen stays on during the run. Keep this page open; directions stop if you lock the phone or switch apps.'
    : 'Keep the screen on and this page open, or directions stop. Turn off auto-lock for the run if you can.';
  if (!voice.available) $('navNote').textContent = 'This browser can\u2019t speak, so directions are shown on screen only.';

  render(navigator_.start());
  const onFix = (fix) => {
    if (nav.active !== n || n.navigator.paused) return;
    render(n.navigator.update(fix));
  };
  if (demo) {
    n.source = new SimulatedRun(route, { rate: n.rate, clock });
    n.source.isPaused = () => n.navigator.paused;
    n.source.start(onFix);
  } else {
    n.source = new GpsSource();
    n.source.start(onFix, (err) => {
      if (nav.active !== n) return;
      if (err.code === 1) {
        endRun();
        toast('Location access is needed for live directions. Allow it in your browser settings, or try the demo run.');
      } else {
        showAlert('Waiting for GPS\u2026 Go outside with a clear view of the sky.');
      }
    });
  }
  n.timer = setInterval(() => {
    if (nav.active !== n) return;
    n.navigator.tick();
    $('statTime').textContent = fmtTime(n.navigator.elapsed);
  }, 1000);
}

function showAlert(text) {
  $('navAlert').hidden = !text;
  if (text) $('navAlert').textContent = text;
}

function render(v) {
  const n = nav.active;
  if (!n) return;
  const banner = $('navBanner');
  banner.classList.toggle('off', v.offRoute);
  if (v.finished) {
    $('navArrow').innerHTML = arrowSvg('arrive');
    $('navDist').textContent = '';
    $('navText').textContent = 'You\u2019re back at the start';
    $('navStreet').textContent = '';
  } else if (v.offRoute) {
    $('navArrow').innerHTML = arrowSvg('uturn');
    $('navDist').textContent = v.offBy != null ? `${fmtDist(v.offBy)} away` : '';
    $('navText').textContent = v.progress < 30 ? 'Head to the start' : 'Off route';
    $('navStreet').textContent = 'Head back to the colored line';
  } else if (v.next) {
    $('navArrow').innerHTML = arrowSvg(v.next.type, v.next.dir);
    $('navDist').textContent = fmtDist(v.next.in);
    $('navText').textContent = v.next.action;
    $('navStreet').textContent = v.next.street || '';
  }
  showAlert(null);
  $('statTime').textContent = fmtTime(v.elapsed);
  $('statDist').textContent = (v.odometer / 1000).toFixed(2);
  $('statPace').textContent = paceShort(v.pace);
  $('statLeft').textContent = (v.remaining / 1000).toFixed(1);
  $('navProgress').style.width = `${Math.min(100, (v.progress / n.navigator.total) * 100)}%`;

  // Done part of the route in grey, the runner's dot, and the map following.
  const nv = n.navigator;
  if (v.onRoute) n.doneLine.setLatLngs([...n.route.latlngs.slice(0, nv.seg + 1), v.onRoute]);
  const pos = v.fix ? [v.fix.lat, v.fix.lon] : null;
  if (pos) {
    n.userMarker.setLatLng(pos);
    if (n.follow) map.setView(pos, Math.max(map.getZoom(), 16), { animate: !n.demo || n.rate <= 6 });
  }
  if (v.finished && !n.done) {
    n.done = true;
    setTimeout(() => showFinish(v), 1200);
  }
}

function showFinish(v) {
  const n = nav.active;
  if (!n) return;
  n.source?.stop();
  $('finishStats').innerHTML = `
    <div><b>${(v.odometer / 1000).toFixed(2)}</b><span>km</span></div>
    <div><b>${fmtTime(v.elapsed)}</b><span>time</span></div>
    <div><b>${paceShort(v.pace)}</b><span>min/km</span></div>`;
  $('navFinish').hidden = false;
}

function endRun() {
  const n = nav.active;
  if (!n) return;
  n.source?.stop();
  clearInterval(n.timer);
  voice.stop();
  voice.onSay = null;
  screenLock.release();
  nav.active = null;
  navLayer.clearLayers();
  map.removeLayer(navLayer);
  routeLayer.addTo(map);
  document.body.classList.remove('navigating');
  $('navView').hidden = true;
  $('recenterBtn').hidden = true;
  resetEnd();
  if (state.routes[state.selected]) map.fitBounds(L.latLngBounds(state.routes[state.selected].latlngs), mapPadding());
}

function setPaused(p) {
  $('pauseBtn').classList.toggle('paused', p);
  $('pauseBtn').querySelector('span').textContent = p ? 'Resume' : 'Pause';
}
$('pauseBtn').addEventListener('click', () => {
  const n = nav.active;
  if (!n || n.navigator.finished) return;
  if (n.navigator.paused) n.navigator.resume();
  else n.navigator.pause();
  setPaused(n.navigator.paused);
});
$('muteBtn').addEventListener('click', () => {
  const m = !voice.muted;
  voice.setMuted(m);
  $('muteBtn').setAttribute('aria-pressed', String(m));
  $('muteBtn').querySelector('span').textContent = m ? 'Unmute' : 'Mute';
});
// Ending takes two taps, so a bump in a pocket doesn't stop the run.
let endTimer = null;
function resetEnd() {
  clearTimeout(endTimer);
  endTimer = null;
  $('endBtn').classList.remove('confirm');
  $('endBtn').querySelector('span').textContent = 'End run';
}
$('endBtn').addEventListener('click', () => {
  if (!nav.active) return;
  if (endTimer || nav.active.navigator.finished) return endRun();
  $('endBtn').classList.add('confirm');
  $('endBtn').querySelector('span').textContent = 'Tap again to end';
  endTimer = setTimeout(resetEnd, 3000);
});
$('finishDone').addEventListener('click', endRun);
$('navDemo').addEventListener('click', () => {
  const n = nav.active;
  if (!n?.demo) return;
  n.rate = DEMO_RATES[(DEMO_RATES.indexOf(n.rate) + 1) % DEMO_RATES.length];
  n.source.rate = n.rate;
  $('navDemo').textContent = `DEMO \u00d7${n.rate}`;
});
map.on('dragstart', () => {
  if (!nav.active) return;
  nav.active.follow = false;
  $('recenterBtn').hidden = false;
});
$('recenterBtn').addEventListener('click', () => {
  const n = nav.active;
  if (!n) return;
  n.follow = true;
  $('recenterBtn').hidden = true;
  map.setView(n.userMarker.getLatLng(), 17);
});

// ---------- Views: cover page, modes, side toolbar, terms ----------
const rail = $('rail');
function openDrawer(open) {
  rail.classList.toggle('open', open);
  $('drawerBackdrop').hidden = !open;
}
function setView(v) {
  document.body.dataset.view = v;
  if (v === 'app') setTimeout(() => map.invalidateSize?.(), 60);
}
// Running mode offers the landscape options (parks, waterfront, quiet streets) and never sightseeing;
// the Sightseeing tour is a mode of its own: sightseeing is on, the landscape options are put away.
function setMode(mode) {
  state.mode = mode;
  const tour = mode === 'tour';
  document.body.dataset.mode = mode;
  state.prefs.sights = tour;
  if (tour) for (const k of ['green', 'water', 'quiet']) state.prefs[k] = false;
  for (const b of $('landscape').querySelectorAll('[data-pref]')) b.setAttribute('aria-pressed', String(!!state.prefs[b.dataset.pref]));
  $('landscapeLabel').textContent = tour ? 'Mode' : 'Landscape';
  $('landscapeHint').textContent = tour ? 'landmarks on the way' : 'pick any';
  $('tourNote').hidden = !tour;
  $('modeBadge').textContent = tour ? 'Sightseeing tour' : 'Running mode';
  $('goBtn').textContent = tour ? 'Find my sightseeing routes' : 'Find my routes';
  highlightNav(mode);
}
// The menu marks whatever is on screen: a mode, a page, or nothing on the cover.
function highlightNav(target) {
  for (const b of rail.querySelectorAll('.rail-item')) b.classList.toggle('on', b.dataset.nav === target);
}
// Installed-app support (PWA): the service worker keeps the app shell on the phone;
// the "Install on your phone" page shows the steps for this device, or the real
// install button where the browser offers one (Chrome on Android and desktop).
function installSetup() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone) {
    $('installInstalled').hidden = false;
    $('installIos').hidden = true;
    $('installAndroid').hidden = true;
    $('railInstall').hidden = true;
  } else if (ios) $('installAndroid').hidden = true;
  else $('installIos').hidden = true;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') $('installBtn').hidden = true;
    deferred = null;
  });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; $('railInstall').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err));
  }
}

function navigate(target) {
  openDrawer(false);
  if (target === 'home') {
    $('terms').hidden = true;
    $('install').hidden = true;
    setView('home');
    highlightNav(null);
    return;
  }
  if (target === 'terms' || target === 'install') {
    for (const id of ['terms', 'install']) $(id).hidden = id !== target;
    $(target).scrollTop = 0;
    highlightNav(target);
    return;
  }
  $('terms').hidden = true;
  $('install').hidden = true;
  if (state.mode !== target && state.routes.length) showPrefs(); // a new mode starts from the preferences
  setMode(target);
  setView('app');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (b) navigate(b.dataset.nav);
});
$('homeMenu').addEventListener('click', () => openDrawer(true));
$('appMenu').addEventListener('click', () => openDrawer(true));
$('drawerBackdrop').addEventListener('click', () => openDrawer(false));
$('termsBack').addEventListener('click', () => { $('terms').hidden = true; highlightNav(document.body.dataset.view === 'app' ? state.mode : null); });
$('installBack').addEventListener('click', () => { $('install').hidden = true; highlightNav(document.body.dataset.view === 'app' ? state.mode : null); });
installSetup();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openDrawer(false); closeRouteAsk(); } });
setMode('run');
highlightNav(null); // the cover page is open: no menu item is "current" yet

// Expose for testing/debugging.
window.__rtt = { state, engine, map, setStart, nav, voice, navigate };

// Arriving somewhere new: try to find the runner right away.
locate({ quiet: true });
