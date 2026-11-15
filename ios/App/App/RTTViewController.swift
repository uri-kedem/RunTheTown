import UIKit
import Capacitor

// The web view's controller: Capacitor's, plus RunTheTown's own plugins, which live in
// this project rather than in npm packages (Plugins/). They are registered here, before
// the page loads, so the JavaScript can reach them as Capacitor.Plugins.<name>.
class RTTViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthPlugin())
        bridge?.registerPluginInstance(ChimePlugin())
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }
}
