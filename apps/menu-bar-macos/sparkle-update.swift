import AppKit
import Sparkle

/// Keep Sparkle's standard UI and expose only its live, cancellable installation choice.
@MainActor
final class TelaSparkleUserDriver: SPUStandardUserDriver {
  private var installationReply: ((SPUUserUpdateChoice) -> Void)?
  var choiceChanged: (() -> Void)?
  var canDiscardDownload: Bool { installationReply != nil }

  private func installationChoice(_ reply: @escaping (SPUUserUpdateChoice) -> Void) -> (SPUUserUpdateChoice) -> Void {
    var pendingReply: ((SPUUserUpdateChoice) -> Void)? = reply
    let respond: (SPUUserUpdateChoice) -> Void = { [weak self] choice in
      guard let reply = pendingReply else { return }
      pendingReply = nil
      self?.installationReply = nil
      self?.choiceChanged?()
      reply(choice)
    }
    installationReply = respond
    choiceChanged?()
    return respond
  }

  override func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void) {
    super.showUpdateFound(with: appcastItem, state: state,
      reply: state.stage == .notDownloaded ? reply : installationChoice(reply))
  }

  override func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    super.showReady(toInstallAndRelaunch: installationChoice(reply))
  }

  func discardDownload() {
    guard let reply = installationReply else { return }
    installationReply = nil
    super.dismissUpdateInstallation()
    choiceChanged?()
    // Sparkle owns cancellation and file removal; the following explicit check clears skipped versions.
    reply(.skip)
  }

  override func dismissUpdateInstallation() {
    installationReply = nil
    choiceChanged?()
    super.dismissUpdateInstallation()
  }

  override func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool,
    retryTerminatingApplication: @escaping () -> Void) {
    installationReply = nil
    choiceChanged?()
    super.showInstallingUpdate(withApplicationTerminated: applicationTerminated,
      retryTerminatingApplication: retryTerminatingApplication)
  }
}

/// Sparkle owns all update transport, verification, replacement and standard presentation.
@MainActor
final class TelaSparkleUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  private(set) var availableVersion: String?
  private(set) var downloaded = false
  private(set) var problem: String?
  var changed: (() -> Void)?
  private var pendingBuild: String?
  private var preparingTermination = false
  private var preparationWindow: NSPanel?
  private var updater: SPUUpdater!
  private var userDriver: TelaSparkleUserDriver!
  private var checkAfterDiscard = false

  override init() {
    super.init()
    userDriver = TelaSparkleUserDriver(hostBundle: .main, delegate: self)
    updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: userDriver, delegate: self)
    userDriver.choiceChanged = { [weak self] in self?.changed?() }
  }

  var automaticallyChecksForUpdates: Bool {
    get { updater.automaticallyChecksForUpdates }
    set { updater.automaticallyChecksForUpdates = newValue }
  }

  var preparationStatus: String? { preparingTermination ? "Preparing update…" : nil }
  var canCheck: Bool { !preparingTermination && !checkAfterDiscard && (updater.canCheckForUpdates || updater.sessionInProgress) }
  var canDiscardDownload: Bool { !preparingTermination && !checkAfterDiscard && userDriver.canDiscardDownload }
  func checkForUpdates(_ sender: Any?) { updater.checkForUpdates() }

  func discardDownloadAndCheckAgain() {
    guard canDiscardDownload else { return }
    checkAfterDiscard = true
    userDriver.discardDownload()
  }

  private static func makePreparationWindow() -> NSPanel {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 110),
                        styleMask: [.titled], backing: .buffered, defer: false)
    panel.title = "Updating Tela"
    panel.isReleasedWhenClosed = false
    let progress = NSProgressIndicator()
    progress.style = .spinning
    progress.isIndeterminate = true
    progress.controlSize = .small
    progress.sizeToFit()
    progress.setAccessibilityLabel("Preparing update")
    let title = NSTextField(labelWithString: "Preparing update…")
    title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    let detail = NSTextField(labelWithString: "Tela will restart automatically.")
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
      try updater.start()
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
    Task {
      defer {
        preparationWindow?.close()
        preparationWindow = nil
        NSLog("Tela update preparation ended after %.3f seconds", ProcessInfo.processInfo.systemUptime - started)
      }
      do {
        let arguments = ["prepare", "--target-build", build]
        do { _ = try await lifecycle(arguments) }
        catch let error as NSError where error.domain == "TelaUpdateBusy" {
          preparationWindow?.orderOut(nil)
          let alert = NSAlert()
          alert.messageText = "Stop tasks and update?"
          alert.informativeText = error.localizedDescription + " Running tasks will be interrupted. Conversations and saved files are kept."
          alert.addButton(withTitle: "Stop Tasks and Update")
          alert.addButton(withTitle: "Later")
          guard alert.runModal() == .alertFirstButtonReturn else { throw CancellationError() }
          preparationWindow?.makeKeyAndOrderFront(nil)
          _ = try await lifecycle(arguments + ["--interrupt-work"])
        }
        problem = nil
        app.reply(toApplicationShouldTerminate: true)
      } catch {
        preparingTermination = false
        app.reply(toApplicationShouldTerminate: false)
        if error is CancellationError { changed?(); return }
        preparationWindow?.orderOut(nil)
        problem = error.localizedDescription
        changed?()
        let alert = NSAlert()
        alert.messageText = "Update postponed"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.runModal()
      }
    }
    return .terminateLater
  }

  private func lifecycle(_ arguments: [String]) async throws -> (ready: Bool, restored: Bool) {
    guard let launcher = Bundle.main.url(forAuxiliaryExecutable: "chatgpt-tela") else {
      throw NSError(domain: "TelaUpdate", code: 1)
    }
    let payload = Bundle.main.bundleURL.path
    let outcome = await Task.detached { () -> (Int32, Data) in
      let task = Process()
      task.executableURL = launcher
      task.arguments = ["application-update"] + arguments + ["--payload", payload]
      let output = Pipe()
      task.standardOutput = output
      task.standardError = FileHandle.standardError
      do {
        try task.run()
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
    if availableVersion != item.displayVersionString { downloaded = false }
    availableVersion = item.displayVersionString
    changed?()
  }

  func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
    availableVersion = nil
    downloaded = false
    changed?()
  }

  nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
    let version = update.displayVersionString, downloaded = state.stage != .notDownloaded
    Task { @MainActor [weak self] in
      self?.availableVersion = version
      self?.downloaded = downloaded
      self?.changed?()
    }
  }

  func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) {
    downloaded = true
    changed?()
  }

  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { pendingBuild = item.versionString }

  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    pendingBuild = nil
    preparingTermination = false
    preparationWindow?.close()
    preparationWindow = nil
    problem = error.localizedDescription
    changed?()
  }

  func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
    guard error != nil || checkAfterDiscard else { return }
    Task {
      do { _ = try await lifecycle(["cancel"]) }
      catch {
        checkAfterDiscard = false
        problem = "Tela recovery needs attention before updating."
        changed?()
        return
      }
      if checkAfterDiscard {
        checkAfterDiscard = false
        pendingBuild = nil
        availableVersion = nil
        downloaded = false
        problem = nil
        updater.checkForUpdates()
      }
      changed?()
    }
  }
}
