import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readBoundedProcessState, synchronizeProcessDirectory, writeExclusiveProcessState } from "./process-state";

type ArtifactKind = "result" | "claim" | "live" | "completed";
export interface RetirementArtifactProof { readonly kind: ArtifactKind; readonly digest: string; }
interface Artifact {
  readonly kind: ArtifactKind;
  readonly digest: string;
  readonly device: string;
  readonly inode: string;
}
interface Retirement {
  readonly version: 1;
  readonly operationId: string;
  readonly operation: unknown;
  readonly artifacts: readonly Artifact[];
}
const PLAN_LIMIT = 16 * 1024;
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error("invalid retirement identity");
  return value;
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function directory(path: string): { readonly device: string; readonly inode: string } {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("retirement artifact directory is unsafe");
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

/** One bounded authenticated cleanup intent. Registry commit must succeed before any artifact removal.
 * Caller authenticates terminal execution/result evidence before preparing it. Missing planned artifacts
 * on resume are already retired; changed artifacts/roots fail closed. No scans, retries or idle work.
 */
export class ProcessRetirement {
  readonly #store: string;
  readonly #path: string;
  readonly #key: string;
  constructor(input: { readonly storePath: string; readonly key: string }) {
    if (!/^[a-f0-9]{64}$/.test(input.key)) throw new Error("invalid retirement key");
    this.#store = resolve(input.storePath); this.#path = `${this.#store}.retirement.json`; this.#key = input.key;
  }
  #signature(body: string): string {
    return createHmac("sha256", this.#key).update("tela-chat-retirement-v1\0").update(body).digest("hex");
  }
  #artifactPath(operationId: string, kind: ArtifactKind): string {
    return kind === "result" ? join(`${this.#store}.results`, `${id(operationId)}.bin`)
      : join(`${this.#store}.executions`, `${id(operationId)}.${kind}.json`);
  }
  prepare(operation: { readonly operationId: string }, proofs: readonly RetirementArtifactProof[]): void {
    const kinds = proofs.map(proof => proof.kind);
    if (kinds.length > 4 || new Set(kinds).size !== kinds.length
      || kinds.some(kind => !["result", "claim", "live", "completed"].includes(kind))) throw new Error("invalid retirement artifacts");
    const operationId = id(operation.operationId);
    const artifacts = proofs.map(({ kind, digest: expected }) => {
      if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("invalid authenticated retirement digest");
      const path = this.#artifactPath(operationId, kind);
      const identity = directory(dirname(path));
      if (digest(readBoundedProcessState(path, kind === "result" ? 512 * 1024 : 4096)) !== expected) throw new Error("retirement artifact changed since authentication");
      return { kind, ...identity, digest: expected };
    });
    const body = JSON.stringify({ version: 1, operationId, operation, artifacts } satisfies Retirement);
    const bytes = Buffer.from(JSON.stringify({ body, signature: this.#signature(body) }));
    if (bytes.length > PLAN_LIMIT) throw new Error("retirement plan exceeds its bound");
    // Never replace an interrupted plan, including an incomplete or unauthenticated one.
    writeExclusiveProcessState(this.#path, bytes);
  }
  resume(commitRegistryRemoval: (operation: unknown) => void): boolean {
    if (!present(this.#path)) return false;
    const original = readBoundedProcessState(this.#path, PLAN_LIMIT);
    const envelope = JSON.parse(original.toString("utf8")) as { body: string; signature: string };
    if (typeof envelope.body !== "string" || typeof envelope.signature !== "string"
      || !/^[a-f0-9]{64}$/.test(envelope.signature)
      || !timingSafeEqual(Buffer.from(envelope.signature), Buffer.from(this.#signature(envelope.body)))) throw new Error("retirement plan authentication failed");
    const plan = JSON.parse(envelope.body) as Retirement;
    if (plan.version !== 1 || !Array.isArray(plan.artifacts) || plan.artifacts.length > 4
      || !plan.operation || typeof plan.operation !== "object" || Array.isArray(plan.operation)
      || (plan.operation as { operationId?: unknown }).operationId !== id(plan.operationId)) throw new Error("invalid retirement plan");
    const kinds = new Set<string>();
    for (const artifact of plan.artifacts) {
      if (!artifact || !["result", "claim", "live", "completed"].includes(artifact.kind) || kinds.has(artifact.kind)
        || typeof artifact.digest !== "string" || !/^[a-f0-9]{64}$/.test(artifact.digest)
        || typeof artifact.device !== "string" || !/^\d+$/.test(artifact.device)
        || typeof artifact.inode !== "string" || !/^\d+$/.test(artifact.inode)) throw new Error("invalid retirement artifact proof");
      kinds.add(artifact.kind);
    }
    const verify = (artifact: Artifact): void => {
      const path = this.#artifactPath(plan.operationId, artifact.kind), root = directory(dirname(path));
      if (root.device !== artifact.device || root.inode !== artifact.inode) throw new Error("retirement directory identity changed");
      if (present(path) && digest(readBoundedProcessState(path, artifact.kind === "result" ? 512 * 1024 : 4096)) !== artifact.digest) throw new Error("retirement artifact changed");
    };
    // Verify the complete remaining set before either registry write or deletion.
    for (const artifact of plan.artifacts) verify(artifact);
    commitRegistryRemoval(plan.operation);
    for (const artifact of plan.artifacts) {
      verify(artifact);
      const path = this.#artifactPath(plan.operationId, artifact.kind);
      if (present(path)) {
        unlinkSync(path);
        synchronizeProcessDirectory(dirname(path));
      }
    }
    if (!readBoundedProcessState(this.#path, PLAN_LIMIT).equals(original)) throw new Error("retirement plan changed during cleanup");
    unlinkSync(this.#path);
    synchronizeProcessDirectory(dirname(this.#path));
    return true;
  }
}
