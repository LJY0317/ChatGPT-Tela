import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, linkSync, writeFileSync, fsyncSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { CodexWebDelegationCapacityContract, WebDelegationBlockCode, WebDelegationMode } from "@chatgpt-tela/service-protocol";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";
import { selectDelegationWebModel, type DelegationWebModel } from "./web-delegation-model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_RETAINED_JOBS = 64;
// Temporary managed CLI policy. One exclusive file per execution slot.
const READERS_PER_PROFILE = 2, WRITERS_PER_PROFILE = 1, TOTAL_PER_PROFILE = 3;
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
export type WebDelegationState = "reserved" | "creating" | "created" | "submitting" | "running" | "completed" | "failed" | "uncertain";
export interface WebDelegationRecord {
  readonly id: string;
  readonly slot: number;
  /** Older read-only records omitted this field. */
  readonly mode?: WebDelegationMode;
  readonly cwd: string;
  readonly createdAt: number;
  readonly promptHash: string;
  readonly owner: LocalProfileBinding;
  readonly session: TrustedNativeProfileSession;
  readonly selection?: DelegationWebModel;
  readonly state: WebDelegationState;
  readonly threadId?: string;
  readonly turnId?: string;
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
  readonly failure?: "transport_or_ack" | "turn_failed" | "result_unavailable";
}
/** One final-answer contract shared by live result, recovery and CLI delivery. */
export function verifiedWebDelegationAnswer(record: WebDelegationRecord): string | undefined {
  return record.state === "completed" && record.finalEvidence && record.answer?.trim()
    ? record.answer : undefined;
}

/** Private user data, outside repositories/logs/releases. Hard capacity bounds retention without deleting results. */
export class WebDelegationStore {
  readonly fingerprintKey: Uint8Array;
  constructor(readonly root: string) {
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
  #permits(slot: number, mode: WebDelegationMode): string[] {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw Error("Invalid Web profile slot");
    return mode === "write" ? [join(this.root, `writer-${slot}.lease`)]
      : [join(this.root, `reader-${slot}.lease`), join(this.root, `reader-${slot}-2.lease`)];
  }
  #checkoutPermit(cwd: string): string {
    return join(this.root, `writer-checkout-${createHash("sha256").update(cwd).digest("hex")}.lease`);
  }
  #retained(): string[] { return readdirSync(this.root).filter(name => name.endsWith(".json")); }
  #leaseOwner(path: string): "free" | "unknown" | string {
    if (!existsSync(path)) return "free";
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 36) return "unknown";
    const id = readFileSync(path, "utf8");
    return UUID.test(id) ? id : "unknown";
  }
  #terminal(record: WebDelegationRecord): boolean {
    return Boolean(verifiedWebDelegationAnswer(record))
      || record.state === "failed" && (record.failure === "turn_failed" || !record.turnId);
  }
  #release(record: WebDelegationRecord): void {
    if (!this.#terminal(record)) return;
    const saved = this.get(record.id);
    if (!saved || !this.#terminal(saved) || saved.slot !== record.slot) return;
    const paths = [...this.#permits(record.slot, record.mode ?? "read"),
      ...(record.mode === "write" ? [this.#checkoutPermit(record.cwd)] : [])];
    for (const path of paths) if (this.#leaseOwner(path) === record.id) unlinkSync(path);
  }
  capacity(slot: number, mode: WebDelegationMode = "read", cwd?: string): WebDelegationCapacity {
    const readers = this.#permits(slot, "read").map(path => this.#leaseOwner(path));
    const writers = this.#permits(slot, "write").map(path => this.#leaseOwner(path));
    const all = [...readers, ...writers], retained = this.#retained();
    const held = new Set(all.filter(id => id !== "free" && id !== "unknown"));
    const unknown = (leases: readonly string[]) => leases.filter(id => id === "unknown"
      || id !== "free" && (!this.get(id) || this.get(id)?.state === "uncertain")).length;
    const readUsed = readers.filter(id => id !== "free").length, writeUsed = writers.filter(id => id !== "free").length;
    const used = readUsed + writeUsed;
    const liveRecords = retained.slice(0, MAX_RETAINED_JOBS + 1).flatMap(name => {
      const id = name.slice(0, -5);
      if (!UUID.test(id)) return [];
      const job = this.get(id);
      return job?.slot === slot && !this.#terminal(job) ? [job] : [];
    });
    const orphaned = liveRecords.some(job => !held.has(job.id));
    const selected = mode === "write" ? writers : readers;
    const selectedUsed = mode === "write" ? writeUsed : readUsed;
    const selectedLimit = mode === "write" ? WRITERS_PER_PROFILE : READERS_PER_PROFILE;
    const checkout = mode === "write" && cwd ? this.#leaseOwner(this.#checkoutPermit(cwd)) : "free";
    const blockCode: WebDelegationBlockCode | undefined = retained.length >= MAX_RETAINED_JOBS ? "CAPACITY_STORAGE_RECORDS"
      : orphaned ? "UNCERTAIN_RESERVATION"
        : checkout !== "free" ? checkout === "unknown" ? "UNCERTAIN_RESERVATION" : "CAPACITY_WRITER_CHECKOUT"
          : used >= TOTAL_PER_PROFILE ? "CAPACITY_TOTAL_PROFILE"
            : selectedUsed >= selectedLimit ? unknown(selected) ? "UNCERTAIN_RESERVATION"
              : mode === "write" ? "CAPACITY_WRITER_PROFILE" : "CAPACITY_READER_PROFILE" : undefined;
    const statusKo = `프로필 ${slot}: 쓰기 ${writeUsed}/1, 읽기 ${readUsed}/2, 총 ${used}/3`;
    const statusEn = `Profile ${slot}: write ${writeUsed}/1, read ${readUsed}/2, total ${used}/3`;
    const reasonKo = blockCode === "CAPACITY_STORAGE_RECORDS" ? `보관 기록 ${retained.length}/64개로 가득 찼습니다. 완료 기록을 검토하세요.`
      : blockCode === "UNCERTAIN_RESERVATION" ? "기존 작업의 종료가 불확실합니다. 해당 작업을 조회·복구하세요."
        : blockCode === "CAPACITY_WRITER_CHECKOUT" ? "이 작업 디렉터리에서 다른 쓰기 위임이 진행 중입니다."
          : blockCode ? "실행 한도에 도달했습니다. 진행 중인 작업이 끝난 후 다시 시도하세요."
            : "관리되는 슬롯이 사용 가능합니다. 실제 계정 준비 상태는 별도로 확인됩니다.";
    const reasonEn = blockCode === "CAPACITY_STORAGE_RECORDS" ? `Retained records ${retained.length}/64 full; review finished jobs.`
      : blockCode === "UNCERTAIN_RESERVATION" ? "An earlier job is unresolved; inspect and reconcile it."
        : blockCode === "CAPACITY_WRITER_CHECKOUT" ? "Another write delegation holds this checkout."
          : blockCode ? "Concurrency limit reached; retry after active work finishes."
            : "Managed slot available; account readiness is checked separately.";
    return { contractVersion: 1, source: "managed_delegation_journal", observedAt: new Date().toISOString(), profileSlot: slot,
      coverage: "managed_jobs_only",
      policy: "temporary_1_writer_2_readers_v1", requestedMode: mode,
      readers: { used: readUsed, limit: READERS_PER_PROFILE, uncertain: unknown(readers) },
      writers: { used: writeUsed, limit: WRITERS_PER_PROFILE, uncertain: unknown(writers) },
      total: { used, limit: TOTAL_PER_PROFILE },
      records: { retained: retained.length, limit: MAX_RETAINED_JOBS }, available: !blockCode, ...(blockCode ? { blockCode } : {}),
      messageKo: `${statusKo}. ${reasonKo}`, messageEn: `${statusEn}. ${reasonEn}`,
      nextAction: blockCode === "CAPACITY_STORAGE_RECORDS" ? "review_owned_finished_records"
        : blockCode === "UNCERTAIN_RESERVATION" ? "inspect_and_reconcile_exact_job"
          : blockCode ? "wait_for_active_job" : "start_if_profile_ready" };
  }
  #read(path: string, id: string): WebDelegationRecord | undefined {
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_RESULT_BYTES + 32 * 1024) throw Error("Invalid Web job record");
    const value = JSON.parse(readFileSync(path, "utf8")) as WebDelegationRecord;
    if (value.id !== id || !UUID.test(value.id) || !["reserved", "creating", "created", "submitting", "running", "completed", "failed", "uncertain"].includes(value.state)) throw Error("Invalid Web job record");
    return value;
  }
  get(id: string): WebDelegationRecord | undefined {
    const path = this.#path(id);
    // Immutable terminal receipts win over late observer updates. A final can
    // supersede a previously observed failure, but an old timeout cannot erase
    // a proven answer. No separate result inbox or replay path is introduced.
    return this.#read(`${path}.completed`, id) ?? this.#read(`${path}.failed`, id) ?? this.#read(path, id);
  }
  reserve(record: WebDelegationRecord): void {
    const mode = record.mode ?? "read";
    // Exact terminal journal proofs can release stale permits after a crash.
    for (const lease of [...this.#permits(record.slot, "read"), ...this.#permits(record.slot, "write"),
      ...(mode === "write" ? [this.#checkoutPermit(record.cwd)] : [])]) {
      const owner = this.#leaseOwner(lease);
      if (owner !== "free" && owner !== "unknown") {
        const previous = this.get(owner);
        if (previous) this.#release(previous);
      }
    }
    const available = this.capacity(record.slot, mode, record.cwd);
    if (!available.available) throw new WebDelegationCapacityError(available);
    const path = this.#path(record.id), fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    // Exclusive creation is the admission boundary. An unresolved partial
    // reservation stays fenced rather than allowing an extra model send.
    const claimed: string[] = [];
    try {
      const paths = this.#permits(record.slot, mode);
      const chosen = paths.find(p => this.#leaseOwner(p) === "free");
      if (!chosen) throw Object.assign(new Error("profile capacity changed"), { code: "EEXIST" });
      const claims = mode === "write" ? [this.#checkoutPermit(record.cwd), chosen] : [chosen];
      for (const lease of claims) {
        const leaseFd = openSync(lease, "wx", 0o600);
        claimed.push(lease);
        try { writeFileSync(leaseFd, record.id); fsyncSync(leaseFd); } finally { closeSync(leaseFd); }
      }
    } catch (error) {
      if (claimed.length === 0) unlinkSync(path);
      const capacity = this.capacity(record.slot, mode, record.cwd);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WebDelegationCapacityError({
        ...capacity, available: false,
        blockCode: capacity.blockCode ?? (mode === "write" ? "CAPACITY_WRITER_PROFILE" : "CAPACITY_READER_PROFILE"),
        nextAction: "wait_for_active_job",
      });
      throw error;
    }
  }
  save(record: WebDelegationRecord): WebDelegationRecord {
    const current = this.get(record.id);
    if (!current) throw Error("Web job was not reserved");
    if (verifiedWebDelegationAnswer(current) || this.#terminal(current) && !verifiedWebDelegationAnswer(record)) {
      this.#release(current);
      return current;
    }
    const path = this.#path(record.id), temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
      if (this.#terminal(record)) {
        // link() publishes a *complete* terminal record once, atomically and
        // without replacing another process's receipt. The base snapshot can
        // still change, but get() always prefers the immutable terminal proof.
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
export interface WebDelegationAdapters {
  owner(slot: number): Promise<{ binding: LocalProfileBinding; session: TrustedNativeProfileSession }>;
  connect(endpoint: string): Promise<CodexAppServerRpc>;
  store: WebDelegationStore;
  changed?(record: WebDelegationRecord): void;
}
/** A NEW durable Native-owned thread with an explicit sandbox, routed to Web.
 * The provider receives unrestricted execution authority for this delegation. */
export async function runWebDelegation(adapters: WebDelegationAdapters, input: {
  id: string; slot: number; cwd: string; prompt: string; signal: AbortSignal; mode?: WebDelegationMode;
}): Promise<WebDelegationRecord> {
  if (!UUID.test(input.id) || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 24 * 1024) throw Error("Invalid bounded Web delegation");
  if (realpathSync(input.cwd) !== input.cwd || !lstatSync(input.cwd).isDirectory()) throw Error("Web delegation requires an exact workspace");
  const mode = input.mode ?? "read";
  if (mode !== "read" && mode !== "write") throw Error("Invalid Web delegation mode");
  const owner = await adapters.owner(input.slot);
  let rpc: CodexAppServerRpc | undefined;
  let record: WebDelegationRecord | undefined;
  let reserved = false;
  let unsubscribe: (() => void) | undefined;
  try {
    record = { id: input.id, slot: input.slot, cwd: input.cwd, createdAt: Date.now(),
      promptHash: createHash("sha256").update(input.prompt).digest("hex"), owner: owner.binding,
      session: owner.session, mode, state: "reserved" };
    // Admission is persistent and atomic before connecting to a model/provider.
    adapters.store.reserve(record);
    reserved = true;
    adapters.changed?.(record);
    rpc = await adapters.connect(owner.session.terminalEndpoint);
    if (!rpc.subscribe) throw Error("Event-driven Web delegation is not supported by this engine");
    const selection = selectDelegationWebModel(await rpc.request("model/list", { includeHidden: false }, input.signal));
    const update = (change: Partial<WebDelegationRecord>) => {
      record = adapters.store.save({ ...record!, ...change }); adapters.changed?.(record);
    };
    update({ selection });
    const prove = async () => {};
    update({ state: "creating" });
    const started = object(await rpc.request("thread/start", {
      cwd: input.cwd, model: selection.model, ephemeral: false, historyMode: "paginated",
    }, input.signal));
    const thread = object(started?.thread);
    if (!thread || typeof thread.id !== "string" || !UUID.test(thread.id)) throw Error("New Web job thread was not proven");
    update({ threadId: thread.id, state: "created" });
    let resolveDone!: () => void, rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const messages = new Map<string, { text: string; phase?: string }>();
    const pending: Array<[string, Record<string, unknown>]> = [];
    let toolItems = 0, turnId: string | undefined, eventCount = 0;
    const resultItems = new Set<string>();
    const accept = (method: string, event: Record<string, unknown>) => {
      if (event.threadId !== record!.threadId) return;
      if (++eventCount > 10_000) { rejectDone(Error("Web job event bound exceeded")); return; }
      if (!turnId) {
        if (pending.length >= 256) { rejectDone(Error("Web job ACK event bound exceeded")); return; }
        if (method === "item/completed" || method === "turn/completed") pending.push([method, event]);
        return;
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
      update({ state: "submitting" });
      const response = object(await rpc.request("turn/start", {
        threadId: record.threadId, model: selection.model, effort: selection.effort,
        input: [{ type: "text", text: input.prompt, textElements: [] }],
      }, input.signal));
      const turn = object(response?.turn);
      if (typeof turn?.id !== "string" || !UUID.test(turn.id)) throw Error("Web job submission ACK is uncertain");
      turnId = turn.id;
      update({ turnId, state: "running" });
      for (const [method, event] of pending) accept(method, event);
      pending.length = 0;
      await done;
      const completed = completedAnswer([...messages.values()]);
      if (!completed) throw Error("Web job completed without a proven final answer");
      update({ state: "completed", taskOutcome: "unassessed", ...completed,
        toolItems, toolItemCoverage: "live-events", toolResultItems: resultItems.size, toolResultCoverage: "live-events" });
      return record;
    } finally { input.signal.removeEventListener("abort", abort); }
  } catch (error) {
    if (record && reserved) {
      const turnFailed = error instanceof Error && error.message === "Web job turn failed";
      const state = turnFailed || record.state === "reserved" || record.state === "created" ? "failed" : "uncertain";
      record = { ...record, state, failure: turnFailed ? "turn_failed" : "transport_or_ack" };
      record = adapters.store.save(record); adapters.changed?.(record);
    }
    throw error;
  } finally { unsubscribe?.(); await rpc?.close(); }
}

/** Explicit, bounded recovery of this job only. Never resumes/replays a turn or reads personal history. */
export async function reconcileWebDelegation(adapters: WebDelegationAdapters, id: string, signal: AbortSignal): Promise<WebDelegationRecord> {
  const record = adapters.store.get(id);
  if (!record) throw Error("Web job was not found");
  if (verifiedWebDelegationAnswer(record)) return record;
  if (!record.threadId || !record.turnId) throw Error("No acknowledged Web turn; do not retry an uncertain submission");
  const rpc = await adapters.connect(record.session.terminalEndpoint);
  try {
    const response = object(await rpc.request("thread/turns/list", {
      threadId: record.threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
    }, signal));
    if (!Array.isArray(response?.data) || response.data.length !== 1) throw Error("Web job turn summary is unavailable");
    const turn = object(response.data[0]);
    if (turn?.id !== record.turnId) throw Error("Web job turn changed");
    if (turn.status === "inProgress") return record;
    if (turn.status === "failed" || turn.status === "interrupted") {
      return adapters.store.save({ ...record, state: "failed", failure: "turn_failed" });
    }
    if (turn.status !== "completed" || !Array.isArray(turn.items) || turn.items.length > 120) throw Error("Web job completion is not proven");
    const items = turn.items.map(object);
    const messages = items.filter(item => item?.type === "agentMessage" && typeof item.text === "string");
    const completed = completedAnswer(messages.filter((item): item is Record<string, unknown> =>
      item !== undefined).map(item => ({
      text: item.text as string, ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
    })));
    if (!completed || Buffer.byteLength(completed.answer) > MAX_RESULT_BYTES) throw Error("Web final answer is not bounded and proven");
    return adapters.store.save({ ...record, state: "completed", taskOutcome: "unassessed", ...completed,
      toolItems: Math.max(record.toolItems ?? 0, items.filter(item => typeof item?.type === "string" && TOOL_ITEM_TYPES.has(item.type)).length),
      toolItemCoverage: record.toolItemCoverage ?? "history-summary",
      toolResultItems: Math.max(record.toolResultItems ?? 0, items.filter(item => hasNativeToolResult(item, false)).length),
      toolResultCoverage: record.toolResultCoverage ?? "history-summary",
    });
  } finally { await rpc.close(); }
}
