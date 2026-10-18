import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, writeFileSync, fsyncSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";
import { selectDelegationWebModel, type DelegationWebModel } from "./web-delegation-model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESULT_BYTES = 512 * 1024;
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
  readonly cwd: string;
  readonly createdAt: number;
  readonly promptHash: string;
  readonly owner: LocalProfileBinding;
  readonly session: TrustedNativeProfileSession;
  readonly selection: DelegationWebModel;
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
  readonly failure?: "owner_changed" | "transport_or_ack" | "turn_failed" | "result_unavailable";
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
  get(id: string): WebDelegationRecord | undefined {
    const path = this.#path(id);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESULT_BYTES + 32 * 1024) throw Error("Invalid Web job record");
    const value = JSON.parse(readFileSync(path, "utf8")) as WebDelegationRecord;
    if (value.id !== id || !UUID.test(value.id) || !["reserved", "creating", "created", "submitting", "running", "completed", "failed", "uncertain"].includes(value.state)) throw Error("Invalid Web job record");
    return value;
  }
  reserve(record: WebDelegationRecord): void {
    if (readdirSync(this.root).filter(name => name.endsWith(".json")).length >= 64) throw Error("Web job store is full; review and remove finished jobs first");
    const fd = openSync(this.#path(record.id), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  }
  save(record: WebDelegationRecord): WebDelegationRecord {
    if (!this.get(record.id)) throw Error("Web job was not reserved");
    const path = this.#path(record.id), temporary = `${path}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    const current = this.get(record.id)!;
    // A late observer timeout must not overwrite a result already reconciled by another command.
    if (current.state === "completed" && current.finalEvidence) {
      closeSync(fd); unlinkSync(temporary); return current;
    }
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    return record;
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
function sameOwner(record: WebDelegationRecord, current: Awaited<ReturnType<WebDelegationAdapters["owner"]>>) {
  return JSON.stringify(record.owner) === JSON.stringify(current.binding)
    && JSON.stringify(record.session) === JSON.stringify(current.session);
}

/** A NEW durable read-only Native-owned thread, routed to Web by the existing provider. Never resumes a personal thread. */
export async function runReadOnlyWebDelegation(adapters: WebDelegationAdapters, input: {
  id: string; slot: number; cwd: string; prompt: string; signal: AbortSignal;
}): Promise<WebDelegationRecord> {
  if (!UUID.test(input.id) || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 24 * 1024) throw Error("Invalid bounded Web delegation");
  if (realpathSync(input.cwd) !== input.cwd || !lstatSync(input.cwd).isDirectory()) throw Error("Web delegation requires an exact workspace");
  const owner = await adapters.owner(input.slot);
  const rpc = await adapters.connect(owner.session.terminalEndpoint);
  let record: WebDelegationRecord | undefined;
  let reserved = false;
  let unsubscribe: (() => void) | undefined;
  try {
    if (!rpc.subscribe) throw Error("Event-driven Web delegation is not supported by this engine");
    const selection = selectDelegationWebModel(await rpc.request("model/list", { includeHidden: false }, input.signal));
    record = { id: input.id, slot: input.slot, cwd: input.cwd, createdAt: Date.now(), promptHash: createHash("sha256").update(input.prompt).digest("hex"), owner: owner.binding, session: owner.session, selection, state: "reserved" };
    adapters.store.reserve(record);
    reserved = true;
    const update = (change: Partial<WebDelegationRecord>) => {
      record = adapters.store.save({ ...record!, ...change }); adapters.changed?.(record);
    };
    const prove = async () => { if (!sameOwner(record!, await adapters.owner(input.slot))) throw Error("Web job owner changed"); };
    await prove();
    update({ state: "creating" });
    const started = object(await rpc.request("thread/start", {
      cwd: input.cwd, model: selection.model, ephemeral: false, historyMode: "paginated",
      sandbox: "read-only", approvalPolicy: "never",
    }, input.signal));
    const thread = object(started?.thread);
    if (!thread || typeof thread.id !== "string" || !UUID.test(thread.id)) throw Error("New Web job thread was not proven");
    update({ threadId: thread.id, state: "created" });
    if (thread.cwd !== input.cwd || thread.ephemeral === true || thread.historyMode !== "paginated"
      || started?.model !== selection.model || started.approvalPolicy !== "never"
      || object(started.sandbox)?.type !== "readOnly") throw Error("New Web job model or read-only authority was not proven");
    await prove();
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
        sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never",
      }, input.signal));
      const turn = object(response?.turn);
      if (typeof turn?.id !== "string" || !UUID.test(turn.id)) throw Error("Web job submission ACK is uncertain");
      turnId = turn.id;
      update({ turnId, state: "running" });
      for (const [method, event] of pending) accept(method, event);
      pending.length = 0;
      await done;
      await prove();
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
  } finally { unsubscribe?.(); await rpc.close(); }
}

/** Explicit, bounded recovery of this job only. Never resumes/replays a turn or reads personal history. */
export async function reconcileWebDelegation(adapters: WebDelegationAdapters, id: string, signal: AbortSignal): Promise<WebDelegationRecord> {
  const record = adapters.store.get(id);
  if (!record) throw Error("Web job was not found");
  if (record.state === "completed" && record.finalEvidence) return record;
  if (!record.threadId || !record.turnId) throw Error("No acknowledged Web turn; do not retry an uncertain submission");
  if (!sameOwner(record, await adapters.owner(record.slot))) throw Error("Web job owner changed");
  const rpc = await adapters.connect(record.session.terminalEndpoint);
  try {
    const response = object(await rpc.request("thread/turns/list", {
      threadId: record.threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
    }, signal));
    if (!Array.isArray(response?.data) || response.data.length !== 1) throw Error("Web job turn summary is unavailable");
    const turn = object(response.data[0]);
    if (turn?.id !== record.turnId) throw Error("Web job turn changed");
    if (!sameOwner(record, await adapters.owner(record.slot))) throw Error("Web job owner changed during recovery");
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
