// The runner and their runs, kept on the phone.
//
// Profile: name, e-mail and a small photo in localStorage ('rtt-profile'). Runs: one record
// per completed run in IndexedDB (cache.js `runStore`): when, how far, how long, the pace, the
// route's name and type, the planned line, the GPS track actually run, and a picture of the
// route over the map (drawn here from the map tiles, so the journal needs no network to show
// it later). There is no server yet; the journal can be exported as a file.

import { runStore } from './cache.js';
import { tileXY } from './elevation.js';
import { haversine } from './geo.js';

const PROFILE_KEY = 'rtt-profile';

export function loadProfile(storage = globalThis.localStorage) {
  try {
    const p = JSON.parse(storage?.getItem(PROFILE_KEY) || 'null');
    if (p && typeof p === 'object') return { name: String(p.name || ''), email: String(p.email || ''), photo: typeof p.photo === 'string' ? p.photo : null, since: p.since || null, skipped: !!p.skipped };
  } catch {
    /* defaults */
  }
  return null;
}

export function saveProfile(profile, storage = globalThis.localStorage) {
  const slim = { name: String(profile.name || '').trim().slice(0, 80), email: String(profile.email || '').trim().slice(0, 120), photo: profile.photo || null, since: profile.since || new Date().toISOString(), skipped: !!profile.skipped };
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(slim));
  } catch {
    /* storage full (a big photo): keep it without the photo */
    try { storage?.setItem(PROFILE_KEY, JSON.stringify({ ...slim, photo: null })); } catch {}
  }
  return slim;
}

export const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());

// A photo from the camera roll, shrunk to a small square JPEG data URL (browser only).
export function shrinkPhoto(file, { size = 160, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}

// Every n-th point plus the corners, so a track of thousands of fixes stays a few hundred points.
export function simplifyTrack(points, { maxPoints = 600, minStep = 8 } = {}) {
  if (!points || points.length <= 2) return points || [];
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    if (haversine(last[0], last[1], p[0], p[1]) >= minStep) out.push(p);
  }
  out.push(points[points.length - 1]);
  if (out.length <= maxPoints) return out;
  const step = out.length / maxPoints;
  const thin = [];
  for (let i = 0; i < out.length; i += step) thin.push(out[Math.floor(i)]);
  if (thin[thin.length - 1] !== out[out.length - 1]) thin.push(out[out.length - 1]);
  return thin;
}

/**
 * A run record from the live run. `track` = [[lat, lon], …] fixes actually run (in order),
 * `route` = the planned route (latlngs, name, type, distance, place), `stats` = the navigator's
 * figures (odometer m, elapsed ms), `start` = { lat, lon, label }.
 */
export function makeRun({ route, track, odometer, elapsed, startedAt, start, settings, country = false, rerouted = false, finished = true }) {
  const paceSecPerKm = odometer > 50 ? elapsed / 1000 / (odometer / 1000) : null;
  return {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    time: startedAt, // ISO, when the run started
    endedAt: new Date().toISOString(),
    distance: Math.round(odometer),
    elapsed: Math.round(elapsed),
    pace: paceSecPerKm,
    finished, // reached the end of the route (else stopped early)
    name: route?.name || 'Run',
    type: route?.type || 'loop',
    planned: Math.round(route?.distance || 0),
    place: route?.place ? { kind: route.place.kind, name: route.place.name } : null,
    start: start ? { lat: start.lat, lon: start.lon, label: start.label } : null,
    units: settings?.units || 'km',
    country,
    rerouted,
    latlngs: route?.latlngs || [],
    track: simplifyTrack(track),
    picture: null, // a JPEG data URL, added by drawRunPicture
  };
}

// ---- The picture: map tiles with the planned line, the track and the start ----

const TILE = 256;

function bounds(pts) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [la, lo] of pts) { if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Draws the run over map tiles into a canvas and returns a JPEG data URL. `tileUrl` is a
 * {z}/{x}/{y} template (the map's own source). Tiles that fail to load (offline) leave a
 * plain patch; if the canvas is tainted (no CORS), it is redrawn without tiles.
 */
export async function drawRunPicture(run, { tileUrl, width = 640, height = 400, pad = 36, fetchTile = null, quality = 0.82 } = {}) {
  const pts = (run.track?.length > 1 ? run.track : run.latlngs) || [];
  if (pts.length < 2 || typeof document === 'undefined') return null;
  const all = run.latlngs?.length ? [...run.latlngs, ...(run.track || [])] : pts;
  const b = bounds(all);
  // The zoom at which the whole run fits inside the picture (minus the padding).
  let z = 18;
  let fx0, fy0, fx1, fy1;
  for (; z > 2; z--) {
    [fx0, fy0] = tileXY(b.maxLat, b.minLon, z);
    [fx1, fy1] = tileXY(b.minLat, b.maxLon, z);
    if ((fx1 - fx0) * TILE <= width - 2 * pad && (fy1 - fy0) * TILE <= height - 2 * pad) break;
  }
  const cx = (fx0 + fx1) / 2, cy = (fy0 + fy1) / 2; // picture centre in tile units
  const toPx = (lat, lon) => { const [tx, ty] = tileXY(lat, lon, z); return [width / 2 + (tx - cx) * TILE, height / 2 + (ty - cy) * TILE]; };
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#eef1f5';
  ctx.fillRect(0, 0, width, height);
  // Tiles covering the picture.
  const x0 = Math.floor(cx - width / 2 / TILE), x1 = Math.floor(cx + width / 2 / TILE);
  const y0 = Math.floor(cy - height / 2 / TILE), y1 = Math.floor(cy + height / 2 / TILE);
  const n = 1 << z;
  const jobs = [];
  if (tileUrl) {
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        const url = tileUrl.replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
        jobs.push(loadTile(url, fetchTile).then((img) => { if (img) ctx.drawImage(img, width / 2 + (tx - cx) * TILE, height / 2 + (ty - cy) * TILE, TILE, TILE); }).catch(() => {}));
      }
    }
    await Promise.all(jobs);
  }
  const drawn = draw(ctx, run, toPx);
  try {
    return c.toDataURL('image/jpeg', quality);
  } catch {
    // Tainted by a tile without CORS headers: the same picture on a plain background.
    const c2 = document.createElement('canvas');
    c2.width = width;
    c2.height = height;
    const ctx2 = c2.getContext('2d');
    ctx2.fillStyle = '#eef1f5';
    ctx2.fillRect(0, 0, width, height);
    draw(ctx2, run, toPx);
    return c2.toDataURL('image/jpeg', quality);
  }
  function draw(g, r, px) {
    const line = (list, color, w, dash = null) => {
      if (!list || list.length < 2) return;
      g.beginPath();
      list.forEach(([la, lo], i) => { const [x, y] = px(la, lo); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.lineCap = g.lineJoin = 'round';
      g.setLineDash(dash || []);
      g.strokeStyle = color;
      g.lineWidth = w;
      g.stroke();
      g.setLineDash([]);
    };
    // A soft white wash so the lines read on any map.
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, 0, width, height);
    if (r.latlngs?.length > 1) { line(r.latlngs, '#fff', 9); line(r.latlngs, '#94a3b8', 5, r.track?.length > 1 ? [8, 8] : null); }
    if (r.track?.length > 1) { line(r.track, '#fff', 10); line(r.track, '#ff5a36', 6); }
    const s = (r.track?.length ? r.track : r.latlngs)[0];
    const e = (r.track?.length ? r.track : r.latlngs).slice(-1)[0];
    for (const [p, fill] of [[e, '#0f172a'], [s, '#ff5a36']]) {
      const [x, y] = px(p[0], p[1]);
      g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
    }
    return true;
  }
}

function loadTile(url, fetchTile) {
  if (fetchTile) return fetchTile(url);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---- The journal ----

export const journal = {
  async save(run) { await runStore.put(run); return run; },
  async list() { return runStore.list(); },
  async get(id) { return runStore.get(id); },
  async remove(id) { return runStore.remove(id); },
  async exportJson() {
    const runs = await runStore.list({ full: true });
    return JSON.stringify({ app: 'RunTheTown', exported: new Date().toISOString(), profile: loadProfile(), runs }, null, 1);
  },
  // Totals for the profile card.
  async totals() {
    const runs = await runStore.list();
    return { runs: runs.length, distance: runs.reduce((a, r) => a + (r.distance || 0), 0), elapsed: runs.reduce((a, r) => a + (r.elapsed || 0), 0) };
  },
};
