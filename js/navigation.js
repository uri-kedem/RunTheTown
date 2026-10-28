// Live run guidance: follows the runner's GPS along the chosen route and
// decides what to say and show: turn instructions ahead of each junction,
// off-route warnings, kilometer splits with pace, and sights coming up.
//
// Navigator is pure logic (fixes in, announcements out) so it can be tested
// with simulated GPS. Voice, ScreenLock, GpsSource and SimulatedRun wrap the
// browser APIs.

import { makeProjection } from './geo.js';

const PRE_MAX = 200; // announce a turn this far ahead (m)...
const PRE_MIN = 60; // ...unless it's already this close, then wait for "now"
const NOW_M = 30; // "turn left" when this close
const THEN_M = 70; // a second turn this soon after the first is chained: ", then …"
const OFF_M = 40; // further than this from the route = off route
const BACK_M = 25; // back within this = on route again
const OFF_FIXES = 2; // consecutive far fixes before warning
const OFF_REPEAT_MS = 45000; // repeat the off-route hint at most this often
const SIGHT_AHEAD = 80; // call out a sight this far before passing it
const ARRIVE_M = 30;
const MAX_ACCURACY = 60; // ignore GPS fixes worse than this (m)
const WINDOW_BACK = 60; // search the route this far behind current progress...
const WINDOW_AHEAD = 400; // ...and this far ahead (stops jumping to a parallel leg)

const HEBREW = /[֐-׿]/;
const NAV_COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function roundDist(m) {
  if (m < 100) return Math.max(10, Math.round(m / 10) * 10);
  if (m < 1000) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}
export function distText(m) {
  const r = roundDist(m);
  return r >= 1000 ? `${(r / 1000).toFixed(1).replace(/\.0$/, '')} kilometers` : `${r} meters`;
}
export function paceText(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s ? `${m} minutes ${s} seconds per kilometer` : `${m} minutes per kilometer`;
}
export function paceShort(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '–:––';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s === 60 ? 59 : s).padStart(2, '0')}`;
}

// A spoken message is a list of parts so that a Hebrew-only street name can
// be read by a Hebrew voice in the middle of an English sentence.
const part = (text) => ({ text, lang: HEBREW.test(text) ? 'he' : 'en' });
const msg = (...bits) => bits.filter(Boolean).map((b) => (typeof b === 'string' ? part(b) : b));

/** Short instruction for a cue: { verb: 'Turn left', street } */
export function cueAction(c) {
  if (c.type === 'turn' && !c.dir && c.text) return c.text; // spoken in words: "Onto the track"
  switch (c.type) {
    case 'lap': return `Lap ${c.lap} of ${c.laps}`;
    case 'uturn': return 'Turn around';
    case 'arrive': return 'Finish';
    case 'depart': return `Head ${c.compass}`;
    case 'slight': return `Bear ${c.dir}`;
    case 'sharp': return `Sharp ${c.dir}`;
    default: return `Turn ${c.dir}`;
  }
}

function cueSpeech(c, { ahead = null } = {}) {
  const lead = ahead != null ? `In ${distText(ahead)}, ` : '';
  const onto = c.street ? [' onto ', c.street] : [];
  if (c.type === 'turn' && !c.dir && c.text) return msg(ahead != null ? `${lead}${c.text[0].toLowerCase()}${c.text.slice(1)}` : c.text);
  switch (c.type) {
    case 'lap': return msg(`Lap ${c.lap} of ${c.laps}.`);
    case 'uturn': return msg(`${lead}${ahead != null ? 'turn around' : 'Turn around and head back the same way'}`);
    case 'arrive': return msg(ahead != null ? `In ${distText(ahead)}, you'll be back at the start` : 'You have arrived back at the start');
    case 'slight': return msg(`${lead}${ahead != null ? 'b' : 'B'}ear ${c.dir}`, ...onto);
    case 'sharp': return msg(`${lead}${ahead != null ? 'm' : 'M'}ake a sharp ${c.dir}`, ...onto);
    default: return msg(`${lead}${ahead != null ? 't' : 'T'}urn ${c.dir}`, ...onto);
  }
}
const lower = (parts) => parts.map((p, i) => (i === 0 ? { ...p, text: p.text[0].toLowerCase() + p.text.slice(1) } : p));

/**
 * Follows one route. Feed it fixes with update(); it returns the current view
 * (for the screen) and pushes spoken messages to opts.speak(parts, {priority}).
 */
export class Navigator {
  constructor(route, { speak = () => {}, now = () => Date.now() } = {}) {
    this.route = route;
    this.speak = speak;
    this.now = now;
    const pts = route.latlngs;
    this.proj = makeProjection(pts[0][0], pts[0][1]);
    this.xy = pts.map(([la, lo]) => this.proj.toXY(la, lo));
    this.along = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      this.along[i] = this.along[i - 1] + Math.hypot(this.xy[i][0] - this.xy[i - 1][0], this.xy[i][1] - this.xy[i - 1][1]);
    }
    this.total = this.along[pts.length - 1];
    // Cues and sights, positioned on this polyline (their `at` came from the graph; same geometry).
    // Re-measure positions on this polyline so long routes don't drift.
    this.progress = 0; // meters along the route
    this.seg = 0; // segment index of progress
    this.cues = (route.cues || [])
      .filter((c) => c.type !== 'depart')
      .map((c) => ({ ...c, at: c.idx != null && c.idx < pts.length ? this.along[c.idx] : c.at, pre: false, now: false }));
    this.sights = (route.sights || []).map((s) => {
      const [x, y] = this.proj.toXY(s.lat, s.lon);
      return { ...s, at: this.snap(x, y, (s.at || 0) - 300, (s.at || 0) + 300, 0).at, said: false };
    });
    this.offRoute = false;
    this.farCount = 0;
    this.lastOffSaid = -Infinity;
    this.odometer = 0; // meters actually run (from GPS), for splits and pace
    this.anchor = null;
    this.moving = null; // heading of travel (deg), from recent movement
    this.nextSplit = 1000;
    this.lastSplit = { t: 0, odo: 0 };
    this.elapsed = 0; // ms, excluding pauses
    this.paused = false;
    this.started = false;
    this.finished = false;
  }

  start() {
    this.started = true;
    this.startT = this.now();
    this.lastTick = this.startT;
    const d = this.route.cues?.[0];
    this.speak(
      msg(
        `Starting your ${(this.total / 1000).toFixed(1)} kilometer run. `,
        d ? `Head ${d.compass}` : null,
        d?.street ? ' on ' : null,
        d?.street || null,
        '.'
      ),
      { priority: 2 }
    );
    return this.view();
  }

  pause() {
    this.tick();
    this.paused = true;
    this.speak(msg('Run paused.'), { priority: 2 });
  }
  resume() {
    this.paused = false;
    this.lastTick = this.now();
    this.anchor = null; // don't count the distance moved while paused
    this.speak(msg('Resuming.'), { priority: 2 });
  }
  tick() {
    const t = this.now();
    if (this.started && !this.paused && !this.finished) this.elapsed += t - this.lastTick;
    this.lastTick = t;
  }

  /** fix: { lat, lon, accuracy } */
  update(fix) {
    this.tick();
    if (!this.started || this.paused || this.finished) return this.view();
    if (fix.accuracy != null && fix.accuracy > MAX_ACCURACY) return this.view(fix);
    const [x, y] = this.proj.toXY(fix.lat, fix.lon);

    // Travel direction, from movement of at least 8 m (GPS jitter is ignored).
    if (!this.anchor) this.anchor = { x, y };
    const moved = Math.hypot(x - this.anchor.x, y - this.anchor.y);
    if (moved >= 8) {
      if (moved < 300) this.moving = (Math.atan2(x - this.anchor.x, y - this.anchor.y) * 180) / Math.PI;
      if (this.offRoute && moved < 300) this.odometer += moved; // off the route: count raw movement
      this.anchor = { x, y };
    }

    // Snap to the route near where we were; if lost, anywhere ahead.
    let snap = this.snap(x, y, this.progress - WINDOW_BACK, this.progress + WINDOW_AHEAD);
    if (snap.dist > OFF_M && this.offRoute) {
      // Rejoin anywhere the runner could plausibly have got to since leaving the route
      // (so crossing a later part of the loop while lost doesn't skip ahead).
      const ran = this.odometer - this.offOdo;
      const lostFor = this.now() - this.offSince;
      const reach = lostFor > 180000 ? Infinity : this.progress + ran * 1.5 + 300;
      const wide = this.snap(x, y, this.progress - 30, reach, 0.005);
      if (wide.dist < snap.dist - 20 && wide.dist <= BACK_M) snap = wide;
    }
    this.snapped = snap;

    if (snap.dist > OFF_M) {
      this.farCount++;
      if (this.farCount >= OFF_FIXES && (!this.offRoute || this.now() - this.lastOffSaid > OFF_REPEAT_MS)) {
        if (!this.offRoute) { this.offOdo = this.odometer; this.offSince = this.now(); }
        this.offRoute = true;
        this.lastOffSaid = this.now();
        this.speak(this.offRouteSpeech(x, y, snap), { priority: 3 });
      }
    } else {
      this.farCount = 0;
      if (this.offRoute && snap.dist <= BACK_M) {
        this.offRoute = false;
        this.rejoined = true; // the jump in progress was already counted as raw movement
        this.speak(msg('Back on route.'), { priority: 3 });
      }
      if (!this.offRoute) {
        // Progress only moves forward (GPS jitter backwards is ignored).
        if (snap.at > this.progress) {
          const gain = snap.at - this.progress;
          if (gain > 0 && gain < 300 && !this.rejoined) this.odometer += gain;
          this.rejoined = false; // on the route: measured along it (smooth)
          this.progress = snap.at;
          this.seg = snap.seg;
        }
      }
    }

    if (!this.offRoute && snap.dist <= OFF_M) {
      this.announceCues();
      this.announceSights();
    }
    this.announceSplit();
    if (!this.finished && this.total - this.progress <= ARRIVE_M && this.progress > this.total * 0.8) this.finish();
    return this.view(fix);
  }

  snap(x, y, from, to, k = 0.06) {
    let best = { cost: Infinity, dist: Infinity, at: this.progress, seg: this.seg, x, y };
    const n = this.xy.length;
    // Find the first segment in the window (binary search on `along`).
    let lo = 0, hi = n - 1;
    const a0 = Math.max(0, from);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.along[mid + 1] < a0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < n - 1 && this.along[i] <= to; i++) {
      const [ax, ay] = this.xy[i];
      const [bx, by] = this.xy[i + 1];
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const L = Math.sqrt(L2);
      // Clamp to the part of this segment inside the window [from, to].
      const t0 = L ? Math.max(0, (from - this.along[i]) / L) : 0;
      const t1 = L ? Math.min(1, (to - this.along[i]) / L) : 0;
      const t = L2 ? Math.max(t0, Math.min(t1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(x - px, y - py);
      const at = this.along[i] + t * L;
      // Where route legs overlap (out & back, crossings) prefer the nearest
      // point in running order, and segments heading the way the runner moves.
      let cost = d + k * Math.abs(at - this.progress);
      if (this.moving != null && L2 > 1) {
        const h = (Math.atan2(dx, dy) * 180) / Math.PI;
        if (Math.abs(((h - this.moving + 540) % 360) - 180) > 120) cost += 30;
      }
      if (cost < best.cost) best = { cost, dist: d, at, seg: i, x: px, y: py };
    }
    return best;
  }

  offRouteSpeech(x, y, snap) {
    const dx = snap.x - x, dy = snap.y - y;
    const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    const far = distText(snap.dist);
    const what = this.progress < 30 ? 'Head to the start of the route. It' : "You're off the route. It";
    if (this.moving != null) {
      const rel = ((bearing - this.moving + 540) % 360) - 180; // + = right
      const a = Math.abs(rel);
      const where = a < 35 ? 'ahead of you' : a > 145 ? 'behind you' : rel > 0 ? 'to your right' : 'to your left';
      return msg(`${what}'s ${far} ${where}.`);
    }
    return msg(`${what}'s ${far} to the ${NAV_COMPASS[Math.round(bearing / 45) % 8]}.`);
  }

  nextCue() {
    return this.cues.find((c) => c.at > this.progress + 3) || null;
  }

  announceCues() {
    for (let k = 0; k < this.cues.length; k++) {
      const c = this.cues[k];
      const ahead = c.at - this.progress;
      if (ahead < -10) {
        c.pre = c.now = true; // passed (e.g. GPS skipped it)
        continue;
      }
      if (ahead > PRE_MAX) break;
      if (c.type === 'arrive') break; // handled by finish()
      if (c.type === 'lap') {
        // Lap counts are said once, as the lap starts; never announced ahead.
        if (!c.now && ahead <= NOW_M) { c.now = c.pre = true; this.speak(cueSpeech(c), { priority: 1 }); }
        continue;
      }
      if (!c.now && ahead <= NOW_M) {
        c.now = c.pre = true;
        const next = this.cues[k + 1];
        let parts = cueSpeech(c);
        if (next && next.type !== 'arrive' && next.type !== 'lap' && next.at - c.at <= THEN_M) { // laps are said on their own, as they start
          parts = [...parts, part(', then '), ...lower(cueSpeech(next))];
          next.pre = true;
        }
        this.speak(parts, { priority: 2 });
        continue;
      }
      if (!c.now) {
        // Only the next turn gets an early heads-up.
        if (!c.pre && ahead > PRE_MIN) {
          c.pre = true;
          this.speak(cueSpeech(c, { ahead }), { priority: 1 });
        }
        break;
      }
    }
  }

  announceSights() {
    for (const s of this.sights) {
      if (s.said) continue;
      const ahead = s.at - this.progress;
      if (ahead < -20) { s.said = true; continue; }
      if (ahead > SIGHT_AHEAD) continue;
      s.said = true;
      const side = s.side === 'left' ? 'On your left' : s.side === 'right' ? 'On your right' : 'Just ahead';
      const kind = s.kind && !s.name.toLowerCase().includes(s.kind) ? `, a ${s.kind}` : '';
      this.speak(msg(`${side}: `, s.name, kind ? `${kind}.` : '.'), { priority: 0 });
    }
  }

  announceSplit() {
    if (this.odometer < this.nextSplit) return;
    const km = Math.round(this.nextSplit / 1000);
    const dt = (this.elapsed - this.lastSplit.t) / 1000;
    const dd = (this.odometer - this.lastSplit.odo) / 1000;
    this.lastSplit = { t: this.elapsed, odo: this.odometer };
    this.nextSplit += 1000;
    const left = Math.max(0, this.total - this.progress);
    const parts = [`${km} kilometer${km > 1 ? 's' : ''}.`];
    if (dd > 0.5) parts.push(`Last kilometer ${paceText(dt / dd)}.`);
    if (left > 300) parts.push(`${distText(left)} to go.`);
    this.speak(msg(parts.join(' ')), { priority: 1 });
  }

  finish() {
    this.finished = true;
    this.progress = this.total;
    this.seg = this.xy.length - 2;
    const mins = Math.round(this.elapsed / 60000);
    const pace = this.odometer > 500 ? ` Average pace ${paceText(this.elapsed / 1000 / (this.odometer / 1000))}.` : '';
    this.speak(msg(`You have arrived back at the start. Great run! ${(this.odometer / 1000).toFixed(1)} kilometers in ${mins} minute${mins === 1 ? '' : 's'}.${pace}`), { priority: 3 });
  }

  /** Everything the screen needs. */
  view(fix = null) {
    const next = this.finished ? null : this.nextCue();
    // Point on the route at the accepted progress (not the raw snap, which may be rejected).
    let pos = null;
    if (this.snapped) {
      const i = Math.min(this.seg, this.xy.length - 2);
      const L = this.along[i + 1] - this.along[i] || 1;
      const t = Math.max(0, Math.min(1, (this.progress - this.along[i]) / L));
      pos = this.proj.toLatLon(this.xy[i][0] + (this.xy[i + 1][0] - this.xy[i][0]) * t, this.xy[i][1] + (this.xy[i + 1][1] - this.xy[i][1]) * t);
    }
    return {
      fix,
      onRoute: pos && !this.offRoute ? [pos[0], pos[1]] : null,
      offRoute: this.offRoute,
      offBy: this.snapped?.dist ?? null,
      progress: this.progress,
      remaining: Math.max(0, this.total - this.progress),
      odometer: this.odometer,
      elapsed: this.elapsed,
      pace: this.odometer > 50 ? this.elapsed / 1000 / (this.odometer / 1000) : NaN,
      next: next && { type: next.type, dir: next.dir, street: next.street, action: cueAction(next), in: next.at - this.progress },
      finished: this.finished,
      paused: this.paused,
    };
  }
}

// ---------------- Browser pieces ----------------

/** Speaks message parts with the Web Speech API, English with Hebrew names. */
export class Voice {
  constructor(synth = globalThis.speechSynthesis) {
    this.synth = synth;
    this.muted = false;
    this.queue = [];
    this.speaking = false;
    this.voices = { en: null, he: null };
    this.log = []; // everything said (for tests and the on-screen caption)
    this.onSay = null;
    if (synth) {
      const pick = () => {
        const vs = synth.getVoices?.() || [];
        const by = (re) => vs.find((v) => re.test(v.lang) && v.localService) || vs.find((v) => re.test(v.lang));
        this.voices.en = by(/^en[-_](US|GB)/i) || by(/^en/i) || null;
        this.voices.he = by(/^(he|iw)/i) || null;
      };
      pick();
      synth.addEventListener?.('voiceschanged', pick);
    }
  }
  get available() { return !!this.synth; }
  /** Must be called from a tap (iOS only allows speech that starts from a user action). */
  unlock() {
    if (!this.synth) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch {}
  }
  say(parts, { priority = 1 } = {}) {
    const text = parts.map((p) => p.text).join('');
    this.log.push(text);
    this.onSay?.(text);
    if (this.muted || !this.synth) return;
    // Urgent messages (turn now, off route) jump the queue and drop stale ones.
    if (priority >= 2) {
      this.queue = this.queue.filter((q) => q.priority >= 2);
      if (priority >= 3) { this.cancelSpeech(); }
    }
    this.queue.push({ parts, priority });
    if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
    if (!this.speaking) this.next();
  }
  // Stops what is being said. The cancelled utterance's callback still fires later; the
  // generation counter makes it a no-op instead of resuming the old sentence.
  cancelSpeech() {
    this.gen = (this.gen || 0) + 1;
    clearTimeout(this.watchdog);
    try { this.synth.cancel(); } catch {}
    this.queue = [];
    this.speaking = false;
  }
  next() {
    const item = this.queue.shift();
    if (!item) { this.speaking = false; return; }
    this.speaking = true;
    const gen = (this.gen = (this.gen || 0) + 1);
    // Merge runs of the same language; drop Hebrew parts if there is no Hebrew voice.
    const runs = [];
    for (const p of item.parts) {
      const lang = p.lang === 'he' && this.voices.he ? 'he' : 'en';
      if (p.lang === 'he' && !this.voices.he) continue;
      const last = runs[runs.length - 1];
      if (last && last.lang === lang) last.text += p.text;
      else runs.push({ lang, text: p.text });
    }
    let i = 0;
    const speakRun = () => {
      if (gen !== this.gen) return; // cancelled or superseded: this chain is dead
      clearTimeout(this.watchdog);
      if (i >= runs.length) return this.next();
      const r = runs[i++];
      const u = new SpeechSynthesisUtterance(r.text);
      u.lang = r.lang === 'he' ? 'he-IL' : 'en-US';
      const v = this.voices[r.lang];
      if (v) u.voice = v;
      u.rate = 1.02;
      u.onend = u.onerror = speakRun;
      this.current = u; // keep a reference: Chrome drops callbacks of a collected utterance
      // Watchdog: if the browser never reports the end (screen locked, tab in the
      // background), carry on anyway instead of staying silent for the rest of the run.
      this.watchdog = setTimeout(speakRun, 4000 + 80 * r.text.length);
      try { this.synth.speak(u); } catch { speakRun(); }
    };
    speakRun();
  }
  setMuted(m) {
    this.muted = m;
    if (m && this.synth) this.cancelSpeech();
  }
  stop() { this.setMuted(true); this.muted = false; }
}

/** Keeps the screen awake during the run (re-acquired when the page comes back). */
export class ScreenLock {
  constructor() {
    this.lock = null;
    this.wanted = false;
    this.onVis = () => document.visibilityState === 'visible' && this.wanted && this.acquire();
  }
  get supported() { return 'wakeLock' in navigator; }
  async acquire() {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVis);
    if (!this.supported) return false;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false;
    }
  }
  release() {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVis);
    this.lock?.release?.().catch(() => {});
    this.lock = null;
  }
}

/** Real GPS. */
export class GpsSource {
  start(onFix, onError) {
    if (!('geolocation' in navigator)) { onError?.(new Error('This browser has no GPS access.')); return; }
    this.id = navigator.geolocation.watchPosition(
      (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading }),
      (e) => onError?.(e),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }
  stop() {
    if (this.id != null) navigator.geolocation.clearWatch(this.id);
    this.id = null;
  }
}

/**
 * A pretend runner moving along the route, so guidance can be tried at a desk.
 * `speed` m/s of simulated running, `rate` x real time.
 */
export class SimulatedRun {
  constructor(route, { speed = 3.2, rate = 6, intervalMs = 1000, noise = 3, clock = null } = {}) {
    this.route = route;
    this.speed = speed;
    this.rate = rate;
    this.intervalMs = intervalMs;
    this.noise = noise;
    this.clock = clock; // a fake clock to advance (so pace looks real), optional
    const pts = route.latlngs;
    const proj = makeProjection(pts[0][0], pts[0][1]);
    this.proj = proj;
    this.xy = pts.map(([a, b]) => proj.toXY(a, b));
    this.d = 0;
    this.i = 0;
  }
  position(d) {
    const xy = this.xy;
    while (this.i < xy.length - 2) {
      const L = Math.hypot(xy[this.i + 1][0] - xy[this.i][0], xy[this.i + 1][1] - xy[this.i][1]);
      if (this.segStart + L >= d) break;
      this.segStart += L;
      this.i++;
    }
    const a = xy[this.i], b = xy[this.i + 1] || a;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = Math.min(1, Math.max(0, (d - this.segStart) / L));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  /** Next fix, advancing `dt` seconds of simulated running. */
  step(dt) {
    if (this.segStart == null) this.segStart = 0;
    this.d += this.speed * dt;
    const [x, y] = this.position(this.d);
    const j = () => (Math.random() * 2 - 1) * this.noise;
    const [lat, lon] = this.proj.toLatLon(x + j(), y + j());
    return { lat, lon, accuracy: 5 };
  }
  start(onFix) {
    this.timer = setInterval(() => {
      if (this.isPaused?.()) return;
      const dt = (this.intervalMs / 1000) * this.rate;
      this.clock?.advance(dt * 1000);
      onFix(this.step(dt));
    }, this.intervalMs);
  }
  stop() { clearInterval(this.timer); }
}
