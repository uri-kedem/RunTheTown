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
const STILL_M = 20; // off the line, movement counts only while the runner gets this far ...
const STILL_MS = 20000; // ... within this time (GPS jitter while standing adds nothing)
const BACK_M = 25; // back within this = on route again
const OFF_FIXES = 2; // consecutive far fixes before warning
const SIGHT_AHEAD = 80; // call out a sight this far before passing it
const REVERSE_M = 70; // running against the route for this long near the line = the runner turned around on purpose
const JOIN_START_M = 300; // starting this close to any part of the route: the run begins from there, not from the route's first point
const ARRIVE_M = 30;
const MAX_ACCURACY = 60; // ignore GPS fixes worse than this (m)
const WINDOW_BACK = 60; // search the route this far behind current progress...
const WINDOW_AHEAD = 400; // ...and this far ahead (stops jumping to a parallel leg)

const HEBREW = /[֐-׿]/;
const NAV_COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export const MILE = 1609.344;
export const FOOT = 0.3048;

export function roundDist(m) {
  if (m < 100) return Math.max(10, Math.round(m / 10) * 10);
  if (m < 1000) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}
// Spoken distance: metres and kilometres, or feet and miles ("In 500 feet", "a quarter mile").
export function distText(m, units = 'km') {
  if (units === 'mi') {
    const mi = m / MILE;
    if (mi >= 0.95) { const r = Math.round(mi * 10) / 10; return `${r === 1 ? 'one mile' : `${String(r).replace(/\.0$/, '')} miles`}`; }
    if (mi >= 0.7) return 'three quarters of a mile';
    if (mi >= 0.45) return 'half a mile';
    if (mi >= 0.22) return 'a quarter mile';
    const ft = m / FOOT;
    return `${Math.max(50, Math.round(ft / 50) * 50)} feet`;
  }
  const r = roundDist(m);
  return r >= 1000 ? `${(r / 1000).toFixed(1).replace(/\.0$/, '')} kilometers` : `${r} meters`;
}
export function paceText(secPerKm, units = 'km') {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '';
  const per = units === 'mi' ? secPerKm * (MILE / 1000) : secPerKm;
  const m = Math.floor(per / 60);
  const s = Math.round(per % 60);
  const unit = units === 'mi' ? 'mile' : 'kilometer';
  return s ? `${m} minutes ${s} seconds per ${unit}` : `${m} minutes per ${unit}`;
}
// On-screen length: "3.2 km" / "450 m", or "2.0 mi" / "800 ft".
export function lenText(m, units = 'km', { decimals = 1 } = {}) {
  if (units === 'mi') {
    const mi = m / MILE;
    return mi >= 0.2 ? `${mi.toFixed(decimals)} mi` : `${Math.round(m / FOOT / 10) * 10} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(decimals)} km` : `${Math.round(m)} m`;
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

function cueSpeech(c, { ahead = null, units = 'km' } = {}) {
  const lead = ahead != null ? `In ${distText(ahead, units)}, ` : '';
  const onto = c.street ? [' onto ', c.street] : [];
  if (c.type === 'turn' && !c.dir && c.text) return msg(ahead != null ? `${lead}${c.text[0].toLowerCase()}${c.text.slice(1)}` : c.text);
  switch (c.type) {
    case 'lap': return msg(`Lap ${c.lap} of ${c.laps}.`);
    case 'uturn': return msg(`${lead}${ahead != null ? 'turn around' : 'Turn around and head back the same way'}`);
    case 'arrive': return msg(ahead != null ? `In ${distText(ahead, units)}, you'll be back at the start` : 'You have arrived back at the start');
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
  /**
   * opts: speak, now, and the runner's settings: units 'km' | 'mi', splits (every km / mile),
   * landmarks (sights called out), quiet (only turns and off-route warnings), warnM (how far
   * ahead a turn is announced, m).
   */
  constructor(route, { speak = () => {}, sound = () => {}, now = () => Date.now(), units = 'km', splits = true, landmarks = true, quiet = false, warnM = PRE_MAX, onTurnaround = null } = {}) {
    this.speak = speak;
    this.sound = sound; // short sounds: 'offroute' (the recalculating chime)
    this.now = now;
    this.onTurnaround = onTurnaround; // called when the runner turned around on a loop (no return leg to switch to)
    this.backTravel = 0; // metres run against the route's direction, near the line
    this.units = units;
    this.splitM = units === 'mi' ? MILE : 1000;
    this.saying = { splits: splits && !quiet, landmarks: landmarks && !quiet, quiet };
    this.warnM = Math.max(PRE_MIN + 20, warnM);
    this.proj = makeProjection(route.latlngs[0][0], route.latlngs[0][1]);
    this.setRoute(route);
    this.odometer = 0; // meters actually run (from GPS), for splits and pace
    this.anchor = null;
    this.moving = null; // heading of travel (deg), from recent movement
    this.nextSplit = this.splitM;
    this.lastSplit = { t: 0, odo: 0 };
    this.elapsed = 0; // ms, excluding pauses
    this.paused = false;
    this.started = false;
    this.routeDone = false; // the planned line has been run to its end; the run itself goes on until the runner ends it
    this.finished = false;
  }

  // The line to follow: geometry, cues and sights measured on this polyline (their `at`
  // came from the graph; re-measured here so long routes don't drift). Progress restarts at 0.
  setRoute(route) {
    this.route = route;
    const pts = route.latlngs;
    this.xy = pts.map(([la, lo]) => this.proj.toXY(la, lo));
    this.along = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      this.along[i] = this.along[i - 1] + Math.hypot(this.xy[i][0] - this.xy[i - 1][0], this.xy[i][1] - this.xy[i - 1][1]);
    }
    this.total = this.along[pts.length - 1];
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
    this.snapped = null;
    this.rejoined = false;
    this.backTravel = 0;
    this.begun = false; // true once the runner is on the line (from the first point or anywhere else)
    this.startHintSaid = false;
  }

  /**
   * Rerouting: a new line from where the runner is, joining the old route further on.
   * The run's distance, time and splits carry on; progress restarts on the new line.
   * `route` = { latlngs, cues, sights } beginning at the runner's position.
   */
  reroute(route, { say = true } = {}) {
    const sightsSaid = new Set(this.sights.filter((s) => s.said).map((s) => s.name));
    this.setRoute(route);
    for (const s of this.sights) if (sightsSaid.has(s.name)) s.said = true;
    this.anchor = null;
    this.rerouted = (this.rerouted || 0) + 1;
    if (say) {
      const d = route.cues?.[0];
      this.speak(msg(d?.compass ? `Head ${d.compass}` : 'Follow the new route', d?.street ? ' on ' : null, d?.street || null, '.'), { priority: 3 });
    }
    return this.view();
  }

  start() {
    this.started = true;
    this.startT = this.now();
    this.lastTick = this.startT;
    const d = this.route.cues?.[0];
    this.speak(
      msg(
        `Starting your ${this.units === 'mi' ? `${(this.total / MILE).toFixed(1)} mile` : `${(this.total / 1000).toFixed(1)} kilometer`} run. `,
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
    this.still = null;
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
    if (fix.accuracy != null && fix.accuracy > MAX_ACCURACY) return this.view(); // a bad fix moves nothing, not even the dot
    const [x, y] = this.proj.toXY(fix.lat, fix.lon);

    // Travel direction, from movement of at least 8 m (GPS jitter is ignored).
    if (!this.anchor) this.anchor = { x, y };
    const moved = Math.hypot(x - this.anchor.x, y - this.anchor.y);
    // Standing still: GPS jitter wanders a few metres each fix and must not add up to
    // distance. The runner counts as moving while they get 20 m away from where they last
    // were within 20 s; a runner stopped at a light, or done and chatting, adds nothing.
    const t = this.now();
    if (!this.still || Math.hypot(x - this.still.x, y - this.still.y) >= STILL_M) this.still = { x, y, t };
    const running = t - this.still.t < STILL_MS;
    let hop = 0;
    if (moved >= 8) {
      if (moved < 300) { this.moving = (Math.atan2(x - this.anchor.x, y - this.anchor.y) * 180) / Math.PI; hop = moved; }
      if ((this.offRoute || this.routeDone) && moved < 300 && running) this.odometer += moved; // off the route (or past its end): count raw movement
      this.anchor = { x, y };
    }

    // The route has been run to its end: the runner may well keep going (a 12 km plan that
    // came out at 11.9, or just a good day). Distance, time and splits carry on from the raw
    // movement; no more turns, no off-route chime. The run ends when the runner ends it.
    if (this.routeDone) {
      this.announceSplit();
      return this.view(fix);
    }

    // Not on the line yet: the run begins wherever the runner meets the route, within
    // JOIN_START_M of any part of it (a runner who sets off 60 m past the start point, or
    // from their hotel door onto the loop, did that on purpose). Further away, one hint.
    if (!this.begun) {
      // On an out-and-back the return leg runs over the same ground as the way out, so the
      // first fix is as close to the end of the route as to its start. A slight preference
      // for the earliest point (a metre per kilometre) joins the route at its start; a
      // runner really joining further along is still matched there, as nothing else is near.
      const s0 = this.snap(x, y, 0, this.total, 0.001);
      if (s0.dist <= OFF_M) {
        this.begun = true;
        this.progress = s0.at;
        this.seg = s0.seg;
        this.snapped = s0;
        this.rejoined = true; // joining is not distance run
        for (const c of this.cues) if (c.at < this.progress - 10) c.pre = c.now = true;
        if (s0.at > 50) this.joinedAt = s0.at;
      } else if (s0.dist <= JOIN_START_M) {
        // On the way to the line: count the movement, say nothing. The line is close.
        if (hop) this.odometer += hop;
        this.toLine = s0.dist;
        return this.view(fix);
      } else {
        if (hop) this.odometer += hop;
        this.toLine = s0.dist;
        if (!this.startHintSaid && this.moving != null) { this.startHintSaid = true; this.speak(this.offRouteSpeech(x, y, s0), { priority: 3 }); }
        return this.view(fix);
      }
    }

    // Snap to the route near where we were; if lost, anywhere ahead.
    let snap = this.snap(x, y, this.progress - Math.max(WINDOW_BACK, this.backTravel + 40), this.progress + WINDOW_AHEAD);

    // Turned around? Running against the route's direction, close to the line, for REVERSE_M:
    // on an out-and-back that means the return leg (switch to it, skipping the turnaround);
    // on a loop it means heading home the way they came (the app builds that route).
    if (hop && !this.finished) {
      const near = this.snap(x, y, this.progress - 600, this.progress + 60, 0); // the line just behind too
      const against = near.dist <= OFF_M && this.turnAngle(this.moving, this.segHeading(near.seg)) > 120;
      this.backTravel = against ? this.backTravel + hop : 0;
      if (this.backTravel >= REVERSE_M) {
        this.backTravel = 0;
        if (this.turnedAround(x, y)) return this.view(fix);
      }
    }
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
      // Off the line: a chime, like a car navigator recalculating, and the screen shows the
      // way back. No words (the runner usually knows why they left the line); the new route,
      // when the app finds one, is announced as a plain instruction.
      if (this.farCount >= OFF_FIXES && !this.offRoute) {
        this.offOdo = this.odometer;
        this.offSince = this.now();
        this.offRoute = true;
        this.sound('offroute');
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
          this.progress = snap.at;
          this.seg = snap.seg;
        }
        this.rejoined = false; // on the route: measured along it (smooth), also after a rejoin behind the last progress
      }
    }

    if (!this.offRoute && snap.dist <= OFF_M) {
      this.announceCues();
      this.announceSights();
    }
    this.announceSplit();
    if (!this.routeDone && this.total - this.progress <= ARRIVE_M && this.progress > this.total * 0.8) this.routeComplete();
    return this.view(fix);
  }

  // Heading (deg) of the route along segment i.
  segHeading(i) {
    const j = Math.max(0, Math.min(this.xy.length - 2, i));
    const [ax, ay] = this.xy[j];
    const [bx, by] = this.xy[j + 1];
    return (Math.atan2(bx - ax, by - ay) * 180) / Math.PI;
  }
  turnAngle(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  /**
   * The runner turned around. Looks for a later part of the route that runs the way they
   * now run, within OFF_M (the return leg of an out-and-back): progress jumps there and the
   * rest of the route is followed from that point. On a loop there is no such leg: the
   * onTurnaround callback gets the chance to build the way back; returns true when handled.
   */
  turnedAround(x, y) {
    const n = this.xy.length;
    let best = null;
    for (let i = 0; i < n - 1; i++) {
      if (this.along[i + 1] < this.progress + 80) continue; // only later parts of the route
      if (this.turnAngle(this.moving, this.segHeading(i)) > 60) continue;
      const s = this.snap(x, y, this.along[i], this.along[i + 1], 0);
      if (s.dist <= OFF_M && (!best || s.at < best.at)) best = s;
    }
    if (best) {
      this.progress = best.at;
      this.seg = best.seg;
      this.snapped = best;
      this.offRoute = false;
      this.farCount = 0;
      this.rejoined = true; // the jump is not distance run
      this.turnarounds = (this.turnarounds || 0) + 1;
      for (const c of this.cues) if (c.at < this.progress - 10) c.pre = c.now = true; // skipped turns are not announced
      const left = Math.max(0, this.total - this.progress);
      this.speak(msg(`Turned around? Following the route back from here. ${distText(left, this.units)} to go.`), { priority: 3 });
      return true;
    }
    if (this.onTurnaround) return !!this.onTurnaround({ x, y, progress: this.progress, seg: this.seg });
    return false;
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
    const far = distText(snap.dist, this.units);
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
      if (ahead > this.warnM) break;
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
          this.speak(cueSpeech(c, { ahead, units: this.units }), { priority: 1 });
        }
        break;
      }
    }
  }

  announceSights() {
    if (!this.saying.landmarks) return;
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
    const n = Math.round(this.nextSplit / this.splitM);
    const dt = (this.elapsed - this.lastSplit.t) / 1000;
    const dd = (this.odometer - this.lastSplit.odo) / 1000; // km
    this.lastSplit = { t: this.elapsed, odo: this.odometer };
    this.nextSplit += this.splitM;
    if (!this.saying.splits) return;
    const unit = this.units === 'mi' ? 'mile' : 'kilometer';
    const parts = [`${n} ${unit}${n > 1 ? 's' : ''}.`];
    if (dd > 0.5 * (this.splitM / 1000)) parts.push(`Last ${unit} ${paceText(dt / dd, this.units)}.`);
    this.speak(msg(parts.join(' ')), { priority: 1 });
  }

  /** The planned line is done. Said once; the run goes on until finish(). */
  routeComplete() {
    this.routeDone = true;
    this.progress = this.total;
    this.seg = this.xy.length - 2;
    this.offRoute = false;
    this.anchor = null; // raw movement counts from here
    this.speak(msg(`Route complete, you're back at the start. Keep going if you like; press End run when you're done.`), { priority: 3 });
  }

  /** The runner ended the run: the clock stops and the summary is said. */
  finish() {
    if (this.finished) return;
    this.tick();
    this.finished = true;
    const mins = Math.round(this.elapsed / 60000);
    const pace = this.odometer > 500 ? ` Average pace ${paceText(this.elapsed / 1000 / (this.odometer / 1000), this.units)}.` : '';
    const ran = this.units === 'mi' ? `${(this.odometer / MILE).toFixed(1)} miles` : `${(this.odometer / 1000).toFixed(1)} kilometers`;
    this.speak(msg(`Run finished. ${ran} in ${mins} minute${mins === 1 ? '' : 's'}.${pace}`), { priority: 3 });
  }

  /** Everything the screen needs. */
  view(fix = null) {
    const next = this.finished || this.routeDone ? null : this.nextCue();
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
      onRoute: pos && !this.offRoute && this.begun ? [pos[0], pos[1]] : null,
      offRoute: this.offRoute,
      joining: this.started && !this.begun && !this.finished, // on the way to the line (nothing said, nothing urged)
      toLine: this.begun ? 0 : this.toLine ?? null,
      offBy: this.snapped?.dist ?? null,
      progress: this.progress,
      remaining: Math.max(0, this.total - this.progress),
      odometer: this.odometer,
      elapsed: this.elapsed,
      pace: this.odometer > 50 ? this.elapsed / 1000 / (this.odometer / 1000) : NaN,
      next: next && { type: next.type, dir: next.dir, street: next.street, action: cueAction(next), in: next.at - this.progress },
      routeDone: this.routeDone,
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
    this.preferred = null; // voiceURI the runner chose, or null for the default
    if (synth) {
      const pick = () => {
        const vs = synth.getVoices?.() || [];
        const siri = (v) => /siri/i.test(v.name) && /siri/i.test(v.voiceURI + ' ' + v.name) && !/compact/i.test(v.voiceURI); // a downloaded Siri voice, when the browser exposes it
        const good = (v) => /enhanced|premium/i.test(v.voiceURI + v.name); // the better copy of a phone voice
        const by = (re) => vs.find((v) => re.test(v.lang) && v.localService && siri(v)) || vs.find((v) => re.test(v.lang) && v.localService && good(v)) || vs.find((v) => re.test(v.lang) && v.localService) || vs.find((v) => re.test(v.lang));
        const chosen = this.preferred && vs.find((v) => v.voiceURI === this.preferred);
        // No choice yet: the best-ranked voice (house voices, then the well-known phone voices),
        // never simply the first one the phone lists (on iPhone that is "Fred").
        const ranked = chosen ? null : this.options(1)[0];
        this.voices.en = chosen || (ranked && vs.find((v) => v.voiceURI === ranked.uri)) || by(/^en[-_](US|GB)/i) || by(/^en/i) || null;
        this.voices.he = by(/^(he|iw)/i) || null;
      };
      this.pick = pick;
      pick();
      synth.addEventListener?.('voiceschanged', pick);
    }
  }
  /** The runner's choice of English voice (a voiceURI); null goes back to the default. */
  setVoice(uri) {
    this.preferred = uri || null;
    this.pick?.();
  }
  /**
   * Up to `max` English voices worth offering, the well-known phone voices first
   * (one entry per name; the enhanced version of a voice wins over its compact one).
   * Each: { uri, name, lang, accent, current }.
   */
  options(max = 5) {
    const vs = this.synth?.getVoices?.() || [];
    const ACCENT = { US: 'American', GB: 'British', AU: 'Australian', IE: 'Irish', ZA: 'South African', IN: 'Indian', CA: 'Canadian', NZ: 'New Zealand' };
    const FAVOURITES = ['zoe', 'tom', 'siri', 'samantha', 'daniel', 'karen', 'aaron', 'moira', 'arthur', 'tessa', 'rishi', 'nicky', 'catherine', 'gordon', 'fred', 'google us english', 'google uk english female', 'google uk english male', 'microsoft aria', 'microsoft guy', 'microsoft sonia', 'microsoft ryan'];
    const en = vs.filter((v) => /^en[-_]/i.test(v.lang));
    const byName = new Map();
    for (const v of en) {
      const key = v.name.replace(/\s*\((enhanced|premium|compact)\)/i, '').trim().toLowerCase();
      const better = /enhanced|premium/i.test(v.voiceURI + v.name) || (v.localService && !byName.get(key)?.localService);
      if (!byName.has(key) || better) byName.set(key, v);
    }
    const rank = (v) => {
      const key = v.name.replace(/\s*\((enhanced|premium|compact)\)/i, '').trim().toLowerCase();
      const i = FAVOURITES.findIndex((f) => key.startsWith(f));
      return (i < 0 ? 100 : i) + (v.localService ? 0 : 50);
    };
    const current = this.voices.en?.voiceURI;
    return [...byName.values()].sort((a, b) => rank(a) - rank(b)).slice(0, max).map((v) => ({
      uri: v.voiceURI,
      name: v.name.replace(/\s*\((enhanced|premium|compact)\)/i, '').replace(/^(Google|Microsoft)\s+/i, ''),
      lang: v.lang,
      accent: ACCENT[(v.lang.split(/[-_]/)[1] || '').toUpperCase()] || v.lang,
      current: v.voiceURI === current,
    }));
  }
  /** Speaks a sample cue with one voice (from a tap), without touching the run's queue. */
  preview(uri, text = 'In 200 meters, turn left onto Rothschild Boulevard. Then keep going along the promenade.') {
    if (!this.synth) return;
    const v = (this.synth.getVoices?.() || []).find((x) => x.voiceURI === uri);
    try { this.synth.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(text);
    u.lang = v?.lang || 'en-US';
    if (v) u.voice = v;
    u.rate = 1.02;
    this.current = u;
    try { this.synth.speak(u); } catch {}
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
