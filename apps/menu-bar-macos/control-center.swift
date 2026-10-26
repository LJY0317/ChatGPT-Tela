import AppKit
import Foundation

// A status-bar utility's control surface accepts keyboard input without taking
// application activation away from the user's foreground app.
@MainActor
private final class TelaControlCenterPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

private struct ControlCenterServiceDescriptor: Decodable {
  let service: String
  let endpoint: String
  let bearerToken: String
}

private struct ControlCenterServiceStatus: Decodable {
  let service: String
  let state: String
}

private struct ControlCenterIngressStatus: Decodable, Equatable {
  let publicAvailability: String?
  let contractVersion: Int
  let availability: String
  let cause: String
  let detail: String
  let exposureKind: String?
  let externalClientReachability: String?
}

private typealias ControlCenterProfileStatus = TelaWorkProfile

private struct ControlCenterProfilesEnvelope: Decodable {
  let profiles: [ControlCenterProfileStatus]
}

private struct ControlCenterDelegationCapacity: Decodable {
  let contractVersion: Int
  let profileSlot: Int
  let source: String
  let coverage: String
  let total: Total
  struct Total: Decodable { let used: Int; let limit: Int }
  func valid(for slot: Int) -> Bool {
    contractVersion == 3 && profileSlot == slot && source == "managed_delegation_journal"
      && coverage == "managed_jobs_only" && (0...8).contains(total.used) && (1...5).contains(total.limit)
  }
}

private struct ControlCenterBridgeSurface: Decodable, Equatable { let id: String; let label: String; let title: String? }
private struct ControlCenterBridgeInventory: Decodable {
  let contractVersion: Int
  let slot: Int
  let revision: Int
  let surfaces: [ControlCenterBridgeSurface]
}
private struct ControlCenterApprovalWait: Decodable {
  let phase: String
  let elapsedMs: Int
  let operationState: String

  var statusText: String {
    if operationState == "stopping" { return "Ending this Web operation; remote outcome unconfirmed." }
    let seconds = max(0, elapsedMs) / 1000
    let elapsed = "\(seconds / 60)m \(seconds % 60)s"
    if phase == "card_cleared" { return "Card cleared; task progress unconfirmed · \(elapsed)" }
    return "Approval waiting · \(elapsed)"
  }
}

private struct ControlCenterBridgePreview: Decodable {
  let approvalState: String?
  let approvalObservationReason: String?
  let approvalWait: ControlCenterApprovalWait?
  let contractVersion: Int
  let slot: Int
  let activeSurfaceCount: Int
  let surfaces: [ControlCenterBridgeSurface]?
  let selectedSurfaceId: String?
  let previewAvailable: Bool
  let imageMimeType: String?
  let imageBase64: String?
}

private struct TelaChatFolderStatus: Decodable { let roots: [String]; let applied: Bool }

private struct TelaBootstrapStatus: Decodable {
  let configuration: String
  let publicUrl: String?
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

private final class SessionSidebarStack: NSStackView {
  override var isFlipped: Bool { true }
}

// AppKit supplies the hover timing; the popover keeps click-to-show help stable.
private final class DelegationHelpButton: NSButton, NSViewToolTipOwner {
  var helpText = ""
  private var tracking: NSTrackingArea?
  private var popover: NSPopover?

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
    addTrackingArea(area)
    tracking = area
    removeAllToolTips()
    addToolTip(bounds, owner: self, userData: nil)
  }

  func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData: UnsafeMutableRawPointer?) -> String {
    showHelp(self)
    return ""
  }

  @objc func showHelp(_ sender: Any?) {
    if popover?.isShown == true { return }
    let message = NSTextField(wrappingLabelWithString: helpText)
    message.font = .systemFont(ofSize: TelaStyle.bodySize)
    message.translatesAutoresizingMaskIntoConstraints = false
    let controller = NSViewController()
    controller.view = NSView()
    controller.view.addSubview(message)
    NSLayoutConstraint.activate([
      message.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor, constant: TelaStyle.cardInset),
      message.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor, constant: -TelaStyle.cardInset),
      message.topAnchor.constraint(equalTo: controller.view.topAnchor, constant: TelaStyle.cardVerticalInset),
      message.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor, constant: -TelaStyle.cardVerticalInset),
      message.widthAnchor.constraint(equalToConstant: 260),
    ])
    let help = NSPopover()
    help.behavior = .applicationDefined
    help.contentViewController = controller
    popover = help
    help.show(relativeTo: bounds, of: self, preferredEdge: .maxY)
  }

  override func mouseExited(with event: NSEvent) {
    super.mouseExited(with: event)
    popover?.close()
    popover = nil
  }

  override func viewWillMove(toWindow newWindow: NSWindow?) {
    if newWindow == nil { popover?.close(); popover = nil }
    super.viewWillMove(toWindow: newWindow)
  }
}

private final class FlippedDocumentView: NSView {
  override var isFlipped: Bool { true }
}

@MainActor
final class TelaControlCenterController: NSObject, NSWindowDelegate {
  var onPreferencesChanged: (() -> Void)?
  var onConnectionProgressChanged: ((String?) -> Void)?
  var connectionOperationInProgress: Bool { operationInProgress }
  var connectionProgressSlot: Int? { connectionProfileSlot }
  func workInventoryDidChange() {
    clearResolvedProfileFailure()
    rememberRunningProfileApps(profiles)
    if accountInventory != profiles {
      accountInventory = profiles
      accountRevision += 1
      profileAccounts.removeAll()
      if !refreshing { refreshProfileAccounts() }
    }
    updateSurfaceWatches()
    if !refreshing && (selectedPage == .work || selectedPage == .home) { renderCurrentPage() }
  }
  private let fileManager = FileManager.default
  private let home: URL
  init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
    home = homeDirectory
    super.init()
  }
  private var window: NSWindow?
  private var detailStack: NSStackView?
  private var detailScroll: NSScrollView?
  private var navigationButtons: [ControlCenterPage: NSButton] = [:]
  private var selectedPage: ControlCenterPage = .home
  private var serviceStates: [String: String] = [:]
  private var ingressStatus: ControlCenterIngressStatus?
  let workState = TelaWorkState()
  private var workInventory: TelaWorkInventory {
    get { workState.inventory }
    set { workState.inventory = newValue }
  }
  private var runningProfileApps: [Int: NSRunningApplication] = [:]
  private var profiles: [ControlCenterProfileStatus] { workInventory.profiles }
  private var profileAccounts: [Int: TelaAccountDisplay] = [:]
  private var accountInventory: [TelaWorkProfile] = []
  private var accountRevision = 0
  private var accountTask: Task<Void, Never>?
  private var accountRefreshPending = false
  private var refreshing = false
  private var refreshWaiters: [CheckedContinuation<Void, Never>] = []
  private var changingProfile = false { didSet {
    clearResolvedProfileFailure()
    onConnectionProgressChanged?(profileProgress)
  } }
  private var connectionProfileSlot: Int? { didSet { onConnectionProgressChanged?(profileProgress) } }
  private var profileProgress: String? {
    didSet { if profileProgress != oldValue { onConnectionProgressChanged?(profileProgress) } }
  }
  private var profileFailure: String? { didSet { profileConnectionFailure = nil } }
  private var profileConnectionFailure: TelaProfileConnectionFailure?
  private func clearResolvedProfileFailure() {
    if profileConnectionFailure?.resolved(in: workInventory, operationInProgress: changingProfile) == true {
      profileFailure = nil
    }
  }
  private var changingServices = false
  private var serviceAction: String?
  private var previewLoads = 0
  private var bootstrapState = "checking"
  private var connectorURL: String?
  private var savingConfiguration = false
  private var settingUp = false
  private var setupMessage: String?
  private var endpointField: NSTextField?
  private var portField: NSTextField?
  private var exposurePicker: NSPopUpButton?
  private var exposureConsent: NSButton?
  private var endpointDraft = ""
  private var portDraft = "18743"
  private var exposureDraft = "existing-https"
  private var consentDraft = false
  private var chatFolders: [String] = []
  private var chatFoldersAvailable = false
  private var chatFoldersApplied = false
  private var chatFolderMessage = ""
  private var changingChatFolders = false
  private var launchingMaintenance = false
  private var operationInProgress: Bool { changingProfile || changingServices || changingChatFolders || savingConfiguration || settingUp || launchingMaintenance }
  private var approvalAutomation = "off"
  private var approvalDelay = "instant"
  private var delegationLimits: [String: Int] = [:]
  private var delegationCapacity: [Int: ControlCenterDelegationCapacity] = [:]
  private var bridgeImage: NSImage?
  private var bridgeMessage = "No preview requested yet."
  private var selectedPreviewSlot: Int?
  private var bridgeSurfaces: [Int: [ControlCenterBridgeSurface]] = [:]
  private var surfaceWatches: [Int: Task<Void, Never>] = [:]
  private var surfaceWatchIDs: [Int: UUID] = [:]
  private var surfaceEndpoint: String?
  private var surfaceOwners: [Int: String] = [:]
  private var surfaceMessages: [Int: String] = [:]
  private var selectedBridgeSurface: String?
  private var previewRevision = 0
  private var preferenceError = false
  private let delegationHelpText = "Web delegations run tasks in separate ChatGPT conversations. This usage counts tasks managed by Tela; your other chats are not included."

  private var supportRoot: URL {
    home.appendingPathComponent("Library/Application Support/ChatGPT Tela", isDirectory: true)
  }
  private var runtimeServicesRoot: URL {
    supportRoot.appendingPathComponent("runtime/services", isDirectory: true)
  }
  private var preferencesURL: URL {
    supportRoot.appendingPathComponent("config/preferences-v1.json", isDirectory: false)
  }

  func show() {
    if window == nil { buildWindow() }
    guard let window else { return }
    // Explicit Open Tela is a reveal action. An inactive utility must order the
    // panel above other apps once, without taking activation or changing its level.
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    onWindowStateChanged?("window_shown")
    updateSurfaceWatches()
    Task { await refreshCurrentPage() }
  }

  var onWindowStateChanged: ((String) -> Void)?
  /** Bounded own-UI decision evidence. Never serialize prompt text or auto-approve. */
  var onDecisionStateChanged: ((String, Int, String) -> Void)?
  var windowStateEvidence: [String: Bool] {
    ["visible": window?.isVisible == true, "key": window?.isKeyWindow == true,
      "main": window?.isMainWindow == true, "onscreen": window?.occlusionState.contains(.visible) == true]
  }
  func windowDidBecomeKey(_ notification: Notification) { onWindowStateChanged?("window_key") }
  func windowDidResignKey(_ notification: Notification) { onWindowStateChanged?("window_not_key") }
  func windowDidChangeOcclusionState(_ notification: Notification) {
    onWindowStateChanged?("window_visibility_changed")
    updateSurfaceWatches()
  }

  func showFirstUseIfNeeded() async {
    await loadBootstrapStatus()
    if bootstrapState == "missing" { show() }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // The control center is a view over the background product. Closing it must not stop Tela.
    sender.orderOut(nil)
    updateSurfaceWatches()
    clearAccountDisplay()
    return false
  }

  private func buildWindow() {
    let window = TelaControlCenterPanel(
      contentRect: NSRect(x: 0, y: 0, width: 880, height: 640),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    window.title = "ChatGPT Tela"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.minSize = NSSize(width: 760, height: 520)
    window.backgroundColor = .windowBackgroundColor
    window.isReleasedWhenClosed = false
    window.isFloatingPanel = false
    window.level = .normal
    window.hidesOnDeactivate = false
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

  private func row(_ title: String, subtitle: String? = nil, control: NSView, in stack: NSStackView, emphasized: Bool = false) {
    let row = NSView()
    let text = NSStackView()
    text.distribution = .fill
    text.orientation = .vertical
    text.alignment = .leading
    text.spacing = 4
    let name = label(title)
    name.font = .systemFont(ofSize: TelaStyle.bodySize, weight: emphasized ? .semibold : .regular)
    append(name, to: text)
    if let subtitle { append(secondary(subtitle), to: text) }
    text.translatesAutoresizingMaskIntoConstraints = false
    control.translatesAutoresizingMaskIntoConstraints = false
    row.addSubview(text)
    row.addSubview(control)
    control.setContentHuggingPriority(.required, for: .horizontal)
    control.setContentCompressionResistancePriority(.required, for: .horizontal)
    append(row, to: stack)
    // Text receives exactly the space left by the trailing control. Its wrapping measurement
    // must never compete with a spacer for width during asynchronous status refresh.
    NSLayoutConstraint.activate([
      text.leadingAnchor.constraint(equalTo: row.leadingAnchor),
      text.trailingAnchor.constraint(equalTo: control.leadingAnchor, constant: -TelaStyle.cardInset),
      control.trailingAnchor.constraint(equalTo: row.trailingAnchor),
      text.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      control.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      row.heightAnchor.constraint(greaterThanOrEqualTo: text.heightAnchor),
      row.heightAnchor.constraint(greaterThanOrEqualTo: control.heightAnchor),
    ])
    let height = row.heightAnchor.constraint(equalTo: text.heightAnchor)
    height.priority = .defaultLow
    height.isActive = true
  }

  private func delegationRow(usage: String, help: DelegationHelpButton, in stack: NSStackView) {
    let rowView = NSView()
    let title = label("Web delegations")
    let value = secondary(usage)
    for view in [rowView, title, value, help] { view.translatesAutoresizingMaskIntoConstraints = false }
    rowView.addSubview(title)
    rowView.addSubview(value)
    rowView.addSubview(help)
    append(rowView, to: stack)
    NSLayoutConstraint.activate([
      title.leadingAnchor.constraint(equalTo: rowView.leadingAnchor),
      title.centerYAnchor.constraint(equalTo: rowView.centerYAnchor),
      value.trailingAnchor.constraint(equalTo: help.leadingAnchor, constant: -8),
      value.centerYAnchor.constraint(equalTo: rowView.centerYAnchor),
      help.trailingAnchor.constraint(equalTo: rowView.trailingAnchor),
      help.centerYAnchor.constraint(equalTo: rowView.centerYAnchor),
      rowView.heightAnchor.constraint(greaterThanOrEqualToConstant: 24),
    ])
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

  private func pageHeader(_ subtitle: String, title: String? = nil) {
    guard let stack = detailStack else { return }
    let header = NSStackView()
    header.distribution = .fill
    header.orientation = .vertical
    header.alignment = .leading
    header.spacing = 6
    append(sectionTitle(title ?? selectedPage.rawValue), to: header)
    if let activity = activityMessage {
      let progress = NSProgressIndicator()
      progress.style = .spinning
      progress.controlSize = .small
      progress.isIndeterminate = true
      progress.setAccessibilityLabel(activity)
      let line = NSStackView(views: [progress, secondary(activity)])
      line.orientation = .horizontal
      line.spacing = 8
      append(line, to: header)
      progress.startAnimation(nil)
    }
    if !subtitle.isEmpty { append(secondary(subtitle), to: header) }
    append(header, to: stack)
    stack.setCustomSpacing(22, after: header)
  }

  private var activityMessage: String? {
    if changingServices { return serviceAction }
    if changingProfile { return profileProgress ?? "Connecting…" }
    if savingConfiguration { return "Saving settings…" }
    if settingUp { return "Waiting for sign-in…" }
    if changingChatFolders { return "Updating folder access…" }
    if launchingMaintenance { return "Opening maintenance…" }
    if previewLoads > 0 { return "Loading preview…" }
    if refreshing { return "Checking status…" }
    return nil
  }

  private func addTelaControl() {
    guard installedServiceControlsAvailable() else { return }
    let ready = ["gateway", "chat", "codex"].allSatisfy { serviceStates[$0] == "Ready" }
    guard !ready || changingServices else { return }
    let connection = card("Tela")
    if changingServices {
      append(secondary(serviceAction ?? "Updating…"), to: connection)
    } else if serviceStates.isEmpty {
      append(secondary("Checking…"), to: connection)
    } else {
      let stopped = serviceStates.values.allSatisfy { $0 == "Stopped" }
      let start = actionButton("Start Tela", action: #selector(startServices))
      start.isEnabled = !operationInProgress && !refreshing
      row(stopped ? "Off" : "Needs attention", control: start, in: connection)
    }
  }

  private func availability(for service: String, needsProfile: Bool = false) -> String {
    if serviceStates[service] == nil { return "Checking…" }
    let profileReady = !needsProfile || (workInventory.error == nil && profiles.contains {
      $0.connected && $0.connectionInProgress != true
    })
    if !needsProfile {
      let connection = TelaIngressPresentation(localReady: serviceStates["gateway"] == "Ready" && serviceStates[service] == "Ready",
        availability: ingressStatus?.availability, publicAvailability: ingressStatus?.publicAvailability)
      return connection.status == "Ready" ? "Available" : connection.status
    }
    return serviceStates[service] == "Ready" && profileReady ? "Available" : "Needs attention"
  }

  private func renderCurrentPage() {
    guard let stack = detailStack else { return }
    onConnectionProgressChanged?(activityMessage)
    // Preserve an unfinished form across on-demand connection refreshes.
    if let field = endpointField { endpointDraft = field.stringValue }
    if let field = portField { portDraft = field.stringValue }
    if let picker = exposurePicker { exposureDraft = picker.selectedItem?.representedObject as? String ?? exposureDraft }
    if let consent = exposureConsent { consentDraft = consent.state == .on }
    endpointField = nil; portField = nil; exposurePicker = nil; exposureConsent = nil
    clearDetail()
    if installedServiceControlsAvailable() && bootstrapState != "configured" {
      renderFirstUse()
      return
    }
    switch selectedPage {
    case .home:
      pageHeader("Your ChatGPT connections at a glance.")
      addTelaControl()
      let connections = card()
      addStatus("Chat", value: availability(for: "chat"),
                subtitle: "Use your local workspace in ChatGPT.", to: connections)
      divider(in: connections)
      addStatus("Work / Codex", value: availability(for: "codex", needsProfile: true),
                subtitle: "Use Web models in your Codex conversations.", to: connections)
      if serviceStates["codex"] == "Ready" && availability(for: "codex", needsProfile: true) == "Needs attention" {
        let help = card("Finish connecting Work")
        append(secondary("Open Work to get Web models ready in ChatGPT."), to: help)
        help.addArrangedSubview(actionButton("Open Work", action: #selector(openWork)))
      }
      stack.addArrangedSubview(actionButton("Refresh status", action: #selector(refreshPage)))
    case .work:
      pageHeader("Your ChatGPT connections.")
      addTelaControl()
      if installedServiceControlsAvailable() && serviceStates["codex"] == "Ready" && (profiles.isEmpty || settingUp || setupMessage != nil) {
        let setup = card("Sign in and connect ChatGPT")
        append(secondary("Sign in in Tela's login window. Open ChatGPT Plugins and connect ChatGPT Tela using the address below. Reuse an existing connection when available. Then finish setup in the login window."), to: setup)
        setup.addArrangedSubview(actionButton("Open ChatGPT Plugins", action: #selector(openChatGPTPlugins)))
        if let connectorURL {
          let address = secondary(connectorURL)
          address.isSelectable = true
          append(address, to: setup)
          setup.addArrangedSubview(actionButton("Copy connection address", action: #selector(copyConnectionAddress)))
        }
        if profiles.isEmpty {
          let login = actionButton("Open ChatGPT login", action: #selector(openLoginSetup(_:)))
          login.tag = 1
          login.isEnabled = !operationInProgress && serviceStates["codex"] == "Ready"
          setup.addArrangedSubview(login)
        }
        if settingUp { append(secondary("Complete setup in the login window. Choose Finish setup from its menu or close the window. Cancel setup leaves the profile disconnected."), to: setup) }
        if let setupMessage { append(secondary(setupMessage), to: setup) }
      }
      if workInventory.error != nil {
        let unavailable = card()
        row("Connection status unavailable", control: actionButton("Refresh", action: #selector(refreshPage)), in: unavailable)
      } else if profiles.isEmpty {
        append(secondary("No ChatGPT profiles found."), to: card())
      }
      for profile in profiles {
        let profileCard = card()
        let account = profileAccounts[profile.slot]
        let open = actionButton("Open app", action: #selector(openProfileButton(_:)))
        open.tag = profile.slot
        open.isEnabled = workInventory.error == nil && profile.connectionInProgress != true && (profile.connected || !operationInProgress)
        row(profile.targetDisplayName, subtitle: account?.native.email, control: open, in: profileCard, emphasized: true)
        divider(in: profileCard)

        let toggle = NSSwitch()
        toggle.controlSize = .small
        let connection = webConnectionPresentation(for: profile)
        toggle.state = connection.enabled ? .on : .off
        toggle.target = self
        toggle.action = #selector(toggleProfile(_:))
        toggle.tag = profile.slot
        toggle.isEnabled = workInventory.error == nil && !operationInProgress && profile.connectionInProgress != true
        toggle.setAccessibilityLabel("Connect \(profile.targetDisplayName) to Tela")
        let connectionControls = NSStackView()
        connectionControls.orientation = .horizontal
        connectionControls.spacing = 8
        if let title = connection.buttonTitle {
          let retry = actionButton(title, action: #selector(retryProfileConnection(_:)))
          retry.tag = profile.slot
          retry.isEnabled = toggle.isEnabled
          connectionControls.addArrangedSubview(retry)
        }
        connectionControls.addArrangedSubview(toggle)
        row("Web models", subtitle: workInventory.error != nil ? "Status unavailable" : connection.status,
            control: connectionControls, in: profileCard)
        let help = DelegationHelpButton(title: "?", target: nil, action: nil)
        help.target = help
        help.action = #selector(DelegationHelpButton.showHelp(_:))
        help.bezelStyle = .helpButton
        help.controlSize = .small
        help.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        help.setButtonType(.momentaryPushIn)
        help.helpText = delegationHelpText
        help.setAccessibilityLabel("Web delegations help")
        help.setAccessibilityHelp(delegationHelpText)
        let usage = delegationCapacity[profile.slot].map { "\($0.total.used) of \($0.total.limit) slots in use" } ?? "Usage unavailable"

        let web = TelaWebPresentation(profile: profile, account: account)
        let controls = NSStackView()
        controls.orientation = .horizontal
        controls.spacing = 8
        let localProgress = connectionProfileSlot == profile.slot ? profileProgress : nil
        let busy = TelaProfilePresentation(profile: profile, inventoryError: workInventory.error, localProgress: localProgress).busy
        if busy {
          let progress = NSProgressIndicator()
          progress.style = .spinning
          progress.controlSize = .small
          progress.isIndeterminate = true
          progress.setAccessibilityLabel("Checking Web connection")
          controls.addArrangedSubview(progress)
          progress.startAnimation(nil)
        }
        if let title = web.buttonTitle, installedServiceControlsAvailable() {
          let selector: Selector
          switch web.action {
          case .account: selector = #selector(openLoginSetup(_:))
          case .reconnect: selector = #selector(reconnectWebButton(_:))
          case .finish: selector = #selector(finishWebAccountButton(_:))
          case .none: selector = #selector(refreshPage)
          }
          let button = actionButton(title, action: selector)
          button.tag = profile.slot
          button.isEnabled = !operationInProgress && workInventory.error == nil
          controls.addArrangedSubview(button)
        }
        if controls.arrangedSubviews.isEmpty {
          controls.widthAnchor.constraint(equalToConstant: 0).isActive = true
        }
        if connectionProfileSlot == profile.slot, let message = profileFailure {
          append(secondary(message), to: profileCard)
        }
        row("Account", subtitle: workInventory.error == nil ? (localProgress ?? web.status) : "Status unavailable",
            control: controls, in: profileCard)
        delegationRow(usage: usage, help: help, in: profileCard)
      }
      let preview = card("Web activity")
      let runningProfiles = profiles.filter { $0.controlState == "running" }
      let activityLayout = NSStackView()
      activityLayout.orientation = .horizontal
      activityLayout.alignment = .top
      activityLayout.distribution = .fill
      activityLayout.spacing = 12
      let sessionList = SessionSidebarStack()
      sessionList.orientation = .vertical
      sessionList.alignment = .leading
      sessionList.distribution = .fill
      sessionList.spacing = 6
      let sessionScroll = NSScrollView()
      sessionScroll.hasVerticalScroller = true
      sessionScroll.autohidesScrollers = true
      sessionScroll.drawsBackground = false
      sessionScroll.borderType = .noBorder
      sessionScroll.documentView = sessionList
      sessionList.translatesAutoresizingMaskIntoConstraints = false
      sessionScroll.translatesAutoresizingMaskIntoConstraints = false
      activityLayout.addArrangedSubview(sessionScroll)
      let sessionDivider = NSBox()
      sessionDivider.boxType = .separator
      activityLayout.addArrangedSubview(sessionDivider)
      let previewPane = NSStackView()
      previewPane.orientation = .vertical
      previewPane.alignment = .leading
      previewPane.distribution = .fill
      previewPane.spacing = 10
      activityLayout.addArrangedSubview(previewPane)
      let sessionSidebarWidth: CGFloat = 100
      sessionScroll.heightAnchor.constraint(equalTo: activityLayout.heightAnchor).isActive = true
      sessionDivider.heightAnchor.constraint(equalTo: activityLayout.heightAnchor).isActive = true
      previewPane.heightAnchor.constraint(equalTo: activityLayout.heightAnchor).isActive = true
      sessionList.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
      sessionDivider.widthAnchor.constraint(equalToConstant: 1).isActive = true
      previewPane.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
      activityLayout.heightAnchor.constraint(equalToConstant: 340).isActive = true
      preview.addArrangedSubview(activityLayout)
      activityLayout.widthAnchor.constraint(equalTo: preview.widthAnchor).isActive = true
      for profile in runningProfiles {
        if profiles.count > 1 {
          let heading = label(profile.targetDisplayName)
          heading.font = .systemFont(ofSize: TelaStyle.bodySize, weight: .semibold)
          sessionList.addArrangedSubview(heading)
          heading.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
        }
        let surfaces = bridgeSurfaces[profile.slot] ?? []
        if let message = surfaceMessages[profile.slot] {
          let status = secondary(message); sessionList.addArrangedSubview(status)
          status.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
        } else if bridgeSurfaces[profile.slot] == nil {
          let status = secondary("Loading…"); sessionList.addArrangedSubview(status)
          status.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
        } else if surfaces.isEmpty {
          let status = secondary("No active Web sessions")
          sessionList.addArrangedSubview(status)
          status.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
        }
        for surface in surfaces {
          let selected = selectedPreviewSlot == profile.slot && selectedBridgeSurface == surface.id
          let title = displayBridgeTitle(surface.title) ?? surface.label
          let button = NSButton(title: title, target: self, action: #selector(selectBridgeSurface(_:)))
          button.setButtonType(.pushOnPushOff)
          button.bezelStyle = .recessed
          button.state = selected ? .on : .off
          button.alignment = .left
          button.lineBreakMode = .byTruncatingTail
          button.tag = profile.slot
          button.identifier = NSUserInterfaceItemIdentifier(surface.id)
          button.toolTip = surface.title ?? surface.label
          button.setAccessibilityLabel(surface.title ?? surface.label)
          sessionList.addArrangedSubview(button)
          button.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
        }
        if let last = sessionList.arrangedSubviews.last {
          sessionList.setCustomSpacing(18, after: last)
        }
      }
      sessionScroll.widthAnchor.constraint(equalToConstant: sessionSidebarWidth).isActive = true
      if runningProfiles.isEmpty {
        let status = secondary("No active Web sessions"); sessionList.addArrangedSubview(status)
        status.widthAnchor.constraint(equalTo: sessionScroll.contentView.widthAnchor).isActive = true
      }
      let previewContent = NSView()
      append(previewContent, to: previewPane)
      previewContent.setContentHuggingPriority(.defaultLow, for: .vertical)
      previewContent.heightAnchor.constraint(greaterThanOrEqualToConstant: 170).isActive = true
      if let bridgeImage {
        let imageView = NSImageView(image: bridgeImage)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        previewContent.addSubview(imageView)
        NSLayoutConstraint.activate([
          imageView.leadingAnchor.constraint(equalTo: previewContent.leadingAnchor),
          imageView.trailingAnchor.constraint(equalTo: previewContent.trailingAnchor),
          imageView.topAnchor.constraint(equalTo: previewContent.topAnchor),
          imageView.bottomAnchor.constraint(equalTo: previewContent.bottomAnchor),
        ])
        append(secondary(bridgeMessage), to: previewPane)
      } else {
        let empty = NSStackView()
        empty.orientation = .vertical
        empty.alignment = .centerX
        empty.spacing = 10
        let icon = NSImageView(image: NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: nil) ?? NSImage())
        icon.contentTintColor = .tertiaryLabelColor
        empty.addArrangedSubview(icon)
        icon.heightAnchor.constraint(equalToConstant: 26).isActive = true
        let message = secondary(bridgeMessage == "No preview requested yet." ? "No snapshot yet" : bridgeMessage)
        message.alignment = .center
        empty.addArrangedSubview(message)
        empty.translatesAutoresizingMaskIntoConstraints = false
        previewContent.addSubview(empty)
        NSLayoutConstraint.activate([
          empty.centerXAnchor.constraint(equalTo: previewContent.centerXAnchor),
          empty.centerYAnchor.constraint(equalTo: previewContent.centerYAnchor),
          empty.leadingAnchor.constraint(greaterThanOrEqualTo: previewContent.leadingAnchor),
          empty.trailingAnchor.constraint(lessThanOrEqualTo: previewContent.trailingAnchor),
        ])
      }
      let actions = NSStackView()
      actions.distribution = .fill
      actions.orientation = .horizontal
      actions.spacing = 12
      let snapshot = actionButton("View snapshot", action: #selector(refreshBridgePreview))
      snapshot.isEnabled = selectedBridgeSurface != nil
      actions.addArrangedSubview(snapshot)
      let show = actionButton("Open browser", action: #selector(revealBridgeSurface))
      show.isEnabled = selectedBridgeSurface != nil
      actions.addArrangedSubview(show)
      let interact = actionButton("Interact…", action: #selector(interactBridgeSurface))
      interact.isEnabled = selectedBridgeSurface != nil
      actions.addArrangedSubview(interact)
      interact.toolTip = "Allow input in the browser. Changing chats can interrupt the task."
      previewPane.addArrangedSubview(actions)
      actions.bottomAnchor.constraint(equalTo: previewPane.bottomAnchor).isActive = true
      stack.addArrangedSubview(actionButton("Refresh status", action: #selector(refreshPage)))
    case .settings:
      pageHeader("Make Tela work the way you want.")
      let folders = card("Chat · Local folders")
      append(secondary("Choose folders ChatGPT may read and edit through Tela Chat. Your files remain yours."), to: folders)
      if !chatFoldersAvailable { append(secondary("Folder settings unavailable. Refresh details or update Tela."), to: folders) }
      else if chatFolders.isEmpty { append(secondary("No folders approved yet."), to: folders) }
      for (index, path) in chatFolders.enumerated() {
        let remove = actionButton("Remove access…", action: #selector(removeChatFolder(_:)))
        remove.tag = index; remove.isEnabled = !operationInProgress
        row(URL(fileURLWithPath:path).lastPathComponent, subtitle:path, control:remove, in:folders)
      }
      let choose = actionButton("Choose folder…", action:#selector(chooseChatFolder))
      choose.isEnabled = chatFoldersAvailable && !operationInProgress
      folders.addArrangedSubview(choose)
      if chatFoldersAvailable && !chatFoldersApplied {
        append(secondary("Saved folder access is not active yet. Applying it restarts only Chat and interrupts running Chat commands."), to:folders)
        let apply = actionButton("Apply Chat settings…", action:#selector(applyChatFolders))
        apply.isEnabled = !operationInProgress; folders.addArrangedSubview(apply)
      }
      if !chatFolderMessage.isEmpty { append(secondary(chatFolderMessage), to:folders) }
      let approvals = card("Approvals")
      let approval = NSSwitch()
      approval.controlSize = .small
      approval.target = self
      approval.action = #selector(toggleApproval(_:))
      approval.state = approvalAutomation == "off" ? .off : .on
      approval.isEnabled = !preferenceError
      approval.setAccessibilityLabel("Full access approval")
      row("Full access approval", subtitle: "Allow for this conversation when available; otherwise allow once.",
        control: approval, in: approvals)
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
      delayPicker.isEnabled = !preferenceError && approvalAutomation != "off"
      row("Wait before approving", control: delayPicker, in: approvals)
      append(secondary("Restart your Work profile to apply changes. This interrupts any active turn."), to: approvals)
      if preferenceError { append(secondary("Couldn't read approval settings."), to: approvals) }
      let delegations = card("Web delegations")
      for profile in profiles {
        let picker = NSPopUpButton()
        for count in 1...5 {
          picker.addItem(withTitle: String(count))
          picker.lastItem?.representedObject = count
        }
        picker.selectItem(at: (delegationLimits[String(profile.slot)] ?? 3) - 1)
        picker.tag = profile.slot
        picker.target = self
        picker.action = #selector(setDelegationLimit(_:))
        picker.isEnabled = !preferenceError
        row(profiles.count == 1 ? "Concurrent tasks" : "\(profile.targetDisplayName) · Concurrent tasks",
            control: picker, in: delegations)
      }
      if installedServiceControlsAvailable() {
        let background = card("Tela")
        let running = serviceStates.values.contains("Ready")
        let button = actionButton(running ? "Stop Tela…" : "Start Tela", action: running ? #selector(stopServices) : #selector(startServices))
        button.isEnabled = !operationInProgress
        row("Background activity", subtitle: changingServices ? "Updating…" : nil, control: button, in: background)
      }
      let support = card()
      row("ChatGPT plugin", subtitle: "Manage or remove the plugin in ChatGPT. Tela stays installed on this computer.",
          control: actionButton("Manage…", action: #selector(openChatGPTPlugins)), in: support)
      let maintain = actionButton("Open…", action: #selector(openMaintenance))
      maintain.isEnabled = !operationInProgress && installedServiceControlsAvailable()
      row("Updates & maintenance", subtitle: launchingMaintenance ? "Opening…" : nil, control: maintain, in: support)
      stack.addArrangedSubview(actionButton("Refresh details", action: #selector(refreshPage)))
    }
  }

  @objc private func openChatGPTPlugins() {
    NSWorkspace.shared.open(telaChatGPTPluginsURL)
  }

  private func installedServiceControlsAvailable() -> Bool {
    guard let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return false }
    return fileManager.isExecutableFile(atPath: launcher)
  }

  private nonisolated static func runChatFolderCommand(_ launcher: String, _ args: [String]) -> (Int32, Data) {
    let process = Process(); process.executableURL = URL(fileURLWithPath:launcher); process.arguments = args
    let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    do { try process.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
      return (process.terminationStatus, data.count <= 1_048_576 ? data : Data())
    } catch { return (1,Data()) }
  }
  private func loadChatFolders() async {
    guard let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return }
    let result = await Task.detached { Self.runChatFolderCommand(launcher,["chat","roots"]) }.value
    if result.0 == 0, let status = try? JSONDecoder().decode(TelaChatFolderStatus.self,from:result.1) {
      chatFolders = status.roots; chatFoldersApplied = status.applied; chatFoldersAvailable = true
    } else { chatFoldersAvailable = false }
  }
  @objc private func chooseChatFolder() {
    guard !operationInProgress else { return }
    let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
    panel.message = "Approve this folder and its subfolders for reading and editing through Tela Chat."
    guard panel.runModal() == .OK, let path = panel.url?.path else { return }
    changeChatFolders(["chat","allow-root","--path",path])
  }
  @objc private func removeChatFolder(_ sender: NSButton) {
    guard !operationInProgress, chatFolders.indices.contains(sender.tag) else { return }
    let alert = NSAlert(); alert.messageText = "Remove Chat access to this folder?"
    alert.informativeText = "Your files will be kept. Apply Chat settings afterward to stop access; broader approved parent folders still grant access."
    alert.addButton(withTitle:"Remove access"); alert.addButton(withTitle:"Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    changeChatFolders(["chat","disallow-root","--path",chatFolders[sender.tag]])
  }
  @objc private func applyChatFolders() {
    guard !operationInProgress else { return }
    let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "Apply Chat folder access?"
    alert.informativeText = "This restarts Tela Chat and interrupts running Chat commands. Work / Codex profiles stay open."
    alert.addButton(withTitle:"Apply settings"); alert.addButton(withTitle:"Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    changeChatFolders(["services","restart","chat"])
  }
  private func changeChatFolders(_ args: [String]) {
    guard let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return }
    changingChatFolders = true; chatFolderMessage = args.first == "chat" ? "Saving folder access…" : "Applying Chat settings…"; renderCurrentPage()
    Task {
      let result = await Task.detached { Self.runChatFolderCommand(launcher,args) }.value
      await loadChatFolders(); changingChatFolders = false
      chatFolderMessage = result.0 == 0 ? (chatFoldersApplied ? "Chat folder access is active." : "Saved. Apply Chat settings to activate folder access.") : "Couldn't change Chat settings. Refresh details and check logs."
      renderCurrentPage()
    }
  }

  @objc private func openMaintenance() {
    guard !operationInProgress, let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return }
    launchingMaintenance = true; renderCurrentPage()
    Task {
      let result = await Task.detached { Self.runLauncher(launcher, arguments: ["maintenance-open"]) }.value
      launchingMaintenance = false; renderCurrentPage()
      if result.0 != 0 {
        let alert = NSAlert(); alert.messageText = "Couldn't open Tela maintenance"
        alert.informativeText = "This package may need updating, or its installed files couldn't be verified. Use a trusted extracted package for repair."
        alert.addButton(withTitle: "Choose repair package…"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { openMaintenanceFromRepairPackage(launcher) }
      }
    }
  }

  private func openMaintenanceFromRepairPackage(_ launcher: String) {
    let package = NSOpenPanel(); package.canChooseFiles = false; package.canChooseDirectories = true
    package.allowsMultipleSelection = false; package.message = "Select a repair package matching the installed Tela version."
    guard package.runModal() == .OK, let source = package.url else { return }
    launchingMaintenance = true; renderCurrentPage()
    Task {
      let result = await Task.detached { Self.runLauncher(launcher, arguments: ["maintenance-open", "--payload", source.path]) }.value
      launchingMaintenance = false; renderCurrentPage()
      if result.0 != 0 {
        let alert = NSAlert(); alert.messageText = "Couldn't verify the repair package"
        alert.informativeText = "Check its version and source. If Tela's launcher is missing too, use a separately extracted trusted installer. No changes were applied."
        alert.addButton(withTitle: "OK"); alert.runModal()
      }
    }
  }

  // All setup mutations use the verified installed launcher; the UI owns no config authority.
  private nonisolated static func runLauncher(_ launcher: String, arguments: [String], input: Data? = nil,
                                               capture: Bool = false) -> (Int32, Data) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launcher)
    process.arguments = arguments
    let output = Pipe()
    let stdin = Pipe()
    process.standardOutput = capture ? output : FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.standardInput = input == nil ? FileHandle.nullDevice : stdin
    do {
      try process.run()
      if let input {
        try stdin.fileHandleForWriting.write(contentsOf: input)
        try stdin.fileHandleForWriting.close()
      }
      let data = capture ? output.fileHandleForReading.readDataToEndOfFile() : Data()
      process.waitUntilExit()
      return (process.terminationStatus, data)
    } catch { return (1, Data()) }
  }

  private func loadBootstrapStatus() async {
    guard installedServiceControlsAvailable(), bootstrapState == "checking" || bootstrapState == "failed",
          let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return }
    let result = await Task.detached { Self.runLauncher(launcher, arguments: ["bootstrap-status"], capture: true) }.value
    if result.0 == 0, let status = try? JSONDecoder().decode(TelaBootstrapStatus.self, from: result.1),
       ["missing", "configured"].contains(status.configuration) {
      bootstrapState = status.configuration
      connectorURL = status.publicUrl
    } else { bootstrapState = "failed" }
    renderCurrentPage()
  }

  private func renderFirstUse() {
    guard let stack = detailStack else { return }
    pageHeader("", title: "Set up ChatGPT Tela")
    if bootstrapState == "checking" {
      append(secondary("Checking your installation…"), to: stack)
      return
    }
    if bootstrapState == "failed" {
      let help = card("Setup needs attention")
      append(secondary("Couldn't verify the installation or existing settings. Your settings were preserved. Repair or update Tela before continuing."), to: help)
      help.addArrangedSubview(actionButton("Check again", action: #selector(refreshPage)))
      return
    }
    append(secondary("This preview needs a reachable HTTPS address before you sign in and connect ChatGPT."), to: stack)
    let connection = card("1. Connection address")
    let endpoint = NSTextField(string: endpointDraft)
    endpoint.placeholderString = "https://your-server.example/mcp"
    append(endpoint, to: connection)
    endpointField = endpoint
    let picker = NSPopUpButton()
    for (value, title) in [("existing-https", "I already have an HTTPS route"), ("tailscale-funnel", "Use my Tailscale Funnel") ] {
      picker.addItem(withTitle: title)
      picker.lastItem?.representedObject = value
    }
    picker.selectItem(at: exposureDraft == "tailscale-funnel" ? 1 : 0)
    append(picker, to: connection)
    exposurePicker = picker
    append(secondary("Your HTTPS route must forward to Tela's local port. For Tailscale, install it and sign in first; use your device's HTTPS address with /mcp."), to: connection)
    let port = NSTextField(string: portDraft)
    port.widthAnchor.constraint(equalToConstant: 90).isActive = true
    row("Local port", control: port, in: connection)
    portField = port
    let consent = NSButton(checkboxWithTitle: "Allow this development-only public connection", target: nil, action: nil)
    consent.state = consentDraft ? .on : .off
    append(consent, to: connection)
    exposureConsent = consent
    append(secondary("This preview has no authentication on the public endpoint. Anyone with its address can reach the exposed tools. Use only a controlled development environment. Consumer-safe sign-in is not available yet."), to: connection)
    let save = actionButton("Save and continue", action: #selector(saveFirstUseConfiguration))
    save.isEnabled = !operationInProgress
    connection.addArrangedSubview(save)
    if savingConfiguration { append(secondary("Saving Tela settings…"), to: connection) }
    if let setupMessage { append(secondary(setupMessage), to: connection) }
  }

  @objc private func saveFirstUseConfiguration() {
    guard !operationInProgress, bootstrapState == "missing",
          exposureConsent?.state == .on, let endpoint = endpointField?.stringValue,
          let port = Int(portField?.stringValue ?? ""),
          let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else {
      setupMessage = "Enter a connection address and local port, and confirm the development connection limit."
      renderCurrentPage(); return
    }
    let exposure = exposurePicker?.selectedItem?.representedObject as? String ?? "existing-https"
    var settings: [String: Any] = ["kind": exposure, "publicUrl": endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
                                  "localPort": port, "authentication": "none", "allowUnauthenticatedPublicEndpoint": true]
    if exposure == "tailscale-funnel" { settings["tailscaleCli"] = "tailscale" }
    guard let input = try? JSONSerialization.data(withJSONObject: ["version": 1, "publicMcpAbi": "stable", "exposure": settings]) else { return }
    savingConfiguration = true
    setupMessage = nil
    renderCurrentPage()
    Task {
      let result = await Task.detached { Self.runLauncher(launcher, arguments: ["configure", "--stdin", "--if-missing"], input: input) }.value
      savingConfiguration = false
      bootstrapState = "checking"
      await loadBootstrapStatus()
      if result.0 == 0 {
        selectedPage = .work
        updateNavigation()
        setupMessage = "Settings saved. Start Tela, then open the login window."
      } else { setupMessage = "Couldn't save settings. Check the HTTPS address and port. Existing settings are never replaced by first-use setup." }
      renderCurrentPage()
      await refreshCurrentPage()
    }
  }

  @objc private func copyConnectionAddress() {
    guard let connectorURL else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(connectorURL, forType: .string)
  }

  @objc private func openLoginSetup(_ sender: NSButton) {
    openWebAccount(slot: sender.tag)
  }

  @objc private func finishWebAccountButton(_ sender: NSButton) {
    finishWebAccount(slot: sender.tag)
  }

  func finishWebAccount(slot: Int) {
    guard !operationInProgress, workInventory.error == nil,
          let profile = profiles.first(where: { $0.slot == slot && $0.connected && $0.accountManagementActive == true }) else { return }
    connectionProfileSlot = slot
    profileFailure = nil
    changingProfile = true
    profileProgress = "Finishing account management…"
    renderCurrentPage()
    Task {
      do {
        guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "TelaWork", code: 11) }
        _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/account-browser-close", method: "POST")
      } catch {
        profileFailure = "Couldn’t finish account management. Check Web status and try again."
        if let targetId = profile.targetId {
          profileConnectionFailure = TelaProfileConnectionFailure(slot: slot, targetId: targetId, goal: .connected)
        }
      }
      profileProgress = nil
      changingProfile = false
      await refreshCurrentPage()
    }
  }

  func openWebAccount(slot: Int) {
    guard !operationInProgress else { return }
    if let profile = profiles.first(where: { $0.slot == slot }) {
      if profile.controlState == "orphaned" {
        connectionProfileSlot = slot
        profileFailure = "Reconnect this Work profile before changing its Web account."
        renderCurrentPage()
        return
      }
      if profile.controlState == "running" {
        connectionProfileSlot = slot
        profileFailure = nil
        changingProfile = true
        profileProgress = "Opening Web account…"
        renderCurrentPage()
        Task {
          do {
            guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "TelaWork", code: 11) }
            _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/account-browser", method: "POST")
          } catch {
            profileFailure = "Couldn’t open the account window. Try again."
          }
          profileProgress = nil
          changingProfile = false
          await refreshCurrentPage()
        }
        return
      }
    }
    guard let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return }
    settingUp = true
    setupMessage = nil
    renderCurrentPage()
    Task {
      let result = await Task.detached { Self.runLauncher(launcher, arguments: ["setup", "--slot", String(slot)]) }.value
      settingUp = false
      setupMessage = result.0 == 0 ? "Login verified. Turn on this profile's connection to use Web models."
        : "Setup wasn't completed. Disconnect an active Work profile before opening login, then try again."
      renderCurrentPage()
      await refreshCurrentPage()
    }
  }

  // The installed login item owns startup; service registrations remain on demand.
  // Await the existing lifecycle before reading profiles or deciding launch notices.
  func startServicesAtLaunch() async {
    guard installedServiceControlsAvailable(),
          let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] else { return }
    _ = await Task.detached { Self.runLauncher(launcher, arguments: ["services", "start"]) }.value
  }

  @objc private func startServices() { changeBackgroundServices(start: true) }
  func startTelaFromMenu() {
    show()
    Task {
      await refreshCurrentPage()
      guard bootstrapState == "configured" else { return }
      changeBackgroundServices(start: true)
    }
  }
  @objc private func stopServices() { changeBackgroundServices(start: false) }

  private func changeBackgroundServices(start: Bool) {
    guard !operationInProgress, installedServiceControlsAvailable() else { return }
    if !start {
      let alert = NSAlert()
      alert.alertStyle = .warning
      alert.messageText = "Stop Tela background services?"
      alert.informativeText = "This stops Chat and Work connections. ChatGPT profiles connected through Tela may close, and their running work may be interrupted."
      alert.addButton(withTitle: "Stop services")
      alert.addButton(withTitle: "Cancel")
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    changingServices = true
    serviceAction = start ? "Starting Tela…" : "Stopping Tela…"
    renderCurrentPage()
    let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"]
    Task {
      let success = await Task.detached {
        guard let launcher else { return false }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launcher)
        process.arguments = ["services", start ? "start" : "stop"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus == 0 }
        catch { return false }
      }.value
      changingServices = false
      serviceAction = nil
      if !success {
        let alert = NSAlert()
        alert.messageText = "Some background services couldn't be changed"
        alert.informativeText = "Refresh connection details to check their current state."
        alert.addButton(withTitle: "OK")
        alert.runModal()
      }
      await refreshCurrentPage()
      renderCurrentPage()
      onPreferencesChanged?()
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
    updateSurfaceWatches()
    if page != .work { clearAccountDisplay() }
    updateNavigation()
    renderCurrentPage()
    detailScroll?.contentView.scroll(to: .zero)
    Task { await refreshCurrentPage() }
  }

  @objc private func refreshPage() {
    for task in surfaceWatches.values { task.cancel() }
    surfaceWatches.removeAll(); surfaceWatchIDs.removeAll()
    Task { await refreshCurrentPage() }
  }
  @objc private func refreshBridgePreview() { Task { await loadBridgePreview() } }

  @objc private func selectBridgeSurface(_ sender: NSButton) {
    selectedPreviewSlot = sender.tag
    selectedBridgeSurface = sender.identifier?.rawValue
    bridgeImage = nil
    Task { await refreshBridgeTitles(slot: sender.tag) }
    Task { await loadBridgePreview() }
  }

  private func displayBridgeTitle(_ title: String?) -> String? {
    guard let title else { return nil }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let prefix = "[Tela Agent] "
    let display = trimmed.hasPrefix(prefix) ? String(trimmed.dropFirst(prefix.count)) : trimmed
    return display.isEmpty ? nil : display
  }

  private func refreshBridgeTitles(slot: Int) async {
    let identity = BridgeTitleReadIdentity(owner: surfaceOwners[slot], watchID: surfaceWatchIDs[slot],
      inventory: bridgeSurfaces[slot], selectedSlot: selectedPreviewSlot, selectedSurface: selectedBridgeSurface)
    do {
      guard let descriptor = try readDescriptor("codex") else { return }
      let data = try await request(descriptor, path: "v1/codex/profiles/\(slot)/bridge-surfaces")
      let value = try JSONDecoder().decode(ControlCenterBridgeInventory.self, from: data)
      guard value.contractVersion == 1, value.slot == slot,
            identity == BridgeTitleReadIdentity(owner: surfaceOwners[slot], watchID: surfaceWatchIDs[slot],
              inventory: bridgeSurfaces[slot], selectedSlot: selectedPreviewSlot, selectedSurface: selectedBridgeSurface),
            profiles.contains(where: { $0.slot == slot && $0.controlState == "running" }) else { return }
      bridgeSurfaces[slot] = value.surfaces
      renderCurrentPage()
    } catch {
      if identity == BridgeTitleReadIdentity(owner: surfaceOwners[slot], watchID: surfaceWatchIDs[slot],
         inventory: bridgeSurfaces[slot], selectedSlot: selectedPreviewSlot, selectedSurface: selectedBridgeSurface),
         let current = bridgeSurfaces[slot] {
        bridgeSurfaces[slot] = current.map { ControlCenterBridgeSurface(id: $0.id, label: $0.label, title: nil) }
        renderCurrentPage()
      }
    }
  }

  @objc private func revealBridgeSurface() { revealSelectedBridge(interactive: false) }
  @objc private func interactBridgeSurface() { revealSelectedBridge(interactive: true) }
  private func revealSelectedBridge(interactive: Bool) {
    guard let id = selectedBridgeSurface, let slot = selectedPreviewSlot else { return }
    Task {
      let message: String
      do {
        guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "TelaWork", code: 5) }
        _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/bridge-reveal", method: "POST", body: ["surfaceId": id, "interactive": interactive])
        message = interactive ? "Browser interaction enabled. Close its window to return to viewing." : "Browser opened for viewing. Choose Interact for approvals or login."
      } catch {
        message = "Couldn't open this Web session. Refresh to check its availability."
      }
      guard selectedBridgeSurface == id, selectedPreviewSlot == slot else { return }
      bridgeMessage = message
      renderCurrentPage()
    }
  }

  @objc private func setDelegationLimit(_ sender: NSPopUpButton) {
    guard let limit = sender.selectedItem?.representedObject as? Int, (1...5).contains(limit) else { return }
    do {
      var preferences = try TelaPreferencesStore.read(at: preferencesURL)
      var limits = preferences.webDelegationLimits ?? [:]
      limits[String(sender.tag)] = limit
      preferences.webDelegationLimits = limits
      try TelaPreferencesStore.write(preferences, at: preferencesURL)
      delegationLimits = limits
      onPreferencesChanged?()
    } catch {
      sender.selectItem(at: (delegationLimits[String(sender.tag)] ?? 3) - 1)
      NSSound.beep()
    }
  }

  @objc private func toggleApproval(_ sender: NSSwitch) {
    do {
      var preferences = try TelaPreferencesStore.read(at: preferencesURL)
      preferences.approvalAutomation = sender.state == .on ? "full_access" : "off"
      try TelaPreferencesStore.write(preferences, at: preferencesURL)
      approvalAutomation = preferences.approvalAutomation
      preferenceError = false
      onPreferencesChanged?()
      renderCurrentPage()
    } catch {
      sender.state = approvalAutomation == "off" ? .off : .on
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

  @objc private func toggleProfile(_ sender: NSSwitch) {
    sender.state = sender.state == .on ? .off : .on
    toggleConnection(slot: sender.tag)
  }

  func webConnectionPresentation(for profile: TelaWorkProfile) -> TelaWebConnectionPresentation {
    let wanted = (try? TelaPreferencesStore.read(at: preferencesURL))?.workProfileConnections ?? []
    return TelaWebConnectionPresentation(profile: profile, wantedTargets: wanted,
      failed: profileConnectionFailure?.slot == profile.slot && profileConnectionFailure?.goal == .connected)
  }

  private func setConnectionWanted(_ profile: TelaWorkProfile, enabled: Bool) throws {
    guard let target = profile.targetId else { throw NSError(domain: "TelaConnection", code: 1) }
    var preferences = try TelaPreferencesStore.read(at: preferencesURL)
    var wanted = Set(preferences.workProfileConnections ?? [])
    if enabled { wanted.insert(target) } else { wanted.remove(target) }
    preferences.workProfileConnections = wanted.sorted()
    try TelaPreferencesStore.write(preferences, at: preferencesURL)
  }

  private func toggleConnection(slot: Int) {
    guard !operationInProgress, workInventory.error == nil,
          let profile = profiles.first(where: { $0.slot == slot }), profile.connectionInProgress != true else { return }
    // Cancelling saved intent for an unattached app must not close that app or reconnect it.
    if webConnectionPresentation(for: profile).enabled && !profile.connected {
      do {
        try setConnectionWanted(profile, enabled: false)
        profileConnectionFailure = nil
        profileFailure = nil
      } catch { profileFailure = "Couldn't save the Web models setting." }
      renderCurrentPage()
      onPreferencesChanged?()
    } else { changeConnection(slot: slot) }
  }

  @objc private func retryProfileConnection(_ sender: NSButton) { retryConnection(slot: sender.tag) }

  func retryConnection(slot: Int) {
    selectedPage = .work
    show()
    if profiles.first(where: { $0.slot == slot })?.connected == true { reconnectWeb(slot: slot) }
    else { changeConnection(slot: slot) }
  }

  @objc private func openProfileButton(_ sender: NSButton) { openProfile(slot: sender.tag) }

  // Keep the OS application instance found by authenticated inventory, rather than looking up
  // a possibly reused PID on every click. A terminated instance always takes fresh discovery.
  func rememberRunningProfileApps(_ verifiedProfiles: [TelaWorkProfile]) {
    var current: [Int: NSRunningApplication] = [:]
    for profile in verifiedProfiles where profile.connectionInProgress != true {
      guard let pid = profile.desktopProcessId, pid > 0, pid <= Int(Int32.max) else { continue }
      if let app = runningProfileApps[profile.slot], app.processIdentifier == pid_t(pid), !app.isTerminated {
        current[profile.slot] = app
      } else if let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated {
        current[profile.slot] = app
      }
    }
    runningProfileApps = current
  }

  func openProfile(slot: Int) {
    if profiles.first(where: { $0.slot == slot })?.connected == true,
       let app = runningProfileApps[slot], !app.isTerminated, app.activate(options: []) {
      return
    }
    guard !operationInProgress else { show(); return }
    connectionProfileSlot = slot
    profileFailure = nil
    changingProfile = true
    profileProgress = "Checking ChatGPT…"
    renderCurrentPage()
    Task {
      await refreshCurrentPage()
      if workInventory.error != nil, installedServiceControlsAvailable(),
         let launcher = ProcessInfo.processInfo.environment["CHATGPT_TELA_PACKAGED_LAUNCHER_EXECUTABLE"] {
        profileProgress = "Starting Tela…"
        let result = await Task.detached {
          Self.runLauncher(launcher, arguments: ["services", "start"])
        }.value
        if result.0 != 0 {
          profileProgress = nil
          changingProfile = false
          profileFailure = "Couldn't start Tela. Check the connection details in Settings."
          selectedPage = .work; show(); return
        }
        await refreshCurrentPage()
      }
      profileProgress = nil
      changingProfile = false
      renderCurrentPage()
      guard workInventory.error == nil, let profile = profiles.first(where: { $0.slot == slot }),
            profile.connectionInProgress != true else {
        profileFailure = "Couldn't check ChatGPT. Please try again in a moment."
        selectedPage = .work; show(); return
      }
      if let pid = profile.desktopProcessId, pid > 0, pid <= Int(Int32.max),
         let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated {
        if !profile.connected {
          changeConnection(slot: slot)
          return
        }
        if !app.activate(options: []) {
          profileFailure = "Couldn't bring ChatGPT to the front. Please try again."
          selectedPage = .work; show()
        }
      } else if profile.targetState != "running", profile.controlState == "stopped" {
        selectedPage = .work; show()
        changeConnection(slot: slot, requireStopped: true)
      } else {
        profileFailure = "ChatGPT is still opening or closing. Please try again in a moment."
        selectedPage = .work; show()
      }
    }
  }

  func reopenForWeb(slot: Int, expectedDesktopPid: Int) {
    guard !operationInProgress else { show(); return }
    selectedPage = .work; show()
    connectionProfileSlot = slot
    profileFailure = nil
    changingProfile = true
    profileProgress = "Checking ChatGPT…"
    renderCurrentPage()
    Task {
      await refreshCurrentPage()
      profileProgress = nil
      changingProfile = false
      renderCurrentPage()
      guard workInventory.error == nil, let profile = profiles.first(where: { $0.slot == slot }),
            profile.desktopProcessId == expectedDesktopPid, profile.connectionInProgress == false else {
        profileFailure = "ChatGPT has changed since the reminder appeared. Check its connection before trying again."
        renderCurrentPage(); return
      }
      if profile.connected { return }
      changeConnection(slot: slot, confirmedDesktopPid: expectedDesktopPid)
    }
  }

  func connectFromMenu(slot: Int) {
    guard !operationInProgress else { show(); return }
    selectedPage = .work
    show()
    connectionProfileSlot = slot
    profileFailure = nil
    changingProfile = true
    profileFailure = nil
    profileProgress = "Checking ChatGPT…"
    renderCurrentPage()
    Task {
      await refreshCurrentPage()
      changingProfile = false
      profileProgress = nil
      if let error = workInventory.error { profileFailure = error }
      renderCurrentPage()
      toggleConnection(slot: slot)
    }
  }

  func changeConnection(slot: Int, confirmedDesktopPid: Int? = nil, requireStopped: Bool = false) {
    guard !operationInProgress, workInventory.error == nil,
          let profile = profiles.first(where: { $0.slot == slot }) else { return }
    let action = profile.action
    guard profile.connectionInProgress != true else { return }
    if requireStopped && action != "start" { return }
    if confirmedDesktopPid != nil && (profile.desktopProcessId != confirmedDesktopPid || action != "restart") { return }
    if action != "start" && confirmedDesktopPid == nil {
      let alert = NSAlert()
      alert.alertStyle = .warning
      alert.messageText = action == "restart" ? "Reopen \(profile.targetDisplayName) with Tela?" : "Turn off Web models in \(profile.targetDisplayName)?"
      alert.informativeText = action == "restart"
        ? "ChatGPT will close and reopen with Web models ready. Finish any ongoing work first. Your conversations will be kept."
        : "This closes this ChatGPT app and interrupts any ongoing work. Your conversations will be kept. You can still open ChatGPT normally to use Native models."
      alert.addButton(withTitle: action == "restart" ? "Reopen with Tela" : "Turn Off and Close")
      alert.addButton(withTitle: "Cancel")
      let decision = action == "restart" ? "web_reopen" : "web_disconnect"
      let decisionId = UUID().uuidString
      onDecisionStateChanged?("decision_\(decision)_pending", slot, decisionId)
      let answer = alert.runModal()
      onDecisionStateChanged?(answer == .alertFirstButtonReturn
        ? "decision_\(decision)_accepted" : "decision_\(decision)_deferred", slot, decisionId)
      guard answer == .alertFirstButtonReturn else { return }
    }
    if action != "stop" {
      do { try setConnectionWanted(profile, enabled: true) }
      catch { profileFailure = "Couldn't save the Web models setting."; renderCurrentPage(); return }
    }
    connectionProfileSlot = slot
    changingProfile = true
    profileFailure = nil
    profileProgress = action == "stop" ? "Disconnecting this profile…" : "Starting the connection…"
    renderCurrentPage()
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
        if action == "stop" {
          _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/stop", method: "POST")
        } else {
          try await connectProfile(descriptor, slot: slot,
            expectedDesktopPid: action == "restart" ? profile.desktopProcessId : confirmedDesktopPid,
            requireStopped: requireStopped)
        }
      } catch {
        profileFailure = (error as? TelaConnectionFailure)?.message
          ?? "Couldn't connect ChatGPT. Check its status in Work before trying again."
        if let targetId = profile.targetId {
          profileConnectionFailure = TelaProfileConnectionFailure(slot: slot, targetId: targetId,
            goal: action == "stop" ? .stopped : .connected)
        }
      }
      profileProgress = nil
      changingProfile = false
      renderCurrentPage()
      await refreshCurrentPage()
      onPreferencesChanged?()
    }
  }

  @objc private func reconnectWebButton(_ sender: NSButton) { reconnectWeb(slot: sender.tag) }

  func reconnectWeb(slot: Int) {
    guard !operationInProgress, workInventory.error == nil,
          let profile = profiles.first(where: { $0.slot == slot }), profile.canReconnectWeb else { return }
    connectionProfileSlot = slot
    changingProfile = true
    profileFailure = nil
    profileProgress = "Connecting Web…"
    renderCurrentPage()
    Task {
      do {
        guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "TelaConnection", code: 7) }
        let data = try await request(descriptor, path: "v1/codex/profiles/\(slot)/web-reconnect", method: "POST")
        let updated = try JSONDecoder().decode(TelaWorkProfile.self, from: data)
        workInventory.loaded(profiles.filter { $0.slot != slot } + [updated])
      } catch {
        profileFailure = "Couldn’t connect. Try again later."
      }
      profileProgress = nil
      changingProfile = false
      renderCurrentPage()
      await refreshCurrentPage()
      onPreferencesChanged?()
    }
  }

  private func connectProfile(_ descriptor: ControlCenterServiceDescriptor, slot: Int, expectedDesktopPid: Int? = nil, requireStopped: Bool = false) async throws {
    guard let base = URL(string: descriptor.endpoint),
          let url = URL(string: "v1/codex/profiles/\(slot)/start", relativeTo: base) else {
      throw NSError(domain: "TelaConnection", code: 1)
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(descriptor.bearerToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
    if expectedDesktopPid != nil || requireStopped {
      var options: [String: Any] = [:]
      if let expectedDesktopPid { options["expectedDesktopProcessId"] = expectedDesktopPid }
      if requireStopped { options["requireStopped"] = true }
      request.httpBody = try JSONSerialization.data(withJSONObject: options)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    request.timeoutInterval = TelaRequestBudget.seconds(path: "v1/codex/profiles/\(slot)/start", method: "POST")
    let (bytes, response) = try await URLSession.shared.bytes(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
          http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("application/x-ndjson") == true else {
      throw TelaConnectionFailure(phase: "checking", message: "Couldn't start the Web connection. Check Tela's status in Settings.")
    }
    var completed = false
    for try await line in bytes.lines {
      guard line.utf8.count <= 64 * 1024 else { throw NSError(domain: "TelaConnection", code: 2) }
      let frame = try JSONDecoder().decode(TelaConnectionFrame.self, from: Data(line.utf8))
      if let failure = frame.error { throw failure }
      if let phase = frame.phase {
        profileProgress = telaConnectionProgress(phase)
        renderCurrentPage()
      }
      if let profile = frame.profile {
        completed = profile.connected
        workInventory.loaded(profiles.filter { $0.slot != profile.slot } + [profile])
        rememberRunningProfileApps(profiles)
        profileProgress = profile.connectionLabel
        renderCurrentPage()
      }
    }
    guard completed else {
      throw TelaConnectionFailure(phase: "connecting", message: "Couldn't confirm the connection. Check its status before trying again.")
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

  private func request(_ descriptor: ControlCenterServiceDescriptor, path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
    guard let base = URL(string: descriptor.endpoint), let url = URL(string: path, relativeTo: base) else {
      throw NSError(domain: "ChatGPTTelaControlCenter", code: 3)
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    request.setValue("Bearer \(descriptor.bearerToken)", forHTTPHeaderField: "Authorization")
    // Metadata waits for a surface lifecycle event; Task cancellation owns its lifetime.
    request.timeoutInterval = path.contains("/bridge-surfaces?since=") ? TimeInterval(Int32.max)
      : TelaRequestBudget.seconds(path: path, method: method)
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw NSError(domain: "ChatGPTTelaControlCenter", code: 4)
    }
    return data
  }

  private func refreshCurrentPage() async {
    if refreshing {
      await withCheckedContinuation { refreshWaiters.append($0) }
      return
    }
    refreshing = true
    renderCurrentPage()
    defer {
      refreshing = false
      renderCurrentPage()
      let waiters = refreshWaiters
      refreshWaiters.removeAll()
      for waiter in waiters { waiter.resume() }
    }
    await loadBootstrapStatus()
    let previousChatFolders = chatFolders
    let previousChatFoldersApplied = chatFoldersApplied
    let previousChatFoldersAvailable = chatFoldersAvailable
    await loadChatFolders()
    let previousProfileError = workInventory.error
    let previousServices = serviceStates
    let previousIngress = ingressStatus
    let previousProfiles = profiles
    let previousApproval = approvalAutomation
    let previousDelay = approvalDelay
    let previousPreferenceError = preferenceError
    async let gateway = serviceState("gateway")
    async let chat = serviceState("chat")
    async let codex = serviceState("codex")
    async let ingress = loadIngressStatus()
    serviceStates = ["gateway": await gateway, "chat": await chat, "codex": await codex]
    ingressStatus = await ingress
    await loadProfiles()
    updateSurfaceWatches()
    // Refresh Native-only renames on the existing user-initiated/status lifecycle.
    // Surface revision tracks Web leases and cannot signal a Native thread rename.
    if selectedPage == .work {
      for profile in profiles where profile.controlState == "running" {
        await refreshBridgeTitles(slot: profile.slot)
      }
    }
    delegationCapacity = [:]
    if selectedPage == .work, let descriptor = try? readDescriptor("codex") {
      for profile in profiles {
        if let data = try? await request(descriptor, path: "v1/codex/profiles/\(profile.slot)/web-delegation-capacity"),
           let value = try? JSONDecoder().decode(ControlCenterDelegationCapacity.self, from: data),
           value.valid(for: profile.slot) { delegationCapacity[profile.slot] = value }
      }
    }
    refreshProfileAccounts()
    if let preferences = try? TelaPreferencesStore.read(at: preferencesURL) {
      approvalAutomation = preferences.approvalAutomation
      approvalDelay = preferences.approvalDelay ?? "instant"
      delegationLimits = preferences.webDelegationLimits ?? [:]
      preferenceError = false
    } else {
      preferenceError = true
    }
    if previousChatFolders != chatFolders || previousChatFoldersApplied != chatFoldersApplied || previousChatFoldersAvailable != chatFoldersAvailable || previousServices != serviceStates || previousIngress != ingressStatus
      || previousProfiles != profiles || previousProfileError != workInventory.error || previousApproval != approvalAutomation
      || previousDelay != approvalDelay || previousPreferenceError != preferenceError {
      renderCurrentPage()
    }
  }

  private func serviceState(_ service: String) async -> String {
    do {
      guard let descriptor = try readDescriptor(service) else { return "Stopped" }
      let status = try JSONDecoder().decode(ControlCenterServiceStatus.self, from: await request(descriptor, path: "v1/status"))
      return status.service == service ? status.state.capitalized : "Unavailable"
    } catch { return "Unavailable" }
  }

  private func loadProfiles() async {
    let ticket = workState.beginRead()
    do {
      guard let descriptor = try readDescriptor("codex") else {
        throw NSError(domain: "TelaWork", code: 1)
      }
      let envelope = try JSONDecoder().decode(ControlCenterProfilesEnvelope.self, from: await request(descriptor, path: "v1/codex/profiles"))
      workState.finishRead(ticket, profiles: envelope.profiles)
      rememberRunningProfileApps(profiles)
    } catch { workState.finishRead(ticket, profiles: nil, error: error) }
  }

  private func clearAccountDisplay() {
    accountRevision += 1
    profileAccounts.removeAll()
    accountRefreshPending = false
    accountTask?.cancel()
  }

  // Coalesced work-page requests only; no timer, disk cache, or stopped-profile launch.
  private func refreshProfileAccounts() {
    guard selectedPage == .work, window?.isVisible == true else { return }
    if accountTask != nil { accountRefreshPending = true; return }
    accountRefreshPending = false
    let revision = accountRevision
    let current = profiles.filter { $0.connected && $0.connectionInProgress != true }
    accountTask = Task {
      defer {
        accountTask = nil
        if accountRefreshPending { refreshProfileAccounts() }
      }
      let descriptor = try? readDescriptor("codex")
      var result: [Int: TelaAccountDisplay] = [:]
      for profile in current {
        guard !Task.isCancelled else { return }
        do {
          guard let descriptor else { throw NSError(domain: "TelaAccountDisplay", code: 1) }
          let data = try await request(descriptor, path: "v1/codex/profiles/\(profile.slot)/account-display")
          let value = try JSONDecoder().decode(TelaAccountDisplay.self, from: data)
          guard value.valid(for: profile.slot) else { continue }
          result[profile.slot] = value
        } catch {
          result[profile.slot] = TelaAccountDisplay(contractVersion: 1, slot: profile.slot,
            native: .init(state: "unavailable", email: nil), web: .init(state: "unavailable", email: nil), comparison: "unavailable")
        }
      }
      guard !Task.isCancelled, revision == accountRevision, selectedPage == .work, window?.isVisible == true else { return }
      profileAccounts = result
      renderCurrentPage()
    }
  }

  private func loadIngressStatus() async -> ControlCenterIngressStatus? {
    do {
      guard let descriptor = try readDescriptor("gateway") else { return nil }
      let value = try JSONDecoder().decode(ControlCenterIngressStatus.self, from: await request(descriptor, path: window?.isVisible == true ? "v1/ingress?public=1" : "v1/ingress"))
      guard value.contractVersion == 1,
            ["ready", "unavailable", "unconfigured"].contains(value.availability),
            !value.cause.isEmpty,
            !value.detail.isEmpty else { return nil }
      return value
    } catch { return nil }
  }

  private func updateSurfaceWatches() {
    let visible = selectedPage == .work && window?.isVisible == true
      && window?.occlusionState.contains(.visible) == true
    let descriptor = try? readDescriptor("codex")
    let endpoint = descriptor.map { $0.endpoint + $0.bearerToken }
    if endpoint != surfaceEndpoint {
      for task in surfaceWatches.values { task.cancel() }
      surfaceWatches.removeAll(); surfaceWatchIDs.removeAll()
      surfaceEndpoint = endpoint
    }
    let slots = visible ? Set(profiles.filter { $0.controlState == "running" }.map { $0.slot }) : []
    let owners = Dictionary(uniqueKeysWithValues: profiles.map {
      ($0.slot, "\($0.targetId ?? ""):\($0.childProcessId ?? $0.desktopProcessId ?? 0)")
    })
    for slot in Array(surfaceWatches.keys) where !slots.contains(slot) || surfaceOwners[slot] != owners[slot] {
      surfaceWatches.removeValue(forKey: slot)?.cancel()
      surfaceWatchIDs.removeValue(forKey: slot)
      if surfaceOwners[slot] != owners[slot] {
        bridgeSurfaces.removeValue(forKey: slot)
        if selectedPreviewSlot == slot { clearBridgeSelection() }
      }
    }
    surfaceOwners = owners
    for slot in Array(bridgeSurfaces.keys) where !profiles.contains(where: { $0.slot == slot && $0.controlState == "running" }) {
      bridgeSurfaces.removeValue(forKey: slot)
      if selectedPreviewSlot == slot { clearBridgeSelection() }
    }
    guard let descriptor else { return }
    for slot in slots where surfaceWatches[slot] == nil {
      let watchID = UUID()
      surfaceWatchIDs[slot] = watchID
      surfaceMessages[slot] = bridgeSurfaces[slot] == nil ? "Loading…" : nil
      surfaceWatches[slot] = Task { [weak self] in
        guard let self else { return }
        defer {
          if self.surfaceWatchIDs[slot] == watchID {
            self.surfaceWatches.removeValue(forKey: slot)
            self.surfaceWatchIDs.removeValue(forKey: slot)
          }
        }
        var revision: Int?
        do {
          while !Task.isCancelled {
            let suffix = revision.map { "?since=\($0)" } ?? ""
            let data = try await self.request(descriptor, path: "v1/codex/profiles/\(slot)/bridge-surfaces" + suffix)
            try Task.checkCancellation()
            let value = try JSONDecoder().decode(ControlCenterBridgeInventory.self, from: data)
            guard value.contractVersion == 1, value.slot == slot,
                  self.surfaceWatchIDs[slot] == watchID else { return }
            revision = value.revision
            let wasUnavailable = self.surfaceMessages.removeValue(forKey: slot) != nil
            if self.bridgeSurfaces[slot] != value.surfaces {
              self.bridgeSurfaces[slot] = value.surfaces
              if self.selectedPreviewSlot == slot,
                 !value.surfaces.contains(where: { $0.id == self.selectedBridgeSurface }) {
                self.clearBridgeSelection()
              }
              self.renderCurrentPage()
            } else if wasUnavailable { self.renderCurrentPage() }
          }
        } catch {
          if !Task.isCancelled, self.surfaceWatchIDs[slot] == watchID {
            self.surfaceMessages[slot] = "Sessions unavailable"
            self.renderCurrentPage()
          }
          // Preserve the list on transport failure. Explicit refresh or a new visibility
          // lifecycle restarts observation; never spin or infer that sessions ended.
        }
      }
    }
  }

  private func clearBridgeSelection() {
    previewRevision += 1
    selectedBridgeSurface = nil
    selectedPreviewSlot = nil
    bridgeImage = nil
    bridgeMessage = "Choose a Web session"
  }

  private func loadBridgePreview() async {
    previewLoads += 1
    renderCurrentPage()
    defer { previewLoads -= 1; renderCurrentPage() }
    previewRevision += 1
    let revision = previewRevision
    bridgeImage = nil
    guard let slot = selectedPreviewSlot, let selection = selectedBridgeSurface,
          profiles.contains(where: { $0.controlState == "running" && $0.slot == slot }) else {
      bridgeMessage = "Choose a Web session"
      return
    }
    do {
      guard let descriptor = try readDescriptor("codex") else { throw NSError(domain: "ChatGPTTelaControlCenter", code: 5) }
      let suffix = "?surfaceId=" + selection
      let data = try await request(descriptor, path: "v1/codex/profiles/\(slot)/bridge-preview" + suffix)
      guard revision == previewRevision, selectedPreviewSlot == slot, selectedBridgeSurface == selection else { return }
      let preview = try JSONDecoder().decode(ControlCenterBridgePreview.self, from: data)
      guard preview.contractVersion == 1, preview.slot == slot else { throw NSError(domain: "ChatGPTTelaControlCenter", code: 6) }
      if preview.previewAvailable,
         preview.imageMimeType == "image/jpeg",
         let encoded = preview.imageBase64,
         let imageData = Data(base64Encoded: encoded),
         let image = NSImage(data: imageData) {
        bridgeImage = image
        bridgeMessage = "Snapshot"
      } else if preview.activeSurfaceCount == 0 {
        bridgeMessage = "This Web session has ended."
      } else {
        bridgeMessage = "Choose a Web session to view its snapshot or open its browser."
      }
      if preview.selectedSurfaceId != nil, let wait = preview.approvalWait {
        bridgeMessage += "\n\(wait.statusText)"
      }
      if preview.selectedSurfaceId != nil && preview.approvalState == "pending" {
        bridgeMessage += "\nApproval is waiting in this browser session. Choose Interact to review the card."
      } else if preview.selectedSurfaceId != nil && preview.approvalState == "unavailable" {
        bridgeMessage += preview.approvalObservationReason == "automation_unavailable"
          ? "\nApproval cannot be checked because this session has no page-observation capability."
          : "\nApproval observation failed; do not assume the card was cleared."
      }
    } catch {
      guard revision == previewRevision, selectedPreviewSlot == slot, selectedBridgeSurface == selection else { return }
      bridgeMessage = "The Web session is no longer available. Refresh the session list."
    }
    renderCurrentPage()
  }
}
