import AppKit
import Sparkle

/// A profile clone can share the official bundle ID. Prefer the standard installation for slot 1.
func telaDefaultDesktopApplicationURL(applicationDirectories: [URL] = FileManager.default.urls(for: .applicationDirectory, in: .localDomainMask)
    + FileManager.default.urls(for: .applicationDirectory, in: .userDomainMask),
  registeredApplications: (String) -> [URL] = { NSWorkspace.shared.urlsForApplications(withBundleIdentifier: $0) }) -> URL? {
  let candidates = registeredApplications("com.openai.codex")
  for directory in applicationDirectories {
    let matches = candidates.filter { $0.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL }
    if matches.count == 1 { return matches.first }
    if matches.count > 1 { return nil }
  }
  return candidates.count == 1 ? candidates.first : nil
}

/// Standard Launch Services open/reopen; no Tela connection or profile mutation is involved.
func openTelaDesktopApplication(at url: URL, activates: Bool, completion: @escaping (Error?) -> Void) {
  let expected = url.standardizedFileURL.resolvingSymlinksInPath()
  if let running = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == expected
  }) {
    let success = !activates || running.activate(options: [.activateAllWindows])
    recordMenuDiagnostic("desktop_open_existing", fields: ["success": success, "sameApplication": true, "activationPolicy": running.activationPolicy.rawValue])
    completion(success ? nil : NSError(domain: "TelaDesktopOpen", code: 2)); return
  }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = activates
  // Profile clones share a bundle ID. Without a new instance Launch Services
  // can return a different running clone even when given this exact app URL.
  configuration.createsNewApplicationInstance = true
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
    let matches = app?.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == expected
    recordMenuDiagnostic("desktop_open_completed", fields: ["success": error == nil && matches,
      "appPresent": app != nil, "sameApplication": matches, "activationPolicy": app?.activationPolicy.rawValue ?? -1,
      "errorDomain": (error as NSError?)?.domain ?? "none", "errorCode": (error as NSError?)?.code ?? 0])
    completion(error ?? (matches ? nil : NSError(domain: "TelaDesktopOpen", code: 3)))
  }
}

struct TelaDesktopProfile: Codable, Equatable {
  let slot: Int
  let targetId: String
}

private struct TelaDesktopSnapshot: Decodable { let profiles: [TelaDesktopProfile] }
private struct TelaDesktopLaunch: Decodable { let state: String; let desktopProcessId: Int32? }

private func runTelaDesktopCommand(_ arguments: [String]) throws -> Data {
  guard let launcher = Bundle.main.url(forAuxiliaryExecutable: "chatgpt-tela") else {
    throw NSError(domain: "TelaDesktopOpen", code: 4)
  }
  let process = Process(), output = Pipe()
  process.executableURL = launcher; process.arguments = ["desktop-app"] + arguments
  process.standardInput = FileHandle.nullDevice; process.standardOutput = output; process.standardError = FileHandle.nullDevice
  try process.run()
  let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
  guard process.terminationStatus == 0 else { throw NSError(domain: "TelaDesktopOpen", code: Int(process.terminationStatus)) }
  return data
}

func openTelaDesktopProfile(_ profile: TelaDesktopProfile, activates: Bool, completion: @escaping (Error?) -> Void) {
  if profile.slot == 1 {
    guard let url = telaDefaultDesktopApplicationURL() else {
      completion(NSError(domain: "TelaDesktopOpen", code: 5)); return
    }
    openTelaDesktopApplication(at: url, activates: activates, completion: completion)
    return
  }
  Task.detached {
    do {
      let data = try runTelaDesktopCommand(["open", "--slot", String(profile.slot), "--target", profile.targetId])
      let result = try JSONDecoder().decode(TelaDesktopLaunch.self, from: data)
      DispatchQueue.main.async {
        let accepted = !activates || (result.desktopProcessId.map {
          NSRunningApplication(processIdentifier: $0)?.activate(options: [.activateAllWindows]) == true
        } ?? (result.state == "launch-requested"))
        recordMenuDiagnostic("profile_owner_open", fields: ["slot": profile.slot, "state": result.state, "accepted": accepted,
          "activationPolicy": result.desktopProcessId.flatMap { NSRunningApplication(processIdentifier: $0)?.activationPolicy.rawValue } ?? -1])
        completion(accepted ? nil : NSError(domain: "TelaDesktopOpen", code: 6))
      }
    } catch {
      DispatchQueue.main.async {
        recordMenuDiagnostic("profile_owner_open_failed", fields: ["slot": profile.slot, "errorCode": (error as NSError).code])
        completion(error)
      }
    }
  }
}

/// Sparkle owns all update transport, verification, replacement and standard presentation.
@MainActor
final class TelaSparkleUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  private(set) var availableVersion: String?
  private(set) var problem: String?
  private(set) var recoveredPendingUpdate = false
  var changed: (() -> Void)?
  var runningDesktopProfiles: () throws -> [TelaDesktopProfile] = {
    try JSONDecoder().decode(TelaDesktopSnapshot.self, from: runTelaDesktopCommand(["snapshot"])).profiles
  }
  var reopenDesktop: (TelaDesktopProfile, @escaping (Error?) -> Void) -> Void = { profile, completion in
    openTelaDesktopProfile(profile, activates: false, completion: completion)
  }
  private static let desktopRestoreKey = "TelaUpdateDesktopProfiles"

  func preserveDesktopApps(targetBuild: String) {
    // Retire the URL-only snapshot: a derived app URL cannot restore profile isolation.
    UserDefaults.standard.removeObject(forKey: "TelaUpdateDesktopRestore")
    do {
      let profiles = try runningDesktopProfiles()
      UserDefaults.standard.set(["targetBuild": targetBuild,
        "profiles": profiles.map { ["slot": $0.slot, "targetId": $0.targetId] as [String: Any] }], forKey: Self.desktopRestoreKey)
      recordMenuDiagnostic("desktop_restore_captured", fields: ["count": profiles.count, "targetBuild": targetBuild])
    } catch {
      UserDefaults.standard.removeObject(forKey: Self.desktopRestoreKey)
      recordMenuDiagnostic("desktop_restore_capture_failed", fields: ["errorCode": (error as NSError).code])
    }
  }

  func restoreDesktopApps(forBuild expectedBuild: String? = nil) {
    let retiredSnapshot = UserDefaults.standard.object(forKey: "TelaUpdateDesktopRestore") != nil
    UserDefaults.standard.removeObject(forKey: "TelaUpdateDesktopRestore")
    guard let saved = UserDefaults.standard.dictionary(forKey: Self.desktopRestoreKey),
      let build = saved["targetBuild"] as? String,
      build == (expectedBuild ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String),
      let rows = saved["profiles"], let data = try? JSONSerialization.data(withJSONObject: rows),
      let profiles = try? JSONDecoder().decode([TelaDesktopProfile].self, from: data) else {
      recordMenuDiagnostic("desktop_restore_skipped", fields: ["snapshotPresent": UserDefaults.standard.object(forKey: Self.desktopRestoreKey) != nil, "retiredSnapshot": retiredSnapshot])
      return
    }
    UserDefaults.standard.removeObject(forKey: Self.desktopRestoreKey)
    let running = (try? runningDesktopProfiles()) ?? []
    let missing = profiles.filter { !running.contains($0) }
    recordMenuDiagnostic("desktop_restore_started", fields: ["count": missing.count, "alreadyRunning": profiles.count - missing.count])
    for profile in missing {
      reopenDesktop(profile) { [weak self] error in
        guard error != nil else { return }
        Task { @MainActor in
          self?.problem = "Couldn't reopen ChatGPT. Open it from Applications."
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
    preserveDesktopApps(targetBuild: build)
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
            alert.informativeText = "Finish any work before continuing."
            alert.addButton(withTitle: "Close and Update")
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
          if failure != nil, let build = self.pendingBuild { self.restoreDesktopApps(forBuild: build) }
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
      let detail = value?["blockedReason"] as? String == "native_activity_unobservable"
        ? "ChatGPT is open, but Tela cannot check whether its Native work is idle. This does not mean running work was detected."
        : "\(name) is not ready for this update. Finish any work before continuing; ChatGPT may need to close."
      throw NSError(domain: "TelaUpdateBusy", code: 1,
        userInfo: [NSLocalizedDescriptionKey: detail])
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
    let abortedBuild = pendingBuild
    idleObservation?.cancel()
    idleObservation = nil
    pendingBuild = nil
    preparingTermination = false
    preparationWindow?.close()
    preparationWindow = nil
    problem = error.localizedDescription
    changed?()
    guard ownedInstallation else { return }
    Task {
      do {
        _ = try await lifecycle(["cancel"]); recoveredPendingUpdate = false
        if let build = abortedBuild { restoreDesktopApps(forBuild: build) }
      }
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
