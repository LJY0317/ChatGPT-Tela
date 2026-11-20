import Foundation

// Snapshot the existing owner/watch/selection lifecycle before an async metadata read.
struct BridgeTitleReadIdentity<Inventory: Equatable>: Equatable {
  let owner: String?
  let watchID: UUID?
  let inventory: Inventory?
  let selectedSlot: Int?
  let selectedSurface: String?
}

struct ControlCenterBridgeSurface: Decodable, Equatable {
  let id: String
  let label: String
  let title: String?
}

// The caller drops the inventory when the profile owner changes. A missing
// metadata read must not erase a title already proven for the same surface.
func preservingBridgeTitles(_ incoming: [ControlCenterBridgeSurface],
  from previous: [ControlCenterBridgeSurface]) -> [ControlCenterBridgeSurface] {
  let titles = Dictionary(uniqueKeysWithValues: previous.compactMap { surface in
    surface.title.map { (surface.id, $0) }
  })
  return incoming.map { surface in
    guard surface.title == nil, let title = titles[surface.id] else { return surface }
    return ControlCenterBridgeSurface(id: surface.id, label: surface.label, title: title)
  }
}
