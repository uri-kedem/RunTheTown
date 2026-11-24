// Accounts: an optional sign-in that keeps a runner's profile and run journal on our own
// server, so they are backed up and follow the runner to a new phone and to the website.
// The app works without one ("Continue as a guest"); nothing here is asked of a guest.
//
// Three ways in, and no password anywhere:
//   - e-mail: we send a six-digit code to the address and the runner types it back;
//   - Google and Apple: the phone hands us the signed note ("ID token") those services
//     give it, and we check the signature against their published keys.
// All three end the same way: a row in `users`, and a long random key for that phone
// (a "session"), of which only a hash is stored. The same proved e-mail address always
// leads to the same account, whichever of the three ways proved it.
//
// Routes (JSON in, JSON out; all but the first five need `Authorization: Bearer <key>`):
//   GET    /account/ways                                         which ways in are switched on
//   POST   /account/email/start    {email, lang}                 sends the code
//   POST   /account/email/verify   {email, code, device}         -> {token, account, profile}
//   POST   /account/google         {credential, device}          -> the same
//   POST   /account/apple          {identityToken, name, device} -> the same
//   GET    /account                                              the account and its profile
//   PUT    /account/profile        {profile, updated}            the newer of the two is kept
//   GET    /account/runs                                         every run's id (and whether it was deleted)
//   GET    /account/runs/<id>      PUT {run}      DELETE         one run
//   POST   /account/signout                                      forgets this phone's key
//   DELETE /account                                              deletes the account and everything in it
//
// Settings (wrangler.toml / secrets): DB (the D1 database, schema.sql); MAIL_FROM and the
// mail service's key (see sendMail) for the e-mail way; GOOGLE_WEB_CLIENT_ID (the website)
// and GOOGLE_IOS_CLIENT_ID (the iPhone app) for Google; APPLE_APP_ID (the iPhone app's
// bundle id) and APPLE_SERVICES_ID (the website) for Apple. A way in whose setting is
// missing answers 503, and /account/ways tells the app not to offer it: a way is switched
// on here, with no new version of the app.

const CODE_MINUTES = 10; // how long a code works
const CODE_TRIES = 5; // wrong guesses before the code is thrown away
const SESSION_IDLE_DAYS = 400; // a phone not seen for this long is signed out
const MAX_RUNS = 5000; // per account
const MAX_RUN_BYTES = 400 * 1024;
const MAX_PROFILE_BYTES = 400 * 1024; // two small JPEGs as data URLs and a name
const GOOGLE = { keys: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] };
const APPLE = { keys: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] };

/** An answer with a status the app can act on: thrown anywhere below, turned into JSON by `accounts`. */
class Refusal extends Error {
  constructor(status, error, extra = {}) { super(error); this.status = status; this.extra = extra; }
}
const refuse = (status, error, extra) => { throw new Refusal(status, error, extra); };

/**
 * Every /account route. `json(body, status)` builds the answer (the worker passes its own,
 * with the CORS headers); `env.now()` is the clock, replaceable in the tests.
 */
export async function accounts(request, env, url, json) {
  const now = () => (env.now ? env.now() : Date.now());
  try {
    const path = url.pathname.replace(/\/+$/, '');
    const m = request.method;
    if (m === 'GET' && path === '/account/ways') return json(ways(env));
    if (!env.DB) refuse(503, 'accounts are not set up');
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (m === 'POST' && path === '/account/email/start') return json(await emailStart(env, await body(request, 2000), ip, now()));
    if (m === 'POST' && path === '/account/email/verify') return json(await emailVerify(env, await body(request, 2000), ip, now()));
    if (m === 'POST' && path === '/account/google') return json(await withToken(env, 'google', await body(request, 8000), ip, now()));
    if (m === 'POST' && path === '/account/apple') return json(await withToken(env, 'apple', await body(request, 8000), ip, now()));
    // Everything below is the runner's own data: the phone's key says whose.
    const session = await sessionOf(env, request, now());
    const user = session.user;
    if (m === 'GET' && path === '/account') return json(await describe(env, user));
    if (m === 'PUT' && path === '/account/profile') return json(await putProfile(env, user, await body(request, MAX_PROFILE_BYTES + 2000), now()));
    if (m === 'GET' && path === '/account/runs') return json(await listRuns(env, user));
    const run = path.match(/^\/account\/runs\/([^/]+)$/);
    if (run) {
      const id = runId(decodeURIComponent(run[1]));
      if (m === 'GET') return json(await getRun(env, user, id));
      if (m === 'PUT') return json(await putRun(env, user, id, await body(request, MAX_RUN_BYTES + 2000), now()));
      if (m === 'DELETE') return json(await deleteRun(env, user, id, now()));
    }
    if (m === 'POST' && path === '/account/signout') { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.hash).run(); return json({ ok: true }); }
    if (m === 'DELETE' && path === '/account') return json(await deleteAccount(env, user));
    refuse(404, 'no such route');
  } catch (err) {
    if (err instanceof Refusal) return json({ error: err.message, ...err.extra }, err.status);
    return json({ error: 'the account server failed' }, 500); // what went wrong stays in the server's log
  }
}

// What the app may offer on its welcome page. The ids are public: they are what the app
// hands to Google and Apple to say which app is asking.
const list = (...values) => values.map((v) => String(v || '').trim()).filter(Boolean);
function ways(env) {
  const on = !!env.DB;
  return {
    email: on && mailReady(env),
    google: on && list(env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID).length ? { web: list(env.GOOGLE_WEB_CLIENT_ID)[0] || null, ios: list(env.GOOGLE_IOS_CLIENT_ID)[0] || null } : null,
    apple: on && list(env.APPLE_APP_ID, env.APPLE_SERVICES_ID).length ? { app: !!list(env.APPLE_APP_ID).length, web: list(env.APPLE_SERVICES_ID)[0] || null } : null,
  };
}

// ---- Reading what the app sent ----

async function body(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) refuse(413, 'too large');
  try {
    const v = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* refused below */ }
  refuse(400, 'not JSON');
}

// An address as people type it: spaces around it, capitals in it. One spelling per person.
function emailOf(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]{2,}$/.test(email)) refuse(400, 'not an e-mail address');
  return email;
}

// A run's id is made by the app: the time it started and a few random letters.
function runId(value) {
  if (!/^[\w:.+-]{6,80}$/.test(value)) refuse(400, 'bad run id');
  return value;
}

// ---- Small tools ----

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomKey = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

// Six digits, each as likely as the next: numbers are drawn until one falls below the
// largest multiple of a million (taking the remainder of any number would favour some codes).
function randomCode() {
  const top = Math.floor(0x100000000 / 1000000) * 1000000;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < top) return String(n % 1000000).padStart(6, '0');
  }
}

// Two hashes compared without stopping at the first difference, so the time taken says
// nothing about how much of a guess was right.
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * At most `max` of something per `seconds`, counted in the database (the Worker itself
 * remembers nothing between requests). Returns how many seconds to wait when over the limit,
 * else 0.
 */
async function overLimit(env, key, max, seconds, now) {
  const row = await env.DB.prepare(
    `INSERT INTO limits (key, start, n) VALUES (?1, ?2, 1)
     ON CONFLICT (key) DO UPDATE SET n = CASE WHEN start + ?3 <= ?2 THEN 1 ELSE n + 1 END, start = CASE WHEN start + ?3 <= ?2 THEN ?2 ELSE start END
     RETURNING start, n`
  ).bind(key, now, seconds * 1000).first();
  return row.n > max ? Math.max(1, Math.ceil((row.start + seconds * 1000 - now) / 1000)) : 0;
}

// ---- E-mail: a code sent, a code typed back ----

async function emailStart(env, { email: raw, lang }, ip, now) {
  const email = emailOf(raw);
  if (!mailReady(env)) refuse(503, 'e-mail sign-in is not set up');
  // One code a minute and six an hour to an address (nobody's inbox is flooded through
  // us), and thirty an hour from one network.
  const wait = (await overLimit(env, `mail-minute:${email}`, 1, 60, now)) || (await overLimit(env, `mail-hour:${email}`, 6, 3600, now)) || (await overLimit(env, `mail-ip:${ip}`, 30, 3600, now));
  if (wait) refuse(429, 'too many codes', { wait });
  // Now and then (about one request in twenty) what has run out is cleared away: old
  // counters, codes nobody typed, phones long signed out by time.
  if (crypto.getRandomValues(new Uint8Array(1))[0] < 13) await tidy(env, now);
  const code = randomCode();
  await env.DB.prepare('INSERT INTO codes (email, code_hash, expires, attempts, sent) VALUES (?1, ?2, ?3, 0, ?4) ON CONFLICT (email) DO UPDATE SET code_hash = ?2, expires = ?3, attempts = 0, sent = ?4')
    .bind(email, await sha256(`${email}:${code}`), now + CODE_MINUTES * 60000, now).run();
  await sendMail(env, email, codeMail(code, lang));
  return { ok: true, minutes: CODE_MINUTES };
}

async function tidy(env, now) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM limits WHERE start < ?').bind(now - 86400000),
    env.DB.prepare('DELETE FROM codes WHERE expires < ?').bind(now - 86400000),
    env.DB.prepare('DELETE FROM sessions WHERE last_used < ?').bind(now - SESSION_IDLE_DAYS * 86400000),
  ]);
}

async function emailVerify(env, { email: raw, code: typed, device }, ip, now) {
  const email = emailOf(raw);
  const code = String(typed || '').replace(/\D/g, '');
  const wait = await overLimit(env, `guess-ip:${ip}`, 40, 3600, now);
  if (wait) refuse(429, 'too many tries', { wait });
  const row = await env.DB.prepare('SELECT code_hash, expires, attempts FROM codes WHERE email = ?').bind(email).first();
  if (!row || row.expires < now) refuse(410, 'the code has expired');
  if (row.attempts >= CODE_TRIES) refuse(410, 'too many wrong codes');
  if (code.length !== 6 || !same(row.code_hash, await sha256(`${email}:${code}`))) {
    await env.DB.prepare('UPDATE codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    const left = CODE_TRIES - row.attempts - 1;
    refuse(left > 0 ? 400 : 410, left > 0 ? 'wrong code' : 'too many wrong codes', { left });
  }
  await env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(email).run(); // a code works once
  return signIn(env, { email }, device, now);
}

// The message with the code, in the app's language. Kept plain: a code, what it is for,
// how long it works, and what to do if the reader never asked for it.
function codeMail(code, lang) {
  if (lang === 'he') {
    return {
      subject: `${code} הוא קוד הכניסה שלך אל RunTheTown`,
      text: `קוד הכניסה שלך אל RunTheTown הוא ${code}\n\nהקוד תקף למשך ${CODE_MINUTES} דקות. אם לא ביקשת אותו, אפשר להתעלם מההודעה הזאת.`,
    };
  }
  return {
    subject: `${code} is your RunTheTown sign-in code`,
    text: `Your RunTheTown sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this message.`,
  };
}

const mailReady = (env) => !!(env.sendMail || (env.MAIL_FROM && env.RESEND_API_KEY));

/**
 * Sends one plain-text message. `env.sendMail` stands in for the mail service in the tests.
 * The service is Resend (an HTTPS call, no library): MAIL_FROM is the sender, for example
 * "RunTheTown <signin@example.org>", on a domain that service has verified.
 */
async function sendMail(env, to, { subject, text }) {
  if (env.sendMail) return env.sendMail(to, { subject, text });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
  }).catch(() => null);
  if (!res?.ok) refuse(502, 'the code could not be sent');
}

// ---- Google and Apple: a signed note instead of a code ----

async function withToken(env, who, { credential, identityToken, name, device }, ip, now) {
  const wait = await overLimit(env, `token-ip:${ip}`, 60, 3600, now);
  if (wait) refuse(429, 'too many tries', { wait });
  const provider = who === 'google' ? GOOGLE : APPLE;
  const audiences = who === 'google' ? list(env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID) : list(env.APPLE_APP_ID, env.APPLE_SERVICES_ID);
  if (!audiences.length) refuse(503, `${who} sign-in is not set up`);
  const claims = await verifyIdToken(String((who === 'google' ? credential : identityToken) || ''), provider, audiences, now);
  // Both services say whether the address is one the person proved to them (Apple writes
  // it as a word, Google as true or false). Google adds that its word settles who owns an
  // address only for Gmail addresses and for an organisation's own Google accounts (`hd`).
  // An address that is not settled never joins this sign-in to an existing account: the
  // account is then found by the service's own id for the person alone.
  const verified = !!claims.email && (claims.email_verified === true || claims.email_verified === 'true');
  const proved = verified && (who === 'apple' || /@gmail\.com$/i.test(claims.email) || !!claims.hd);
  const email = proved ? emailOf(claims.email) : null;
  // Apple gives the name to the phone, once, and not in the note; Google writes it in the note.
  const given = String((who === 'google' ? claims.name : name) || '').trim().slice(0, 80);
  return signIn(env, { email, [`${who}_sub`]: String(claims.sub) }, device, now, given);
}

// The services' public keys, kept for an hour: they change a few times a year.
const keyCache = new Map();
async function keysOf(url, now) {
  const hit = keyCache.get(url);
  if (hit && hit.until > now) return hit.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
  if (!res?.ok) { if (hit) return hit.keys; refuse(502, 'the sign-in service did not answer'); }
  const keys = (await res.json()).keys || [];
  keyCache.set(url, { keys, until: now + 3600000 });
  return keys;
}

/**
 * Checks a Google or Apple ID token (a JWT signed with RS256) and returns what it says.
 * Checked: the signature, against the key the note names; who issued it; that it was
 * written for our app (`aud`); and that it has not run out.
 */
export async function verifyIdToken(token, provider, audiences, now) {
  const parts = token.split('.');
  if (parts.length !== 3) refuse(401, 'not a sign-in token');
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch { refuse(401, 'not a sign-in token'); }
  if (header.alg !== 'RS256') refuse(401, 'not a sign-in token');
  let jwk = (await keysOf(provider.keys, now)).find((k) => k.kid === header.kid);
  if (!jwk) { keyCache.delete(provider.keys); jwk = (await keysOf(provider.keys, now)).find((k) => k.kid === header.kid); } // a key newer than our copy
  if (!jwk) refuse(401, 'signed with an unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!good) refuse(401, 'the signature is wrong');
  if (!provider.issuers.includes(claims.iss)) refuse(401, 'issued by someone else');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => audiences.includes(a))) refuse(401, 'written for another app');
  if (!claims.sub || !(claims.exp * 1000 > now - 60000)) refuse(401, 'the sign-in has run out');
  return claims;
}

// ---- The account behind any of the three ways in ----

/**
 * Finds the account for a proved identity, or opens one, and gives this phone its key.
 * `who` has `email` (proved, or null) and at most one of `google_sub` / `apple_sub`.
 */
async function signIn(env, who, device, now, givenName = '') {
  const sub = who.google_sub ? ['google_sub', who.google_sub] : who.apple_sub ? ['apple_sub', who.apple_sub] : null;
  let user = sub ? await env.DB.prepare(`SELECT * FROM users WHERE ${sub[0]} = ?`).bind(sub[1]).first() : null;
  if (!user && who.email) user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(who.email).first();
  let isNew = false;
  if (!user) {
    isNew = true;
    user = { id: randomKey(12), email: who.email, google_sub: who.google_sub || null, apple_sub: who.apple_sub || null, created: now, profile: null, profile_updated: 0 };
    await env.DB.prepare('INSERT INTO users (id, email, google_sub, apple_sub, created, profile, profile_updated) VALUES (?, ?, ?, ?, ?, NULL, 0)').bind(user.id, user.email, user.google_sub, user.apple_sub, now).run();
  } else if (sub && !user[sub[0]]) {
    // The account was opened another way (with a code, say) under the same proved address:
    // from now on this service's id finds it too.
    await env.DB.prepare(`UPDATE users SET ${sub[0]} = ? WHERE id = ?`).bind(sub[1], user.id).run();
    user[sub[0]] = sub[1];
  }
  const token = randomKey(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created, last_used, device) VALUES (?, ?, ?, ?, ?)').bind(await sha256(token), user.id, now, now, String(device || '').slice(0, 60)).run();
  return { token, isNew, givenName, ...(await describe(env, user)) };
}

// Whose request this is, from the key in its Authorization header.
async function sessionOf(env, request, now) {
  const token = (request.headers.get('Authorization') || '').match(/^Bearer\s+([\w-]{20,})$/)?.[1];
  if (!token) refuse(401, 'not signed in');
  const hash = await sha256(token);
  const row = await env.DB.prepare('SELECT s.last_used, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(hash).first();
  if (!row || row.last_used < now - SESSION_IDLE_DAYS * 86400000) refuse(401, 'not signed in');
  // Noted once a day at most: when this phone was last seen.
  if (now - row.last_used > 86400000) await env.DB.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').bind(now, hash).run();
  return { hash, user: row };
}

async function describe(env, user) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND deleted = 0').bind(user.id).first();
  return {
    account: { id: user.id, email: user.email || null, created: user.created, google: !!user.google_sub, apple: !!user.apple_sub, runs: count?.n || 0 },
    profile: user.profile ? JSON.parse(user.profile) : null,
    profileUpdated: user.profile_updated || 0,
  };
}

// ---- The profile and the runs ----

// Two phones may both have changed the profile: the later change is kept, and the answer
// says which that was, so the phone that lost takes the other's.
async function putProfile(env, user, { profile, updated }, now) {
  if (!profile || typeof profile !== 'object') refuse(400, 'no profile');
  const dataUrl = (v) => (typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null);
  const slim = { name: String(profile.name || '').trim().slice(0, 80), photo: dataUrl(profile.photo), photoFull: dataUrl(profile.photoFull), since: typeof profile.since === 'string' ? profile.since.slice(0, 40) : null };
  const text = JSON.stringify(slim);
  if (text.length > MAX_PROFILE_BYTES) refuse(413, 'too large');
  const when = Math.min(Number.isFinite(+updated) && +updated > 0 ? +updated : now, now); // a phone's clock may run ahead
  if (when >= (user.profile_updated || 0)) {
    await env.DB.prepare('UPDATE users SET profile = ?, profile_updated = ? WHERE id = ?').bind(text, when, user.id).run();
    return { profile: slim, profileUpdated: when };
  }
  return { profile: user.profile ? JSON.parse(user.profile) : null, profileUpdated: user.profile_updated };
}

async function listRuns(env, user) {
  const rows = await env.DB.prepare('SELECT id, updated, deleted FROM runs WHERE user_id = ?').bind(user.id).all();
  return { runs: (rows.results || []).map((r) => ({ id: r.id, updated: r.updated, deleted: !!r.deleted })) };
}

async function getRun(env, user, id) {
  const row = await env.DB.prepare('SELECT body, deleted FROM runs WHERE user_id = ? AND id = ?').bind(user.id, id).first();
  if (!row || row.deleted || !row.body) refuse(404, 'no such run');
  return { run: JSON.parse(row.body) };
}

async function putRun(env, user, id, { run }, now) {
  if (!run || typeof run !== 'object' || run.id !== id) refuse(400, 'no run');
  // The map picture is drawn by each phone from the map; it is the bulk of a run and is not kept here.
  const text = JSON.stringify({ ...run, picture: null });
  if (text.length > MAX_RUN_BYTES) refuse(413, 'too large');
  const have = await env.DB.prepare('SELECT deleted FROM runs WHERE user_id = ? AND id = ?').bind(user.id, id).first();
  if (have?.deleted) return { id, deleted: true }; // deleted on another phone: it is not brought back
  if (!have) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ?').bind(user.id).first();
    if ((count?.n || 0) >= MAX_RUNS) refuse(507, 'the journal is full');
  }
  await env.DB.prepare('INSERT INTO runs (user_id, id, time, updated, deleted, body) VALUES (?1, ?2, ?3, ?4, 0, ?5) ON CONFLICT (user_id, id) DO UPDATE SET time = ?3, updated = ?4, body = ?5')
    .bind(user.id, id, typeof run.time === 'string' ? run.time.slice(0, 40) : null, now, text).run();
  return { id, updated: now };
}

async function deleteRun(env, user, id, now) {
  await env.DB.prepare('INSERT INTO runs (user_id, id, time, updated, deleted, body) VALUES (?1, ?2, NULL, ?3, 1, NULL) ON CONFLICT (user_id, id) DO UPDATE SET updated = ?3, deleted = 1, body = NULL')
    .bind(user.id, id, now).run();
  return { id, deleted: true };
}

// Everything the account holds, at once: the runs, every phone's key, any code on its way,
// and the account itself. Nothing is kept back.
async function deleteAccount(env, user) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM runs WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM codes WHERE email = ?').bind(user.email || ''),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return { ok: true, deleted: true };
}
