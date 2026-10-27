import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyPackagedInstallFromPayload, macApplicationUpdatePath, packagedProductManifestPath,
  PackagedServiceShutdownNotStartedError, planPackagedInstallFromPayload, readMacApplicationUpdate,
  readOwnershipManifest, type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { LaunchdUpgradeRunner } from "../../../tests/support/launchd-upgrade-runner";
import { runApplicationUpdate } from "./application-update";
import { verifyInstalledPackage } from "./runtime";

async function fixture(root: string) {
  const source = join(root, "source.app"), home = join(root, "home");
  const manifest = { version: 1, product: "chatgpt-tela", productVersion: "1.0.0",
    launcher: { executable: "Contents/MacOS/chatgpt-tela" }, menuBar: { executable: "Contents/MacOS/chatgpt-tela-menu-bar" },
    profileRuntime: { executable: "Contents/Frameworks/Electron.app/Contents/MacOS/Electron", entrypoint: "Contents/Resources/runtime.js" },
    services: Object.fromEntries(["gateway", "chat", "codex"].map(id => [id, { executable: `Contents/Helpers/${id}`, arguments: [] }])) };
  const files = [manifest.launcher.executable, manifest.menuBar.executable, manifest.profileRuntime.executable,
    manifest.profileRuntime.entrypoint, ...Object.values(manifest.services).map(service => service.executable)];
  for (const file of files) { mkdirSync(dirname(join(source, file)), { recursive: true }); writeFileSync(join(source, file), "fixture", { mode: 0o755 }); }
  writeFileSync(join(source, "Contents/Info.plist"), "fixture-info");
  writeFileSync(join(source, "Contents/Resources/build.txt"), "1");
  writeFileSync(packagedProductManifestPath(source), JSON.stringify(manifest));
  const runner = new LaunchdUpgradeRunner(), options = { home, platform: "darwin" as const, environment: {}, runner };
  const planned = await planPackagedInstallFromPayload({ payloadSourcePath: source, ...options });
  const result = await applyPackagedInstallFromPayload({ planned, payloadSourcePath: source, ...options });
  expect(result.verify.ready).toBe(true);
  const paths = planned.blueprint.paths;
  const sourceRoot = paths.binaryRoot;
  const input = { payloadRoot: sourceRoot, options: { ...options, async shutdownService(service: TelaServiceId) {
    runner.jobs.get(`com.openai.chatgpt-tela.${service}`)!.running = false;
  }, async waitUntilReady(service: TelaServiceId) {
    verifyInstalledPackage({ payloadRoot: sourceRoot, pathOptions: options, service });
  } }, verifySignature() {}, readBuild(app: string) { return readFileSync(join(app, "Contents/Resources/build.txt"), "utf8"); } };
  for (const [id, job] of runner.jobs) job.running = !id.endsWith("codex");
  runner.calls.length = 0;
  return { input, runner, paths, manifest, sourceRoot };
}

// Synthetic launchd only; signature storage is separately tested with real codesign.
test("Sparkle replacement restores only prior running services and promotes external metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-settlement-"));
  try {
    const f = await fixture(root);
    expect(await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" })).toMatchObject({ prepared: true });
    expect(readMacApplicationUpdate(f.paths)?.phase).toBe("ready");
    expect([...f.runner.jobs.keys()]).toEqual(["com.openai.chatgpt-tela.menu-bar"]);
    const before = [...f.runner.calls];
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: false, prepared: true });
    expect(await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" })).toMatchObject({ prepared: true });
    expect(f.runner.calls).toEqual(before); // Resume a prepared Sparkle handoff without re-stopping or restoring source.

    // Simulates Sparkle's already authenticated replacement at the same app path.
    writeFileSync(packagedProductManifestPath(f.sourceRoot), JSON.stringify({ ...f.manifest, productVersion: "2.0.0" }));
    writeFileSync(join(f.sourceRoot, "Contents/Resources/build.txt"), "2");
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: true, restored: true, productVersion: "2.0.0" });
    expect(readOwnershipManifest(f.paths.installManifest)?.productVersion).toBe("2.0.0");
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.codex")?.running).toBe(false);
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.chat")?.running).toBe(true);
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.gateway")?.running).toBe(true);
    expect(existsSync(macApplicationUpdatePath(f.paths))).toBe(false);
    const calls = [...f.runner.calls];
    await runApplicationUpdate("finish", f.input);
    expect(f.runner.calls).toEqual(calls); // Startup reconciliation never sends another model/tool/service action.
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active-work refusal is before any shutdown or app-termination permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-active-"));
  try {
    const f = await fixture(root); let stops = 0;
    await expect(runApplicationUpdate("prepare", { ...f.input, targetBuild: "2", options: { ...f.input.options,
      async shutdownService() { stops++; }, async prepareShutdownService() { throw new PackagedServiceShutdownNotStartedError("chat"); },
    } })).rejects.toThrow();
    expect(stops).toBe(0);
    expect(f.runner.calls.some(call => call.startsWith("bootout") || call.startsWith("kickstart"))).toBe(false);
    expect(existsSync(macApplicationUpdatePath(f.paths))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shutdown refusal after a peer stopped restores that peer and keeps source version", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-refusal-"));
  try {
    const f = await fixture(root);
    f.runner.jobs.get("com.openai.chatgpt-tela.codex")!.running = true;
    await expect(runApplicationUpdate("prepare", { ...f.input, targetBuild: "2", options: { ...f.input.options,
      async shutdownService(service) {
        if (service === "codex") throw new PackagedServiceShutdownNotStartedError("codex");
        await f.input.options.shutdownService(service);
      },
    } })).rejects.toThrow();
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.gateway")?.running).toBe(true);
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.codex")?.running).toBe(true);
    expect(readOwnershipManifest(f.paths.installManifest)?.productVersion).toBe("1.0.0");
    expect(existsSync(macApplicationUpdatePath(f.paths))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an aborted Sparkle install restores the unchanged source without another shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-abort-"));
  try {
    const f = await fixture(root);
    await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" });
    f.runner.calls.length = 0;
    expect(await runApplicationUpdate("cancel", f.input)).toMatchObject({ ready: true, productVersion: "1.0.0" });
    expect(f.runner.calls.some(call => call.startsWith("bootout"))).toBe(false);
    expect(existsSync(macApplicationUpdatePath(f.paths))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("interrupted readiness resumes the target without re-stopping or restarting ready peers", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-resume-"));
  try {
    const f = await fixture(root);
    await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" });
    writeFileSync(packagedProductManifestPath(f.sourceRoot), JSON.stringify({ ...f.manifest, productVersion: "2.0.0" }));
    writeFileSync(join(f.sourceRoot, "Contents/Resources/build.txt"), "2");
    await expect(runApplicationUpdate("finish", { ...f.input, options: { ...f.input.options,
      async waitUntilReady(service) {
        if (service === "gateway") throw Error("readiness interrupted");
        await f.input.options.waitUntilReady(service);
      },
    } })).rejects.toThrow("readiness interrupted");
    expect(readMacApplicationUpdate(f.paths)).toMatchObject({ phase: "resuming", resumedServices: ["chat"] });
    f.runner.calls.length = 0;
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: true, restored: true });
    expect(f.runner.calls.some(call => call.startsWith("bootout") || call.startsWith("kickstart"))).toBe(false);
    expect(existsSync(macApplicationUpdatePath(f.paths))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
