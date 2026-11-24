// The account server (server/accounts.js behind server/worker.js) driven in Node: a real
// SQLite database stands in for Cloudflare's D1 (same SQL, the tables of server/schema.sql),
// a list stands in for the mail service, and a key pair made here stands in for Google's and
// Apple's, so every way of signing in is exercised end to end with no network.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../server/worker.js';

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

// D1's small interface over node:sqlite.
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql) => {
    let args = [];
    const st = {
      bind: (...a) => { args = a; return st; },
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    };
    return st;
  };
  return { raw: db, prepare, batch: async (list) => { for (const s of list) await s.run(); } };
}

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// Google's and Apple's signing keys: one pair of ours, published where the server looks.
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const stranger = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'key-1', use: 'sig', alg: 'RS256' };
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
async function idToken(claims, { key = pair.privateKey, alg = 'RS256', kid = 'key-1' } = {}) {
  const head = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head))).toString('base64url');
  return `${head}.${sig}`;
}
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (/googleapis\.com\/oauth2\/v3\/certs|appleid\.apple\.com\/auth\/keys/.test(String(url))) return new Response(JSON.stringify({ keys: [jwk] }));
  return new Response('{}', { status: 404 });
};

// The server's settings, its clock (moved by hand) and its outbox.
let clock = Date.parse('2026-11-23T10:00:00Z');
const outbox = [];
const DB = d1();
const env = {
  DB, now: () => clock,
  ALLOWED_ORIGINS: 'https://uri-kedem.github.io,capacitor://localhost',
  GOOGLE_WEB_CLIENT_ID: 'web-client.apps.googleusercontent.com', GOOGLE_IOS_CLIENT_ID: 'ios-client.apps.googleusercontent.com',
  APPLE_APP_ID: 'com.urikedem.runthetown',
  sendMail: async (to, mail) => { outbox.push({ to, ...mail }); },
};
const call = async (method, path, { body, token, origin = 'capacitor://localhost', ip = '203.0.113.7', use = env } = {}) => {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`https://proxy.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), use);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, headers: res.headers };
};
const codeIn = (mail) => mail.text.match(/\b(\d{6})\b/)?.[1];
const minutes = (n) => { clock += n * 60000; };

// Who may call, and what a browser is told it may send.
{
  const pre = await call('OPTIONS', '/account/runs/x');
  check(pre.status === 204 && /PUT/.test(pre.headers.get('Access-Control-Allow-Methods')) && /DELETE/.test(pre.headers.get('Access-Control-Allow-Methods')) && /Authorization/.test(pre.headers.get('Access-Control-Allow-Headers')), 'a browser may send the key and use PUT and DELETE');
  const other = await call('GET', '/account', { origin: 'https://elsewhere.example' });
  check(other.status === 403, 'another website cannot use the accounts');
  const none = await call('GET', '/account');
  check(none.status === 401 && none.headers.get('Cache-Control') === 'no-store', 'no key: not signed in, and nothing here is cached');
  const all = await call('GET', '/account/ways');
  check(all.status === 200 && all.data.email === true && all.data.google.web === 'web-client.apps.googleusercontent.com' && all.data.google.ios === 'ios-client.apps.googleusercontent.com' && all.data.apple.app === true && all.data.apple.web === null, 'the app is told which ways in are switched on');
  const bare = await call('GET', '/account/ways', { use: { DB, ALLOWED_ORIGINS: env.ALLOWED_ORIGINS } });
  const off = await call('GET', '/account/ways', { use: { ...env, DB: undefined } });
  check(bare.data.email === false && bare.data.google === null && bare.data.apple === null && off.data.email === false && off.data.google === null, 'with nothing set up, no way in is offered');
  const noDb = await call('POST', '/account/email/start', { body: { email: 'a@example.org' }, use: { ...env, DB: undefined } });
  check(noDb.status === 503, 'without a database the accounts answer "not set up"');
  const noMail = await call('POST', '/account/email/start', { body: { email: 'a@example.org' }, use: { ...env, sendMail: undefined } });
  check(noMail.status === 503 && outbox.length === 0, 'without a mail service the e-mail way in answers "not set up"');
}

// E-mail: a code is sent, typed back, and that is the account.
let dana;
{
  const bad = await call('POST', '/account/email/start', { body: { email: 'not an address' } });
  check(bad.status === 400, 'something that is not an address is refused');
  const start = await call('POST', '/account/email/start', { body: { email: '  Dana@Example.org ', lang: 'en' } });
  const mail = outbox.at(-1);
  check(start.status === 200 && start.data.minutes === 10 && mail.to === 'dana@example.org' && /^\d{6}$/.test(codeIn(mail)) && mail.subject.includes(codeIn(mail)), 'a six-digit code goes to the address, lower-cased');
  check(!JSON.stringify(start.data).includes(codeIn(mail)), 'the code is in the e-mail only, never in the answer to the app');
  check(!DB.raw.prepare('SELECT code_hash FROM codes').get().code_hash.includes(codeIn(mail)), 'the database keeps a hash of the code, not the code');
  const again = await call('POST', '/account/email/start', { body: { email: 'dana@example.org' } });
  check(again.status === 429 && again.data.wait > 0 && again.data.wait <= 60 && outbox.length === 1, 'a second code within a minute is refused, with how long to wait');
  const wrong = await call('POST', '/account/email/verify', { body: { email: 'dana@example.org', code: '000000' === codeIn(mail) ? '111111' : '000000' } });
  check(wrong.status === 400 && wrong.data.left === 4, 'a wrong code: four tries left');
  const ok = await call('POST', '/account/email/verify', { body: { email: 'DANA@example.org', code: ` ${codeIn(mail).slice(0, 3)} ${codeIn(mail).slice(3)} `, device: 'iPhone' } });
  dana = ok.data;
  check(ok.status === 200 && dana.token.length >= 40 && dana.isNew === true && dana.account.email === 'dana@example.org' && dana.profile === null && dana.account.runs === 0, 'the right code (typed with spaces) opens a new account and signs the phone in');
  const reuse = await call('POST', '/account/email/verify', { body: { email: 'dana@example.org', code: codeIn(mail) } });
  check(reuse.status === 410, 'a code works once');
  const stored = DB.raw.prepare('SELECT token_hash FROM sessions').all();
  check(stored.length === 1 && !JSON.stringify(stored).includes(dana.token) && /^[0-9a-f]{64}$/.test(stored[0].token_hash), 'only a hash of the phone\'s key is stored');
  const me = await call('GET', '/account', { token: dana.token });
  check(me.status === 200 && me.data.account.id === dana.account.id, 'the key says whose account it is');
  const forged = await call('GET', '/account', { token: `${dana.token.slice(0, -2)}xx` });
  check(forged.status === 401, 'a made-up key is refused');
}

// Guessing and waiting.
{
  minutes(2);
  await call('POST', '/account/email/start', { body: { email: 'guess@example.org' } });
  const real = codeIn(outbox.at(-1));
  const guess = real === '123456' ? '654321' : '123456';
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push(await call('POST', '/account/email/verify', { body: { email: 'guess@example.org', code: guess } }));
  check(tries.slice(0, 4).every((t) => t.status === 400) && tries[4].status === 410, 'five wrong guesses and the code is thrown away');
  const late = await call('POST', '/account/email/verify', { body: { email: 'guess@example.org', code: real } });
  check(late.status === 410, 'after that even the right code is refused: a new one must be asked for');
  minutes(2);
  await call('POST', '/account/email/start', { body: { email: 'slow@example.org' } });
  const slow = codeIn(outbox.at(-1));
  minutes(11);
  const expired = await call('POST', '/account/email/verify', { body: { email: 'slow@example.org', code: slow } });
  check(expired.status === 410 && expired.data.error === 'the code has expired', 'a code older than ten minutes has expired');
  // Six codes an hour to one address.
  let sent = 0, refused = null;
  for (let i = 0; i < 8; i++) {
    minutes(1.1);
    const r = await call('POST', '/account/email/start', { body: { email: 'flood@example.org' }, ip: `198.51.100.${i}` });
    if (r.status === 200) sent++; else refused = r;
  }
  check(sent === 6 && refused?.status === 429 && refused.data.wait > 60, `no more than six codes an hour to one address (${sent} sent)`);
  minutes(60);
}

// The same address again is the same account; a second phone has its own key.
let phone2;
{
  await call('POST', '/account/email/start', { body: { email: 'dana@example.org', lang: 'he' } });
  const mail = outbox.at(-1);
  check(/[֐-׿]/.test(mail.text) && /RunTheTown/.test(mail.text) && !/[֐-׿]-?RunTheTown/.test(mail.text), 'in Hebrew the message is Hebrew, and no prefix is glued to the app\'s name');
  const r = await call('POST', '/account/email/verify', { body: { email: 'dana@example.org', code: codeIn(mail), device: 'web' } });
  phone2 = r.data;
  check(r.status === 200 && phone2.isNew === false && phone2.account.id === dana.account.id && phone2.token !== dana.token, 'signing in again with the same address is the same account, with a key of its own');
}

// The profile: the later change wins.
{
  const photo = `data:image/jpeg;base64,${Buffer.from('a small picture').toString('base64')}`;
  const put = await call('PUT', '/account/profile', { token: dana.token, body: { profile: { name: '  Dana  ', photo, photoFull: 'javascript:alert(1)', since: '2026-11-01T08:00:00.000Z', skipped: false, extra: 'x' }, updated: clock - 5000 } });
  check(put.status === 200 && put.data.profile.name === 'Dana' && put.data.profile.photo === photo && put.data.profile.photoFull === null && !('extra' in put.data.profile) && put.data.profileUpdated === clock - 5000, 'the profile is kept: the name, real pictures only, nothing else');
  const older = await call('PUT', '/account/profile', { token: phone2.token, body: { profile: { name: 'Old name' }, updated: clock - 60000 } });
  check(older.data.profile.name === 'Dana' && older.data.profileUpdated === clock - 5000, 'an older change from another phone loses, and is told the newer profile');
  const newer = await call('PUT', '/account/profile', { token: phone2.token, body: { profile: { name: 'Dana K' }, updated: clock + 999999 } });
  check(newer.data.profile.name === 'Dana K' && newer.data.profileUpdated === clock, 'a newer change wins (a clock running ahead is brought back to now)');
  const seen = await call('GET', '/account', { token: dana.token });
  check(seen.data.profile.name === 'Dana K', 'the first phone sees it');
}

// The run journal.
const run = (id, extra = {}) => ({ id, time: id.slice(0, 24), distance: 5000, elapsed: 1500000, name: 'Sea loop', track: [[32.08, 34.77, 0], [32.081, 34.771, 30]], latlngs: [[32.08, 34.77], [32.081, 34.771]], picture: `data:image/jpeg;base64,${'A'.repeat(2000)}`, ...extra });
const idA = '2026-11-20T06:00:00.000Z-abc123', idB = '2026-11-21T06:00:00.000Z-def456';
{
  const put = await call('PUT', `/account/runs/${encodeURIComponent(idA)}`, { token: dana.token, body: { run: run(idA) } });
  await call('PUT', `/account/runs/${encodeURIComponent(idB)}`, { token: dana.token, body: { run: run(idB) } });
  check(put.status === 200 && put.data.updated === clock, 'a run is saved to the account');
  const list = await call('GET', '/account/runs', { token: phone2.token });
  check(list.data.runs.length === 2 && list.data.runs.every((r) => !r.deleted) && !('body' in list.data.runs[0]), 'the other phone is told which runs the account has');
  const got = await call('GET', `/account/runs/${encodeURIComponent(idA)}`, { token: phone2.token });
  check(got.status === 200 && got.data.run.distance === 5000 && got.data.run.track.length === 2 && got.data.run.picture === null, 'and reads one whole: the track and the line, without the map picture');
  const mismatch = await call('PUT', `/account/runs/${encodeURIComponent(idA)}`, { token: dana.token, body: { run: run(idB) } });
  const badId = await call('PUT', '/account/runs/a%20b', { token: dana.token, body: { run: run('a b') } });
  const huge = await call('PUT', `/account/runs/${encodeURIComponent(idB)}`, { token: dana.token, body: { run: run(idB, { latlngs: 'x'.repeat(500000) }) } });
  check(mismatch.status === 400 && badId.status === 400 && huge.status === 413, 'a run under the wrong id, an id that is not one, and an enormous run are refused');
  const del = await call('DELETE', `/account/runs/${encodeURIComponent(idA)}`, { token: phone2.token });
  const after = await call('GET', '/account/runs', { token: dana.token });
  check(del.status === 200 && after.data.runs.find((r) => r.id === idA).deleted === true && DB.raw.prepare('SELECT body FROM runs WHERE id = ?').get(idA).body === null, 'a run deleted on one phone is marked deleted for the other, and its content is gone');
  const back = await call('PUT', `/account/runs/${encodeURIComponent(idA)}`, { token: dana.token, body: { run: run(idA) } });
  const gone = await call('GET', `/account/runs/${encodeURIComponent(idA)}`, { token: dana.token });
  check(back.data.deleted === true && gone.status === 404, 'the phone that still has it cannot bring it back');
  check((await call('GET', '/account', { token: dana.token })).data.account.runs === 1, 'the account counts the runs it still has');
}

// Google: a signed note, checked.
let viaGoogle;
{
  const base = { iss: 'https://accounts.google.com', aud: 'web-client.apps.googleusercontent.com', sub: 'g-1001', email: 'Dana@example.org', email_verified: true, hd: 'example.org', name: 'Dana Kay', exp: Math.floor(clock / 1000) + 3600 };
  const good = await call('POST', '/account/google', { body: { credential: await idToken(base), device: 'web' } });
  viaGoogle = good.data;
  check(good.status === 200 && viaGoogle.account.id === dana.account.id && viaGoogle.isNew === false && viaGoogle.account.google === true && viaGoogle.givenName === 'Dana Kay', 'Google vouching for the same address signs in to the same account');
  check(asked.some((u) => u.includes('googleapis.com/oauth2/v3/certs')), 'the signature is checked against Google\'s published keys');
  const otherApp = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, aud: 'someone-else.apps.googleusercontent.com' }) } });
  const expired = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, exp: Math.floor(clock / 1000) - 3600 }) } });
  const forged = await call('POST', '/account/google', { body: { credential: await idToken(base, { key: stranger.privateKey }) } });
  const fromElsewhere = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, iss: 'https://accounts.example.com' }) } });
  const unsigned = await call('POST', '/account/google', { body: { credential: `${b64({ alg: 'none', kid: 'key-1' })}.${b64(base)}.` } });
  const t = await idToken(base);
  const edited = await call('POST', '/account/google', { body: { credential: `${t.split('.')[0]}.${b64({ ...base, email: 'victim@example.org' })}.${t.split('.')[2]}` } });
  check([otherApp, expired, forged, fromElsewhere, unsigned, edited].every((r) => r.status === 401), 'a note for another app, an expired one, one signed by a stranger, one from another issuer, an unsigned one and an edited one are all refused');
  // An address Google has not checked must not open someone else's account.
  const unproved = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, sub: 'g-2002', email: 'dana@example.org', email_verified: false }) } });
  check(unproved.status === 200 && unproved.data.account.id !== dana.account.id && unproved.data.account.email === null && unproved.data.isNew === true, 'an address Google has not verified does not open the account that owns it');
  const notGoogles = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, sub: 'g-3003', hd: undefined }) } });
  const gmail = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, sub: 'g-4004', hd: undefined, email: 'someone@gmail.com' }) } });
  check(notGoogles.data.account.id !== dana.account.id && notGoogles.data.account.email === null && gmail.data.account.email === 'someone@gmail.com', 'Google\'s word settles an address only for Gmail and for an organisation\'s own accounts');
  const sameSub = await call('POST', '/account/google', { body: { credential: await idToken({ ...base, email: 'new-address@example.org' }) } });
  check(sameSub.data.account.id === dana.account.id, 'the same Google person with a changed address is still the same account');
  const off = await call('POST', '/account/google', { body: { credential: await idToken(base) }, use: { ...env, GOOGLE_WEB_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '' } });
  check(off.status === 503, 'with no Google setting the Google way in answers "not set up"');
}

// Apple: the same check; the name comes beside the note, and "verified" comes as a word.
let noa;
{
  const claims = { iss: 'https://appleid.apple.com', aud: 'com.urikedem.runthetown', sub: 'apple-77', email: 'noa@privaterelay.appleid.com', email_verified: 'true', exp: Math.floor(clock / 1000) + 600 };
  const r = await call('POST', '/account/apple', { body: { identityToken: await idToken(claims), name: 'Noa', device: 'iPhone' } });
  noa = r.data;
  check(r.status === 200 && noa.isNew === true && noa.account.apple === true && noa.account.email === 'noa@privaterelay.appleid.com' && noa.givenName === 'Noa' && asked.some((u) => u.includes('appleid.apple.com/auth/keys')), 'Sign in with Apple opens an account, with the name the phone passed on');
  const wrongIssuer = await call('POST', '/account/apple', { body: { identityToken: await idToken({ ...claims, iss: 'https://accounts.google.com' }) } });
  check(wrongIssuer.status === 401, 'a Google note is not accepted as an Apple one');
}

// One runner never sees another's runs.
{
  const peek = await call('GET', `/account/runs/${encodeURIComponent(idB)}`, { token: noa.token });
  const list = await call('GET', '/account/runs', { token: noa.token });
  check(peek.status === 404 && list.data.runs.length === 0, 'another account cannot read or list Dana\'s runs');
  await call('PUT', `/account/runs/${encodeURIComponent(idB)}`, { token: noa.token, body: { run: run(idB, { name: 'Noa\'s' }) } });
  const danas = await call('GET', `/account/runs/${encodeURIComponent(idB)}`, { token: dana.token });
  check(danas.data.run.name === 'Sea loop', 'two accounts may hold a run with the same id without touching each other');
}

// Signing out, a phone long unused, and deleting the account.
{
  const out = await call('POST', '/account/signout', { token: phone2.token });
  check(out.status === 200 && (await call('GET', '/account', { token: phone2.token })).status === 401 && (await call('GET', '/account', { token: dana.token })).status === 200, 'signing out forgets that phone\'s key and no other');
  const del = await call('DELETE', '/account', { token: dana.token });
  const left = ['users', 'sessions', 'runs'].map((t) => DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = ?`).get(dana.account.id).n);
  check(del.status === 200 && left.every((n) => n === 0), 'deleting the account removes the account, every phone\'s key and every run');
  check((await call('GET', '/account', { token: dana.token })).status === 401 && (await call('GET', '/account', { token: viaGoogle.token })).status === 401, 'and no key of that account works afterwards');
  check((await call('GET', `/account/runs/${encodeURIComponent(idB)}`, { token: noa.token })).status === 200, 'the other runner\'s account is untouched');
  clock += 401 * 86400000;
  check((await call('GET', '/account', { token: noa.token })).status === 401, 'a phone not seen for more than a year is signed out');
}

// What has run out is cleared away in passing (about one request for a code in twenty does it).
{
  clock += 3 * 86400000;
  const before = DB.raw.prepare('SELECT COUNT(*) AS n FROM limits').get().n;
  for (let i = 0; i < 150; i++) { minutes(1.1); await call('POST', '/account/email/start', { body: { email: `tidy${i}@example.org` }, ip: `198.51.100.${i}` }); }
  const old = DB.raw.prepare('SELECT COUNT(*) AS n FROM limits WHERE start < ?').get(clock - 2 * 86400000).n;
  const stale = DB.raw.prepare('SELECT COUNT(*) AS n FROM codes WHERE expires < ?').get(clock - 2 * 86400000).n;
  check(before > 0 && old === 0 && stale === 0, 'old counters and codes nobody typed do not pile up in the database');
}

// ---- The app's side (js/account.js) against that server: two phones and one account ----
{
  const { Account, AccountError, accountMessage } = await import('../js/account.js');
  const { loadProfile, saveProfile } = await import('../js/journal.js');
  clock = Date.parse('2028-03-01T08:00:00Z');
  let online = true;
  // A phone: its own storage and journal, talking to the worker above.
  const phone = (name) => {
    const kept = new Map();
    const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); }, removeItem: (k) => { kept.delete(k); } };
    const runs = new Map();
    const journal = { save: async (r) => { runs.set(r.id, r); return r; }, list: async () => [...runs.values()].map((r) => ({ ...r, picture: undefined, track: undefined })), get: async (id) => runs.get(id), remove: async (id) => { runs.delete(id); } };
    const fetch = async (url, init) => { if (!online) throw new TypeError('offline'); return worker.fetch(new Request(url, { ...init, headers: { ...init.headers, Origin: 'capacitor://localhost', 'CF-Connecting-IP': '192.0.2.50' } }), env); };
    const account = new Account({ server: 'https://proxy.test', storage, fetch, runs: journal, now: () => clock, device: name });
    return { account, storage, runs, journal };
  };
  const signIn = async (p, email) => {
    minutes(2);
    await p.account.emailStart(email, 'en');
    return p.account.emailVerify(email, codeIn(outbox.at(-1)));
  };
  const A = phone('iPhone'), B = phone('web');

  // Which ways in the page may offer.
  const ways = await A.account.ways();
  check(ways.email === true && ways.google.web && ways.apple.app === true, 'the app learns which ways of signing in are switched on');
  online = false;
  check((await A.account.ways()).email === true && (await phone('new').account.ways()).email === false, 'offline: the last answer is used; a phone that never asked offers none');
  let refused = null;
  try { await A.account.emailStart('ruth@example.org'); } catch (e) { refused = e; }
  check(refused instanceof AccountError && refused.status === 0 && accountMessage(refused) === 'No connection. Try again when you are online.', 'with no connection the runner is told so');
  online = true;

  // A guest with a profile and two runs signs in: the phone's things go to the new account.
  saveProfile({ name: 'Ruth', photo: null, since: '2028-01-05T07:00:00.000Z' }, A.storage);
  const r1 = '2028-02-01T06:00:00.000Z-aaa111', r2 = '2028-02-08T06:00:00.000Z-bbb222', r3 = '2028-02-15T06:00:00.000Z-ccc333';
  await A.journal.save(run(r1)); await A.journal.save(run(r2));
  check(A.account.signedIn === false && (await A.account.sync()) === null, 'a guest: nothing is sent anywhere');
  let wrong = null;
  minutes(2);
  await A.account.emailStart('ruth@example.org', 'en');
  try { await A.account.emailVerify('ruth@example.org', codeIn(outbox.at(-1)) === '000000' ? '111111' : '000000'); } catch (e) { wrong = e; }
  check(accountMessage(wrong) === 'That code is not right. 4 tries left.' && A.account.signedIn === false, 'a wrong code is explained, with the tries left');
  const first = await A.account.emailVerify('ruth@example.org', codeIn(outbox.at(-1)));
  let changes = 0; A.account.onChange = () => { changes++; };
  await A.account.sync();
  const onServer = (await call('GET', '/account/runs', { token: A.account.token })).data.runs;
  const me = (await call('GET', '/account', { token: A.account.token })).data;
  check(first.isNew === true && A.account.who.email === 'ruth@example.org' && onServer.length === 2 && me.profile.name === 'Ruth', 'after signing in, the runs and the profile already on the phone are in the account');
  check(A.runs.get(r1).picture && (await call('GET', `/account/runs/${encodeURIComponent(r1)}`, { token: A.account.token })).data.run.picture === null, 'the phone keeps its map pictures; the account holds the runs without them');

  // The second phone signs in to the same account and receives them.
  const second = await signIn(B, 'ruth@example.org');
  let bChanges = 0; B.account.onChange = () => { bChanges++; };
  const got = await B.account.sync();
  check(second.isNew === false && got.down === 2 && got.profile === true && B.runs.size === 2 && B.runs.get(r2).track.length === 2 && loadProfile(B.storage).name === 'Ruth' && bChanges === 1, 'a second phone gets the profile and both runs, and the page is told to redraw');
  check((await B.account.sync()).down === 0 && B.runs.size === 2, 'syncing again changes nothing');

  // A run on the second phone, a deletion on the first, a new name on the second.
  await B.journal.save(run(r3)); await B.account.runSaved();
  await A.journal.remove(r1); await A.account.runDeleted(r1);
  minutes(1);
  saveProfile({ ...loadProfile(B.storage), name: 'Ruth B' }, B.storage); await B.account.profileChanged();
  // (Each of those three already exchanged what there was to exchange; one more round settles the rest.)
  await A.account.sync(); await B.account.sync();
  check(A.runs.has(r3) && A.runs.get(r3).track.length === 2 && loadProfile(A.storage).name === 'Ruth B', 'the first phone receives the new run and the new name');
  check(!B.runs.has(r1) && !A.runs.has(r1) && B.runs.size === 2 && A.runs.size === 2 && (await call('GET', '/account/runs', { token: A.account.token })).data.runs.find((r) => r.id === r1).deleted, 'the run deleted on one phone is deleted on the other, and is not sent back');

  // Offline: the phone goes on; what happened is exchanged when the connection returns.
  online = false;
  const r4 = '2028-02-22T06:00:00.000Z-ddd444';
  await A.journal.save(run(r4));
  check((await A.account.runSaved()) === null && A.account.signedIn === true && A.runs.has(r4), 'offline: the run is on the phone, the phone stays signed in, nothing fails');
  await A.journal.remove(r2); await A.account.runDeleted(r2);
  online = true;
  await A.account.sync(); const b3 = await B.account.sync();
  check(b3.down === 1 && b3.removed === 1 && B.runs.has(r4) && !B.runs.has(r2), 'back online: the run saved offline and the run deleted offline both reach the other phone');

  // Calls that arrive while a sync is running become one more pass, not a second sync at once.
  const r5 = '2028-02-25T06:00:00.000Z-eee555';
  const running = A.account.sync();
  await A.journal.save(run(r5));
  const folded = A.account.runSaved();
  await running; await folded;
  check(running === folded && (await call('GET', '/account/runs', { token: A.account.token })).data.runs.some((r) => r.id === r5 && !r.deleted), 'a run saved while a sync is running is sent by the same sync');

  // Signing out keeps the phone's runs; someone else signing in on that phone does not get them.
  await B.account.signOut();
  check(B.account.signedIn === false && B.runs.size === 2 && (await call('GET', '/account', { token: 'x'.repeat(43) })).status === 401, 'signing out: the phone is a guest again and keeps its runs');
  const other = await signIn(B, 'guest-of-ruth@example.org');
  const r6 = '2028-02-27T06:00:00.000Z-fff666';
  await B.journal.save(run(r6));
  await B.account.sync();
  const theirs = (await call('GET', '/account/runs', { token: B.account.token })).data.runs.map((r) => r.id);
  const theirProfile = (await call('GET', '/account', { token: B.account.token })).data.profile;
  check(other.isNew === true && theirs.length === 1 && theirs[0] === r6 && theirProfile === null, 'a different runner signing in on the same phone: Ruth\'s runs and name are not handed to their account');

  // The account deleted from one phone: the other phone becomes a guest at its next sync, with its runs.
  await A.account.sync();
  const C = phone('second iPhone'); await signIn(C, 'ruth@example.org'); await C.account.sync();
  const before = C.runs.size;
  await A.account.deleteAccount();
  check(A.account.signedIn === false && A.runs.size >= 2, 'deleting the account: this phone is a guest again and still has its runs');
  await C.account.sync();
  check(C.account.signedIn === false && C.runs.size === before && before >= 2, 'the other phone finds the account gone, becomes a guest, and keeps what it has');
  const again = await signIn(A, 'ruth@example.org'); await A.account.sync();
  check(again.isNew === true && (await call('GET', '/account/runs', { token: A.account.token })).data.runs.length === A.runs.size, 'signing up again later starts a fresh account, and the phone\'s runs go into it');

  // The words for the other refusals.
  check(accountMessage(new AccountError(429, 'too many codes', { wait: 40 })) === 'Too many tries. Try again in a minute.' && accountMessage(new AccountError(429, 'too many codes', { wait: 1700 })) === 'Too many tries. Try again in 29 minutes.' && accountMessage(new AccountError(400, 'wrong code', { left: 1 })) === 'That code is not right. One try left.' && accountMessage(new AccountError(410, 'the code has expired')) === 'This code no longer works. Ask for a new one.' && accountMessage(new AccountError(400, 'not an e-mail address')) === 'That does not look like an e-mail address.', 'each refusal has plain words for the runner');
}

console.log(failures ? `\n${failures} account test(s) FAILED` : '\nAll account tests passed');
process.exit(failures ? 1 : 0);
