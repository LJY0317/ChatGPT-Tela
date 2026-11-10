import Foundation

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
