import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

(process.platform === "darwin" ? test : test.skip)("Sparkle postponement preserves work and AppKit modal termination runs preparation after completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-delegate-"));
  const app = join(root, "Probe.app"), mac = join(app, "Contents/MacOS");
  const frameworkRoot = resolve("apps/menu-bar-macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let observer: ReturnType<typeof watch> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!existsSync(join(frameworkRoot, "Sparkle.framework"))) {
      const build = spawnSync("/usr/bin/xcrun", ["swift", "build", "--disable-keychain", "--disable-netrc", "--package-path", "apps/menu-bar-macos", "-c", "release"], { stdio: "inherit" });
      expect(build.status).toBe(0);
    }
    mkdirSync(mac, { recursive: true });
    mkdirSync(join(app, "Contents/Frameworks"));
    cpSync(join(frameworkRoot, "Sparkle.framework"), join(app, "Contents/Frameworks/Sparkle.framework"), { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.chatgpt-tela.disposable.${crypto.randomUUID()}</string>
<key>CFBundleName</key><string>Tela update test</string><key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/>
</dict></plist>`);
    writeFileSync(join(mac, "chatgpt-tela"), `#!/bin/sh
case "$2" in
wait) printf entered > "$TELA_IDLE_FIXTURE/wait-entered"; IFS= read -r release < "$TELA_IDLE_FIXTURE/release.fifo"; printf '{"ready":true}\\n' ;;
prepare) printf prepared > "$TELA_IDLE_FIXTURE/prepared"; printf '{"prepared":true}\\n' ;;
*) printf '{"ready":true}\\n' ;;
esac
`, { mode: 0o755 });
    const harness = join(root, "probe.swift");
    writeFileSync(harness, `import AppKit
import Sparkle
@MainActor final class Probe: NSObject, NSApplicationDelegate {
  var tela: TelaSparkleUpdater!
  var source: SPUStandardUpdaterController!
  func applicationDidFinishLaunching(_ note: Notification) {
    let root = ProcessInfo.processInfo.environment["TELA_IDLE_FIXTURE"]!
    tela = TelaSparkleUpdater()
    source = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
    // Only a synthetic version is needed; no feed, archive or update is fetched.
    let item = SUAppcastItem(dictionary: ["enclosure": ["sparkle:version": "2", "url": "http://127.0.0.1/unused.zip", "length": "1", "type": "application/octet-stream"]])!
    precondition(tela.updater(source.updater, shouldPostponeRelaunchForUpdate: item) {
      try! Data("resumed".utf8).write(to: URL(fileURLWithPath: root + "/resumed"))
      DispatchQueue.main.async { NSApp.terminate(nil) }
    })
    precondition(tela.preparationStatus == "Waiting for tasks to finish…" && !tela.canCheck)
    precondition(tela.applicationShouldTerminate(NSApp) == .terminateCancel)
    try! Data("started".utf8).write(to: URL(fileURLWithPath: root + "/started"))
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { tela.applicationShouldTerminate(sender) }
}
@main struct Entry {
  @MainActor static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let delegate = Probe()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}`);
    const compile = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", resolve("apps/menu-bar-macos/sparkle-update.swift"), harness,
      "-F", frameworkRoot, "-framework", "Sparkle", "-framework", "AppKit", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks", "-o", join(mac, "probe")], { encoding: "utf8" });
    expect(compile.status).toBe(0);
    expect(spawnSync("/usr/bin/mkfifo", [join(root, "release.fifo")]).status).toBe(0);
    const entered = new Promise<void>(resolve => {
      observer = watch(root, () => { if (existsSync(join(root, "wait-entered"))) { observer?.close(); resolve(); } });
    });
    child = Bun.spawn([join(mac, "probe")], { env: { ...process.env, TELA_IDLE_FIXTURE: root }, stdout: "ignore", stderr: "ignore" });
    const running = child;
    deadline = setTimeout(() => running.kill(), 20_000);
    await Promise.race([entered, child.exited.then(code => { throw Error(`probe exited before completion gate (${code})`); })]);
    expect(existsSync(join(root, "started"))).toBe(true);
    expect(existsSync(join(root, "resumed"))).toBe(false);
    expect(existsSync(join(root, "prepared"))).toBe(false);
    expect(child.exitCode).toBeNull();
    writeFileSync(join(root, "release.fifo"), "completed\n");
    expect(await child.exited).toBe(0);
    expect(existsSync(join(root, "resumed"))).toBe(true);
    expect(existsSync(join(root, "prepared"))).toBe(true);
  } finally {
    clearTimeout(deadline); observer?.close();
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
