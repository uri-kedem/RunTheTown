// The map, drawn by MapLibre GL from OpenFreeMap's vector tiles (the same tiles the planner
// reads streets from), behind a small Leaflet-shaped API: the app thinks in [lat, lon],
// layer groups, markers with HTML icons and polylines, as it did with Leaflet, and this
// module turns that into MapLibre sources, layers and DOM markers. What vector tiles give
// that raster tiles could not: street names stay upright when the map turns with the runner
// (the map itself is rotated, not its picture), a dark map at night, and no dependency on
// a tile server whose terms forbid app use.
//
// Zoom levels are Leaflet's (256 px tiles): MapLibre's 512 px tiles make its zoom one less
// for the same scale, and the conversion happens here so the app keeps its numbers.

const OFM_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const ZOOM_SHIFT = 1; // Leaflet zoom = MapLibre zoom + 1

// The style without its low-zoom shaded relief (a second tile server, slow to answer at
// times, that a snapshot at zoom 14+ never draws). Fetched once per theme.
const snapshotStyles = {};
async function snapshotStyle(theme) {
  if (!snapshotStyles[theme]) {
    snapshotStyles[theme] = fetch(OFM_STYLES[theme]).then((r) => r.json()).then((st) => {
      const drop = Object.keys(st.sources || {}).filter((id) => /^ne2|natural_earth/i.test(id) || /natural_earth/i.test(st.sources[id]?.url || ''));
      for (const id of drop) delete st.sources[id];
      st.layers = (st.layers || []).filter((l) => !drop.includes(l.source));
      return st;
    }).catch(() => { delete snapshotStyles[theme]; return null; });
  }
  return snapshotStyles[theme];
}

let lineSeq = 0;
const gl = () => globalThis.maplibregl;

/** Leaflet-style [lat, lon] (or {lat, lng}) to MapLibre's [lng, lat]. */
const toLngLat = (p) => (Array.isArray(p) ? [p[1], p[0]] : [p.lng ?? p.lon, p.lat]);

/** A bounds object (Leaflet-like) from a list of [lat, lon]. */
export function glBounds(pts) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const p of pts) {
    const [lat, lon] = Array.isArray(p) ? p : [p.lat, p.lng ?? p.lon];
    if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s, n, w, e };
}

export function glDivIcon(o) { return o; }

/** A group of markers and lines that is added, removed and cleared as one. */
export function glLayerGroup() {
  const g = {
    _children: new Set(),
    _parent: null,
    get _map() { return this._parent?._map || null; },
    addTo(parent) {
      g._parent = parent;
      (parent._children || parent._top).add(g);
      for (const c of g._children) c.addTo(g);
      return g;
    },
    remove() {
      for (const c of g._children) c.remove({ keep: true });
      if (g._parent) (g._parent._children || g._parent._top).delete(g);
      g._parent = null;
      return g;
    },
    clearLayers() {
      for (const c of g._children) c.remove({ keep: true });
      g._children.clear();
      return g;
    },
  };
  return g;
}

/** A polyline: one GeoJSON source and one line layer on the map. */
export function glPolyline(latlngs, opts = {}) {
  const id = `rtt-line-${++lineSeq}`;
  const line = {
    _id: id,
    _pts: latlngs.map(toLngLat),
    _opts: { color: '#000', weight: 3, opacity: 1, ...opts },
    _parent: null,
    _on: {},
    _geo() { return { type: 'Feature', geometry: { type: 'LineString', coordinates: this._pts }, properties: {} }; },
    _paint() { return { 'line-color': this._opts.color, 'line-width': this._opts.weight, 'line-opacity': this._opts.opacity }; },
    addTo(parent) {
      line._parent = parent;
      (parent._children || parent._top).add(line);
      const m = parent._map || (parent._top ? parent : null);
      if (m) m._attachLine(line);
      return line;
    },
    remove({ keep = false } = {}) {
      const m = line._parent?._map || (line._parent?._top ? line._parent : null);
      if (m) m._detachLine(line);
      if (!keep && line._parent) (line._parent._children || line._parent._top).delete(line);
      if (!keep) line._parent = null;
      return line;
    },
    on(ev, fn) { line._on[ev] = fn; const m = line._parent?._map; if (m && m._gl.getLayer(id)) m._bindLine(line); return line; },
    setStyle(o) {
      Object.assign(line._opts, o);
      const m = line._parent?._map;
      if (m && m._gl.getLayer(id)) for (const [k, v] of Object.entries(line._paint())) m._gl.setPaintProperty(id, k, v);
      return line;
    },
    setLatLngs(pts) {
      line._pts = pts.map(toLngLat);
      const m = line._parent?._map;
      const src = m && m._gl.getSource(id);
      if (src) src.setData(line._geo());
      return line;
    },
    bringToFront() {
      const m = line._parent?._map;
      if (m && m._gl.getLayer(id)) m._gl.moveLayer(id);
      return line;
    },
  };
  return line;
}

/** A marker with an HTML icon (`icon.html`), optionally draggable, with a popup. */
export function glMarker(latlng, opts = {}) {
  const mk = {
    _ll: toLngLat(latlng),
    _opts: opts,
    _parent: null,
    _m: null, // the maplibregl.Marker once on a map
    _popupHtml: null,
    _popupOpts: null,
    _on: {},
    _element() {
      const ic = this._opts.icon || {};
      const el = document.createElement('div');
      el.className = 'rtt-marker';
      el.innerHTML = ic.html || '<div class="rtt-dot"></div>';
      const [w, h] = ic.iconSize || [22, 22];
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      if (this._opts.interactive === false) el.style.pointerEvents = 'none';
      if (this._opts.zIndexOffset) el.style.zIndex = String(this._opts.zIndexOffset);
      return el;
    },
    addTo(parent) {
      mk._parent = parent;
      (parent._children || parent._top).add(mk);
      const m = parent._map || (parent._top ? parent : null);
      if (m) m._attachMarker(mk);
      return mk;
    },
    remove({ keep = false } = {}) {
      if (mk._m) { mk._m.remove(); mk._m = null; }
      if (!keep && mk._parent) (mk._parent._children || mk._parent._top).delete(mk);
      if (!keep) mk._parent = null;
      return mk;
    },
    on(ev, fn) { mk._on[ev] = fn; return mk; },
    setLatLng(p) { mk._ll = toLngLat(p); if (mk._m) mk._m.setLngLat(mk._ll); return mk; },
    getLatLng() { const ll = mk._m ? mk._m.getLngLat() : { lng: mk._ll[0], lat: mk._ll[1] }; return { lat: ll.lat, lng: ll.lng }; },
    bindPopup(html, o = {}) { mk._popupHtml = html; mk._popupOpts = o; if (mk._m) mk._m.setPopup(mk._makePopup()); return mk; },
    setPopupContent(html) { mk._popupHtml = html; const p = mk._m?.getPopup(); if (p) p.setHTML(html); return mk; },
    // One popup at a time, as on the old map: opening this one closes the others.
    openPopup() { const p = mk._m?.getPopup(); if (p && !p.isOpen()) { mk._parent?._map?.closePopup(); mk._m.togglePopup(); } return mk; },
    _makePopup() {
      const { Popup } = gl();
      const [, h] = this._opts.icon?.iconSize || [22, 22];
      const p = new Popup({ offset: h / 2 + 4, maxWidth: this._popupOpts?.maxWidth ? `${this._popupOpts.maxWidth}px` : '280px', closeButton: true, className: 'rtt-popup' });
      p.setHTML(this._popupHtml || '');
      p.on('open', () => { const m = this._parent?._map; if (m) { for (const o of [...m._popups]) if (o !== p) o.remove(); m._popups.add(p); } this._on.popupopen?.({}); });
      p.on('close', () => this._parent?._map?._popups.delete(p));
      return p;
    },
    dragging: {
      disable() { mk._m?.setDraggable(false); mk._opts.draggable = false; },
      enable() { mk._m?.setDraggable(true); mk._opts.draggable = true; },
    },
  };
  return mk;
}

/** A small circle marker (start and finish dots in the route viewer). */
export function glCircleMarker(latlng, { radius = 7, color = '#fff', weight = 3, fillColor = '#000' } = {}) {
  const d = radius * 2;
  const html = `<div style="width:${d}px;height:${d}px;border-radius:50%;background:${fillColor};border:${weight}px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`;
  return glMarker(latlng, { icon: { html, iconSize: [d + 2 * weight, d + 2 * weight] }, interactive: false });
}

/**
 * The map in `id`. Options: `zoomControl` (buttons, top right), `attributionControl`,
 * `dark` (start with the night style), `interactive` (false for a snapshot map).
 */
export function glCreateMap(id, { zoomControl = false, attributionControl = true, dark = false, interactive = true, container = null, style = null } = {}) {
  const { Map: GLMap, NavigationControl, AttributionControl } = gl();
  const el = container || document.getElementById(id);
  const m = {
    _gl: null,
    _top: new Set(),
    _ready: false,
    _pending: [],
    _lines: new Set(), // lines currently on the map (re-added after a style change)
    _popups: new Set(), // popups open right now
    _zoomTarget: null, // the zoom the app last asked for (read back while an animation is still on its way)
    _animating: false,
    _handlers: {},
    _theme: dark ? 'dark' : 'light',
    get _map() { return m; },
    _whenReady(fn) { if (m._ready) fn(); else m._pending.push(fn); },
    _attachLine(line) {
      m._lines.add(line);
      m._whenReady(() => {
        if (!m._lines.has(line) || m._gl.getSource(line._id)) return;
        m._gl.addSource(line._id, { type: 'geojson', data: line._geo() });
        m._gl.addLayer({ id: line._id, type: 'line', source: line._id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: line._paint() });
        m._bindLine(line);
      });
    },
    _detachLine(line) {
      m._lines.delete(line);
      if (!m._ready || !m._gl.getLayer(line._id)) return;
      m._gl.removeLayer(line._id);
      m._gl.removeSource(line._id);
    },
    _bindLine(line) {
      if (line._bound || !line._on.click) return;
      line._bound = true;
      m._gl.on('click', line._id, (e) => { e.originalEvent?.stopPropagation?.(); m._lineClicked = true; line._on.click(e); });
      m._gl.on('mouseenter', line._id, () => { m._gl.getCanvas().style.cursor = 'pointer'; });
      m._gl.on('mouseleave', line._id, () => { m._gl.getCanvas().style.cursor = ''; });
    },
    _attachMarker(mk) {
      const { Marker } = gl();
      if (mk._m) return;
      const ic = mk._opts.icon || {};
      const [w, h] = ic.iconSize || [22, 22];
      const [ax, ay] = ic.iconAnchor || [w / 2, h / 2];
      mk._m = new Marker({ element: mk._element(), anchor: 'center', offset: [w / 2 - ax, h / 2 - ay], draggable: !!mk._opts.draggable });
      mk._m.setLngLat(mk._ll);
      if (mk._popupHtml != null) mk._m.setPopup(mk._makePopup());
      mk._m.on('dragend', () => { mk._ll = [mk._m.getLngLat().lng, mk._m.getLngLat().lat]; mk._on.dragend?.({}); });
      mk._m.addTo(m._gl);
    },
    // ---- the Leaflet-like surface the app uses ----
    setView(center, zoom, { animate = true } = {}) {
      const o = { center: toLngLat(center), zoom: (zoom ?? m.getZoom()) - ZOOM_SHIFT };
      m._zoomTarget = o.zoom;
      m._animating = animate && m._ready;
      if (m._animating) m._gl.easeTo({ ...o, duration: 350 }); else m._gl.jumpTo(o);
      return m;
    },
    /**
     * One camera move per GPS fix while following the runner: centre, the zoom the runner
     * chose and the bearing (the course that points up; 0 for north up) travel together in
     * a linear ease as long as a fix interval, so the map glides instead of jumping.
     */
    follow(center, { bearing = 0, animate = true, durationMs = 900 } = {}) {
      const o = { center: toLngLat(center), zoom: m._zoomTarget ?? m._gl.getZoom(), bearing };
      m._animating = animate && m._ready;
      if (m._animating) m._gl.easeTo({ ...o, duration: durationMs, easing: (t) => t, essential: true }); else m._gl.jumpTo(o);
      return m;
    },
    getZoom() { return (m._zoomTarget ?? m._gl.getZoom()) + ZOOM_SHIFT; },
    getCenter() { const c = m._gl.getCenter(); return { lat: c.lat, lng: c.lng }; },
    getSize() { return { x: el.clientWidth, y: el.clientHeight }; },
    invalidateSize() { m._gl.resize(); return m; },
    fitBounds(b, { paddingTopLeft = [20, 20], paddingBottomRight = [20, 20], padding = null, animate = true } = {}) {
      const pad = padding != null ? { top: padding[1] ?? padding, bottom: padding[1] ?? padding, left: padding[0] ?? padding, right: padding[0] ?? padding } : { top: paddingTopLeft[1], left: paddingTopLeft[0], bottom: paddingBottomRight[1], right: paddingBottomRight[0] };
      m._zoomTarget = null; // the zoom is whatever fits
      m._gl.fitBounds([[b.w, b.s], [b.e, b.n]], { padding: pad, duration: animate ? 400 : 0, maxZoom: 18 - ZOOM_SHIFT });
      return m;
    },
    on(ev, fn) {
      if (ev === 'click') m._gl.on('click', (e) => { if (m._lineClicked) { m._lineClicked = false; return; } fn({ latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng } }); });
      else if (ev === 'dragstart') m._gl.on('dragstart', () => fn({}));
      else m._gl.on(ev, fn);
      return m;
    },
    removeLayer(l) { l.remove(); return m; },
    addLayer(l) { l.addTo(m); return m; },
    closePopup() { for (const p of [...m._popups]) p.remove(); m._popups.clear(); return m; },
    /** Turns the map so `heading` (compass degrees) points up; null puts north up. */
    setBearing(heading, { animate = true } = {}) {
      const b = heading == null ? 0 : heading;
      if (animate) m._gl.easeTo({ bearing: b, duration: 700, easing: (t) => t }); else m._gl.jumpTo({ bearing: b });
      return m;
    },
    getBearing() { return m._gl.getBearing(); },
    /**
     * Whether the runner may turn the map by hand (a two-finger twist, or a right-button /
     * ctrl drag on a computer). Off during a run, where the map turns with the runner.
     */
    setRotatable(on) {
      if (on) { m._gl.dragRotate.enable(); m._gl.touchZoomRotate.enableRotation(); }
      else { m._gl.dragRotate.disable(); m._gl.touchZoomRotate.disableRotation(); }
      return m;
    },
    /** Day or night look: 'light' | 'dark'. Lines are put back once the new style is in. */
    setTheme(theme) {
      if (theme === m._theme) return m;
      m._theme = theme;
      m._ready = false;
      m._gl.setStyle(OFM_STYLES[theme], { diff: false });
      return m;
    },
    get theme() { return m._theme; },
    get gl() { return m._gl; },
    remove() { m._gl.remove(); },
  };
  m._gl = new GLMap({
    container: el,
    style: style || OFM_STYLES[m._theme],
    center: [0, 0],
    zoom: 1,
    attributionControl: false,
    interactive,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    fadeDuration: 0,
    preserveDrawingBuffer: !interactive,
  });
  m._gl.dragRotate.disable();
  m._gl.touchZoomRotate.disableRotation();
  if (attributionControl) m._gl.addControl(new AttributionControl({ compact: true }), 'bottom-right'); // the style credits OpenFreeMap, OpenMapTiles and OpenStreetMap
  if (zoomControl) m._gl.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  // A pinch or the zoom buttons set a new zoom the app will read back; our own animations end here too.
  m._gl.on('moveend', () => { m._animating = false; });
  m._gl.on('zoomend', () => { if (!m._animating) m._zoomTarget = m._gl.getZoom(); });
  // Sources and layers can only be added once the style is in, and again after every
  // style change (a style change drops them all).
  m._gl.on('style.load', () => {
    m._ready = true;
    const todo = m._pending.splice(0);
    for (const line of m._lines) { line._bound = false; m._attachLine(line); }
    for (const fn of todo) fn();
  });
  return m;
}

/**
 * A still picture of the map around `pts` ([lat, lon] list): a hidden map is drawn once,
 * its canvas and a lat/lon-to-pixel function are returned, then it is thrown away.
 * Resolves to null when WebGL or the tiles are not available (offline).
 */
export function glSnapshot(pts, { width = 640, height = 400, pad = 36, dark = false, timeoutMs = 12000 } = {}) {
  return new Promise(async (resolve) => {
    let box = null, m = null, poll = null;
    const done = (v, released = false) => { clearTimeout(timer); clearInterval(poll); try { m?.remove(); } catch { /* already gone */ } box?.remove(); if (!released) resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    const style = await snapshotStyle(dark ? 'dark' : 'light');
    if (!style) return done(null);
    try {
      box = document.createElement('div');
      box.style.cssText = `position:fixed;left:-${width + 20}px;top:0;width:${width}px;height:${height}px;visibility:hidden`;
      document.body.appendChild(box);
      m = glCreateMap(null, { container: box, interactive: false, attributionControl: false, dark, style });
      m._gl.jumpTo({ center: [0, 0], zoom: 1 });
      m._whenReady(() => {
        const b = glBounds(pts);
        m._gl.fitBounds([[b.w, b.s], [b.e, b.n]], { padding: pad, duration: 0, maxZoom: 17 });
        // Drawn once everything is in: the idle event, or (should it not come while the main
        // map keeps the renderer busy) a check every half second that the tiles are loaded.
        let taken = false;
        const take = () => {
          if (taken) return;
          taken = true;
          clearInterval(poll);
          poll = null;
          // The picture is copied out now; project() needs the map, so it stays until release().
          const c = document.createElement('canvas');
          c.width = width; c.height = height;
          c.getContext('2d').drawImage(m._gl.getCanvas(), 0, 0, width, height);
          clearTimeout(timer);
          resolve({ canvas: c, project: (lat, lon) => { const q = m._gl.project([lon, lat]); return [q.x, q.y]; }, release: () => done(null, true) });
        };
        m._gl.once('idle', take);
        poll = setInterval(() => { if (m._gl.loaded() && m._gl.areTilesLoaded() && !m._gl.isMoving()) { m._gl.once('render', take); m._gl.triggerRepaint(); } }, 500);
      });
      m._gl.on('error', (e) => { if (/style|tile|source/i.test(String(e?.error?.message || ''))) done(null); });
    } catch {
      done(null);
    }
  });
}
