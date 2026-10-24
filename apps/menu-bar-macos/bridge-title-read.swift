import Foundation

// Snapshot the existing owner/watch/selection lifecycle before an async metadata read.
struct BridgeTitleReadIdentity<Inventory: Equatable>: Equatable {
  let owner: String?
  let watchID: UUID?
  let inventory: Inventory?
  let selectedSlot: Int?
  let selectedSurface: String?
}
