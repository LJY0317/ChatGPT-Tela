import { expect, test } from "bun:test";
import { observeDiagnosticEvents, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyPackagedInstallFromPayload, macApplicationUpdatePath, packagedProductManifestPath,
  PackagedServiceShutdownNotStartedError, planPackagedInstallFromPayload, readMacApplicationUpdate,
  readOwnershipManifest, prepareOwnedDirectory, type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { LaunchdUpgradeRunner } from "../../../tests/support/launchd-upgrade-runner";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";
import { runApplicationUpdate } from "./application-update";
import { verifyInstalledPackage } from "./runtime";

async function fixture(root: string, application = true) {
  const path = (value: string) => application ? value : value.replace(/^Contents\//, "");
  const source = join(root, "source.app"), home = join(root, "home");
  const manifest = { version: 1, product: "chatgpt-tela", productVersion: "1.0.0",
    launcher: { executable: path("Contents/MacOS/chatgpt-tela") }, menuBar: { executable: path("Contents/MacOS/chatgpt-tela-menu-bar") },
    profileRuntime: { executable: path("Contents/Frameworks/Electron.app/Contents/MacOS/Electron"), entrypoint: path("Contents/Resources/runtime.js") },
    services: Object.fromEntries(["gateway", "chat", "codex"].map(id => [id, { executable: path(`Contents/Helpers/${id}`), arguments: [] }])) };
  const files = [manifest.launcher.executable, manifest.menuBar.executable, manifest.profileRuntime.executable,
    manifest.profileRuntime.entrypoint, ...Object.values(manifest.services).map(service => service.executable)];
  for (const file of files) { mkdirSync(dirname(join(source, file)), { recursive: true }); writeFileSync(join(source, file), "fixture", { mode: 0o755 }); }
  writeFileSync(join(source, path("Contents/Info.plist")), "fixture-info");
  writeFileSync(join(source, path("Contents/Resources/build.txt")), "1");
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
test("update phases retain failure evidence and reject changed payloads before stopping services", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-update-phase-cost-"));
  const events: StructuralDiagnosticEvent[] = [];
  const unobserve = observeDiagnosticEvents(event => { if (event.event === "chatgpt_tela_update") events.push(event); });
  try {
    const f = await fixture(root);
    await expect(runApplicationUpdate("prepare", { ...f.input, targetBuild: "2",
      verifySignature() { throw Error("private failure detail must not be logged"); },
    })).rejects.toThrow("private failure detail");
    expect(events.find(event => event.stage === "application_update_phase_failed" && event.phase === "signature"))
      .toMatchObject({ action: "prepare", outcome: "failed", duration_ms: expect.any(Number) });
    expect(f.runner.calls).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("private failure detail");
    const file = join(f.sourceRoot, "Contents/Resources/runtime.js");
    writeFileSync(file, "changed payload");
    await expect(runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" })).rejects.toThrow("ownership/receipt");
    expect(events.find(event => event.stage === "application_update_phase_failed" && event.phase === "payload_verification"))
      .toMatchObject({ action: "prepare", outcome: "failed", duration_ms: expect.any(Number) });
    expect(f.runner.calls).toEqual([]);
    writeFileSync(file, "fixture");
    events.length = 0;
    expect(await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" })).toMatchObject({ prepared: true });
    expect(events.filter(event => event.phase === "service_stop" && event.stage === "application_update_phase_finished")
      .map(event => event.service)).toEqual(["gateway", "chat"]);
    expect(events.at(-1)).toMatchObject({ phase: "transition", outcome: "completed", duration_ms: expect.any(Number) });
  } finally { unobserve?.(); rmSync(root, { recursive: true, force: true }); }
});

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
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ prepared: true, ready: false });
    f.runner.calls.length = 0;
    expect(await runApplicationUpdate("cancel", f.input)).toMatchObject({ ready: true, productVersion: "1.0.0" });
    expect(f.runner.calls.some(call => call.startsWith("bootout"))).toBe(false);
    expect(existsSync(macApplicationUpdatePath(f.paths))).toBe(false);
    f.runner.calls.length = 0;
    expect(await runApplicationUpdate("cancel", { ...f.input,
      verifySignature() { throw Error("no pending update must not reverify the app"); },
      readBuild() { throw Error("no pending update must not read the build"); },
    })).toMatchObject({ ready: true });
    expect(f.runner.calls).toEqual([]);
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


test("split-payload keep-data removal migrates to one app without a compatibility installer", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-migration-"));
  try {
    const old = await fixture(root, false);
    const owner = readOwnershipManifest(old.paths.installManifest)!;
    await prepareOwnedDirectory({ manifestPath: old.paths.installManifest, installId: owner.installId,
      productVersion: owner.productVersion, resource: { kind: "directory", id: "product-config",
        owner: "product", path: old.paths.configRoot, dataClass: "config" } });
    const saved = join(old.paths.configRoot, "saved-settings.json");
    writeFileSync(saved, '{"keep":"exact bytes"}');
    for (const job of old.runner.jobs.values()) job.running = false;
    const removed = await runProductUninstall({ ...old.input.options, mode: "apply", removeData: false,
      serviceRegistrationRunner: old.runner, executingBinaryPath: process.execPath });
    expect(removed).toMatchObject({ failedCount: 0, manifestRemoved: false });
    expect(existsSync(old.sourceRoot)).toBe(false);
    expect(old.runner.jobs.size).toBe(0);
    rmSync(join(root, "source.app"), { recursive: true });
    const next = await fixture(root);
    expect(next.sourceRoot).toBe(join(root, "home/Applications/ChatGPT Tela.app"));
    expect(readOwnershipManifest(next.paths.installManifest)?.installId).toBe(owner.installId);
    expect(readFileSync(saved, "utf8")).toBe('{"keep":"exact bytes"}');
    expect(existsSync(join(next.sourceRoot, ".chatgpt-tela-owner.json"))).toBe(false);
    expect(readOwnershipManifest(next.paths.installManifest)?.resources.filter(item => item.kind === "directory" && item.dataClass === "binary"))
      .toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const action of ['reinstall', 'remove'] as const) test(`manual app removal settles external ownership on ${action}`, async () => {
  const root=mkdtempSync(join(tmpdir(),'tela-removed-app-'));
  try {
    const f=await fixture(root), metadata=join(f.paths.stateRoot,'install/application');
    for(const job of f.runner.jobs.values())job.running=false;
    rmSync(f.sourceRoot,{recursive:true}); // Finder/Trash removes the app, not its external receipts.
    expect(existsSync(metadata)).toBe(true);
    if(action==='reinstall') {
      const options={...f.input.options,payloadSourcePath:join(root,'source.app')};
      const planned=await planPackagedInstallFromPayload(options);
      expect((await applyPackagedInstallFromPayload({...options,planned})).verify.ready).toBe(true);
      expect(existsSync(join(f.sourceRoot,'.chatgpt-tela-owner.json'))).toBe(false);
    } else {
      expect(await runProductUninstall({...f.input.options,mode:'apply',removeData:false,
        serviceRegistrationRunner:f.runner,executingBinaryPath:process.execPath})).toMatchObject({failedCount:0});
      expect(existsSync(metadata)).toBe(false);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
