#if canImport(TelaLocalization)
import TelaLocalization
#endif
import AppKit
import Foundation

private final class TelaMaintenanceDocumentView: NSView { override var isFlipped: Bool { true } }

private struct TelaMaintenanceResource: Decodable { let name: String; let action: String }
private struct TelaMaintenanceReview: Decodable {
  let operation: String
  let reviewToken: String
  let fromVersion: String
  let toVersion: String?
  let resources: [TelaMaintenanceResource]
  let blockers: [String]
}
private struct TelaMaintenanceResult: Decodable {
  let success: Bool
  let failedCount: Int
  let preservedCount: Int
  let blockers: [String]?
}
private struct TelaMaintenanceStatus: Decodable {
  let installedVersion: String
  let pendingTransition: String
}
private struct TelaMaintenanceProcess: Decodable {
  let workspaceId: String
  let workspaceName: String
  let operationId: String
  let sessionId: Int
  let startedAt: String
  let state: String
  let liveness: String
}
private struct TelaMaintenanceProcesses: Decodable { let processes: [TelaMaintenanceProcess] }

// A verified, temporary copy survives shutdown/removal of the installed menu bar.
// It calls the same launcher lifecycle engine and owns no service or install authority.
@MainActor
final class TelaMaintenanceController: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow!
  private let version = NSTextField(labelWithString: telaText("Checking installation…"))
  private let message = NSTextField(wrappingLabelWithString: "")
  private let nextStep = NSTextField(wrappingLabelWithString: "")
  private let planText = NSTextField(wrappingLabelWithString: telaText("Review an operation before applying it."))
  private let packageLabel = NSTextField(labelWithString: telaText("No package selected"))
  private let picker = NSPopUpButton()
  private let pluginManagement = NSButton(title: telaText("Open ChatGPT Plugins"), target: nil, action: nil)
  private let removeData = NSButton(checkboxWithTitle: telaText("Also remove Tela settings, saved logins, and credentials"), target: nil, action: nil)
  private let reviewButton = NSButton(title: telaText("Review changes"), target: nil, action: nil)
  private let applyButton = NSButton(title: telaText("Apply…"), target: nil, action: nil)
  private let packageButton = NSButton(title: telaText("Choose package…"), target: nil, action: nil)
  private let processPicker = NSPopUpButton()
  private let cancelProcessButton = NSButton(title: telaText("Cancel selected execution…"), target: nil, action: nil)
  private let processInfo = NSTextField(wrappingLabelWithString: "")
  private var unresolvedProcesses: [TelaMaintenanceProcess] = []
  private let progress = NSProgressIndicator()
  private let processSection = NSBox()
  private let packageSection = NSBox()
  private let removalSection = NSBox()
  private var package: URL?
  private var review: TelaMaintenanceReview?
  private var busy = false
  private var completedRemoval = false
  private var launcher: String { ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] ?? "" }
  private let operations = ["repair", "uninstall"]
  private var operation: String { operations[picker.indexOfSelectedItem] }
  private let operationHelp = NSTextField(wrappingLabelWithString: "")

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 660),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = telaText("Tela Maintenance")
    window.minSize = NSSize(width: 560, height: 520)
    window.delegate = self
    window.isReleasedWhenClosed = false
    let root = NSView()
    window.contentView = root
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    let document = TelaMaintenanceDocumentView()
    document.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = document
    let content = NSStackView()
    content.orientation = .vertical; content.alignment = .leading; content.spacing = 18
    content.translatesAutoresizingMaskIntoConstraints = false
    document.addSubview(content)
    root.addSubview(scroll)

    let title = NSTextField(labelWithString: telaText("Repair or remove Tela"))
    title.font = .systemFont(ofSize: 22, weight: .semibold)
    version.font = .systemFont(ofSize: 12)
    version.textColor = .secondaryLabelColor
    let intro = NSTextField(wrappingLabelWithString: telaText("Review the changes before applying them. Your projects and original ChatGPT data are preserved."))
    intro.textColor = .secondaryLabelColor
    let heading = NSStackView(views: [title, version, intro])
    heading.orientation = .vertical; heading.alignment = .leading; heading.spacing = 6
    content.addArrangedSubview(heading)

    picker.addItems(withTitles: [telaText("Repair this installation"), telaText("Remove Tela")])
    picker.target = self; picker.action = #selector(selectionChanged)
    for (button, selector) in [(packageButton, #selector(choosePackage)),
      (reviewButton, #selector(reviewChanges)), (applyButton, #selector(applyChanges))] {
      button.bezelStyle = .rounded; button.target = self; button.action = selector
    }
    packageButton.setAccessibilityLabel(telaText("Choose Tela package"))
    operationHelp.textColor = .secondaryLabelColor
    let actionSection = section(telaText("Action"), views: [picker, operationHelp])
    content.addArrangedSubview(actionSection)

    for field in [packageLabel] {
      field.font = .systemFont(ofSize: 12)
      field.textColor = .secondaryLabelColor
      field.lineBreakMode = .byTruncatingMiddle
      field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    let trust = NSTextField(wrappingLabelWithString: telaText("Choose a trusted Tela app matching the installed version."))
    trust.font = .systemFont(ofSize: 12); trust.textColor = .secondaryLabelColor
    configureSection(packageSection, title: telaText("Package"), views: [
      selectionRow(telaText("Tela package"), value: packageLabel, button: packageButton),
      trust,
    ])
    content.addArrangedSubview(packageSection)
    removeData.target = self; removeData.action = #selector(selectionChanged); removeData.state = .off
    pluginManagement.bezelStyle = .rounded
    pluginManagement.target = self; pluginManagement.action = #selector(openChatGPTPlugins)
    let pluginHelp = NSTextField(wrappingLabelWithString: telaText("Removing Tela from this computer does not remove its ChatGPT plugin. You can remove that separately in ChatGPT."))
    pluginHelp.textColor = .secondaryLabelColor
    configureSection(removalSection, title: telaText("Removal"), views: [removeData, pluginHelp, pluginManagement])
    content.addArrangedSubview(removalSection)
    planText.font = .systemFont(ofSize: 13)
    content.addArrangedSubview(section(telaText("Changes to review"), views: [planText]))
    cancelProcessButton.target = self; cancelProcessButton.action = #selector(cancelSelectedProcess)
    processPicker.target = self
    configureSection(processSection, title: telaText("Running tasks"), views: [processInfo, processPicker, cancelProcessButton])
    content.addArrangedSubview(processSection)

    message.font = .systemFont(ofSize: 12); message.textColor = .secondaryLabelColor
    let spacer = NSView()
    let actions = NSStackView(views: [progress, spacer, reviewButton, applyButton])
    actions.spacing = 10; actions.distribution = .fill
    progress.style = .spinning; progress.controlSize = .small; progress.isDisplayedWhenStopped = false
    nextStep.font = .systemFont(ofSize: 12)
    nextStep.textColor = .secondaryLabelColor
    let footer = NSStackView(views: [nextStep, message, actions])
    footer.orientation = .vertical; footer.alignment = .leading; footer.spacing = 12
    footer.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(footer)
    let separator = NSBox(); separator.boxType = .separator
    separator.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(separator)
    for view in [heading, packageSection, removalSection] {
      view.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }
    for view in content.arrangedSubviews where view is NSBox {
      view.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }
    intro.widthAnchor.constraint(equalTo: heading.widthAnchor).isActive = true
    message.widthAnchor.constraint(equalTo: footer.widthAnchor).isActive = true
    nextStep.widthAnchor.constraint(equalTo: footer.widthAnchor).isActive = true
    actions.widthAnchor.constraint(equalTo: footer.widthAnchor).isActive = true
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: root.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: separator.topAnchor, constant: -16),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      content.topAnchor.constraint(equalTo: document.topAnchor, constant: 24),
      content.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
      content.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
      content.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -8),
      separator.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
      separator.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      separator.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16),
      footer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
      footer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
    ])
    window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    let environment = ProcessInfo.processInfo.environment
    if let selected = environment["CHATGPT_TELA_MAINTENANCE_OPERATION"], let index = operations.firstIndex(of: selected) {
      picker.selectItem(at: index)
    }
    if let path = environment["CHATGPT_TELA_MAINTENANCE_PAYLOAD"] {
      package = URL(fileURLWithPath: path); packageLabel.stringValue = package!.lastPathComponent
    }
    updateControls()
    Task {
      await loadStatus(); await refreshProcesses()
      if package != nil { reviewChanges() }
    }
  }

  private func section(_ title: String, views: [NSView]) -> NSBox {
    let box = NSBox(); configureSection(box, title: title, views: views); return box
  }
  private func selectionRow(_ title: String, value: NSTextField, button: NSButton) -> NSStackView {
    let label = NSTextField(labelWithString: title)
    label.font = .systemFont(ofSize: 13)
    let details = NSStackView(views: [label, value])
    details.orientation = .vertical; details.alignment = .leading; details.spacing = 3
    details.setContentHuggingPriority(.defaultLow, for: .horizontal)
    value.widthAnchor.constraint(equalTo: details.widthAnchor).isActive = true
    button.title = telaText("Choose…")
    button.setContentHuggingPriority(.required, for: .horizontal)
    button.setContentCompressionResistancePriority(.required, for: .horizontal)
    let row = NSStackView(views: [details, button])
    row.alignment = .centerY; row.spacing = 12; row.distribution = .fill
    return row
  }
  private func configureSection(_ box: NSBox, title: String, views: [NSView]) {
    box.boxType = .custom; box.borderWidth = 1
    box.borderColor = .separatorColor; box.fillColor = .controlBackgroundColor
    box.cornerRadius = 8; box.titlePosition = .noTitle
    box.contentViewMargins = NSSize(width: 16, height: 14)
    let label = NSTextField(labelWithString: title)
    label.font = .systemFont(ofSize: 13, weight: .semibold)
    let stack = NSStackView(views: [label] + views)
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    let container = NSView()
    box.contentView = container
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: container.topAnchor),
      stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      box.heightAnchor.constraint(equalTo: stack.heightAnchor, constant: 28),
    ])
    for view in views where view is NSTextField || view is NSStackView {
      view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
  }

  private func updateControls() {
    packageButton.title = telaText("Choose…")
    operationHelp.stringValue = operation == "repair"
      ? telaText("Choose a Tela app matching the installed version. Your settings and logins are kept.")
      : telaText("Remove Tela and its background services. Your projects and original ChatGPT data are kept.")
    packageSection.isHidden = operation == "uninstall"
    removalSection.isHidden = operation != "uninstall"
    applyButton.title = operation == "uninstall" ? telaText("Remove Tela…") : telaText("Repair Tela…")
    reviewButton.title = telaText("Review changes")
    window.defaultButtonCell = (review == nil ? reviewButton : applyButton).cell as? NSButtonCell
    picker.isEnabled = !busy && !completedRemoval
    packageButton.isEnabled = !busy && operation != "uninstall" && !completedRemoval
    removeData.isEnabled = !busy && operation == "uninstall" && !completedRemoval
    reviewButton.isEnabled = !busy && !completedRemoval && (operation == "uninstall" || package != nil)
    applyButton.isEnabled = !busy && review != nil && review?.blockers.isEmpty == true && !completedRemoval
    processPicker.isEnabled = !busy && !unresolvedProcesses.isEmpty
    cancelProcessButton.isEnabled = !busy && !unresolvedProcesses.isEmpty
    if completedRemoval {
      nextStep.stringValue = telaText("If you also want to remove the ChatGPT plugin, open ChatGPT Plugins.")
    } else if busy {
      nextStep.stringValue = ""
    } else if let review {
      nextStep.stringValue = review.blockers.isEmpty
        ? (operation == "uninstall" ? telaText("Check the changes above, then remove Tela.") : telaText("Check the changes above, then repair Tela."))
        : telaText("Resolve the issues shown above, then review again.")
    } else if operation == "uninstall" {
      nextStep.stringValue = telaText("Choose whether to keep your Tela data, then review the removal.")
    } else if package == nil {
      nextStep.stringValue = telaText("Choose a package to begin.")
    } else {
      nextStep.stringValue = telaText("Ready to review. No changes will be made during review.")
    }
    nextStep.isHidden = nextStep.stringValue.isEmpty
    message.isHidden = message.stringValue.isEmpty
    if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
  }
  @objc private func openChatGPTPlugins() {
    NSWorkspace.shared.open(URL(string: "https://chatgpt.com/plugins")!)
  }

  @objc private func selectionChanged() {
    review = nil; planText.stringValue = telaText("Review changes before applying them."); message.stringValue = ""; updateControls()
  }
  @objc private func choosePackage() {
    let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowedContentTypes = [.applicationBundle]
    panel.allowsMultipleSelection = false; panel.message = telaText("Select a Tela app matching the installed version.")
    if panel.runModal() == .OK { package = panel.url; packageLabel.stringValue = package?.lastPathComponent ?? telaText("No package selected"); selectionChanged() }
  }
  private func arguments(_ mode: String) -> [String] {
    var result = ["maintenance", mode, operation]
    if operation == "uninstall" { if removeData.state == .on { result.append("--remove-data") } }
    else if let package { result += ["--payload", package.path] }
    return result
  }
  private nonisolated static func execute(_ launcher: String, _ arguments: [String]) -> (Int32, Data) {
    let process = Process(); process.executableURL = URL(fileURLWithPath: launcher); process.arguments = arguments
    let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    do {
      try process.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
      return (process.terminationStatus, data.count <= 1_048_576 ? data : Data())
    } catch { return (1, Data()) }
  }
  private func loadStatus(preservingOutcome: Bool = false) async {
    let path = launcher
    let result = await Task.detached { Self.execute(path, ["maintenance", "status"]) }.value
    if result.0 == 0, let status = try? JSONDecoder().decode(TelaMaintenanceStatus.self, from: result.1) {
      version.stringValue = String(format: telaText("Installed: %@"), status.installedVersion)
      if status.pendingTransition != "none" {
        let recovery = status.pendingTransition == "uninstall"
          ? telaText("An earlier removal is unfinished. Select Remove Tela and review the remaining changes to continue.")
          : status.pendingTransition == "application-update"
          ? telaText("Finish the pending update in Tela before maintenance.")
          : telaText("An earlier installation is unfinished. Use its original installer to finish recovery.")
        message.stringValue = preservingOutcome && !message.stringValue.isEmpty
          ? message.stringValue + "\n" + recovery : recovery
      }
    } else { version.stringValue = telaText("Installation status unavailable") }
    updateControls()
  }
  @discardableResult
  private func refreshProcesses() async -> Bool {
    let path = launcher
    let result = await Task.detached { Self.execute(path, ["maintenance", "processes"]) }.value
    let observed = result.0 == 0 ? try? JSONDecoder().decode(TelaMaintenanceProcesses.self, from: result.1) : nil
    if let parsed = observed {
      unresolvedProcesses = parsed.processes
      processPicker.removeAllItems()
      for entry in unresolvedProcesses {
        let started = try? Date.ISO8601FormatStyle().parse(entry.startedAt)
        let when = started.map { DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .short) } ?? telaText("Unknown start time")
        processPicker.addItem(withTitle: String(format: telaText("%@ · %@ · task %@"), entry.workspaceName, when, String(entry.sessionId)))
      }
      processInfo.stringValue = unresolvedProcesses.isEmpty ? telaText("No unfinished Chat commands found. Review changes to check maintenance readiness.") : telaText("Wait for commands to finish, then choose Review changes again. To stop one, select it and choose Cancel selected execution.")
    } else {
      unresolvedProcesses = []; processPicker.removeAllItems()
      processInfo.stringValue = telaText("Couldn't verify Chat execution status. Choose Review changes to check maintenance readiness again.")
    }
    updateControls()
    return observed != nil
  }
  @objc private func cancelSelectedProcess() {
    guard !busy, processPicker.indexOfSelectedItem >= 0,
      processPicker.indexOfSelectedItem < unresolvedProcesses.count else { return }
    let selected = unresolvedProcesses[processPicker.indexOfSelectedItem]
    let alert = NSAlert(); alert.alertStyle = .warning
    alert.messageText = String(format: telaText("Cancel task %@ in %@?"), String(selected.sessionId), selected.workspaceName)
    alert.informativeText = telaText("This command may still be running. Only the selected task will be cancelled. Maintenance remains blocked until the command's completion and service readiness are verified.")
    alert.addButton(withTitle: telaText("Cancel execution")); alert.addButton(withTitle: telaText("Keep running"))
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    busy = true; updateControls()
    let path = launcher
    Task {
      let result = await Task.detached { Self.execute(path, ["maintenance", "cancel-process", selected.workspaceId, selected.operationId]) }.value
      busy = false
      review = nil
      let statusVerified = await refreshProcesses()
      if result.0 == 0 && statusVerified {
        message.stringValue = unresolvedProcesses.contains(where: { $0.operationId == selected.operationId })
          ? telaText("Cancellation was requested, but completion is not yet confirmed. Review the status before updating.")
          : telaText("The selected command is no longer unfinished. Review the update again to verify service readiness.")
      } else {
        message.stringValue = telaText("Cancellation outcome is uncertain. Current status was checked where available; review it before another request.")
      }
      updateControls()
    }
  }
  @objc private func reviewChanges() {
    guard !busy else { return }; busy = true; review = nil
    message.stringValue = telaText("Checking package, ownership, and planned changes…"); updateControls()
    let path = launcher, args = arguments("review")
    Task {
      let result = await Task.detached { Self.execute(path, args) }.value
      busy = false
      if result.0 == 0, let observed = try? JSONDecoder().decode(TelaMaintenanceReview.self, from: result.1) {
        review = observed
        let versionText = observed.toVersion.map { "\(observed.fromVersion) → \($0)\n" } ?? ""
        let lines = observed.resources.map { "\($0.name): \($0.action.replacingOccurrences(of: "-", with: " "))" }
        planText.stringValue = versionText + lines.joined(separator: "\n")
        if !observed.blockers.isEmpty {
          planText.stringValue += "\n\n" + telaText("Before continuing:") + "\n" + observed.blockers.joined(separator: "\n")
        }
        message.stringValue = observed.blockers.isEmpty ? telaText("Review complete. No changes applied.")
          : telaText("These changes cannot be applied yet. No changes applied.")
      } else { message.stringValue = telaText("Couldn't review these changes. Repair needs the installed version. No changes applied.") }
      updateControls()
      await refreshProcesses()
    }
  }
  @objc private func applyChanges() {
    guard !busy, let review, review.blockers.isEmpty else { return }
    let alert = NSAlert(); alert.alertStyle = .warning
    alert.messageText = operation == "uninstall" ? telaText("Remove ChatGPT Tela?") : telaText("Repair ChatGPT Tela?")
    alert.informativeText = telaText("Active work must finish before maintenance. ")
      + (operation == "uninstall" ? (removeData.state == .on ? telaText("Tela settings and saved logins will also be removed. ") : telaText("Tela settings and saved logins will be kept. ")) : telaText("Tela settings and logins will be kept. "))
      + telaText("Your projects and original ChatGPT data are preserved.")
    alert.addButton(withTitle: operation == "uninstall" ? telaText("Remove Tela") : telaText("Repair Tela")); alert.addButton(withTitle: telaText("Cancel"))
    if alert.runModal() != .alertFirstButtonReturn { return }
    busy = true; message.stringValue = telaText("Applying changes and verifying the result…"); updateControls()
    let path = launcher, args = arguments("apply") + ["--review-token", review.reviewToken], removing = operation == "uninstall"
    Task {
      let result = await Task.detached { Self.execute(path, args) }.value
      busy = false; self.review = nil
      if result.0 == 0, let applied = try? JSONDecoder().decode(TelaMaintenanceResult.self, from: result.1) {
        completedRemoval = removing && applied.success
        message.stringValue = if let blockers = applied.blockers, !blockers.isEmpty {
          blockers.joined(separator: "\n") + "\n" + telaText("Maintenance did not complete. Resolve the blocker, then review again.")
        } else if applied.success { removing ? String(format: telaText("Tela removed from this computer. Preserved resources: %@."), String(applied.preservedCount))
          : telaText("Changes verified. Tela control center refresh completed.")
        } else {
          String(format: telaText("Some changes couldn't finish. Failed resources: %@. Preserved resources: %@. Review again to recover."), String(applied.failedCount), String(applied.preservedCount))
        }
      } else { message.stringValue = telaText("Changes couldn't complete or the reviewed plan changed. Check the unfinished transition status and review with its matching package before resuming or cancelling. Running services may still need recovery.") }
      await loadStatus(preservingOutcome: true); updateControls()
    }
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if busy { NSSound.beep(); return false }
    NSApp.terminate(nil); return false
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { busy ? .terminateCancel : .terminateNow }
  func applicationWillTerminate(_ notification: Notification) {
    guard let root = ProcessInfo.processInfo.environment["CHATGPT_TELA_MAINTENANCE_WORKSPACE"] else { return }
    _ = Self.execute(launcher, ["maintenance-cleanup", "--workspace", root])
  }
}
