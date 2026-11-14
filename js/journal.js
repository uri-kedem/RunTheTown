// The runner and their runs, kept on the phone.
//
// Profile: name and a small photo in localStorage ('rtt-profile'). Runs: one record
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
    if (p && typeof p === 'object') return { name: String(p.name || ''), photo: typeof p.photo === 'string' ? p.photo : null, photoFull: typeof p.photoFull === 'string' ? p.photoFull : null, since: p.since || null, skipped: !!p.skipped };
  } catch {
    /* defaults */
  }
  return null;
}

export function saveProfile(profile, storage = globalThis.localStorage) {
  // photo: the avatar (a 320 px circle); photoFull: the same crop at 800 px for viewing.
  const slim = { name: String(profile.name || '').trim().slice(0, 80), photo: profile.photo || null, photoFull: profile.photoFull || null, since: profile.since || new Date().toISOString(), skipped: !!profile.skipped };
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(slim));
  } catch {
    /* storage full (a big photo): keep it without the big copy, then without any photo */
    try { storage?.setItem(PROFILE_KEY, JSON.stringify({ ...slim, photoFull: null })); } catch { try { storage?.setItem(PROFILE_KEY, JSON.stringify({ ...slim, photo: null, photoFull: null })); } catch {} }
  }
  return slim;
}


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
    onPlan: matchShare(simplifyTrack(track), route?.latlngs || []), // share of the track on the planned line (null without a track)
    picture: null, // a JPEG data URL, added by drawRunPicture
  };
}

/**
 * The run as a GPX 1.1 file: one track of the fixes actually run (the planned line when
 * there is no track). A fix is [lat, lon, secondsSinceStart]; fixes recorded before the
 * time was kept get their time from the distance covered at the run's average pace, so
 * every point carries a timestamp (Strava and Garmin refuse tracks without them).
 */
export function runGpx(run) {
  const pts = (run.track?.length > 1 ? run.track : run.latlngs) || [];
  const startMs = Date.parse(run.time) || Date.now();
  const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  // Cumulative distance along the points, for the fixes without a time of their own.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const total = cum[cum.length - 1] || 1;
  const elapsedS = (run.elapsed || 0) / 1000;
  const when = (p, i) => new Date(startMs + 1000 * (p[2] != null ? p[2] : (elapsedS * cum[i]) / total)).toISOString();
  const trk = pts.map((p, i) => `   <trkpt lat="${(+p[0]).toFixed(6)}" lon="${(+p[1]).toFixed(6)}"><time>${when(p, i)}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunTheTown" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><name>${esc(run.name)}</name><time>${new Date(startMs).toISOString()}</time></metadata>
 <trk>
  <name>${esc(run.name)}</name>
  <type>running</type>
  <trkseg>
${trk}
  </trkseg>
 </trk>
</gpx>
`;
}

// How much of the track ran on the planned line: the share of track points within `tol` m of
// it (brute force: the track is thinned to a few hundred points, the line to a few hundred vertices).
export function matchShare(track, latlngs, tol = 30) {
  if (!track?.length || !latlngs?.length) return null;
  const line = latlngs.length > 400 ? latlngs.filter((_, i) => i % Math.ceil(latlngs.length / 400) === 0) : latlngs;
  let on = 0;
  for (const [la, lo] of track) {
    let best = Infinity;
    for (const [a, b] of line) { const d = haversine(la, lo, a, b); if (d < best) { best = d; if (best <= tol) break; } }
    if (best <= tol) on++;
  }
  return on / track.length;
}

// A picture to share: the route picture with the figures on it (1080 x 1350, JPEG data URL).
export function drawShareCard(run, { title = 'RunTheTown', stats = [], who = '' } = {}) {
  if (typeof document === 'undefined') return null;
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#0f172a';
  g.fillRect(0, 0, W, H);
  return new Promise((resolve) => {
    const finish = () => {
      g.fillStyle = '#fff';
      g.font = '800 64px Inter, -apple-system, Helvetica, Arial, sans-serif';
      g.fillText(run.name, 60, 860, W - 120);
      g.font = '500 34px Inter, -apple-system, Helvetica, Arial, sans-serif';
      g.fillStyle = '#94a3b8';
      g.fillText([who, new Date(run.time).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })].filter(Boolean).join(' · '), 60, 915, W - 120);
      stats.forEach(([value, label], i) => {
        const x = 60 + i * ((W - 120) / stats.length);
        g.fillStyle = '#fff';
        g.font = '800 88px Inter, -apple-system, Helvetica, Arial, sans-serif';
        g.fillText(value, x, 1090);
        g.fillStyle = '#94a3b8';
        g.font = '500 32px Inter, -apple-system, Helvetica, Arial, sans-serif';
        g.fillText(label, x, 1140);
      });
      g.fillStyle = '#ff5a36';
      g.font = '800 40px Inter, -apple-system, Helvetica, Arial, sans-serif';
      g.fillText(title, 60, 1270);
      g.fillStyle = '#64748b';
      g.font = '500 26px Inter, -apple-system, Helvetica, Arial, sans-serif';
      g.fillText('Routes for runners in a new city · Map © OpenStreetMap', 60, 1312);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    if (!run.picture) { g.fillStyle = '#1e293b'; g.fillRect(60, 60, W - 120, 700); finish(); return; }
    const img = new Image();
    img.onload = () => {
      // The route picture, cover-fitted into a rounded frame.
      const fw = W - 120, fh = 700;
      g.save();
      g.beginPath();
      g.roundRect(60, 60, fw, fh, 36);
      g.clip();
      const k = Math.max(fw / img.width, fh / img.height);
      g.drawImage(img, 60 + (fw - img.width * k) / 2, 60 + (fh - img.height * k) / 2, img.width * k, img.height * k);
      g.restore();
      finish();
    };
    img.onerror = finish;
    img.src = run.picture;
  });
}

// ---- The picture: map tiles with the run as it was actually run (the planned line only when there is no track) ----

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
  const b = bounds(pts);
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
    // What was run, in orange; the planned line stands in only for a run with no GPS track.
    const ran = r.track?.length > 1 ? r.track : r.latlngs;
    line(ran, '#fff', 10); line(ran, '#ff5a36', 6);
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
