import Foundation

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
  var connectionInProgress: Bool? = nil
  var webModelsReady: Bool? = nil
  var webState: String? = nil
  var accountManagementActive: Bool? = nil
  var needsWebSignIn: Bool { connected && webState == "login-required" }
  var canReconnectWeb: Bool { connected && (webState == "failed" || webState == "ready") }
  var connected: Bool { controlState == "running" && targetSessionState == "ready" }
  var action: String { connected ? "stop" : (targetState == "running" || controlState == "restart-required" ? "restart" : "start") }
  var connectionLabel: String {
    if connected && accountManagementActive == true { return "Finish account management" }
    if connected && webState == "preparing" { return "Connecting…" }
    if needsWebSignIn { return "Web sign-in required" }
    if connected && webState == "failed" { return "Connection failed" }
    if connected && webState == "ready" && webModelsReady != false { return "Connected" }
    return connected && webModelsReady == false ? "Models unavailable" : connected ? "Connected" : (action == "restart" ? "Reconnect required" : "Off")
  }
}

struct TelaWebPresentation {
  enum Action { case none, account, reconnect, finish }
  let status: String
  let action: Action
  let buttonTitle: String?
  let needsAttention: Bool

  init(profile: TelaWorkProfile, account: TelaAccountDisplay? = nil) {
    let result: (String, Action, String?, Bool)
    if !profile.connected {
      result = ("Off", .none, nil, false)
    } else if profile.accountManagementActive == true {
      result = ("Finish in the browser", .finish, "Done", true)
    } else if profile.connectionInProgress == true || profile.webState == "preparing" {
      result = ("Connecting…", .none, nil, false)
    } else if profile.needsWebSignIn || account?.web.state == "signed-out" {
      result = ("Sign-in required", .account, "Sign in…", true)
    } else if account?.comparison == "different" {
      result = ("Different account", .account, "Change account…", true)
    } else if profile.webState == "ready" && profile.webModelsReady != false {
      result = ("Ready", .account, "Account…", false)
    } else if account?.web.state == "signed-in" && profile.canReconnectWeb {
      result = ("Unavailable", .reconnect, "Try again", true)
    } else {
      result = ("Account not verified", .account, "Check account…", true)
    }
    status = result.0; action = result.1; buttonTitle = result.2; needsAttention = result.3
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
          profile.controlState == "restart-required", !profile.connected else { return nil }
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
      ? "ChatGPT is taking longer to respond. Check again in a moment."
      : "Couldn't check your ChatGPT apps. Please try again."
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
  case "browser": return "Opening Web connection…"
  case "account": return "Checking Web sign-in…"
  case "connector": return "Checking Tela connection…"
  case "models": return "Loading available models…"
  case "opening": return "Opening ChatGPT…"
  case "checking": return "Checking ChatGPT…"
  case "closing": return "Waiting for ChatGPT to close…"
  case "preparing": return "Getting Web models ready…"
  case "connecting": return "Connecting ChatGPT…"
  case "ready": return "Finishing up…"
  default: return "Connecting…"
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
    label = localProgress ?? (busy ? (profile.connected ? profile.connectionLabel : "Connecting…") : (inventoryError == nil ? profile.connectionLabel : "Connection status unavailable"))
  }
}
