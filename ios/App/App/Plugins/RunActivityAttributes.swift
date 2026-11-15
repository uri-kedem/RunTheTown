import Foundation
#if canImport(ActivityKit)
import ActivityKit

// What the Lock Screen (and the Dynamic Island) shows during a run. Shared by the app,
// which updates it on every GPS fix, and the RunActivity extension, which draws it.
@available(iOS 16.1, *)
struct RunActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var instruction: String // "Turn right", "Off route", "Route complete"
        var street: String // the street turned onto, or a hint
        var toTurn: String // "350 m", "" when there is no next turn
        var distance: String // "4.21 km"
        var pace: String // "5:32 min/km"
        var elapsed: String // "23:40"
        var offRoute: Bool
        var symbol: String // SF Symbol for the instruction: arrow.turn.up.left, arrow.up, flag.checkered…
    }
    var routeName: String
}
#endif
