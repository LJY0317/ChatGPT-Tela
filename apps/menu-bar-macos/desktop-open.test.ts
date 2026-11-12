import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

(process.platform === "darwin" ? test : test.skip)("opening an absent app does not reuse a running clone with the same bundle ID", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-desktop-open-"));
  const domain = `org.chatgpttela.disposable.${crypto.randomUUID()}`;
  try {
    const appSource = join(root, "app.swift");
    writeFileSync(appSource, "import AppKit\nNSApplication.shared.run()\n");
    const apps = [join(root, "A.app"), join(root, "B.app")];
    for (const app of apps) {
      mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
      writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${domain}</string><key>CFBundleName</key><string>Tela disposable app</string>
<key>CFBundleExecutable</key><string>probe</string><key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
      const compiled = spawnSync("/usr/bin/xcrun", ["swiftc", appSource, "-o", join(app, "Contents/MacOS/probe")], { encoding: "utf8" });
      expect(compiled.status, compiled.stderr).toBe(0);
    }
    const source = readFileSync(resolve("apps/menu-bar-macos/sparkle-update.swift"), "utf8").split("/// Sparkle owns")[0]!.replace("import Sparkle\n", "");
    const helper = join(root, "helper.swift"), harness = join(root, "main.swift"), binary = join(root, "check");
    writeFileSync(helper, source + '\nfunc recordMenuDiagnostic(_ event: String, fields: [String: Any] = [:]) {}\n');
    writeFileSync(harness, `import AppKit
@main struct Test {
 @MainActor static func main() async {
  let a=URL(fileURLWithPath:CommandLine.arguments[1]), b=URL(fileURLWithPath:CommandLine.arguments[2])
  let domain=CommandLine.arguments[3]
  defer { for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == domain { app.terminate() } }
  let configuration=NSWorkspace.OpenConfiguration(); configuration.activates=false; configuration.createsNewApplicationInstance=true
  let second:NSRunningApplication?=await withCheckedContinuation { done in NSWorkspace.shared.openApplication(at:b,configuration:configuration){app,_ in done.resume(returning:app)} }
  let firstError:Error?=await withCheckedContinuation { done in openTelaDesktopApplication(at:a,activates:false){done.resume(returning:$0)} }
  let first=NSWorkspace.shared.runningApplications.first { $0.bundleURL?.standardizedFileURL == a.standardizedFileURL }
  let again:Error?=await withCheckedContinuation { done in openTelaDesktopApplication(at:a,activates:false){done.resume(returning:$0)} }
  let result:[String:Any]=["bothOpened":first != nil && second != nil,"distinctProcesses":first?.processIdentifier != second?.processIdentifier,
   "success":firstError == nil && again == nil,"instanceCount":NSWorkspace.shared.runningApplications.filter{$0.bundleIdentifier == domain}.count]
  let data=try! JSONSerialization.data(withJSONObject:result);print(String(data:data,encoding:.utf8)!)
 }
}`);
    const compiled = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", helper, harness, "-framework", "AppKit", "-o", binary], { encoding: "utf8" });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [...apps, domain], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ bothOpened: true, distinctProcesses: true, success: true, instanceCount: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);
