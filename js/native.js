// The native shell (Capacitor, iPhone first). The same web app runs inside the app; these
// adapters replace the browser pieces that a web page cannot do well on a phone:
//   - NativeVoice: the system speech engine with every installed voice (Zoe, Tom, Siri),
//     speaking on while the screen is locked (UIBackgroundModes audio);
//   - NativeGps: a background location watcher, so fixes keep coming with the screen off
//     or the app behind another (UIBackgroundModes location);
//   - NativeScreenLock: keep-awake while the run screen is on.
// Plugins are reached through the bridge (Capacitor.registerPlugin), so the bundle needs
// no npm imports; the native side is added by `npx cap sync ios`.

// window.Capacitor is the native bridge; registerPlugin comes from @capacitor/core, which
// index.html loads as js/vendor/capacitor.js (it sets window.capacitorExports).
const cap = () => globalThis.Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();
const registerPlugin = (name) => (globalThis.capacitorExports?.registerPlugin || cap()?.registerPlugin)?.(name) || null;
const plugin = (name) => { if (!isNative()) return null; try { return registerPlugin(name); } catch { return null; } };

const NATIVE_HEBREW = /[֐-׿]/;

/** Same surface as navigation.js Voice, on the phone's own speech engine. */
export class NativeVoice {
  constructor() {
    this.tts = plugin('TextToSpeech');
    this.muted = false;
    this.queue = [];
    this.speaking = false;
    this.voices = { en: null, he: null };
    this.list = []; // { voiceURI, name, lang, localService }
    this.log = [];
    this.onSay = null;
    this.preferred = null;
    this.gen = 0;
    // The settings page reads voices through this shim (the web Voice exposes speechSynthesis).
    this.synth = { getVoices: () => this.list, addEventListener: () => {}, cancel: () => this.cancelSpeech() };
    this.ready = this.loadVoices();
  }
  get available() { return !!this.tts; }
  async loadVoices() {
    try {
      const { voices } = await this.tts.getSupportedVoices();
      this.list = (voices || []).map((v, i) => ({ voiceURI: v.voiceURI || `native-${i}`, name: v.name || v.voiceURI || `Voice ${i}`, lang: v.lang || '', localService: v.localService !== false, index: i }));
    } catch {
      this.list = [];
    }
    this.pick();
  }
  pick() {
    const vs = this.list;
    const chosen = this.preferred && vs.find((v) => v.voiceURI === this.preferred);
    const ranked = chosen ? null : this.options(1)[0];
    const by = (re) => vs.find((v) => re.test(v.lang));
    this.voices.en = chosen || (ranked && vs.find((v) => v.voiceURI === ranked.uri)) || by(/^en[-_](US|GB)/i) || by(/^en/i) || null;
    this.voices.he = by(/^(he|iw)/i) || null;
  }
  setVoice(uri) { this.preferred = uri || null; this.pick(); }
  options(max = 5) {
    const ACCENT = { US: 'American', GB: 'British', AU: 'Australian', IE: 'Irish', ZA: 'South African', IN: 'Indian', CA: 'Canadian', NZ: 'New Zealand' };
    const FAVOURITES = ['zoe', 'tom', 'siri', 'samantha', 'daniel', 'karen', 'aaron', 'moira', 'arthur', 'tessa', 'rishi', 'nicky', 'ava', 'evan', 'allison', 'susan', 'joelle'];
    const en = this.list.filter((v) => /^en[-_]/i.test(v.lang));
    const grade = (v) => (/premium/i.test(v.voiceURI + v.name) ? 3 : /enhanced/i.test(v.voiceURI + v.name) ? 2 : 1);
    const byName = new Map();
    for (const v of en) {
      const key = v.name.replace(/\s*\((enhanced|premium|compact)\)/i, '').trim().toLowerCase();
      if (!byName.has(key) || grade(v) > grade(byName.get(key))) byName.set(key, v);
    }
    const rank = (v) => { const key = v.name.replace(/\s*\((enhanced|premium|compact)\)/i, '').trim().toLowerCase(); const i = FAVOURITES.findIndex((f) => key.startsWith(f)); return i < 0 ? 100 : i; };
    const current = this.voices.en?.voiceURI;
    return [...byName.values()].sort((a, b) => rank(a) - rank(b)).slice(0, max).map((v) => ({
      uri: v.voiceURI,
      name: v.name.replace(/\s*\((enhanced|premium|compact)\)/i, ''),
      lang: v.lang,
      accent: ACCENT[(v.lang.split(/[-_]/)[1] || '').toUpperCase()] || v.lang,
      current: v.voiceURI === current,
    }));
  }
  unlock() {}
  say(parts, { priority = 1 } = {}) {
    const text = parts.map((p) => p.text).join('');
    this.log.push(text);
    this.onSay?.(text);
    if (this.muted || !this.tts) return;
    if (priority >= 2) {
      this.queue = this.queue.filter((q) => q.priority >= 2);
      if (priority >= 3) this.cancelSpeech();
    }
    this.queue.push({ parts, priority });
    if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
    if (!this.speaking) this.next();
  }
  cancelSpeech() {
    this.gen++;
    this.queue = [];
    this.speaking = false;
    this.tts?.stop().catch(() => {});
  }
  async next() {
    const item = this.queue.shift();
    if (!item) { this.speaking = false; return; }
    this.speaking = true;
    const gen = ++this.gen;
    const runs = [];
    for (const p of item.parts) {
      const he = (p.lang === 'he' || NATIVE_HEBREW.test(p.text)) && this.voices.he;
      if ((p.lang === 'he' || NATIVE_HEBREW.test(p.text)) && !this.voices.he) continue;
      const lang = he ? 'he' : 'en';
      const last = runs[runs.length - 1];
      if (last && last.lang === lang) last.text += p.text;
      else runs.push({ lang, text: p.text });
    }
    for (const r of runs) {
      if (gen !== this.gen) return;
      const v = this.voices[r.lang];
      try {
        await this.tts.speak({ text: r.text, lang: v?.lang || (r.lang === 'he' ? 'he-IL' : 'en-US'), rate: 1.0, pitch: 1.0, volume: 1.0, voice: v?.index, category: 'playback' });
      } catch {
        /* a voice that cannot speak this text: skip it */
      }
    }
    if (gen === this.gen) this.next();
  }
  preview(uri, text = 'In 200 meters, turn left onto Rothschild Boulevard. Then keep going along the promenade.') {
    const v = this.list.find((x) => x.voiceURI === uri);
    this.cancelSpeech();
    this.tts?.speak({ text, lang: v?.lang || 'en-US', rate: 1.0, pitch: 1.0, volume: 1.0, voice: v?.index, category: 'playback' }).catch(() => {});
  }
  setMuted(m) { this.muted = m; if (m) this.cancelSpeech(); }
  stop() { this.setMuted(true); this.muted = false; }
}

/** GPS that keeps running with the screen locked (background location). */
export class NativeGps {
  constructor() { this.geo = plugin('BackgroundGeolocation'); this.id = null; }
  async start(onFix, onError) {
    if (!this.geo) { onError?.(new Error('No location plugin')); return; }
    try {
      this.id = await this.geo.addWatcher(
        { backgroundMessage: 'RunTheTown is guiding your run.', backgroundTitle: 'Run in progress', requestPermissions: true, stale: false, distanceFilter: 3 },
        (loc, err) => {
          if (err) { onError?.(err.code === 'NOT_AUTHORIZED' ? { code: 1, message: err.message } : err); return; }
          if (loc) onFix({ lat: loc.latitude, lon: loc.longitude, accuracy: loc.accuracy, heading: loc.bearing ?? null, speed: loc.speed ?? null });
        }
      );
    } catch (e) {
      onError?.(e);
    }
  }
  stop() {
    if (this.id != null) this.geo?.removeWatcher({ id: this.id }).catch(() => {});
    this.id = null;
  }
}

/** Keeps the screen on while the run screen is up (the guide itself goes on with the screen off). */
export class NativeScreenLock {
  constructor() { this.ka = plugin('KeepAwake'); this.wanted = false; }
  get supported() { return !!this.ka; }
  async acquire() {
    this.wanted = true;
    try { await this.ka?.keepAwake(); return true; } catch { return false; }
  }
  release() {
    this.wanted = false;
    this.ka?.allowSleep().catch(() => {});
  }
}

/** Share a JPEG data URL through the phone's share sheet (web share needs no file on disk; native does). */
export async function nativeShare({ dataUrl, fileName, text }) {
  const fs = plugin('Filesystem');
  const share = plugin('Share');
  if (!fs || !share) return false;
  const base64 = dataUrl.split(',')[1];
  const { uri } = await fs.writeFile({ path: fileName, data: base64, directory: 'CACHE' });
  await share.share({ text, files: [uri] });
  return true;
}
