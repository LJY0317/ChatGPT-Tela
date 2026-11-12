import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Tiny public-API-shaped Sparkle stub: exercise the production Swift delegate
// without downloading a framework, showing real UI or installing an update.
(process.platform === "darwin" ? test : test.skip)(
  "a new Sparkle session abort cannot cancel a prepared handoff owned by the previous UI process",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-sparkle-recovered-abort-"));
    const app = join(root, "Probe.app"), mac = join(app, "Contents/MacOS");
    const framework = join(app, "Contents/Frameworks"), effects = join(root, "effects");
    try {
      mkdirSync(mac, { recursive: true });
      mkdirSync(framework, { recursive: true });
      const stub = join(root, "sparkle-stub.swift");
      writeFileSync(stub, `
@MainActor public protocol SPUUpdaterDelegate: AnyObject {}
@MainActor public protocol SPUStandardUserDriverDelegate: AnyObject {}
@MainActor public final class SPUUpdater {
  public var automaticallyChecksForUpdates = false
  public var canCheckForUpdates = true
  public var sessionInProgress = false
  public init() {}
  public func start() throws {}
}
@MainActor public final class SPUStandardUpdaterController {
  public let updater = SPUUpdater()
  public init(startingUpdater: Bool, updaterDelegate: (any SPUUpdaterDelegate)?,
              userDriverDelegate: (any SPUStandardUserDriverDelegate)?) {}
  public func checkForUpdates(_ sender: Any?) {}
}
public final class SUAppcastItem {
  public let versionString: String
  public let displayVersionString: String
  public init(versionString: String) {
    self.versionString = versionString
    self.displayVersionString = versionString
  }
}
public final class SPUUserUpdateState {}
`);
      const library = join(root, "libSparkle.dylib");
      const stubBuild = spawnSync("/usr/bin/xcrun", [
        "swiftc", "-emit-library", "-emit-module", "-module-name", "Sparkle",
        stub, "-o", library,
      ], { encoding: "utf8" });
      expect(stubBuild.status, stubBuild.stderr).toBe(0);
      cpSync(library, join(framework, "libSparkle.dylib"));
      writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.chatgpt-tela.disposable.recovered-abort</string>
<key>CFBundleName</key><string>Tela recovered abort fixture</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`);
      writeFileSync(join(mac, "chatgpt-tela"), `#!/bin/sh
case "$2" in
finish) printf '{"ready":false,"prepared":true}\\n' ;;
cancel) printf 'cancel\\n' >> "$TELA_SPARKLE_ABORT_EFFECTS"; printf '{"ready":true,"restored":true}\\n' ;;
*) exit 3 ;;
esac
`, { mode: 0o755 });
      const probe = join(root, "probe.swift");
      writeFileSync(probe, `
import AppKit
import Sparkle
@main struct Probe {
  @MainActor static func main() async {
    let appsRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: appsRoot) }
    let standard = appsRoot.appendingPathComponent("Applications/ChatGPT.app")
    let clone = appsRoot.appendingPathComponent("runtime/profile-2/ChatGPT.app")
    let resolved = telaDefaultDesktopApplicationURL(
      applicationDirectories: [standard.deletingLastPathComponent()], registeredApplications: { _ in [clone, standard] })
    precondition(resolved == standard, "shared bundle ID must not select the profile clone")
    precondition(telaDefaultDesktopApplicationURL( applicationDirectories: [],
      registeredApplications: { _ in [clone, standard] }) == nil, "ambiguous installation must not open the wrong profile")
    let restore = TelaSparkleUpdater()
    let first = TelaDesktopProfile(slot: 1, targetId: "default")
    let second = TelaDesktopProfile(slot: 2, targetId: "fixture.second")
    restore.runningDesktopProfiles = { [first] }
    var opened: [TelaDesktopProfile] = []
    restore.reopenDesktop = { value, completion in opened.append(value); completion(nil) }
    restore.preserveDesktopApps(targetBuild: "1")
    restore.runningDesktopProfiles = { [] }
    restore.restoreDesktopApps()
    restore.restoreDesktopApps()
    precondition(opened == [first], "restore must reopen the pre-update profile once")
    restore.runningDesktopProfiles = { [first, second] }
    restore.preserveDesktopApps(targetBuild: "1")
    restore.runningDesktopProfiles = { [] }
    restore.restoreDesktopApps()
    precondition(opened == [first, first, second], "optional profiles must restore by provider identity")
    restore.runningDesktopProfiles = { [first, second] }
    restore.preserveDesktopApps(targetBuild: "2")
    restore.restoreDesktopApps()
    precondition(opened.count == 3 && UserDefaults.standard.dictionary(forKey: "TelaUpdateDesktopProfiles") != nil,
      "source build must not consume a future update snapshot")
    restore.runningDesktopProfiles = { [second] }
    restore.restoreDesktopApps(forBuild: "2")
    precondition(opened.count == 4 && opened.last == first,
      "an aborted attempt must restore the app it closed without reopening the app that refused to quit")
    restore.runningDesktopProfiles = { [first] }
    restore.reopenDesktop = { _, completion in completion(NSError(domain: "NSOSStatusErrorDomain", code: -10814)) }
    restore.preserveDesktopApps(targetBuild: "1")
    restore.runningDesktopProfiles = { [] }
    restore.restoreDesktopApps()
    await Task.yield()
    precondition(restore.problem != nil, "failed owner reopen must not be silent")
    precondition(UserDefaults.standard.dictionary(forKey: "TelaUpdateDesktopProfiles") == nil, "failed reopen must not keep retry state")
    let prior = TelaSparkleUpdater()
    let couldStart = await prior.start()
    precondition(!couldStart, "a source-build prepared handoff must block ordinary startup")
    precondition(prior.recoveredPendingUpdate, "source-build handoff was not observed")
    let driver = SPUUpdater()
    let error = NSError(domain: "SUSparkleErrorDomain", code: 1001,
                        userInfo: [NSLocalizedDescriptionKey: "new session found no update"])
    prior.updater(driver, didAbortWithError: error)
    try? await Task.sleep(nanoseconds: 500_000_000)
    let path = ProcessInfo.processInfo.environment["TELA_SPARKLE_ABORT_EFFECTS"]!
    precondition(prior.recoveredPendingUpdate, "unrelated new-session abort consumed the prior handoff")
    precondition(!FileManager.default.fileExists(atPath: path), "unrelated abort invoked cancel")

    let current = TelaSparkleUpdater()
    current.updater(driver, willInstallUpdate: SUAppcastItem(versionString: "2"))
    current.updater(driver, didAbortWithError: error)
    for _ in 0..<50 {
      if FileManager.default.fileExists(atPath: path) { break }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    let calls = try? String(contentsOfFile: path, encoding: .utf8)
    precondition(calls == "cancel\\n", "current-process cancellation did not retain its existing settlement")
  }
}
`);
      const compile = spawnSync("/usr/bin/xcrun", [
        "swiftc", "-parse-as-library", resolve("apps/menu-bar-macos/diagnostic-retention.swift"), resolve("apps/menu-bar-macos/sparkle-update.swift"),
        probe, "-I", root, "-L", root, "-lSparkle", "-framework", "AppKit",
        "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
        "-o", join(mac, "probe"),
      ], { encoding: "utf8" });
      expect(compile.status, compile.stderr).toBe(0);
      const run = spawnSync(join(mac, "probe"), [], {
        env: { ...process.env, CFFIXED_USER_HOME: root, TELA_SPARKLE_ABORT_EFFECTS: effects },
        encoding: "utf8", timeout: 10_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(effects)).toBe(true);
      expect(readFileSync(effects, "utf8")).toBe("cancel\n");
    } finally {
      spawnSync("/usr/bin/defaults", ["delete", "org.chatgpt-tela.disposable.recovered-abort", "TelaUpdateDesktopProfiles"]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000,
);
