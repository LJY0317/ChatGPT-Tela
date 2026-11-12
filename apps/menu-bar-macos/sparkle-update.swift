import AppKit
import Sparkle

/// A profile clone can share the official bundle ID. Prefer the standard installation for slot 1.
func telaDesktopApplicationURL(bundleId: String,
  applicationDirectories: [URL] = FileManager.default.urls(for: .applicationDirectory, in: .localDomainMask)
    + FileManager.default.urls(for: .applicationDirectory, in: .userDomainMask),
  registeredApplications: (String) -> [URL] = { NSWorkspace.shared.urlsForApplications(withBundleIdentifier: $0) }) -> URL? {
  if bundleId != "com.openai.codex" { return NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }
  let candidates = registeredApplications(bundleId)
  for directory in applicationDirectories {
    let matches = candidates.filter { $0.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL }
    if matches.count == 1 { return matches.first }
    if matches.count > 1 { return nil }
  }
  return candidates.count == 1 ? candidates.first : nil
}

/// Standard Launch Services open/reopen; no Tela connection or profile mutation is involved.
func openTelaDesktopApplication(at url: URL, activates: Bool, completion: @escaping (Error?) -> Void) {
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = activates
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
    NSLog("Tela desktop open completed success=%d app_present=%d domain=%@ code=%ld", error == nil ? 1 : 0, app == nil ? 0 : 1, (error as NSError?)?.domain ?? "none", (error as NSError?)?.code ?? 0)
    completion(error)
  }
}

/// Sparkle owns all update transport, verification, replacement and standard presentation.
@MainActor
final class TelaSparkleUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  private(set) var availableVersion: String?
  private(set) var problem: String?
  private(set) var recoveredPendingUpdate = false
  var changed: (() -> Void)?
  var desktopBundleIdentifiers: () -> [String] = { ["com.openai.codex"] }
  var runningDesktopApplications: ([String]) -> [String] = { ids in
    ids.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
      .compactMap { $0.bundleURL?.absoluteString }
  }
  var reopenDesktop: (String, @escaping (Error?) -> Void) -> Void = { value, completion in
    guard let url = URL(string: value), url.isFileURL else {
      completion(NSError(domain: "TelaDesktopOpen", code: 1)); return
    }
    openTelaDesktopApplication(at: url, activates: false, completion: completion)
  }
  private static let desktopRestoreKey = "TelaUpdateDesktopRestore"

  func preserveDesktopApps(targetBuild: String) {
    let urls = Array(Set(runningDesktopApplications(desktopBundleIdentifiers()))).sorted()
    UserDefaults.standard.set(["targetBuild": targetBuild, "applicationURLs": urls], forKey: Self.desktopRestoreKey)
    NSLog("Tela desktop restoration captured count=%d", urls.count)
  }

  func restoreDesktopApps() {
    guard let saved = UserDefaults.standard.dictionary(forKey: Self.desktopRestoreKey),
      let build = saved["targetBuild"] as? String,
      build == Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
      let urls = saved["applicationURLs"] as? [String] else { return }
    // Consume once before Launch Services callbacks; a failed open never creates an automatic retry.
    UserDefaults.standard.removeObject(forKey: Self.desktopRestoreKey)
    NSLog("Tela desktop restoration started count=%d", urls.count)
    for url in urls {
      reopenDesktop(url) { [weak self] error in
        guard error != nil else { return }
        Task { @MainActor in
          self?.problem = "Tela updated, but a ChatGPT app could not reopen. Open it from Applications."
          self?.changed?()
        }
      }
    }
  }
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

  var preparationStatus: String? { idleObservation != nil ? "Waiting to update…" : preparingTermination ? "Preparing update…" : nil }
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
    progress.setAccessibilityLabel(waiting ? "Waiting to update" : "Preparing update")
    let title = NSTextField(labelWithString: waiting ? "Waiting to update…" : "Preparing update…")
    title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    let detail = NSTextField(labelWithString: waiting ? "Waiting for Tela services to be ready." : "Tela will restart automatically.")
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
      if result.ready { restoreDesktopApps() }
      recoveredPendingUpdate = !result.ready && result.prepared
      problem = recoveredPendingUpdate ? "An update is prepared. Review it in Sparkle to see whether it can continue." : result.ready ? nil : "Finish the pending update to restart Tela."
      if recoveredPendingUpdate { NSLog("Tela update startup found a prepared Sparkle handoff; awaiting a new user-initiated update session") }
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
            alert.messageText = "Close ChatGPT and update?"
            alert.informativeText = error.localizedDescription + " ChatGPT will close. Any running work may be interrupted. Conversations and saved files are kept."
            alert.addButton(withTitle: "Close ChatGPT and Update")
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

  private nonisolated func lifecycle(_ arguments: [String], observation: UpdateIdleObservation? = nil) async throws -> (ready: Bool, restored: Bool, prepared: Bool) {
    guard let launcher = Bundle.main.url(forAuxiliaryExecutable: "chatgpt-tela") else {
      throw NSError(domain: "TelaUpdate", code: 1)
    }
    let payload = Bundle.main.bundleURL.path
    let outcome = await Task.detached { () -> (Int32, Data) in
      let task = observation?.process ?? Process()
      task.executableURL = launcher
      task.arguments = ["application-update"] + arguments + ["--payload", payload]
      let output = Pipe()
      // Only the read-only wait observes this UI's lifetime. When this UI
      // exits unexpectedly, its pipe closes and the observer can release its
      // pending readiness request without affecting user work.
      if observation != nil { task.standardInput = Pipe() }
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
        userInfo: [NSLocalizedDescriptionKey: "\(name) is not ready for this update. Finish any work before continuing; ChatGPT may need to close."])
    }
    guard outcome.0 == 0, let value,
      value["ready"] as? Bool == true || value["prepared"] as? Bool == true else {
      throw NSError(domain: "TelaUpdate", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Tela could not prepare its services for updating. Check service status and try again. Your conversations are kept."])
    }
    return (value["ready"] as? Bool == true, value["restored"] as? Bool == true, value["prepared"] as? Bool == true)
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
    preserveDesktopApps(targetBuild: item.versionString)
    recoveredPendingUpdate = false
    idleObservation = observation
    pendingBuild = item.versionString
    preparationWindow = Self.makePreparationWindow(waiting: true)
    preparationWindow?.center()
    preparationWindow?.makeKeyAndOrderFront(nil)
    changed?()
    NSLog("Tela update deferred by Sparkle; observing current work before invoking the install handler")
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
      NSLog("Tela update idle observation settled; invoking Sparkle install handler")
      installHandler()
    }
    return true
  }

  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { pendingBuild = item.versionString }

  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    // A newly created UI can encounter an unrelated Sparkle check failure.
    // It does not own a previous process's prepared service handoff.
    let ownedInstallation = pendingBuild != nil || preparingTermination
    idleObservation?.cancel()
    idleObservation = nil
    pendingBuild = nil
    preparingTermination = false
    preparationWindow?.close()
    preparationWindow = nil
    problem = error.localizedDescription
    changed?()
    guard ownedInstallation else { return }
    UserDefaults.standard.removeObject(forKey: Self.desktopRestoreKey)
    Task {
      do { _ = try await lifecycle(["cancel"]); recoveredPendingUpdate = false }
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
