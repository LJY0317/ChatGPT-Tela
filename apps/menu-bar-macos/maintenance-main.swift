import AppKit

@main
struct TelaMaintenanceMain {
  @MainActor static func main() {
    let app = NSApplication.shared
    let menu = NSMenu()
    let applicationItem = NSMenuItem()
    let applicationMenu = NSMenu(title: "Tela Maintenance")
    applicationMenu.addItem(withTitle: "Quit Tela Maintenance", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    applicationItem.submenu = applicationMenu
    menu.addItem(applicationItem)
    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    menu.addItem(windowItem)
    app.mainMenu = menu
    let delegate = TelaMaintenanceController()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
