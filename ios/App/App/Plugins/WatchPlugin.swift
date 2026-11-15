import Foundation
import Capacitor
import WatchConnectivity
import HealthKit

// The run on the Apple Watch: at Start the watch app is woken (with a workout configuration,
// the one way a phone may start its watch app), then every update of the run screen is sent
// to it, with the name of a tap when a turn comes up. With no watch paired, or the watch
// app not installed, every call answers quietly and nothing else happens.
@objc(WatchPlugin)
public class WatchPlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
    public let identifier = "WatchPlugin"
    public let jsName = "Watch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]
    private let store = HKHealthStore()
    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

    override public func load() {
        session?.delegate = self
        session?.activate()
    }

    private var ready: Bool {
        guard let s = session, s.activationState == .activated else { return false }
        return s.isPaired && s.isWatchAppInstalled
    }

    @objc func status(_ call: CAPPluginCall) {
        let s = session
        call.resolve([
            "supported": s != nil,
            "paired": s?.isPaired ?? false,
            "installed": s?.isWatchAppInstalled ?? false,
            "reachable": s?.isReachable ?? false,
        ])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard ready else { call.resolve(["started": false]); return }
        let message = payload(call, kind: "start")
        let config = HKWorkoutConfiguration()
        config.activityType = .running
        config.locationType = .outdoor
        store.startWatchApp(with: config) { ok, _ in
            self.send(message)
            call.resolve(["started": ok])
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard ready else { call.resolve(["sent": false]); return }
        send(payload(call, kind: "update"))
        call.resolve(["sent": true])
    }

    @objc func end(_ call: CAPPluginCall) {
        guard ready else { call.resolve(["sent": false]); return }
        send(payload(call, kind: "end"))
        call.resolve(["sent": true])
    }

    private func payload(_ call: CAPPluginCall, kind: String) -> [String: Any] {
        var m: [String: Any] = ["kind": kind, "t": Date().timeIntervalSince1970]
        for key in ["routeName", "instruction", "street", "toTurn", "distance", "pace", "elapsed", "symbol", "haptic"] {
            if let v = call.getString(key) { m[key] = v }
        }
        m["offRoute"] = call.getBool("offRoute") ?? false
        return m
    }

    // Live while the watch is in reach; otherwise as the latest state it picks up when it wakes.
    private func send(_ message: [String: Any]) {
        guard let s = session, s.activationState == .activated else { return }
        if s.isReachable {
            s.sendMessage(message, replyHandler: nil) { _ in try? s.updateApplicationContext(message) }
        } else {
            try? s.updateApplicationContext(message)
        }
    }

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
