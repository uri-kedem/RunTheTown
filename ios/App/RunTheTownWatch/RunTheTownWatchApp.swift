import SwiftUI
import WatchKit
import HealthKit

// RunTheTown on the wrist: the next turn, how far it is, and the run's figures, sent by the
// iPhone app during a run; each turn is felt as a tap. The watch plans nothing and stores
// nothing: the phone does the work, the watch shows and taps.
@main
struct RunTheTownWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchDelegate.self) var delegate
    @StateObject private var run = RunSession.shared

    var body: some Scene {
        WindowGroup {
            RunView().environmentObject(run)
        }
    }
}

final class WatchDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        RunSession.shared.activate()
    }

    // The iPhone started a run and woke this app with a workout configuration. A workout
    // session is what lets a watch app keep running, and tapping, with the wrist down.
    func handle(_ workoutConfiguration: HKWorkoutConfiguration) {
        RunSession.shared.startWorkout(workoutConfiguration)
    }
}
