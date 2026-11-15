import Foundation
import Capacitor
import AVFoundation

// The off-route chime (two rising notes) and the single note, played by the phone itself:
// the page's own audio can be silent with the screen locked, the app's audio session is not.
// The tones are synthesised once into a small WAV in memory; the session is shared with
// whatever is playing (music keeps going, a little quieter for a moment).
@objc(ChimePlugin)
public class ChimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ChimePlugin"
    public let jsName = "Chime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
    ]
    private var players: [String: AVAudioPlayer] = [:]

    @objc func play(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "note"
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
                try session.setActive(true)
                let player = try self.player(for: name)
                player.currentTime = 0
                player.play()
                // Let the music come back up once the chime is over.
                DispatchQueue.main.asyncAfter(deadline: .now() + player.duration + 0.1) {
                    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
                }
                call.resolve(["played": true])
            } catch {
                call.resolve(["played": false, "reason": error.localizedDescription])
            }
        }
    }

    private func player(for name: String) throws -> AVAudioPlayer {
        if let p = players[name] { return p }
        let notes: [(Double, Double)] = name == "offroute" ? [(740, 0), (988, 0.14)] : [(880, 0)] // Hz, start s
        let p = try AVAudioPlayer(data: ChimePlugin.wav(notes: notes), fileTypeHint: AVFileType.wav.rawValue)
        p.prepareToPlay()
        players[name] = p
        return p
    }

    // 16-bit mono PCM: each note rises in 20 ms and fades over 200 ms, like the page's version.
    static func wav(notes: [(Double, Double)], rate: Double = 22050) -> Data {
        let length = (notes.map { $0.1 }.max() ?? 0) + 0.3
        let n = Int(length * rate)
        var samples = [Int16](repeating: 0, count: n)
        for (hz, at) in notes {
            let from = Int(at * rate)
            for i in from..<n {
                let t = Double(i - from) / rate
                let env = t < 0.02 ? t / 0.02 : max(0, 1 - (t - 0.02) / 0.2)
                if env <= 0 { break }
                let v = sin(2 * Double.pi * hz * t) * env * 0.5
                samples[i] = Int16(clamping: Int(samples[i]) + Int(v * 32767))
            }
        }
        var data = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 2)) }
        let bytes = n * 2
        data.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + bytes)); data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        data.append("data".data(using: .ascii)!); u32(UInt32(bytes))
        samples.withUnsafeBufferPointer { data.append(Data(buffer: $0)) }
        return data
    }
}
