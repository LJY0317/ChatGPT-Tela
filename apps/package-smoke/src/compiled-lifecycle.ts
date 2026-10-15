import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackagedPayload, createEd25519PackagedPayloadSigner, CURRENT_PACKAGED_LIFECYCLE,
  readOwnershipManifest, readPackagedProductManifest, resolveProductPaths,
  type ServiceRegistrationCommandRunner, type TelaServiceId } from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";
import { runPackagedLifecycleCommand } from "../../packaged-launcher/src/lifecycle";

/** Compiled production lifecycle with fake registration; never launch a real service/profile. */
class Registrations implements ServiceRegistrationCommandRunner {
  readonly enabled = new Set<string>();
  readonly running = new Set<string>();
  async run(command: string, args: readonly string[]) {
    assert.equal(command, "systemctl", "fixture prohibits external platform commands");
    const unit = args.at(-1)!;
    const result = (stdout = "", exitCode = 0) => ({ stdout, exitCode, stderr: "" });
    if (args.includes("show")) return result(this.enabled.has(unit) ? "loaded\n" : "not-found\n", this.enabled.has(unit) ? 0 : 1);
    if (args.includes("is-enabled")) return result(this.enabled.has(unit) ? "enabled\n" : "disabled\n", this.enabled.has(unit) ? 0 : 1);
    if (args.includes("is-active")) return result(this.running.has(unit) ? "active\n" : "inactive\n", this.running.has(unit) ? 0 : 3);
    if (args.includes("daemon-reload")) return result();
    if (args.includes("enable")) { this.enabled.add(unit); return result(); }
    if (args.includes("disable")) { this.enabled.delete(unit); return result(); }
    if (args.includes("start")) { this.running.add(unit); return result(); }
    if (args.includes("stop")) { this.running.delete(unit); return result(); }
    throw new Error("fixture refused an unknown platform operation");
  }
}

const root = mkdtempSync(join(tmpdir(), "tela-compiled-lifecycle-"));
process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT = "test";
process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = join(root, "fixture.diagnostics.jsonl");
try {
  const home = join(root, "home"), inputs = join(root, "inputs"), electron = join(inputs, "electron");
  mkdirSync(home); mkdirSync(electron, { recursive: true });
  const original = join(home, "external-project.txt"); writeFileSync(original, "synthetic external data");
  writeFileSync(join(electron, "electron"), "never executed", { mode: 0o755 });
  writeFileSync(join(inputs, "runtime.cjs"), "module.exports={};");
  const keys = generateKeyPairSync("ed25519"), key = join(root, "trusted.pem");
  writeFileSync(key, keys.publicKey.export({ type: "spki", format: "pem" }));
  const payload = (version: string) => {
    writeFileSync(join(inputs, "launcher"), version, { mode: 0o755 });
    const outputPath = join(root, version);
    buildPackagedPayload({ outputPath, productVersion: version, lifecycle: CURRENT_PACKAGED_LIFECYCLE,
      launcherSourcePath: join(inputs, "launcher"),
      services: { chat: { executableSourcePath: join(inputs, "launcher") }, codex: { executableSourcePath: join(inputs, "launcher") }, gateway: { executableSourcePath: join(inputs, "launcher") } },
      profileRuntime: { electronBundleSourcePath: electron, electronExecutableRelativePath: "electron",
        entrypointSourcePath: join(inputs, "runtime.cjs"), setupEntrypointSourcePath: join(inputs, "runtime.cjs") },
      signer: createEd25519PackagedPayloadSigner({ keyId: "compiled-fixture", privateKey: keys.privateKey }) });
    return outputPath;
  };
  const source = payload("1.0.0"), target = payload("2.0.0"), runner = new Registrations();
  let failStop = true;
  const options = { platform: "linux" as const, home, environment: {}, runner,
    shutdownService: async (service: TelaServiceId) => {
      runner.running.delete(`chatgpt-tela-${service}.service`);
      if (failStop && service === "codex") throw new Error("synthetic shutdown failure");
    } };
  const paths = resolveProductPaths(options);
  const run = (command: string, path: string) => runPackagedLifecycleCommand(
    [command, "--apply", "--trusted-public-key", key], { ...options, defaultPayloadRoot: path });
  await run("install", source);
  for (const service of ["chat", "codex", "gateway"]) runner.running.add(`chatgpt-tela-${service}.service`);
  rmSync(source, { recursive: true });
  await assert.rejects(() => run("upgrade", target), (error: unknown) => (error as { recoveryState?: string }).recoveryState === "source-restored");
  assert.equal(readOwnershipManifest(paths.installManifest)?.productVersion, "1.0.0");
  assert.equal(runner.running.size, 3);
  failStop = false;
  await run("upgrade", target);
  assert.equal(readOwnershipManifest(paths.installManifest)?.productVersion, "2.0.0");
  const manifest = readPackagedProductManifest(paths.binaryRoot);
  assert.equal(readFileSync(join(paths.binaryRoot, manifest.launcher!.executable), "utf8"), "2.0.0");
  runner.running.clear(); // Fixture services are dormant for removal; no live processes exist.
  const removed = await runProductUninstall({ ...options, mode: "apply", removeData: true, serviceRegistrationRunner: runner });
  assert.equal(removed.manifestRemoved, true);
  assert.equal(existsSync(paths.installManifest), false);
  assert.equal(existsSync(join(paths.stateRoot, "install", "coordinator")), false);
  assert.equal(readFileSync(original, "utf8"), "synthetic external data");
  console.log(JSON.stringify({ compiledLifecycleVerified: true, sourceRestored: true, upgradeVerified: true,
    completeRemovalVerified: true, externalFixturePreserved: true, realServiceOrProfileActions: 0 }));
} finally { rmSync(root, { recursive: true, force: true }); }
