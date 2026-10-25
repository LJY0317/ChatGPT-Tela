import AppKit
import Foundation

private struct ServiceDescriptor: Decodable {
  let service: String
  let endpoint: String
  let bearerToken: String
}

private struct ServiceStatus: Decodable {
  let service: String
  let state: String
}

private struct IngressStatus: Decodable {
  let contractVersion: Int
  let availability: String
  let cause: String
  let detail: String
}

private typealias ProfileStatus = TelaWorkProfile

private struct ProfilesEnvelope: Decodable {
  let profiles: [ProfileStatus]
}

struct TelaPreferences: Codable {
  let version: Int
  var approvalAutomation: String
  var approvalDelay: String?
  var workProfileConnections: [String]?
  var webDelegationLimits: [String: Int]?
  var savedChatAcceptance: SavedChatAcceptance?
  struct SavedChatAcceptance: Codable { let slot: Int; let expiresAt: Int }
}

enum TelaPreferencesStore {
  static let delays = ["instant", "250ms", "500ms", "1s", "2s", "5s", "10s", "15s"]

  static func read(at url: URL) throws -> TelaPreferences {
    guard FileManager.default.fileExists(atPath: url.path) else {
      return TelaPreferences(version: 1, approvalAutomation: "off", approvalDelay: "instant")
    }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw NSError(domain: "ChatGPTTelaPreferences", code: 1)
    }
    let value = try JSONDecoder().decode(TelaPreferences.self, from: Data(contentsOf: url))
    guard value.version == 1,
          ["off", "full_access", "recognized_once", "recognized_conversation"].contains(value.approvalAutomation),
          delays.contains(value.approvalDelay ?? "instant") else {
      throw NSError(domain: "ChatGPTTelaPreferences", code: 2)
    }
    guard (value.webDelegationLimits ?? [:]).allSatisfy({ key, count in
      guard let slot = Int(key) else { return false }
      return String(slot) == key && (1...99).contains(slot) && (1...5).contains(count)
    }) else { throw NSError(domain: "ChatGPTTelaPreferences", code: 3) }
    return value
  }

  static func write(_ value: TelaPreferences, at url: URL) throws {
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    var payload = try JSONEncoder().encode(value)
    payload.append(0x0A)
    try payload.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
}

private struct MenuSnapshot {
  let services: [(String, String)]
  let runtimeReady: Bool
  let workInventory: TelaWorkInventory
}

// One accessible action owns the row. The switch is a visual state indicator,
// so clicking it does not require making the menu's window key.
@MainActor
private final class TelaMenuToggleRow: NSView {
  private let label = NSTextField(labelWithString: "")
  private let detail = NSTextField(labelWithString: "")
  private let toggle = NSSwitch()
  private let progress = NSProgressIndicator()
  private let icon = NSImageView()
  var action: (() -> Void)?
  var enabled = true

  init(title: String, image: NSImage?, on: Bool) {
    super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 48))
    icon.image = image
    icon.frame = NSRect(x: 16, y: 14, width: 20, height: 20)
    label.frame = NSRect(x: 44, y: 25, width: 196, height: 18)
    detail.frame = NSRect(x: 44, y: 7, width: 196, height: 16)
    detail.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    detail.textColor = .secondaryLabelColor
    label.lineBreakMode = .byTruncatingTail
    detail.lineBreakMode = .byTruncatingTail
    toggle.frame = NSRect(x: 252, y: 12, width: 38, height: 24)
    toggle.controlSize = .small
    addSubview(icon); addSubview(label); addSubview(detail); addSubview(toggle)
    progress.style = .spinning
    progress.controlSize = .small
    progress.isIndeterminate = true
    progress.frame = NSRect(x: 260, y: 16, width: 16, height: 16)
    progress.isHidden = true
    addSubview(progress)
    setAccessibilityElement(true)
    setAccessibilityRole(.checkBox)
    update(title: title, on: on, enabled: true)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
  func update(title: String, on: Bool, enabled: Bool, busy: Bool = false) {
    let parts = title.components(separatedBy: " — ")
    label.stringValue = parts.first ?? title
    detail.stringValue = parts.dropFirst().joined(separator: " — ")
    self.enabled = enabled
    toggle.state = on ? .on : .off
    toggle.isEnabled = enabled
    toggle.isHidden = busy
    progress.isHidden = !busy
    if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
    label.textColor = enabled ? .labelColor : .disabledControlTextColor
    setAccessibilityLabel(title)
    setAccessibilityValue(on ? 1 : 0)
    setAccessibilityEnabled(enabled)
  }
  override func hitTest(_ point: NSPoint) -> NSView? {
    bounds.contains(convert(point, from: superview)) ? self : nil
  }
  override func mouseUp(with event: NSEvent) {
    guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
    _ = accessibilityPerformPress()
  }
  override func accessibilityPerformPress() -> Bool {
    guard enabled, let action else { return false }
    action()
    return true
  }
}

@MainActor
final class TelaMenuBarController: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    controlCenter.show()
    return true
  }
  private var statusItem: NSStatusItem!
  private var statusMenu: NSMenu!
  private var connectionSpinner: NSProgressIndicator?
  private var connectionProgress: String?
  private var profileConnectionItems: [Int: NSMenuItem] = [:]
  private var profileToggleRows: [Int: TelaMenuToggleRow] = [:]
  private var profileOpenItems: [NSMenuItem] = []
  private var snapshot: MenuSnapshot?
  private var menuOpen = false
  private var controlCenterRevealPending = false
  private var chatGPTIcon: NSImage?
  private var workInventory: TelaWorkInventory {
    get { controlCenter.workState.inventory }
    set { controlCenter.workState.inventory = newValue }
  }
  private var refreshing = false
  private var refreshGeneration = 0
  private var refreshAgain = false
  private var noticePolicy = TelaLaunchNoticePolicy()
  private var pendingLaunchPids = Set<Int>()
  private var showingLaunchNotice = false
  private var launchNotice: (alert: NSAlert, slot: Int, pid: Int, decisionId: String)?
  private let decisionUiSession = UUID().uuidString
  private let controlCenter = TelaControlCenterController()
  private let fileManager = FileManager.default
  private let home = FileManager.default.homeDirectoryForCurrentUser

  private var supportRoot: URL {
    home.appendingPathComponent("Library/Application Support/ChatGPT Tela", isDirectory: true)
  }
  private var runtimeServicesRoot: URL {
    supportRoot.appendingPathComponent("runtime/services", isDirectory: true)
  }
  private var preferencesURL: URL {
    supportRoot.appendingPathComponent("config/preferences-v1.json", isDirectory: false)
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(reopenInstalledMenu),
      name: Notification.Name("com.openai.chatgpt-tela.menu-bar.reopen"), object: nil)
    NSApp.setActivationPolicy(.accessory)
    controlCenter.onPreferencesChanged = { [weak self] in
      Task { await self?.refreshNow() }
    }
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = statusItem.button {
      if #available(macOS 11.0, *) {
        button.image = NSImage(systemSymbolName: "network", accessibilityDescription: "ChatGPT Tela")
      } else {
        button.title = "T"
      }
    }
    controlCenter.workState.onChange = { [weak self] in
      guard let self else { return }
      self.controlCenter.workInventoryDidChange()
      self.updateConnectionProgress(self.connectionProgress)
      self.showPendingLaunchNotice()
    }
    controlCenter.onConnectionProgressChanged = { [weak self] message in
      self?.updateConnectionProgress(message)
      self?.showPendingLaunchNotice()
    }
    let menu = NSMenu()
    menu.autoenablesItems = false
    menu.delegate = self
    statusMenu = menu
    statusItem.menu = menu
    controlCenter.onWindowStateChanged = { [weak self] event in self?.recordMenuState(event) }
    controlCenter.onDecisionStateChanged = { [weak self] event, slot, decisionId in
      self?.recordMenuState(event, slot: slot, decisionId: decisionId)
    }
    rebuildMenu(loading: true)
    let notifications = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didActivateApplicationNotification,
                 NSWorkspace.didTerminateApplicationNotification] {
      notifications.addObserver(self, selector: #selector(workspaceChanged(_:)), name: name, object: nil)
    }
    Task {
      await controlCenter.startServicesAtLaunch()
      await refreshNow()
    }
    Task { await controlCenter.showFirstUseIfNeeded() }
    // Only the installed launcher supplies this acknowledgement destination.
    if let path = ProcessInfo.processInfo.environment["CHATGPT_TELA_MENU_BAR_READY_FILE"],
       let version = ProcessInfo.processInfo.environment["CHATGPT_TELA_PRODUCT_VERSION"] {
      do {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let ready: [String: Any] = ["pid": Int(getpid()), "parentPid": Int(getppid()), "productVersion": version]
        try JSONSerialization.data(withJSONObject: ready).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
      } catch {
        fputs("Tela menu bar could not acknowledge startup.\n", stderr)
        NSApp.terminate(nil)
      }
    }
  }

  @objc private func reopenInstalledMenu() { controlCenter.show() }

  private func updateConnectionProgress(_ message: String?) {
    connectionProgress = message
    guard let button = statusItem.button else { return }
    let visibleProgress = message ?? (refreshing ? "Checking status…" : nil) ?? (workInventory.error == nil && workInventory.profiles.contains { $0.connectionInProgress == true || ($0.connected && $0.webState == "preparing") } ? "Connecting ChatGPT…" : nil)
    button.toolTip = visibleProgress ?? "ChatGPT Tela"
    button.setAccessibilityLabel(visibleProgress.map { "Tela: \($0)" } ?? "ChatGPT Tela")
    if visibleProgress != nil {
      if connectionSpinner == nil {
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.sizeToFit()
        spinner.setFrameOrigin(NSPoint(x: (button.bounds.width - spinner.frame.width) / 2,
                                      y: (button.bounds.height - spinner.frame.height) / 2))
        spinner.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        button.addSubview(spinner)
        connectionSpinner = spinner
      }
      button.image = nil
      connectionSpinner?.startAnimation(nil)
    } else {
      connectionSpinner?.stopAnimation(nil)
      connectionSpinner?.removeFromSuperview()
      connectionSpinner = nil
      button.image = NSImage(systemSymbolName: "network", accessibilityDescription: "ChatGPT Tela")
    }
    updateProfileProgress()
    // Update existing row contents while tracking; keep the open menu's geometry stable.
    if !menuOpen { rebuildMenu(loading: snapshot == nil) }
  }

  @objc private func signInWebProfile(_ sender: NSMenuItem) {
    statusMenu.cancelTracking()
    controlCenter.openWebAccount(slot: sender.tag)
  }

  @objc private func finishWebAccountProfile(_ sender: NSMenuItem) {
    statusMenu.cancelTracking()
    controlCenter.finishWebAccount(slot: sender.tag)
  }

  @objc private func reconnectWebProfile(_ sender: NSMenuItem) { controlCenter.reconnectWeb(slot: sender.tag) }

  private func updateProfileProgress() {
    for (slot, item) in profileConnectionItems {
      if let profile = workInventory.profiles.first(where: { $0.slot == slot }) {
        let presentation = TelaProfilePresentation(profile: profile, inventoryError: workInventory.error,
          localProgress: controlCenter.connectionProgressSlot == slot ? connectionProgress : nil)
        let connection = controlCenter.webConnectionPresentation(for: profile)
        let state = workInventory.error != nil ? "Status unavailable" : presentation.busy ? "Connecting…" : connection.menuStatus
        item.title = "\(profile.targetDisplayName) — \(state)"
        item.state = connection.enabled ? .on : .off
        profileToggleRows[slot]?.update(title: item.title,
          on: connection.enabled, enabled: workInventory.error == nil && !controlCenter.connectionOperationInProgress
            && profile.connectionInProgress != true, busy: presentation.busy)
      }
      item.isEnabled = workInventory.error == nil && !controlCenter.connectionOperationInProgress
        && workInventory.profiles.first(where: { $0.slot == slot })?.connectionInProgress != true
    }
    for item in profileOpenItems {
      let profile = workInventory.profiles.first(where: { $0.slot == item.tag })
      item.isEnabled = workInventory.error == nil && profile?.connectionInProgress != true
        && (profile?.connected == true || !controlCenter.connectionOperationInProgress)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    NSWorkspace.shared.notificationCenter.removeObserver(self)
    if let path = ProcessInfo.processInfo.environment["CHATGPT_TELA_MENU_BAR_READY_FILE"],
       let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
       let ready = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       ready["pid"] as? Int == Int(getpid()) {
      try? FileManager.default.removeItem(atPath: path)
    }
  }

  @objc private func workspaceChanged(_ notification: Notification) {
    if notification.name == NSWorkspace.didTerminateApplicationNotification,
       let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
      noticePolicy.ended(pid: Int(app.processIdentifier))
      pendingLaunchPids.remove(Int(app.processIdentifier))
    }
    let live = Set(NSWorkspace.shared.runningApplications.map { Int($0.processIdentifier) })
    noticePolicy.prune(livePids: live)
    pendingLaunchPids.formIntersection(live)
    guard notification.name != NSWorkspace.didTerminateApplicationNotification,
          let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
          app.activationPolicy == .regular,
          let preferences = try? TelaPreferencesStore.read(at: preferencesURL),
          !(preferences.workProfileConnections ?? []).isEmpty else { return }
    if notification.name == NSWorkspace.didActivateApplicationNotification,
       !pendingLaunchPids.contains(Int(app.processIdentifier)),
       !workInventory.profiles.contains(where: { $0.desktopProcessId == Int(app.processIdentifier) }) { return }
    pendingLaunchPids.insert(Int(app.processIdentifier))
    Task { await refreshNow() }
  }

  private func showPendingLaunchNotice() {
    guard !showingLaunchNotice, !controlCenter.connectionOperationInProgress,
          snapshot != nil, workInventory.error == nil,
          let preferences = try? TelaPreferencesStore.read(at: preferencesURL) else { return }
    let live = Set(NSWorkspace.shared.runningApplications.map { Int($0.processIdentifier) })
    noticePolicy.prune(livePids: live)
    pendingLaunchPids.formIntersection(live)
    // Inventory also covers apps opened before Tela and launch events whose PID
    // was not discoverable yet. OS notifications remain hints, not a second owner.
    pendingLaunchPids.formUnion(workInventory.profiles.compactMap { $0.desktopProcessId })
    for pid in pendingLaunchPids.sorted() {
      // Do not steal focus from another app if the user moved on during discovery.
      guard Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) == pid else { continue }
      guard let profile = noticePolicy.notice(pid: pid, profiles: workInventory.profiles,
          wantedTargets: preferences.workProfileConnections ?? [], inventoryValid: true),
          let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else { continue }
      pendingLaunchPids.remove(pid)
      showingLaunchNotice = true
      let alert = NSAlert()
      alert.messageText = "Reopen \(profile.targetDisplayName)?"
      alert.informativeText = "Reopen with Tela to enable Web models.\nFinish any ongoing work first."
      alert.icon = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
      alert.addButton(withTitle: "Reopen with Tela")
      alert.addButton(withTitle: "Later").keyEquivalent = "\u{1b}"
      // A modeless window bypasses NSAlert's usual presentation-time layout.
      alert.layout()
      alert.window.level = .floating
      NSApp.activate(ignoringOtherApps: true)
      let decisionId = UUID().uuidString
      // Keep the menu and other profiles responsive while the owner is away.
      // Showing a notice never authorizes a restart or acknowledges a decision.
      launchNotice = (alert, profile.slot, pid, decisionId)
      alert.window.delegate = self
      for button in alert.buttons {
        button.target = self
        button.action = #selector(respondToLaunchNotice(_:))
      }
      recordMenuState("decision_web_reopen_pending", slot: profile.slot, decisionId: decisionId)
      alert.window.makeKeyAndOrderFront(nil)
      // Avoid stacking multiple app notices over the same user's action.
      break
    }
  }

  @objc private func respondToLaunchNotice(_ sender: NSButton) {
    guard let notice = launchNotice, notice.alert.buttons.contains(where: { $0 === sender }) else { return }
    finishLaunchNotice(accepted: sender === notice.alert.buttons.first)
  }

  private func finishLaunchNotice(accepted: Bool, closeWindow: Bool = true) {
    guard let notice = launchNotice else { return }
    // Clear before closing: windowWillClose cannot emit a second decision.
    launchNotice = nil
    showingLaunchNotice = false
    recordMenuState(accepted ? "decision_web_reopen_accepted" : "decision_web_reopen_deferred",
      slot: notice.slot, decisionId: notice.decisionId)
    if closeWindow { notice.alert.window.close() }
    if accepted {
      controlCenter.reopenForWeb(slot: notice.slot, expectedDesktopPid: notice.pid)
    } else if let app = NSRunningApplication(processIdentifier: pid_t(notice.pid)), !app.isTerminated {
      app.activate(options: [])
    }
  }

  func windowWillClose(_ notification: Notification) {
    guard let window = notification.object as? NSWindow, launchNotice?.alert.window === window else { return }
    finishLaunchNotice(accepted: false, closeWindow: false)
  }

  func menuWillOpen(_ menu: NSMenu) {
    // A native menu owns tracking. Opening it must not activate unrelated product windows.
    rebuildMenu(loading: snapshot == nil)
    menuOpen = true
    recordMenuState("menu_open")
    Task { await refreshNow() }
  }

  func menuDidClose(_ menu: NSMenu) {
    menuOpen = false
    // AppKit forbids rebuilding menu structure inside this callback. Defer until tracking ends.
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.menuOpen else { return }
      self.rebuildMenu(loading: self.snapshot == nil)
      self.recordMenuState("menu_closed")
    }
  }

  func applicationDidBecomeActive(_ notification: Notification) { recordMenuState("app_active") }
  func applicationDidResignActive(_ notification: Notification) { recordMenuState("app_inactive") }

  private func recordMenuState(_ event: String, slot: Int? = nil, decisionId: String? = nil) {
    // Event-driven, bounded, local-only evidence: no window titles, other app identities or content.
    let directory = home.appendingPathComponent("Library/Logs/ChatGPT Tela", isDirectory: true)
    let url = directory.appendingPathComponent("menu-ui-events.json")
    var rows: [[String: Any]] = []
    if let data = try? Data(contentsOf: url), data.count < 131072,
       let existing = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] { rows = existing }
    let now = Date().timeIntervalSince1970
    rows = rows.filter { ($0["at"] as? Double ?? 0) > now - 86400 }
    var evidence: [String: Any] = ["at": now, "event": event, "menuOpen": menuOpen,
      "uiSession": decisionUiSession,
      "appActive": NSApp.isActive, "ownAppFrontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
      "window": controlCenter.windowStateEvidence]
    if let slot, (1...99).contains(slot) { evidence["slot"] = slot }
    if let decisionId { evidence["decision"] = decisionId }
    rows.append(evidence)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try JSONSerialization.data(withJSONObject: Array(rows.suffix(64))).write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    } catch { /* Diagnostics cannot alter UI behavior. */ }
  }

  private func descriptorURL(_ service: String) -> URL {
    runtimeServicesRoot.appendingPathComponent("\(service)/descriptor.json", isDirectory: false)
  }

  private func readDescriptor(_ service: String) throws -> ServiceDescriptor? {
    let url = descriptorURL(service)
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 1)
    }
    let value = try JSONDecoder().decode(ServiceDescriptor.self, from: Data(contentsOf: url))
    guard value.service == service,
          let endpoint = URL(string: value.endpoint),
          endpoint.scheme == "http",
          ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? ""),
          value.bearerToken.count >= 32 else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 2)
    }
    return value
  }

  private func request(_ descriptor: ServiceDescriptor, path: String) async throws -> Data {
    guard let base = URL(string: descriptor.endpoint),
          let url = URL(string: path, relativeTo: base) else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 3)
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(descriptor.bearerToken)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = TelaRequestBudget.seconds(path: path, method: "GET")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 4)
    }
    return data
  }

  private func inspectService(_ service: String) async -> String {
    do {
      guard let descriptor = try readDescriptor(service) else { return "Stopped" }
      let data = try await request(descriptor, path: "v1/status")
      let status = try JSONDecoder().decode(ServiceStatus.self, from: data)
      guard status.service == service else { return "Unavailable" }
      return status.state.capitalized
    } catch {
      return "Unavailable"
    }
  }

  private func inspectIngress() async -> IngressStatus? {
    do {
      guard let descriptor = try readDescriptor("gateway") else { return nil }
      let data = try await request(descriptor, path: "v1/ingress")
      let status = try JSONDecoder().decode(IngressStatus.self, from: data)
      guard status.contractVersion == 1,
            ["ready", "unavailable", "unconfigured"].contains(status.availability),
            !status.cause.isEmpty,
            !status.detail.isEmpty else { return nil }
      return status
    } catch {
      return nil
    }
  }

  private func inspect() async -> MenuSnapshot {
    async let gateway = inspectService("gateway")
    async let chat = inspectService("chat")
    async let codex = inspectService("codex")
    async let ingress = inspectIngress()
    let ticket = controlCenter.workState.beginRead()
    do {
      guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "TelaWork", code: 1) }
      let envelope = try JSONDecoder().decode(ProfilesEnvelope.self, from: await request(descriptor, path: "v1/codex/profiles"))
      controlCenter.workState.finishRead(ticket, profiles: envelope.profiles)
    } catch { controlCenter.workState.finishRead(ticket, profiles: nil, error: error) }
    let gatewayState = await gateway
    let chatState = await chat
    let codexState = await codex
    let ingressStatus = await ingress
    let connectionReady = gatewayState == "Ready" && ingressStatus?.availability == "ready"
    let chatReady = connectionReady && chatState == "Ready"
    return MenuSnapshot(
      services: [
        ("Chat", chatReady ? "Ready" : (chatState == "Stopped" ? "Off" : "Needs attention"))
      ],
      runtimeReady: gatewayState == "Ready" && chatState == "Ready" && codexState == "Ready",
      workInventory: workInventory
    )
  }

  private func addDisabled(_ title: String, to menu: NSMenu) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
  }

  private func actionItem(_ title: String, action: Selector, keyEquivalent: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
    item.target = self
    return item
  }

  private func profileIcon(_ profile: TelaWorkProfile) -> NSImage? {
    let runningURL = profile.desktopProcessId.flatMap { pid -> URL? in
      guard pid > 0, pid <= Int(Int32.max) else { return nil }
      return NSRunningApplication(processIdentifier: pid_t(pid))?.bundleURL
    }
    guard let url = runningURL ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") else { return chatGPTIcon }
    // Display adapter: use the installed app's own menu glyph when available. Never bundle it.
    if let resource = Bundle(url: url)?.url(forResource: "chatgptTemplate", withExtension: "png"),
       let image = NSImage(contentsOf: resource) {
      image.size = NSSize(width: 18, height: 18)
      if let retinaURL = Bundle(url: url)?.url(forResource: "chatgptTemplate@2x", withExtension: "png"),
         let data = try? Data(contentsOf: retinaURL), let representation = NSBitmapImageRep(data: data) {
        representation.size = image.size
        image.addRepresentation(representation)
      }
      image.isTemplate = true
      chatGPTIcon = image
      return image
    }
    return NSWorkspace.shared.icon(forFile: url.path)
  }

  private func rebuildMenu(loading: Bool) {
    guard let menu = statusMenu else { return }
    profileToggleRows.removeAll()
    profileConnectionItems.removeAll(); profileOpenItems.removeAll()
    menu.removeAllItems()
    if let connectionProgress {
      addDisabled(connectionProgress, to: menu)
    } else if loading || snapshot == nil {
      addDisabled("Checking status…", to: menu)
    } else if let snapshot {
      for (name, state) in snapshot.services {
        addDisabled("\(name): \(state)", to: menu)
      }
    }
    if let snapshot {
      if !snapshot.runtimeReady {
        let start = actionItem("Start Tela", action: #selector(startTela))
        start.isEnabled = !controlCenter.connectionOperationInProgress
        menu.addItem(start)
      }
      menu.addItem(.separator())
      for profile in workInventory.profiles {
        let connection = controlCenter.webConnectionPresentation(for: profile)
        let item = actionItem(profile.targetDisplayName, action: #selector(toggleWorkProfile(_:)))
        item.tag = profile.slot
        item.state = connection.enabled ? .on : .off
        item.image = profileIcon(profile)
        item.isEnabled = snapshot.workInventory.error == nil && !controlCenter.connectionOperationInProgress
        profileConnectionItems[profile.slot] = item
        let row = TelaMenuToggleRow(title: item.title, image: item.image, on: connection.enabled)
        row.action = { [weak self, weak item] in
          guard let self, let item else { return }
          self.toggleWorkProfile(item)
        }
        item.view = row
        profileToggleRows[profile.slot] = row
        menu.addItem(item)
        addProfileOpen(profile.slot, name: profile.targetDisplayName, to: menu)
        if let title = connection.buttonTitle {
          let retry = actionItem(title, action: #selector(retryWorkProfile(_:)))
          retry.tag = profile.slot
          retry.isEnabled = item.isEnabled && profile.connectionInProgress != true
          menu.addItem(retry)
        }
        let web = TelaWebPresentation(profile: profile)
        if connection.buttonTitle == nil,
           profile.webState != "ready" || profile.webModelsReady == false || profile.accountManagementActive == true,
           let title = web.buttonTitle {
          let selector: Selector
          switch web.action {
          case .finish: selector = #selector(finishWebAccountProfile(_:))
          case .reconnect: selector = #selector(reconnectWebProfile(_:))
          case .account: selector = #selector(signInWebProfile(_:))
          case .none: selector = #selector(openControlCenter)
          }
          let action = actionItem(title, action: selector)
          action.tag = profile.slot
          action.isEnabled = !controlCenter.connectionOperationInProgress && workInventory.error == nil
          menu.addItem(action)
        }
      }
    }
    if workInventory.profiles.isEmpty {
      addProfileOpen(1, name: "ChatGPT", to: menu)
    }
    menu.addItem(.separator())
    menu.addItem(actionItem("Open Tela…", action: #selector(openControlCenter), keyEquivalent: "o"))
    menu.addItem(actionItem("Quit Tela Menu", action: #selector(quitMenuBar), keyEquivalent: "q"))
    updateProfileProgress()
  }

  @objc private func startTela() {
    statusMenu.cancelTracking()
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.menuOpen else { return }
      self.controlCenter.startTelaFromMenu()
    }
  }

  private func addProfileOpen(_ slot: Int, name: String, to menu: NSMenu) {
    let item = actionItem("Open \(name)", action: #selector(openWorkProfile(_:)))
    item.tag = slot
    item.isEnabled = workInventory.profiles.first(where: { $0.slot == slot })?.connected == true
      || !controlCenter.connectionOperationInProgress
    profileOpenItems.append(item)
    menu.addItem(item)
  }

  @objc private func openWorkProfile(_ sender: NSMenuItem) {
    statusMenu.cancelTracking()
    controlCenter.openProfile(slot: sender.tag)
  }

  @objc private func toggleWorkProfile(_ sender: NSMenuItem) {
    statusMenu.cancelTracking()
    controlCenter.connectFromMenu(slot: sender.tag)
  }

  @objc private func retryWorkProfile(_ sender: NSMenuItem) {
    statusMenu.cancelTracking()
    controlCenter.retryConnection(slot: sender.tag)
  }

  @objc private func openControlCenter() {
    controlCenterRevealPending = true
    statusMenu.cancelTracking()
    // Finish the native menu tracking transaction before ordering another window.
    // A fixed delay or activation/focus restoration is neither needed nor appropriate.
    DispatchQueue.main.async { [weak self] in
      guard let self, self.controlCenterRevealPending, !self.menuOpen else { return }
      self.controlCenterRevealPending = false
      self.controlCenter.show()
    }
  }

  private func refreshNow() async {
    guard !refreshing else { refreshAgain = true; return }
    refreshing = true
    updateConnectionProgress(connectionProgress)
    defer {
      refreshing = false
      updateConnectionProgress(connectionProgress)
      if refreshAgain { refreshAgain = false; Task { await refreshNow() } }
    }
    refreshGeneration += 1
    let generation = refreshGeneration
    let observed = await inspect()
    guard generation == refreshGeneration else { return }
    snapshot = observed
    if observed.workInventory.error == nil {
      controlCenter.rememberRunningProfileApps(observed.workInventory.profiles)
    }
    updateProfileProgress()
    if !menuOpen { rebuildMenu(loading: false) }
    showPendingLaunchNotice()
  }

  @objc private func quitMenuBar() {
    NSApp.terminate(nil)
  }
}

@main
struct ChatGPTTelaMenuBarMain {
  @MainActor
  static func main() {
    // Finder/Spotlight launches inherit no launchd environment; resolve the same
    // installed product launcher used by the packaged menu admission path.
    if Bundle.main.bundleIdentifier == "com.openai.chatgpt-tela.menu-bar",
       ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] == nil {
      let launcher = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ChatGPT Tela/bin/chatgpt-tela").path
      if FileManager.default.isExecutableFile(atPath: launcher) {
        setenv("CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE", launcher, 0)
      }
    }
    if CommandLine.arguments.contains("--maintenance-only") {
      let app = NSApplication.shared
      let delegate = TelaMaintenanceController()
      app.delegate = delegate
      withExtendedLifetime(delegate) { app.run() }
      return
    }
    let instance = TelaMenuBarInstanceLock()
    do {
      guard try instance.acquire() else {
        DistributedNotificationCenter.default().post(name: Notification.Name("com.openai.chatgpt-tela.menu-bar.reopen"), object: nil)
        return
      }
    } catch {
      // Startup diagnostics never expose user paths or OS error payloads.
      fputs("Tela menu bar could not acquire its instance lock.\n", stderr)
      return
    }
    let app = NSApplication.shared
    let delegate = TelaMenuBarController()
    app.delegate = delegate
    withExtendedLifetime(instance) { app.run() }
  }
}
