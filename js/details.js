// Details for a running spot (track, stadium, park): its website, Wikipedia
// page, opening hours and entry rules. Map tiles carry none of this, so it is
// looked up on tap: the place in OpenStreetMap through Nominatim (with its
// extra tags), then Wikidata for the official website when OSM has none.

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const WIKIDATA = 'https://www.wikidata.org/wiki/Special:EntityData';
const LOOKUP_TIMEOUT_MS = 7000;
const GENERIC_NAME = /^(athletics track|running track|park)$/i;
const PLACE_TYPES = /^(stadium|track|sports_centre|sports_hall|pitch|park|garden|recreation_ground|nature_reserve)$/;

async function getJson(url, fetchImpl, timeoutMs = LOOKUP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('status ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const cleanUrl = (u) => {
  if (!u || typeof u !== 'string') return null;
  const first = u.split(/[;\s]+/)[0];
  if (!first) return null;
  return /^https?:\/\//i.test(first) ? first : `https://${first}`;
};

/** Picks the OSM place that matches a running spot from Nominatim results. */
export function pickOsmPlace(results, place) {
  const list = (results || []).filter((r) => r && (r.extratags || r.name));
  if (!list.length) return null;
  const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const wanted = [norm(place.name), norm(place.local)].filter(Boolean);
  const score = (r) => {
    let s = 0;
    const nm = norm(r.name || r.display_name?.split(',')[0]);
    if (wanted.includes(nm)) s += 4;
    else if (wanted.some((w) => nm && (nm.includes(w) || w.includes(nm)))) s += 2;
    if (PLACE_TYPES.test(r.type || '')) s += 2;
    if (r.extratags?.website || r.extratags?.['contact:website'] || r.extratags?.wikidata || r.extratags?.wikipedia) s += 1;
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

/** What the OSM tags say, in one small record. */
export function detailsFromTags(tags = {}, osm = {}) {
  const d = {};
  const site = cleanUrl(tags.website || tags['contact:website'] || tags.url);
  if (site) d.website = site;
  if (tags.wikidata && /^Q\d+$/.test(tags.wikidata)) d.wikidata = tags.wikidata;
  if (tags.wikipedia && /^[a-z-]+:.+/.test(tags.wikipedia)) {
    const [lang, ...rest] = tags.wikipedia.split(':');
    d.wikipedia = { lang, title: rest.join(':'), url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(rest.join(':').replace(/ /g, '_'))}` };
  }
  if (tags.opening_hours) d.hours = tags.opening_hours;
  if (tags.fee === 'no') d.fee = 'free';
  else if (tags.fee === 'yes') d.fee = 'paid';
  if (tags.access === 'private' || tags.access === 'no' || tags.access === 'customers') d.access = 'private';
  else if (tags.access === 'yes' || tags.access === 'public' || tags.access === 'permissive') d.access = 'public';
  const phone = tags.phone || tags['contact:phone'];
  if (phone) d.phone = phone.split(';')[0].trim();
  if (tags.sport) d.sport = tags.sport;
  if (osm.name && !GENERIC_NAME.test(osm.name)) d.osmName = osm.name;
  return d;
}

/** Adds the official website and Wikipedia links from a Wikidata entity. */
export function detailsFromWikidata(entityJson, id, d = {}) {
  const ent = entityJson?.entities?.[id];
  if (!ent) return d;
  const sites = (ent.claims?.P856 || []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => typeof v === 'string');
  if (!d.website && sites.length) d.website = cleanUrl(sites[0]);
  if (!d.wikipedia || (d.wikipedia.lang !== 'en' && ent.sitelinks?.enwiki)) {
    const links = ent.sitelinks || {};
    const pick = ['enwiki', ...Object.keys(links).filter((k) => k !== 'enwiki' && /wiki$/.test(k) && !/wikivoyage|wikiquote|wikinews|commons/.test(k))];
    for (const k of pick) {
      if (links[k]?.title) {
        const lang = k.replace(/wiki$/, '');
        d.wikipedia = { lang, title: links[k].title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(links[k].title.replace(/ /g, '_'))}` };
        break;
      }
    }
  }
  if (!d.name && ent.labels?.en?.value) d.name = ent.labels.en.value;
  return d;
}

/**
 * Looks a running spot up. Returns { website?, wikipedia?, hours?, fee?, access?, phone?, sport?, osmName?, source }
 * and never throws: with nothing found (or no network) the record is just empty.
 */
export async function lookupPlace(place, { fetchImpl = (...a) => fetch(...a) } = {}) {
  let d = {};
  try {
    const { lat, lon } = place;
    let results = [];
    const named = place.name && !GENERIC_NAME.test(place.name);
    if (named) {
      // Only this neighbourhood: a viewbox of about 2 km around the spot.
      const dLat = 0.01;
      const dLon = 0.012 / Math.cos((lat * Math.PI) / 180);
      const vb = `&viewbox=${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)},${(lat - dLat).toFixed(5)}&bounded=1`;
      for (const q of [place.name, place.local].filter((v, i, a) => v && a.indexOf(v) === i)) {
        results = await getJson(`${NOMINATIM}/search?format=jsonv2&limit=5&extratags=1&q=${encodeURIComponent(q)}${vb}`, fetchImpl);
        if (results?.length) break;
      }
    }
    if (!results?.length) {
      // The feature under the spot itself (works for unnamed tracks).
      const r = await getJson(`${NOMINATIM}/reverse?format=jsonv2&zoom=18&extratags=1&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, fetchImpl);
      if (r && !r.error && (PLACE_TYPES.test(r.type || '') || r.class === 'leisure')) results = [r];
    }
    const hit = pickOsmPlace(results, place);
    if (hit) d = detailsFromTags(hit.extratags || {}, hit);
    if (d.wikidata && (!d.website || !d.wikipedia || d.wikipedia.lang !== 'en')) {
      try {
        const ent = await getJson(`${WIKIDATA}/${d.wikidata}.json`, fetchImpl);
        d = detailsFromWikidata(ent, d.wikidata, d);
      } catch {
        /* Wikidata down: keep what OSM gave */
      }
    }
  } catch {
    /* no network or a timeout: nothing found */
  }
  return d;
}

/** Links that always work, even with nothing found. */
export function fallbackLinks(place) {
  const q = `${place.name}${place.local && place.local !== place.name ? ' ' + place.local : ''} ${place.kind === 'park' ? 'park' : 'athletics track'}`;
  return {
    search: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    maps: `https://www.google.com/maps/search/?api=1&query=${place.lat.toFixed(6)},${place.lon.toFixed(6)}`,
  };
}
