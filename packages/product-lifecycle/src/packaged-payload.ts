import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepareOwnedDirectory } from "./directory-registration";
import {
  OWNERSHIP_MARKER,
  readOwnershipManifest,
  type OwnedResource,
  type OwnershipManifest,
} from "./ownership";
import { FilesystemOwnershipObserver, type OwnershipObservation, type UninstallObserver } from "./uninstall";

export const PACKAGED_PAYLOAD_RECEIPT = ".chatgpt-tela-payload-v1.json";
export const PACKAGED_PAYLOAD_SIGNATURE = "chatgpt-tela-package-signature-v1.json";

type DirectoryResource = Extract<OwnedResource, { readonly kind: "directory" }>;

export interface PackagedPayloadSpec {
  readonly sourcePath: string;
  readonly resource: DirectoryResource;
  readonly productVersion: string;
}

export interface PackagedPayloadReceipt {
  readonly version: 1;
  readonly installId: string;
  readonly resourceId: string;
  readonly productVersion: string;
  readonly payloadFingerprint: string;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function assertPayloadRoot(path: string): void {
  if (!existsSync(path)) throw new Error(`packaged payload source is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("packaged payload source must be a real directory");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeSymlinkTarget(root: string, path: string, relativePath: string): string {
  const target = readlinkSync(path);
  if (isAbsolute(target)) throw new Error(`packaged payload symlink is absolute: ${relativePath}`);
  const lexical = resolve(dirname(path), target);
  const lexicalRoot = resolve(root);
  if (!inside(lexicalRoot, lexical)) throw new Error(`packaged payload symlink escapes its root: ${relativePath}`);
  let finalTarget: string;
  try { finalTarget = realpathSync(path); }
  catch (error) { throw new Error(`packaged payload symlink is broken or cyclic: ${relativePath}`, { cause: error }); }
  if (!inside(realpathSync(root), finalTarget)) throw new Error(`packaged payload symlink resolves outside its root: ${relativePath}`);
  return target;
}

function walkPayload(root: string, reservedPolicy: "reject" | "skip" = "reject"): readonly {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly linkTarget?: string;
}[] {
  assertPayloadRoot(root);
  const items: Array<{
    readonly relativePath: string;
    readonly absolutePath: string;
    readonly kind: "directory" | "file" | "symlink";
    readonly mode: number;
    readonly linkTarget?: string;
  }> = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = portableRelative(root, absolutePath);
      if (relativePath === OWNERSHIP_MARKER || relativePath === PACKAGED_PAYLOAD_RECEIPT) {
        if (reservedPolicy === "skip") continue;
        throw new Error(`packaged payload source uses reserved path: ${relativePath}`);
      }
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        items.push(Object.freeze({ relativePath, absolutePath, kind: "symlink", mode: 0,
          linkTarget: safeSymlinkTarget(root, absolutePath, relativePath) }));
        continue;
      }
      if (stat.isDirectory()) {
        items.push(Object.freeze({ relativePath, absolutePath, kind: "directory", mode: stat.mode & 0o777 }));
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`packaged payload contains a non-regular entry: ${relativePath}`);
      items.push(Object.freeze({ relativePath, absolutePath, kind: "file", mode: stat.mode & 0o777 }));
    }
  };
  visit(root);
  return Object.freeze(items);
}

export function packagedPayloadFingerprint(root: string, input: { readonly target?: boolean } = {}): string {
  const hash = createHash("sha256");
  for (const item of walkPayload(root, input.target === true ? "skip" : "reject")) {
    if (item.relativePath === PACKAGED_PAYLOAD_SIGNATURE) continue;
    hash.update(item.kind === "directory" ? "d\0" : item.kind === "file" ? "f\0" : "l\0");
    hash.update(item.relativePath);
    hash.update("\0");
    hash.update(String(item.mode & 0o111));
    hash.update("\0");
    if (item.kind === "file") hash.update(createHash("sha256").update(readFileSync(item.absolutePath)).digest());
    if (item.kind === "symlink") hash.update(item.linkTarget!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function receiptPath(resource: DirectoryResource): string {
  return join(resource.path, PACKAGED_PAYLOAD_RECEIPT);
}

function parseReceipt(value: unknown): PackagedPayloadReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged payload receipt is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("packaged payload receipt version is unsupported");
  for (const field of ["installId", "resourceId", "productVersion", "payloadFingerprint"] as const) {
    if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(`packaged payload receipt ${field} is invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(item.payloadFingerprint as string)) throw new Error("packaged payload receipt fingerprint is invalid");
  return Object.freeze({
    version: 1,
    installId: item.installId as string,
    resourceId: item.resourceId as string,
    productVersion: item.productVersion as string,
    payloadFingerprint: item.payloadFingerprint as string,
  });
}

export function readPackagedPayloadReceipt(resource: DirectoryResource): PackagedPayloadReceipt | undefined {
  const path = receiptPath(resource);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packaged payload receipt path is unsafe or replaced");
  return parseReceipt(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export type InstalledPackagedPayloadObservation =
  | { readonly state: "missing" | "ownership-drift" | "unsafe" }
  | { readonly state: "owned"; readonly receipt: PackagedPayloadReceipt };

export type PackagedPayloadRepairObservation = OwnershipObservation | "repairable";

export function observeInstalledPackagedPayload(
  resource: DirectoryResource,
  manifest: OwnershipManifest,
): InstalledPackagedPayloadObservation {
  const filesystem = new FilesystemOwnershipObserver();
  const ownership = filesystem.observe(resource, manifest);
  if (ownership !== "owned") {
    const state = ownership === "missing" ? "missing" : ownership === "unsafe" ? "unsafe" : "ownership-drift";
    return Object.freeze({ state });
  }
  const recorded = manifest.resources.find(candidate => candidate.id === resource.id);
  if (!recorded || JSON.stringify(recorded) !== JSON.stringify(resource)) return Object.freeze({ state: "ownership-drift" });
  let receipt: PackagedPayloadReceipt | undefined;
  try { receipt = readPackagedPayloadReceipt(resource); }
  catch { return Object.freeze({ state: "ownership-drift" }); }
  if (!receipt) return Object.freeze({ state: "missing" });
  if (receipt.installId !== manifest.installId || receipt.resourceId !== resource.id) {
    return Object.freeze({ state: "ownership-drift" });
  }
  try {
    if (packagedPayloadFingerprint(resource.path, { target: true }) !== receipt.payloadFingerprint) {
      return Object.freeze({ state: "ownership-drift" });
    }
  } catch {
    return Object.freeze({ state: "unsafe" });
  }
  return Object.freeze({ state: "owned", receipt });
}

export function beginPackagedPayloadReplacement(input: {
  readonly resource: DirectoryResource;
  readonly manifest: OwnershipManifest;
  readonly expected: PackagedPayloadReceipt;
}): void {
  const current = observeInstalledPackagedPayload(input.resource, input.manifest);
  if (current.state !== "owned" || JSON.stringify(current.receipt) !== JSON.stringify(input.expected)) {
    throw new Error("installed packaged payload no longer matches the planned upgrade source");
  }
  rmSync(receiptPath(input.resource), { force: false });
}

function writeReceipt(resource: DirectoryResource, receipt: PackagedPayloadReceipt): void {
  const path = receiptPath(resource);
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

function clearIncompletePayload(resource: DirectoryResource): void {
  for (const entry of readdirSync(resource.path, { withFileTypes: true })) {
    if (entry.name === OWNERSHIP_MARKER) continue;
    rmSync(join(resource.path, entry.name), { recursive: true, force: true });
  }
}

function copyPayload(source: string, target: string): void {
  for (const item of walkPayload(source)) {
    const destination = join(target, ...item.relativePath.split("/"));
    if (item.kind === "directory") {
      mkdirSync(destination, { recursive: false, mode: item.mode || 0o700 });
      try { chmodSync(destination, item.mode); } catch { /* Windows ACLs own permissions there. */ }
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (item.kind === "symlink") {
      symlinkSync(item.linkTarget!, destination);
      continue;
    }
    copyFileSync(item.absolutePath, destination);
    try { chmodSync(destination, item.mode); } catch { /* Windows ACLs own permissions there. */ }
  }
}

export class PackagedPayloadManager {
  readonly #manifestPath: string;
  readonly #installId: string;
  readonly #spec: PackagedPayloadSpec;
  readonly #payloadFingerprint: string;
  readonly #filesystem = new FilesystemOwnershipObserver();

  constructor(input: {
    readonly manifestPath: string;
    readonly installId: string;
    readonly spec: PackagedPayloadSpec;
  }) {
    if (input.spec.resource.kind !== "directory" || input.spec.resource.dataClass !== "binary") {
      throw new Error("packaged payload resource must be a binary directory");
    }
    this.#manifestPath = input.manifestPath;
    this.#installId = input.installId;
    this.#spec = input.spec;
    this.#payloadFingerprint = packagedPayloadFingerprint(input.spec.sourcePath);
  }

  get resource(): DirectoryResource { return this.#spec.resource; }
  get payloadFingerprint(): string { return this.#payloadFingerprint; }

  observeRepair(manifest: OwnershipManifest): PackagedPayloadRepairObservation {
    const ownership = this.#filesystem.observe(this.#spec.resource, manifest);
    if (ownership !== "owned") return ownership;
    const recorded = manifest.resources.find(resource => resource.id === this.#spec.resource.id);
    if (!recorded || JSON.stringify(recorded) !== JSON.stringify(this.#spec.resource)) return "ownership-drift";
    let receipt: PackagedPayloadReceipt | undefined;
    try { receipt = readPackagedPayloadReceipt(this.#spec.resource); }
    catch { return "ownership-drift"; }
    if (!receipt) return "missing";
    if (receipt.installId !== manifest.installId
      || receipt.resourceId !== this.#spec.resource.id
      || receipt.productVersion !== this.#spec.productVersion
      || receipt.payloadFingerprint !== this.#payloadFingerprint) return "ownership-drift";
    try {
      return packagedPayloadFingerprint(this.#spec.resource.path, { target: true }) === this.#payloadFingerprint
        ? "owned"
        : "repairable";
    } catch {
      return "unsafe";
    }
  }

  observe(manifest: OwnershipManifest): OwnershipObservation {
    const observation = this.observeRepair(manifest);
    return observation === "repairable" ? "ownership-drift" : observation;
  }

  async install(manifest: OwnershipManifest): Promise<{ readonly created: boolean; readonly detail: string }> {
    if (manifest.installId !== this.#installId) throw new Error("packaged payload belongs to a different install instance");
    const prepared = await prepareOwnedDirectory({
      manifestPath: this.#manifestPath,
      installId: this.#installId,
      productVersion: this.#spec.productVersion,
      resource: this.#spec.resource,
    });
    if (prepared.state === "external-existing") {
      throw new Error("packaged binary target already exists without Tela ownership");
    }
    const refreshed = readOwnershipManifest(this.#manifestPath);
    if (!refreshed || refreshed.installId !== this.#installId) throw new Error("packaged payload ownership intent was not persisted");
    const current = this.observe(refreshed);
    if (current === "owned") return Object.freeze({ created: false, detail: "exact packaged payload already installed" });
    if (current !== "missing") throw new Error(`packaged binary target cannot be repaired from ${current} state`);

    clearIncompletePayload(this.#spec.resource);
    copyPayload(this.#spec.sourcePath, this.#spec.resource.path);
    writeReceipt(this.#spec.resource, Object.freeze({
      version: 1,
      installId: this.#installId,
      resourceId: this.#spec.resource.id,
      productVersion: this.#spec.productVersion,
      payloadFingerprint: this.#payloadFingerprint,
    }));
    if (this.observe(refreshed) !== "owned") throw new Error("packaged payload verification failed after copy");
    return Object.freeze({ created: true, detail: "packaged payload copied and verified" });
  }

  async repair(manifest: OwnershipManifest): Promise<{ readonly repaired: boolean; readonly detail: string }> {
    if (manifest.installId !== this.#installId) throw new Error("packaged payload belongs to a different install instance");
    const current = this.observeRepair(manifest);
    if (current === "owned") return Object.freeze({ repaired: false, detail: "exact packaged payload is already healthy" });
    if (current === "missing") {
      const installed = await this.install(manifest);
      return Object.freeze({ repaired: installed.created, detail: installed.detail });
    }
    if (current !== "repairable") throw new Error(`packaged binary target cannot be repaired from ${current} state`);

    const refreshed = readOwnershipManifest(this.#manifestPath);
    if (!refreshed || refreshed.installId !== this.#installId || refreshed.productVersion !== manifest.productVersion) {
      throw new Error("packaged payload ownership changed before repair");
    }
    if (this.observeRepair(refreshed) !== "repairable") throw new Error("packaged payload repair state changed before mutation");
    clearIncompletePayload(this.#spec.resource);
    copyPayload(this.#spec.sourcePath, this.#spec.resource.path);
    writeReceipt(this.#spec.resource, Object.freeze({
      version: 1,
      installId: this.#installId,
      resourceId: this.#spec.resource.id,
      productVersion: this.#spec.productVersion,
      payloadFingerprint: this.#payloadFingerprint,
    }));
    if (this.observeRepair(refreshed) !== "owned") throw new Error("packaged payload verification failed after repair");
    return Object.freeze({ repaired: true, detail: "exact owned packaged payload repaired and verified" });
  }
}

export class PackagedPayloadOwnershipObserver implements UninstallObserver {
  readonly #manager: PackagedPayloadManager;
  constructor(manager: PackagedPayloadManager) { this.#manager = manager; }
  observe(resource: OwnedResource, manifest: OwnershipManifest): OwnershipObservation {
    return resource.id === this.#manager.resource.id ? this.#manager.observe(manifest) : "unknown";
  }
}
