import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBoundedProcessState, writeExclusiveProcessState } from "./process-state";
import { validateProcessOwnerDescriptor, type ProcessOwnerDescriptor } from "./process-owner";

const MAX_RECORD_BYTES = 4096;
export interface ProcessExecutionClaim {
  readonly version: 1;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly launchingServerId: string;
  readonly requestFingerprint: string;
  readonly claimedAt: string;
}
export interface ProcessExecutionCompletion {
  readonly state: "exited" | "signaled" | "spawn_failed";
  readonly endedAt: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly resultFingerprint?: string;
  readonly resultTruncated?: boolean;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error("invalid execution identity");
  return value;
}
function claim(value: ProcessExecutionClaim): ProcessExecutionClaim {
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.requestFingerprint) || !Number.isFinite(Date.parse(value.claimedAt))) throw new Error("invalid execution claim");
  // Workspace IDs are opaque registry identities, not operation UUIDs.
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim() || value.workspaceId.length > 256
    || /[\u0000\r\n]/.test(value.workspaceId)) throw new Error("invalid execution workspace identity");
  return Object.freeze({ version: 1, operationId: id(value.operationId), workspaceId: value.workspaceId,
    ownerId: id(value.ownerId), launchingServerId: id(value.launchingServerId), requestFingerprint: value.requestFingerprint, claimedAt: value.claimedAt });
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Private execution evidence. Caller must reserve registry capacity before launching any owner. */
export class ProcessExecutionJournal {
  readonly #root: string;
  readonly #key: string;
  constructor(input: { readonly root: string; readonly key: string }) {
    if (!/^[a-f0-9]{64}$/.test(input.key)) throw new Error("invalid execution journal key");
    this.#root = resolve(input.root); this.#key = input.key;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#checkRoot();
  }
  #checkRoot(): void {
    const stat = lstatSync(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe execution journal root");
  }
  #path(operationId: string, phase: "claim" | "live" | "completed"): string {
    return join(this.#root, `${id(operationId)}.${phase}.json`);
  }
  #signature(phase: string, body: string): string {
    return createHmac("sha256", this.#key).update(`tela-process-journal-${phase}-v1\0`).update(body).digest("hex");
  }
  #write(operationId: string, phase: "claim" | "live" | "completed", value: unknown): void {
    this.#checkRoot();
    const body = JSON.stringify(value);
    const envelope = JSON.stringify({ body, signature: this.#signature(phase, body) });
    if (Buffer.byteLength(envelope) > MAX_RECORD_BYTES) throw new Error("execution journal record exceeds its bound");
    // An incomplete claim remains evidence of uncertainty, never permission to start again.
    writeExclusiveProcessState(this.#path(operationId, phase), envelope);
  }
  #read(operationId: string, phase: "claim" | "live" | "completed", authenticatedDigest?: (digest: string) => void): unknown {
    this.#checkRoot();
    const bytes = readBoundedProcessState(this.#path(operationId, phase), MAX_RECORD_BYTES);
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (typeof envelope.body !== "string" || typeof envelope.signature !== "string"
      || !same(this.#signature(phase, envelope.body), envelope.signature)) throw new Error("execution journal authentication failed");
    authenticatedDigest?.(createHash("sha256").update(bytes).digest("hex"));
    return JSON.parse(envelope.body);
  }
  #verify(expected: ProcessExecutionClaim): ProcessExecutionClaim {
    const known = this.readClaim(expected.operationId);
    if (JSON.stringify(known) !== JSON.stringify(claim(expected))) throw new Error("execution claim does not match its reservation");
    return known;
  }
  reserve(input: Omit<ProcessExecutionClaim, "version" | "ownerId" | "claimedAt">): ProcessExecutionClaim {
    const reserved = claim({ ...input, version: 1, ownerId: randomUUID(), claimedAt: new Date().toISOString() });
    this.#write(reserved.operationId, "claim", reserved);
    return reserved;
  }
  readClaim(operationId: string, authenticatedDigest?: (digest: string) => void): ProcessExecutionClaim {
    const known = claim(this.#read(operationId, "claim", authenticatedDigest) as ProcessExecutionClaim);
    if (known.operationId !== operationId) throw new Error("execution claim identity mismatch");
    return known;
  }
  publishLive(expected: ProcessExecutionClaim, descriptor: ProcessOwnerDescriptor): void {
    const known = this.#verify(expected);
    validateProcessOwnerDescriptor(descriptor);
    if (descriptor.ownerId !== known.ownerId || descriptor.operationId !== known.operationId || descriptor.workspaceId !== known.workspaceId) throw new Error("execution descriptor binding mismatch");
    this.#write(known.operationId, "live", { claim: known, descriptor });
  }
  readLive(expected: ProcessExecutionClaim, authenticatedDigest?: (digest: string) => void): ProcessOwnerDescriptor {
    const known = this.#verify(expected);
    const record = this.#read(known.operationId, "live", authenticatedDigest) as { claim: ProcessExecutionClaim; descriptor: ProcessOwnerDescriptor };
    if (JSON.stringify(claim(record.claim)) !== JSON.stringify(known)) throw new Error("execution live evidence mismatch");
    validateProcessOwnerDescriptor(record.descriptor);
    if (record.descriptor.ownerId !== known.ownerId || record.descriptor.workspaceId !== known.workspaceId || record.descriptor.operationId !== known.operationId) throw new Error("execution descriptor binding mismatch");
    return Object.freeze(record.descriptor);
  }
  publishCompletion(expected: ProcessExecutionClaim, result: ProcessExecutionCompletion): void {
    const known = this.#verify(expected);
    this.#validateCompletion(result);
    this.#write(known.operationId, "completed", { claim: known, result });
  }
  readCompletion(expected: ProcessExecutionClaim, authenticatedDigest?: (digest: string) => void): ProcessExecutionCompletion {
    const known = this.#verify(expected);
    const record = this.#read(known.operationId, "completed", authenticatedDigest) as { claim: ProcessExecutionClaim; result: ProcessExecutionCompletion };
    if (JSON.stringify(claim(record.claim)) !== JSON.stringify(known)) throw new Error("execution completion evidence mismatch");
    this.#validateCompletion(record.result);
    return Object.freeze(record.result);
  }
  #validateCompletion(result: ProcessExecutionCompletion): void {
    if (!["exited", "signaled", "spawn_failed"].includes(result.state) || !Number.isFinite(Date.parse(result.endedAt))
      || (result.state === "exited" && !Number.isSafeInteger(result.exitCode))
      || (result.state === "signaled" && (typeof result.signal !== "string" || !/^[A-Z0-9_]{1,32}$/.test(result.signal)))
      || (result.resultFingerprint !== undefined && (!/^[a-f0-9]{64}$/.test(result.resultFingerprint)
        || typeof result.resultTruncated !== "boolean"))) throw new Error("invalid execution completion");
  }
}
