// The runner's settings, kept on the phone (localStorage 'rtt-settings'). Every value has
// a default, unknown keys are ignored, and reading never throws: a private window or a
// blocked storage just means the defaults.

export const DEFAULTS = Object.freeze({
  voice: null, // voiceURI of the chosen English voice, or null for the house voice
  units: 'km', // 'km' | 'mi'
  splits: true, // say every kilometre / mile with the pace
  landmarks: true, // call out sights on a tour
  quiet: false, // only turns and off-route warnings
  warnM: 200, // how far ahead a turn is announced: 100 | 200 | 300
  follow: true, // the map follows the runner
  headingUp: true, // the map turns so the way ahead is up (during a run, while following)
  awake: true, // keep the screen on during a run
  language: 'en', // 'en' for now; 'he' is coming
});

const KEY = 'rtt-settings';

export function loadSettings(storage = globalThis.localStorage) {
  const out = { ...DEFAULTS };
  try {
    const raw = storage?.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : {};
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in saved)) continue;
      const ok = k === 'voice' ? saved[k] == null || typeof saved[k] === 'string' : typeof saved[k] === typeof DEFAULTS[k];
      if (ok) out[k] = saved[k];
    }
    // The voice used to be kept on its own; carry it over once.
    const oldVoice = storage?.getItem('rtt-voice');
    if (oldVoice && !out.voice) out.voice = oldVoice;
  } catch {
    /* defaults */
  }
  if (!['km', 'mi'].includes(out.units)) out.units = 'km';
  if (![100, 200, 300].includes(out.warnM)) out.warnM = 200;
  return out;
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    const slim = {};
    for (const k of Object.keys(DEFAULTS)) if (k in settings) slim[k] = settings[k];
    storage?.setItem(KEY, JSON.stringify(slim));
    storage?.removeItem('rtt-voice');
  } catch {
    /* storage full or blocked: the setting still holds for this session */
  }
}

// The two house voices: Zoe (female) and Tom (male), the best copy of each that is on the
// phone (Premium over Enhanced over compact). `voices` is speechSynthesis.getVoices().
export const HOUSE_VOICES = [
  { id: 'zoe', name: 'Zoe', gender: 'female', match: /\bzoe\b/i },
  { id: 'tom', name: 'Tom', gender: 'male', match: /\btom\b/i },
];
export function houseVoices(voices) {
  const grade = (v) => (/premium/i.test(v.voiceURI + v.name) ? 3 : /enhanced/i.test(v.voiceURI + v.name) ? 2 : 1);
  return HOUSE_VOICES.map((h) => {
    // The name or the identifier ("com.apple.voice.premium.en-US.Zoe"), whichever iOS fills in.
    const found = voices.filter((v) => /^en[-_]/i.test(v.lang) && (h.match.test(v.name) || h.match.test(String(v.voiceURI).split('.').pop() || ''))).sort((a, b) => grade(b) - grade(a))[0] || null;
    return { ...h, voice: found, quality: found ? ['', 'standard', 'enhanced', 'premium'][grade(found)] : null };
  });
}
