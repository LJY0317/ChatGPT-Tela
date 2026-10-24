import Foundation

@main struct BridgeTitleReadTests {
  static func main() {
    let watch = UUID()
    let original = BridgeTitleReadIdentity(owner: "profile-a:1", watchID: watch,
      inventory: ["surface-a"], selectedSlot: 1, selectedSurface: "surface-a")
    precondition(original == BridgeTitleReadIdentity(owner: "profile-a:1", watchID: watch,
      inventory: ["surface-a"], selectedSlot: 1, selectedSurface: "surface-a"))
    precondition(original != BridgeTitleReadIdentity(owner: "profile-b:2", watchID: watch,
      inventory: ["surface-a"], selectedSlot: 1, selectedSurface: "surface-a"))
    precondition(original != BridgeTitleReadIdentity(owner: "profile-a:1", watchID: UUID(),
      inventory: ["surface-a"], selectedSlot: 1, selectedSurface: "surface-a"))
    precondition(original != BridgeTitleReadIdentity(owner: "profile-a:1", watchID: watch,
      inventory: ["surface-b"], selectedSlot: 1, selectedSurface: "surface-a"))
    precondition(original != BridgeTitleReadIdentity(owner: "profile-a:1", watchID: watch,
      inventory: ["surface-a"], selectedSlot: 1, selectedSurface: "surface-b"))
    print("Bridge title read ownership and selection regression: passed")
  }
}
