// Keeps downloaded map tiles and elevation grids on the device, so opening the
// app again in the same city is instant and a retry only fetches what's
// missing. IndexedDB holds the data; a small index in localStorage lists the
// elevation areas. Every call is best-effort: if storage is unavailable, the
// app simply downloads again.

import { haversine } from './geo.js';

const DB_NAME = 'runthetown';
const STORE = 'areas';
const TILES = 'tiles';
const INDEX_KEY = 'rtt-elev-areas-v2'; // elevation grids only; map data lives in tiles
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const MAX_AREAS = 6;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      else if (e.oldVersion < 2) req.transaction.objectStore(STORE).clear(); // v1 kept whole map areas: drop them
      if (!db.objectStoreNames.contains(TILES)) db.createObjectStore(TILES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function db() {
  dbPromise ||= openDB().catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(db, mode, fn, storeName = STORE) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY)) || [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: ignore */
  }
}

// A cached elevation area that fully contains the circle (lat, lon, radius), or null.
export async function findCachedArea(lat, lon, radius) {
  try {
    const now = Date.now();
    const hit = readIndex().find(
      (a) => now - a.time < MAX_AGE_MS && haversine(a.lat, a.lon, lat, lon) + radius <= a.radius,
    );
    if (!hit) return null;
    const d = await db();
    const data = await tx(d, 'readonly', (s) => s.get(hit.key));
    return data || null;
  } catch {
    return null;
  }
}

export async function saveArea(area) {
  try {
    const key = `${area.lat.toFixed(4)},${area.lon.toFixed(4)},${Math.round(area.radius)}`;
    const d = await db();
    let index = readIndex().filter((a) => a.key !== key && Date.now() - a.time < MAX_AGE_MS);
    // Keep only the newest few areas.
    const drop = index.slice(MAX_AREAS - 1);
    index = index.slice(0, MAX_AREAS - 1);
    await tx(d, 'readwrite', (s) => {
      for (const a of drop) s.delete(a.key);
      return s.put(area, key);
    });
    writeIndex([{ key, lat: area.lat, lon: area.lon, radius: area.radius, time: Date.now() }, ...index]);
  } catch {
    /* best-effort */
  }
}

// Per-tile map data, valid for 14 days.
export const tileCache = {
  async get(key) {
    try {
      const rec = await tx(await db(), 'readonly', (s) => s.get(key), TILES);
      return rec && Date.now() - rec.time < MAX_AGE_MS ? rec.elements : null;
    } catch {
      return null;
    }
  },
  async put(key, elements) {
    try {
      await tx(await db(), 'readwrite', (s) => s.put({ time: Date.now(), elements }, key), TILES);
    } catch {
      /* storage full or blocked: ignore */
    }
  },
};
