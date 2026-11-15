import Foundation
import Capacitor
import HealthKit
import CoreLocation

// Apple Health: a finished run is saved as a running workout (distance, time, the route),
// so it counts in the Health app's activity and in anything that reads Health. The first
// call asks the runner's permission with the system sheet; "not now" is remembered by iOS.
@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveRun", returnType: CAPPluginReturnPromise),
    ]
    private let store = HKHealthStore()

    private var shareTypes: Set<HKSampleType> {
        var set: Set<HKSampleType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
        if let d = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) { set.insert(d) }
        if let e = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { set.insert(e) }
        return set
    }

    @objc func available(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["granted": false]); return }
        store.requestAuthorization(toShare: shareTypes, read: []) { ok, error in
            if let error = error { call.reject(error.localizedDescription); return }
            // Whether the runner allowed sharing is private to iOS; the workout status says it.
            let status = self.store.authorizationStatus(for: HKObjectType.workoutType())
            call.resolve(["granted": ok && status == .sharingAuthorized])
        }
    }

    // { start: ISO 8601, end: ISO 8601, distance: m, elapsed: ms, route: [[lat, lon, secondsSinceStart], …], name }
    @objc func saveRun(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["saved": false, "reason": "no health"]); return }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()
        guard let startS = call.getString("start"), let start = iso.date(from: startS) ?? isoPlain.date(from: startS) else { call.reject("start missing"); return }
        let elapsedMs = call.getDouble("elapsed") ?? 0
        let distance = call.getDouble("distance") ?? 0
        let end = (call.getString("end").flatMap { iso.date(from: $0) ?? isoPlain.date(from: $0) }) ?? start.addingTimeInterval(max(1, elapsedMs / 1000))
        let route = call.getArray("route") as? [[Double]] ?? []

        store.requestAuthorization(toShare: shareTypes, read: []) { ok, error in
            if let error = error { call.reject(error.localizedDescription); return }
            guard ok, self.store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized else {
                call.resolve(["saved": false, "reason": "not allowed"]); return
            }
            let config = HKWorkoutConfiguration()
            config.activityType = .running
            config.locationType = .outdoor
            let builder = HKWorkoutBuilder(healthStore: self.store, configuration: config, device: .local())
            builder.beginCollection(withStart: start) { began, error in
                guard began else { call.reject(error?.localizedDescription ?? "could not begin"); return }
                var samples: [HKSample] = []
                if distance > 0, let type = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) {
                    samples.append(HKQuantitySample(type: type, quantity: HKQuantity(unit: .meter(), doubleValue: distance), start: start, end: end))
                }
                // Energy: a plain running estimate (about one kilocalorie per kilogram and kilometre,
                // at an assumed 70 kg) so the ring moves; Health shows it as the app's estimate.
                if distance > 0, let type = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) {
                    samples.append(HKQuantitySample(type: type, quantity: HKQuantity(unit: .kilocalorie(), doubleValue: distance / 1000 * 70), start: start, end: end))
                }
                let finish = {
                    builder.endCollection(withEnd: end) { _, error in
                        if let error = error { call.reject(error.localizedDescription); return }
                        builder.finishWorkout { workout, error in
                            guard let workout = workout else { call.reject(error?.localizedDescription ?? "could not finish"); return }
                            self.attachRoute(route, start: start, to: workout) { call.resolve(["saved": true]) }
                        }
                    }
                }
                if samples.isEmpty { finish() } else { builder.add(samples) { _, _ in finish() } }
            }
        }
    }

    private func attachRoute(_ route: [[Double]], start: Date, to workout: HKWorkout, done: @escaping () -> Void) {
        let locations: [CLLocation] = route.compactMap { p in
            guard p.count >= 2 else { return nil }
            let t = p.count >= 3 ? p[2] : 0
            return CLLocation(coordinate: CLLocationCoordinate2D(latitude: p[0], longitude: p[1]), altitude: 0, horizontalAccuracy: 10, verticalAccuracy: -1, timestamp: start.addingTimeInterval(t))
        }
        guard locations.count >= 2 else { done(); return }
        let rb = HKWorkoutRouteBuilder(healthStore: store, device: .local())
        rb.insertRouteData(locations) { ok, _ in
            guard ok else { done(); return }
            rb.finishRoute(with: workout, metadata: nil) { _, _ in done() }
        }
    }
}
