import Foundation

private let menuDiagnosticLock = NSLock()

/// Shared structural menu evidence, bounded by encoded bytes and age, never event count.
func recordMenuDiagnostic(_ event: String, fields: [String: Any] = [:],
  home: URL = FileManager.default.homeDirectoryForCurrentUser) {
  menuDiagnosticLock.lock()
  defer { menuDiagnosticLock.unlock() }
  let directory = home.appendingPathComponent("Library/Logs/ChatGPT Tela", isDirectory: true)
  let url = directory.appendingPathComponent("menu-ui-events.json")
  var rows: [[String: Any]] = []
  if let data = try? Data(contentsOf: url), data.count <= 131072,
     let existing = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] { rows = existing }
  let now = Date().timeIntervalSince1970
  var row = fields
  row["at"] = now; row["event"] = event
  rows.append(row)
  do {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try retainedMenuDiagnosticData(rows, since: now - 86400, maxBytes: 131072).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  } catch { /* Diagnostics cannot alter application behavior. */ }
}

/// Keep the newest time-valid suffix that fits the encoded JSON byte budget.
func retainedMenuDiagnosticData(_ rows: [[String: Any]], since cutoff: TimeInterval, maxBytes: Int) throws -> Data {
  let entries = try rows.filter { ($0["at"] as? Double ?? 0) > cutoff }
    .map { try JSONSerialization.data(withJSONObject: $0) }
  var size = 2 + entries.reduce(0) { $0 + $1.count } + max(0, entries.count - 1)
  var first = 0
  while size > maxBytes && first < entries.count {
    size -= entries[first].count + (first + 1 < entries.count ? 1 : 0)
    first += 1
  }
  var data = Data([0x5b])
  for index in first..<entries.count {
    if index > first { data.append(0x2c) }
    data.append(entries[index])
  }
  data.append(0x5d)
  return data
}
