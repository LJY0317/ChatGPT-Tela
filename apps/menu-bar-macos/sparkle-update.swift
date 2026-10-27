import AppKit
import Sparkle

/// Sparkle owns all update transport, verification, replacement and standard presentation.
@MainActor
final class TelaSparkleUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  private(set) var availableVersion: String?
  private(set) var downloaded = false
  private(set) var problem: String?
  var changed: (() -> Void)?
  private var pendingBuild: String?
  private var preparingTermination = false
  private var controller: SPUStandardUpdaterController!

  override init() {
    super.init()
    controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: self)
  }

  var automaticallyChecksForUpdates: Bool {
    get { controller.updater.automaticallyChecksForUpdates }
    set { controller.updater.automaticallyChecksForUpdates = newValue }
  }

  var canCheck: Bool { controller.updater.canCheckForUpdates || controller.updater.sessionInProgress }
  func checkForUpdates(_ sender: Any?) { controller.checkForUpdates(sender) }

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
    guard let build = pendingBuild else { return .terminateNow }
    guard !preparingTermination else { return .terminateLater }
    preparingTermination = true
    Task {
      do {
        let arguments = ["prepare", "--target-build", build]
        do { _ = try await lifecycle(arguments) }
        catch let error as NSError where error.domain == "TelaUpdateBusy" {
          let alert = NSAlert()
          alert.messageText = "Stop tasks and update?"
          alert.informativeText = error.localizedDescription + " Running tasks will be interrupted. Conversations and saved files are kept."
          alert.addButton(withTitle: "Stop Tasks and Update")
          alert.addButton(withTitle: "Later")
          guard alert.runModal() == .alertFirstButtonReturn else { throw CancellationError() }
          _ = try await lifecycle(arguments + ["--interrupt-work"])
        }
        problem = nil
        app.reply(toApplicationShouldTerminate: true)
      } catch {
        preparingTermination = false
        app.reply(toApplicationShouldTerminate: false)
        changed?()
        if error is CancellationError { return }
        problem = error.localizedDescription
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
    problem = error.localizedDescription
    Task {
      do { _ = try await lifecycle(["cancel"]) }
      catch { problem = "Tela recovery needs attention before updating." }
      changed?()
    }
  }
}
