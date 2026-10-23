// Minimal Leaflet stand-in for offline UI tests (the test sandbox has no CDN access).
// Web-Mercator view (center + zoom), nested layer groups, polylines as SVG and
// markers with their real divIcon HTML, so screenshots look like the app.
(function () {
  let el, svg, pane;
  const view = { center: [0, 0], zoom: 13 };
  const handlers = {};
  const top = new Set(); // layers added straight to the map
  const svgNS = 'http://www.w3.org/2000/svg';
  const world = (z) => 256 * 2 ** z;
  const proj = ([lat, lon], z) => {
    const r = (lat * Math.PI) / 180;
    return [((lon + 180) / 360) * world(z), ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * world(z)];
  };
  const toLL = (p) => (Array.isArray(p) ? p : [p.lat, p.lng]);
  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    queueMicrotask(draw);
  }
  function draw() {
    queued = false;
    if (!el) return;
    const W = el.clientWidth, H = el.clientHeight;
    const [cx, cy] = proj(view.center, view.zoom);
    const P = (ll) => { const [x, y] = proj(toLL(ll), view.zoom); return [x - cx + W / 2, y - cy + H / 2]; };
    svg.innerHTML = '';
    pane.innerHTML = '';
    const walk = (set, fn) => set.forEach((l) => (l._children ? walk(l._children, fn) : fn(l)));
    walk(top, (l) => {
      if (l._type !== 'polyline' || !(l._opts.opacity > 0) || l._pts.length < 2) return;
      const p = document.createElementNS(svgNS, 'polyline');
      p.setAttribute('points', l._pts.map(P).map((q) => q.join(',')).join(' '));
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', l._opts.color);
      p.setAttribute('stroke-width', l._opts.weight);
      p.setAttribute('stroke-opacity', l._opts.opacity);
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('stroke-linecap', 'round');
      svg.appendChild(p);
    });
    walk(top, (l) => {
      if (l._type !== 'marker') return;
      const [x, y] = P(l._pts[0]);
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${x}px;top:${y}px;z-index:${(l._opts.zIndexOffset || 0) + Math.round(y)}`;
      const ic = l._opts.icon;
      if (ic?.html) {
        const a = ic.iconAnchor || [0, 0];
        d.innerHTML = `<div style="position:absolute;left:${-a[0]}px;top:${-a[1]}px;width:${ic.iconSize?.[0] || 'auto'}px">${ic.html}</div>`;
      } else {
        d.innerHTML = `<div style="position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:${l._opts.draggable ? '#ff5a36' : '#333'};border:3px solid #fff"></div>`;
      }
      pane.appendChild(d);
    });
  }
  const layerBase = (type, pts, opts = {}) => ({
    _type: type, _pts: pts, _opts: { opacity: 1, ...opts }, _h: {},
    addTo(g) { (g._children || top).add(this); this._parent = g; render(); return this; },
    remove() { (this._parent?._children || top).delete(this); render(); return this; },
    on(ev, fn) { this._h[ev] = fn; return this; },
    setStyle(o) { Object.assign(this._opts, o); render(); return this; },
    bringToFront() { const s = this._parent?._children || top; s.delete(this); s.add(this); render(); return this; },
    setLatLng(p) { this._pts = [toLL(p)]; render(); return this; },
    getLatLng() { return { lat: this._pts[0][0], lng: this._pts[0][1] }; },
    setLatLngs(p) { this._pts = p.map(toLL); render(); return this; },
    bindPopup(html) { this._popup = html; return this; },
    setPopupContent(html) { this._popup = html; if (window.__openPopupMarker === this) window.__openPopup = html; return this; },
    openPopup() { window.__openPopupMarker = this; window.__openPopup = this._popup; this._h.popupopen?.({}); return this; },
  });
  window.L = {
    map(id) {
      el = document.getElementById(id);
      el.style.overflow = 'hidden';
      svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.cssText = 'position:absolute;inset:0;background:#e9ecdf';
      pane = document.createElement('div');
      pane.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      el.append(svg, pane);
      const m = {
        setView(c, z) { view.center = toLL(c); if (z != null) view.zoom = z; render(); return m; },
        getZoom: () => view.zoom,
        getCenter: () => ({ lat: view.center[0], lng: view.center[1] }),
        on(ev, fn) { handlers[ev] = fn; return m; },
        removeLayer(l) { top.delete(l); render(); return m; },
        addLayer(l) { top.add(l); render(); return m; },
        fitBounds(b, o = {}) {
          const tl = o.paddingTopLeft || [20, 20], br = o.paddingBottomRight || [20, 20];
          const W = el.clientWidth - tl[0] - br[0], H = el.clientHeight - tl[1] - br[1];
          let z = 18;
          for (; z > 2; z--) {
            const [x0, y0] = proj([b.n, b.w], z), [x1, y1] = proj([b.s, b.e], z);
            if (x1 - x0 <= W && y1 - y0 <= H) break;
          }
          const [x0, y0] = proj([b.n, b.w], z), [x1, y1] = proj([b.s, b.e], z);
          // Center so the box sits inside the padded area.
          const mx = (x0 + x1) / 2 + (br[0] - tl[0]) / 2, my = (y0 + y1) / 2 + (br[1] - tl[1]) / 2;
          const n = world(z);
          const lon = (mx / n) * 360 - 180;
          const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * my) / n))) * 180) / Math.PI;
          view.center = [lat, lon];
          view.zoom = z;
          render();
          return m;
        },
        _click(lat, lng) { handlers.click?.({ latlng: { lat, lng } }); },
        _drag() { handlers.dragstart?.({}); },
        closePopup() { window.__openPopup = null; return m; },
      };
      window.__stubMap = m;
      return m;
    },
    tileLayer: () => ({ addTo() { return this; }, on() { return this; }, remove() {} }),
    control: { zoom: () => ({ addTo() { return this; } }) },
    divIcon: (o) => o,
    marker: (p, o = {}) => layerBase('marker', [toLL(p)], o),
    polyline: (pts, o) => layerBase('polyline', pts.map(toLL), o),
    layerGroup() {
      const g = {
        _children: new Set(),
        addTo(t) { (t._children || top).add(g); g._parent = t; render(); return g; },
        clearLayers() { g._children.clear(); render(); return g; },
      };
      return g;
    },
    latLngBounds(pts) {
      return { s: Math.min(...pts.map((p) => p[0])), n: Math.max(...pts.map((p) => p[0])), w: Math.min(...pts.map((p) => p[1])), e: Math.max(...pts.map((p) => p[1])) };
    },
  };
})();
