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

  var symbol: String {
    switch self {
    case .home: return "house"
    case .work: return "terminal"
    case .settings: return "slider.horizontal.3"
    }
  }
}

// Tela-owned visual choices, independent of the ChatGPT app's implementation.
// Prefer native typography; keep intentional geometry and palette in one place.
private enum TelaStyle {
  static let bodySize = NSFont.systemFontSize
  static let captionSize = NSFont.smallSystemFontSize
  static let titleFont = NSFont.systemFont(ofSize: 21, weight: .semibold)
  static let actionFont = NSFont.systemFont(ofSize: 12, weight: .regular)
  static let cardRadius: CGFloat = 10
  static let controlRadius: CGFloat = 7
  static let borderWidth: CGFloat = 0.5
  static let pageInset: CGFloat = 36
  static let pageVerticalInset: CGFloat = 38
  static let cardInset: CGFloat = 18
  static let cardVerticalInset: CGFloat = 16
  static let contentMaxWidth: CGFloat = 640
}

private enum TelaAppearance {
  enum Surface {
    case page, sidebar, cardBorder, selection, button, pressedButton, buttonBorder
    var shades: (light: CGFloat, dark: CGFloat) {
      switch self {
      case .page: return (1, 0.08)
      case .sidebar: return (0.975, 0.11)
      case .cardBorder: return (0.91, 0.22)
      case .selection: return (0.925, 0.19)
      case .button: return (1, 0.11)
      case .pressedButton: return (0.95, 0.19)
      case .buttonBorder: return (0.90, 0.25)
      }
    }
  }

  static func color(_ surface: Surface, in appearance: NSAppearance) -> NSColor {
    let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let shades = surface.shades
    return NSColor(calibratedWhite: isDark ? shades.dark : shades.light, alpha: 1)
  }
}

private final class TelaBackgroundView: NSView {
  var isSidebar = false
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = TelaAppearance.color(isSidebar ? .sidebar : .page, in: effectiveAppearance).cgColor
  }
}

private final class TelaCardView: NSView {
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = TelaAppearance.color(.page, in: effectiveAppearance).cgColor
    layer?.borderColor = TelaAppearance.color(.cardBorder, in: effectiveAppearance).cgColor
    layer?.borderWidth = TelaStyle.borderWidth
    layer?.cornerRadius = TelaStyle.cardRadius
  }
}

private final class TelaNavigationButton: NSButton {
  var selected = false { didSet { needsDisplay = true } }
  override func draw(_ dirtyRect: NSRect) {
    if selected || isHighlighted {
      TelaAppearance.color(.selection, in: effectiveAppearance).setFill()
      NSBezierPath(roundedRect: bounds, xRadius: TelaStyle.controlRadius, yRadius: TelaStyle.controlRadius).fill()
    }
    super.draw(dirtyRect)
  }
}

private final class TelaActionButton: NSButton {
  override func draw(_ dirtyRect: NSRect) {
    let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: TelaStyle.borderWidth, dy: TelaStyle.borderWidth), xRadius: TelaStyle.controlRadius, yRadius: TelaStyle.controlRadius)
    TelaAppearance.color(isHighlighted ? .pressedButton : .button, in: effectiveAppearance).setFill()
    shape.fill()
    TelaAppearance.color(.buttonBorder, in: effectiveAppearance).setStroke()
    shape.lineWidth = TelaStyle.borderWidth
    shape.stroke()
    super.draw(dirtyRect)
  }
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
      contentRect: NSRect(x: 0, y: 0, width: 880, height: 640),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "ChatGPT Tela"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.minSize = NSSize(width: 760, height: 520)
    window.backgroundColor = .windowBackgroundColor
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()

    let split = NSSplitViewController()
    let sidebar = NSViewController()
    sidebar.view = makeSidebar()
    let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
    sidebarItem.minimumThickness = 190
    sidebarItem.maximumThickness = 210
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
    let container = TelaBackgroundView()
    container.isSidebar = true
    container.wantsLayer = true
    let stack = NSStackView()
    stack.distribution = .fill
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 4
    stack.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
      stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 22),
    ])
    let heading = label("ChatGPT Tela")
    heading.font = .systemFont(ofSize: 14, weight: .medium)
    stack.addArrangedSubview(heading)
    stack.setCustomSpacing(20, after: heading)
    for page in ControlCenterPage.allCases {
      let button = TelaNavigationButton(title: page.rawValue, target: self, action: #selector(selectPage(_:)))
      button.setButtonType(.momentaryChange)
      button.isBordered = false
      button.alignment = .left
      button.title = "  " + page.rawValue
      button.font = .systemFont(ofSize: TelaStyle.bodySize, weight: .regular)
      button.image = NSImage(systemSymbolName: page.symbol, accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: TelaStyle.bodySize, weight: .regular))
      button.imagePosition = .imageLeading
      button.imageScaling = .scaleProportionallyDown
      button.wantsLayer = true
      button.layer?.cornerRadius = TelaStyle.controlRadius
      button.setAccessibilityLabel(page.rawValue)
      button.identifier = NSUserInterfaceItemIdentifier(page.rawValue)
      stack.addArrangedSubview(button)
      button.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
      button.heightAnchor.constraint(equalToConstant: 34).isActive = true
      navigationButtons[page] = button
    }
    updateNavigation()
    let footer = label("Tela runs in the background.", style: .caption1)
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
      let selected = page == selectedPage
      button.state = .off
      (button as? TelaNavigationButton)?.selected = selected
      button.contentTintColor = .labelColor
      button.setAccessibilityValue(selected ? "Selected" : "")
    }
  }

  private func makeDetailView() -> NSView {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.drawsBackground = true
    scroll.backgroundColor = .textBackgroundColor
    let document = FlippedDocumentView()
    document.translatesAutoresizingMaskIntoConstraints = false
    let stack = NSStackView()
    stack.distribution = .fill
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    document.addSubview(stack)
    scroll.documentView = document
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: document.centerXAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: document.leadingAnchor, constant: TelaStyle.pageInset),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: document.trailingAnchor, constant: -TelaStyle.pageInset),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: TelaStyle.contentMaxWidth),
      stack.topAnchor.constraint(equalTo: document.topAnchor, constant: TelaStyle.pageVerticalInset),
      document.bottomAnchor.constraint(equalTo: stack.bottomAnchor, constant: TelaStyle.pageVerticalInset),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
    ])
    let contentWidth = stack.widthAnchor.constraint(equalTo: document.widthAnchor, constant: -2 * TelaStyle.pageInset)
    contentWidth.priority = .defaultHigh
    contentWidth.isActive = true
    detailStack = stack
    detailScroll = scroll
    return scroll
  }

  private func label(_ text: String, style: NSFont.TextStyle = .body) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: style == .caption1 ? TelaStyle.captionSize : TelaStyle.bodySize)
    field.maximumNumberOfLines = 0
    return field
  }

  private func sectionTitle(_ title: String) -> NSTextField {
    let field = label(title)
    field.font = TelaStyle.titleFont
    return field
  }

  private func secondary(_ text: String) -> NSTextField {
    let field = label(text)
    field.textColor = .secondaryLabelColor
    return field
  }

  private func clearDetail() {
    guard let stack = detailStack else { return }
    for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
  }

  private func append(_ view: NSView, to stack: NSStackView) {
    stack.addArrangedSubview(view)
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
  }

  private func card(_ title: String? = nil) -> NSStackView {
    let container = TelaCardView()
    container.wantsLayer = true
    let content = NSStackView()
    content.distribution = .fill
    content.orientation = .vertical
    content.alignment = .leading
    content.spacing = 14
    content.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: TelaStyle.cardInset),
      content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -TelaStyle.cardInset),
      content.topAnchor.constraint(equalTo: container.topAnchor, constant: TelaStyle.cardVerticalInset),
      content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -TelaStyle.cardVerticalInset),
    ])
    if let detailStack {
      if let title {
        let heading = label(title)
        heading.font = .systemFont(ofSize: TelaStyle.bodySize, weight: .medium)
        append(heading, to: detailStack)
        detailStack.setCustomSpacing(10, after: heading)
      }
      append(container, to: detailStack)
      detailStack.setCustomSpacing(24, after: container)
    }
    return content
  }

  private func actionButton(_ title: String, action: Selector) -> NSButton {
    let button = TelaActionButton(title: title, target: self, action: action)
    button.setButtonType(.momentaryPushIn)
    button.isBordered = false
    button.wantsLayer = true
    button.font = TelaStyle.actionFont
    button.contentTintColor = .labelColor
    button.translatesAutoresizingMaskIntoConstraints = false
    button.heightAnchor.constraint(equalToConstant: 28).isActive = true
    let width = (title as NSString).size(withAttributes: [.font: button.font!]).width + 24
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: ceil(width)).isActive = true
    return button
  }

  private func row(_ title: String, subtitle: String? = nil, control: NSView, in stack: NSStackView) {
    let row = NSStackView()
    row.distribution = .fill
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 18
    let text = NSStackView()
    text.distribution = .fill
    text.orientation = .vertical
    text.alignment = .leading
    text.spacing = 4
    let name = label(title)
    name.font = .systemFont(ofSize: TelaStyle.bodySize, weight: .regular)
    append(name, to: text)
    if let subtitle { append(secondary(subtitle), to: text) }
    row.addArrangedSubview(text)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.init(1), for: .horizontal)
    spacer.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    row.addArrangedSubview(spacer)
    row.addArrangedSubview(control)
    text.setContentHuggingPriority(.defaultLow, for: .horizontal)
    control.setContentHuggingPriority(.required, for: .horizontal)
    control.setContentCompressionResistancePriority(.required, for: .horizontal)
    append(row, to: stack)
  }

  private func divider(in stack: NSStackView) {
    let line = NSBox()
    line.boxType = .separator
    append(line, to: stack)
  }

  private func addStatus(_ title: String, value: String, subtitle: String? = nil, to stack: NSStackView) {
    let ready = value == "Available" || value == "Ready" || value == "Running"
    let state = label("● " + value)
    state.font = .systemFont(ofSize: TelaStyle.captionSize, weight: .medium)
    state.textColor = ready ? .secondaryLabelColor : (value == "Checking…" ? .secondaryLabelColor : .systemOrange)
    row(title, subtitle: subtitle, control: state, in: stack)
  }

  private func pageHeader(_ subtitle: String) {
    guard let stack = detailStack else { return }
    let header = NSStackView()
    header.distribution = .fill
    header.orientation = .vertical
    header.alignment = .leading
    header.spacing = 6
    append(sectionTitle(selectedPage.rawValue), to: header)
    append(secondary(subtitle), to: header)
    append(header, to: stack)
    stack.setCustomSpacing(22, after: header)
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
    switch selectedPage {
    case .home:
      pageHeader("Your ChatGPT connections at a glance.")
      let connections = card()
      addStatus("Chat", value: availability(for: "chat"),
                subtitle: "Use your local workspace in ChatGPT.", to: connections)
      divider(in: connections)
      addStatus("Work / Codex", value: availability(for: "codex", needsProfile: true),
                subtitle: "Use Web models in your Codex conversations.", to: connections)
      if availability(for: "codex", needsProfile: true) == "Needs attention" {
        let help = card("Finish connecting Work")
        append(secondary("Open Work to connect or restart your ChatGPT profile."), to: help)
        help.addArrangedSubview(actionButton("Open Work", action: #selector(openWork)))
      }
      stack.addArrangedSubview(actionButton("Refresh status", action: #selector(refreshPage)))
    case .work:
      pageHeader("Connect ChatGPT and check your Web activity.")
      let profileCard = card(profiles.count > 1 ? "ChatGPT profiles" : "ChatGPT")
      if profiles.isEmpty { append(secondary("No Work profiles found."), to: profileCard) }
      for (index, profile) in profiles.enumerated() {
        if index > 0 { divider(in: profileCard) }
        let running = profile.controlState == "running" && profile.targetSessionState == "ready"
        let action = profile.controlState == "running" ? "stop" :
          (profile.controlState == "restart-required" ? "restart" : "start")
        let title = action == "stop" ? "Stop" : (action == "restart" ? "Restart" : "Connect")
        let button = actionButton(title, action: #selector(changeProfile(_:)))
        button.identifier = NSUserInterfaceItemIdentifier("profile:\(profile.slot):\(action)")
        let state = running ? "Connected to Tela" :
          (action == "restart" ? "Restart to connect with Tela" : "Not connected")
        row(profile.targetDisplayName, subtitle: state, control: button, in: profileCard)
      }
      let preview = card("Web activity")
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
        row("Profile", control: picker, in: preview)
      }
      if let bridgeImage {
        let imageView = NSImageView(image: bridgeImage)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        append(imageView, to: preview)
        imageView.heightAnchor.constraint(equalToConstant: 280).isActive = true
        append(secondary(bridgeMessage), to: preview)
      } else {
        let empty = NSStackView()
        empty.distribution = .fill
        empty.orientation = .vertical
        empty.alignment = .centerX
        empty.spacing = 10
        let icon = NSImageView(image: NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: nil) ?? NSImage())
        icon.contentTintColor = .tertiaryLabelColor
        empty.addArrangedSubview(icon)
        icon.heightAnchor.constraint(equalToConstant: 26).isActive = true
        let message = secondary(bridgeMessage == "No preview requested yet." ? "No snapshot yet" : bridgeMessage)
        message.alignment = .center
        append(message, to: empty)
        append(empty, to: preview)
        empty.heightAnchor.constraint(equalToConstant: 92).isActive = true
      }
      let actions = NSStackView()
      actions.distribution = .fill
      actions.orientation = .horizontal
      actions.spacing = 12
      actions.addArrangedSubview(actionButton("View snapshot", action: #selector(refreshBridgePreview)))
      actions.addArrangedSubview(secondary("Read-only · refreshes when requested"))
      preview.addArrangedSubview(actions)
      stack.addArrangedSubview(actionButton("Refresh status", action: #selector(refreshPage)))
    case .settings:
      pageHeader("Make Tela work the way you want.")
      let approvals = card("Approvals")
      let approval = NSSwitch()
      approval.target = self
      approval.action = #selector(toggleApproval(_:))
      approval.state = approvalAutomation == "recognized_once" ? .on : .off
      approval.isEnabled = !preferenceError
      approval.setAccessibilityLabel("Auto-approve one-time requests")
      row("Auto-approve one-time requests", subtitle: "Only recognized requests. All other approvals stay manual.", control: approval, in: approvals)
      divider(in: approvals)
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
      delayPicker.isEnabled = !preferenceError && approvalAutomation == "recognized_once"
      row("Wait before approving", control: delayPicker, in: approvals)
      append(secondary("Restart your Work profile to apply changes. This interrupts any active turn."), to: approvals)
      if preferenceError { append(secondary("Couldn't read approval settings."), to: approvals) }
      let connections = card("Connection details")
      for (index, service) in ["gateway", "chat", "codex"].enumerated() {
        if index > 0 { divider(in: connections) }
        let titles = ["gateway": "Tela connection", "chat": "Chat", "codex": "Work / Codex"]
        addStatus(titles[service]!, value: serviceStates[service] ?? "Checking…", to: connections)
      }
      divider(in: connections)
      addStatus("ChatGPT connector", value: ingressStatus?.availability.capitalized ?? "Checking…", to: connections)
      if let ingressStatus, ingressStatus.availability != "ready" {
        append(secondary(ingressStatus.detail), to: connections)
      }
      let support = card("Help & updates")
      row("Troubleshooting", subtitle: "View local logs to investigate a connection issue.",
          control: actionButton("Open logs", action: #selector(openLogs)), in: support)
      divider(in: support)
      row("Source preview", subtitle: "Updates are installed manually in this version.",
          control: label("Pre-release"), in: support)
      stack.addArrangedSubview(actionButton("Refresh details", action: #selector(refreshPage)))
    }
  }

  @objc private func openWork() {
    selectedPage = .work
    updateNavigation()
    renderCurrentPage()
    detailScroll?.contentView.scroll(to: .zero)
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

  @objc private func toggleApproval(_ sender: NSSwitch) {
    do {
      var preferences = try TelaPreferencesStore.read(at: preferencesURL)
      preferences.approvalAutomation = sender.state == .on ? "recognized_once" : "off"
      try TelaPreferencesStore.write(preferences, at: preferencesURL)
      approvalAutomation = preferences.approvalAutomation
      preferenceError = false
      onPreferencesChanged?()
      renderCurrentPage()
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
