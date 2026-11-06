// UI: map, start point, preferences and route results.

import { RouteEngine, MAX_DISTANCE_KM } from './engine.js';
import { rejoinRoute, backRoute } from './planner.js';
import { haversine } from './geo.js';
import { Navigator, Voice, ScreenLock, GpsSource, SimulatedRun, paceShort, lenText, MILE } from './navigation.js';
import { loadSettings, saveSettings, houseVoices } from './settings.js';
import { loadProfile, saveProfile, validEmail, makeRun, drawRunPicture, journal } from './journal.js';
import { fallbackLinks } from './details.js';

const COLORS = ['#2563eb', '#ea580c', '#9333ea', '#0891b2', '#16a34a', '#db2777'];
const DEFAULT_VIEW = { center: [32.0853, 34.7818], zoom: 13 }; // Tel Aviv until we know better
const $ = (id) => document.getElementById(id);

// ---------- Settings (kept on the phone) ----------
const settings = loadSettings();
// Units on screen: numbers in km or miles, short lengths in m or ft.
const U = {
  get mi() { return settings.units === 'mi'; },
  get unit() { return settings.units === 'mi' ? 'mi' : 'km'; },
  num(m, dec = 1) { return (this.mi ? m / MILE : m / 1000).toFixed(dec); }, // "5.2"
  len(m) { return lenText(m, settings.units); }, // "5.2 km" / "450 m"
  lenShort(m) { return this.mi ? lenText(m, 'mi') : m >= 1000 ? `${(m / 1000).toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(m / 10) * 10} m`; },
  toKm(v) { return this.mi ? v * (MILE / 1000) : v; }, // a typed distance -> km
  fromKm(km) { return this.mi ? km / (MILE / 1000) : km; },
  pace(secPerKm) { return paceShort(this.mi ? secPerKm * (MILE / 1000) : secPerKm); },
  paceLabel() { return this.mi ? 'min/mi' : 'min/km'; },
};

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

// ---------- Bottom sheet (peek / half / full) and the search bar ----------
// The search bar leaves once a start point is set; the "Start point" button brings it back.
const POS = ['peek', 'half', 'full'];
function setSheet(pos) {
  if (isDesktop()) return;
  const sheet = $('sheet');
  sheet.dataset.pos = pos;
  if (pos !== 'full') sheet.scrollTop = 0;
  // The strip of routes stays visible in peek (sticky under the handle).
  const strip = $('routeStrip');
  strip.hidden = !(pos === 'peek' && state.routes.length);
  sheet.style.setProperty('--peek', state.routes.length ? '118px' : '96px');
}
function sheetPos() { return $('sheet').dataset.pos || 'half'; }
{
  const grab = $('sheetGrab');
  let drag = null;
  grab.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, h: $('sheet').offsetHeight, moved: false }; grab.setPointerCapture(e.pointerId); $('sheet').classList.add('dragging'); });
  grab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 6) drag.moved = true;
    $('sheet').style.maxHeight = `${Math.max(80, Math.min(window.innerHeight * 0.88, drag.h - dy))}px`;
  });
  const end = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const h = Math.max(80, drag.h - dy);
    $('sheet').classList.remove('dragging');
    $('sheet').style.maxHeight = '';
    if (!drag.moved) setSheet(sheetPos() === 'peek' ? 'half' : 'peek'); // a tap on the handle: peek <-> half
    else {
      const vh = window.innerHeight;
      setSheet(h < vh * 0.3 ? 'peek' : h < vh * 0.68 ? 'half' : 'full');
    }
    drag = null;
    setTimeout(() => { if (state.routes[state.selected]) map.fitBounds(L.latLngBounds(state.routes[state.selected].latlngs), mapPadding()); }, 280);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}
function showSearch(show) {
  document.querySelector('.topbar').classList.toggle('start-set', !show);
}
$('mapBack').addEventListener('click', () => {
  showSearch(true);
  setSheet('half');
  setTimeout(() => $('searchInput').focus(), 50);
});
function renderRouteStrip() {
  const strip = $('routeStrip');
  strip.innerHTML = '';
  state.routes.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.setProperty('--c', COLORS[i]);
    b.className = i === state.selected ? 'on' : '';
    b.innerHTML = `<i></i>${escapeHtml(r.name)}`;
    b.addEventListener('click', () => { lastTapped = i; selectRoute(i, { fit: true }); [...strip.children].forEach((c, k) => c.classList.toggle('on', k === i)); });
    strip.appendChild(b);
  });
}

function setStart(lat, lon, label, { pan = true } = {}) {
  state.start = { lat, lon, label };
  showSearch(false);
  if (!startMarker) {
    startMarker = L.marker([lat, lon], {
      draggable: true,
      icon: L.divIcon({ className: '', html: '<div class="start-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 1000,
    }).addTo(map);
    startMarker.on('dragend', () => {
      const p = startMarker.getLatLng();
      if (nav.active || busy) { startMarker.setLatLng([state.start.lat, state.start.lon]); return; } // not while running or planning
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
      ? `${spots.length} running spot${spots.length > 1 ? 's' : ''} within ${U.lenShort(8000)} · tap one to plan your laps`
      : final ? `No athletics tracks or stadiums within ${U.lenShort(8000)} of here` : 'Looking for running tracks and parks nearby…';
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
// Limits in the unit on screen (the planner works in km).
const limits = () => ({ min: Math.round(U.fromKm(MIN_KM) * 10) / 10, max: Math.round(U.fromKm(MAX_DISTANCE_KM) * 10) / 10 });
function readDistance() {
  const raw = $('distanceInput').value.trim().replace(',', '.');
  const v = Number(raw);
  const { min, max } = limits();
  const ok = raw !== '' && Number.isFinite(v) && v >= min && v <= max;
  state.distanceValid = ok;
  if (ok) state.distanceKm = Math.round(U.toKm(v) * 10) / 10;
  $('distanceBox').classList.toggle('invalid', !ok && raw !== '');
  const msg = $('distanceMsg');
  msg.classList.toggle('error', !ok);
  if (!ok) msg.textContent = raw === '' ? `Type how many ${U.mi ? 'miles' : 'kilometers'} you want to run` : `Enter a distance between ${min} and ${max} ${U.unit}`;
  else if (state.distanceKm > LONG_RUN_KM) msg.textContent = 'Long run: the first map download for this area takes a few seconds longer.';
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
    if (routes.country) toast('Country run: there is no paved network here, so unpaved lanes and tracks are included. Watch your footing.');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong. Please try again.');
  } finally {
    busy = false;
    updateGoButton();
    status(null);
  }
});

let lastTapped = -1; // the route the runner tapped last: a second tap on it opens the pop-up
function showRoutes(routes, { keep = false } = {}) {
  const keepIdx = keep ? state.selected : 0;
  if (!keep) lastTapped = -1;
  $('prefsView').hidden = true;
  $('resultsView').hidden = false;
  const bits = [`${U.num(state.distanceKm * 1000)} ${U.unit}`];
  const p = state.prefs;
  if (p.green) bits.push('parks');
  if (p.water) bits.push('waterfront');
  if (p.quiet) bits.push('quiet');
  if (p.sights) bits.push('sightseeing');
  if (state.terrain !== 'any') bits.push(state.terrain);
  $('resultsSub').textContent = `${bits.join(' · ')} · from ${state.start.label}`;
  // Fewer than three: only the landscape runs are offered (park paths, boardwalks, promenades).
  const note = $('resultsNote');
  if (note) note.textContent = (routes.length < 3 && routes.every((r) => r.stats?.promFrac >= 0.6) ? 'Only the landscape runs are shown: park paths, boardwalks and promenades for most of the way. ' : '') + 'Tap a route to see it on the map, tap it again to start.';

  const cards = $('cards');
  cards.innerHTML = '';
  routes.forEach((r, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.style.setProperty('--c', COLORS[i]);
    // The card: name, distance, then the facts (climb & descent, traffic lights & road crossings,
    // landmarks on a tour) and the elevation profile.
    card.innerHTML = `
      <div class="card-top"><span class="swatch"></span><span class="card-name">${escapeHtml(r.name)}</span>${r.type === 'outback' ? '<span class="badge">Out &amp; back</span>' : r.type === 'laps' ? '<span class="badge laps">Laps</span>' : ''}</div>
      <div class="card-dist">${U.num(r.distance, 2)}<small>${U.unit}</small></div>
      <ul>${r.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>
      ${r.hasElevation ? profileSvg(r.profile) : ''}`;
    // First tap picks the route (map and card light up); a second tap on it opens the pop-up.
    card.addEventListener('click', () => { const again = lastTapped === i; lastTapped = i; selectRoute(i, { fit: true }); if (again) openRouteAsk(i); });
    cards.appendChild(card);
  });
  drawRoutes();
  drawPlaces(routes.places || []);
  renderRouteStrip();
  if (!keep) setSheet('half');
  selectRoute(keepIdx, { fit: !keep });
}

// ---------- Running spots: athletics tracks and big parks ----------
const fmtKmShort = (m) => U.lenShort(m);
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
        if (!d?.failed) p._details = d || {}; // a failed lookup is tried again on the next open
        marker.setPopupContent(placePopup(p, i, d || {}));
      }).catch(() => {
        marker.setPopupContent(placePopup(p, i, {}));
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
  if (!place || !state.start || nav.active || busy) return; // not during a run or a search
  map.closePopup?.();
  askedPlace = place;
  $('lapsAskTitle').textContent = place.kind === 'park' ? `Loops in ${place.name}` : `Laps at ${place.name}`;
  $('lapsKm').value = '';
  $('lapsMsg').textContent = place.lapM ? `One ${place.kind === 'park' ? 'loop' : 'lap'} is ${U.len(place.lapM)}` : '';
  $('lapsMsg').classList.remove('error');
  $('lapsGo').disabled = true;
  $('lapsAsk').hidden = false;
  setTimeout(() => $('lapsKm').focus(), 50);
}
function readLapsKm() {
  const raw = $('lapsKm').value.trim().replace(',', '.');
  const v = Number(raw);
  const { min, max } = limits();
  const ok = raw !== '' && Number.isFinite(v) && v >= min && v <= max;
  $('lapsGo').disabled = !ok;
  $('lapsBox').classList.toggle('invalid', !ok && raw !== '');
  const msg = $('lapsMsg');
  msg.classList.toggle('error', !ok && raw !== '');
  if (!ok && raw !== '') msg.textContent = `Enter a distance between ${min} and ${max} ${U.unit}`;
  else if (ok && askedPlace?.ring && state.start) {
    // What that distance means here: the real plan (laps, plus the way there and back).
    const r = engine.routeAtPlace(askedPlace, { lat: state.start.lat, lon: state.start.lon, distanceKm: U.toKm(v), prefs: { ...state.prefs } });
    // Before the map reaches the spot, the way there is not known yet: say so instead of a lap count that will change.
    msg.textContent = r ? (r.highlights[1]?.includes('there and back') ? `${r.highlights[0]} · ${r.highlights[1]} · ${U.len(r.distance)} in total` : `Laps plus the way there and back from your start`) : '';
  }
  return ok ? Math.round(U.toKm(v) * 10) / 10 : null;
}
function closeLapsAsk() {
  $('lapsAsk').hidden = true;
  askedPlace = null;
}
async function planLaps() {
  const km = readLapsKm();
  const place = askedPlace;
  if (km == null || !place || !state.start) return;
  if (busy) return toast('Still working on the last search — one moment.');
  closeLapsAsk();
  // The chosen distance becomes the app's distance too, so the next search matches.
  $('distanceInput').value = String(Math.round(U.fromKm(km) * 10) / 10);
  readDistance();
  // The map must reach from the start to the spot (the spot list looks 8 km out, the
  // preview map only a few), or there is no way there and back to plan.
  const toPlace = haversine(state.start.lat, state.start.lon, place.lat, place.lon);
  busy = true;
  status('Loading the map to the track…');
  try {
    await engine.loadArea(state.start.lat, state.start.lon, Math.max(toPlace + 600, 1500), status);
  } catch (err) {
    console.error(err);
    toast(err.message || 'The map could not be loaded. Please try again.');
    busy = false;
    status(null);
    return;
  }
  busy = false;
  status(null);
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
  $('lapsKm').value = U.mi ? b.dataset.mi : b.dataset.km;
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
    for (const l of [casing, line]) l.on('click', () => { const again = lastTapped === i; lastTapped = i; selectRoute(i); if (again) openRouteAsk(i); });
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
  [...$('routeStrip').children].forEach((c, k) => c.classList.toggle('on', k === i));
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
      .bindPopup(`<b>${escapeHtml(sg.name)}</b>${sg.local && sg.local !== sg.name ? `<br><span dir="auto">${escapeHtml(sg.local)}</span>` : ''}<br><small>${escapeHtml(sg.kind || '')} · ${U.len(sg.at)} into the run</small>`)
      .addTo(layer);
  }
}

function showPrefs() {
  $('prefsView').hidden = false;
  $('resultsView').hidden = true;
  state.routes = [];
  $('routeStrip').hidden = true;
  setSheet('half');
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
  $('routeAskDist').textContent = U.num(r.distance, 2);
  $('routeAskUnit').textContent = U.unit;
  $('voiceBtn').textContent = voiceLabelText();
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
$('reportRouteBtn').addEventListener('click', () => { closeRouteAsk(); openReport(state.routes[state.selected], null); });

// ---------- Settings page ----------
// Voice (Zoe and Tom, the house voices, plus the phone's others), units, announcements,
// language, the map during the run, about. Every change is saved at once and applies to
// the next run; units apply to the screen right away.
voice.setVoice(settings.voice);

function applyUnits() {
  const { min, max } = limits();
  $('distanceUnit').textContent = U.unit;
  $('lapsUnit').textContent = U.unit;
  $('distanceHint').textContent = `${min}–${max} ${U.unit}`;
  for (const b of $('lapsQuick').querySelectorAll('button')) b.textContent = `${U.mi ? b.dataset.mi : b.dataset.km} ${U.unit}`;
  $('statDistLabel').textContent = `${U.unit} run`;
  $('statPaceLabel').textContent = U.paceLabel();
  $('statLeftLabel').textContent = `${U.unit} to go`;
  // The typed distance keeps its meaning: shown in the new unit.
  if (state.distanceValid) $('distanceInput').value = String(Math.round(U.fromKm(state.distanceKm) * 10) / 10);
  readDistance();
  if (state.routes.length) showRoutes(state.routes, { keep: true });
  if (!$('routeAsk').hidden && state.routes[state.selected]) openRouteAsk(state.selected);
  if (state.spots.length && !state.routes.length) drawPlaces(state.spots, $('spotsPrefs'));
}

const voiceLabelText = () => `Voice: ${voice.voices.en?.name?.replace(/\s*\((enhanced|premium|compact)\)/i, '') || 'default'}`;
let voiceShowAll = false;
function voiceRows() {
  const all = voice.synth?.getVoices?.() || [];
  const house = houseVoices(all);
  const rows = house.map((h) => ({ uri: h.voice?.voiceURI || null, name: h.name, sub: h.voice ? `${h.gender === 'female' ? 'Female' : 'Male'} · ${h.quality}` : `${h.gender === 'female' ? 'Female' : 'Male'} · not offered by this browser`, missing: !h.voice }));
  const houseUris = new Set(rows.map((r) => r.uri).filter(Boolean));
  const others = voice.options(8).filter((o) => !houseUris.has(o.uri) && !/^(zoe|tom)\b/i.test(o.name)).map((o) => ({ uri: o.uri, name: o.name, sub: `${o.accent} English`, missing: false }));
  return { rows, others, houseMissing: house.filter((h) => !h.voice) };
}
function currentVoiceUri() {
  return voice.voices.en?.voiceURI || null;
}
function renderVoices() {
  const { rows, others, houseMissing } = voiceRows();
  const cur = currentVoiceUri();
  const list = $('voiceList');
  list.innerHTML = '';
  const shown = voiceShowAll || houseMissing.length === rows.length ? [...rows, ...others] : rows;
  for (const o of shown) {
    const row = document.createElement('div');
    const on = !!o.uri && o.uri === cur;
    row.className = 'voice-row' + (on ? ' on' : '') + (o.missing ? ' missing' : '');
    row.innerHTML = `<span class="tick">${on ? '✓' : ''}</span><span class="who"><b>${escapeHtml(o.name)}</b><small>${escapeHtml(o.sub)}</small></span>` +
      (o.uri ? `<button type="button" class="play" aria-label="Play ${escapeHtml(o.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z" /></svg></button>` : '');
    row.addEventListener('click', (e) => {
      if (!o.uri) return;
      voice.unlock();
      settings.voice = o.uri;
      voice.setVoice(o.uri);
      saveSettings(settings);
      renderVoices();
      if (e.target.closest('.play')) voice.preview(o.uri);
    });
    list.appendChild(row);
  }
  const hint = $('voiceHint');
  if (houseMissing.length) {
    hint.hidden = false;
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    hint.textContent = ios
      ? `${houseMissing.map((h) => h.name).join(' and ')} ${houseMissing.length > 1 ? 'are' : 'is'} not available here: on iPhone, Safari and home-screen apps only get the built-in voices, not the ones you download (Apple's rule). They will read your directions in the App Store version. Until then pick one of the voices below.`
      : `${houseMissing.map((h) => h.name).join(' and ')} ${houseMissing.length > 1 ? 'are' : 'is'} not on this device. On iPhone: Settings → Accessibility → Spoken Content → Voices → English → ${houseMissing.map((h) => `${h.name} (${h.id === 'zoe' ? 'Premium' : 'Enhanced'})`).join(', ')}.`;
  } else hint.hidden = true;
  $('voiceMore').hidden = !others.length || houseMissing.length === rows.length;
  $('voiceMore').textContent = voiceShowAll ? 'Fewer voices' : 'More voices on this phone';
  $('voiceBtn').textContent = voiceLabelText();
}
$('voiceMore').addEventListener('click', () => { voiceShowAll = !voiceShowAll; renderVoices(); });
// Everything the browser reports, for checking why a downloaded voice is not offered.
$('voiceDiag').addEventListener('click', () => {
  const box = $('voiceDiagList');
  if (!box.hidden) { box.hidden = true; return; }
  const all = voice.synth?.getVoices?.() || [];
  box.textContent = all.length
    ? `${all.length} voices · ${navigator.userAgent.match(/(?:iPhone|CPU) OS (\d+_\d+)/)?.[1]?.replace('_', '.') || navigator.platform}\n` + all.map((v) => `${v.name} · ${v.lang}${v.localService ? '' : ' · online'} · ${v.voiceURI}`).join('\n')
    : 'The browser reports no voices at all.';
  box.hidden = false;
});
voice.synth?.addEventListener?.('voiceschanged', () => { if (!$('settings').hidden) renderVoices(); });

function setSegment(id, value) {
  for (const b of $(id).querySelectorAll('button')) { const on = b.dataset.v === String(value); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
}
function renderSettings() {
  renderVoices();
  setSegment('setUnits', settings.units);
  setSegment('setWarn', settings.warnM);
  for (const b of $('setWarn').querySelectorAll('button')) b.textContent = U.mi ? `${Math.round(Number(b.dataset.v) / 0.3048 / 10) * 10} ft` : `${b.dataset.v} m`;
  setSegment('setLang', settings.language);
  $('setSplits').checked = settings.splits;
  $('setLandmarks').checked = settings.landmarks;
  $('setQuiet').checked = settings.quiet;
  $('setSplits').disabled = $('setLandmarks').disabled = settings.quiet;
  $('setFollow').checked = settings.follow;
  $('setAwake').checked = settings.awake;
  $('settingsBuild').textContent = $('buildTag')?.dataset.build || 'dev';
}
$('setUnits').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b || b.dataset.v === settings.units) return;
  settings.units = b.dataset.v;
  saveSettings(settings);
  setSegment('setUnits', settings.units);
  applyUnits();
  renderSettings();
});
$('setWarn').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  settings.warnM = Number(b.dataset.v);
  saveSettings(settings);
  setSegment('setWarn', settings.warnM);
});
for (const [id, key] of [['setSplits', 'splits'], ['setLandmarks', 'landmarks'], ['setQuiet', 'quiet'], ['setFollow', 'follow'], ['setAwake', 'awake']]) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings(settings);
    if (key === 'quiet') { $('setSplits').disabled = $('setLandmarks').disabled = settings.quiet; }
    if (key === 'follow' && nav.active) { nav.active.follow = settings.follow; $('recenterBtn').hidden = settings.follow; }
    if (key === 'awake' && nav.active) { if (settings.awake) screenLock.acquire(); else screenLock.release(); }
  });
}
$('setUpdate').addEventListener('click', async () => {
  toast('Checking for a new version…');
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    const res = await fetch(`index.html?x=${Date.now()}`, { cache: 'no-store' });
    const html = await res.text();
    const live = html.match(/data-build="([^"]+)"/)?.[1];
    const here = $('buildTag')?.dataset.build;
    if (live && live !== here) toast(`Version ${live} is out. It loads the next time you open the app (or reload now).`);
    else toast(`You have the latest version (${here}).`);
  } catch {
    toast('Could not check right now.');
  }
});
function openSettings() {
  openDrawer(false);
  $('terms').hidden = true;
  $('install').hidden = true;
  voice.unlock();
  renderSettings();
  $('settings').hidden = false;
  $('settings').scrollTop = 0;
  highlightNav('settings');
}
$('settingsBack').addEventListener('click', () => { $('settings').hidden = true; highlightNav(document.body.dataset.view === 'app' ? state.mode : null); });

// ---------- Report a problem ----------
// A runner who meets a locked gate, a road without a sidewalk or a wrong turn can say so
// in two taps. The report is kept on the phone (the last 50) and goes out as an e-mail
// the runner sends themself: no server, nothing leaves the phone without their say-so.
const REPORT_TO = 'uri.kedem1@gmail.com';
const REPORT_REASONS = {
  closed: 'Closed or private', sidewalk: 'Road with no sidewalk', unsafe: 'Felt unsafe',
  directions: 'Wrong directions', landscape: 'Not the scenery promised', other: 'Something else',
};
const report = { route: null, at: null, reason: null };
function openReport(route, at) {
  if (!route) return;
  report.route = route;
  report.at = at; // the runner's position during a run, null from the route pop-up
  report.reason = null;
  $('reportSub').textContent = at ? 'What is wrong here? Your position is included.' : `What went wrong with “${route.name}”?`;
  for (const b of $('reportReasons').querySelectorAll('button')) b.classList.remove('on');
  $('reportNote').value = '';
  $('reportSend').disabled = true;
  $('reportAsk').hidden = false;
}
function closeReport() {
  $('reportAsk').hidden = true;
}
$('reportReasons').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-reason]');
  if (!b) return;
  report.reason = b.dataset.reason;
  for (const x of $('reportReasons').querySelectorAll('button')) x.classList.toggle('on', x === b);
  $('reportSend').disabled = false;
});
$('reportCancel').addEventListener('click', closeReport);
$('reportAsk').addEventListener('click', (e) => { if (e.target === $('reportAsk')) closeReport(); });
$('reportSend').addEventListener('click', () => {
  const r = report.route;
  if (!r || !report.reason) return;
  const fmt = (p) => (p ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : '-');
  const entry = {
    time: new Date().toISOString(),
    build: $('buildTag')?.dataset.build || 'dev',
    reason: report.reason,
    note: $('reportNote').value.trim(),
    route: r.name,
    distance: Math.round(r.distance),
    start: state.start ? { lat: state.start.lat, lon: state.start.lon } : null,
    at: report.at ? { lat: report.at.lat, lon: report.at.lon } : null,
    type: r.type || 'loop',
  };
  try {
    const all = JSON.parse(localStorage.getItem('rtt-reports') || '[]');
    all.push(entry);
    localStorage.setItem('rtt-reports', JSON.stringify(all.slice(-50)));
  } catch {}
  const lines = [
    `Problem: ${REPORT_REASONS[entry.reason]}`,
    entry.note ? `Note: ${entry.note}` : null,
    '',
    `Route: ${entry.route} (${(entry.distance / 1000).toFixed(2)} km, ${entry.type})`,
    `Where: ${fmt(entry.at)}${entry.at ? ` https://www.openstreetmap.org/?mlat=${entry.at.lat.toFixed(5)}&mlon=${entry.at.lon.toFixed(5)}#map=17/${entry.at.lat.toFixed(5)}/${entry.at.lon.toFixed(5)}` : ''}`,
    `Start: ${fmt(entry.start)}`,
    `Build: ${entry.build} · ${entry.time}`,
  ].filter((l) => l != null);
  const subject = `RunTheTown report: ${REPORT_REASONS[entry.reason]}`;
  closeReport();
  toast('Thanks. Your e-mail app opens with the report; just send it.');
  window.location.href = `mailto:${REPORT_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
});

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
const fmtDist = (m) => (U.mi ? U.len(m) : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50} m`);

async function startRun({ demo }) {
  const route = state.routes[state.selected];
  if (!route || nav.active) return;
  voice.unlock(); // must happen inside the tap
  const clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const navigator_ = new Navigator(route, {
    speak: (parts, opts) => voice.say(parts, opts),
    now: demo ? () => clock.t : () => Date.now(),
    units: settings.units, splits: settings.splits, landmarks: settings.landmarks, quiet: settings.quiet, warnM: settings.warnM,
    onTurnaround: (where) => turnedAroundOnLoop(where),
  });
  const n = (nav.active = { navigator: navigator_, route, color: COLORS[state.selected], demo, clock, follow: settings.follow, rate: 6, track: [], startedAt: new Date().toISOString(), saved: false });
  $('recenterBtn').hidden = settings.follow;

  document.body.classList.add('navigating');
  startMarker?.dragging?.disable(); // the start stays put during the run
  map.closePopup?.();
  $('navView').hidden = false;
  $('navFinish').hidden = true;
  $('navDemo').hidden = !demo;
  $('navDemo').textContent = `DEMO ×${n.rate}`;
  $('navCaption').textContent = '';
  setPaused(false);
  map.removeLayer(routeLayer);
  navLayer.clearLayers().addTo(map);
  n.lines = [
    L.polyline(route.latlngs, { color: '#fff', weight: 11, opacity: 0.95, lineJoin: 'round' }).addTo(navLayer),
    L.polyline(route.latlngs, { color: n.color, weight: 7, opacity: 1, lineJoin: 'round' }).addTo(navLayer),
  ];
  n.doneLine = L.polyline([], { color: '#94a3b8', weight: 7, opacity: 1, lineJoin: 'round' }).addTo(navLayer);
  const extras = L.layerGroup().addTo(navLayer);
  drawKmMarkers(route, n.color, extras);
  n.userMarker = L.marker(route.latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000, interactive: false }).addTo(navLayer);
  map.setView(route.latlngs[0], 17);

  voice.onSay = (text) => ($('navCaption').textContent = text);
  const locked = settings.awake ? await screenLock.acquire() : false;
  if (nav.active !== n) { screenLock.release(); return; } // ended (or restarted) while the lock was being acquired
  $('navNote').textContent = locked
    ? 'Screen stays on during the run. Keep this page open; directions stop if you lock the phone or switch apps.'
    : 'Keep the screen on and this page open, or directions stop. Turn off auto-lock for the run if you can.';
  if (!voice.available) $('navNote').textContent = 'This browser can\u2019t speak, so directions are shown on screen only.';

  render(navigator_.start());
  const onFix = (fix) => {
    if (nav.active !== n || n.navigator.paused) return;
    n.lastFix = fix;
    if (!demo && (fix.accuracy == null || fix.accuracy <= 60)) n.track.push([fix.lat, fix.lon]);
    const v = n.navigator.update(fix);
    render(v);
    if (v.offRoute && !demo) maybeReroute(n, fix);
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

// Off the line for a while: plan the way from here back onto the route further on,
// like a car navigator, instead of only asking the runner to go back. At most once
// every 45 s, only with a decent GPS fix, and only when the map covers the runner.
const REROUTE_AFTER_MS = 12000;
function maybeReroute(n, fix) {
  const nv = n.navigator;
  const now = Date.now();
  if (!nv.offSince || now - nv.offSince < REROUTE_AFTER_MS) return;
  if (now - (n.lastReroute || 0) < 45000) return;
  if (fix.accuracy != null && fix.accuracy > 40) return;
  const area = engine.area;
  if (!area) return;
  n.lastReroute = now;
  // Join the old line ~250 m ahead of where the runner left it (the next vertex past that).
  const target = nv.progress + 250;
  let joinIdx = nv.along.findIndex((a) => a >= target);
  if (joinIdx < 0) joinIdx = nv.along.length - 1;
  const fresh = rejoinRoute(area.graph, area.proj, { lat: fix.lat, lon: fix.lon }, nv.route, joinIdx);
  if (!fresh) return;
  n.route = fresh;
  render(nv.reroute(fresh));
  // Redraw the line to follow (the part already run stays grey).
  n.lines?.forEach((l) => l.remove());
  n.lines = [
    L.polyline(fresh.latlngs, { color: '#fff', weight: 11, opacity: 0.95, lineJoin: 'round' }).addTo(navLayer),
    L.polyline(fresh.latlngs, { color: n.color, weight: 7, opacity: 1, lineJoin: 'round' }).addTo(navLayer),
  ];
  n.doneLine?.bringToFront?.();
  n.userMarker?.setZIndexOffset?.(1000);
  toast('New route from here: it joins your run a little further on.');
}

// The runner turned around on a loop (no return leg to switch to): the rest of the run is
// the way back to the start along what they have already run.
function turnedAroundOnLoop({ seg }) {
  const n = nav.active;
  const area = engine.area;
  if (!n || !area || !n.lastFix) return false;
  const fresh = backRoute(area.graph, area.proj, { lat: n.lastFix.lat, lon: n.lastFix.lon }, n.route, seg);
  if (!fresh) return false;
  n.route = fresh;
  render(n.navigator.reroute(fresh, { say: false }));
  n.lines?.forEach((l) => l.remove());
  n.lines = [
    L.polyline(fresh.latlngs, { color: '#fff', weight: 11, opacity: 0.95, lineJoin: 'round' }).addTo(navLayer),
    L.polyline(fresh.latlngs, { color: n.color, weight: 7, opacity: 1, lineJoin: 'round' }).addTo(navLayer),
  ];
  n.doneLine?.setLatLngs([]);
  voice.say([{ text: `Turned around? Heading back the way you came. ${U.mi ? (fresh.distance / MILE).toFixed(1) + ' miles' : (fresh.distance / 1000).toFixed(1) + ' kilometers'} to the start.` }], { priority: 3 });
  toast('Turned around: the route now leads back to the start the way you came.');
  return true;
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
  } else if (v.joining && v.toLine != null) {
    $('navArrow').innerHTML = arrowSvg('depart');
    $('navDist').textContent = fmtDist(v.toLine);
    $('navText').textContent = 'To the route';
    $('navStreet').textContent = 'Your run starts where you meet the line';
  } else if (v.offRoute) {
    $('navArrow').innerHTML = arrowSvg('uturn');
    $('navDist').textContent = v.offBy != null ? `${fmtDist(v.offBy)} away` : '';
    $('navText').textContent = 'Off route';
    $('navStreet').textContent = 'Head back to the colored line';
  } else if (v.next) {
    $('navArrow').innerHTML = arrowSvg(v.next.type, v.next.dir);
    $('navDist').textContent = fmtDist(v.next.in);
    $('navText').textContent = v.next.action;
    $('navStreet').textContent = v.next.street || '';
  }
  showAlert(null);
  $('statTime').textContent = fmtTime(v.elapsed);
  $('statDist').textContent = U.num(v.odometer, 2);
  $('statPace').textContent = U.pace(v.pace);
  $('statLeft').textContent = U.num(v.remaining, 1);
  $('navProgress').style.width = `${Math.min(100, (v.progress / n.navigator.total) * 100)}%`;

  // Done part of the route in grey, the runner's dot, and the map following.
  const nv = n.navigator;
  if (v.onRoute) n.doneLine.setLatLngs([...n.route.latlngs.slice(0, nv.seg + 1), v.onRoute]);
  const pos = v.fix ? [v.fix.lat, v.fix.lon] : null;
  if (pos) {
    n.userMarker.setLatLng(pos);
    if (n.follow) map.setView(pos, map.getZoom(), { animate: !n.demo || n.rate <= 6 }); // follow at the zoom the runner chose
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
    <div><b>${U.num(v.odometer, 2)}</b><span>${U.unit}</span></div>
    <div><b>${fmtTime(v.elapsed)}</b><span>time</span></div>
    <div><b>${U.pace(v.pace)}</b><span>${U.paceLabel()}</span></div>`;
  $('navFinish').hidden = false;
  saveRun(n, { finished: true });
}

// ---------- The run journal ----------
// Every finished run, and every run stopped after 500 m, is kept on the phone with a
// picture of the route over the map. Demo runs are not logged.
async function saveRun(n, { finished }) {
  if (!n || n.saved || n.demo) return;
  const nv = n.navigator;
  if (!finished && nv.odometer < 500) return;
  n.saved = true;
  const run = makeRun({
    route: n.route, track: n.track, odometer: nv.odometer, elapsed: nv.elapsed, startedAt: n.startedAt, start: state.start, settings,
    country: !!state.routes.country, rerouted: !!(nv.rerouted || nv.turnarounds), finished,
  });
  try {
    run.picture = await drawRunPicture(run, { tileUrl: TILE_SOURCES[tileSource].url });
  } catch {
    run.picture = null;
  }
  try {
    await journal.save(run);
    refreshRailUser();
    toast(`Run saved to your journal${run.picture ? '' : ' (no map picture this time)'}.`);
  } catch {
    toast('Could not save this run on the phone.');
  }
}

function endRun() {
  const n = nav.active;
  if (!n) return;
  n.source?.stop();
  saveRun(n, { finished: n.navigator.finished });
  clearInterval(n.timer);
  voice.stop();
  voice.onSay = null;
  screenLock.release();
  nav.active = null;
  navLayer.clearLayers();
  map.removeLayer(navLayer);
  routeLayer.addTo(map);
  document.body.classList.remove('navigating');
  startMarker?.dragging?.enable();
  window.dispatchEvent(new Event('rtt:runended')); // a build update that waited for the run can reload now
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
$('reportRunBtn').addEventListener('click', () => {
  const n = nav.active;
  if (!n) return;
  openReport(n.route, n.lastFix ? { lat: n.lastFix.lat, lon: n.lastFix.lon } : null);
});
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
    const d = deferred;
    deferred = null; // the browser allows one prompt per saved event; the button hides until the next one
    $('installBtn').hidden = true;
    try {
      d.prompt();
      await d.userChoice;
    } catch {}
  });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; $('railInstall').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // A new build shows on the first open: once the new service worker has taken over
    // (it skips waiting and claims the page), reload so the page runs the new files.
    // Never while a run is on: the reload waits for the run to end.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // first install, nothing to swap
      // At most one reload every few minutes: GitHub's edge caches can hand out an old
      // and a new sw.js in turn for a while, which would otherwise reload in a loop.
      let last = 0;
      try { last = Number(sessionStorage.getItem('rtt-reload-at') || 0); } catch {}
      if (Date.now() - last < 3 * 60 * 1000) return;
      const reload = () => {
        try { sessionStorage.setItem('rtt-reload-at', String(Date.now())); } catch {}
        location.reload();
      };
      // Never mid-run, and not while a search or the laps dialog is in progress.
      const waiting = () => document.body.classList.contains('navigating') || busy || !$('lapsAsk').hidden;
      if (!waiting()) return reload();
      const tryLater = () => { if (!waiting()) { reload(); } else setTimeout(tryLater, 2000); };
      window.addEventListener('rtt:runended', tryLater, { once: true });
      setTimeout(tryLater, 2000);
    });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update().catch(() => {})).catch((err) => console.warn('Service worker not registered:', err));
  }
}

function navigate(target) {
  openDrawer(false);
  if (target === 'home') {
    $('terms').hidden = true;
    $('install').hidden = true;
    $('settings').hidden = true;
    for (const id of ['profile', 'runs', 'runPage']) $(id).hidden = true;
    setView('home');
    highlightNav(null);
    return;
  }
  if (target === 'settings') return openSettings();
  if (target === 'profile') return openProfile();
  if (target === 'runs') return openRuns();
  $('settings').hidden = true;
  for (const id of ['profile', 'runs', 'runPage']) $(id).hidden = true;
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openDrawer(false); closeRouteAsk(); if (!$('lapsAsk').hidden) closeLapsAsk(); } });
setMode('run');
highlightNav(null); // the cover page is open: no menu item is "current" yet

// ---------- Profile (first run of the app) and the journal pages ----------
let profile = loadProfile();
const initials = (name) => (name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
function avatarInto(el, p) {
  if (p?.photo) { el.style.backgroundImage = `url(${p.photo})`; el.textContent = ''; }
  else { el.style.backgroundImage = ''; el.textContent = initials(p?.name); }
}
async function refreshRailUser() {
  avatarInto($('railAvatar'), profile);
  if (profile?.name) {
    $('railName').textContent = profile.name;
    try { const t = await journal.totals(); $('railRuns').textContent = t.runs ? `${t.runs} run${t.runs > 1 ? 's' : ''} · ${U.len(t.distance)}` : 'No runs yet'; } catch { $('railRuns').textContent = ''; }
  } else {
    $('railName').textContent = 'Set up your profile';
    $('railRuns').textContent = 'name, e-mail, photo';
  }
}
let photoDraft = null;
// The profile page's big avatar: the label (background) and the initials span inside it.
function previewPhoto(photo, name) {
  const label = $('photoPick');
  const span = $('photoPreview');
  label.style.backgroundImage = photo ? `url(${photo})` : '';
  span.textContent = photo ? '' : initials(name);
}
function openProfile({ first = false } = {}) {
  openDrawer(false);
  for (const id of ['terms', 'install', 'settings', 'runs', 'runPage']) $(id).hidden = true;
  $('profileTitle').textContent = first ? 'Welcome to RunTheTown' : 'Your profile';
  $('profileIntro').hidden = !first && !!profile?.name;
  $('profileName').value = profile?.name || '';
  $('profileEmail').value = profile?.email || '';
  photoDraft = profile?.photo || null;
  previewPhoto(photoDraft, profile?.name);
  $('profileMsg').textContent = '';
  $('profileSkip').hidden = !first;
  $('profileBack').hidden = first;
  $('profileSave').textContent = first ? 'Start running' : 'Save';
  const totals = $('profileTotals');
  totals.hidden = true;
  if (profile?.name) journal.totals().then((t) => {
    totals.hidden = false;
    totals.innerHTML = `<div><b>${t.runs}</b><span>runs</span></div><div><b>${U.num(t.distance, 1)}</b><span>${U.unit}</span></div><div><b>${fmtTime(t.elapsed)}</b><span>time</span></div>`;
  }).catch(() => {});
  $('profile').hidden = false;
  $('profile').scrollTop = 0;
  highlightNav('profile');
}
$('photoInput').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  e.target.value = '';
  try {
    const photo = await cropPhoto(f); // move and zoom inside the circle, then a 160 px JPEG
    if (photo) { photoDraft = photo; previewPhoto(photoDraft, $('profileName').value); }
  } catch (err) {
    $('profileMsg').textContent = `Could not open that photo (${err?.message || 'unknown error'}).`;
  }
});
$('profileName').addEventListener('input', () => { if (!photoDraft) previewPhoto(null, $('profileName').value); });

// Circle crop: the photo in a 280 px stage, dragged and zoomed; the 240 px circle in the
// middle becomes the avatar.
function cropPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    // The dialog opens at once (a big phone photo takes a moment to decode).
    $('cropAsk').hidden = false;
    $('cropCancel').onclick = () => { $('cropAsk').hidden = true; URL.revokeObjectURL(url); resolve(null); };
    $('cropDone').onclick = null;
    img.onload = () => {
      const stage = $('cropStage');
      const canvas = $('cropCanvas');
      const ctx = canvas.getContext('2d');
      const SZ = 280, CIRCLE = 240;
      const base = Math.max(CIRCLE / img.width, CIRCLE / img.height); // the photo covers the circle at zoom 1
      let zoom = 1, ox = 0, oy = 0; // offsets of the photo centre from the stage centre (stage px)
      const scale = () => base * zoom;
      const clamp = () => {
        const w = img.width * scale(), h = img.height * scale();
        const mx = Math.max(0, (w - CIRCLE) / 2), my = Math.max(0, (h - CIRCLE) / 2);
        ox = Math.max(-mx, Math.min(mx, ox));
        oy = Math.max(-my, Math.min(my, oy));
      };
      const draw = () => {
        clamp();
        const w = img.width * scale(), h = img.height * scale();
        ctx.clearRect(0, 0, SZ, SZ);
        ctx.drawImage(img, SZ / 2 + ox - w / 2, SZ / 2 + oy - h / 2, w, h);
      };
      const zoomEl = $('cropZoom');
      zoomEl.value = '1';
      zoomEl.oninput = () => { zoom = Number(zoomEl.value); draw(); };
      let drag = null;
      stage.onpointerdown = (ev) => { drag = { x: ev.clientX, y: ev.clientY, ox, oy }; stage.setPointerCapture(ev.pointerId); };
      stage.onpointermove = (ev) => { if (!drag) return; ox = drag.ox + (ev.clientX - drag.x); oy = drag.oy + (ev.clientY - drag.y); draw(); };
      stage.onpointerup = stage.onpointercancel = () => { drag = null; };
      const close = (result) => { $('cropAsk').hidden = true; URL.revokeObjectURL(url); stage.onpointerdown = stage.onpointermove = stage.onpointerup = null; resolve(result); };
      $('cropCancel').onclick = () => close(null);
      $('cropDone').onclick = () => {
        const out = document.createElement('canvas');
        out.width = out.height = 160;
        const o = out.getContext('2d');
        const k = 160 / CIRCLE;
        const w = img.width * scale() * k, h = img.height * scale() * k;
        o.fillStyle = '#fff'; o.fillRect(0, 0, 160, 160); // the corners outside the circle are hidden by the round avatar
        o.beginPath(); o.arc(80, 80, 80, 0, Math.PI * 2); o.clip();
        o.drawImage(img, 80 + ox * k - w / 2, 80 + oy * k - h / 2, w, h);
        close(out.toDataURL('image/jpeg', 0.85));
      };
      draw();
      $('cropAsk').hidden = false;
    };
    img.onerror = () => { $('cropAsk').hidden = true; URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}
$('profileSave').addEventListener('click', () => {
  const name = $('profileName').value.trim();
  const email = $('profileEmail').value.trim();
  if (!name) { $('profileMsg').textContent = 'Please type your name.'; return; }
  if (!validEmail(email)) { $('profileMsg').textContent = 'That e-mail address does not look right.'; return; }
  profile = saveProfile({ ...(profile || {}), name, email, photo: photoDraft, skipped: false });
  refreshRailUser();
  $('profile').hidden = true;
  highlightNav(document.body.dataset.view === 'app' ? state.mode : null);
  toast(`Welcome, ${name.split(' ')[0]}. Your runs will be saved to your journal.`);
});
$('profileSkip').addEventListener('click', () => {
  profile = saveProfile({ name: '', email: '', photo: null, skipped: true });
  $('profile').hidden = true;
  highlightNav(null);
});
$('profileBack').addEventListener('click', () => { $('profile').hidden = true; highlightNav(document.body.dataset.view === 'app' ? state.mode : null); });

const fmtWhen = (iso) => { const d = new Date(iso); return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
async function openRuns() {
  openDrawer(false);
  for (const id of ['terms', 'install', 'settings', 'profile', 'runPage']) $(id).hidden = true;
  const list = $('runsList');
  list.innerHTML = '';
  let runs = [];
  try { runs = await journal.list(); } catch { runs = []; }
  $('runsEmpty').hidden = runs.length > 0;
  $('runsSummary').textContent = runs.length ? `${runs.length} run${runs.length > 1 ? 's' : ''} · ${U.len(runs.reduce((a, r) => a + r.distance, 0))} · ${fmtTime(runs.reduce((a, r) => a + r.elapsed, 0))}` : '';
  for (const r of runs) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'run-card';
    card.innerHTML = `<div class="thumb" data-id="${r.id}"></div><div><b>${escapeHtml(r.name)}</b><small>${U.num(r.distance, 2)} ${U.unit} · ${fmtTime(r.elapsed)} · ${r.pace ? U.pace(r.pace) + ' ' + U.paceLabel() : ''}${r.finished ? '' : ' · stopped early'}</small><small class="when">${fmtWhen(r.time)}${r.start?.label ? ' · ' + escapeHtml(r.start.label) : ''}</small></div>`;
    card.addEventListener('click', () => openRun(r.id));
    list.appendChild(card);
    if (r.hasPicture) journal.get(r.id).then((full) => { if (full?.picture) card.querySelector('.thumb').style.backgroundImage = `url(${full.picture})`; }).catch(() => {});
  }
  $('runs').hidden = false;
  $('runs').scrollTop = 0;
  highlightNav('runs');
}
let openRunId = null;
async function openRun(id) {
  const r = await journal.get(id).catch(() => null);
  if (!r) return;
  openRunId = id;
  $('runTitle').textContent = r.name;
  const pic = $('runPic');
  pic.hidden = !r.picture;
  if (r.picture) pic.src = r.picture;
  $('runStats').innerHTML = `<div><b>${U.num(r.distance, 2)}</b><span>${U.unit}</span></div><div><b>${fmtTime(r.elapsed)}</b><span>time</span></div><div><b>${r.pace ? U.pace(r.pace) : '–:––'}</b><span>${U.paceLabel()}</span></div>`;
  const facts = [fmtWhen(r.time), r.start?.label ? `From ${r.start.label}` : null, r.planned ? `Planned ${U.len(r.planned)}${r.finished ? ', completed' : ', stopped early'}` : null, r.place ? `${r.place.kind === 'track' ? 'Laps at' : 'Loop in'} ${r.place.name}` : null, r.rerouted ? 'Rerouted or turned around on the way' : null, r.country ? 'Country run (unpaved lanes and tracks)' : null].filter(Boolean);
  $('runFacts').innerHTML = facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  $('runShowMap').hidden = !(r.latlngs?.length > 1 || r.track?.length > 1);
  $('runs').hidden = true;
  $('runPage').hidden = false;
  $('runPage').scrollTop = 0;
}
$('runBack').addEventListener('click', () => { $('runPage').hidden = true; openRuns(); });
$('runsBack').addEventListener('click', () => { $('runs').hidden = true; highlightNav(document.body.dataset.view === 'app' ? state.mode : null); });
$('runDelete').addEventListener('click', async () => {
  if (!openRunId) return;
  if (!$('runDelete').dataset.armed) { $('runDelete').dataset.armed = '1'; $('runDelete').textContent = 'Tap again to delete'; setTimeout(() => { delete $('runDelete').dataset.armed; $('runDelete').textContent = 'Delete this run'; }, 3000); return; }
  await journal.remove(openRunId).catch(() => {});
  delete $('runDelete').dataset.armed; $('runDelete').textContent = 'Delete this run';
  refreshRailUser();
  $('runPage').hidden = true;
  openRuns();
});
$('runShowMap').addEventListener('click', async () => {
  const r = await journal.get(openRunId).catch(() => null);
  if (!r) return;
  for (const id of ['runPage', 'runs']) $(id).hidden = true;
  setView('app');
  journalLayer.clearLayers().addTo(map);
  const pts = r.track?.length > 1 ? r.track : r.latlngs;
  if (r.latlngs?.length > 1) L.polyline(r.latlngs, { color: '#94a3b8', weight: 5, dashArray: r.track?.length > 1 ? '8 8' : null }).addTo(journalLayer);
  if (r.track?.length > 1) L.polyline(r.track, { color: '#ff5a36', weight: 5 }).addTo(journalLayer);
  map.fitBounds(L.latLngBounds(pts), mapPadding());
  setSheet('peek');
  toast(`${r.name}: ${U.num(r.distance, 2)} ${U.unit} on ${fmtWhen(r.time)}. Tap the map or change the start to clear it.`);
});
const journalLayer = L.layerGroup();
map.on('click', () => { if (journalLayer.getLayers?.().length) { journalLayer.clearLayers(); map.removeLayer(journalLayer); } });
$('runsExport').addEventListener('click', async () => {
  try {
    const json = await journal.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `runthetown-journal-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch {
    toast('Could not export the journal.');
  }
});
refreshRailUser();
// First open of the app: the profile page, once (Skip is remembered too).
if (!profile) setTimeout(() => openProfile({ first: true }), 400);

// Expose for testing/debugging.
applyUnits();
window.__rtt = { state, engine, map, setStart, nav, voice, navigate, settings };

// Arriving somewhere new: try to find the runner right away.
locate({ quiet: true });
