import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

(process.platform === "darwin" ? test : test.skip)("Sparkle handles deferred termination and preserves Tela startup when the updater is unavailable", async () => {
  const bundleId = `org.chatgpt-tela.disposable.${crypto.randomUUID()}`;
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
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Tela update test</string><key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/>
<key>SUPublicEDKey</key><string>invalid-fixture-key</string>
</dict></plist>`);
    writeFileSync(join(mac, "chatgpt-tela"), `#!/bin/sh
case "$2" in
wait) printf entered > "$TELA_IDLE_FIXTURE/wait-entered"
  if [ "$TELA_IDLE_FIXTURE_UI_EXIT" = 1 ]; then
    IFS= read -r release; printf closed > "$TELA_IDLE_FIXTURE/wait-settled"
  else IFS= read -r release < "$TELA_IDLE_FIXTURE/release.fifo"; fi
  printf '{"ready":true}\\n' ;;
prepare) printf prepared > "$TELA_IDLE_FIXTURE/prepared"; printf '{"prepared":true}\\n' ;;
cancel) printf cancelled > "$TELA_IDLE_FIXTURE/cancelled"; printf '{"ready":true,"restored":true}\\n' ;;
finish) if [ "$TELA_STARTUP_RECOVERY" = pending ]; then
  printf '{"ready":false,"prepared":true}'
  else printf '{"ready":true}'; fi ;;
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
    if let startup = ProcessInfo.processInfo.environment["TELA_STARTUP_RECOVERY"] {
      Task {
        let mayStart = await tela.start()
        precondition(mayStart == (startup == "ordinary"), "unavailable Sparkle must not change the service startup decision")
        precondition(tela.recoveredPendingUpdate == (startup == "pending"), "unavailable Sparkle must not hide a pending handoff")
        precondition(!tela.canCheck, "invalid updater configuration must disable update actions")
        let status = startup == "pending" ? "Can’t open the pending update." : "Updates are unavailable."
        precondition(tela.problem == telaText(status), "show an update problem without claiming service recovery failed")
        NSApp.terminate(nil)
      }
      return
    }
    if ProcessInfo.processInfo.environment["TELA_IDLE_FIXTURE_RECOVERED"] == "1" {
      precondition(tela.preparationStatus == nil)
      precondition(tela.applicationShouldTerminate(NSApp) == .terminateNow)
      try! Data("fresh".utf8).write(to: URL(fileURLWithPath: root + "/recovered"))
      NSApp.terminate(nil)
      return
    }
    source = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
    // Only a synthetic version is needed; no feed, archive or update is fetched.
    let item = SUAppcastItem(dictionary: ["enclosure": ["sparkle:version": "2", "url": "http://127.0.0.1/unused.zip", "length": "1", "type": "application/octet-stream"]])!
    if ProcessInfo.processInfo.environment["TELA_IDLE_FIXTURE_ABORT_PREPARE"] == "1" {
      tela.updater(source.updater, willInstallUpdate: item)
      DispatchQueue.main.async { NSApp.terminate(nil) }
      return
    }
    precondition(tela.updater(source.updater, shouldPostponeRelaunchForUpdate: item) {
      try! Data("resumed".utf8).write(to: URL(fileURLWithPath: root + "/resumed"))
      DispatchQueue.main.async { NSApp.terminate(nil) }
    })
    precondition(tela.preparationStatus == "Waiting to update…" && !tela.canCheck)
    precondition(tela.applicationShouldTerminate(NSApp) == .terminateCancel)
    try! Data("started".utf8).write(to: URL(fileURLWithPath: root + "/started"))
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    let reply = tela.applicationShouldTerminate(sender)
    if ProcessInfo.processInfo.environment["TELA_IDLE_FIXTURE_ABORT_PREPARE"] == "1" {
      precondition(reply == .terminateLater)
      tela.updater(source.updater, didAbortWithError: NSError(domain: "SparkleFixture", code: 1))
    }
    return reply
  }
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
    const compile = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", resolve("apps/menu-bar-macos/localization.swift"), resolve("apps/menu-bar-macos/diagnostic-retention.swift"), resolve("apps/menu-bar-macos/sparkle-update.swift"), harness,
      "-F", frameworkRoot, "-framework", "Sparkle", "-framework", "AppKit", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks", "-o", join(mac, "probe")], { encoding: "utf8" });
    expect(compile.status).toBe(0);
    expect(spawnSync("/usr/bin/mkfifo", [join(root, "release.fifo")]).status).toBe(0);
    const entered = new Promise<void>(resolve => {
      observer = watch(root, () => { if (existsSync(join(root, "wait-entered"))) { observer?.close(); resolve(); } });
    });
    child = Bun.spawn([join(mac, "probe")], { env: { ...process.env, CFFIXED_USER_HOME: root, TELA_IDLE_FIXTURE: root }, stdout: "ignore", stderr: "ignore" });
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

    // The same real AppKit/Sparkle delegate, now losing its UI process before
    // readiness. Only this disposable app is killed; its observer owns stdin.
    clearTimeout(deadline);
    for (const name of ["started", "wait-entered", "resumed", "prepared"]) rmSync(join(root, name));
    const whenCreated = (name: string) => new Promise<void>(resolve => {
      observer = watch(root, () => {
        if (existsSync(join(root, name))) { observer?.close(); resolve(); }
      });
      if (existsSync(join(root, name))) { observer.close(); resolve(); }
    });
    const waiting = whenCreated("wait-entered");
    const env = { ...process.env, CFFIXED_USER_HOME: root, TELA_IDLE_FIXTURE: root };
    child = Bun.spawn([join(mac, "probe")], { env: { ...env, TELA_IDLE_FIXTURE_UI_EXIT: "1" }, stdout: "ignore", stderr: "ignore" });
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(Error("disposable UI recovery timed out")), 20_000);
    });
    await Promise.race([waiting, timeout, child.exited.then(code => { throw Error(`UI exited before wait (${code})`); })]);
    const settled = whenCreated("wait-settled");
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    await Promise.race([settled, timeout]);
    child = Bun.spawn([join(mac, "probe")], { env: { ...env, TELA_IDLE_FIXTURE_RECOVERED: "1" }, stdout: "ignore", stderr: "ignore" });
    expect(await Promise.race([child.exited, timeout])).toBe(0);
    expect(existsSync(join(root, "recovered"))).toBe(true);
    expect(existsSync(join(root, "resumed"))).toBe(false);
    expect(existsSync(join(root, "prepared"))).toBe(false);

    for (const startup of ["ordinary", "pending"]) {
      const probe = Bun.spawn([join(mac, "probe")], { env: { ...env, TELA_STARTUP_RECOVERY: startup }, stdout: "ignore", stderr: "pipe" });
      child = probe;
      const stderr = new Response(probe.stderr).text();
      expect(await Promise.race([child.exited, timeout]), await stderr).toBe(0);
    }

    rmSync(join(root, "prepared"), { force: true });
    const cancelled = whenCreated("cancelled");
    child = Bun.spawn([join(mac, "probe")], { env: { ...env, TELA_IDLE_FIXTURE_ABORT_PREPARE: "1" }, stdout: "ignore", stderr: "ignore" });
    await Promise.race([cancelled, timeout, child.exited.then(code => { throw Error(`UI exited during aborted preparation (${code})`); })]);
    expect(existsSync(join(root, "prepared"))).toBe(true);
    expect(child.exitCode).toBeNull();
  } finally {
    clearTimeout(deadline); observer?.close();
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    spawnSync("/usr/bin/defaults", ["delete", bundleId, "TelaUpdateDesktopProfiles"]);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
