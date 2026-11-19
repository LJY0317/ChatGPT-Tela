#if canImport(TelaLocalization)
import TelaLocalization
#endif
import Foundation

func telaDelegationThreadId(_ input: String) -> String? {
  let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
  if let id = UUID(uuidString: value) { return id.uuidString.lowercased() }
  guard let link = URLComponents(string: value),
        link.scheme == "codex", link.host == "threads",
        link.user == nil, link.password == nil, link.port == nil,
        link.query == nil, link.fragment == nil,
        let id = UUID(uuidString: String(link.percentEncodedPath.dropFirst())) else { return nil }
  return id.uuidString.lowercased()
}

struct TelaWebTaskResult: Decodable {
  enum Outcome: String, Decodable { case pending, answer, failed, interrupted }
  let threadId: String
  let turnId: String?
  let itemId: String?
  let text: String?
  let outcome: Outcome

  func answer(in requestedThread: String) -> (turn: String, item: String, text: String)? {
    guard threadId == requestedThread, outcome == .answer, let turnId, !turnId.isEmpty,
          let itemId, !itemId.isEmpty, let text, !text.isEmpty else { return nil }
    return (turnId, itemId, text)
  }
}

// On-demand official CLI metadata, scoped to this installation's local source.
struct TelaRetentionStatus: Decodable {
  struct Item: Decodable {
    let slot: Int
    let threadId: String
    let title: String?
    let dueAt: Double
    let reason: String
    var explanation: String {
      switch reason {
      case "running": return telaText("Still running. Check and stop the task in ChatGPT.")
      case "owner_unavailable": return telaText("ChatGPT still holds this chat, or its connection is unavailable.")
      case "descendants_present": return telaText("Archiving would also affect other chats. Review them first.")
      case "ownership_changed": return telaText("The chat or profile ownership changed. Check the original profile.")
      case "archive_unconfirmed": return telaText("The archive result is unknown. Check the existing result before trying again.")
      default: return telaText("Archiving is overdue. Check the chat and connection.")
      }
    }
  }
  let overdue: [Item]
}

struct TelaLocalPluginStatus: Decodable {
  struct Profile: Decodable { let slot: Int; let state: String }
  let source: String
  let profiles: [Profile]
}

struct TelaLocalPluginPresentation {
  let label: String
  let guidance: String?
  let openApp: Bool
  init(state: String) {
    switch state {
    case "prepare": (label, guidance, openApp) = ("Plugin: Not prepared", nil, false)
    case "install": (label, guidance, openApp) = ("Plugin: Not installed", "Install Tela Local Chat in ChatGPT’s Plugins Directory.", true)
    case "update": (label, guidance, openApp) = ("Plugin: Update needed", "Update Tela Local Chat in ChatGPT’s Plugins Directory.", true)
    case "disabled": (label, guidance, openApp) = ("Plugin: Off", "Manage the plugin in ChatGPT.", true)
    case "ready": (label, guidance, openApp) = ("Plugin: Enabled", "Applies to new chats.", false)
    case "customized": (label, guidance, openApp) = ("Plugin: Custom source kept", "Manage the plugin in ChatGPT.", true)
    default: (label, guidance, openApp) = ("Plugin: Couldn't check", "Check the plugin in ChatGPT.", true)
    }
  }
}

// Display-only, memory-only data from the authenticated local UI endpoint.
struct TelaAccountDisplay: Decodable, Equatable {
  struct Account: Decodable, Equatable {
    let state: String
    let email: String?
    var valid: Bool {
      guard ["signed-in", "signed-out", "unavailable"].contains(state) else { return false }
      guard let email else { return true }
      return state == "signed-in" && email.utf8.count <= 254 && email.range(of: "^[^\\s@\\x00-\\x1f\\x7f]+@[^\\s@\\x00-\\x1f\\x7f]+$", options: .regularExpression) != nil
    }
  }
  let contractVersion: Int
  let slot: Int
  let native: Account
  let web: Account
  let comparison: String
  func valid(for expectedSlot: Int) -> Bool {
    guard contractVersion == 1, slot == expectedSlot, native.valid, web.valid else { return false }
    guard let lhs = native.email, let rhs = web.email else { return comparison == "unavailable" }
    func normalize(_ email: String) -> String {
      guard let at = email.lastIndex(of: "@") else { return email }
      return String(email[...at]) + email[email.index(after: at)...].lowercased()
    }
    return comparison == (normalize(lhs) == normalize(rhs) ? "matching" : "different")
  }
}

struct TelaWorkProfile: Decodable, Equatable {
  let slot: Int
  let targetDisplayName: String
  let targetState: String
  let targetSessionState: String
  let controlState: String
  var targetId: String? = nil
  var desktopProcessId: Int? = nil
  var childProcessId: Int? = nil
  var connectionInProgress: Bool? = nil
  var webModelsReady: Bool? = nil
  var webState: String? = nil
  var webSignIn: String? = nil
  var accountManagementActive: Bool? = nil
  var needsWebSignIn: Bool { connected && webState == "login-required" }
  var canReconnectWeb: Bool { connected && (webState == "failed" || webState == "ready") }
  var connected: Bool {
    controlState == "running" && (targetSessionState == "ready" || targetSessionState == "independent")
  }
  var action: String {
    if connected { return "stop" }
    // An app-owned route can be started while the official Desktop remains open.
    if controlState == "stopped" && targetSessionState == "available" { return "start" }
    return targetState == "running" || controlState == "restart-required" ? "restart" : "start"
  }
  var connectionLabel: String {
    if connected && accountManagementActive == true { return telaText("Finish account management") }
    if connected && webState == "preparing" { return telaText("Connecting…") }
    if needsWebSignIn { return telaText("Web sign-in required") }
    if connected && webState == "failed" { return telaText("Connection failed") }
    if connected && webState == "ready" && webModelsReady != false { return telaText("Connected") }
    return connected && webModelsReady == false ? telaText("Models unavailable") : connected ? telaText("Connected")
      : (action == "restart" ? telaText("Reconnect required") : telaText("Off"))
  }
}

// Saved intent controls the switch; observed readiness controls the short status.
struct TelaWebConnectionPresentation {
  let enabled: Bool
  private let statusSource: String
  private let buttonTitleSource: String?
  var status: String { telaText(statusSource) }
  var buttonTitle: String? { buttonTitleSource.map(telaText) }
  var menuStatus: String { ["Off", "Ready", "Paused"].contains(statusSource)
    ? String(format: telaText("Web models: %@"), status) : status }

  init(profile: TelaWorkProfile, wantedTargets: [String], failed: Bool = false) {
    enabled = profile.connected || profile.targetId.map { wantedTargets.contains($0) } == true
    if profile.connectionInProgress == true || (profile.webState == "preparing" && profile.accountManagementActive != true) {
      statusSource = "Connecting…"; buttonTitleSource = nil
    } else if profile.accountManagementActive == true {
      statusSource = "Paused"; buttonTitleSource = nil
    } else if profile.needsWebSignIn {
      statusSource = "Sign-in required"; buttonTitleSource = nil
    } else if failed || profile.webState == "failed" || (profile.connected && (profile.webState != "ready" || profile.webModelsReady == false)) {
      statusSource = "Connection failed"; buttonTitleSource = "Try Again"
    } else if profile.connected {
      statusSource = "Ready"; buttonTitleSource = nil
    } else if enabled {
      statusSource = "Reconnect required"; buttonTitleSource = profile.action == "restart" ? "Reopen with Tela" : "Try Again"
    } else {
      statusSource = "Off"; buttonTitleSource = nil
    }
  }
}

struct TelaWebPresentation {
  enum Action { case none, account, reconnect, finish }
  private let statusSource: String
  let action: Action
  private let buttonTitleSource: String?
  var status: String { telaText(statusSource) }
  var buttonTitle: String? { buttonTitleSource.map(telaText) }

  var menuButtonTitle: String? { ["Connected", "Verified"].contains(statusSource) ? nil : buttonTitle }

  init(profile: TelaWorkProfile, account: TelaAccountDisplay? = nil) {
    let result: (String, Action, String?)
    if !profile.connected {
      result = ("Off", .none, nil)
    } else if profile.accountManagementActive == true {
      result = ("Finish in the browser", .finish, "Done")
    } else if profile.connectionInProgress == true || profile.webState == "preparing" {
      result = ("Checking…", .none, nil)
    } else if profile.needsWebSignIn || profile.webSignIn == "signed-out" || account?.web.state == "signed-out" {
      result = ("Sign-in required", .account, "Sign in…")
    } else if account?.comparison == "different" {
      result = ("Different account", .account, "Manage…")
    } else if profile.webSignIn == "signed-in" || account?.web.state == "signed-in" {
      result = ("Verified", profile.webState == "failed" ? .reconnect : .account,
        profile.webState == "failed" ? "Try again" : "Manage…")
    } else if profile.webState == "ready" && profile.webModelsReady != false {
      // Readiness is positive connection evidence; missing account metadata is not a login failure.
      result = ("Connected", .account, "Manage…")
    } else {
      result = ("Not verified", .account, "Verify…")
    }
    statusSource = result.0; action = result.1; buttonTitleSource = result.2
  }
}

// Launch notifications are only hints. The authenticated inventory must identify the exact
// live app, and saved intent never authorizes a restart. Retain only currently running launches.
struct TelaLaunchNoticePolicy {
  private var shown: Set<Int> = []
  mutating func ended(pid: Int) { shown.remove(pid) }
  mutating func prune(livePids: Set<Int>) { shown.formIntersection(livePids) }
  mutating func notice(pid: Int, profiles: [TelaWorkProfile], wantedTargets: [String], inventoryValid: Bool) -> TelaWorkProfile? {
    guard inventoryValid, pid > 0, pid <= Int(Int32.max), !shown.contains(pid) else { return nil }
    let matches = profiles.filter { $0.desktopProcessId == pid }
    guard matches.count == 1, let profile = matches.first, let target = profile.targetId,
          wantedTargets.contains(target), profile.targetState == "running",
          profile.connectionInProgress == false,
          !profile.connected else { return nil }
    shown.insert(pid)
    return profile
  }
}

struct TelaWorkInventory {
  private(set) var profiles: [TelaWorkProfile] = []
  private(set) var error: String?
  mutating func loaded(_ value: [TelaWorkProfile]) {
    profiles = value.sorted { $0.slot < $1.slot }
    error = nil
  }
  mutating func failed(_ error: Error) {
    let code = (error as NSError).code
    self.error = code == NSURLErrorTimedOut
      ? telaText("ChatGPT is taking longer to respond. Check again in a moment.")
      : telaText("Couldn't check your ChatGPT apps. Please try again.")
  }
}

// A failed connection action is obsolete only when fresh inventory proves its
// intended result for the same target. Native-only readiness cannot settle a Web start.
struct TelaProfileConnectionFailure {
  enum Goal { case connected, stopped }
  let slot: Int
  let targetId: String
  let goal: Goal
  func resolved(in inventory: TelaWorkInventory, operationInProgress: Bool) -> Bool {
    guard !operationInProgress, inventory.error == nil,
          let profile = inventory.profiles.first(where: { $0.slot == slot && $0.targetId == targetId }),
          profile.connectionInProgress != true else { return false }
    switch goal {
    case .connected:
      return profile.connected && profile.webState == "ready" && profile.webModelsReady == true
        && profile.accountManagementActive != true
    case .stopped:
      return profile.controlState == "stopped" && profile.targetSessionState == "available"
    }
  }
}

// Inventory launches bounded platform discovery; quick health checks must not set its budget.
enum TelaRequestBudget {
  static func seconds(path: String, method: String) -> TimeInterval {
    if method == "POST" && path.hasPrefix("v1/codex/profiles/") { return 320 }
    if path.hasPrefix("v1/ingress?") { return 30 }
    if path.hasSuffix("/account-display") { return 25 }
    return path == "v1/codex/profiles" ? 30 : 4
  }
}

struct TelaConnectionFailure: Decodable, LocalizedError {
  let phase: String
  let message: String
  var errorDescription: String? { message }
}
struct TelaConnectionFrame: Decodable {
  let phase: String?
  let profile: TelaWorkProfile?
  let error: TelaConnectionFailure?
}
func telaConnectionProgress(_ phase: String) -> String {
  switch phase {
  case "browser": return telaText("Opening Web connection…")
  case "account": return telaText("Checking Web sign-in…")
  case "connector": return telaText("Checking Tela connection…")
  case "models": return telaText("Loading available models…")
  case "opening": return telaText("Opening ChatGPT…")
  case "checking": return telaText("Checking ChatGPT…")
  case "closing": return telaText("Waiting for ChatGPT to close…")
  case "preparing": return telaText("Getting Web models ready…")
  case "connecting": return telaText("Connecting ChatGPT…")
  case "ready": return telaText("Finishing up…")
  default: return telaText("Connecting…")
  }
}

// Both product windows consume one inventory; snapshots remain value types.
@MainActor final class TelaWorkState {
  var onChange: (() -> Void)?
  private var revision = 0
  var inventory = TelaWorkInventory() { didSet { revision += 1; onChange?() } }
  func beginRead() -> Int { revision += 1; return revision }
  func finishRead(_ ticket: Int, profiles: [TelaWorkProfile]?, error: Error? = nil) {
    guard ticket == revision else { return }
    if let profiles { inventory.loaded(profiles) }
    else if let error { inventory.failed(error) }
  }
}

struct TelaProfilePresentation {
  let busy: Bool
  let label: String
  init(profile: TelaWorkProfile, inventoryError: String?, localProgress: String?) {
    busy = localProgress != nil || (inventoryError == nil && (profile.connectionInProgress == true
      || (profile.connected && profile.webState == "preparing" && profile.accountManagementActive != true)))
    label = localProgress ?? (busy ? (profile.connected ? profile.connectionLabel : telaText("Connecting…"))
      : (inventoryError == nil ? profile.connectionLabel : telaText("Connection status unavailable")))
  }
}

// A running local service is independent of public Web ingress and does not
// prove that the user installed or enabled a plugin in ChatGPT Desktop.
struct TelaLocalChatPresentation {
  let serviceState: String
  var status: String {
    switch serviceState {
    case "Ready": return telaText("Running")
    case "Stopped": return telaText("Off")
    case "Unavailable": return telaText("Unavailable")
    default: return telaText("Checking…")
    }
  }
}

struct TelaStartPresentation {
  let webConfigured: Bool
  let chatReady: Bool
  let gatewayReady: Bool
  let codexReady: Bool
  var shouldOfferStart: Bool { !chatReady || (webConfigured && (!gatewayReady || !codexReady)) }
  var title: String { webConfigured ? telaText("Start Tela") : telaText("Start Tela Chat") }
}
