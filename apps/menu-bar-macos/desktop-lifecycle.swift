import AppKit

/// Observe the Desktop itself, including transitions to background mode. Workspace
/// launch/terminate notifications alone omit LSUIElement applications.
final class TelaDesktopLifecycleObserver {
  private var inventory: NSKeyValueObservation?
  private var applications: [pid_t: NSRunningApplication] = [:]
  private var observations: [pid_t: [NSKeyValueObservation]] = [:]
  private let emit: (String, [String: Any]) -> Void
  private let terminated: () -> Void

  init(emit: @escaping (String, [String: Any]) -> Void, terminated: @escaping () -> Void) {
    self.emit = emit
    self.terminated = terminated
    inventory = NSWorkspace.shared.observe(\.runningApplications, options: [.initial, .new]) { [weak self] workspace, _ in
      DispatchQueue.main.async { self?.update(workspace.runningApplications) }
    }
  }

  func stop() {
    inventory = nil
    observations.removeAll()
    applications.removeAll()
  }

  private func update(_ running: [NSRunningApplication]) {
    // All supported official Desktop installations share this identity. Never
    // persist the workspace inventory, app paths, titles, or unrelated apps.
    let current = Dictionary(uniqueKeysWithValues: running
      .filter { $0.bundleIdentifier == "com.openai.codex" }
      .map { ($0.processIdentifier, $0) })
    for (pid, app) in applications where current[pid] == nil {
      emit("desktop_inventory_removed", fields(app))
      if app.isTerminated { terminated() }
      observations.removeValue(forKey: pid)
    }
    for (pid, app) in current where applications[pid] == nil {
      emit("desktop_inventory_observed", fields(app))
      observations[pid] = [
        app.observe(\.activationPolicy, options: [.new]) { [weak self] app, _ in
          DispatchQueue.main.async { guard let self else { return }; self.emit("desktop_activation_policy_changed", self.fields(app)) }
        },
        app.observe(\.isTerminated, options: [.new]) { [weak self] app, _ in
          DispatchQueue.main.async {
            guard let self else { return }
            self.emit("desktop_termination_changed", self.fields(app))
            if app.isTerminated { self.terminated() }
          }
        }
      ]
    }
    applications = current
  }

  private func fields(_ app: NSRunningApplication) -> [String: Any] {
    ["pid": Int(app.processIdentifier), "activationPolicy": app.activationPolicy.rawValue,
     "terminated": app.isTerminated]
  }
}
