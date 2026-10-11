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
}
private struct TelaMaintenanceStatus: Decodable {
  let installedVersion: String
  let pendingTransition: String
}

// A verified, temporary copy survives shutdown/removal of the installed menu bar.
// It calls the same launcher lifecycle engine and owns no service or install authority.
@MainActor
final class TelaMaintenanceController: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow!
  private let version = NSTextField(labelWithString: "Checking installation…")
  private let message = NSTextField(wrappingLabelWithString: "")
  private let nextStep = NSTextField(wrappingLabelWithString: "")
  private let planText = NSTextField(wrappingLabelWithString: "Review an operation before applying it.")
  private let packageLabel = NSTextField(labelWithString: "No package selected")
  private let keyLabel = NSTextField(labelWithString: "No release key selected")
  private let picker = NSPopUpButton()
  private let removeData = NSButton(checkboxWithTitle: "Also remove Tela settings, saved logins, and credentials", target: nil, action: nil)
  private let reviewButton = NSButton(title: "Review changes", target: nil, action: nil)
  private let applyButton = NSButton(title: "Apply…", target: nil, action: nil)
  private let packageButton = NSButton(title: "Choose package…", target: nil, action: nil)
  private let keyButton = NSButton(title: "Choose trusted release key…", target: nil, action: nil)
  private let progress = NSProgressIndicator()
  private let packageSection = NSBox()
  private let removalSection = NSBox()
  private var package: URL?
  private var key: URL?
  private var review: TelaMaintenanceReview?
  private var busy = false
  private var completedRemoval = false
  private var launcher: String { ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] ?? "" }
  private var operations = ["upgrade", "repair", "uninstall"]
  private var operation: String { operations[picker.indexOfSelectedItem] }
  private let operationHelp = NSTextField(wrappingLabelWithString: "")

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 660),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Maintain ChatGPT Tela"
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

    let title = NSTextField(labelWithString: "Update, repair or remove Tela")
    title.font = .systemFont(ofSize: 22, weight: .semibold)
    version.font = .systemFont(ofSize: 12)
    version.textColor = .secondaryLabelColor
    let intro = NSTextField(wrappingLabelWithString: "Review the changes before applying them. Your projects and original ChatGPT data are preserved.")
    intro.textColor = .secondaryLabelColor
    let heading = NSStackView(views: [title, version, intro])
    heading.orientation = .vertical; heading.alignment = .leading; heading.spacing = 6
    content.addArrangedSubview(heading)

    picker.addItems(withTitles: ["Update Tela", "Repair this installation", "Remove Tela"])
    picker.target = self; picker.action = #selector(selectionChanged)
    for (button, selector) in [(packageButton, #selector(choosePackage)), (keyButton, #selector(chooseKey)),
      (reviewButton, #selector(reviewChanges)), (applyButton, #selector(applyChanges))] {
      button.bezelStyle = .rounded; button.target = self; button.action = selector
    }
    packageButton.setAccessibilityLabel("Choose signed Tela package")
    keyButton.setAccessibilityLabel("Choose trusted release key")
    operationHelp.textColor = .secondaryLabelColor
    content.addArrangedSubview(section("Action", views: [picker, operationHelp]))

    for field in [packageLabel, keyLabel] {
      field.font = .systemFont(ofSize: 12)
      field.textColor = .secondaryLabelColor
      field.lineBreakMode = .byTruncatingMiddle
      field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    let trust = NSTextField(wrappingLabelWithString: "Use a signed package and an independently trusted release key. Preview releases do not download updates automatically.")
    trust.font = .systemFont(ofSize: 12); trust.textColor = .secondaryLabelColor
    configureSection(packageSection, title: "Package and verification key", views: [
      selectionRow("Signed package", value: packageLabel, button: packageButton),
      selectionRow("Trusted release key", value: keyLabel, button: keyButton), trust,
    ])
    content.addArrangedSubview(packageSection)
    removeData.target = self; removeData.action = #selector(selectionChanged); removeData.state = .off
    configureSection(removalSection, title: "Saved data", views: [removeData])
    content.addArrangedSubview(removalSection)
    planText.font = .systemFont(ofSize: 13)
    content.addArrangedSubview(section("Changes to review", views: [planText]))

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
    updateControls()
    Task { await loadStatus() }
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
    button.title = "Choose…"
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
    packageButton.title = "Choose…"
    switch operation {
    case "repair":
      operationHelp.stringValue = "Choose a signed package matching the installed version. Your Tela settings and logins are kept."
    case "uninstall":
      operationHelp.stringValue = "Remove Tela and its background services. Your projects and original ChatGPT data are kept."
    case "cancel-upgrade":
      operationHelp.stringValue = "Keep the installed version and restore previously running services. Choose its retained signed package. Available only before file replacement starts."
    default:
      operationHelp.stringValue = "Choose the new signed Tela package. You will review its changes before updating."
    }
    packageSection.isHidden = operation == "uninstall"
    removalSection.isHidden = operation != "uninstall"
    operationHelp.isHidden = operationHelp.stringValue.isEmpty
    applyButton.title = operation == "cancel-upgrade" ? "Cancel update…" : operation == "uninstall" ? "Remove Tela…" : operation == "repair" ? "Repair Tela…" : "Update Tela…"
    window.defaultButtonCell = (review == nil ? reviewButton : applyButton).cell as? NSButtonCell
    picker.isEnabled = !busy && !completedRemoval
    packageButton.isEnabled = !busy && operation != "uninstall" && !completedRemoval
    keyButton.isEnabled = packageButton.isEnabled
    removeData.isEnabled = !busy && operation == "uninstall" && !completedRemoval
    reviewButton.isEnabled = !busy && !completedRemoval && (operation == "uninstall" || (package != nil && key != nil))
    applyButton.isEnabled = !busy && review != nil && review?.blockers.isEmpty == true && !completedRemoval
    if busy || completedRemoval {
      nextStep.stringValue = ""
    } else if let review {
      nextStep.stringValue = review.blockers.isEmpty
        ? (operation == "cancel-upgrade" ? "Check the changes above, then cancel the unfinished update."
          : "Check the changes above, then \(operation == "uninstall" ? "remove" : operation == "repair" ? "repair" : "update") Tela.")
        : "Resolve the issues shown above, then review again."
    } else if operation == "uninstall" {
      nextStep.stringValue = "Choose whether to keep your Tela data, then review the removal."
    } else if package == nil {
      nextStep.stringValue = "Choose a signed package to begin."
    } else if key == nil {
      nextStep.stringValue = "Choose the independently trusted release key to verify this package."
    } else {
      nextStep.stringValue = "Ready to review. No changes will be made during review."
    }
    nextStep.isHidden = nextStep.stringValue.isEmpty
    message.isHidden = message.stringValue.isEmpty
    if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
  }
  @objc private func selectionChanged() {
    review = nil; planText.stringValue = "Review changes before applying them."; message.stringValue = ""; updateControls()
  }
  @objc private func choosePackage() {
    let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false; panel.message = operation == "cancel-upgrade" ? "Select the signed package for the currently installed version, not the newer update." : "Select an extracted signed Tela package."
    if panel.runModal() == .OK { package = panel.url; packageLabel.stringValue = package?.lastPathComponent ?? "No package selected"; selectionChanged() }
  }
  @objc private func chooseKey() {
    let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
    panel.message = "Select the release public key you trust independently of this package."
    if panel.runModal() == .OK { key = panel.url; keyLabel.stringValue = key?.lastPathComponent ?? "No release key selected"; selectionChanged() }
  }
  private func arguments(_ mode: String) -> [String] {
    var result = ["maintenance", mode, operation]
    if operation == "uninstall" { if removeData.state == .on { result.append("--remove-data") } }
    else if let package, let key { result += ["--payload", package.path, "--trusted-public-key", key.path] }
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
  private func loadStatus() async {
    let path = launcher
    let result = await Task.detached { Self.execute(path, ["maintenance", "status"]) }.value
    if result.0 == 0, let status = try? JSONDecoder().decode(TelaMaintenanceStatus.self, from: result.1) {
      version.stringValue = "Installed: \(status.installedVersion)"
      if status.pendingTransition == "upgrade", !operations.contains("cancel-upgrade") {
        operations.append("cancel-upgrade"); picker.addItem(withTitle: "Cancel unfinished update")
      } else if status.pendingTransition != "upgrade", let index = operations.firstIndex(of: "cancel-upgrade") {
        picker.selectItem(at: 0); picker.removeItem(at: index); operations.remove(at: index); review = nil
        planText.stringValue = "Review changes before applying them."
      }
      if status.pendingTransition != "none" {
        message.stringValue = status.pendingTransition == "upgrade"
          ? "An update is unfinished. Resume with its update package, or review cancellation with the installed-version package."
          : "An earlier repair is unfinished. Select its matching package to resume it."
      }
    } else { version.stringValue = "Installation status unavailable" }
    updateControls()
  }
  @objc private func reviewChanges() {
    guard !busy else { return }; busy = true; review = nil
    message.stringValue = "Checking signature, ownership, and planned changes…"; updateControls()
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
          planText.stringValue += "\n\nBefore continuing:\n" + observed.blockers.joined(separator: "\n")
        }
        message.stringValue = observed.blockers.isEmpty ? "Review complete. No changes applied."
          : "These changes cannot be applied yet. No changes applied."
      } else { message.stringValue = operation == "cancel-upgrade"
          ? "Couldn't verify cancellation. Select the signed installed-version package and trusted key. Cancellation also requires launcher support and no file replacement. Otherwise resume with the original update package. No changes applied."
          : "Couldn't review these changes. Check the package and trusted key. Repair needs the installed version; an unfinished transition needs its original package. No changes applied." }
      updateControls()
    }
  }
  @objc private func applyChanges() {
    guard !busy, let review, review.blockers.isEmpty else { return }
    let alert = NSAlert(); alert.alertStyle = .warning
    alert.messageText = operation == "cancel-upgrade" ? "Cancel the unfinished update?"
      : operation == "uninstall" ? "Remove ChatGPT Tela?" : "Apply the reviewed changes?"
    alert.informativeText = operation == "cancel-upgrade"
      ? "The installed version will be kept. Currently running services stay open; previously running services that stopped will be restored. Your projects, settings, logins, and original ChatGPT data are preserved."
      : "Connected ChatGPT profiles can close and running work can be interrupted. "
      + (operation == "uninstall" ? (removeData.state == .on ? "Tela settings, saved logins, and credentials will also be removed. " : "Tela settings, saved logins, and credentials will be kept. ") : "Your Tela settings and logins will be preserved. ")
      + "Your projects and original ChatGPT data are preserved."
    alert.addButton(withTitle: operation == "cancel-upgrade" ? "Cancel update" : operation == "uninstall" ? "Remove Tela" : "Apply changes"); alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    busy = true; message.stringValue = "Applying changes and verifying the result…"; updateControls()
    let path = launcher, args = arguments("apply") + ["--review-token", review.reviewToken], removing = operation == "uninstall"
    Task {
      let result = await Task.detached { Self.execute(path, args) }.value
      busy = false; self.review = nil
      if result.0 == 0, let applied = try? JSONDecoder().decode(TelaMaintenanceResult.self, from: result.1) {
        completedRemoval = removing && applied.success
        message.stringValue = applied.success ? (removing ? "Tela removed. Preserved resources: \(applied.preservedCount). You can close this window."
          : operation == "cancel-upgrade" ? "Update cancelled. The installed version was kept and previously running services were restored."
          : "Changes verified. Reopen Tela to load the updated control center.")
          : "Some changes couldn't finish. Failed resources: \(applied.failedCount). Preserved resources: \(applied.preservedCount). Review again to recover."
      } else { message.stringValue = "Changes couldn't complete or the reviewed plan changed. Review again before retrying. An interrupted update or repair may require its matching package." }
      await loadStatus(); updateControls()
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
