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

private struct ControlCenterPreferences: Decodable {
  let version: Int
  let approvalAutomation: String
}

private enum ControlCenterPage: String, CaseIterable {
  case overview = "Overview"
  case chat = "Chat"
  case work = "Work / Codex"
  case profiles = "Profiles"
  case bridge = "Bridge"
  case updates = "Updates"
  case settings = "Settings"
  case diagnostics = "Diagnostics"
}

@MainActor
final class TelaControlCenterController: NSObject, NSWindowDelegate {
  private let fileManager = FileManager.default
  private let home = FileManager.default.homeDirectoryForCurrentUser
  private var window: NSWindow?
  private var detailStack: NSStackView?
  private var selectedPage: ControlCenterPage = .overview
  private var serviceStates: [String: String] = [:]
  private var profiles: [ControlCenterProfileStatus] = []
  private var approvalAutomation = "off"
  private var bridgeImage: NSImage?
  private var bridgeMessage = "No preview requested yet."

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
      contentRect: NSRect(x: 0, y: 0, width: 860, height: 620),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "ChatGPT Tela"
    window.minSize = NSSize(width: 720, height: 500)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()

    let split = NSSplitViewController()
    let sidebar = NSViewController()
    sidebar.view = makeSidebar()
    let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
    sidebarItem.minimumThickness = 170
    sidebarItem.maximumThickness = 220
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
    stack.spacing = 6
    stack.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
      stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 18),
    ])
    for page in ControlCenterPage.allCases {
      let button = NSButton(title: page.rawValue, target: self, action: #selector(selectPage(_:)))
      button.bezelStyle = .inline
      button.alignment = .left
      button.identifier = NSUserInterfaceItemIdentifier(page.rawValue)
      button.widthAnchor.constraint(greaterThanOrEqualToConstant: 145).isActive = true
      stack.addArrangedSubview(button)
    }
    return container
  }

  private func makeDetailView() -> NSView {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    let document = NSView()
    document.translatesAutoresizingMaskIntoConstraints = false
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    document.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 28),
      stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -28),
      stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 28),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: document.bottomAnchor, constant: -28),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
    ])
    scroll.documentView = document
    detailStack = stack
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
    field.font = NSFont.systemFont(ofSize: 24, weight: .semibold)
    return field
  }

  private func clearDetail() {
    guard let stack = detailStack else { return }
    for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
  }

  private func addRefreshButton(_ title: String = "Refresh") {
    detailStack?.addArrangedSubview(NSButton(title: title, target: self, action: #selector(refreshPage)))
  }

  private func renderCurrentPage() {
    guard let stack = detailStack else { return }
    clearDetail()
    stack.addArrangedSubview(sectionTitle(selectedPage.rawValue))

    switch selectedPage {
    case .overview:
      stack.addArrangedSubview(label("ChatGPT Tela runs as independent Gateway, Chat, and Codex services. Closing this window leaves them running."))
      for service in ["gateway", "chat", "codex"] {
        stack.addArrangedSubview(label("\(service.capitalized): \(serviceStates[service] ?? "Unknown")"))
      }
      addRefreshButton()
    case .chat:
      stack.addArrangedSubview(label("Tela Chat: \(serviceStates["chat"] ?? "Unknown")"))
      stack.addArrangedSubview(label("Local workspace, file, process, review, worktree, and configured agent capabilities are served through the private Chat service and public ChatGPT Tela connector."))
      addRefreshButton()
    case .work:
      stack.addArrangedSubview(label("Tela Codex: \(serviceStates["codex"] ?? "Unknown")"))
      if profiles.isEmpty { stack.addArrangedSubview(label("No Codex profiles are currently available.")) }
      for profile in profiles {
        stack.addArrangedSubview(label("\(profile.targetDisplayName) · \(profile.controlState) · session \(profile.targetSessionState)"))
      }
      addRefreshButton()
    case .profiles:
      if profiles.isEmpty { stack.addArrangedSubview(label("No profiles reported by Tela Codex.")) }
      for profile in profiles {
        stack.addArrangedSubview(label("Profile \(profile.slot): \(profile.targetDisplayName)\nTarget: \(profile.targetState) · Session: \(profile.targetSessionState) · Control: \(profile.controlState)"))
      }
      addRefreshButton()
    case .bridge:
      stack.addArrangedSubview(label("Read-only observation only. This preview never reveals, focuses, clicks, types into, stops, or otherwise manipulates the hidden Work/Codex browser surface."))
      stack.addArrangedSubview(label(bridgeMessage))
      if let bridgeImage {
        let imageView = NSImageView(image: bridgeImage)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.borderWidth = 1
        imageView.layer?.cornerRadius = 8
        imageView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 360).isActive = true
        stack.addArrangedSubview(imageView)
      }
      stack.addArrangedSubview(NSButton(title: "Refresh Read-only Preview", target: self, action: #selector(refreshBridgePreview)))
    case .updates:
      stack.addArrangedSubview(label("Signed install, repair, upgrade, and uninstall lifecycle operations exist. The final consumer updater UI and pinned release trust remain release work."))
    case .settings:
      stack.addArrangedSubview(label("Approval automation: \(approvalAutomation == "recognized_once" ? "Recognized one-shot cards" : "Off")"))
      stack.addArrangedSubview(label("Additional settings will move here as they become stable product preferences. The menu bar remains the quick-control surface."))
      addRefreshButton()
    case .diagnostics:
      stack.addArrangedSubview(label("Tela diagnostics are privacy-bounded and stored separately from user prompts, tool arguments, and file contents."))
      let logs = NSButton(title: "Open Logs", target: self, action: #selector(openLogs))
      stack.addArrangedSubview(logs)
    }
  }

  @objc private func selectPage(_ sender: NSButton) {
    guard let raw = sender.identifier?.rawValue,
          let page = ControlCenterPage(rawValue: raw) else { return }
    selectedPage = page
    renderCurrentPage()
    Task { await refreshCurrentPage() }
  }

  @objc private func refreshPage() { Task { await refreshCurrentPage() } }
  @objc private func refreshBridgePreview() { Task { await loadBridgePreview() } }

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

  private func request(_ descriptor: ControlCenterServiceDescriptor, path: String) async throws -> Data {
    guard let base = URL(string: descriptor.endpoint), let url = URL(string: path, relativeTo: base) else {
      throw NSError(domain: "ChatGPTTelaControlCenter", code: 3)
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
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
    serviceStates = ["gateway": await gateway, "chat": await chat, "codex": await codex]
    profiles = await loadProfiles()
    if let data = try? Data(contentsOf: preferencesURL),
       let preferences = try? JSONDecoder().decode(ControlCenterPreferences.self, from: data),
       preferences.version == 1 {
      approvalAutomation = preferences.approvalAutomation
    }
    renderCurrentPage()
    if selectedPage == .bridge { await loadBridgePreview() }
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

  private func loadBridgePreview() async {
    bridgeImage = nil
    guard let profile = profiles.first(where: { $0.controlState == "running" }) else {
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
