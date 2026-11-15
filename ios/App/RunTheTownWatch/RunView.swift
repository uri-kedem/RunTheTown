import SwiftUI

// One screen: during a run the next turn (arrow, distance, what to do, the street) over the
// run's distance, pace and time; otherwise a line saying where runs start.
struct RunView: View {
    @EnvironmentObject var run: RunSession

    var body: some View {
        if run.active {
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .center) {
                        Image(systemName: run.symbol)
                            .font(.system(size: 32, weight: .bold))
                            .foregroundColor(run.offRoute ? .red : .orange)
                        Spacer()
                        Text(run.toTurn)
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundColor(.orange)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                    }
                    Text(run.instruction)
                        .font(.headline)
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                    if !run.street.isEmpty {
                        Text(run.street)
                            .font(.footnote)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    Divider().padding(.vertical, 2)
                    HStack {
                        Text(run.distance).font(.system(.body, design: .rounded).monospacedDigit())
                        Spacer()
                        Text(run.elapsed).font(.system(.body, design: .rounded).monospacedDigit())
                    }
                    Text(run.pace)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                    Button("Stop on watch") { run.finish() }
                        .font(.footnote)
                        .padding(.top, 6)
                }
                .padding(.horizontal, 4)
            }
        } else {
            VStack(spacing: 8) {
                Image(systemName: "figure.run")
                    .font(.largeTitle)
                    .foregroundColor(.orange)
                Text("RunTheTown").font(.headline)
                Text("Start a run on your iPhone. The turns will tap your wrist.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 6)
        }
    }
}
