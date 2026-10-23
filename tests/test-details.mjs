// Place details (website, Wikipedia, hours) lookups. Run: node tests/test-details.mjs
import { lookupPlace, pickOsmPlace, detailsFromTags, detailsFromWikidata, fallbackLinks } from '../js/details.js';
import { RouteEngine } from '../js/engine.js';
import { syntheticOverpass, CENTER } from './synthetic-city.mjs';
import { makeMockMapBackend } from './mock-vectortiles.mjs';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const json = (v) => ({ ok: true, status: 200, json: async () => v });

// Real shapes seen live for Hadar Yosef (Oct 19): OSM has only sport + wikidata, Wikidata has the site.
const nominatimHadar = [{ name: 'Hadar Yosef Stadium', class: 'leisure', type: 'stadium', osm_type: 'way', osm_id: 91609721, extratags: { sport: 'athletics', wikidata: 'Q863824' } }];
const wikidataHadar = { entities: { Q863824: { labels: { en: { value: 'National Sport Center Tel Aviv' } }, claims: { P856: [{ mainsnak: { datavalue: { value: 'http://nsc.org.il' } } }] }, sitelinks: { enwiki: { title: 'National Sport Center Tel Aviv' }, hewiki: { title: 'מרכז הספורט הלאומי תל אביב' } } } } };
const hadar = { kind: 'track', name: 'Hadar Yosef Stadium', local: 'אצטדיון האתלטיקה הדר יוסף', lat: 32.1049, lon: 34.8222 };

const fetchHadar = async (url) => {
  if (url.includes('nominatim') && url.includes('search')) return json(url.includes('viewbox') && url.includes('bounded=1') ? nominatimHadar : []);
  if (url.includes('wikidata.org')) return json(wikidataHadar);
  throw new Error('unexpected ' + url);
};
{
  const d = await lookupPlace(hadar, { fetchImpl: fetchHadar });
  console.log('Hadar Yosef:', d);
  check(d.website === 'http://nsc.org.il', 'website comes from Wikidata when OSM has none');
  check(d.wikipedia?.lang === 'en' && d.wikipedia.url === 'https://en.wikipedia.org/wiki/National_Sport_Center_Tel_Aviv', 'English Wikipedia link built from the sitelink');
  check(d.sport === 'athletics', 'sport kept');
}
// OSM website wins over Wikidata; hours, fee and phone pass through; wikipedia tag parsed.
{
  const d = detailsFromTags({ website: 'example.org/track; https://other', opening_hours: 'Mo-Fr 06:00-22:00', fee: 'no', access: 'yes', phone: '+972 3 555 1234; +972 3 555 1235', wikipedia: 'he:פארק הירקון' }, { name: 'X' });
  check(d.website === 'https://example.org/track', 'first website, scheme added');
  check(d.hours === 'Mo-Fr 06:00-22:00' && d.fee === 'free' && d.access === 'public' && d.phone === '+972 3 555 1234', 'hours, fee, access, phone');
  check(d.wikipedia.lang === 'he' && d.wikipedia.url.startsWith('https://he.wikipedia.org/wiki/'), 'wikipedia tag parsed');
  const d2 = detailsFromWikidata(wikidataHadar, 'Q863824', { ...d });
  check(d2.website === 'https://example.org/track' && d2.wikipedia.lang === 'en' && d2.wikipedia.title === 'National Sport Center Tel Aviv', 'OSM website kept; an English Wikipedia article replaces a local-language one');
}
// Picking the right OSM result: name match + place type beat a random street.
{
  const results = [{ name: 'Klachkin', class: 'highway', type: 'tertiary', extratags: {} }, { name: 'Shitrit', class: 'leisure', type: 'track', extratags: { sport: 'running' } }, { name: 'Hadar Yosef Stadium', class: 'leisure', type: 'stadium', extratags: { wikidata: 'Q863824' } }];
  check(pickOsmPlace(results, hadar).name === 'Hadar Yosef Stadium', 'name match wins');
  check(/^(track|stadium)$/.test(pickOsmPlace(results, { name: 'Athletics track', local: 'Athletics track' }).type), 'otherwise a leisure place wins over a street');
}
// Unnamed track: reverse geocoding is used; nothing found gives an empty record, never an error.
{
  let reverse = 0;
  const d = await lookupPlace({ kind: 'track', name: 'Athletics track', local: 'Athletics track', lat: 32.1171, lon: 34.8027 }, { fetchImpl: async (url) => { if (url.includes('/reverse')) { reverse++; return json({ class: 'highway', type: 'tertiary', name: 'Klachkin', extratags: {} }); } throw new Error('no search expected: ' + url); } });
  check(reverse === 1 && Object.keys(d).length === 0, 'generic name: reverse lookup only, street ignored');
  const down = await lookupPlace(hadar, { fetchImpl: async () => { throw new Error('offline'); } });
  check(Object.keys(down).length === 0, 'offline: empty details, no exception');
  const links = fallbackLinks(hadar);
  check(/google\.com\/search\?q=Hadar/.test(links.search) && /maps\/search\/\?api=1&query=32\.1049/.test(links.maps), 'search and map links always available');
}
// Through the engine, with caching: one lookup per place.
{
  const fetchImpl = makeMockMapBackend(syntheticOverpass());
  const engine = new RouteEngine({ fetchImpl, fetchElevationImpl: async () => null, useCache: false, scanPauseMs: 0 });
  const routes = await engine.plan({ lat: CENTER[0], lon: CENTER[1], distanceKm: 6, prefs: {}, terrain: 'any' });
  const track = routes.places.find((p) => p.kind === 'track');
  const park = routes.places.find((p) => p.kind === 'park');
  const [dt, dp] = await Promise.all([engine.placeDetails(track), engine.placeDetails(park)]);
  console.log('engine:', dt, dp);
  check(dt.website === 'https://example.org/central-stadium' && dt.hours === 'Mo-Su 06:00-22:00' && dt.fee === 'free', 'track: website, hours and free entry from OSM');
  check(dt.wikipedia?.lang === 'en', 'track: Wikipedia from Wikidata sitelinks');
  check(dp.wikipedia?.url === 'https://en.wikipedia.org/wiki/Central_Park_(Testville)' && !dp.website, 'park: Wikipedia from the OSM tag');
  const before = fetchImpl.calls.details;
  await engine.placeDetails(track);
  check(fetchImpl.calls.details === before, 'second tap uses the cache');
}
console.log(failures ? `\n${failures} FAILED` : '\nAll details tests passed');
process.exit(failures ? 1 : 0);
