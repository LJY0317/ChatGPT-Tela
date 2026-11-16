import Foundation

// The maintenance utility is a separate SwiftPM executable target and reads
// the same app-only language selection and bundled strings as the menu app.
func telaText(_ source: String) -> String {
  let url = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/ChatGPT Tela/config/preferences-v1.json")
  let preferences = (try? Data(contentsOf: url))
    .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  let selected = (preferences?["uiLanguage"] as? String) ?? "en"
  let korean = selected == "ko" ||
    (selected == "system" && Locale.preferredLanguages.first?.lowercased().hasPrefix("ko") == true)
  guard korean else { return source }
  let roots = [Bundle.main.resourceURL, Bundle.main.executableURL?.deletingLastPathComponent()].compactMap { $0 }
  for root in roots {
    if let bundle = Bundle(url: root.appendingPathComponent("TelaLocalizations.bundle")),
       let path = bundle.path(forResource: "ko", ofType: "lproj"),
       let koreanBundle = Bundle(path: path) {
      return koreanBundle.localizedString(forKey: source, value: source, table: "Localizable")
    }
  }
  return source
}
