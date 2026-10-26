import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, linkSync, writeFileSync, fsyncSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { CodexWebDelegationCapacityContract, WebDelegationBlockCode } from "@chatgpt-tela/service-protocol";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";
import { selectDelegationWebModel, webDelegationTurnSettings, type DelegationWebModel } from "./web-delegation-model";
import { indexedWebDelegationProgress, WebDelegationProgressProjection, type WebDelegationProgress } from "./web-delegation-progress";
import { decodeNativeInlineEvidence, diagnosticFailureClass, diagnosticFailureIncidentRef, diagnosticFingerprint, emitDiagnosticEvent, emitDiagnosticIncident, structuralDiagnosticEvent, privateDiagnosticFailureGuidance } from "@chatgpt-tela/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESULT_BYTES = 512 * 1024;
const DELEGATED_TITLE_PREFIX = "[Tela Agent] ";
// A reporting threshold, never an admission bound on retained results.
const RECORD_REVIEW_THRESHOLD = 64;
const COLLECTED_HISTORY_RETENTION_MS = 30 * 86_400_000;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
// Reserve the full supported range; lowering a limit never revokes an active lease.
const MAX_PROFILE_TASKS = 5;
export type WebDelegationCapacity = CodexWebDelegationCapacityContract;
export type { WebDelegationBlockCode };
export class WebDelegationCapacityError extends Error {
  readonly code: WebDelegationBlockCode;
  constructor(readonly capacity: WebDelegationCapacity) {
    super(capacity.messageKo);
    this.name = "WebDelegationCapacityError";
    this.code = capacity.blockCode ?? "UNCERTAIN_RESERVATION";
  }
}
type WebFinalEvidence = "explicit-final-phase" | "sole-completed-message";
function completedAnswer(messages: readonly { text: string; phase?: string }[]):
  { answer: string; finalEvidence: WebFinalEvidence } | undefined {
  const final = messages.filter(message => message.phase === "finalAnswer" || message.phase === "final_answer");
  const chosen = final.at(-1);
  if (chosen?.text.trim()) return { answer: chosen.text, finalEvidence: "explicit-final-phase" };
  // A completed Native turn containing ONE unphased assistant message is also
  // a useful final. Other phases, or multiple unphased messages, are ambiguous.
  const only = messages.length === 1 ? messages[0] : undefined;
  if (final.length === 0 && only?.phase === undefined && only?.text.trim()) {
    return { answer: only.text, finalEvidence: "sole-completed-message" };
  }
}
// Counts are observations of supported Native item kinds, never proof of all execution.
const TOOL_ITEM_TYPES = new Set(["commandExecution", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"]);
const RESULT_FIELDS = ["aggregatedOutput", "output", "response", "result", "contentItems"];

function boundedResultPresent(value: unknown): boolean {
  const seen = new Set<object>();
  let nodes = 0, bytes = 0, nonempty = false;
  const visit = (part: unknown, depth: number): boolean => {
    if (++nodes > 256 || depth > 8) return false;
    if (typeof part === "string") {
      if (part.length > 128 * 1024) return false;
      bytes += Buffer.byteLength(part, "utf8");
      if (part.length > 0) nonempty = true;
      return bytes <= 128 * 1024;
    }
    if (typeof part === "boolean" || typeof part === "number" && Number.isFinite(part)) {
      nonempty = true; bytes += 16; return bytes <= 128 * 1024;
    }
    if (part === null || part === undefined) return true;
    if (!part || typeof part !== "object" || seen.has(part)) return false;
    seen.add(part);
    if (Array.isArray(part)) {
      return part.length <= 128 && part.every(child => visit(child, depth + 1));
    }
    const entries = Object.entries(part);
    if (entries.length > 128) return false;
    for (const [key, child] of entries) {
      bytes += Buffer.byteLength(key, "utf8");
      if (bytes > 128 * 1024 || !visit(child, depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0) && nonempty;
}

/** Content-free evidence of a Native tool result, not proof of task success or
 * external side effects. Failed items and unbounded/opaque output do not count. */
function hasNativeToolResult(item: Record<string, unknown> | undefined, completedEvent: boolean): boolean {
  if (!item || !TOOL_ITEM_TYPES.has(String(item.type))
    || (!completedEvent && !["completed", "success", "succeeded"].includes(String(item.status)))
    || ["failed", "error", "interrupted"].includes(String(item.status))) return false;
  return RESULT_FIELDS.some(key => Object.hasOwn(item, key) && boundedResultPresent(item[key]));
}
export type WebDelegationState = "reserved" | "creating" | "created" | "submitting" | "running" | "completed" | "failed" | "uncertain" | "linked";
export interface WebDelegationRecord {
  readonly id: string;
  readonly slot: number;
  /** Older read-only records omitted this field. */
  readonly mode?: "read" | "write"; // Historical journal metadata only.
  readonly cwd: string;
  readonly createdAt: number;
  readonly promptHash?: string;
  readonly owner: LocalProfileBinding;
  readonly session: TrustedNativeProfileSession;
  readonly selection?: DelegationWebModel;
  readonly state: WebDelegationState;
  readonly threadId?: string;
  readonly turnId?: string;
  /** Last observed public summary, not proof of liveness or a blocked classification. */
  readonly progress?: WebDelegationProgress;
  /** Last on-demand Native observation, distinct from the durable job state. */
  readonly reconciliation?: "native-in-progress" | "unproven";
  /** Model execution completion does not attest requested-task success. */
  readonly taskOutcome?: "unassessed";
  readonly finalEvidence?: WebFinalEvidence;
  readonly answer?: string;
  readonly toolItems?: number;
  readonly toolItemCoverage?: "live-events" | "history-summary";
  /** Count of result-bearing completed Native tool items; zero is not evidence
   * that no result was delivered, and content never enters this journal. */
  readonly toolResultItems?: number;
  readonly toolResultCoverage?: "live-events" | "history-summary";
  readonly parentJobId?: string;
  readonly checkoutRoot?: string;
  /** Explicit link to a separately created Native thread, never inferred from history. */
  readonly origin?: "native-thread-link";
  readonly failure?: "owner_changed" | "transport_or_ack" | "turn_failed" | "result_unavailable";
  /** Payload-free cause and boundary for an actionable terminal or uncertain result. */
  readonly failureStage?: WebDelegationFailureStage;
  readonly failureClass?: ReturnType<typeof diagnosticFailureClass>;
  readonly failureNativeCode?: string;
  readonly failureProviderReason?: "unusual_activity";
  readonly failureIncidentRef?: string;
  readonly failureIncidentState?: "recorded" | "unavailable";
  readonly failureNextAction?: "inspect_job" | "reconcile_exact_turn" | "inspect_diagnostics";
  readonly failureDiagnostics?: ReturnType<typeof privateDiagnosticFailureGuidance>;
  readonly coordinator?: { readonly slot: number; readonly threadId: string; readonly accountFingerprint: string };
  readonly coordinatorClientUserMessageId?: string;
  readonly coordinatorQueueItemId?: string;
  readonly coordinatorNotice?: "queued" | "accepted_unobserved" | "delivery_uncertain" | "unsupported" | "owner_unverified";
  readonly coordinatorFollowThrough?: "unobserved";
}

export type WebDelegationFailureStage =
  | "admission" | "owner_proof" | "connect" | "subscribe" | "thread_create"
  | "thread_resume" | "settings_update" | "turn_submit" | "turn_observe"
  | "turn_complete" | "final_result" | "reconcile_owner" | "reconcile_history"
  | "reconcile_result";

function failureStage(error: unknown, fallback: WebDelegationFailureStage): WebDelegationFailureStage {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("owner changed") || message.includes("owner mismatch")) return "owner_proof";
  if (message.includes("connection lost") || message.includes("connection")) return "connect";
  if (message.includes("turn failed")) return "turn_complete";
  if (message.includes("final answer") || message.includes("final result")) return "final_result";
  if (message.includes("history") || message.includes("indexed")) return "reconcile_history";
  return fallback;
}

// Only product-owned, bounded identifiers cross the diagnostic boundary.
function nativeTurnFailureCode(turn: Record<string, unknown> | undefined): string | undefined {
  const failure = object(turn?.error);
  let code = failure?.code;
  if (code === undefined && typeof failure?.message === "string") {
    try {
      code = object(object(JSON.parse(failure.message))?.error)?.code;
    } catch { /* Native errors may contain plain text. */ }
  }
  return typeof code === "string" && /^tela_[a-z_]{1,64}$/.test(code) ? code : undefined;
}
function nativeTurnProviderReason(turn: Record<string, unknown> | undefined): "unusual_activity" | undefined {
  const failure = object(turn?.error);
  let reason = failure?.reason_class;
  if (reason === undefined && typeof failure?.message === "string") {
    try { reason = object(object(JSON.parse(failure.message))?.error)?.reason_class; } catch { /* Non-JSON is not a classification. */ }
  }
  return reason === "unusual_activity" ? reason : undefined;
}

function failureMetadata(input: {
  readonly id: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly stage: WebDelegationFailureStage;
  readonly error: unknown;
  readonly nativeCode?: string | undefined;
  readonly providerReason?: "unusual_activity" | undefined;
  readonly diagnosticRoot?: string | undefined;
}) {
  const reasonClass = diagnosticFailureClass(input.error);
  const operationFingerprint = diagnosticFingerprint(input.id);
  const fields = {
    operation_fingerprint: operationFingerprint,
    failure_class: reasonClass,
    ...(input.nativeCode ? { reason_class: input.nativeCode } : {}),
    ...(input.providerReason ? { provider_reason: input.providerReason } : {}),
    failure_stage: input.stage,
    next_action: input.stage === "turn_submit" || input.stage === "turn_observe"
      ? "reconcile_exact_turn" : input.stage === "final_result" ? "inspect_job" : "inspect_diagnostics",
    thread_linked: Boolean(input.threadId),
    turn_linked: Boolean(input.turnId),
  } as const;
  const incident = emitDiagnosticIncident("chatgpt_tela_codex", "web_delegation_failed", fields);
  return Object.freeze({
    failureDiagnostics: privateDiagnosticFailureGuidance(input.diagnosticRoot),
    failureStage: input.stage,
    failureClass: reasonClass,
    ...(input.nativeCode ? { failureNativeCode: input.nativeCode } : {}),
    ...(input.providerReason ? { failureProviderReason: input.providerReason } : {}),
    failureIncidentState: incident.state,
    ...(incident.ref ? { failureIncidentRef: incident.ref } : {}),
    failureNextAction: (input.stage === "turn_submit" || input.stage === "turn_observe"
      ? "reconcile_exact_turn" : input.stage === "final_result" ? "inspect_job" : "inspect_diagnostics") as
      "inspect_job" | "reconcile_exact_turn" | "inspect_diagnostics",
  });
}

/** Bounded, payload-free lifecycle evidence for distinguishing orphan boundaries. */
function delegationBoundary(id: string, phase: string, fields: Record<string, boolean | string> = {}): void {
  emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_lifecycle", {
    operation_fingerprint: diagnosticFingerprint(id), phase, ...fields,
  });
}

export type WebDelegationRetentionState = "archived" | "excluded" | "deleted";
export interface WebDelegationRetentionReceipt {
  readonly state: WebDelegationRetentionState;
  readonly archivedAt?: number;
  /** Native metadata after our archive, used to detect subsequent manual changes. */
  readonly updatedAt?: number;
}
export interface WebDelegationThreadKey {
  readonly slot: number;
  readonly accountFingerprint: string;
  readonly threadId: string;
}

export function webDelegationRetentionPath(root: string, key: WebDelegationThreadKey): string {
  if (!Number.isSafeInteger(key.slot) || key.slot < 1 || key.slot > 99
    || !/^[a-f0-9]{64}$/.test(key.accountFingerprint) || !UUID.test(key.threadId)) {
    throw Error("Invalid managed thread identity");
  }
  return join(root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`);
}

/** Trusted coordinator evidence for its creation or an explicit user adoption of
 * an existing delegated thread under the currently authenticated account. */
export interface NativeThreadOwnershipEvidence {
  readonly slot: number;
  readonly cwd: string;
  readonly createdAt: number;
  readonly accountFingerprint: string;
  readonly threadId: string;
  readonly turnId?: string;
}

/** A proven final can be retrieved even when the Native turn itself failed.
 * Failure remains failure; only completed jobs may authorize continuations. */
export function verifiedWebDelegationAnswer(record: WebDelegationRecord): string | undefined {
  const deliverable = record.state === "completed"
    || record.state === "failed" && record.failure === "turn_failed"
      && record.finalEvidence === "explicit-final-phase";
  return deliverable && record.finalEvidence && record.answer?.trim()
    ? record.answer : undefined;
}

/** Resolve all paths inside one Git worktree to its physical checkout root. */
function checkoutRoot(cwd: string): string {
  try { return realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { try { return realpathSync(cwd); } catch { return cwd; } }
}
/** Private user data, outside repositories/logs/releases. Execution capacity is lease-based. */
export class WebDelegationStore {
  readonly fingerprintKey: Uint8Array;
  constructor(readonly root: string, readonly limitForProfile: (slot: number) => number = () => 3) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error("Unsafe Web job store");
    chmodSync(root, 0o700);
    const key = join(root, "owner-key");
    try {
      const fd = openSync(key, "wx", 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(key).isFile() || lstatSync(key).isSymbolicLink()) throw Error("Unsafe Web job owner key");
    this.fingerprintKey = readFileSync(key);
    if (this.fingerprintKey.length !== 32) throw Error("Invalid Web job owner key");
  }
  #path(id: string) { if (!UUID.test(id)) throw Error("Invalid Web job ID"); return join(this.root, `${id}.json`); }
  #permits(slot: number): string[] {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw Error("Invalid Web profile slot");
    return Array.from({ length: MAX_PROFILE_TASKS }, (_, index) =>
      join(this.root, `task-${slot}-${index + 1}.lease`));
  }
  #limit(slot: number): number {
    this.#permits(slot);
    const limit = this.limitForProfile(slot);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROFILE_TASKS) throw Error("Invalid Web delegation limit");
    return limit;
  }
  #legacyPermits(slot: number): string[] {
    return [join(this.root, `writer-${slot}.lease`), join(this.root, `reader-${slot}.lease`), join(this.root, `reader-${slot}-2.lease`)];
  }
  #checkoutPermit(cwd: string): string {
    return join(this.root, `writer-checkout-${createHash("sha256").update(checkoutRoot(cwd)).digest("hex")}.lease`);
  }
  #legacyCheckoutPermit(cwd: string): string {
    return join(this.root, `writer-checkout-${createHash("sha256").update(cwd).digest("hex")}.lease`);
  }
  #threadPermit(threadId: string): string {
    if (!UUID.test(threadId)) throw Error("Invalid continuation thread ID");
    return join(this.root, `continuation-thread-${threadId}.lease`);
  }
  #retained(): string[] {
    return [...new Set(readdirSync(this.root).flatMap(name => {
      const id = /^([0-9a-f-]{36})\.json(?:\.(?:completed|failed))?$/.exec(name)?.[1];
      return id && UUID.test(id) ? [id] : [];
    }))].map(id => `${id}.json`);
  }
  #leaseOwner(path: string): "free" | "unknown" | string {
    if (!existsSync(path)) return "free";
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 36) return "unknown";
    const id = readFileSync(path, "utf8");
    return UUID.test(id) ? id : "unknown";
  }
  #terminal(record: WebDelegationRecord): boolean {
    return Boolean(verifiedWebDelegationAnswer(record))
      || record.state === "failed" && (record.failure === "turn_failed" || record.failure === "result_unavailable" || !record.turnId);
  }
  #release(record: WebDelegationRecord): void {
    if (!this.#terminal(record)) return;
    const saved = this.get(record.id);
    if (!saved || !this.#terminal(saved) || saved.slot !== record.slot) return;
    const paths = [...this.#permits(record.slot), ...this.#legacyPermits(record.slot),
      this.#checkoutPermit(record.checkoutRoot ?? record.cwd), this.#legacyCheckoutPermit(record.cwd),
      ...(record.parentJobId && record.threadId ? [this.#threadPermit(record.threadId)] : [])];
    for (const path of paths) if (this.#leaseOwner(path) === record.id) unlinkSync(path);
  }
  capacity(slot: number, cwd?: string): WebDelegationCapacity {
    const limit = this.#limit(slot);
    const modern = this.#permits(slot).map(path => this.#leaseOwner(path));
    const legacy = this.#legacyPermits(slot).map(path => this.#leaseOwner(path));
    const all = [...modern, ...legacy], retained = this.#retained();
    const unknown = all.filter(id => id === "unknown" || id !== "free" && (!this.get(id) || this.get(id)?.state === "uncertain")).length;
    const unsafeLease = all.some(id => id === "unknown" || id !== "free" && !this.get(id));
    const used = all.filter(id => id !== "free").length;
    // A journal entry without a lease has no admitted capacity claim. Keep
    // the record for exact recovery, but do not fence unrelated new jobs.
    const checkout = cwd ? this.#leaseOwner(this.#checkoutPermit(cwd)) : "free";
    // Old writer lease names were hashed from the provided cwd, not the Git root.
    // Preserve their ownership across policy upgrades and subdirectory aliases.
    const checkoutLegacyConflict = cwd && retained.some(name => {
      const id = name.slice(0, -5);
      if (!UUID.test(id)) return false;
      const job = this.get(id);
      if (!job || this.#terminal(job) || job.state === "completed") return false;
      if (checkoutRoot(job.cwd) !== checkoutRoot(cwd)) return false;
      return this.#legacyPermits(job.slot).some(path => this.#leaseOwner(path) === id);
    });
    const blockCode: WebDelegationBlockCode | undefined = unsafeLease ? "UNCERTAIN_RESERVATION"
        : used >= limit ? "CAPACITY_TOTAL_PROFILE"
          : (checkoutLegacyConflict || checkout !== "free")
            ? checkout === "unknown" ? "UNCERTAIN_RESERVATION" : "CAPACITY_WRITER_CHECKOUT" : undefined;
    const statusKo = `프로필 ${slot}: 동시 작업 ${used}/${limit}`;
    const statusEn = `Profile ${slot}: concurrent jobs ${used}/${limit}`;
    const reasonKo = blockCode === "UNCERTAIN_RESERVATION" ? "기존 작업의 종료가 불확실합니다. 해당 작업을 조회·복구하세요."
        : blockCode === "CAPACITY_WRITER_CHECKOUT" ? "이 작업 디렉터리에서 다른 쓰기 위임이 진행 중입니다."
          : blockCode ? "실행 한도에 도달했습니다. 진행 중인 작업이 끝난 후 다시 시도하세요."
            : "관리되는 슬롯이 사용 가능합니다. 실제 계정 준비 상태는 별도로 확인됩니다.";
    const reasonEn = blockCode === "UNCERTAIN_RESERVATION" ? "An earlier job is unresolved; inspect and reconcile it."
        : blockCode === "CAPACITY_WRITER_CHECKOUT" ? "Another write delegation holds this checkout."
          : blockCode ? "Concurrency limit reached; retry after active work finishes."
            : "Managed slot available; account readiness is checked separately.";
    return { contractVersion: 3, source: "managed_delegation_journal", observedAt: new Date().toISOString(), profileSlot: slot,
      coverage: "managed_jobs_only",
      policy: "configurable_tasks_one_writer_per_checkout_v3",
      uncertain: unknown,
      total: { used, limit },
      // Keep the historical 'limit' field for v2 clients, but explicitly mark
      // it advisory. Neither record count nor age releases or denies a lease.
      records: { retained: retained.length, limit: RECORD_REVIEW_THRESHOLD, admissionBound: false },
      available: !blockCode, ...(blockCode ? { blockCode } : {}),
      messageKo: `${statusKo}. ${reasonKo}`, messageEn: `${statusEn}. ${reasonEn}`,
      nextAction: blockCode === "UNCERTAIN_RESERVATION" ? "inspect_and_reconcile_exact_job"
          : blockCode ? "wait_for_active_job" : "start_if_profile_ready" };
  }
  #read(path: string, id: string): WebDelegationRecord | undefined {
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_RESULT_BYTES + 32 * 1024) throw Error("Invalid Web job record");
    const value = JSON.parse(readFileSync(path, "utf8")) as WebDelegationRecord;
    if (value.id !== id || !UUID.test(value.id) || !["reserved", "creating", "created", "submitting", "running", "completed", "failed", "uncertain", "linked"].includes(value.state)) throw Error("Invalid Web job record");
    return value;
  }
  get(id: string): WebDelegationRecord | undefined {
    const path = this.#path(id);
    // A proven final receipt wins over an earlier failure receipt, including
    // when the exact Native turn remains failed. Late observers cannot erase it.
    const record = this.#read(`${path}.completed`, id) ?? this.#read(`${path}.failed`, id) ?? this.#read(path, id);
    return record && !this.#deleted(record) ? record : undefined;
  }
  /** Only managed entries are eligible; deleted threads are hidden during cleanup. */
  records(): WebDelegationRecord[] {
    return this.#retained().filter(name => UUID.test(name.slice(0, -5)))
      .map(name => this.get(name.slice(0, -5))!).filter(Boolean);
  }
  threadRetention(record: WebDelegationRecord): WebDelegationRetentionReceipt | undefined {
    if (!record.threadId) return undefined;
    const path = webDelegationRetentionPath(this.root, {
      slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId,
    });
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as WebDelegationRetentionReceipt;
    if (!["archived", "excluded", "deleted"].includes(value.state)
      || value.state === "archived" && (!Number.isFinite(value.archivedAt) || !Number.isFinite(value.updatedAt))) {
      throw Error("Invalid Web thread retention receipt");
    }
    return value;
  }
  /** Called after exact Native absence is confirmed. */
  removeDeletedThread(key: WebDelegationThreadKey): { jobs: number; files: number } {
    const records = this.recordsForThread(key);
    for (const record of records) {
      const paths = [...this.#permits(record.slot), ...this.#legacyPermits(record.slot),
        this.#checkoutPermit(record.checkoutRoot ?? record.cwd), this.#legacyCheckoutPermit(record.cwd),
        ...(record.parentJobId && record.threadId ? [this.#threadPermit(record.threadId)] : [])];
      for (const path of paths) if (this.#leaseOwner(path) === record.id) unlinkSync(path);
    }
    const files = records.reduce((count, record) => count + this.#removeRecordFiles(record.id), 0);
    const receipt = webDelegationRetentionPath(this.root, key);
    if (existsSync(receipt)) { unlinkSync(receipt); return { jobs: records.length, files: files + 1 }; }
    return { jobs: records.length, files };
  }
  #removeRecordFiles(id: string): number {
    let files = 0;
    // Keep collection proof until all answer-bearing records are gone. An
    // interrupted prune can then resume from its terminal sidecar; a final
    // collected-only marker is removed by the existing orphan sweep.
    for (const suffix of ["", ".failed", ".completed", ".collected", ".named", ".naming"]) {
      const path = this.#path(id) + suffix;
      if (existsSync(path)) { unlinkSync(path); files++; }
    }
    return files;
  }
  /** Local history only: user-controlled Native conversations are never mutated.
   * Active, unresolved and uncollected results can exceed this reclaimable-history budget. */
  pruneCollectedHistory(eligible: ReadonlySet<string>, now = Date.now()): { removed: number; next?: number } {
    const records = this.records();
    let bytes = 0;
    const groups = new Map<string, WebDelegationRecord[]>();
    const identity = (record: WebDelegationRecord) => `${record.slot}:${record.owner.accountFingerprint}:${record.threadId}`;
    for (const record of records) {
      if (!record.threadId) continue;
      const key = identity(record);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const candidates = [...groups.entries()].flatMap(([key, jobs]) => {
      if (!eligible.has(key) || this.threadRetention(jobs[0]!)?.state !== "excluded"
        || jobs.some(job => !this.#terminal(job) || !verifiedWebDelegationAnswer(job) || this.collectedAt(job.id) === undefined)) return [];
      const collected = Math.max(...jobs.map(job => this.collectedAt(job.id)!));
      const size = jobs.reduce((sum, job) => sum + ["", ".collected", ".failed", ".completed", ".named", ".naming"].reduce((total, suffix) => {
        const path = this.#path(job.id) + suffix;
        return total + (existsSync(path) ? lstatSync(path).size : 0);
      }, 0), 0);
      bytes += size;
      return [{ jobs, collected, size }];
    }).sort((a, b) => a.collected - b.collected || a.jobs[0]!.id.localeCompare(b.jobs[0]!.id));
    let removed = 0;
    let next = Infinity;
    for (const { jobs, collected, size } of candidates) {
      const expiry = collected + COLLECTED_HISTORY_RETENTION_MS;
      if (expiry > now && bytes <= MAX_HISTORY_BYTES) { next = Math.min(next, expiry); continue; }
      if (jobs.some(job => {
        const current = this.get(job.id);
        return !current || !this.#terminal(current) || !verifiedWebDelegationAnswer(current) || this.collectedAt(job.id) === undefined;
      })) continue;
      const record = jobs[0]!;
      if (this.threadRetention(record)?.state !== "excluded") continue;
      // A continuation may have acquired its thread lease after the retention
      // pass observed the Native tail. An unknown lease is protected too.
      if (this.#leaseOwner(this.#threadPermit(record.threadId!)) !== "free") continue;
      const key = { slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! };
      for (const job of jobs) { this.#release(job); this.#removeRecordFiles(job.id); removed++; }
      delegationBoundary(record.id, "collected_history_pruned", { thread_linked: true });
      bytes -= size;
      const receipt = webDelegationRetentionPath(this.root, key);
      if (existsSync(receipt)) unlinkSync(receipt);
    }
    return { removed, ...(next === Infinity ? {} : { next }) };
  }
  /** Sweep non-answer artifacts left after interrupted local history pruning. */
  pruneOrphanedExcludedReceipts(): void {
    const retained = new Set(this.#retained());
    const owned = new Set(this.records().filter(record => record.threadId).map(record =>
      webDelegationRetentionPath(this.root, { slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! })));
    for (const name of readdirSync(this.root)) {
      const collectedId = /^([0-9a-f-]{36})\.json\.(?:collected|named)$/.exec(name)?.[1];
      if (collectedId && UUID.test(collectedId) && !retained.has(`${collectedId}.json`)) {
        unlinkSync(join(this.root, name));
        continue;
      }
      if (!/^thread-([1-9][0-9]?)-[a-f0-9]{64}-[0-9a-f-]{36}\.retention$/i.test(name)) continue;
      const path = join(this.root, name);
      if (owned.has(path)) continue;
      const receipt = JSON.parse(readFileSync(path, "utf8")) as WebDelegationRetentionReceipt;
      if (receipt.state === "excluded") unlinkSync(path);
    }
  }
  /** Recover ownership from terminal sidecars even when the base predates thread creation. */
  recordsForThread(key: WebDelegationThreadKey): WebDelegationRecord[] {
    return this.#retained().map(name => {
      const id = name.slice(0, -5);
      const base = this.#path(id);
      return this.#read(`${base}.completed`, id) ?? this.#read(`${base}.failed`, id) ?? this.#read(base, id);
    }).filter((record): record is WebDelegationRecord => Boolean(record && record.slot === key.slot
      && record.owner.accountFingerprint === key.accountFingerprint && record.threadId === key.threadId));
  }
  /** Old deleted receipts require renewed exact Native absence proof. */
  pendingDeletedThreads(): WebDelegationThreadKey[] {
    const pending: WebDelegationThreadKey[] = [];
    for (const name of readdirSync(this.root)) {
      const match = /^thread-([1-9][0-9]?)-([a-f0-9]{64})-([0-9a-f-]{36})\.retention$/i.exec(name);
      if (!match || !UUID.test(match[3]!)) continue;
      const key = { slot: Number(match[1]), accountFingerprint: match[2]!, threadId: match[3]! };
      const receipt = this.threadRetention({ threadId: key.threadId, slot: key.slot, owner: { accountFingerprint: key.accountFingerprint } } as WebDelegationRecord);
      if (receipt?.state === "deleted") pending.push(key);
    }
    return pending;
  }
  #deleted(record: WebDelegationRecord): boolean {
    return Boolean(record.threadId && this.threadRetention(record)?.state === "deleted");
  }
  collectedAt(id: string): number | undefined {
    const path = `${this.#path(id)}.collected`;
    if (!existsSync(path)) return undefined;
    const value = Number(readFileSync(path, "utf8"));
    if (!Number.isFinite(value) || value < 0) throw Error("Invalid Web result collection time");
    return value;
  }
  /** First explicit result retrieval is durable; repeated reads do not extend retention. */
  collect(id: string, now = Date.now()): boolean {
    const record = this.get(id);
    if (!record || !verifiedWebDelegationAnswer(record)) throw Error("No verified Web result to collect");
    try {
      const fd = openSync(`${this.#path(id)}.collected`, "wx", 0o600);
      try { writeFileSync(fd, String(now)); fsyncSync(fd); } finally { closeSync(fd); }
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return false; }
  }
  /** Claim once per Tela-created conversation, independently of answer collection. */
  claimTitle(record: WebDelegationRecord, confirmUncertain = false): boolean {
    if (!this.#terminal(record) || !record.threadId || record.origin) return false;
    const root = record.parentJobId ? this.recordsForThread({ slot: record.slot,
      accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId })
      .find(job => !job.parentJobId && !job.origin) : record;
    if (!root) return false;
    const named = `${this.#path(root.id)}.named`;
    const state = existsSync(named) ? readFileSync(named, "utf8") : undefined;
    if (this.collectedAt(root.id) !== undefined && state !== "retry" && state !== "uncertain") return false;
    if (existsSync(named)) {
      if (state === "complete" || state === "") return false;
      if (state === "uncertain" && !confirmUncertain) return false;
      if (state !== "uncertain" && state !== "retry") return false;
    }
    try {
      const fd = openSync(`${this.#path(root.id)}.naming`, "wx", 0o600);
      closeSync(fd);
      if (state === "uncertain") unlinkSync(named);
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return false; }
  }
  completeTitleClaim(record: WebDelegationRecord): void {
    if (!record.threadId || record.origin) return;
    const root = record.parentJobId ? this.recordsForThread({ slot: record.slot,
      accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId })
      .find(job => !job.parentJobId && !job.origin) : record;
    if (root) {
      writeFileSync(`${this.#path(root.id)}.named`, "complete", { mode: 0o600 });
      const claim = `${this.#path(root.id)}.naming`;
      if (existsSync(claim)) unlinkSync(claim);
    }
  }
  /** Unknown mutation outcomes stay fenced until an explicit retry confirmation. */
  releaseTitleClaim(record: WebDelegationRecord, outcome: "uncertain" | "retry" | "keep" = "keep"): void {
    if (!record.threadId || record.origin) return;
    const root = record.parentJobId ? this.recordsForThread({ slot: record.slot,
      accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId })
      .find(job => !job.parentJobId && !job.origin) : record;
    if (root) {
      const named = `${this.#path(root.id)}.named`;
      if (outcome === "uncertain" && (!existsSync(named) || readFileSync(named, "utf8") !== "complete")) {
        writeFileSync(named, "uncertain", { mode: 0o600 });
      }
      else if (outcome === "retry" && (!existsSync(named) || readFileSync(named, "utf8") !== "complete")) {
        writeFileSync(named, "retry", { mode: 0o600 });
      }
      const claim = `${this.#path(root.id)}.naming`;
      if (existsSync(claim)) unlinkSync(claim);
    }
  }
  /** An explicitly linked thread has no task permit and cannot submit a model turn. */
  link(record: WebDelegationRecord): void {
    if (record.state !== "linked" || record.origin !== "native-thread-link"
      || !UUID.test(record.id) || !record.threadId || !UUID.test(record.threadId)
      || record.turnId !== undefined && !UUID.test(record.turnId)
      || this.records().some(existing => existing.slot === record.slot && existing.threadId === record.threadId)) {
      throw Error("Invalid or already managed Native thread link");
    }
    if (this.#deleted(record)) throw Error("Web thread was deleted");
    const fd = openSync(this.#path(record.id), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  }
  reserve(record: WebDelegationRecord): void {
    if (record.threadId && this.#deleted(record)) throw Error("Web thread was deleted");
    if (record.parentJobId && !record.threadId) throw Error("Continuation requires its exact Native thread");
    const threadLease = record.parentJobId ? this.#threadPermit(record.threadId!) : undefined;
    // Exact terminal journal proofs can release stale permits after a crash.
    for (const lease of [...this.#permits(record.slot), ...this.#legacyPermits(record.slot),
      this.#checkoutPermit(record.cwd), this.#legacyCheckoutPermit(record.cwd),
      ...(threadLease ? [threadLease] : [])]) {
      const owner = this.#leaseOwner(lease);
      if (owner !== "free" && owner !== "unknown") {
        const previous = this.get(owner);
        if (previous) this.#release(previous);
      }
    }
    const available = this.capacity(record.slot, record.cwd);
    if (!available.available) throw new WebDelegationCapacityError(available);
    const path = this.#path(record.id), fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    // Exclusive creation is the admission boundary. An unresolved partial
    // reservation stays fenced rather than allowing an extra model send.
    const claimed: string[] = [];
    let admissionStage: "thread" | "checkout" | "profile" = "profile";
    try {
      if (threadLease) {
        admissionStage = "thread";
        const fd = openSync(threadLease, "wx", 0o600);
        claimed.push(threadLease);
        try { writeFileSync(fd, record.id); fsyncSync(fd); } finally { closeSync(fd); }
      }
      admissionStage = "checkout";
      const checkout = this.#checkoutPermit(record.cwd);
      const checkoutFd = openSync(checkout, "wx", 0o600);
      claimed.push(checkout);
      try { writeFileSync(checkoutFd, record.id); fsyncSync(checkoutFd); } finally { closeSync(checkoutFd); }
      admissionStage = "profile";
      let admitted = false;
      for (const lease of this.#permits(record.slot).slice(0, available.total.limit)) {
        try {
          const fd = openSync(lease, "wx", 0o600);
          claimed.push(lease);
          try { writeFileSync(fd, record.id); fsyncSync(fd); } finally { closeSync(fd); }
          admitted = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!admitted) throw Object.assign(new Error("profile capacity changed"), { code: "EEXIST" });
    } catch (error) {
      for (const lease of claimed) if (this.#leaseOwner(lease) === record.id) unlinkSync(lease);
      unlinkSync(path);
      const capacity = this.capacity(record.slot, record.cwd);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WebDelegationCapacityError({
        ...capacity, available: false,
        blockCode: capacity.blockCode ?? (admissionStage === "thread" ? "CAPACITY_THREAD_ACTIVE" : "CAPACITY_TOTAL_PROFILE"),
        nextAction: "wait_for_active_job",
      });
      throw error;
    }
  }
  save(record: WebDelegationRecord): WebDelegationRecord {
    if (this.#terminal(record)) {
      const { progress: _progress, reconciliation: _reconciliation, ...settled } = record;
      record = settled;
    }
    const current = this.get(record.id);
    if (!current) throw Error("Web job was not reserved");
    const upgradedFailedFinal = current.state === "failed" && current.failure === "turn_failed"
      && !verifiedWebDelegationAnswer(current) && record.state === "failed"
      && record.failure === "turn_failed" && record.turnId === current.turnId
      && record.threadId === current.threadId && Boolean(verifiedWebDelegationAnswer(record));
    if (verifiedWebDelegationAnswer(current) || this.#terminal(current) && !upgradedFailedFinal) {
      this.#release(current);
      return current;
    }
    if (this.#deleted(record)) throw Error("Web job was deleted");
    const path = this.#path(record.id), temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
      if (!existsSync(path) || this.#deleted(record)) throw Error("Web job was deleted");
      if (this.#terminal(record)) {
        // link() publishes a *complete* terminal record once, atomically and
        // without replacing another process's receipt. The base snapshot can
        // still change, but get() always prefers the immutable terminal proof.
        // The historical .completed suffix denotes a final-bearing receipt;
        // the record's state remains authoritative for failed Native turns.
        const terminal = `${path}.${verifiedWebDelegationAnswer(record) ? "completed" : "failed"}`;
        try { linkSync(temporary, terminal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } else renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    const settled = this.get(record.id)!;
    this.#release(settled);
    return settled;
  }

}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function indexedMessages(items: readonly unknown[]): { text: string; phase?: string }[] {
  return items.map(object)
    .filter(item => item?.type === "agentMessage" && typeof item.text === "string")
    .map(item => ({ text: item!.text as string,
      ...(typeof item!.phase === "string" ? { phase: item!.phase } : {}) }));
}
export interface WebDelegationAdapters {
  owner(slot: number): Promise<{ binding: LocalProfileBinding; session: TrustedNativeProfileSession }>;
  connect(endpoint: string): Promise<CodexAppServerRpc>;
  store: WebDelegationStore;
  diagnosticRoot?: string;
  changed?(record: WebDelegationRecord): void;
}

async function notifyFailureCoordinator(adapters: WebDelegationAdapters, record: WebDelegationRecord): Promise<WebDelegationRecord> {
  if (!record.coordinator || record.coordinatorNotice) return record;
  const clientUserMessageId = randomUUID();
  let updated = adapters.store.save({ ...record, coordinatorClientUserMessageId: clientUserMessageId,
    coordinatorNotice: "delivery_uncertain", coordinatorFollowThrough: "unobserved" });
  adapters.changed?.(updated);
  try {
    const current = await adapters.owner(record.coordinator.slot);
    const proof: WebDelegationRecord = { ...record, slot: record.coordinator.slot,
      owner: { ...current.binding, accountFingerprint: record.coordinator.accountFingerprint },
      session: current.session };
    if (!sameAccountOwner(proof, current) || current.binding.accountFingerprint !== record.coordinator.accountFingerprint) {
      updated = adapters.store.save({ ...updated, coordinatorNotice: "owner_unverified" });
      adapters.changed?.(updated);
      return updated;
    }
    const rpc = await adapters.connect(current.session.terminalEndpoint);
    try {
      const read = object(await rpc.request("thread/read", { threadId: record.coordinator.threadId, includeTurns: false }));
      if (object(read?.thread)?.id !== record.coordinator.threadId) {
        updated = adapters.store.save({ ...updated, coordinatorNotice: "owner_unverified" });
        adapters.changed?.(updated);
        return updated;
      }
      const text = [
        "Tela delegated job failed; inspect this exact job before any retry.",
        `job_id: ${record.id}`,
        `thread_id: ${record.threadId ?? "unavailable"}`,
        `turn_id: ${record.turnId ?? "unavailable"}`,
        `failure_stage: ${record.failureStage ?? "unknown"}`,
        `failure_class: ${record.failureClass ?? "unknown"}`,
        `incident_state: ${record.failureIncidentState ?? "unavailable"}`,
        `incident_ref: ${record.failureIncidentRef ?? "unavailable"}`,
        `next_action: ${record.failureNextAction ?? "inspect_diagnostics"}`,
      ].join("\n");
      const response = object(await rpc.request("thread/queue/add", {
        threadId: record.coordinator.threadId, clientUserMessageId,
        input: [{ type: "text", text }],
      }));
      const queued = object(response?.queuedSubmission);
      if (typeof queued?.id !== "string" || queued.clientUserMessageId !== clientUserMessageId) {
        updated = adapters.store.save({ ...updated, coordinatorNotice: "delivery_uncertain" });
      } else {
        updated = adapters.store.save({ ...updated, coordinatorQueueItemId: queued.id, coordinatorNotice: "queued" });
      }
      adapters.changed?.(updated);
      return updated;
    } finally { await rpc.close(); }
  } catch {
    // The request may have reached Native before the transport failed. Keep the
    // stable message ID and never submit a second notification blindly.
    updated = adapters.store.save({ ...updated, coordinatorNotice: "delivery_uncertain" });
    adapters.changed?.(updated);
    return updated;
  }
}
/** Maintenance reuses exact-turn recovery; a lost observer cannot pin a completed job forever. */
export async function reconcileWebDelegationCapacity(adapters: WebDelegationAdapters, slot: number, signal: AbortSignal): Promise<WebDelegationCapacity> {
  if (adapters.store.capacity(slot).total.used) {
    for (const record of adapters.store.records()) {
      if (record.slot !== slot || !record.threadId || !record.turnId
        || record.state !== "running" && record.state !== "uncertain") continue;
      try { await reconcileWebDelegation(adapters, record.id, signal); }
      catch { /* Unproven operations retain their existing reservation and failure evidence. */ }
    }
  }
  return adapters.store.capacity(slot);
}

/** Inspect the journal after one on-demand recovery of an unfinished exact turn.
 * The observer process may have exited after Native completed its turn. */
export async function inspectWebDelegationResult(adapters: WebDelegationAdapters, id: string, confirmUncertainTitleRetry = false): Promise<WebDelegationRecord> {
  let record = adapters.store.get(id);
  if (!record) throw Error("Web job was not found");
  if ((record.state === "running" || record.state === "uncertain") && record.threadId
    && (record.turnId || record.state === "uncertain" && !record.parentJobId)) {
    try { record = await reconcileWebDelegation(adapters, id, AbortSignal.timeout(30_000)); }
    catch { record = adapters.store.get(id) ?? record; } // Keep inspection available when Native is unreachable.
  }
  if (record.state === "completed" || record.state === "failed") {
    delegationBoundary(record.id, "terminal_inspection", { thread_linked: Boolean(record.threadId) });
  }
  if ((record.state === "completed" || record.state === "failed")
    && adapters.store.claimTitle(record, confirmUncertainTitleRetry)) {
    try {
      const current = await adapters.owner(record.slot);
      if (sameAccountOwner(record, current)) {
        const rpc = await adapters.connect(current.session.terminalEndpoint);
        try {
          let read: Record<string, unknown> | undefined;
          try { read = object(await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false })); }
          catch (error) { adapters.store.releaseTitleClaim(record, "retry"); throw error; }
          const thread = object(read?.thread);
          const name = typeof thread?.name === "string" ? thread.name.trim() : "";
          const preview = typeof thread?.preview === "string" ? thread.preview.split(/\r?\n/).find(line => line.trim())?.trim() : "";
          const title = name || preview;
          if (!title) { adapters.store.releaseTitleClaim(record, "retry"); return record; }
          if (!title.startsWith(DELEGATED_TITLE_PREFIX)) {
            try {
              await rpc.request("thread/name/set", { threadId: record.threadId, name: DELEGATED_TITLE_PREFIX + title });
              adapters.store.completeTitleClaim(record);
            } catch (error) {
              // A lost ACK is ambiguous. Public metadata readback settles a successful
              // mutation without blindly issuing it again on the next inspection.
              let after: Record<string, unknown> | undefined;
              try { after = object(await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false })); }
              catch { adapters.store.releaseTitleClaim(record, "uncertain"); throw error; }
              const afterThread = object(after?.thread);
              const afterName = typeof afterThread?.name === "string" ? afterThread.name.trim() : "";
              if (afterName.startsWith(DELEGATED_TITLE_PREFIX)) adapters.store.completeTitleClaim(record);
              else { adapters.store.releaseTitleClaim(record, "retry"); throw error; }
            }
          } else adapters.store.completeTitleClaim(record);
        } finally { await rpc.close(); }
      } else {
        adapters.store.releaseTitleClaim(record, "retry");
      }
    } catch (error) {
      adapters.store.releaseTitleClaim(record);
      emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_title_failed", {
        phase: "inspect", operation_fingerprint: diagnosticFingerprint(record.id),
        failure_class: diagnosticFailureClass(error), thread_linked: Boolean(record.threadId),
      });
    }
  }
  return record;
}
export async function collectWebDelegationResult(adapters: WebDelegationAdapters, id: string, confirmUncertainTitleRetry = false): Promise<string> {
  const record = await inspectWebDelegationResult(adapters, id, confirmUncertainTitleRetry);
  const answer = verifiedWebDelegationAnswer(record);
  if (!answer) throw Error("No verified final result; inspect job status");
  try {
    adapters.store.collect(id);
    return answer;
  } catch (error) {
    failureMetadata({ id: record.id, ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.turnId ? { turnId: record.turnId } : {}), stage: "reconcile_result", error, diagnosticRoot: adapters.diagnosticRoot });
    throw error;
  }
}
function sameOwner(record: WebDelegationRecord, current: Awaited<ReturnType<WebDelegationAdapters["owner"]>>) {
  return JSON.stringify(record.owner) === JSON.stringify(current.binding)
    && JSON.stringify(record.session) === JSON.stringify(current.session);
}
/** Across a runtime restart, only a freshly proved matching login may read
 * the original exact Native thread. A session fingerprint is a live socket
 * binding, not a durable account identity. Submission still uses sameOwner. */
export function sameAccountOwner(record: WebDelegationRecord, current: Awaited<ReturnType<WebDelegationAdapters["owner"]>>) {
  return /^[a-f0-9]{64}$/.test(record.owner.accountFingerprint)
    && record.owner.slot === record.slot && record.session.slot === record.slot
    && current.binding.slot === record.slot && current.session.slot === record.slot
    && current.binding.accountFingerprint === record.owner.accountFingerprint
    && current.binding.routeFingerprint === current.session.responsesRouteFingerprint;
}

async function findDelegatedTurn(rpc: CodexAppServerRpc, threadId: string, turnId: string, signal: AbortSignal) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 64; page++) {
    const response = object(await rpc.request("thread/turns/list", {
      threadId, limit: 8, sortDirection: "desc", itemsView: "summary", ...(cursor ? { cursor } : {}),
    }, signal));
    if (!Array.isArray(response?.data)) throw Error("Web job turn summary is unavailable");
    const found = response.data.map(object).find(turn => turn?.id === turnId);
    if (found) return found;
    const next = response.nextCursor;
    if (next == null) return undefined;
    if (typeof next !== "string" || !next || next.length > 1024 || seen.has(next)) throw Error("Web job turn cursor is invalid");
    seen.add(next);
    cursor = next;
  }
  throw Error("Web job turn history exceeded recovery bound");
}

/** Only a newly-created one-turn thread can identify an unacknowledged first
 * send without a returned turn ID. A continuation or multiple candidate turns
 * remains uncertain; neither case is ever re-submitted. */
async function findUnacknowledgedFirstTurn(
  rpc: CodexAppServerRpc, record: WebDelegationRecord, signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (!record.threadId || record.parentJobId) return undefined;
  const response = object(await rpc.request("thread/turns/list", {
    threadId: record.threadId, limit: 2, sortDirection: "desc", itemsView: "summary",
  }, signal));
  const rows = response?.data;
  if (!Array.isArray(rows) || rows.length !== 1 || response?.nextCursor != null) return undefined;
  const turn = object(rows[0]);
  if (!turn || typeof turn.id !== "string" || !UUID.test(turn.id)
    || !Array.isArray(turn.items) || turn.items.length > 120) return undefined;
  const user = turn.items.map(object).filter(item => item?.type === "userMessage");
  if (user.length !== 1 || !Array.isArray(user[0]?.content) || user[0].content.length !== 1) return undefined;
  const part = object(user[0].content[0]);
  if (part?.type !== "text" || typeof part.text !== "string"
    || createHash("sha256").update(part.text).digest("hex") !== record.promptHash) return undefined;
  return turn;
}

/** Explicit coordinator adoption, with acknowledged delegation IDs and account proof. */
export async function linkNativeThreadForRetention(adapters: WebDelegationAdapters, evidence: NativeThreadOwnershipEvidence, signal: AbortSignal): Promise<WebDelegationRecord> {
  if (!Number.isSafeInteger(evidence.slot) || evidence.slot < 1 || evidence.slot > 99
    || typeof evidence.cwd !== "string" || !isAbsolute(evidence.cwd)
    || !Number.isSafeInteger(evidence.createdAt) || evidence.createdAt <= 0
    || !/^[a-f0-9]{64}$/.test(evidence.accountFingerprint)
    || !UUID.test(evidence.threadId) || evidence.turnId !== undefined && !UUID.test(evidence.turnId))
    throw Error("Native link creation evidence invalid");
  const current = await adapters.owner(evidence.slot);
  const record: WebDelegationRecord = {
    id: randomUUID(), slot: evidence.slot, cwd: evidence.cwd, createdAt: evidence.createdAt,
    state: "linked", owner: { ...current.binding, accountFingerprint: evidence.accountFingerprint },
    session: current.session, threadId: evidence.threadId,
    ...(evidence.turnId !== undefined ? { turnId: evidence.turnId } : {}),
    origin: "native-thread-link",
  };
  if (!sameAccountOwner(record, current)) throw Error("Native link account owner mismatch");
  const rpc = await adapters.connect(current.session.terminalEndpoint);
  try {
    const response = object(await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false }, signal));
    const thread = object(response?.thread);
    if (!thread || thread.id !== record.threadId || thread.cwd !== evidence.cwd) throw Error("Native link thread mismatch");
    if (!sameAccountOwner(record, await adapters.owner(evidence.slot))) throw Error("Native link owner changed");
    // Explicit user/coordinator adoption restores cleanup authority without
    // recreating an execution workspace or requiring deleted rollout history.
    const existing = adapters.store.recordsForThread({ slot: record.slot,
      accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! })
      .sort((a, b) => a.createdAt - b.createdAt).at(-1);
    const linked = existing ?? record;
    if (!existing) adapters.store.link(record);
    const path = webDelegationRetentionPath(adapters.store.root, { slot: record.slot,
      accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! });
    if (adapters.store.threadRetention(linked)?.state === "excluded") unlinkSync(path);
    adapters.changed?.(linked);
    return linked;
  } finally { await rpc.close(); }
}

/** A NEW durable Native-owned thread with an explicit sandbox, routed to Web.
 * Only an explicitly owned completed thread is eligible for continuation. */
export async function runWebDelegation(adapters: WebDelegationAdapters, input: {
  id: string; slot: number; cwd: string; prompt: string; signal: AbortSignal; parentJobId?: string;
  images?: readonly string[];
  coordinator?: { readonly slot: number; readonly threadId: string; readonly accountFingerprint: string };
}): Promise<WebDelegationRecord> {
  if (!UUID.test(input.id) || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 24 * 1024) throw Error("Invalid bounded Web delegation");
  if (realpathSync(input.cwd) !== input.cwd || !lstatSync(input.cwd).isDirectory()) throw Error("Web delegation requires an exact workspace");
  if ((input.images?.length ?? 0) > 8) throw Error("Web delegation image count exceeds Native ingress limit");
  const imageParts = (input.images ?? []).map(url => {
    const decoded = decodeNativeInlineEvidence(url);
    if (!decoded.mimeType.startsWith("image/")) throw Error("Web delegation image MIME is unsupported");
    return { type: "image" as const, url };
  });
  const owner = await adapters.owner(input.slot);
  let parent = input.parentJobId ? adapters.store.get(input.parentJobId) : undefined;
  if (input.parentJobId && (!parent || !parent.threadId || !parent.turnId || parent.slot !== input.slot
    || parent.cwd !== input.cwd || !sameAccountOwner(parent, owner))) {
    throw Error("Continuation requires an owned Web job in this checkout");
  }
  // A detached observer can leave a completed Native turn recorded as running.
  // Recover only this exact parent before checking its retained writer permit.
  if (parent && !verifiedWebDelegationAnswer(parent) && parent.state !== "failed"
    && parent.state !== "completed") {
    parent = await reconcileWebDelegation(adapters, parent.id, input.signal);
  }
  if (input.coordinator && (!UUID.test(input.coordinator.threadId)
    || !Number.isSafeInteger(input.coordinator.slot) || input.coordinator.slot < 1 || input.coordinator.slot > 99
    || !/^[a-f0-9]{64}$/.test(input.coordinator.accountFingerprint))) throw Error("Coordinator ownership link is invalid");
  let rpc: CodexAppServerRpc | undefined;
  let record: WebDelegationRecord | undefined;
  let reserved = false;
  let turnSubmissionAttempted = false;
  let reportedNativeCode: string | undefined;
  let reportedProviderReason: "unusual_activity" | undefined;
  let failureStageHint: WebDelegationFailureStage = "admission";
  let unsubscribe: (() => void) | undefined;
  try {
    record = { id: input.id, slot: input.slot, cwd: input.cwd, createdAt: Date.now(),
      promptHash: createHash("sha256").update(input.prompt).digest("hex"), owner: owner.binding,
      session: owner.session, state: "reserved", checkoutRoot: checkoutRoot(input.cwd),
      ...(parent?.coordinator || input.coordinator ? { coordinator: parent?.coordinator ?? input.coordinator } : {}),
      ...(parent ? { parentJobId: parent.id, threadId: parent.threadId } : {}) };
    // Admission is persistent and atomic before connecting to a model/provider.
    adapters.store.reserve(record);
    reserved = true;
    delegationBoundary(record.id, "job_reserved");
    adapters.changed?.(record);
    failureStageHint = "connect";
    rpc = await adapters.connect(owner.session.terminalEndpoint);
    failureStageHint = "subscribe";
    if (!rpc.subscribe) throw Error("Event-driven Web delegation is not supported by this engine");
    const selection = parent?.selection ?? selectDelegationWebModel(await rpc.request("model/list", { includeHidden: false }, input.signal));
    const update = (change: Partial<WebDelegationRecord>) => {
      record = adapters.store.save({ ...record!, ...change }); adapters.changed?.(record);
    };
    update({ selection });
    const prove = async () => { if (!sameOwner(record!, await adapters.owner(input.slot))) throw Error("Web job owner changed"); };
    failureStageHint = "owner_proof";
    await prove();
    failureStageHint = parent ? "thread_resume" : "thread_create";
    update({ state: "creating" });
    delegationBoundary(record.id, parent ? "thread_resume_requested" : "thread_create_requested");
    const sandbox = "workspace-write";
    if (parent) {
      // Direct user turns may follow the parent. The current tail must be settled.
      const response = object(await rpc.request("thread/turns/list", {
        threadId: parent.threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
      }, input.signal));
      const latest = Array.isArray(response?.data) ? object(response.data[0]) : undefined;
      if (!latest || !["completed", "failed", "interrupted"].some(status => status === latest.status)) {
        throw Error("Continuation thread has an unsettled last turn");
      }
      if (!sameOwner(parent, owner)) {
        const priorTurn = await findDelegatedTurn(rpc, parent.threadId!, parent.turnId!, input.signal);
        if (!priorTurn || !["completed", "failed", "interrupted"].some(status => status === priorTurn.status)) throw Error("Original Web turn is not proven on the current owner session");
      }
      // Each delegation opens a fresh connection. Attach it to this indexed
      // thread so turn/start's completion notifications reach this observer.
      await rpc.request("thread/resume", { threadId: parent.threadId, excludeTurns: true }, input.signal);
      update({ threadId: parent.threadId!, state: "created" });
    } else {
      const started = object(await rpc.request("thread/start", {
        cwd: input.cwd, model: selection.model, ephemeral: false, historyMode: "paginated",
        sandbox, approvalPolicy: "never",
      }, input.signal));
      const thread = object(started?.thread);
      if (!thread || typeof thread.id !== "string" || !UUID.test(thread.id)) throw Error("New Web job thread was not proven");
      delegationBoundary(record.id, "thread_acknowledged", { thread_fingerprint: diagnosticFingerprint(thread.id) });
      update({ threadId: thread.id, state: "created" });
      delegationBoundary(record.id, "thread_link_persisted", { thread_linked: true });
      const reportedSandbox = object(started?.sandbox)?.type;
      if (thread.cwd !== input.cwd || thread.ephemeral === true || thread.historyMode !== "paginated"
        || started?.model !== selection.model || started.approvalPolicy !== "never"
        || reportedSandbox !== "workspaceWrite") {
        throw Error("New Web job model or requested sandbox authority was not proven");
      }
    }
    await prove();
    // A Goal or queued continuation can start a turn without passing through our
    // turn/start arguments. Persist the same effective preset before submitting
    // any work on this owned delegation thread.
    failureStageHint = "settings_update";
    await rpc.request("thread/settings/update", {
      threadId: record.threadId,
      model: selection.model,
      effort: selection.effort,
      ...webDelegationTurnSettings(selection),
    }, input.signal);
    let resolveDone!: () => void, rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const messages = new Map<string, { text: string; phase?: string }>();
    const pending: Array<[string, Record<string, unknown>]> = [];
    let toolItems = 0, turnId: string | undefined, eventCount = 0, reportedStatus: string | undefined;
    const resultItems = new Set<string>();
    const progressProjection = new WebDelegationProgressProjection();
    const accept = (method: string, event: Record<string, unknown>) => {
      if (event.threadId !== record!.threadId) return;
      if (++eventCount > 10_000) { rejectDone(Error("Web job event bound exceeded")); return; }
      if (!turnId) {
        if (pending.length >= 256) { rejectDone(Error("Web job ACK event bound exceeded")); return; }
        if (method === "item/started" || method === "item/completed" || method === "turn/completed" || method === "item/reasoning/summaryPartAdded"
          || method === "item/reasoning/summaryTextDelta") pending.push([method, event]);
        return;
      }
      if (event.turnId === turnId) {
        const progress = progressProjection.observe(method, event, Date.now());
        if (progress) update({ progress });
      }
      if (method === "item/completed" && event.turnId === turnId) {
        const item = object(event.item);
        if (item?.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
          if (Buffer.byteLength(item.text) > MAX_RESULT_BYTES || messages.size >= 128) { rejectDone(Error("Web job answer bound exceeded")); return; }
          const totalBytes = [...messages].filter(([id]) => id !== item.id).reduce((sum, [, message]) => sum + Buffer.byteLength(message.text), Buffer.byteLength(item.text));
          if (totalBytes > MAX_RESULT_BYTES) { rejectDone(Error("Web job answer bound exceeded")); return; }
          messages.set(item.id, { text: item.text, ...(typeof item.phase === "string" ? { phase: item.phase } : {}) });
        } else if (typeof item?.type === "string" && TOOL_ITEM_TYPES.has(item.type)) {
          toolItems++;
          if (typeof item.id === "string" && hasNativeToolResult(item, true)) resultItems.add(item.id);
        }
      }
      if (method === "turn/completed") {
        const turn = object(event.turn);
        if (turn?.id !== turnId) return;
        reportedStatus = typeof turn.status === "string" ? turn.status : undefined;
        reportedNativeCode = nativeTurnFailureCode(turn);
        reportedProviderReason = nativeTurnProviderReason(turn);
        if (turn.status === "completed") resolveDone(); else rejectDone(Error("Web job turn failed"));
      }
    };
    unsubscribe = rpc.subscribe((method, params) => {
      const event = object(params); if (event) accept(method, event);
    }, () => rejectDone(Error("Web job connection lost")));
    const abort = () => rejectDone(Error("Web job observation stopped; inspect this job before retrying"));
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      input.signal.throwIfAborted();
      failureStageHint = "turn_submit";
      update({ state: "submitting" });
      const sandboxPolicy = { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false };
      turnSubmissionAttempted = true;
      const response = object(await rpc.request("turn/start", {
        threadId: record.threadId, ...webDelegationTurnSettings(selection),
        input: [{ type: "text", text: input.prompt, textElements: [] }, ...imageParts],
        sandboxPolicy, approvalPolicy: "never",
      }, input.signal));
      const turn = object(response?.turn);
      if (typeof turn?.id !== "string" || !UUID.test(turn.id)) throw Error("Web job submission ACK is uncertain");
      turnId = turn.id;
      update({ turnId, state: "running" });
      failureStageHint = "turn_observe";
      for (const [method, event] of pending) accept(method, event);
      pending.length = 0;
      try { await done; }
      catch (error) {
        if (reportedStatus === "failed" && error instanceof Error && error.message === "Web job turn failed") {
          const final = completedAnswer([...messages.values()]);
          if (final?.finalEvidence === "explicit-final-phase") {
            record = { ...record!, ...final, taskOutcome: "unassessed",
              toolItems, toolItemCoverage: "live-events", toolResultItems: resultItems.size, toolResultCoverage: "live-events" };
          }
        }
        throw error;
      }
      await prove();
      failureStageHint = "final_result";
      let completed = completedAnswer([...messages.values()]);
      if (!completed) {
        // Missing live item notifications do not prove that a completed turn
        // lacked a final. Read the exact indexed turn before releasing its lease.
        const turn = await findDelegatedTurn(rpc, record.threadId!, turnId!, input.signal);
        await prove();
        if (turn?.status !== "completed" || !Array.isArray(turn.items) || turn.items.length > 120) {
          throw Error("Web job indexed completion is not proven");
        }
        completed = completedAnswer(indexedMessages(turn.items));
      }
      if (completed && Buffer.byteLength(completed.answer) > MAX_RESULT_BYTES) completed = undefined;
      if (!completed) throw Error("Web job completed without a proven final answer");
      update({ state: "completed", taskOutcome: "unassessed", ...completed,
        toolItems, toolItemCoverage: "live-events", toolResultItems: resultItems.size, toolResultCoverage: "live-events" });
      return record;
    } finally { input.signal.removeEventListener("abort", abort); }
  } catch (error) {
    if (record && reserved) {
      const turnFailed = error instanceof Error && error.message === "Web job turn failed";
      const resultUnavailable = error instanceof Error && error.message === "Web job completed without a proven final answer";
      const state = turnFailed || resultUnavailable || !turnSubmissionAttempted ? "failed" : "uncertain";
      const stage = failureStage(error, failureStageHint);
      delegationBoundary(record.id, "execution_failed", { failure_stage: stage, thread_linked: Boolean(record.threadId) });
      const failedRecord: WebDelegationRecord = { ...record, state, failure: turnFailed ? "turn_failed" : resultUnavailable ? "result_unavailable" : "transport_or_ack",
        ...failureMetadata({ id: record.id, ...(record.threadId ? { threadId: record.threadId } : {}),
          ...(record.turnId ? { turnId: record.turnId } : {}), stage, error, nativeCode: reportedNativeCode, providerReason: reportedProviderReason, diagnosticRoot: adapters.diagnosticRoot }) };
      // Persist the failure evidence before any coordinator side effect. Keep
      // the receipt mutable until the Queue acknowledgement has been journaled.
      record = adapters.store.save({ ...failedRecord, state: "uncertain" }); adapters.changed?.(record);
      record = await notifyFailureCoordinator(adapters, record);
      record = adapters.store.save({ ...failedRecord,
        ...(record.coordinatorClientUserMessageId ? { coordinatorClientUserMessageId: record.coordinatorClientUserMessageId } : {}),
        ...(record.coordinatorQueueItemId ? { coordinatorQueueItemId: record.coordinatorQueueItemId } : {}),
        ...(record.coordinatorNotice ? { coordinatorNotice: record.coordinatorNotice } : {}),
        ...(record.coordinatorFollowThrough ? { coordinatorFollowThrough: record.coordinatorFollowThrough } : {}) });
      adapters.changed?.(record);
    } else {
      failureMetadata({ id: input.id, ...(record?.threadId ? { threadId: record.threadId } : {}),
        ...(record?.turnId ? { turnId: record.turnId } : {}), stage: failureStage(error, "admission"), error, diagnosticRoot: adapters.diagnosticRoot });
    }
    throw error;
  } finally { unsubscribe?.(); try { await rpc?.close(); } catch { /* Preserve the saved outcome. */ } }
}

/** Explicit, bounded recovery of this job only. Never resumes/replays a turn or reads personal history. */
export async function reconcileWebDelegation(adapters: WebDelegationAdapters, id: string, signal: AbortSignal): Promise<WebDelegationRecord> {
  let record = adapters.store.get(id);
  if (!record) throw Error("Web job was not found");
  if (verifiedWebDelegationAnswer(record)) return record;
  if (!record.threadId) throw Error("No acknowledged Web thread; do not retry an uncertain submission");
  if (!record.turnId && (record.parentJobId || record.state !== "uncertain")) {
    throw Error("No acknowledged Web turn; do not retry an uncertain submission");
  }
  try {
  const current = await adapters.owner(record.slot);
  if (!sameAccountOwner(record, current)) throw Error("Web job owner changed");
  const rpc = await adapters.connect(current.session.terminalEndpoint);
  try {
    const turn = record.turnId
      ? await findDelegatedTurn(rpc, record.threadId, record.turnId, signal)
      : await findUnacknowledgedFirstTurn(rpc, record, signal);
    if (!turn) throw Error(record.turnId ? "Web job turn is not in bounded history"
      : "Unacknowledged Web turn cannot be uniquely proven from its exact input");
    const after = await adapters.owner(record.slot);
    if (!sameAccountOwner(record, after) || JSON.stringify(current) !== JSON.stringify(after)) {
      throw Error("Web job owner changed during recovery");
    }
    if (!record.turnId) {
      const { failure: _failure, ...prior } = record;
      record = adapters.store.save({ ...prior, turnId: turn.id as string, state: "running" });
    }
    if (turn.status === "inProgress") {
      const progress = Array.isArray(turn.items) && turn.items.length <= 120
        ? indexedWebDelegationProgress(turn.items, Date.now()) : undefined;
      const { failureStage: _stage, failureClass: _class, failureNativeCode: _code,
        failureIncidentRef: _incident, failureIncidentState: _incidentState,
        failureNextAction: _action, failureDiagnostics: _diagnostics, ...active } = record;
      record = adapters.store.save({ ...active, reconciliation: "native-in-progress",
        ...(progress ? { progress } : {}) });
      adapters.changed?.(record);
      return record;
    }
    if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") {
      throw Error("Web job completion is not proven");
    }
    const items = Array.isArray(turn.items) && turn.items.length <= 120 ? turn.items.map(object) : undefined;
    if (turn.status === "completed" && !items) throw Error("Web job completion is not proven");
    const completed = items ? completedAnswer(indexedMessages(items)) : undefined;
    const final = completed && Buffer.byteLength(completed.answer) <= MAX_RESULT_BYTES ? completed : undefined;
    const observations = items ? {
      toolItems: Math.max(record.toolItems ?? 0, items.filter(item => typeof item?.type === "string" && TOOL_ITEM_TYPES.has(item.type)).length),
      toolItemCoverage: record.toolItemCoverage ?? "history-summary",
      toolResultItems: Math.max(record.toolResultItems ?? 0, items.filter(item => hasNativeToolResult(item, false)).length),
      toolResultCoverage: record.toolResultCoverage ?? "history-summary",
    } as const : {};
    if (turn.status === "failed" || turn.status === "interrupted") {
      const settled = adapters.store.save({ ...record, ...observations, state: "failed", failure: "turn_failed",
        ...failureMetadata({ id: record.id, ...(record.threadId ? { threadId: record.threadId } : {}),
          ...(record.turnId ? { turnId: record.turnId } : {}), stage: "turn_complete", error: new Error("Web job turn failed"), nativeCode: nativeTurnFailureCode(turn), providerReason: nativeTurnProviderReason(turn), diagnosticRoot: adapters.diagnosticRoot }),
        ...(turn.status === "failed" && final?.finalEvidence === "explicit-final-phase"
          ? { ...final, taskOutcome: "unassessed" as const } : {}) });
      adapters.changed?.(settled);
      return settled;
    }
    // Both live and recovery paths release the permit only after the exact
    // completed turn's bounded indexed items prove no deliverable final.
    if (!final) {
      const settled = adapters.store.save({ ...record, ...observations, state: "failed", failure: "result_unavailable",
        ...failureMetadata({ id: record.id, ...(record.threadId ? { threadId: record.threadId } : {}),
          ...(record.turnId ? { turnId: record.turnId } : {}), stage: "reconcile_result", error: new Error("Web job completed without a proven final answer"), diagnosticRoot: adapters.diagnosticRoot }) });
      adapters.changed?.(settled);
      return settled;
    }
    const { failure: _failure, failureStage: _stage, failureClass: _class, failureNativeCode: _code,
      failureIncidentRef: _incident, failureIncidentState: _incidentState, failureNextAction: _action, failureDiagnostics: _diagnostics, ...resolved } = record;
    const { reconciliation: _reconciliation, ...completedRecord } = resolved;
    const settled = adapters.store.save({ ...completedRecord, ...observations, state: "completed", taskOutcome: "unassessed", ...final });
    adapters.changed?.(settled);
    return settled;
  } finally { try { await rpc.close(); } catch { /* Preserve a proven recovery result. */ } }
  } catch (error) {
    const current = adapters.store.get(id);
    if (current && !verifiedWebDelegationAnswer(current) && current.state !== "completed") {
      const stage = failureStage(error, "reconcile_history");
      const metadata = failureMetadata({ id: current.id, ...(current.threadId ? { threadId: current.threadId } : {}),
        ...(current.turnId ? { turnId: current.turnId } : {}), stage, error, diagnosticRoot: adapters.diagnosticRoot });
      const observed = adapters.store.save({ ...current, ...metadata, reconciliation: "unproven" });
      adapters.changed?.(observed);
    }
    throw error;
  }
}
