import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  readOwnershipManifest,
  registerOwnedResource,
  unregisterOwnedResource,
  type OwnedResource,
  type OwnershipManifest,
  type OwnershipObservation,
} from "@chatgpt-tela/product-lifecycle";

export const TELA_CREDENTIAL_SERVICE = "com.openai.chatgpt-tela";
export const OPENAI_AGENT_API_KEY_CREDENTIAL_ID = "agent.openai-responses.api-key";

const MAX_SECRET_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export interface CredentialStoreStatus {
  readonly kind: "macos-keychain" | "windows-dpapi" | "linux-secret-service";
  readonly available: boolean;
  readonly detail: string;
}

export interface CredentialStore {
  readonly kind: CredentialStoreStatus["kind"];
  status(): Promise<CredentialStoreStatus>;
  get(id: string): Promise<string | undefined>;
  set(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface CredentialCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CredentialCommandRunner {
  run(command: string, arguments_: readonly string[], input?: string): Promise<CredentialCommandResult>;
}

export class SystemCredentialCommandRunner implements CredentialCommandRunner {
  readonly #timeoutMs: number;

  constructor(timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error("credential command timeout is invalid");
    }
    this.#timeoutMs = timeoutMs;
  }

  async run(command: string, arguments_: readonly string[], input?: string): Promise<CredentialCommandResult> {
    return await new Promise<CredentialCommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...arguments_], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.#timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, "utf8");
        if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          return;
        }
        stderr += chunk;
      });
      child.once("error", error => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once("exit", code => {
        clearTimeout(timer);
        if (timedOut) {
          rejectPromise(new Error("credential command timed out"));
          return;
        }
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES || stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
          rejectPromise(new Error("credential command output exceeded the bounded limit"));
          return;
        }
        resolvePromise(Object.freeze({ exitCode: code ?? 1, stdout, stderr }));
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }
}

function credentialId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)) throw new Error("Tela credential id is invalid");
  return normalized;
}

function secretValue(value: string): string {
  if (!value || value.includes("\u0000") || /[\r\n]/.test(value)) throw new Error("Tela credential secret is invalid");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error("Tela credential secret is too large");
  return value;
}

function commandDetail(result: CredentialCommandResult, fallback: string): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${fallback}: ${detail.slice(0, 240)}` : fallback;
}

export class MacOsKeychainCredentialStore implements CredentialStore {
  readonly kind = "macos-keychain" as const;
  readonly #runner: CredentialCommandRunner;

  constructor(runner: CredentialCommandRunner = new SystemCredentialCommandRunner()) {
    this.#runner = runner;
  }

  async status(): Promise<CredentialStoreStatus> {
    try {
      const result = await this.#runner.run("/usr/bin/security", ["list-keychains", "-d", "user"]);
      return Object.freeze({
        kind: this.kind,
        available: result.exitCode === 0,
        detail: result.exitCode === 0 ? "user Keychain is available" : "user Keychain is unavailable",
      });
    } catch {
      return Object.freeze({ kind: this.kind, available: false, detail: "macOS security utility is unavailable" });
    }
  }

  async get(idValue: string): Promise<string | undefined> {
    const id = credentialId(idValue);
    const result = await this.#runner.run("/usr/bin/security", [
      "find-generic-password", "-a", id, "-s", TELA_CREDENTIAL_SERVICE, "-w",
    ]);
    if (result.exitCode === 44) return undefined;
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "macOS Keychain lookup failed"));
    const secret = result.stdout.replace(/[\r\n]+$/, "");
    return secret ? secretValue(secret) : undefined;
  }

  async set(idValue: string, secretValueInput: string): Promise<void> {
    const id = credentialId(idValue);
    const secret = secretValue(secretValueInput);
    const result = await this.#runner.run("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-a", id,
      "-s", TELA_CREDENTIAL_SERVICE,
      "-l", `ChatGPT Tela ${id}`,
      "-T", "/usr/bin/security",
      "-w",
    ], `${secret}\n${secret}\n`);
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "macOS Keychain write failed"));
  }

  async delete(idValue: string): Promise<boolean> {
    const id = credentialId(idValue);
    const result = await this.#runner.run("/usr/bin/security", [
      "delete-generic-password", "-a", id, "-s", TELA_CREDENTIAL_SERVICE,
    ]);
    if (result.exitCode === 44) return false;
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "macOS Keychain delete failed"));
    return true;
  }
}

function dpapiFileName(id: string): string {
  return `${createHash("sha256").update(id, "utf8").digest("hex")}.credential`;
}

const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$plain=[Console]::In.ReadToEnd();",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain);",
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser;",
  "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope);",
  "[Console]::Out.Write([Convert]::ToBase64String($protected));",
].join(" ");

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$encoded=[Console]::In.ReadToEnd();",
  "$bytes=[Convert]::FromBase64String($encoded);",
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser;",
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope);",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain));",
].join(" ");

export class WindowsDpapiCredentialStore implements CredentialStore {
  readonly kind = "windows-dpapi" as const;
  readonly #runner: CredentialCommandRunner;
  readonly #root: string;

  constructor(input: { readonly root: string; readonly runner?: CredentialCommandRunner }) {
    this.#root = input.root;
    this.#runner = input.runner ?? new SystemCredentialCommandRunner();
  }

  #path(id: string): string {
    return join(this.#root, dpapiFileName(credentialId(id)));
  }

  async status(): Promise<CredentialStoreStatus> {
    try {
      const result = await this.#runner.run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::Out.Write([Security.Cryptography.DataProtectionScope]::CurrentUser.ToString())",
      ]);
      return Object.freeze({
        kind: this.kind,
        available: result.exitCode === 0 && result.stdout.trim() === "CurrentUser",
        detail: result.exitCode === 0 ? "CurrentUser DPAPI is available" : "CurrentUser DPAPI is unavailable",
      });
    } catch {
      return Object.freeze({ kind: this.kind, available: false, detail: "Windows PowerShell/DPAPI is unavailable" });
    }
  }

  async get(idValue: string): Promise<string | undefined> {
    const path = this.#path(idValue);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Windows credential blob path is unsafe or replaced");
    const encrypted = readFileSync(path, "utf8").trim();
    if (!encrypted) return undefined;
    const result = await this.#runner.run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT_SCRIPT,
    ], encrypted);
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "Windows DPAPI credential read failed"));
    return secretValue(result.stdout);
  }

  async set(idValue: string, secretValueInput: string): Promise<void> {
    const id = credentialId(idValue);
    const secret = secretValue(secretValueInput);
    const result = await this.#runner.run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT_SCRIPT,
    ], secret);
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "Windows DPAPI credential write failed"));
    const encrypted = result.stdout.trim();
    if (!encrypted || encrypted.includes(secret)) throw new Error("Windows DPAPI returned an invalid credential blob");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const path = this.#path(id);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Windows credential blob path is unsafe or replaced");
    }
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${encrypted}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions. */ }
    renameSync(temporary, path);
  }

  async delete(idValue: string): Promise<boolean> {
    const path = this.#path(idValue);
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Windows credential blob path is unsafe or replaced");
    rmSync(path, { force: false });
    return true;
  }
}

export class LinuxSecretServiceCredentialStore implements CredentialStore {
  readonly kind = "linux-secret-service" as const;
  readonly #runner: CredentialCommandRunner;

  constructor(runner: CredentialCommandRunner = new SystemCredentialCommandRunner()) {
    this.#runner = runner;
  }

  async status(): Promise<CredentialStoreStatus> {
    try {
      const result = await this.#runner.run("secret-tool", ["search", "--all", "service", TELA_CREDENTIAL_SERVICE]);
      return Object.freeze({
        kind: this.kind,
        available: result.exitCode === 0 || result.exitCode === 1,
        detail: result.exitCode === 0 || result.exitCode === 1
          ? "Secret Service is available"
          : "Secret Service is unavailable",
      });
    } catch {
      return Object.freeze({ kind: this.kind, available: false, detail: "secret-tool is unavailable" });
    }
  }

  async get(idValue: string): Promise<string | undefined> {
    const id = credentialId(idValue);
    const result = await this.#runner.run("secret-tool", [
      "lookup", "service", TELA_CREDENTIAL_SERVICE, "credential", id,
    ]);
    if (result.exitCode === 1 && !result.stdout.trim()) return undefined;
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "Linux Secret Service lookup failed"));
    const secret = result.stdout.replace(/[\r\n]+$/, "");
    return secret ? secretValue(secret) : undefined;
  }

  async set(idValue: string, secretValueInput: string): Promise<void> {
    const id = credentialId(idValue);
    const secret = secretValue(secretValueInput);
    const result = await this.#runner.run("secret-tool", [
      "store", `--label=ChatGPT Tela ${id}`,
      "service", TELA_CREDENTIAL_SERVICE,
      "credential", id,
    ], `${secret}\n`);
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "Linux Secret Service write failed"));
  }

  async delete(idValue: string): Promise<boolean> {
    const id = credentialId(idValue);
    const existing = await this.get(id);
    if (existing === undefined) return false;
    const result = await this.#runner.run("secret-tool", [
      "clear", "service", TELA_CREDENTIAL_SERVICE, "credential", id,
    ]);
    if (result.exitCode !== 0) throw new Error(commandDetail(result, "Linux Secret Service delete failed"));
    return true;
  }
}

export function createPlatformCredentialStore(input: {
  readonly platform?: NodeJS.Platform;
  readonly stateRoot: string;
  readonly runner?: CredentialCommandRunner;
}): CredentialStore {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") return new MacOsKeychainCredentialStore(input.runner);
  if (platform === "win32") {
    return new WindowsDpapiCredentialStore({
      root: join(input.stateRoot, "credentials", "windows-dpapi-v1"),
      ...(input.runner ? { runner: input.runner } : {}),
    });
  }
  if (platform === "linux") return new LinuxSecretServiceCredentialStore(input.runner);
  throw new Error(`Tela credential store is unsupported on ${platform}`);
}

export type CredentialOwnedResource = Extract<OwnedResource, { readonly kind: "credential" }>;

function physicalStoreKey(): string {
  return `tela.${randomBytes(24).toString("hex")}`;
}

function resourceId(id: string): string {
  return `credential:${id}`;
}

export function credentialOwnedResource(
  store: CredentialStore,
  idValue: string,
  storeKey: string,
): CredentialOwnedResource {
  const id = credentialId(idValue);
  if (!/^tela\.[a-f0-9]{48}$/.test(storeKey)) throw new Error("Tela credential physical store key is invalid");
  return Object.freeze({
    kind: "credential" as const,
    id: resourceId(id),
    owner: "chat" as const,
    credentialId: id,
    storeKind: store.kind,
    storeKey,
  });
}

function sameResource(left: OwnedResource, right: OwnedResource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CredentialOwnershipManager {
  readonly #store: CredentialStore;
  readonly #manifestPath: string;
  readonly #installId: string;
  readonly #productVersion: string;

  constructor(input: {
    readonly store: CredentialStore;
    readonly manifestPath: string;
    readonly installId: string;
    readonly productVersion: string;
  }) {
    this.#store = input.store;
    this.#manifestPath = input.manifestPath;
    this.#installId = input.installId;
    this.#productVersion = input.productVersion;
  }

  #recorded(idValue: string): CredentialOwnedResource | undefined {
    const id = credentialId(idValue);
    const manifest = readOwnershipManifest(this.#manifestPath);
    if (!manifest) return undefined;
    if (manifest.installId !== this.#installId) throw new Error("credential manifest belongs to a different Tela install instance");
    const current = manifest.resources.find(candidate => candidate.id === resourceId(id));
    if (!current) return undefined;
    if (current.kind !== "credential"
      || current.owner !== "chat"
      || current.credentialId !== id
      || current.storeKind !== this.#store.kind) {
      throw new Error("credential resource id is already registered with different ownership");
    }
    return current;
  }

  resource(idValue: string): CredentialOwnedResource | undefined {
    return this.#recorded(idValue);
  }

  async get(idValue: string): Promise<string | undefined> {
    const resource = this.#recorded(idValue);
    if (!resource) return undefined;
    return this.#store.get(resource.storeKey);
  }

  async observe(resource: OwnedResource, manifest: OwnershipManifest): Promise<OwnershipObservation> {
    if (resource.kind !== "credential") return "unknown";
    if (manifest.installId !== this.#installId) return "ownership-drift";
    if (resource.storeKind !== this.#store.kind) return "ownership-drift";
    const recorded = manifest.resources.find(candidate => candidate.id === resource.id);
    if (!recorded || !sameResource(recorded, resource)) return "ownership-drift";
    let current: CredentialOwnedResource | undefined;
    try { current = this.#recorded(resource.credentialId); }
    catch { return "ownership-drift"; }
    if (!current || !sameResource(current, resource)) return "ownership-drift";
    try {
      return await this.#store.get(resource.storeKey) === undefined ? "missing" : "owned";
    } catch {
      return "unknown";
    }
  }

  async storeOwned(idValue: string, secretValueInput: string): Promise<CredentialOwnedResource> {
    const id = credentialId(idValue);
    let resource = this.#recorded(id);
    if (!resource) {
      let storeKey = physicalStoreKey();
      for (let attempts = 0; attempts < 4 && await this.#store.get(storeKey) !== undefined; attempts += 1) {
        storeKey = physicalStoreKey();
      }
      if (await this.#store.get(storeKey) !== undefined) {
        throw new Error("could not allocate an unused Tela credential store key");
      }
      resource = credentialOwnedResource(this.#store, id, storeKey);
      await registerOwnedResource({
        path: this.#manifestPath,
        installId: this.#installId,
        productVersion: this.#productVersion,
        resource,
      });
    }
    await this.#store.set(resource.storeKey, secretValue(secretValueInput));
    const verified = await this.#store.get(resource.storeKey);
    if (verified !== secretValueInput) {
      throw new Error("platform credential write could not be verified; ownership intent was preserved for recovery");
    }
    return resource;
  }

  async remove(resource: OwnedResource, manifest: OwnershipManifest): Promise<{ readonly removed: boolean; readonly detail: string }> {
    if (resource.kind !== "credential") return Object.freeze({ removed: false, detail: "resource is not a credential" });
    const observation = await this.observe(resource, manifest);
    if (observation === "missing") {
      return Object.freeze({ removed: true, detail: "owned credential is already absent" });
    }
    if (observation !== "owned") {
      return Object.freeze({ removed: false, detail: "credential ownership could not be re-proven" });
    }
    await this.#store.delete(resource.storeKey);
    if (await this.#store.get(resource.storeKey) !== undefined) {
      throw new Error("platform credential remained after delete");
    }
    return Object.freeze({ removed: true, detail: "exact owned platform credential removed" });
  }

  async deleteOwned(idValue: string): Promise<{ readonly deleted: boolean; readonly detail: string }> {
    const manifest = readOwnershipManifest(this.#manifestPath);
    if (!manifest || manifest.installId !== this.#installId) {
      return Object.freeze({ deleted: false, detail: "credential is not owned by this Tela install" });
    }
    const id = credentialId(idValue);
    const recorded = manifest.resources.find(candidate => candidate.id === resourceId(id));
    if (!recorded) {
      return Object.freeze({ deleted: false, detail: "credential is not recorded by this Tela install" });
    }
    if (recorded.kind !== "credential" || recorded.credentialId !== id || recorded.storeKind !== this.#store.kind) {
      throw new Error("credential ownership record drifted");
    }
    const removed = await this.remove(recorded, manifest);
    if (!removed.removed) return Object.freeze({ deleted: false, detail: removed.detail });
    await unregisterOwnedResource({
      path: this.#manifestPath,
      installId: this.#installId,
      productVersion: this.#productVersion,
      resourceId: recorded.id,
    });
    return Object.freeze({ deleted: true, detail: removed.detail });
  }
}
