import WidgetKit
import SwiftUI
import ActivityKit

// The Lock Screen card and the Dynamic Island during a run: the next turn big, the
// distance to it, then distance run, pace and time. Navy like the app, orange for the turn.
@main
struct RunActivityBundle: WidgetBundle {
    var body: some Widget {
        RunActivityWidget()
    }
}

struct RunActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunActivityAttributes.self) { context in
            LockScreenView(state: context.state, routeName: context.attributes.routeName)
                .activityBackgroundTint(Color(red: 0.06, green: 0.09, blue: 0.16))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.toTurn).font(.title2.bold()).foregroundColor(.orange)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.distance).font(.title3.bold())
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.instruction).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(context.state.street).lineLimit(1).font(.caption)
                        Spacer()
                        Text(context.state.pace).font(.caption)
                        Text(context.state.elapsed).font(.caption.monospacedDigit())
                    }
                }
            } compactLeading: {
                Image(systemName: context.state.symbol).foregroundColor(.orange)
            } compactTrailing: {
                Text(context.state.toTurn.isEmpty ? context.state.distance : context.state.toTurn).font(.caption.monospacedDigit())
            } minimal: {
                Image(systemName: "figure.run").foregroundColor(.orange)
            }
        }
    }
}

struct LockScreenView: View {
    let state: RunActivityAttributes.ContentState
    let routeName: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: state.symbol)
                    .font(.title2).foregroundColor(.orange)
                VStack(alignment: .leading, spacing: 0) {
                    Text(state.instruction).font(.title3.bold()).lineLimit(1)
                    if !state.street.isEmpty { Text(state.street).font(.subheadline).foregroundColor(.white.opacity(0.8)).lineLimit(1) }
                }
                Spacer()
                Text(state.toTurn).font(.title.bold().monospacedDigit()).foregroundColor(.orange)
            }
            HStack {
                stat(state.distance, "run")
                Spacer()
                stat(state.pace, "pace")
                Spacer()
                stat(state.elapsed, "time")
            }
            Text(routeName).font(.caption2).foregroundColor(.white.opacity(0.6)).lineLimit(1)
        }
        .padding(14)
        .foregroundColor(.white)
    }
    func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 0) {
            Text(value).font(.headline.monospacedDigit())
            Text(label).font(.caption2).foregroundColor(.white.opacity(0.6))
        }
    }
}
