import Foundation
import Capacitor
#if canImport(ActivityKit)
import ActivityKit
#endif

// The run on the Lock Screen: one Live Activity per run, started at Start, updated with
// every GPS fix (the app throttles to about one a second), ended at End run. iOS 16.1 and
// later; older phones get { supported: false } and the voice guidance as before.
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    #if canImport(ActivityKit)
    @available(iOS 16.1, *)
    private static var current: Activity<RunActivityAttributes>?

    @available(iOS 16.1, *)
    private func state(from call: CAPPluginCall) -> RunActivityAttributes.ContentState {
        RunActivityAttributes.ContentState(
            instruction: call.getString("instruction") ?? "",
            street: call.getString("street") ?? "",
            toTurn: call.getString("toTurn") ?? "",
            distance: call.getString("distance") ?? "",
            pace: call.getString("pace") ?? "",
            elapsed: call.getString("elapsed") ?? "",
            offRoute: call.getBool("offRoute") ?? false,
            symbol: call.getString("symbol") ?? "figure.run")
    }
    #endif

    @objc func start(_ call: CAPPluginCall) {
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { call.resolve(["supported": false, "reason": "disabled"]); return }
            // One run at a time: a leftover from a crashed run is ended first.
            for a in Activity<RunActivityAttributes>.activities { Task { await a.end(dismissalPolicy: .immediate) } }
            let attributes = RunActivityAttributes(routeName: call.getString("routeName") ?? "RunTheTown")
            do {
                LiveActivityPlugin.current = try Activity.request(attributes: attributes, contentState: state(from: call), pushType: nil)
                call.resolve(["supported": true])
            } catch {
                call.resolve(["supported": false, "reason": error.localizedDescription])
            }
            return
        }
        #endif
        call.resolve(["supported": false, "reason": "iOS 16.1 needed"])
    }

    @objc func update(_ call: CAPPluginCall) {
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *), let a = LiveActivityPlugin.current {
            let s = state(from: call)
            Task { await a.update(using: s); call.resolve(["updated": true]) }
            return
        }
        #endif
        call.resolve(["updated": false])
    }

    @objc func end(_ call: CAPPluginCall) {
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *), let a = LiveActivityPlugin.current {
            let s = state(from: call)
            LiveActivityPlugin.current = nil
            // The final figures stay on the Lock Screen a little while, then go.
            Task { await a.end(using: s, dismissalPolicy: .after(.now + 15 * 60)); call.resolve(["ended": true]) }
            return
        }
        #endif
        call.resolve(["ended": false])
    }
}
