// The Hebrew interface: the table, the templates, and that the page has no text left behind.
// Run: node tests/test-i18n.mjs
import { readFileSync } from 'node:fs';
import { tr, setLanguage, currentLanguage, fillText, HE_TEXT } from '../js/i18n.js';
import { cueAction, distText, paceText } from '../js/navigation.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const HEBREW = /[֐-׿]/;

// English is the code's own language: nothing changes while it is on.
check(currentLanguage() === 'en' && tr('No runs yet') === 'No runs yet' && tr('In 300 meters, turn left') === 'In 300 meters, turn left', 'English: texts pass through untouched');
setLanguage('xx');
check(currentLanguage() === 'en', 'an unknown language falls back to English');

setLanguage('he');
check(tr('No runs yet') === 'עדיין אין ריצות', 'a fixed text is looked up');
check(tr('Something nobody translated') === 'Something nobody translated', 'a missing text stays English, no error');
check(tr('  My runs\n  ') === '  הריצות שלי\n  ', 'the spaces around a text are kept');
check(tr(null) === null && tr('') === '' && tr('12:30') === '12:30', 'nothing to translate in empty text or bare numbers');

// Templates: the pieces are translated on their own.
check(tr('In 300 meters, turn left') === 'בעוד 300 מטר, פנה שמאלה', 'a spoken turn with its distance');
check(tr('2 traffic lights · 1 road crossing') === '2 רמזורים · חציית כביש אחת', 'a number template does not swallow the text before it');
check(tr('Out & back through the green to the southwest') === 'הלוך ושוב דרך הירוק לכיוון דרום-מערב', 'a route name with its direction');
check(tr('Hilly city loop to the north-northeast') === 'סיבוב עירוני הררי לכיוון צפון-צפון-מזרח', 'a hilly loop (lower-case theme) with a fine direction');
check(tr('Laps at Central Stadium') === 'הקפות: Central Stadium', 'a place name in Latin letters is not glued to a Hebrew prefix');
check(tr('4 laps of the 400 m track · 2.2 km to get there and back the same way · 6.2 km in total').startsWith('4 הקפות של מסלול 400 מ׳ · 2.2 ק"מ'), 'a long card line, piece by piece');
check(tr('1–42.2 km') === '⁦1–42.2⁩ ק"מ', 'a range of numbers is kept left to right inside the Hebrew');
check(tr('Run finished. 5.0 kilometers in 25 minutes. Average pace 5 minutes per kilometer.') === 'הריצה הסתיימה. 5.0 קילומטר ב-25 דקות. קצב ממוצע 5 דקות לקילומטר.', 'the end-of-run summary');
check(tr('Starting your 5.0 kilometer run. ') === 'מתחילים ריצה של 5.0 קילומטר. ', 'a spoken part keeps its trailing space');
check(tr(' onto ') === ' לרחוב ' && tr('On your left: ') === 'משמאלך: ', 'the small joining parts of a sentence');
check(fillText('{a} of {b}', { a: 1, b: 2 }) === '1 of 2', 'fillText puts values into placeholders');

// Everything the navigator can say or show comes out in Hebrew.
{
  const cues = [
    { type: 'turn', dir: 'left' }, { type: 'turn', dir: 'right' }, { type: 'slight', dir: 'left' }, { type: 'slight', dir: 'right' },
    { type: 'sharp', dir: 'left' }, { type: 'sharp', dir: 'right' }, { type: 'uturn' }, { type: 'arrive' }, { type: 'lap', lap: 2, laps: 5 },
    ...['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'].map((compass) => ({ type: 'depart', compass })),
  ];
  const left = cues.map(cueAction).filter((a) => !HEBREW.test(tr(a)));
  check(left.length === 0, `every banner instruction has Hebrew (${left.join(', ') || 'all'})`);
  const dists = [40, 150, 300, 950, 1200, 5400].flatMap((m) => [distText(m, 'km'), distText(m, 'mi')]);
  const leftD = dists.filter((d) => !HEBREW.test(tr(d)));
  check(leftD.length === 0, `every spoken distance has Hebrew (${leftD.join(', ') || 'all'})`);
  const paces = [300, 332, 420].flatMap((s) => [paceText(s, 'km'), paceText(s, 'mi')]);
  check(paces.every((p) => HEBREW.test(tr(p))), 'every spoken pace has Hebrew');
}

// The page: every text and label in index.html has Hebrew (names of services and the like excepted).
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const body = html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '<i></i>').replace(/<!--[\s\S]*?-->/g, '');
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&copy;/g, '©').replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—').replace(/&times;/g, '×').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const texts = new Set();
  for (const m of body.matchAll(/>([^<>]+)</g)) { const t = decode(m[1]).replace(/\s+/g, ' ').trim(); if (/[A-Za-z]{2,}/.test(t)) texts.add(t); }
  for (const m of body.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)) { const t = decode(m[1]).trim(); if (/[A-Za-z]{2,}/.test(t)) texts.add(t); }
  // Proper names, version stamps and the units inside number fields stay as they are.
  const AS_IS = /^(RunTheTown|OpenStreetMap|OpenFreeMap|Esri|Photon \(komoot\)|Nominatim|Overpass API|Wikidata|Open-Meteo|AWS Terrain Tiles|Microsoft Planetary Computer|Safari|English|Android \(Chrome\)|DEMO ×\d+|[0-9a-f]{8}|עברית|Apple Watch)$/;
  const missing = [...texts].filter((t) => !AS_IS.test(t) && !HEBREW.test(tr(t)));
  for (const t of missing) console.log(`    no Hebrew for: ${JSON.stringify(t.slice(0, 100))}`);
  check(texts.size > 150 && missing.length === 0, `all ${texts.size} texts of the page have Hebrew (${missing.length} missing)`);
}

// The table itself: Hebrew on the right-hand side, placeholders carried over.
{
  const bad = Object.entries(HE_TEXT).filter(([en, he]) => {
    const want = [...en.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]);
    const got = new Set([...he.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]));
    const extra = [...got].filter((k) => !want.includes(k));
    return extra.length > 0 || (!HEBREW.test(he) && he !== en && !/^[\s\S]*\{/.test(he));
  });
  for (const [en] of bad.slice(0, 10)) console.log(`    suspicious entry: ${JSON.stringify(en.slice(0, 80))}`);
  check(bad.length === 0, `the ${Object.keys(HE_TEXT).length} entries are well formed (${bad.length} suspicious)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll i18n tests passed');
process.exit(failures ? 1 : 0);
