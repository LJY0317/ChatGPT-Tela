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
    let named = ControlCenterBridgeSurface(id: "surface-a", label: "Web session 1", title: "Original")
    let missing = ControlCenterBridgeSurface(id: named.id, label: named.label, title: nil)
    let renamed = ControlCenterBridgeSurface(id: named.id, label: named.label, title: "New title")
    let other = ControlCenterBridgeSurface(id: "surface-b", label: named.label, title: nil)
    precondition(preservingBridgeTitles([missing, other], from: [named]) == [named, other])
    precondition(preservingBridgeTitles([renamed], from: [named]) == [renamed])
    precondition(preservingBridgeTitles([missing], from: []) == [missing])
    precondition(preservingBridgeTitles([], from: [named]).isEmpty)
    print("Bridge title read ownership and selection regression: passed")
  }
}
