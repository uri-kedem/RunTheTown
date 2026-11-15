import Foundation
import WatchConnectivity
import WatchKit
import HealthKit

// The run as the watch knows it: whatever the phone last sent. Messages arrive live while
// the phone is in reach, or as the latest "application context" when it was not.
final class RunSession: NSObject, ObservableObject, WCSessionDelegate, HKWorkoutSessionDelegate {
    static let shared = RunSession()

    @Published var active = false
    @Published var routeName = ""
    @Published var instruction = ""
    @Published var street = ""
    @Published var toTurn = ""
    @Published var distance = ""
    @Published var pace = ""
    @Published var elapsed = ""
    @Published var symbol = "figure.run"
    @Published var offRoute = false

    private let store = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var lastUpdate = Date.distantPast
    private var watchdog: Timer?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: Messages from the phone

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        if !context.isEmpty { apply(context) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        apply(message)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }

    private func apply(_ m: [String: Any]) {
        DispatchQueue.main.async {
            let kind = m["kind"] as? String ?? "update"
            // An old "application context" from a run that ended long ago is not a run.
            if let t = m["t"] as? Double, Date().timeIntervalSince1970 - t > 600, kind != "end" { return }
            if let v = m["routeName"] as? String { self.routeName = v }
            if let v = m["instruction"] as? String { self.instruction = v }
            if let v = m["street"] as? String { self.street = v }
            if let v = m["toTurn"] as? String { self.toTurn = v }
            if let v = m["distance"] as? String { self.distance = v }
            if let v = m["pace"] as? String { self.pace = v }
            if let v = m["elapsed"] as? String { self.elapsed = v }
            if let v = m["symbol"] as? String, !v.isEmpty { self.symbol = v }
            if let v = m["offRoute"] as? Bool { self.offRoute = v }
            self.lastUpdate = Date()
            if kind == "end" {
                self.finish()
                return
            }
            if !self.active {
                self.active = true
                self.startWatchdog()
            }
            if let haptic = m["haptic"] as? String, !haptic.isEmpty { self.tap(haptic) }
        }
    }

    // MARK: Taps
    // One feel per event, so a turn can be told without looking: a notification buzz ahead
    // of a turn, then "down" for left and "up" for right at the turn itself.
    private func tap(_ kind: String) {
        let device = WKInterfaceDevice.current()
        switch kind {
        case "pre": device.play(.notification)
        case "left": device.play(.directionDown)
        case "right": device.play(.directionUp)
        case "turn": device.play(.click)
        case "offroute": device.play(.failure)
        case "done": device.play(.success)
        default: device.play(.notification)
        }
    }

    // MARK: Staying awake during the run

    func startWorkout(_ configuration: HKWorkoutConfiguration) {
        guard workout == nil, HKHealthStore.isHealthDataAvailable() else { return }
        store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: []) { ok, _ in
            guard ok else { return }
            DispatchQueue.main.async {
                guard self.workout == nil else { return }
                do {
                    // The session only keeps the app alive: no workout is saved from the watch
                    // (the phone saves the run to Health, once).
                    let session = try HKWorkoutSession(healthStore: self.store, configuration: configuration)
                    session.delegate = self
                    session.startActivity(with: Date())
                    self.workout = session
                    self.active = true
                    self.lastUpdate = Date()
                    self.startWatchdog()
                } catch {
                    self.workout = nil
                }
            }
        }
    }

    /// The run is over (the phone said so, the runner pressed Stop, or the phone went quiet).
    func finish() {
        watchdog?.invalidate()
        watchdog = nil
        workout?.end()
        workout = nil
        active = false
    }

    // A phone that stopped talking for ten minutes (out of battery, app closed) must not
    // leave the watch in a workout for the rest of the day.
    private func startWatchdog() {
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if Date().timeIntervalSince(self.lastUpdate) > 600 { self.finish() }
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {}

    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        DispatchQueue.main.async { self.workout = nil }
    }
}
