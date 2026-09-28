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

private struct ProfileStatus: Decodable {
  let slot: Int
  let targetDisplayName: String
  let targetState: String
  let targetSessionState: String
  let controlState: String
}

private struct ProfilesEnvelope: Decodable {
  let profiles: [ProfileStatus]
}

private struct Preferences: Codable {
  let version: Int
  var approvalAutomation: String
}

private struct MenuSnapshot {
  let services: [(String, String)]
  let ingress: IngressStatus?
  let profiles: [ProfileStatus]
  let approvalAutomation: String?
  let approvalError: Bool
  let installedServiceControls: Bool
}

private func runLaunchctl(_ arguments: [String]) {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
  task.arguments = arguments
  try? task.run()
  task.waitUntilExit()
}

@MainActor
final class TelaMenuBarController: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem!
  private var snapshot: MenuSnapshot?
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
  private var logsURL: URL {
    home.appendingPathComponent("Library/Logs/ChatGPT Tela", isDirectory: true)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = statusItem.button {
      if #available(macOS 11.0, *) {
        button.image = NSImage(systemSymbolName: "network", accessibilityDescription: "ChatGPT Tela")
      } else {
        button.title = "T"
      }
    }
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu
    rebuildMenu(loading: true)
  }

  func menuWillOpen(_ menu: NSMenu) {
    rebuildMenu(loading: true)
    Task {
      let observed = await inspect()
      snapshot = observed
      rebuildMenu(loading: false)
    }
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

  private func request(
    _ descriptor: ServiceDescriptor,
    path: String,
    method: String = "GET"
  ) async throws -> Data {
    guard let base = URL(string: descriptor.endpoint),
          let url = URL(string: path, relativeTo: base) else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 3)
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(descriptor.bearerToken)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 3
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

  private func readPreferences() throws -> Preferences {
    guard fileManager.fileExists(atPath: preferencesURL.path) else {
      return Preferences(version: 1, approvalAutomation: "off")
    }
    let values = try preferencesURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 5)
    }
    let value = try JSONDecoder().decode(Preferences.self, from: Data(contentsOf: preferencesURL))
    guard value.version == 1, ["off", "recognized_once"].contains(value.approvalAutomation) else {
      throw NSError(domain: "ChatGPTTelaMenuBar", code: 6)
    }
    return value
  }

  private func writePreferences(_ value: Preferences) throws {
    let directory = preferencesURL.deletingLastPathComponent()
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
    let data = try JSONEncoder().encode(value)
    var payload = data
    payload.append(0x0A)
    try payload.write(to: preferencesURL, options: .atomic)
    try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preferencesURL.path)
  }

  private func installedServiceControlsAvailable() -> Bool {
    ["gateway", "chat", "codex"].allSatisfy { service in
      fileManager.fileExists(atPath: home
        .appendingPathComponent("Library/LaunchAgents/com.openai.chatgpt-tela.\(service).plist").path)
    }
  }

  private func inspect() async -> MenuSnapshot {
    async let gateway = inspectService("gateway")
    async let chat = inspectService("chat")
    async let codex = inspectService("codex")
    async let ingress = inspectIngress()
    var profiles: [ProfileStatus] = []
    if let descriptor = try? readDescriptor("codex") {
      if let data = try? await request(descriptor, path: "v1/codex/profiles"),
         let envelope = try? JSONDecoder().decode(ProfilesEnvelope.self, from: data) {
        profiles = envelope.profiles.sorted { $0.slot < $1.slot }
      }
    }
    let preferences = try? readPreferences()
    return MenuSnapshot(
      services: [("Gateway", await gateway), ("Chat", await chat), ("Codex", await codex)],
      ingress: await ingress,
      profiles: profiles,
      approvalAutomation: preferences?.approvalAutomation,
      approvalError: preferences == nil,
      installedServiceControls: installedServiceControlsAvailable()
    )
  }

  private func addDisabled(_ title: String, to menu: NSMenu) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
  }

  private func rebuildMenu(loading: Bool) {
    guard let menu = statusItem.menu else { return }
    menu.removeAllItems()
    addDisabled("ChatGPT Tela", to: menu)
    menu.addItem(NSMenuItem(title: "Open ChatGPT Tela…", action: #selector(openControlCenter), keyEquivalent: "o"))
    menu.addItem(.separator())
    if loading || snapshot == nil {
      addDisabled("Refreshing status…", to: menu)
    } else if let snapshot {
      for (name, state) in snapshot.services {
        addDisabled("\(name): \(state)", to: menu)
      }
      if let ingress = snapshot.ingress {
        let title: String
        if ingress.availability == "ready" {
          title = "Public connector: Ready"
        } else if ingress.cause == "tailscale-backend-unreachable" || ingress.cause == "tailscale-stopped" {
          title = "Public connector: Tailscale is off"
        } else if ingress.cause == "tailscale-needs-login" {
          title = "Public connector: Tailscale sign-in required"
        } else if ingress.cause == "tailscale-offline" {
          title = "Public connector: Tailscale offline"
        } else if ingress.cause == "local-mcp-unreachable" {
          title = "Public connector: Gateway MCP unavailable"
        } else if ingress.cause == "funnel-route-absent" || ingress.cause == "funnel-route-drift" {
          title = "Public connector: Funnel route unavailable"
        } else {
          title = "Public connector: Unavailable"
        }
        addDisabled(title, to: menu)
      } else if snapshot.services.first(where: { $0.0 == "Gateway" })?.1 == "Stopped" {
        addDisabled("Public connector: Gateway stopped", to: menu)
      }
      if snapshot.installedServiceControls {
        menu.addItem(NSMenuItem(title: "Start Background Services", action: #selector(startServices), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop Background Services", action: #selector(stopServices), keyEquivalent: ""))
      }
      menu.addItem(.separator())
      if snapshot.profiles.isEmpty {
        addDisabled("Codex profiles unavailable", to: menu)
      } else {
        for profile in snapshot.profiles {
          addDisabled("\(profile.targetDisplayName): \(profile.controlState)", to: menu)
          let actionTitle: String
          let action: Selector
          if profile.controlState == "running" {
            actionTitle = "Stop Profile \(profile.slot)"
            action = #selector(stopProfile(_:))
          } else if profile.controlState == "restart-required" {
            actionTitle = "Restart Profile \(profile.slot)"
            action = #selector(restartProfile(_:))
          } else {
            actionTitle = "Start Profile \(profile.slot)"
            action = #selector(startProfile(_:))
          }
          let item = NSMenuItem(title: actionTitle, action: action, keyEquivalent: "")
          item.representedObject = profile.slot
          menu.addItem(item)
        }
      }
      menu.addItem(.separator())
      let approval = NSMenuItem(title: "Auto-approve recognized one-shot cards", action: #selector(toggleApproval), keyEquivalent: "")
      approval.state = snapshot.approvalAutomation == "recognized_once" ? .on : .off
      approval.isEnabled = !snapshot.approvalError
      menu.addItem(approval)
      if snapshot.approvalAutomation == "recognized_once" && snapshot.profiles.contains(where: { $0.controlState == "running" }) {
        addDisabled("Restart active profile(s) to apply approval changes", to: menu)
      }
      if snapshot.approvalError {
        addDisabled("Approval preferences are invalid; fix preferences-v1.json", to: menu)
      }
    }
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Open Logs", action: #selector(openLogs), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Open Diagnostics", action: #selector(openDiagnostics), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Refresh", action: #selector(refresh), keyEquivalent: "r"))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit Menu Bar", action: #selector(quitMenuBar), keyEquivalent: "q"))
  }

  @objc private func startServices() {
    let uid = getuid()
    let operation = Task.detached {
      for service in ["gateway", "chat", "codex"] {
        runLaunchctl(["kickstart", "gui/\(uid)/com.openai.chatgpt-tela.\(service)"])
      }
    }
    Task {
      _ = await operation.value
      await refreshNow()
    }
  }

  @objc private func stopServices() {
    let uid = getuid()
    let operation = Task.detached {
      for service in ["gateway", "chat", "codex"] {
        runLaunchctl(["kill", "SIGTERM", "gui/\(uid)/com.openai.chatgpt-tela.\(service)"])
      }
    }
    Task {
      _ = await operation.value
      await refreshNow()
    }
  }

  private func profileAction(slot: Int, action: String) async {
    do {
      guard let descriptor = try readDescriptor("codex") else { return }
      _ = try await request(descriptor, path: "v1/codex/profiles/\(slot)/\(action)", method: "POST")
    } catch {
      NSSound.beep()
    }
    await refreshNow()
  }

  @objc private func startProfile(_ sender: NSMenuItem) {
    guard let slot = sender.representedObject as? Int else { return }
    Task { await profileAction(slot: slot, action: "start") }
  }

  @objc private func stopProfile(_ sender: NSMenuItem) {
    guard let slot = sender.representedObject as? Int else { return }
    Task { await profileAction(slot: slot, action: "stop") }
  }

  @objc private func restartProfile(_ sender: NSMenuItem) {
    guard let slot = sender.representedObject as? Int else { return }
    Task {
      await profileAction(slot: slot, action: "stop")
      await profileAction(slot: slot, action: "start")
    }
  }

  @objc private func toggleApproval() {
    do {
      var preferences = try readPreferences()
      preferences.approvalAutomation = preferences.approvalAutomation == "recognized_once" ? "off" : "recognized_once"
      try writePreferences(preferences)
    } catch {
      NSSound.beep()
    }
    Task { await refreshNow() }
  }

  @objc private func openLogs() {
    try? fileManager.createDirectory(at: logsURL, withIntermediateDirectories: true,
                                     attributes: [.posixPermissions: 0o700])
    NSWorkspace.shared.open(logsURL)
  }

  @objc private func openControlCenter() {
    controlCenter.show()
  }

  @objc private func openDiagnostics() {
    try? fileManager.createDirectory(at: logsURL, withIntermediateDirectories: true,
                                     attributes: [.posixPermissions: 0o700])
    NSWorkspace.shared.open(logsURL)
  }

  @objc private func refresh() {
    Task { await refreshNow() }
  }

  private func refreshNow() async {
    snapshot = await inspect()
    rebuildMenu(loading: false)
  }

  @objc private func quitMenuBar() {
    NSApp.terminate(nil)
  }
}

@main
struct ChatGPTTelaMenuBarMain {
  @MainActor
  static func main() {
    let app = NSApplication.shared
    let delegate = TelaMenuBarController()
    app.delegate = delegate
    app.run()
  }
}
