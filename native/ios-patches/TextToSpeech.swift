// RunTheTown patch of @capacitor-community/text-to-speech 6.1.0 (ios/Sources/TextToSpeechPlugin/TextToSpeech.swift).
// Copied over the installed plugin by `node native/patch-plugins.mjs` (part of `npm run ios`).
//
// Why: the stock plugin activates a "playback, duck others" audio session the moment the app
// starts and never releases it, so the runner's music drops to half volume for as long as the app
// is open. Here the session is activated only while a sentence is spoken (that is when the music
// ducks) and released right after, which tells iOS to bring the music back up. The voice-prompt
// mode is the one Apple designed for navigation announcements.
import AVFoundation
import Capacitor

enum QUEUE_STRATEGY: Int {
    case QUEUE_ADD = 1, QUEUE_FLUSH = 0
}

@objc public class TextToSpeech: NSObject, AVSpeechSynthesizerDelegate {
    let synthesizer = AVSpeechSynthesizer()
    var calls: [CAPPluginCall] = []
    let queue = DispatchQueue(label: "backgroundAudioSetup", qos: .userInitiated, attributes: [], autoreleaseFrequency: .inherit, target: nil)
    var sessionActive = false
    var releaseWork: DispatchWorkItem?

    override init() {
        super.init()
        self.synthesizer.delegate = self
        // Only the category is set here; the session is activated per sentence in speak().
        queue.async {
            do {
                if #available(iOS 12.0, *) {
                    try AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
                } else {
                    try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: .duckOthers)
                }
            } catch {
                print("Error setting up AVAudioSession: \(error)")
            }
        }
    }

    private func holdSession() {
        releaseWork?.cancel()
        releaseWork = nil
        if sessionActive { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            sessionActive = true
        } catch {
            print("Error activating AVAudioSession: \(error)")
        }
    }

    // Release a moment after the last utterance, so back-to-back sentences do not make the music
    // bounce up and down between them.
    private func releaseSessionSoon() {
        releaseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.synthesizer.isSpeaking, self.calls.isEmpty else { return }
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                print("Error releasing AVAudioSession: \(error)")
            }
            self.sessionActive = false
        }
        releaseWork = work
        queue.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        self.resolveCurrentCall()
        self.releaseSessionSoon()
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        self.resolveCurrentCall()
        self.releaseSessionSoon()
    }

    @objc public func speak(_ text: String, _ lang: String, _ rate: Float, _ pitch: Float, _ category: String, _ volume: Float, _ voice: Int, _ queueStrategy: Int, _ call: CAPPluginCall) throws {
        if queueStrategy == QUEUE_STRATEGY.QUEUE_FLUSH.rawValue {
            self.synthesizer.stopSpeaking(at: .immediate)
        }
        self.calls.append(call)
        self.holdSession()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
        utterance.rate = adjustRate(rate)
        utterance.pitchMultiplier = pitch
        utterance.volume = volume

        // Find the voice associated with the voice parameter if a voice specified.
        // If the specified voice is not available we will fall back to default voice rather than raising an error.
        if voice >= 0 {
            let allVoices = AVSpeechSynthesisVoice.speechVoices()
            if voice < allVoices.count {
                utterance.voice = allVoices[voice]
            }
        }

        synthesizer.speak(utterance)
    }

    @objc public func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        releaseSessionSoon()
    }

    @objc public func getSupportedLanguages() -> [String] {
        return Array(AVSpeechSynthesisVoice.speechVoices().map {
            return $0.language
        })
    }

    @objc public func isLanguageSupported(_ lang: String) -> Bool {
        let voice = AVSpeechSynthesisVoice(language: lang)
        return voice != nil
    }

    // Adjust rate for a closer match to other platform.
    @objc private func adjustRate(_ rate: Float) -> Float {
        let baseRate: Float = AVSpeechUtteranceDefaultSpeechRate
        if rate >= 1.0 {
            return (0.1 * rate) + (baseRate - 0.1)
        }
        return rate * baseRate
    }

    @objc private func resolveCurrentCall() {
        guard let call = calls.first else {
            return
        }
        call.resolve()
        calls.removeFirst()
    }
}
