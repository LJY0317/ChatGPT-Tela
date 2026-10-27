import AppKit

@main
struct TelaMaintenanceMain {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = TelaMaintenanceController()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
