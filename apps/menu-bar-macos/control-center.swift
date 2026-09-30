import AppKit
import Foundation

private struct ControlCenterServiceDescriptor: Decodable {
  let service: String
  let endpoint: String
  let bearerToken: String
}

private struct ControlCenterServiceStatus: Decodable {
  let service: String
  let state: String
}

private struct ControlCenterIngressStatus: Decodable {
  let contractVersion: Int
  let availability: String
  let cause: String
  let detail: String
  let exposureKind: String?
}

private struct ControlCenterProfileStatus: Decodable {
  let slot: Int
  let targetDisplayName: String
  let targetState: String
  let targetSessionState: String
  let controlState: String
}

private struct ControlCenterProfilesEnvelope: Decodable {
  let profiles: [ControlCenterProfileStatus]
}

private struct ControlCenterBridgePreview: Decodable {
  let contractVersion: Int
  let slot: Int
  let activeSurfaceCount: Int
  let previewAvailable: Bool
  let imageMimeType: String?
  let imageBase64: String?
}

private enum ControlCenterPage: String, CaseIterable {
  case home = "Home"
  case work = "Work"
  case settings = "Settings"
}

private final class FlippedDocumentView: NSView {
  override var isFlipped: Bool { true }
}

@MainActor
final class TelaControlCenterController: NSObject, NSWindowDelegate {
  var onPreferencesChanged: (() -> Void)?
  private let fileManager = FileManager.default
  private let home = FileManager.default.homeDirectoryForCurrentUser
  private var window: NSWindow?
  private var detailStack: NSStackView?
  private var detailScroll: NSScrollView?
  private var navigationButtons: [ControlCenterPage: NSButton] = [:]
  private var selectedPage: ControlCenterPage = .home
  private var serviceStates: [String: String] = [:]
  private var ingressStatus: ControlCenterIngressStatus?
  private var profiles: [ControlCenterProfileStatus] = []
  private var approvalAutomation = "off"
  private var approvalDelay = "instant"
  private var bridgeImage: NSImage?
  private var bridgeMessage = "No preview requested yet."
  private var selectedPreviewSlot: Int?
  private var preferenceError = false

  private var supportRoot: URL {
    home.appendingPathComponent("Library/Application Support/ChatGPT Tela", isDirectory: true)
  }
  private var runtimeServicesRoot: URL {
    supportRoot.appendingPathComponent("runtime/services", isDirectory: true)
  }
  private var preferencesURL: URL {
    supportRoot.appendingPathComponent("config/preferences-v1.json", isDirectory: false)
  }
  private var logsURL: URL {
    home.appendingPathComponent("Library/Logs/ChatGPT Tela", isDirectory: true)
  }

  func show() {
    if window == nil { buildWindow() }
    guard let window else { return }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    Task { await refreshCurrentPage() }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // The control center is a view over the background product. Closing it must not stop Tela.
    sender.orderOut(nil)
    return false
  }

  private func buildWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 900, height: 650),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "ChatGPT Tela"
    window.minSize = NSSize(width: 760, height: 520)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()

    let split = NSSplitViewController()
    let sidebar = NSViewController()
    sidebar.view = makeSidebar()
    let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
    sidebarItem.minimumThickness = 185
    sidebarItem.maximumThickness = 230
    sidebarItem.canCollapse = false
    split.addSplitViewItem(sidebarItem)

    let detail = NSViewController()
    detail.view = makeDetailView()
    split.addSplitViewItem(NSSplitViewItem(viewController: detail))
    window.contentViewController = split
    self.window = window
    renderCurrentPage()
  }

  private func makeSidebar() -> NSView {
    let container = NSView()
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
    ])
    let heading = label("ChatGPT Tela")
    heading.font = .systemFont(ofSize: 17, weight: .semibold)
    stack.addArrangedSubview(heading)
    for page in ControlCenterPage.allCases {
      let button = NSButton(title: page.rawValue, target: self, action: #selector(selectPage(_:)))
      button.bezelStyle = .rounded
      button.alignment = .left
      button.font = .systemFont(ofSize: 16, weight: .medium)
      button.identifier = NSUserInterfaceItemIdentifier(page.rawValue)
      stack.addArrangedSubview(button)
      button.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 36).isActive = true
      navigationButtons[page] = button
    }
    updateNavigation()
    let footer = label("Closing this window keeps Tela running.", style: .caption1)
    footer.textColor = .secondaryLabelColor
    footer.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(footer)
    NSLayoutConstraint.activate([
      footer.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
      footer.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
      footer.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -22),
    ])
    return container
  }

  private func updateNavigation() {
    for (page, button) in navigationButtons {
      button.state = page == selectedPage ? .on : .off
      button.contentTintColor = page == selectedPage ? .controlAccentColor : .labelColor
    }
  }

  private func makeDetailView() -> NSView {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    let document = FlippedDocumentView(frame: NSRect(x: 0, y: 0, width: 650, height: 620))
    document.translatesAutoresizingMaskIntoConstraints = false
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    document.addSubview(stack)
    scroll.documentView = document
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -32),
      stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 30),
      document.bottomAnchor.constraint(greaterThanOrEqualTo: stack.bottomAnchor, constant: 32),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      document.heightAnchor.constraint(greaterThanOrEqualTo: scroll.contentView.heightAnchor),
    ])
    let contentHeight = document.bottomAnchor.constraint(equalTo: stack.bottomAnchor, constant: 32)
    contentHeight.priority = .defaultHigh
    contentHeight.isActive = true
    detailStack = stack
    detailScroll = scroll
    return scroll
  }

  private func label(_ text: String, style: NSFont.TextStyle = .body) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = NSFont.preferredFont(forTextStyle: style)
    field.maximumNumberOfLines = 0
    return field
  }

  private func sectionTitle(_ title: String) -> NSTextField {
    let field = label(title, style: .title1)
    field.font = NSFont.systemFont(ofSize: 29, weight: .bold)
    return field
  }

  private func clearDetail() {
    guard let stack = detailStack else { return }
    for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
  }

  private func addRefreshButton(_ title: String = "Refresh") {
    detailStack?.addArrangedSubview(NSButton(title: title, target: self, action: #selector(refreshPage)))
  }

  private func addSection(_ title: String) {
    guard let stack = detailStack else { return }
    let spacer = NSView()
    spacer.heightAnchor.constraint(equalToConstant: 12).isActive = true
    stack.addArrangedSubview(spacer)
    let heading = label(title)
    heading.font = .systemFont(ofSize: 19, weight: .semibold)
    stack.addArrangedSubview(heading)
  }

  private func addStatus(_ title: String, value: String) {
    guard let stack = detailStack else { return }
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.distribution = .fill
    let name = label(title)
    name.font = .systemFont(ofSize: 16, weight: .medium)
    let state = label(value)
    state.textColor = value == "Available" ? .systemGreen : .secondaryLabelColor
    state.alignment = .right
    name.setContentHuggingPriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(name)
    row.addArrangedSubview(state)
    stack.addArrangedSubview(row)
    row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
  }

  private var connectorReady: Bool {
    serviceStates["gateway"] == "Ready" && ingressStatus?.availability == "ready"
  }

  private func availability(for service: String, needsProfile: Bool = false) -> String {
    if serviceStates[service] == nil { return "Checking…" }
    let profileReady = !needsProfile || profiles.contains {
      $0.controlState == "running" && $0.targetSessionState == "ready"
    }
    return connectorReady && serviceStates[service] == "Ready" && profileReady
      ? "Available" : "Needs attention"
  }

  private func renderCurrentPage() {
    guard let stack = detailStack else { return }
    clearDetail()
    stack.addArrangedSubview(sectionTitle(selectedPage.rawValue))

    switch selectedPage {
    case .home:
      stack.addArrangedSubview(label("See what is ready to use in ChatGPT. Tela keeps working when you close this window."))
      addSection("Connections")
      addStatus("Chat", value: availability(for: "chat"))
      addStatus("Work / Codex", value: availability(for: "codex", needsProfile: true))
      stack.addArrangedSubview(label("Chat connects your local workspace. Work / Codex runs Web model turns from your Codex conversations."))
      addRefreshButton("Check again")
    case .work:
      stack.addArrangedSubview(label("Manage the ChatGPT profiles used by Work / Codex and view a snapshot of an active Web turn."))
      addSection("Profiles")
      if profiles.isEmpty { stack.addArrangedSubview(label("No Work profiles are available right now.")) }
      for profile in profiles {
        let state = profile.controlState == "running" && profile.targetSessionState == "ready"
          ? "Running" : profile.controlState.capitalized
        stack.addArrangedSubview(label("\(profile.targetDisplayName) · \(state)"))
        let action = profile.controlState == "running" ? "stop" :
          (profile.controlState == "restart-required" ? "restart" : "start")
        let title = action == "stop" ? "Stop Profile \(profile.slot)" :
          (action == "restart" ? "Restart Profile \(profile.slot)" : "Start Profile \(profile.slot)")
        let button = NSButton(title: title, target: self, action: #selector(changeProfile(_:)))
        button.identifier = NSUserInterfaceItemIdentifier("profile:\(profile.slot):\(action)")
        stack.addArrangedSubview(button)
      }
      addSection("Browser activity")
      stack.addArrangedSubview(label("This snapshot is read-only. It cannot click, type into, or stop the active turn."))
      let runningProfiles = profiles.filter { $0.controlState == "running" }
      if runningProfiles.count > 1 {
        let picker = NSPopUpButton()
        for profile in runningProfiles {
          picker.addItem(withTitle: profile.targetDisplayName)
          picker.lastItem?.representedObject = profile.slot
        }
        if let selectedPreviewSlot,
           let index = runningProfiles.firstIndex(where: { $0.slot == selectedPreviewSlot }) {
          picker.selectItem(at: index)
        }
        picker.target = self
        picker.action = #selector(selectPreviewProfile(_:))
        stack.addArrangedSubview(picker)
      }
      stack.addArrangedSubview(label(bridgeMessage))
      if let bridgeImage {
        let imageView = NSImageView(image: bridgeImage)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.borderWidth = 1
        imageView.layer?.cornerRadius = 8
        stack.addArrangedSubview(imageView)
        imageView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 360).isActive = true
      }
      stack.addArrangedSubview(NSButton(title: "View current snapshot", target: self, action: #selector(refreshBridgePreview)))
      addRefreshButton("Refresh Work status")
    case .settings:
      stack.addArrangedSubview(label("Adjust how Tela handles approvals and inspect connection details."))
      addSection("Approvals")
      let approval = NSButton(checkboxWithTitle: "Automatically approve recognized one-time requests", target: self, action: #selector(toggleApproval(_:)))
      approval.state = approvalAutomation == "recognized_once" ? .on : .off
      approval.isEnabled = !preferenceError
      stack.addArrangedSubview(approval)
      stack.addArrangedSubview(label("Approval delay"))
      let delays: [(String, String)] = [
        ("instant", "Instant"), ("250ms", "0.25 seconds"), ("500ms", "0.5 seconds"),
        ("1s", "1 second"), ("2s", "2 seconds"), ("5s", "5 seconds"),
        ("10s", "10 seconds"), ("15s", "15 seconds")
      ]
      let delayPicker = NSPopUpButton()
      for (preset, title) in delays {
        delayPicker.addItem(withTitle: title)
        delayPicker.lastItem?.representedObject = preset
      }
      delayPicker.selectItem(at: delays.firstIndex(where: { $0.0 == approvalDelay }) ?? 0)
      delayPicker.target = self
      delayPicker.action = #selector(setApprovalDelay(_:))
      delayPicker.isEnabled = !preferenceError
      stack.addArrangedSubview(delayPicker)
      stack.addArrangedSubview(label("Changes take effect after restarting the active Work profile. Restarting interrupts any running turn."))
      if preferenceError { stack.addArrangedSubview(label("Approval settings could not be read. Check Tela's preferences file.")) }
      addSection("Connection details")
      for service in ["gateway", "chat", "codex"] {
        addStatus(service.capitalized, value: serviceStates[service] ?? "Checking…")
      }
      if let ingressStatus {
        addStatus("ChatGPT connection", value: ingressStatus.availability.capitalized)
        if ingressStatus.availability != "ready" { stack.addArrangedSubview(label(ingressStatus.detail)) }
      } else if serviceStates["gateway"] == "Stopped" {
        stack.addArrangedSubview(label("ChatGPT connection is unavailable while Tela's gateway is stopped."))
      }
      addSection("Diagnostics")
      stack.addArrangedSubview(label("Open Tela's local logs when you need to investigate a problem."))
      let logs = NSButton(title: "Open Logs", target: self, action: #selector(openLogs))
      stack.addArrangedSubview(logs)
      addRefreshButton("Refresh details")
      addSection("Updates")
      stack.addArrangedSubview(label("This source preview does not yet have an in-app updater."))
    }
  }

  @objc private func selectPage(_ sender: NSButton) {
    guard let raw = sender.identifier?.rawValue,
          let page = ControlCenterPage(rawValue: raw) else { return }
    selectedPage = page
    updateNavigation()
    renderCurrentPage()
    detailScroll?.contentView.scroll(to: .zero)
    Task { await refreshCurrentPage() }
  }

  @objc private func refreshPage() { Task { await refreshCurrentPage() } }
  @objc private func refreshBridgePreview() { Task { await loadBridgePreview() } }

  @objc private func selectPreviewProfile(_ sender: NSPopUpButton) {
    selectedPreviewSlot = sender.selectedItem?.representedObject as? Int
    bridgeImage = nil
    Task { await loadBridgePreview() }
  }

  @objc private func toggleApproval(_ sender: NSButton) {
    do {
      var preferences = try TelaPreferencesStore.read(at: preferencesURL)
      preferences.approvalAutomation = sender.state == .on ? "recognized_once" : "off"
      try TelaPreferencesStore.write(preferences, at: preferencesURL)
      approvalAutomation = preferences.approvalAutomation
      preferenceError = false
      onPreferencesChanged?()
    } catch {
      sender.state = approvalAutomation == "recognized_once" ? .on : .off
      NSSound.beep()
    }
  }

  @objc private func setApprovalDelay(_ sender: NSPopUpButton) {
    guard let preset = sender.selectedItem?.representedObject as? String,
          TelaPreferencesStore.delays.contains(preset) else { return }
    do {
      var preferences = try TelaPreferencesStore.read(at: preferencesURL)
      preferences.approvalDelay = preset
      try TelaPreferencesStore.write(preferences, at: preferencesURL)
      approvalDelay = preset
      preferenceError = false
      onPreferencesChanged?()
    } catch {
      let prior = sender.itemArray.firstIndex(where: { $0.representedObject as? String == approvalDelay }) ?? 0
      sender.selectItem(at: prior)
      NSSound.beep()
    }
  }

  @objc private func changeProfile(_ sender: NSButton) {
    guard let identifier = sender.identifier?.rawValue else { return }
    let parts = identifier.split(separator: ":")
    guard parts.count == 3, parts[0] == "profile",
          let slot = Int(parts[1]), ["start", "stop", "restart"].contains(String(parts[2])) else { return }
    let action = String(parts[2])
    if action != "start" {
      let alert = NSAlert()
      alert.alertStyle = .warning
      alert.messageText = "\(action == "restart" ? "Restart" : "Stop") Profile \(slot)?"
      alert.informativeText = action == "restart"
        ? "The ChatGPT app for this profile will close and reopen. Any running turn will be interrupted."
        : "The ChatGPT app for this profile will close. Any running turn will be interrupted. You can reopen it from Work."
      alert.addButton(withTitle: action == "restart" ? "Restart Profile" : "Stop Profile")
      alert.addButton(withTitle: "Cancel")
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    sender.isEnabled = false
    Task {
      do {
        guard let descriptor = try readDescriptor("codex") else {
          throw NSError(domain: "ChatGPTTelaControlCenter", code: 7)
        }
        // An unattached profile is restarted by the service's start lifecycle. Calling stop first
        // would reject it as another owner's ready session before that lifecycle can inspect it.
        if action == "restart" && profiles.first(where: { $0.slot == slot })?.controlState == "running" {
          _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/stop", method: "POST")
        }
        _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/\(action == "restart" ? "start" : action)", method: "POST")
      } catch {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Couldn't \(action) this profile"
        alert.informativeText = "Close the ChatGPT app for this profile normally, then try starting it again. If it still fails, check the connection details in Settings."
        alert.addButton(withTitle: "OK")
        alert.runModal()
      }
      await refreshCurrentPage()
    }
  }

  private func descriptorURL(_ service: String) -> URL {
    runtimeServicesRoot.appendingPathComponent("\(service)/descriptor.json", isDirectory: false)
  }

  private func readDescriptor(_ service: String) throws -> ControlCenterServiceDescriptor? {
    let url = descriptorURL(service)
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NSError(domain: "ChatGPTTelaControlCenter", code: 1) }
    let value = try JSONDecoder().decode(ControlCenterServiceDescriptor.self, from: Data(contentsOf: url))
    guard value.service == service,
          let endpoint = URL(string: value.endpoint),
          endpoint.scheme == "http",
          ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? ""),
          value.bearerToken.count >= 32 else { throw NSError(domain: "ChatGPTTelaControlCenter", code: 2) }
    return value
  }

  private func request(_ descriptor: ControlCenterServiceDescriptor, path: String, method: String = "GET") async throws -> Data {
    guard let base = URL(string: descriptor.endpoint), let url = URL(string: path, relativeTo: base) else {
      throw NSError(domain: "ChatGPTTelaControlCenter", code: 3)
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(descriptor.bearerToken)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 4
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw NSError(domain: "ChatGPTTelaControlCenter", code: 4)
    }
    return data
  }

  private func refreshCurrentPage() async {
    async let gateway = serviceState("gateway")
    async let chat = serviceState("chat")
    async let codex = serviceState("codex")
    async let ingress = loadIngressStatus()
    serviceStates = ["gateway": await gateway, "chat": await chat, "codex": await codex]
    ingressStatus = await ingress
    profiles = await loadProfiles()
    if let preferences = try? TelaPreferencesStore.read(at: preferencesURL) {
      approvalAutomation = preferences.approvalAutomation
      approvalDelay = preferences.approvalDelay ?? "instant"
      preferenceError = false
    } else {
      preferenceError = true
    }
    renderCurrentPage()
  }

  private func serviceState(_ service: String) async -> String {
    do {
      guard let descriptor = try readDescriptor(service) else { return "Stopped" }
      let status = try JSONDecoder().decode(ControlCenterServiceStatus.self, from: await request(descriptor, path: "v1/status"))
      return status.service == service ? status.state.capitalized : "Unavailable"
    } catch { return "Unavailable" }
  }

  private func loadProfiles() async -> [ControlCenterProfileStatus] {
    do {
      guard let descriptor = try readDescriptor("codex") else { return [] }
      let envelope = try JSONDecoder().decode(ControlCenterProfilesEnvelope.self, from: await request(descriptor, path: "v1/codex/profiles"))
      return envelope.profiles.sorted { $0.slot < $1.slot }
    } catch { return [] }
  }

  private func loadIngressStatus() async -> ControlCenterIngressStatus? {
    do {
      guard let descriptor = try readDescriptor("gateway") else { return nil }
      let value = try JSONDecoder().decode(ControlCenterIngressStatus.self, from: await request(descriptor, path: "v1/ingress"))
      guard value.contractVersion == 1,
            ["ready", "unavailable", "unconfigured"].contains(value.availability),
            !value.cause.isEmpty,
            !value.detail.isEmpty else { return nil }
      return value
    } catch { return nil }
  }

  private func loadBridgePreview() async {
    bridgeImage = nil
    guard let profile = profiles.first(where: { $0.controlState == "running" && $0.slot == selectedPreviewSlot })
      ?? profiles.first(where: { $0.controlState == "running" }) else {
      bridgeMessage = "No Tela-owned running profile. A preview is available only while Tela owns the Work/Codex profile."
      renderCurrentPage()
      return
    }
    do {
      guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "ChatGPTTelaControlCenter", code: 5) }
      let data = try await request(descriptor, path: "v1/codex/profiles/\(profile.slot)/bridge-preview")
      let preview = try JSONDecoder().decode(ControlCenterBridgePreview.self, from: data)
      guard preview.contractVersion == 1, preview.slot == profile.slot else { throw NSError(domain: "ChatGPTTelaControlCenter", code: 6) }
      if preview.previewAvailable,
         preview.imageMimeType == "image/jpeg",
         let encoded = preview.imageBase64,
         let imageData = Data(base64Encoded: encoded),
         let image = NSImage(data: imageData) {
        bridgeImage = image
        bridgeMessage = "Profile \(profile.slot) · one active hidden bridge surface · snapshot only"
      } else if preview.activeSurfaceCount == 0 {
        bridgeMessage = "Profile \(profile.slot) is running, but no Work/Codex browser surface is active right now."
      } else {
        bridgeMessage = "Profile \(profile.slot) has \(preview.activeSurfaceCount) active surfaces; preview is withheld unless exactly one surface is unambiguous."
      }
    } catch {
      bridgeMessage = "Bridge preview is unavailable. The Work/Codex runtime was not modified."
    }
    renderCurrentPage()
  }

  @objc private func openLogs() {
    try? fileManager.createDirectory(at: logsURL, withIntermediateDirectories: true,
                                     attributes: [.posixPermissions: 0o700])
    NSWorkspace.shared.open(logsURL)
  }
}
