import AppKit
import Sparkle

/// Sparkle owns all update transport, verification, replacement and standard presentation.
@MainActor
final class TelaSparkleUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  private(set) var availableVersion: String?
  private(set) var problem: String?
  var changed: (() -> Void)?
  private var pendingBuild: String?
  private var preparingTermination = false
  private var idleObservation: UpdateIdleObservation?
  private var preparationWindow: NSPanel?
  private var controller: SPUStandardUpdaterController!

  override init() {
    super.init()
    controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: self)
  }

  var automaticallyChecksForUpdates: Bool {
    get { controller.updater.automaticallyChecksForUpdates }
    set { controller.updater.automaticallyChecksForUpdates = newValue }
  }

  var preparationStatus: String? { idleObservation != nil ? "Waiting for tasks to finish…" : preparingTermination ? "Preparing update…" : nil }
  var canCheck: Bool { !preparingTermination && idleObservation == nil && (controller.updater.canCheckForUpdates || controller.updater.sessionInProgress) }
  func checkForUpdates(_ sender: Any?) { controller.checkForUpdates(sender) }

  private static func makePreparationWindow(waiting: Bool = false) -> NSPanel {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 110),
                        styleMask: [.titled], backing: .buffered, defer: false)
    panel.title = "Updating Tela"
    panel.isReleasedWhenClosed = false
    let progress = NSProgressIndicator()
    progress.style = .spinning
    progress.isIndeterminate = true
    progress.controlSize = .small
    progress.sizeToFit()
    progress.setAccessibilityLabel(waiting ? "Waiting for tasks to finish" : "Preparing update")
    let title = NSTextField(labelWithString: waiting ? "Waiting for tasks to finish…" : "Preparing update…")
    title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    let detail = NSTextField(labelWithString: waiting ? "Tela will update when your tasks finish." : "Tela will restart automatically.")
    detail.textColor = .secondaryLabelColor
    let text = NSStackView(views: [title, detail])
    text.orientation = .vertical
    text.alignment = .leading
    let content = NSStackView(views: [progress, text])
    content.spacing = 16
    content.translatesAutoresizingMaskIntoConstraints = false
    panel.contentView!.addSubview(content)
    NSLayoutConstraint.activate([
      content.centerXAnchor.constraint(equalTo: panel.contentView!.centerXAnchor),
      content.centerYAnchor.constraint(equalTo: panel.contentView!.centerYAnchor),
    ])
    progress.startAnimation(nil)
    return panel
  }

  /// Resume ordinary startup only when no update restoration already chose the running services.
  func start() async -> Bool {
    do {
      let result = try await lifecycle(["finish"])
      try controller.updater.start()
      problem = result.ready ? nil : "Finish the pending update to restart Tela."
      changed?()
      return result.ready && !result.restored
    } catch {
      problem = "Tela recovery needs attention before updating."
      changed?()
      return false
    }
  }

  /// This is the ordinary AppKit termination veto; optional relaunch callbacks are not the work guard.
  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    guard idleObservation == nil else { return .terminateCancel }
    guard let build = pendingBuild else { return .terminateNow }
    guard !preparingTermination else { return .terminateLater }
    preparingTermination = true
    problem = nil
    preparationWindow = Self.makePreparationWindow()
    preparationWindow?.center()
    preparationWindow?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    changed?()
    let started = ProcessInfo.processInfo.systemUptime
    NSLog("Tela update preparation started for build %@", build)
    prepareTermination(["prepare", "--target-build", build], app: app, started: started)
    return .terminateLater
  }

  private func prepareTermination(_ arguments: [String], app: NSApplication, started: TimeInterval) {
    // terminateLater runs a modal loop; Swift's main-actor task queue is not
    // serviced there. Run IPC off-main and return through that exact run loop.
    Task.detached {
      let result: Result<Void, Error>
      do { _ = try await self.lifecycle(arguments); result = .success(()) }
      catch { result = .failure(error) }
      RunLoop.main.perform(inModes: [.default, .modalPanel]) {
        MainActor.assumeIsolated {
          var failure: Error?
          if case .failure(let error) = result { failure = error }
          if let error = failure as NSError?, error.domain == "TelaUpdateBusy", !arguments.contains("--interrupt-work") {
            self.preparationWindow?.orderOut(nil)
            let alert = NSAlert()
            alert.messageText = "Stop tasks and update?"
            alert.informativeText = error.localizedDescription + " Running tasks will be interrupted. Conversations and saved files are kept."
            alert.addButton(withTitle: "Stop Tasks and Update")
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn {
              self.preparationWindow?.makeKeyAndOrderFront(nil)
              self.prepareTermination(arguments + ["--interrupt-work"], app: app, started: started)
              return
            }
            failure = CancellationError()
          }
          self.preparationWindow?.close()
          self.preparationWindow = nil
          NSLog("Tela update preparation ended after %.3f seconds", ProcessInfo.processInfo.systemUptime - started)
          self.preparingTermination = failure == nil
          self.problem = failure is CancellationError ? nil : failure?.localizedDescription
          app.reply(toApplicationShouldTerminate: failure == nil)
          self.changed?()
          if let error = failure, !(error is CancellationError) {
            let alert = NSAlert()
            alert.messageText = "Update postponed"
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "OK")
            alert.runModal()
          }
        }
      }
    }
  }

  private nonisolated func lifecycle(_ arguments: [String], observation: UpdateIdleObservation? = nil) async throws -> (ready: Bool, restored: Bool) {
    guard let launcher = Bundle.main.url(forAuxiliaryExecutable: "chatgpt-tela") else {
      throw NSError(domain: "TelaUpdate", code: 1)
    }
    let payload = Bundle.main.bundleURL.path
    let outcome = await Task.detached { () -> (Int32, Data) in
      let task = observation?.process ?? Process()
      task.executableURL = launcher
      task.arguments = ["application-update"] + arguments + ["--payload", payload]
      let output = Pipe()
      task.standardOutput = output
      task.standardError = FileHandle.standardError
      do {
        if let observation { try observation.start() } else { try task.run() }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return (task.terminationStatus, data)
      } catch { return (1, Data()) }
    }.value
    let value = (try? JSONSerialization.jsonObject(with: outcome.1)) as? [String: Any]
    if let service = value?["blockedService"] as? String,
      let name = ["chat": "Tela Chat", "codex": "Work / Codex", "gateway": "Tela Gateway"][service] {
      throw NSError(domain: "TelaUpdateBusy", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "\(name) has running or unsettled tasks."])
    }
    guard outcome.0 == 0, let value,
      value["ready"] as? Bool == true || value["prepared"] as? Bool == true else {
      throw NSError(domain: "TelaUpdate", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Tela could not prepare its services for updating. Check service status and try again. Your conversations are kept."])
    }
    return (value["ready"] as? Bool == true, value["restored"] as? Bool == true)
  }

  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    availableVersion = item.displayVersionString
    changed?()
  }

  func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
    availableVersion = nil
    changed?()
  }

  nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
    let version = update.displayVersionString
    Task { @MainActor [weak self] in
      self?.availableVersion = version
      self?.changed?()
    }
  }

  /// Defer through Sparkle before it asks AppKit to terminate or launches replacement.
  func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
               untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
    let observation = UpdateIdleObservation()
    idleObservation = observation
    pendingBuild = item.versionString
    preparationWindow = Self.makePreparationWindow(waiting: true)
    preparationWindow?.center()
    preparationWindow?.makeKeyAndOrderFront(nil)
    changed?()
    Task {
      do { _ = try await lifecycle(["wait"], observation: observation) }
      catch { NSLog("Tela update idle observation ended; ordinary shutdown admission will decide: %@", error.localizedDescription) }
      guard idleObservation === observation else { return }
      idleObservation = nil
      preparationWindow?.close()
      preparationWindow = nil
      changed?()
      // Admission remains mandatory, including when this optional observation
      // is unavailable or new work was admitted after its last snapshot.
      installHandler()
    }
    return true
  }

  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { pendingBuild = item.versionString }

  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    idleObservation?.cancel()
    idleObservation = nil
    pendingBuild = nil
    preparingTermination = false
    preparationWindow?.close()
    preparationWindow = nil
    problem = error.localizedDescription
    changed?()
    Task {
      do { _ = try await lifecycle(["cancel"]) }
      catch { problem = "Tela recovery needs attention before updating." }
      changed?()
    }
  }
}


/// Cancellation owns only the read-only wait process, never a task or update worker.
private final class UpdateIdleObservation: @unchecked Sendable {
  let process = Process()
  private let lock = NSLock()
  private var cancelled = false

  func start() throws {
    lock.lock()
    defer { lock.unlock() }
    if cancelled { throw CancellationError() }
    try process.run()
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    cancelled = true
    if process.isRunning { process.terminate() }
  }
}
