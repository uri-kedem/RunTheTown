// The optional account: signing in, and keeping the profile and the run journal on our
// server (server/accounts.js) as well as on the phone.
//
// A guest has no account and nothing here runs for them: the profile and the journal stay
// on the phone, as they always have. A signed-in runner's phone still holds everything and
// works with no network; the server holds a second copy, so the journal survives a lost
// phone and appears on the runner's other phone and on the website. Settings and routes
// downloaded for later are not part of the account: they stay on the phone (Uri's decision).
//
// What is on the phone (localStorage):
//   rtt-account  the phone's key and whose account it is
//   rtt-sync     what has already been exchanged with that account: which runs it has,
//                which runs deleted here it has yet to be told about, when the profile was
//                last changed here
//   rtt-ways     which ways of signing in the server offers (asked once a day)

import { PROXY } from './services.js';
import { loadProfile, saveProfile, journal } from './journal.js';

const ACCOUNT_KEY = 'rtt-account';
const SYNC_KEY = 'rtt-sync';
const WAYS_KEY = 'rtt-ways';
const WAYS_FRESH_MS = 24 * 3600 * 1000;
const NO_WAYS = Object.freeze({ email: false, google: null, apple: null });

/** What the server (or the lack of a connection: status 0) said when it refused. */
export class AccountError extends Error {
  constructor(status, reason, more = {}) { super(reason); this.status = status; this.reason = reason; this.wait = more.wait || 0; this.left = more.left; }
}

/**
 * The words for a refusal, for the runner. Written here, in one place, so the sign-in
 * page and the profile page say the same thing (and the Hebrew table has one set to carry).
 */
export function accountMessage(err) {
  const reason = err?.reason || '';
  if (!err || err.status === 0) return 'No connection. Try again when you are online.';
  if (reason === 'not an e-mail address') return 'That does not look like an e-mail address.';
  if (err.status === 429) return err.wait > 90 ? `Too many tries. Try again in ${Math.ceil(err.wait / 60)} minutes.` : 'Too many tries. Try again in a minute.';
  if (reason === 'wrong code') return err.left === 1 ? 'That code is not right. One try left.' : `That code is not right. ${err.left} tries left.`;
  if (err.status === 410) return 'This code no longer works. Ask for a new one.';
  if (reason === 'the code could not be sent') return 'The code could not be sent. Try again in a minute.';
  if (err.status === 503) return 'This way of signing in is not available right now.';
  return 'Something went wrong. Please try again.';
}

export class Account {
  /**
   * Everything the account touches can be handed in (the tests do): the server's address,
   * the storage, `fetch`, the journal, the clock.
   */
  constructor({ server = PROXY, storage = globalThis.localStorage, fetch = (...a) => globalThis.fetch(...a), runs = journal, now = () => Date.now(), device = '' } = {}) {
    this.server = server;
    this.storage = storage;
    this.fetch = fetch;
    this.runs = runs;
    this.now = now;
    this.device = device;
    this.onChange = () => {}; // signed in or out, or a sync brought something: the page redraws
    this.syncing = null;
    this.again = false;
  }

  // ---- What the phone remembers ----

  read(key, fallback) {
    try { const v = JSON.parse(this.storage?.getItem(key) || 'null'); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
  }
  write(key, value) {
    try { if (value == null) this.storage?.removeItem(key); else this.storage?.setItem(key, JSON.stringify(value)); } catch { /* storage full: the next sync finds its way again */ }
  }
  /** Whose account this phone is signed in to: {id, email, google, apple}, or null for a guest. */
  get who() { const a = this.read(ACCOUNT_KEY, null); return a?.token ? { id: a.id, email: a.email, google: !!a.google, apple: !!a.apple } : null; }
  get signedIn() { return !!this.who; }
  get token() { return this.read(ACCOUNT_KEY, null)?.token || ''; }
  state() { const s = this.read(SYNC_KEY, {}); return { id: s.id || null, synced: s.synced || {}, foreign: s.foreign || {}, deletes: s.deletes || [], profileAt: s.profileAt || 0, profileForeign: !!s.profileForeign, last: s.last || 0 }; }

  // ---- Talking to the server ----

  async api(method, path, body, { auth = true } = {}) {
    if (!this.server) throw new AccountError(503, 'accounts are not set up');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await this.fetch(`${this.server}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: globalThis.AbortSignal?.timeout ? AbortSignal.timeout(25000) : undefined });
    } catch {
      throw new AccountError(0, 'offline');
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // The server no longer knows this phone's key (signed out everywhere, or the account
    // was deleted from another phone): the phone becomes a guest again, with its runs.
    if (res.status === 401 && auth) this.forget();
    throw new AccountError(res.status, data.error || 'failed', data);
  }

  /**
   * Which ways of signing in to offer: {email, google: {web, ios} | null, apple: {app, web} | null}.
   * Asked of the server at most once a day; with no answer, the last one known (none, the
   * first time: the app then simply has no sign-in, as before there were accounts).
   */
  async ways({ fresh = false } = {}) {
    const kept = this.read(WAYS_KEY, null);
    if (kept && !fresh && this.now() - kept.at < WAYS_FRESH_MS) return kept.ways;
    try {
      const ways = await this.api('GET', '/account/ways', undefined, { auth: false });
      const clean = { email: !!ways.email, google: ways.google || null, apple: ways.apple || null };
      this.write(WAYS_KEY, { at: this.now(), ways: clean });
      return clean;
    } catch {
      return kept?.ways || NO_WAYS;
    }
  }

  // ---- Signing in and out ----

  emailStart(email, lang) { return this.api('POST', '/account/email/start', { email, lang }, { auth: false }); }
  async emailVerify(email, code) { return this.arrive(await this.api('POST', '/account/email/verify', { email, code, device: this.device }, { auth: false })); }
  async withGoogle(credential) { return this.arrive(await this.api('POST', '/account/google', { credential, device: this.device }, { auth: false })); }
  async withApple(identityToken, name) { return this.arrive(await this.api('POST', '/account/apple', { identityToken, name, device: this.device }, { auth: false })); }

  // Signed in: the key is kept, and what this phone exchanged with ANOTHER account before
  // (somebody else's runs, on a shared phone) is set aside so it is not handed to this one.
  arrive(answer) {
    const a = answer.account;
    this.write(ACCOUNT_KEY, { token: answer.token, id: a.id, email: a.email, google: a.google, apple: a.apple });
    const s = this.state();
    if (s.id && s.id !== a.id) this.write(SYNC_KEY, { id: a.id, synced: {}, foreign: { ...s.foreign, ...s.synced }, deletes: [], profileAt: 0, profileForeign: true, last: 0 });
    else this.write(SYNC_KEY, { ...s, id: a.id });
    this.onChange();
    return { isNew: !!answer.isNew, givenName: answer.givenName || '', email: a.email };
  }

  // The phone forgets its key. The runs and the profile stay on the phone.
  forget() {
    if (!this.read(ACCOUNT_KEY, null)) return;
    this.write(ACCOUNT_KEY, null);
    this.onChange();
  }

  async signOut() {
    try { await this.api('POST', '/account/signout'); } catch { /* offline: the phone forgets the key all the same */ }
    this.forget();
  }

  /** Deletes the account and everything in it from the server. What is on the phone stays. */
  async deleteAccount() {
    await this.api('DELETE', '/account');
    this.write(SYNC_KEY, null);
    this.forget();
  }

  // ---- Keeping the two copies the same ----

  /** The profile was changed on this phone: remembered with the time, and sent. */
  profileChanged() {
    const s = this.state();
    this.write(SYNC_KEY, { ...s, profileAt: this.now(), profileForeign: false });
    return this.sync();
  }
  /** A run was saved on this phone. */
  runSaved() { return this.sync(); }
  /** A run was deleted on this phone: the account is told (now, or when next online and signed in). */
  runDeleted(id) {
    const s = this.state();
    if (s.synced[id]) {
      delete s.synced[id];
      this.write(SYNC_KEY, { ...s, deletes: [...new Set([...s.deletes, id])] });
    }
    return this.sync();
  }

  /**
   * Brings the phone and the account level with each other; safe to call at any time and
   * as often as one likes (calls made while one is running are folded into one more run).
   * Never throws: with no connection it does nothing and the next call tries again.
   * Returns what changed on the phone: {down, removed, profile}, or null when nothing ran.
   */
  sync() {
    if (!this.signedIn) return Promise.resolve(null);
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      let total = null;
      do {
        this.again = false;
        let got = null;
        try { got = await this.syncOnce(); } catch { /* no connection, or signed out meanwhile */ }
        if (got) total = { down: (total?.down || 0) + got.down, removed: (total?.removed || 0) + got.removed, profile: !!(total?.profile || got.profile) };
      } while (this.again && this.signedIn);
      this.syncing = null;
      if (total && (total.down || total.removed || total.profile)) this.onChange();
      return total;
    })();
    return this.syncing;
  }

  async syncOnce() {
    const who = this.who;
    const changed = { down: 0, removed: 0, profile: false };

    // The profile: whichever copy was changed last is the profile.
    const remote = await this.api('GET', '/account');
    let s = this.state();
    const local = loadProfile(this.storage);
    const hasLocal = !!local?.name && !s.profileForeign;
    // A profile made before the phone kept the time of its changes dates from its "since".
    const localAt = hasLocal ? s.profileAt || Date.parse(local.since || '') || 1 : 0;
    if (hasLocal && localAt > (remote.profileUpdated || 0)) {
      const kept = await this.api('PUT', '/account/profile', { profile: { name: local.name, photo: local.photo, photoFull: local.photoFull, since: local.since }, updated: localAt });
      s = { ...this.state(), profileAt: kept.profileUpdated };
      this.write(SYNC_KEY, s);
    } else if (remote.profile?.name && (remote.profileUpdated > localAt || !hasLocal)) {
      saveProfile({ ...remote.profile, skipped: false }, this.storage);
      s = { ...this.state(), profileAt: remote.profileUpdated, profileForeign: false };
      this.write(SYNC_KEY, s);
      changed.profile = true;
    }

    // The runs. The account lists what it has; the phone lists what it has.
    const index = (await this.api('GET', '/account/runs')).runs || [];
    const there = new Map(index.map((r) => [r.id, r]));
    const here = new Set((await this.runs.list()).map((r) => r.id));
    const note = (fn) => { const st = this.state(); fn(st); this.write(SYNC_KEY, st); };

    // Runs deleted here since the account last heard from this phone.
    for (const id of this.state().deletes) {
      if (this.who?.id !== who.id) return changed;
      await this.api('DELETE', `/account/runs/${encodeURIComponent(id)}`);
      note((st) => { st.deletes = st.deletes.filter((d) => d !== id); });
      there.set(id, { id, deleted: true });
    }
    // Runs deleted on another phone: deleted here too.
    for (const r of index) {
      if (r.deleted && here.has(r.id)) {
        await this.runs.remove(r.id);
        here.delete(r.id);
        note((st) => { delete st.synced[r.id]; });
        changed.removed++;
      }
    }
    // Runs the account does not have: sent (never another account's, on a shared phone).
    for (const id of here) {
      if (this.who?.id !== who.id) return changed;
      if (there.has(id)) { if (!this.state().synced[id]) note((st) => { st.synced[id] = 1; }); continue; }
      if (this.state().foreign[id]) continue;
      const run = await this.runs.get(id);
      if (!run) continue;
      let answer;
      try {
        answer = await this.api('PUT', `/account/runs/${encodeURIComponent(id)}`, { run: { ...run, picture: null } });
      } catch (err) {
        if (err.status === 413 || err.status === 400 || err.status === 507) continue; // this one run cannot be kept there; the rest still can
        throw err;
      }
      if (answer.deleted) { await this.runs.remove(id); changed.removed++; } else note((st) => { st.synced[id] = 1; });
    }
    // Runs the phone does not have: fetched. They arrive without a map picture; the page
    // draws one when the run is first looked at.
    for (const r of index) {
      if (this.who?.id !== who.id) return changed;
      if (r.deleted || here.has(r.id) || there.get(r.id)?.deleted) continue;
      let got;
      try { got = await this.api('GET', `/account/runs/${encodeURIComponent(r.id)}`); } catch (err) { if (err.status === 404) continue; throw err; }
      if (got.run?.id === r.id) {
        await this.runs.save({ ...got.run, picture: null });
        note((st) => { st.synced[r.id] = 1; });
        changed.down++;
      }
    }
    note((st) => { st.last = this.now(); });
    return changed;
  }
}
