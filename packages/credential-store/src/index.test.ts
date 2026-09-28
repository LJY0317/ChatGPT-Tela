import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialOwnershipManager,
  LinuxSecretServiceCredentialStore,
  MacOsKeychainCredentialStore,
  OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
  TELA_CREDENTIAL_SERVICE,
  WindowsDpapiCredentialStore,
  createPlatformCredentialStore,
  type CredentialCommandResult,
  type CredentialCommandRunner,
  type CredentialStore,
} from "./index";
import {
  createOwnershipManifest,
  readOwnershipManifest,
  writeOwnershipManifest,
} from "@chatgpt-tela/product-lifecycle";

class FixtureRunner implements CredentialCommandRunner {
  readonly calls: Array<{ command: string; arguments_: readonly string[]; input?: string }> = [];
  handler: (command: string, arguments_: readonly string[], input?: string) => CredentialCommandResult = () => ({
    exitCode: 0, stdout: "", stderr: "",
  });
  async run(command: string, arguments_: readonly string[], input?: string): Promise<CredentialCommandResult> {
    this.calls.push({ command, arguments_: [...arguments_], ...(input === undefined ? {} : { input }) });
    return this.handler(command, arguments_, input);
  }
}

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "macos-keychain" as const;
  readonly values = new Map<string, string>();
  failNextSet = false;
  async status() { return { kind: this.kind, available: true, detail: "fixture" } as const; }
  async get(id: string) { return this.values.get(id); }
  async set(id: string, secret: string) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("fixture write failure");
    }
    this.values.set(id, secret);
  }
  async delete(id: string) { return this.values.delete(id); }
}

describe("platform credential stores", () => {
  test("macOS Keychain write keeps the secret off argv and lookup/delete use exact service+account", async () => {
    const runner = new FixtureRunner();
    const secret = "sk-fixture-macos-secret-value-long-enough";
    runner.handler = (_command, args) => args[0] === "find-generic-password"
      ? { exitCode: 0, stdout: `${secret}\n`, stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
    const store = new MacOsKeychainCredentialStore(runner);
    await store.set(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, secret);
    expect(runner.calls[0]?.arguments_.join(" ")).not.toContain(secret);
    expect(runner.calls[0]?.input).toBe(`${secret}\n${secret}\n`);
    expect(runner.calls[0]?.arguments_).toEqual(expect.arrayContaining([
      "-a", OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "-s", TELA_CREDENTIAL_SERVICE, "-T", "/usr/bin/security", "-w",
    ]));
    expect(await store.get(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(secret);
    expect(await store.delete(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(true);
    expect(runner.calls.at(-1)?.arguments_).toEqual([
      "delete-generic-password", "-a", OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "-s", TELA_CREDENTIAL_SERVICE,
    ]);
  });

  test("macOS missing Keychain item is not an error", async () => {
    const runner = new FixtureRunner();
    runner.handler = () => ({ exitCode: 44, stdout: "", stderr: "not found" });
    const store = new MacOsKeychainCredentialStore(runner);
    expect(await store.get(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBeUndefined();
    expect(await store.delete(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(false);
  });

  test("Windows DPAPI persists only encrypted output and sends plaintext only over stdin", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-dpapi-store-"));
    const runner = new FixtureRunner();
    const secret = "sk-fixture-windows-secret-value-long-enough";
    runner.handler = (_command, args, input) => {
      const script = args.at(-1) ?? "";
      if (script.includes("ProtectedData]::Protect")) {
        expect(input).toBe(secret);
        return { exitCode: 0, stdout: "ZW5jcnlwdGVkLWZpeHR1cmU=", stderr: "" };
      }
      if (script.includes("ProtectedData]::Unprotect")) {
        expect(input).toBe("ZW5jcnlwdGVkLWZpeHR1cmU=");
        return { exitCode: 0, stdout: secret, stderr: "" };
      }
      return { exitCode: 0, stdout: "CurrentUser", stderr: "" };
    };
    try {
      const store = new WindowsDpapiCredentialStore({ root, runner });
      await store.set(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, secret);
      const files = (await import("node:fs")).readdirSync(root);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(root, files[0]!), "utf8")).toContain("ZW5jcnlwdGVkLWZpeHR1cmU=");
      expect(readFileSync(join(root, files[0]!), "utf8")).not.toContain(secret);
      expect(runner.calls.flatMap(call => call.arguments_).join(" ")).not.toContain(secret);
      expect(await store.get(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(secret);
      expect(await store.delete(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(true);
      expect(existsSync(join(root, files[0]!))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Linux Secret Service writes over stdin and stores no secret in attributes", async () => {
    const runner = new FixtureRunner();
    const secret = "sk-fixture-linux-secret-value-long-enough";
    runner.handler = (_command, args) => args[0] === "lookup"
      ? { exitCode: 0, stdout: `${secret}\n`, stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
    const store = new LinuxSecretServiceCredentialStore(runner);
    await store.set(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, secret);
    expect(runner.calls[0]?.input).toBe(`${secret}\n`);
    expect(runner.calls[0]?.arguments_.join(" ")).not.toContain(secret);
    expect(runner.calls[0]?.arguments_).toEqual(expect.arrayContaining([
      "service", TELA_CREDENTIAL_SERVICE, "credential", OPENAI_AGENT_API_KEY_CREDENTIAL_ID,
    ]));
    expect(await store.get(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(secret);
    expect(await store.delete(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe(true);
  });

  test("platform factory keeps platform-specific storage behind one interface", () => {
    const runner = new FixtureRunner();
    expect(createPlatformCredentialStore({ platform: "darwin", stateRoot: "/tmp/state", runner }).kind).toBe("macos-keychain");
    expect(createPlatformCredentialStore({ platform: "win32", stateRoot: "C:\\state", runner }).kind).toBe("windows-dpapi");
    expect(createPlatformCredentialStore({ platform: "linux", stateRoot: "/tmp/state", runner }).kind).toBe("linux-secret-service");
  });

  test("ownership manager never adopts or overwrites a pre-existing logical credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-credential-unowned-"));
    const manifestPath = join(root, "ownership-v1.json");
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    const store = new MemoryCredentialStore();
    store.values.set(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "foreign-secret-value-long-enough");
    const manager = new CredentialOwnershipManager({
      store,
      manifestPath,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
    });
    try {
      const resource = await manager.storeOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "new-secret-value-long-enough");
      expect(resource.storeKey).toMatch(/^tela\.[a-f0-9]{48}$/);
      expect(resource.storeKey).not.toBe(OPENAI_AGENT_API_KEY_CREDENTIAL_ID);
      expect(store.values.get(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe("foreign-secret-value-long-enough");
      expect(store.values.get(resource.storeKey)).toBe("new-secret-value-long-enough");
      expect(readOwnershipManifest(manifestPath)?.resources).toEqual([resource]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ownership manager records intent before write, proves ownership, and deletes only the exact owned credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-credential-owned-"));
    const manifestPath = join(root, "ownership-v1.json");
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    const store = new MemoryCredentialStore();
    const manager = new CredentialOwnershipManager({
      store,
      manifestPath,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
    });
    try {
      const resource = await manager.storeOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "owned-secret-value-long-enough");
      const afterWrite = readOwnershipManifest(manifestPath)!;
      expect(afterWrite.resources).toEqual([resource]);
      expect(await manager.observe(resource, afterWrite)).toBe("owned");
      expect(await manager.get(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).toBe("owned-secret-value-long-enough");
      expect((await manager.deleteOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID)).deleted).toBe(true);
      expect(store.values.has(resource.storeKey)).toBe(false);
      expect(readOwnershipManifest(manifestPath)?.resources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failed platform write preserves ownership intent so an exact retry can resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-credential-retry-"));
    const manifestPath = join(root, "ownership-v1.json");
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    const store = new MemoryCredentialStore();
    store.failNextSet = true;
    const manager = new CredentialOwnershipManager({
      store,
      manifestPath,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
    });
    try {
      await expect(manager.storeOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "retry-secret-value-long-enough"))
        .rejects.toThrow("fixture write failure");
      const intent = readOwnershipManifest(manifestPath)!;
      expect(intent.resources).toHaveLength(1);
      expect(await manager.observe(intent.resources[0]!, intent)).toBe("missing");
      await manager.storeOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "retry-secret-value-long-enough");
      expect(store.values.get((intent.resources[0] as Extract<(typeof intent.resources)[number], { kind: "credential" }>).storeKey))
        .toBe("retry-secret-value-long-enough");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-observation refuses deletion after the current manifest loses the credential record", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-credential-manifest-drift-"));
    const manifestPath = join(root, "ownership-v1.json");
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    const store = new MemoryCredentialStore();
    const manager = new CredentialOwnershipManager({
      store,
      manifestPath,
      installId: manifest.installId,
      productVersion: manifest.productVersion,
    });
    try {
      const resource = await manager.storeOwned(OPENAI_AGENT_API_KEY_CREDENTIAL_ID, "drift-secret-value-long-enough");
      const plannedManifest = readOwnershipManifest(manifestPath)!;
      writeOwnershipManifest(manifestPath, Object.freeze({ ...plannedManifest, resources: Object.freeze([]) }));
      expect(await manager.observe(resource, plannedManifest)).toBe("ownership-drift");
      expect((await manager.remove(resource, plannedManifest)).removed).toBe(false);
      expect(store.values.get(resource.storeKey)).toBe("drift-secret-value-long-enough");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
