import { afterAll, beforeAll, expect, test } from "bun:test";
import { observeDiagnosticEvents, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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

// Synthetic launchd tests need a synthetic uid where the host has no POSIX uid.
const needsFixtureUid = typeof process.getuid !== "function";
beforeAll(() => { if (needsFixtureUid) Object.defineProperty(process, "getuid", { value: () => 501, configurable: true }); });
afterAll(() => { if (needsFixtureUid) Reflect.deleteProperty(process, "getuid"); });

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

test("UI process loss after preparation leaves a handoff for explicit restart settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-process-exit-"));
  try {
    const f = await fixture(root);
    await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" });
    const afterPreparation = [...f.runner.calls];
    // All Swift callbacks and their installHandler belong to the exited UI process.
    // A newly launched UI can only ask the existing lifecycle to reconcile bytes.
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: false, prepared: true });
    expect(f.runner.calls).toEqual(afterPreparation);
    expect(readMacApplicationUpdate(f.paths)).toMatchObject({ phase: "ready", targetBuild: "2" });
    // Explicit cancellation after the replacement was not observed is the only
    // source restoration; the stale approval cannot install anything by itself.
    expect(await runApplicationUpdate("cancel", f.input)).toMatchObject({ ready: true, restored: true });
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
    const afterCancellation = [...f.runner.calls];
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: true });
    expect(f.runner.calls).toEqual(afterCancellation);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("killing the deferred wait worker leaves no install authority for the recreated process", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-wait-exit-"));
  const entered = join(root, "wait-entered"), effects = join(root, "effects");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let observer: ReturnType<typeof watch> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const f = await fixture(root);
    for (const job of f.runner.jobs.values()) job.running = true;
    const beforeManifest = readFileSync(f.paths.installManifest, "utf8");
    const code = [
      'import { appendFileSync, watch, writeFileSync } from "node:fs";',
      'import { runApplicationUpdate } from "./apps/packaged-launcher/src/application-update.ts";',
      'import { LaunchdUpgradeRunner } from "./tests/support/launchd-upgrade-runner.ts";',
      'const runner = new LaunchdUpgradeRunner();',
      'for (const [label, job] of JSON.parse(process.env.TELA_FIXTURE_JOBS!)) runner.jobs.set(label, job);',
      'const originalRun = runner.run.bind(runner);',
      'runner.run = async (command, args) => { if (args[0] !== "print") appendFileSync(process.env.TELA_FIXTURE_EFFECTS!, args[0] + "\\n"); return originalRun(command, args); };',
      'await runApplicationUpdate("wait", { payloadRoot: process.env.TELA_FIXTURE_APP!,',
      '  options: { home: process.env.TELA_FIXTURE_HOME!, platform: "darwin", environment: {}, runner },',
      '  waitForShutdownService: async (service) => {',
      '    writeFileSync(process.env.TELA_FIXTURE_ENTERED!, service);',
      '    await new Promise<void>(() => { watch(process.env.TELA_FIXTURE_HOME!, () => {}); });',
      '  }',
      '});',
    ].join("\n");
    const ready = new Promise<void>(resolve => {
      observer = watch(root, () => {
        if (existsSync(entered)) { observer?.close(); resolve(); }
      });
      if (existsSync(entered)) { observer.close(); resolve(); }
    });
    child = Bun.spawn([process.execPath, "-e", code], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
        TELA_FIXTURE_APP: f.sourceRoot, TELA_FIXTURE_HOME: join(root, "home"),
        TELA_FIXTURE_JOBS: JSON.stringify([...f.runner.jobs]),
        TELA_FIXTURE_ENTERED: entered, TELA_FIXTURE_EFFECTS: effects },
      stdout: "ignore", stderr: "ignore",
    });
    const running = child;
    deadline = setTimeout(() => running.kill("SIGKILL"), 15_000);
    await Promise.race([ready, running.exited.then(code => { throw Error(`observer exited before entering wait (${code})`); })]);
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
    expect(readFileSync(f.paths.installManifest, "utf8")).toBe(beforeManifest);
    expect(existsSync(effects)).toBe(false);
    expect([...f.runner.jobs.values()].every(job => job.running)).toBe(true);
    // Fresh UI startup has no stale application-update approval to settle.
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: true });
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
  } finally {
    if (deadline) clearTimeout(deadline);
    observer?.close();
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("UI-only exit closes wait owner pipe and settles its abandoned observer", async () => {
  // Disposable UI parent + read-only Tela wait worker. No Sparkle helper,
  // signed archive, real service, or installed consumer app is exercised.
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-ui-exit-"));
  const entered = join(root, "wait-entered");
  const done = join(root, "wait-settled"), pidFile = join(root, "observer-pid");
  const effects = join(root, "effects");
  let ui: ReturnType<typeof Bun.spawn> | undefined;
  let waitPid: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const observers = new Set<ReturnType<typeof watch>>();
  const whenCreated = (path: string) => new Promise<void>(resolve => {
    const observer = watch(root, () => {
      if (!existsSync(path)) return;
      observer.close();
      observers.delete(observer);
      resolve();
    });
    observers.add(observer);
    if (existsSync(path)) { observer.close(); observers.delete(observer); resolve(); }
  });
  try {
    const f = await fixture(root);
    for (const job of f.runner.jobs.values()) job.running = true;
    const beforeManifest = readFileSync(f.paths.installManifest, "utf8");
    const waitCode = [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      'import { runApplicationUpdate } from "./apps/packaged-launcher/src/application-update.ts";',
      'import { LaunchdUpgradeRunner } from "./tests/support/launchd-upgrade-runner.ts";',
      'const runner = new LaunchdUpgradeRunner();',
      'for (const [label, job] of JSON.parse(process.env.TELA_FIXTURE_JOBS!)) runner.jobs.set(label, job);',
      'const originalRun = runner.run.bind(runner);',
      'runner.run = async (command, args) => {',
      '  if (args[0] !== "print") appendFileSync(process.env.TELA_FIXTURE_EFFECTS!, args[0] + "\\n");',
      '  return originalRun(command, args);',
      '};',
      'const owner = new AbortController();',
      'process.stdin.once("end", () => owner.abort());',
      'process.stdin.resume();',
      'try { await runApplicationUpdate("wait", { payloadRoot: process.env.TELA_FIXTURE_APP!,',
      '  waitSignal: owner.signal,',
      '  options: { home: process.env.TELA_FIXTURE_HOME!, platform: "darwin", environment: {}, runner },',
      '  waitForShutdownService: async (service, signal) => {',
      '    if (service !== "codex") return;',
      '    writeFileSync(process.env.TELA_FIXTURE_ENTERED!, "waiting");',
      '    await new Promise<void>((_, reject) => {',
      '      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });',
      '    });',
      '  },',
      '}); } catch (error) { if (!owner.signal.aborted) throw error; }',
      'finally { process.stdin.pause(); writeFileSync(process.env.TELA_FIXTURE_DONE!, "owner-closed"); }',
    ].join("\n");
    const uiCode = [
      'import { spawn } from "node:child_process";',
      'import { watch, writeFileSync } from "node:fs";',
      'const worker = spawn(process.execPath, ["-e", process.env.TELA_FIXTURE_WAIT_CODE!],',
      '  { detached: true, stdio: ["pipe", "ignore", "ignore"], cwd: process.cwd(), env: process.env });',
      'if (!worker.pid) throw Error("fixture worker did not start");',
      'worker.unref();',
      'writeFileSync(process.env.TELA_FIXTURE_PID!, String(worker.pid));',
      'watch(process.env.TELA_FIXTURE_ROOT!, () => {});',
    ].join("\n");
    ui = Bun.spawn([process.execPath, "-e", uiCode], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
        TELA_FIXTURE_WAIT_CODE: waitCode,
        TELA_FIXTURE_ROOT: root, TELA_FIXTURE_APP: f.sourceRoot,
        TELA_FIXTURE_HOME: join(root, "home"),
        TELA_FIXTURE_JOBS: JSON.stringify([...f.runner.jobs]),
        TELA_FIXTURE_ENTERED: entered,
        TELA_FIXTURE_DONE: done, TELA_FIXTURE_PID: pidFile,
        TELA_FIXTURE_EFFECTS: effects },
      stdout: "ignore", stderr: "ignore",
    });
    const running = ui;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(Error("isolated UI exit fixture timed out")), 15_000);
    });
    await Promise.race([whenCreated(entered), running.exited.then(code => { throw Error(`UI fixture exited before waiting (${code})`); }), timeout]);
    waitPid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(waitPid) && waitPid > 0).toBe(true);
    ui.kill("SIGKILL"); // Only the disposable parent UI fixture, not its waiting child.
    expect(await ui.exited).not.toBe(0);
    await Promise.race([whenCreated(done), timeout]);
    expect(readFileSync(done, "utf8")).toBe("owner-closed");
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
    expect(readFileSync(f.paths.installManifest, "utf8")).toBe(beforeManifest);
    expect(existsSync(effects)).toBe(false);
    expect([...f.runner.jobs.values()].every(job => job.running)).toBe(true);
    // A newly constructed UI starts without any persisted "apply after work" callback.
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: true });
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
    expect(existsSync(effects)).toBe(false);
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const observer of observers) observer.close();
    if (ui && ui.exitCode === null) { ui.kill("SIGKILL"); await ui.exited; }
    if (waitPid && !existsSync(done)) {
      try { process.kill(waitPid, "SIGKILL"); } catch { /* worker already exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

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

test("recovery rechecks a previously resumed service after it exited", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-resume-exited-"));
  try {
    const f = await fixture(root);
    await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" });
    writeFileSync(packagedProductManifestPath(f.sourceRoot), JSON.stringify({ ...f.manifest, productVersion: "2.0.0" }));
    writeFileSync(join(f.sourceRoot, "Contents/Resources/build.txt"), "2");
    await expect(runApplicationUpdate("finish", { ...f.input, options: { ...f.input.options,
      async waitUntilReady(service) {
        if (service === "gateway") throw Error("gateway startup interrupted");
        await f.input.options.waitUntilReady(service);
      },
    } })).rejects.toThrow("gateway startup interrupted");
    expect(readMacApplicationUpdate(f.paths)?.resumedServices).toEqual(["chat"]);
    f.runner.jobs.get("com.openai.chatgpt-tela.chat")!.running = false;
    f.runner.calls.length = 0;
    expect(await runApplicationUpdate("finish", f.input)).toMatchObject({ ready: true, restored: true });
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.chat")?.running).toBe(true);
    expect(f.runner.calls.some(call => call.startsWith("kickstart") && call.includes("chat"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restart settles a persisted pending stop only from its exact OS state", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-sparkle-pending-stop-"));
  try {
    const f = await fixture(root);
    // Simulate losing the coordinator after gateway stopped and before the
    // stop request for chat received a result. Registrations remain loaded.
    const jobs = [...f.runner.jobs].map(([label, job]) => [label, { ...job }] as const);
    await runApplicationUpdate("prepare", { ...f.input, targetBuild: "2" });
    for (const [label, job] of jobs) f.runner.jobs.set(label, job);
    const path = macApplicationUpdatePath(f.paths);
    const ready = readMacApplicationUpdate(f.paths)!;
    writeFileSync(path, JSON.stringify({ ...ready, phase: "quiescing", pendingStop: "chat",
      stoppedServices: ["gateway"] }));
    f.runner.jobs.get("com.openai.chatgpt-tela.gateway")!.running = false;
    f.runner.jobs.get("com.openai.chatgpt-tela.chat")!.running = true;
    await expect(runApplicationUpdate("cancel", f.input)).rejects.toThrow("shutdown has not been settled");
    expect(readMacApplicationUpdate(f.paths)?.pendingStop).toBe("chat");
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.chat")?.running).toBe(true);
    f.runner.jobs.get("com.openai.chatgpt-tela.chat")!.running = false;
    expect(await runApplicationUpdate("cancel", f.input)).toMatchObject({ ready: true, restored: true });
    expect(f.runner.jobs.get("com.openai.chatgpt-tela.chat")?.running).toBe(true);
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
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


test("waiting for work creates no transition, stops nothing and retains ordinary install admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-update-idle-"));
  try {
    const f = await fixture(root);
    for (const job of f.runner.jobs.values()) job.running = true;
    const ownership = readFileSync(f.paths.installManifest, "utf8");
    const waited: string[] = [];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const wait = runApplicationUpdate("wait", { ...f.input, async waitForShutdownService(service) {
      waited.push(service);
      if (service === "codex") { entered(); await gate; }
    } });
    await admission;
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
    expect(readFileSync(f.paths.installManifest, "utf8")).toBe(ownership);
    expect([...f.runner.jobs.values()].every(job => job.running)).toBe(true);
    release();
    expect(await wait).toEqual({ ready: true });
    expect(waited).toEqual(["codex", "chat", "gateway"]);
    expect(readMacApplicationUpdate(f.paths)).toBeUndefined();
    await expect(runApplicationUpdate("prepare", { ...f.input, targetBuild: "2", options: { ...f.input.options,
      async prepareShutdownService(service) { throw new PackagedServiceShutdownNotStartedError(service); },
    } })).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect([...f.runner.jobs.values()].every(job => job.running)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
