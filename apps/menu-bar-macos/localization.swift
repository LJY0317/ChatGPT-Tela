import Foundation

// The language choice belongs to Tela's interface, not the host OS or ChatGPT.
public enum TelaUILanguage: String, CaseIterable {
  case english = "en"
  case korean = "ko"
  case system = "system"
}

private func telaDefaultPreferencesURL() -> URL {
  FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/ChatGPT Tela/config/preferences-v1.json")
}

private func telaPreferencesObject(at url: URL) throws -> [String: Any] {
  guard FileManager.default.fileExists(atPath: url.path) else {
    return ["version": 1, "approvalAutomation": "off", "approvalDelay": "instant"]
  }
  let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
  guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
        object["version"] as? Int == 1 else {
    throw NSError(domain: "ChatGPTTelaPreferences", code: 3)
  }
  return object
}

public func telaStoredUILanguage(at url: URL) -> TelaUILanguage {
  guard let preferences = try? telaPreferencesObject(at: url),
        let value = preferences["uiLanguage"] as? String,
        let language = TelaUILanguage(rawValue: value) else { return .english }
  return language
}

// Update one preference without dropping fields owned by another runtime.
// The other Swift settings controls use this too, so their writes retain uiLanguage.
public func telaWritePreference(_ key: String, value: Any, at url: URL) throws {
  var preferences = try telaPreferencesObject(at: url)
  preferences[key] = value
  var data = try JSONSerialization.data(withJSONObject: preferences, options: [.prettyPrinted, .sortedKeys])
  data.append(0x0A)
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  try data.write(to: url, options: .atomic)
  try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

private final class TelaLanguageState {
  static let shared = TelaLanguageState()
  private let lock = NSLock()
  private var stored = telaStoredUILanguage(at: telaDefaultPreferencesURL())

  var language: TelaUILanguage {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }

  func reload(from url: URL) {
    let value = telaStoredUILanguage(at: url)
    lock.lock()
    stored = value
    lock.unlock()
  }

  func update(_ value: TelaUILanguage, at url: URL) throws {
    try telaWritePreference("uiLanguage", value: value.rawValue, at: url)
    lock.lock()
    stored = value
    lock.unlock()
  }
}

public func telaUILanguage() -> TelaUILanguage { TelaLanguageState.shared.language }

public func telaReloadUILanguage(at url: URL) { TelaLanguageState.shared.reload(from: url) }

public func telaSetUILanguage(_ language: TelaUILanguage, at url: URL) throws {
  try TelaLanguageState.shared.update(language, at: url)
}

private enum TelaLocalizations {
  // A separate standard bundle works for the menu app, maintenance helper, and
  // an unpackaged command-line build. No path to a build worktree is embedded.
  static let korean: Bundle? = {
    let roots = [Bundle.main.resourceURL, Bundle.main.executableURL?.deletingLastPathComponent()].compactMap { $0 }
    for root in roots {
      let localizations = root.appendingPathComponent("TelaLocalizations.bundle", isDirectory: true)
      if let path = Bundle(url: localizations)?.path(forResource: "ko", ofType: "lproj"),
         let bundle = Bundle(path: path) { return bundle }
    }
    return nil
  }()
}

// English source strings are localization keys. Call sites keep their own
// interpolation/format arguments and translate only Tela-owned UI strings.
public func telaText(_ source: String) -> String {
  let language = telaUILanguage()
  let korean = language == .korean || (language == .system
    && Locale.preferredLanguages.first?.lowercased().hasPrefix("ko") == true)
  guard korean, let bundle = TelaLocalizations.korean else { return source }
  return bundle.localizedString(forKey: source, value: source, table: "Localizable")
}
