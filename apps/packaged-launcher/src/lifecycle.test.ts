import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPackagedPayload,
  createEd25519PackagedPayloadSigner,
  resolveProductPaths,
  type ServiceRegistrationCommandResult,
  type ServiceRegistrationCommandRunner,
} from "@chatgpt-tela/product-lifecycle";
import { parsePackagedLifecycleCommand, runPackagedLifecycleCommand } from "./lifecycle";

class SystemdFixtureRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly enabled = new Set<string>();

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    if (command !== "systemctl") throw new Error(`unexpected command ${command}`);
    const unit = arguments_.at(-1) ?? "";
    if (arguments_.includes("show")) {
      const present = this.loaded.has(unit);
      return { exitCode: present ? 0 : 1, stdout: present ? "loaded\n" : "not-found\n", stderr: "" };
    }
    if (arguments_.includes("is-enabled")) {
      const present = this.enabled.has(unit);
      return { exitCode: present ? 0 : 1, stdout: present ? "enabled\n" : "disabled\n", stderr: "" };
    }
    if (arguments_.includes("daemon-reload")) return { exitCode: 0, stdout: "", stderr: "" };
    if (arguments_.includes("enable")) {
      this.loaded.add(unit);
      this.enabled.add(unit);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected systemctl args ${arguments_.join(" ")}`);
  }
}

function fixture(root: string) {
  const input = join(root, "input");
  const payload = join(root, "payload");
  const publicKeyPath = join(root, "release-public.pem");
  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });
  const keys = generateKeyPairSync("ed25519");
  writeFileSync(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  buildPackagedPayload({
    outputPath: payload,
    productVersion: "1.2.3",
    launcherSourcePath: join(input, "launcher"),
    services: {
      gateway: { executableSourcePath: join(input, "gateway") },
      chat: { executableSourcePath: join(input, "chat") },
      codex: { executableSourcePath: join(input, "codex") },
    },
    profileRuntime: {
      electronBundleSourcePath: join(input, "electron"),
      electronExecutableRelativePath: "bin/electron",
      entrypointSourcePath: join(input, "profile-runtime.cjs"),
    },
    signer: createEd25519PackagedPayloadSigner({ keyId: "release-fixture", privateKey: keys.privateKey }),
  });
  return { payload, publicKeyPath };
}

describe("packaged lifecycle CLI", () => {
  test("requires one explicit mutation mode and one external trusted public key", () => {
    expect(() => parsePackagedLifecycleCommand(["install", "--trusted-public-key", "release.pem"]))
      .toThrow("exactly one");
    expect(() => parsePackagedLifecycleCommand(["install", "--dry-run"]))
      .toThrow("trusted-public-key");
    expect(() => parsePackagedLifecycleCommand(["install", "--dry-run", "--apply", "--trusted-public-key", "release.pem"]))
      .toThrow("exactly one");
    expect(() => parsePackagedLifecycleCommand(["install", "--dry-run", "--trusted-public-key", "release.pem", "--future"]))
      .toThrow("unknown");
  });

  test("upgrade cancellation requires an explicit retained source package", () => {
    expect(() => parsePackagedLifecycleCommand(["cancel-upgrade", "--dry-run", "--trusted-public-key", "release.pem"]))
      .toThrow("requires --payload");
    expect(parsePackagedLifecycleCommand(["cancel-upgrade", "--dry-run", "--trusted-public-key", "release.pem", "--payload", "source-package"]))
      .toEqual({ command: "cancel-upgrade", mode: "dry-run", trustedPublicKeyPath: "release.pem", payloadSourcePath: "source-package", retainedRecoveryKeys: [] });
  });

  test("dry-runs then applies a signed install without trusting any key stored inside the payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-lifecycle-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload, publicKeyPath } = fixture(root);
    const runner = new SystemdFixtureRunner();
    const options = { defaultPayloadRoot: payload, platform: "linux" as const, home, environment: {}, runner };
    try {
      const dryRun = await runPackagedLifecycleCommand([
        "install", "--dry-run", "--trusted-public-key", publicKeyPath,
      ], options) as { plan: { createCount: number; preservedCount: number } };
      expect(dryRun.plan.createCount).toBeGreaterThan(0);
      expect(dryRun.plan.preservedCount).toBe(0);

      const applied = await runPackagedLifecycleCommand([
        "install", "--apply", "--trusted-public-key", publicKeyPath,
      ], options) as { apply: { failedCount: number }; verify: { ready: boolean } };
      expect(applied.apply.failedCount).toBe(0);
      expect(applied.verify.ready).toBe(true);
      expect(existsSync(resolveProductPaths({ platform: "linux", home, environment: {} }).installManifest)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a wrong external release key fails before install ownership state is created", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-lifecycle-untrusted-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload } = fixture(root);
    const wrongKeyPath = join(root, "wrong-public.pem");
    const wrongKeys = generateKeyPairSync("ed25519");
    writeFileSync(wrongKeyPath, wrongKeys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
    try {
      await expect(runPackagedLifecycleCommand([
        "install", "--apply", "--trusted-public-key", wrongKeyPath,
      ], { defaultPayloadRoot: payload, platform: "linux", home, environment: {}, runner: new SystemdFixtureRunner() }))
        .rejects.toThrow("signature verification failed");
      expect(existsSync(paths.installManifest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('upgrade recovery flags form one explicit signed-source contract',()=>{
 const flags=['upgrade','--apply','--trusted-public-key','target.pem','--recovery-payload','source','--recovery-public-key','source.pem'];
 expect(parsePackagedLifecycleCommand(flags)).toMatchObject({recoveryPayloadPath:'source',recoveryPublicKeyPath:'source.pem'});
 expect(()=>parsePackagedLifecycleCommand(flags.slice(0,-2))).toThrow('requires both');
 expect(()=>parsePackagedLifecycleCommand(['repair',...flags.slice(1)])).toThrow('requires both');
 expect(()=>parsePackagedLifecycleCommand([...flags,'--recovery-payload','other'])).toThrow('duplicate');
 const historical=[...flags,'--retained-recovery-key','old-source','old-source.pem','--retained-recovery-key','older-source','older-source.pem'];
 expect(parsePackagedLifecycleCommand(historical).retainedRecoveryKeys).toEqual([
  {keyId:'old-source',path:'old-source.pem'},{keyId:'older-source',path:'older-source.pem'},
 ]);
 expect(()=>parsePackagedLifecycleCommand([...historical,'--retained-recovery-key','old-source','other.pem'])).toThrow('duplicated');
 expect(()=>parsePackagedLifecycleCommand([...flags,'--retained-recovery-key','../unsafe','bad.pem'])).toThrow('invalid');
 expect(()=>parsePackagedLifecycleCommand(['install','--dry-run','--trusted-public-key','release.pem','--retained-recovery-key','older','older.pem'])).toThrow('require an explicit');
});
