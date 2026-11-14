// Minimal MapLibre GL stand-in for offline UI tests (no WebGL, no tile server needed).
// It implements the part of `maplibregl` that js/glmap.js uses: a Map with a Web-Mercator
// view (center + zoom + bearing), GeoJSON line sources drawn as SVG, HTML markers placed
// at their point, and popups whose HTML is exposed on window.__openPopup, so screenshots
// look like the app and the walk-through can read what a pin says.
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const world = (z) => 512 * 2 ** z; // MapLibre zoom: 512 px tiles
  const proj = ([lng, lat], z) => {
    const r = (lat * Math.PI) / 180;
    return [((lng + 180) / 360) * world(z), ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * world(z)];
  };
  const unproj = ([x, y], z) => {
    const n = world(z);
    return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
  };
  const toLngLat = (p) => (Array.isArray(p) ? p : [p.lng, p.lat]);

  class Evented {
    constructor() { this._h = {}; }
    on(ev, a, b) { const fn = b || a; const key = b ? `${ev}:${a}` : ev; (this._h[key] ||= []).push(fn); return this; }
    once(ev, fn) { const w = (e) => { this.off(ev, w); fn(e); }; return this.on(ev, w); }
    off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn); return this; }
    fire(ev, e = {}) { for (const f of this._h[ev] || []) f(e); return this; }
  }

  class Map extends Evented {
    constructor(o) {
      super();
      this._el = typeof o.container === 'string' ? document.getElementById(o.container) : o.container;
      this._el.style.overflow = 'hidden';
      this._el.style.position ||= 'relative';
      this._svg = document.createElementNS(svgNS, 'svg');
      this._svg.setAttribute('width', '100%');
      this._svg.setAttribute('height', '100%');
      this._svg.style.cssText = 'position:absolute;inset:0;background:#e9ecdf';
      this._canvas = document.createElement('canvas');
      this._canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      this._pane = document.createElement('div');
      this._pane.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      this._el.append(this._canvas, this._svg, this._pane);
      this._view = { center: toLngLat(o.center || [0, 0]), zoom: o.zoom ?? 1, bearing: 0 };
      this._sources = new Map_(); this._layers = []; this._markers = new Set(); this._styleUrl = o.style;
      this.dragRotate = { disable() {}, enable() {} };
      this.touchZoomRotate = { disableRotation() {}, enableRotation() {} };
      this._loaded = false;
      setTimeout(() => { this._loaded = true; this.fire('style.load'); this.fire('load'); this._render(); setTimeout(() => this.fire('idle'), 20); }, 0);
      if (!window.__stubMap) window.__stubMap = this;
    }
    isStyleLoaded() { return this._loaded; }
    setStyle(url) { this._styleUrl = url; this._sources = new Map_(); this._layers = []; this._loaded = false; setTimeout(() => { this._loaded = true; this.fire('style.load'); this._render(); }, 0); return this; }
    getContainer() { return this._el; }
    getCanvas() { this._canvas.width = this._el.clientWidth || 390; this._canvas.height = this._el.clientHeight || 700; const g = this._canvas.getContext('2d'); g.fillStyle = '#e9ecdf'; g.fillRect(0, 0, this._canvas.width, this._canvas.height); return this._canvas; }
    addControl() { return this; }
    remove() { this._el.innerHTML = ''; if (window.__stubMap === this) window.__stubMap = null; }
    resize() { this._render(); return this; }
    // ---- camera ----
    getZoom() { return this._view.zoom; }
    getCenter() { const [lng, lat] = this._view.center; return { lng, lat }; }
    getBearing() { return this._view.bearing; }
    jumpTo(o) { if (o.center) this._view.center = toLngLat(o.center); if (o.zoom != null) this._view.zoom = o.zoom; if (o.bearing != null) this._view.bearing = o.bearing; this._render(); return this; }
    easeTo(o) { return this.jumpTo(o); }
    fitBounds(b, o = {}) {
      const pad = typeof o.padding === 'number' ? { top: o.padding, bottom: o.padding, left: o.padding, right: o.padding } : { top: 20, bottom: 20, left: 20, right: 20, ...(o.padding || {}) };
      const [[w, s], [e, n]] = b;
      const W = (this._el.clientWidth || 390) - pad.left - pad.right, H = (this._el.clientHeight || 700) - pad.top - pad.bottom;
      let z = o.maxZoom ?? 17;
      for (; z > 1; z -= 0.25) {
        const [x0, y0] = proj([w, n], z), [x1, y1] = proj([e, s], z);
        if (x1 - x0 <= W && y1 - y0 <= H) break;
      }
      const [x0, y0] = proj([w, n], z), [x1, y1] = proj([e, s], z);
      const mx = (x0 + x1) / 2 + (pad.right - pad.left) / 2, my = (y0 + y1) / 2 + (pad.bottom - pad.top) / 2;
      this._view.center = unproj([mx, my], z); this._view.zoom = z;
      this._render();
      return this;
    }
    project(ll) { const [x, y] = this._px(toLngLat(ll)); return { x, y }; }
    _px(lngLat) {
      const W = this._el.clientWidth || 390, H = this._el.clientHeight || 700;
      const [cx, cy] = proj(this._view.center, this._view.zoom);
      const [x, y] = proj(lngLat, this._view.zoom);
      const dx = x - cx, dy = y - cy, a = (-this._view.bearing * Math.PI) / 180;
      return [W / 2 + dx * Math.cos(a) - dy * Math.sin(a), H / 2 + dx * Math.sin(a) + dy * Math.cos(a)];
    }
    // ---- sources and layers ----
    addSource(id, src) { this._sources.set(id, { data: src.data, setData: (d) => { this._sources.get(id).data = d; this._render(); } }); }
    getSource(id) { return this._sources.get(id); }
    removeSource(id) { this._sources.delete(id); }
    addLayer(l) { this._layers.push(l); this._render(); }
    getLayer(id) { return this._layers.find((l) => l.id === id); }
    removeLayer(id) { this._layers = this._layers.filter((l) => l.id !== id); this._render(); }
    moveLayer(id) { const l = this.getLayer(id); if (l) { this._layers = this._layers.filter((x) => x !== l); this._layers.push(l); this._render(); } }
    setPaintProperty(id, k, v) { const l = this.getLayer(id); if (l) { l.paint[k] = v; this._render(); } }
    _render() {
      if (this._queued) return;
      this._queued = true;
      queueMicrotask(() => {
        this._queued = false;
        this._svg.innerHTML = '';
        for (const l of this._layers) {
          const src = this._sources.get(l.source);
          const coords = src?.data?.geometry?.coordinates || [];
          if (!(l.paint['line-opacity'] > 0) || coords.length < 2) continue;
          const p = document.createElementNS(svgNS, 'polyline');
          p.setAttribute('points', coords.map((c) => this._px(c).join(',')).join(' '));
          p.setAttribute('fill', 'none');
          p.setAttribute('stroke', l.paint['line-color']);
          p.setAttribute('stroke-width', l.paint['line-width']);
          p.setAttribute('stroke-opacity', l.paint['line-opacity']);
          p.setAttribute('stroke-linejoin', 'round');
          p.setAttribute('stroke-linecap', 'round');
          p.dataset.layer = l.id;
          p.style.pointerEvents = 'stroke';
          p.addEventListener('click', () => { for (const f of this._h[`click:${l.id}`] || []) f({ originalEvent: { stopPropagation() {} } }); });
          this._svg.appendChild(p);
        }
        for (const mk of this._markers) mk._place();
      });
    }
    // ---- hooks for the walk-through ----
    _click(lat, lng) { this.fire('click', { lngLat: { lng, lat } }); }
    _drag() { this.fire('dragstart', {}); }
  }
  const Map_ = globalThis.Map; // the real Map class (shadowed by the stub's name above)

  class Marker extends Evented {
    constructor(o = {}) {
      super();
      this._el = o.element || Object.assign(document.createElement('div'), { className: 'rtt-marker' });
      this._offset = o.offset || [0, 0];
      this._draggable = !!o.draggable;
      this._el.style.position = 'absolute';
    }
    setLngLat(ll) { this._ll = toLngLat(ll); this._place(); return this; }
    getLngLat() { return { lng: this._ll[0], lat: this._ll[1] }; }
    addTo(map) { this._map = map; map._markers.add(this); map._pane.appendChild(this._el); this._el.style.pointerEvents = this._el.style.pointerEvents || 'auto'; this._el.addEventListener('click', () => this.togglePopup()); this._place(); return this; }
    remove() { this._map?._markers.delete(this); this._el.remove(); if (this._popup?._open) this._popup.remove(); return this; }
    setDraggable(d) { this._draggable = d; return this; }
    setPopup(p) { this._popup = p; p._marker = this; return this; }
    getPopup() { return this._popup; }
    togglePopup() { if (!this._popup) return this; if (this._popup._open) this._popup.remove(); else this._popup.addTo(this._map); return this; }
    getElement() { return this._el; }
    _place() {
      if (!this._map || !this._ll) return;
      const [x, y] = this._map._px(this._ll);
      const w = parseFloat(this._el.style.width) || 0, h = parseFloat(this._el.style.height) || 0;
      this._el.style.left = `${x - w / 2 + this._offset[0]}px`;
      this._el.style.top = `${y - h / 2 + this._offset[1]}px`;
    }
  }

  class Popup extends Evented {
    constructor(o = {}) { super(); this._o = o; this._html = ''; this._open = false; }
    setHTML(h) { this._html = h; if (this._open && window.__openPopupMarker === this._marker) window.__openPopup = h; return this; }
    isOpen() { return this._open; }
    addTo(map) { this._open = true; window.__openPopupMarker = this._marker; window.__openPopup = this._html; this._el = document.createElement('div'); this._el.className = 'rtt-popup maplibregl-popup'; this._el.innerHTML = `<div class="maplibregl-popup-content">${this._html}</div>`; map._el.appendChild(this._el); this.fire('open'); return this; }
    remove() { this._open = false; this._el?.remove(); if (window.__openPopupMarker === this._marker) { window.__openPopup = null; window.__openPopupMarker = null; } this.fire('close'); return this; }
    on(ev, fn) { return super.on(ev, fn); }
  }

  class NavigationControl { }
  class AttributionControl { }
  window.maplibregl = { Map, Marker, Popup, NavigationControl, AttributionControl };
})();
