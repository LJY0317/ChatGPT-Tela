import AppKit
import Sparkle

@main struct SparkleChoiceTests {
  @MainActor static func main() throws {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    precondition(TelaSparkleUpdater.instancesRespond(to:
      NSSelectorFromString("updater:didFinishUpdateCycleForUpdateCheck:error:")))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".app")
    let contents = directory.appendingPathComponent("Contents")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let info = ["CFBundleIdentifier": "org.example.TelaSparkleChoiceTests", "CFBundleName": "Update Fixture", "CFBundleVersion": "1"]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      .write(to: contents.appendingPathComponent("Info.plist"))
    let driver = TelaSparkleUserDriver(hostBundle: Bundle(url: directory)!, delegate: nil)
    var choices: [SPUUserUpdateChoice] = []
    precondition(!driver.canDiscardDownload)
    driver.showReady(toInstallAndRelaunch: { choices.append($0) })
    precondition(driver.canDiscardDownload)
    driver.discardDownload()
    driver.discardDownload()
    precondition(choices == [.skip] && !driver.canDiscardDownload)

    driver.showReady(toInstallAndRelaunch: { choices.append($0) })
    driver.dismissUpdateInstallation()
    driver.discardDownload()
    precondition(choices == [.skip] && !driver.canDiscardDownload)

    driver.showReady(toInstallAndRelaunch: { choices.append($0) })
    driver.showInstallingUpdate(withApplicationTerminated: false, retryTerminatingApplication: {})
    driver.discardDownload()
    precondition(choices == [.skip] && !driver.canDiscardDownload)
    driver.dismissUpdateInstallation()
    print("Sparkle choice lifecycle: discard once, dismissal, and installation handoff passed")
  }
}
