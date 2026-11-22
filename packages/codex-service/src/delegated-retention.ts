import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndexedNativeItemsPage, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { acknowledgeNativeResult, assertManagedThread, findFinalAnswer, findSavedFinal, persistResultAcknowledgement, readExactResultTurn, readFirstResultTurn, readLatestResultTurn, readPreviousResultAnswer, type ResultAcknowledgement, type ResultReference } from "./result-acknowledgement";

const DAY = 86_400_000, MAX_BYTES = 4 * 1024 * 1024, MAX_RECORD_BYTES = 8192;
const HALF_DAY = DAY / 2, METADATA_RETENTION = 60 * DAY;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type State = {
  version: 1; scope: string; slot: number; parentThreadId?: string; threadId: string;
  enrolledAt: number; dueAt: number; pendingFirstTurnId?: string; firstTurnId?: string;
  latestAcceptedTurnId?: string; latestAcceptedAt?: number; acknowledgement?: ResultAcknowledgement;
  dispatch?: { coordinatorThreadId: string; promptDigest: string; webAccountFingerprint?: string };
  archivedAt?: number; releasedAt?: number; archivePending?: true; reviewAfter?: number; issue?: string; title?: string;
};
const coordinator = (record: State) => record.dispatch?.coordinatorThreadId ?? record.parentThreadId;
const settledAt = (record: State) => record.archivedAt ?? record.releasedAt;
function settledExpired(record: State, observedAt: number): boolean {
  const settled = settledAt(record);
  return settled != null && observedAt - settled > METADATA_RETENTION;
}
export interface DelegatedRetentionProfile {
  /** Install identity + exact configured profile/home; never a model-supplied label. */
  scope: string;
  webAccountFingerprint?(): string | undefined;
  readSavedWebAnswer?(accountFingerprint: string, threadId: string, turnId: string): Promise<string | undefined>;
  connect(threadId: string, lifecycle: boolean, delegatedTitle?: boolean): Promise<CodexAppServerRpc>;
}
function id(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw Error("Invalid delegation identity");
  return value;
}
/** Exactly two clocks. Observations, failures and missing metadata cannot extend either. */
function archiveDeadline(record: State, latestAnswerVerified: boolean): number {
  const ack = record.acknowledgement;
  const collectedAt = latestAnswerVerified && ack?.result.outcome === "answer" ? Date.parse(ack.acknowledgedAt) : NaN;
  return Number.isFinite(collectedAt) ? collectedAt + HALF_DAY : (record.latestAcceptedAt ?? record.enrolledAt) + 7 * DAY;
}

/** A restored child can move between active/archived list queries. Native
 * creation items remain evidence even if both bucket queries miss that move. */
async function hasSpawnHistory(rpc: CodexAppServerRpc, threadId: string): Promise<boolean> {
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await readIndexedNativeItemsPage(rpc, { threadId, limit: 32, sortDirection: "desc",
      ...(cursor ? { cursor } : {}),
    });
    if (page.data.some(({ item }) => (
      item.type === "collabAgentToolCall" && item.tool === "spawnAgent"
        && Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0
    ) || (
      item.type === "subAgentActivity" && item.kind === "started"
        && typeof item.agentThreadId === "string" && item.agentThreadId.length > 0 && item.agentThreadId !== threadId
    ))) return true;
    if (page.nextCursor == null) return false;
    if (typeof page.nextCursor !== "string" || visited.has(page.nextCursor)) throw Error("Official creation history paging did not advance");
    cursor = page.nextCursor;
    visited.add(cursor);
  } while (cursor);
  return false;
}

/** One existing service owns writes and one next-due timer. No conversation scans or model requests. */
export function createDelegatedRetention(input: {
  directory: string; acknowledgementDirectory: string;
  profile(slot: number): DelegatedRetentionProfile;
  now?: () => number;
  /** Tests can drive exact deadlines without waiting hours. */
  automatic?: boolean;
}) {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const root = lstatSync(input.directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error("Invalid delegation state directory");
  const now = input.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false, queue = Promise.resolve();
  let automaticReviewAfter = 0;
  const records = new Map<string, State>();
  const unreadable = new Set<string>();
  let unreadableBytes = 0;
  const key = (scope: string, threadId: string) => hash(JSON.stringify([scope, threadId]));
  const path = (k: string) => join(input.directory, k + ".json");
  // This service is the single writer. Interrupted atomic-write scratch files
  // contain no independent record and are reproducible from the committed file.
  for (const file of readdirSync(input.directory).filter(n => /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(n))) {
    const scratch = join(input.directory, file), stat = lstatSync(scratch);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(scratch);
  }
  for (const file of readdirSync(input.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const k = file.slice(0, -5);
    let size = MAX_RECORD_BYTES;
    try {
      const stat = lstatSync(path(k));
      size = stat.size;
      if (!stat.isFile() || stat.isSymbolicLink() || size > MAX_RECORD_BYTES) throw Error("Invalid delegation state file");
      const record = JSON.parse(readFileSync(path(k), "utf8")) as State;
      if (record.version !== 1 || !Number.isInteger(record.slot) || record.slot < 1 || record.slot > 99
        || !/^[a-f0-9]{64}$/.test(record.scope) || !Number.isFinite(record.enrolledAt)
        || !Number.isFinite(record.dueAt) || record.reviewAfter != null && !Number.isFinite(record.reviewAfter)
        || record.archivedAt != null && !Number.isFinite(record.archivedAt)
        || record.releasedAt != null && !Number.isFinite(record.releasedAt)
        || key(record.scope, id(record.threadId)) !== k) throw Error("Invalid delegation state");
      if (record.parentThreadId !== undefined) id(record.parentThreadId);
      if (record.pendingFirstTurnId !== undefined) id(record.pendingFirstTurnId);
      if (record.firstTurnId !== undefined) id(record.firstTurnId);
      if (record.latestAcceptedTurnId !== undefined) id(record.latestAcceptedTurnId);
      if (record.latestAcceptedAt !== undefined && !Number.isFinite(record.latestAcceptedAt)) throw Error("Invalid accepted turn time");
      if (record.dispatch !== undefined && (record.parentThreadId !== undefined
        || !id(record.dispatch.coordinatorThreadId) || !/^[a-f0-9]{64}$/.test(record.dispatch.promptDigest)
        || record.dispatch.webAccountFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.dispatch.webAccountFingerprint))) {
        throw Error("Invalid delegation dispatch record");
      }
      if (settledExpired(record, now())) unlinkSync(path(k));
      else records.set(k, record);
    } catch {
      unreadable.add(k);
      unreadableBytes += size;
    }
  }
  if (unreadable.size) emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_records_unreadable", {
    count: unreadable.size,
  });
  const readRecord = (k: string) => {
    // The retained file might contain an unconfirmed archive intent.
    if (unreadable.has(k)) throw Error("Unreadable delegation record; existing tracking was preserved");
    return records.get(k);
  };
  const removeRecord = (k: string) => { unlinkSync(path(k)); records.delete(k); };
  const save = (k: string, record: State) => {
    const body = JSON.stringify(record) + "\n";
    const observedAt = now();
    let size = Buffer.byteLength(body) + unreadableBytes;
    for (const [other, value] of records) {
      if (other === k) continue;
      if (settledExpired(value, observedAt)) removeRecord(other);
      else size += Buffer.byteLength(JSON.stringify(value) + "\n");
    }
    if (size > MAX_BYTES) throw Error("Delegation metadata storage is full; existing records were preserved");
    const temporary = path(k) + "." + randomUUID() + ".tmp";
    try { writeFileSync(temporary, body, { flag: "wx", mode: 0o600 }); renameSync(temporary, path(k)); }
    finally { try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
    records.set(k, record);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (closed || input.automatic === false) return;
    const due = Math.min(...[...records.values()].filter(r => settledAt(r) == null && !r.archivePending).map(r => Math.max(r.dueAt, r.reviewAfter ?? r.dueAt)));
    if (!Number.isFinite(due)) return;
    const delay = Math.max(0, Math.max(due, automaticReviewAfter) - now());
    timer = setTimeout(() => { void api.reconcile(undefined, true).catch(report); }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
  };
  const serial = <T>(work: () => Promise<T>, scheduled = false): Promise<T> => {
    const result = queue.then(() => { if (closed) throw Error("Delegation retention is closed"); return work(); });
    queue = result.then(() => undefined, () => {
      // An unexpected batch failure can prevent persisting the normal deferral.
      // Keep the existing timer off the overdue deadline until the next review.
      if (scheduled) automaticReviewAfter = now() + HALF_DAY;
    });
    return result.finally(schedule);
  };
  const event = (stage: string, record: State, reason?: string) => emitDiagnosticEvent("chatgpt_tela_codex", stage, {
    slot: record.slot, scope_fingerprint: record.scope, thread_fingerprint: hash(record.threadId),
    ...(reason ? { reason_class: reason } : {}),
  });
  const report = (error: unknown) => emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_failed", diagnosticFailureFields(error));
  const finishEnrollment = async (k: string, record: State, thread: any, rpc: CodexAppServerRpc, nameWebChat: boolean) => {
    const active = { ...record, ...(record.pendingFirstTurnId ? {
      firstTurnId: record.pendingFirstTurnId, latestAcceptedTurnId: record.pendingFirstTurnId,
      latestAcceptedAt: record.enrolledAt,
    } : {}) };
    delete active.pendingFirstTurnId;
    delete active.reviewAfter;
    delete active.issue;
    if (typeof thread.name === "string") active.title = thread.name.slice(0, 200);
    save(k, active);
    event("delegation_retention_enrolled", active);
    if (nameWebChat && !active.title?.trimStart().startsWith("[Tela Agent]")) {
      const summary = active.title?.trim()
        || (typeof thread.preview === "string" ? thread.preview.trim().split(/\r?\n/, 1)[0] : undefined)
        || "Web task";
      const name = `[Tela Agent] ${summary}`.slice(0, 200);
      try {
        await rpc.request("thread/name/set", { threadId: active.threadId, name });
        save(k, { ...active, title: name });
        return { ...active, title: name };
      } catch (error) {
        emitDiagnosticEvent("chatgpt_tela_codex", "delegation_title_update_failed", {
          slot: active.slot, thread_fingerprint: hash(active.threadId), ...diagnosticFailureFields(error),
        });
      }
    }
    return active;
  };
  const discardObservation = (k: string, record: State, reason: string) => {
    removeRecord(k);
    event("delegation_retention_observation_discarded", record, reason);
  };
  const confirmObservation = async (k: string, record: State, profile: DelegatedRetentionProfile) => {
    const rpc = await profile.connect(record.threadId, false, true);
    try {
      const data: any = await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false });
      if (!data?.thread) throw Error("Official delegation history is unavailable");
      try { assertManagedThread(data.thread, record.threadId, record.parentThreadId); }
      catch { discardObservation(k, record, "ownership_changed"); return; }
      const first = await readFirstResultTurn(rpc, record.threadId);
      if (first?.id === record.pendingFirstTurnId) return await finishEnrollment(k, record, data.thread, rpc, true);
      if (first || record.dueAt <= now()) discardObservation(k, record, first ? "not_first_turn" : "first_turn_unavailable");
    } finally { await rpc.close(); }
  };
  const dispatchedTurn = async (record: State, rpc: CodexAppServerRpc, signal?: AbortSignal) => {
    const turn = await readFirstResultTurn(rpc, record.threadId, signal);
    if (!turn) return undefined;
    const page = await readIndexedNativeItemsPage(rpc, {
      threadId: record.threadId, turnId: turn.id, sortDirection: "asc", limit: 1,
    }, signal);
    const item = page.data[0]?.item;
    const content = item?.type === "userMessage" && Array.isArray(item.content) && item.content.length === 1
      ? item.content[0] : undefined;
    if (!content || content.type !== "text" || typeof content.text !== "string"
      || hash(content.text) !== record.dispatch!.promptDigest) return undefined;
    return turn;
  };
  const dispatchAnswer = async (record: State, profile: DelegatedRetentionProfile, rpc: CodexAppServerRpc,
    turn: { id: string; status: string }, signal?: AbortSignal) => {
    if (turn.status === "completed") {
      const item = await findSavedFinal(rpc, record.threadId, turn.id, signal);
      if (typeof item?.text === "string" && item.text.trim()) return { itemId: item.id, text: item.text };
    } else if (turn.status !== "failed" && turn.status !== "interrupted") {
      return undefined;
    }
    const account = record.dispatch?.webAccountFingerprint;
    if (!account) return undefined;
    signal?.throwIfAborted();
    const text = await profile.readSavedWebAnswer?.(account, record.threadId, turn.id);
    signal?.throwIfAborted();
    if (text?.trim()) return { itemId: `web_${hash(text)}`, text, source: "web" as const };
  };
  const api = {
    registerDispatch(slot: number, coordinatorThreadId: string, threadId: string, promptDigest: string) {
      return serial(async () => {
        id(coordinatorThreadId);
        id(threadId);
        if (!/^[a-f0-9]{64}$/.test(promptDigest)) throw Error("Invalid Web assignment fingerprint");
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, threadId);
        if (readRecord(k)) throw Error("This Web dispatch is already registered");
        const rpc = await profile.connect(threadId, false);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false });
          const thread = data?.thread;
          assertManagedThread(thread, threadId);
          if (thread.modelProvider !== "openai" || !thread.name?.startsWith("[Tela Agent] ")
            || await readFirstResultTurn(rpc, threadId)) throw Error("The Web dispatch is not a new standalone chat");
          let webAccountFingerprint: string | undefined;
          try { webAccountFingerprint = profile.webAccountFingerprint?.(); }
          catch (error) { report(error); } // Official history is still recoverable.
          const enrolledAt = now();
          const record: State = { version: 1, scope, slot, threadId, enrolledAt, dueAt: enrolledAt + 7 * DAY,
            title: thread.name.slice(0, 200), dispatch: { coordinatorThreadId, promptDigest,
              ...(webAccountFingerprint ? { webAccountFingerprint } : {}) } };
          save(k, record);
          event("delegation_retention_enrolled", record);
          return { registered: true };
        } finally { await rpc.close(); }
      });
    },
    /** Resolve the original service-owned dispatch identity for one same-chat turn. */
    resolveFollowUp(slot: number, coordinatorThreadId: string, threadId: string) {
      return serial(async () => {
        const profile = input.profile(slot);
        const scope = hash(profile.scope);
        const record = readRecord(key(scope, id(threadId)));
        if (!record || record.slot !== slot || record.pendingFirstTurnId !== undefined
          || settledAt(record) != null || record.archivePending
          || record.dispatch?.coordinatorThreadId !== id(coordinatorThreadId)
          || !record.dispatch.webAccountFingerprint) {
          throw Error("No active registered Web dispatch belongs to this coordinator and slot");
        }
        const accountFingerprint = profile.webAccountFingerprint?.();
        if (!accountFingerprint || accountFingerprint !== record.dispatch.webAccountFingerprint) {
          throw Error("The registered Web account has changed");
        }
        const rpc = await profile.connect(threadId, false);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false });
          const thread = data?.thread;
          assertManagedThread(thread, threadId, record.parentThreadId);
          if (thread.modelProvider !== "openai" || typeof thread.model !== "string"
            || !thread.model.startsWith("chatgpt-tela-web/") || !await dispatchedTurn(record, rpc)) {
            throw Error("The original Web dispatch cannot be verified");
          }
          return { threadId, profileScope: profile.scope, accountFingerprint, model: thread.model as string };
        } finally { await rpc.close(); }
      });
    },
    enroll(slot: number, parentThreadId: string | undefined, threadId: string, firstWebTurnId?: string) {
      return serial(async () => {
        if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw Error("Invalid profile slot");
        if (parentThreadId !== undefined) id(parentThreadId);
        id(threadId);
        const standalone = parentThreadId === undefined;
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, threadId);
        const existing = readRecord(k);
        if (firstWebTurnId !== undefined) {
          id(firstWebTurnId);
          // The persisted lineage is already verified. Observation cannot change
          // it or its archive state, and need not start another history reader.
          if (existing) {
            if (existing.parentThreadId !== parentThreadId) throw Error("Delegation lineage changed");
            return existing.pendingFirstTurnId === undefined ? existing : { enrolled: false, reason: "first_turn_pending" };
          }
        }
        const nameWebChat = standalone || firstWebTurnId !== undefined || existing?.pendingFirstTurnId !== undefined;
        const rpc = await profile.connect(threadId, false, nameWebChat);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false });
          assertManagedThread(data?.thread, threadId, parentThreadId);
          if (existing && settledAt(existing) == null && existing.pendingFirstTurnId === undefined) return existing;
          if (standalone && (typeof data.thread.model !== "string"
            || !/^chatgpt-tela-web\/family\/[a-f0-9]{20}$/.test(data.thread.model))) {
            throw Error("The selected standalone chat does not have a Web model");
          }
          const enrolledAt = now();
          const record: State = existing?.pendingFirstTurnId !== undefined ? existing : {
            version: 1, scope, slot, ...(standalone ? {} : { parentThreadId }), threadId, enrolledAt, dueAt: enrolledAt + 7 * DAY,
          };
          if (firstWebTurnId !== undefined) {
            const first = await readFirstResultTurn(rpc, threadId).catch(error => { report(error); });
            if (!first) {
              const pending = { ...record, pendingFirstTurnId: firstWebTurnId };
              save(k, pending);
              event("delegation_retention_observed", pending, "first_turn_pending");
              return { enrolled: false, reason: "first_turn_pending" };
            }
            // A later model switch or an old restored chat is not creation consent.
            if (first.id !== firstWebTurnId) return { enrolled: false, reason: "not_first_turn" };
            record.firstTurnId = first.id;
            record.latestAcceptedTurnId = first.id;
            record.latestAcceptedAt = record.enrolledAt;
          }
          return await finishEnrollment(k, record, data.thread, rpc, nameWebChat);
        } finally { await rpc.close(); }
      });
    },
    /** Pass the direct successful turn/start reply when the turn index may still lag.
     * Callers without that reply must use a turn already visible in official history. */
    acceptTurn(slot: number, parentThreadId: string | undefined | null, threadId: string, turnId: string,
      started?: { readonly turn: { readonly id: string } }) {
      return serial(async () => {
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, id(threadId));
        const record = readRecord(k);
        if (!record || record.slot !== slot || record.pendingFirstTurnId !== undefined || settledAt(record) != null
          || (parentThreadId === null ? record.releasedAt != null : coordinator(record) !== parentThreadId)) {
          throw Error("Register the selected Web delegation first");
        }
        const selected = id(turnId);
        if (record.dispatch && !started) throw Error("A registered dispatch follow-up requires its official turn acknowledgement");
        if (started && id(started.turn?.id) !== selected) throw Error("Official turn/start acknowledgement does not match the submitted turn");
        if (record.latestAcceptedTurnId === selected) return { accepted: true, turnId: selected };
        const rpc = await profile.connect(threadId, false);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false });
          assertManagedThread(data?.thread, threadId, record.parentThreadId);
          if (!started && (await readLatestResultTurn(rpc, threadId))?.id !== selected) {
            throw Error("The submitted turn is not the current official turn");
          }
          const original = record.dispatch && !record.firstTurnId ? await dispatchedTurn(record, rpc) : undefined;
          if (record.dispatch && !record.firstTurnId && !original) throw Error("The original Web dispatch cannot be verified");
          const first = record.firstTurnId ?? original?.id ?? record.acknowledgement?.result.turnId ?? selected;
          const acceptedAt = record.firstTurnId === undefined && record.acknowledgement === undefined
            ? record.enrolledAt : now();
          const sameReceipt = record.acknowledgement?.result.turnId === selected;
          const next: State = { ...record, latestAcceptedTurnId: selected, latestAcceptedAt: acceptedAt,
            dueAt: sameReceipt ? record.dueAt : acceptedAt + 7 * DAY };
          if (next.firstTurnId === undefined) next.firstTurnId = id(first);
          if (!sameReceipt) {
            delete next.acknowledgement;
            delete next.reviewAfter;
            delete next.issue;
          }
          save(k, next);
          return { accepted: true, turnId: selected };
        } finally { await rpc.close(); }
      });
    },
    // A null owner resolves the already-verified lineage from the exact registration.
    // Follow-up writers must pass expectedTurnId captured at submission. A new turn
    // cannot then be mistaken for the response to an earlier Web assignment.
    readResult(slot: number, parentThreadId: string | undefined | null, threadId: string, signal?: AbortSignal,
      previousBefore?: string, expectedTurnId?: string) {
      return serial(async () => {
        signal?.throwIfAborted();
        const profile = input.profile(slot), scope = hash(profile.scope);
        const record = readRecord(key(scope, id(threadId)));
        if (!record || record.pendingFirstTurnId !== undefined || record.slot !== slot
          || (parentThreadId === null ? record.releasedAt != null : coordinator(record) !== parentThreadId)) {
          throw Error("Register the selected Web delegation first");
        }
        if (expectedTurnId !== undefined && (!record.dispatch || record.latestAcceptedTurnId !== undefined)
          && expectedTurnId !== record.firstTurnId && expectedTurnId !== record.latestAcceptedTurnId) {
          throw Error("The exact turn was not accepted by this registration");
        }
        const rpc = await profile.connect(threadId, false);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false }, signal);
          assertManagedThread(data?.thread, threadId, record.parentThreadId);
          if (previousBefore !== undefined) {
            if (expectedTurnId !== undefined) throw Error("Choose an exact turn or previous-answer history");
            if (record.dispatch) throw Error("A recovered dispatch has one submitted turn");
            if (record.latestAcceptedTurnId !== undefined && previousBefore !== record.latestAcceptedTurnId) {
              throw Error("The failed turn was not accepted by this registration");
            }
            return await readPreviousResultAnswer(rpc, threadId, id(previousBefore), signal);
          }
          const selectedTurnId = expectedTurnId ?? record.latestAcceptedTurnId;
          const firstDispatch = record.dispatch && (!record.firstTurnId || !selectedTurnId
            || selectedTurnId === record.firstTurnId);
          const turn = firstDispatch ? await dispatchedTurn(record, rpc, signal)
            : selectedTurnId ? await readExactResultTurn(rpc, threadId, id(selectedTurnId), signal)
              : await readLatestResultTurn(rpc, threadId, signal);
          if (firstDispatch && expectedTurnId !== undefined && turn?.id !== expectedTurnId) {
            throw Error("The submitted Web assignment belongs to another turn");
          }
          if (turn === undefined) {
            if (expectedTurnId !== undefined && expectedTurnId !== record.latestAcceptedTurnId) {
              throw Error("The specified turn is absent from official history");
            }
            return record.latestAcceptedTurnId
              ? { threadId, turnId: record.latestAcceptedTurnId, outcome: "pending" as const }
              : { threadId, outcome: "pending" as const };
          }
          const turnId = id(turn.id);
          const reference = { threadId, turnId };
          if (turn.status === "inProgress") return { ...reference, outcome: "pending" as const };
          if (record.dispatch && (!record.firstTurnId || turnId === record.firstTurnId)) {
            const answer = await dispatchAnswer(record, profile, rpc, turn, signal);
            if (answer) return { ...reference, outcome: "answer" as const, ...answer };
          }
          if (turn.status === "failed" || turn.status === "interrupted") {
            return { ...reference, outcome: turn.status as "failed" | "interrupted" };
          }
          if (turn.status !== "completed") throw Error("The latest delegation turn has an unknown status");
          if (record.dispatch && (!record.firstTurnId || turnId === record.firstTurnId)) throw Error("Final answer text is unavailable");
          const item = await findSavedFinal(rpc, threadId, turnId, signal);
          if (!item && record.latestAcceptedTurnId === turnId) return { ...reference, outcome: "pending" as const };
          if (typeof item?.text !== "string" || !item.text.trim()) throw Error("Final answer text is unavailable");
          return { ...reference, outcome: "answer" as const, itemId: item.id, text: item.text };
        } finally { await rpc.close(); }
      });
    },
    acknowledge(slot: number, requested: ResultReference, resolveRegistered = false) {
      return serial(async () => {
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, requested.threadId);
        const record = readRecord(k);
        if (record?.pendingFirstTurnId !== undefined || resolveRegistered && (!record || record.slot !== slot || record.releasedAt != null)) {
          throw Error("Register the selected Web delegation first");
        }
        const parent = resolveRegistered ? record?.parentThreadId : undefined;
        let result = parent === undefined ? requested : { ...requested, parentThreadId: parent };
        if (record?.dispatch) {
          if (record.releasedAt != null || !resolveRegistered && requested.parentThreadId !== record.dispatch.coordinatorThreadId) {
            throw Error("The Web dispatch belongs to a different coordinating chat");
          }
          const { parentThreadId: _coordinator, ...standaloneResult } = requested;
          result = standaloneResult;
        }
        if (record?.latestAcceptedTurnId && result.turnId !== record.latestAcceptedTurnId) {
          throw Error("The receipt belongs to an earlier accepted turn");
        }
        if (result.parentThreadId === undefined && (!record || record.parentThreadId !== undefined)) {
          throw Error("Register the selected standalone Web chat first");
        }
        const rpc = await profile.connect(result.threadId, false);
        try {
          const receipt = { result, directory: input.acknowledgementDirectory, scope: profile.scope, now: now() };
          let verified: ResultAcknowledgement;
          if (record?.dispatch && result.outcome === "answer" && result.itemId.startsWith("web_")
            && (!record.firstTurnId || result.turnId === record.firstTurnId)) {
            const data: any = await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false });
            assertManagedThread(data?.thread, record.threadId);
            const turn = await dispatchedTurn(record, rpc);
            const latest = await readLatestResultTurn(rpc, record.threadId);
            if (!turn || turn.id !== result.turnId || latest?.id !== turn.id
              || (await dispatchAnswer(record, profile, rpc, turn))?.itemId !== result.itemId) {
              throw Error("The selected saved Web answer changed");
            }
            verified = persistResultAcknowledgement(receipt);
          } else {
            if (record?.dispatch && (!record.firstTurnId || result.turnId === record.firstTurnId)
              && (await dispatchedTurn(record, rpc))?.id !== result.turnId) {
              throw Error("The result does not belong to the submitted Web assignment");
            }
            verified = await acknowledgeNativeResult({ rpc, ...receipt });
          }
          const acknowledgement = record?.acknowledgement?.scope === scope
            && JSON.stringify(record.acknowledgement.result) === JSON.stringify(verified.result)
            ? record.acknowledgement : verified;
          if (record && settledAt(record) == null && !record.archivePending) {
            if (record.parentThreadId !== result.parentThreadId) throw Error("Acknowledgement parent changed");
            const next = { ...record, acknowledgement };
            next.dueAt = archiveDeadline(next, acknowledgement.result.outcome === "answer");
            delete next.reviewAfter;
            save(k, next);
            if (record.acknowledgement?.acknowledgedAt !== acknowledgement.acknowledgedAt
              || record.acknowledgement?.result.turnId !== acknowledgement.result.turnId) event("delegation_retention_acknowledged", next);
          }
          return { acknowledgement, enrolled: !!record, automaticArchiveEnabled: !!record && settledAt(record) == null && !record.archivePending, automaticDeleteEnabled: false };
        } finally { await rpc.close(); }
      });
    },
    listForParent(slot: number, parentThreadId: string) {
      return serial(async () => {
        id(parentThreadId);
        const profile = input.profile(slot), scope = hash(profile.scope);
        const belongsToParent = (record: State) => record.slot === slot && record.scope === scope
          && coordinator(record) === parentThreadId && record.releasedAt == null;
        for (const [k, record] of records) {
          if (belongsToParent(record) && record.pendingFirstTurnId !== undefined) {
            await confirmObservation(k, record, profile).catch(report);
          }
        }
        const tracked = [...records.values()]
          .filter(record => belongsToParent(record) && record.pendingFirstTurnId === undefined)
          .sort((a, b) => b.enrolledAt - a.enrolledAt)
          .map(record => ({
            threadId: record.threadId, title: record.title, enrolledAt: record.enrolledAt,
            dueAt: record.dueAt, archivedAt: record.archivedAt,
            ...(record.acknowledgement ? { lastReceipt: {
              turnId: record.acknowledgement.result.turnId,
              outcome: record.acknowledgement.result.outcome,
              acknowledgedAt: record.acknowledgement.acknowledgedAt,
            } } : {}),
          }));
        return { slot, tracked };
      });
    },
    status(includeTracked = false) {
      const observedAt = now();
      const open = [...records].filter(([, record]) => settledAt(record) == null && record.pendingFirstTurnId === undefined);
      const overdue = open.filter(([, r]) => r.dueAt <= observedAt).map(([trackingId, r]) => ({
        trackingId, enrolledAt: r.enrolledAt, slot: r.slot, threadId: r.threadId, title: r.title, dueAt: r.dueAt,
        reason: r.archivePending ? "archive_unconfirmed" : r.issue ?? "overdue",
      }));
      const status = { overdue, automaticDeleteEnabled: false };
      if (!includeTracked) return status;
      const scopes = new Map<number, string | undefined>();
      const tracked = open.flatMap(([, record]) => {
        if (!scopes.has(record.slot)) {
          try { scopes.set(record.slot, hash(input.profile(record.slot).scope)); }
          catch { scopes.set(record.slot, undefined); }
        }
        if (scopes.get(record.slot) !== record.scope) return [];
        return [{ slot: record.slot, threadId: record.threadId, title: record.title, enrolledAt: record.enrolledAt }];
      }).sort((a, b) => b.enrolledAt - a.enrolledAt);
      return { ...status, tracked };
    },
    stopTracking(trackingId: string, enrolledAt: number) {
      return serial(async () => {
        const record = records.get(trackingId), observedAt = now();
        if (!record || record.pendingFirstTurnId !== undefined || record.enrolledAt !== enrolledAt || settledAt(record) != null || record.dueAt > observedAt) {
          throw Error("The selected cleanup entry is no longer pending");
        }
        // This releases the local entry even if its original profile is unavailable.
        const next = { ...record, releasedAt: observedAt };
        delete next.reviewAfter;
        save(trackingId, next);
        event("delegation_retention_released", next);
        return { stopped: true };
      });
    },
    // Scheduled checks honor a deferred review deadline. Real lifecycle/user
    // events can check sooner without changing the original retention clock.
    reconcile(slot?: number, scheduled = false) {
      return serial(async () => {
        const outcomes: { threadId: string; status: string }[] = [];
        for (const [k, stored] of records) {
          if (slot != null && stored.slot !== slot) continue;
          if (settledExpired(stored, now())) removeRecord(k);
          if (settledAt(stored) != null) continue;
          let record = stored;
          if (record.archivePending) { outcomes.push({ threadId: record.threadId, status: "archive_unconfirmed" }); continue; }
          const due = record.dueAt <= now();
          if (!due && (scheduled || record.pendingFirstTurnId === undefined)
            || scheduled && (record.reviewAfter ?? 0) > now()) continue;
          let rpc: CodexAppServerRpc | undefined, reason = "profile_unavailable";
          try {
            const profile = input.profile(record.slot);
            reason = "ownership_changed";
            if (hash(profile.scope) !== record.scope) throw Error("Configured profile ownership changed");
            if (record.pendingFirstTurnId !== undefined) {
              reason = "first_turn_unavailable";
              const confirmed = await confirmObservation(k, record, profile);
              if (!confirmed) continue;
              record = confirmed;
              if (!due) continue;
            }
            reason = "owner_unavailable";
            rpc = await profile.connect(record.threadId, true);
            // The installed engine acquires its writer here. Another owner must
            // release naturally; never send turn/start, interrupt, delete or retry.
            const resumed: any = await rpc.request("thread/resume", { threadId: record.threadId, excludeTurns: true });
            reason = "ownership_changed";
            assertManagedThread(resumed?.thread, record.threadId, record.parentThreadId);
            reason = "running";
            if (resumed.thread.status?.type !== "idle") throw Error("Delegation is not idle");
            const firstDispatchTurn = record.dispatch ? await dispatchedTurn(record, rpc) : undefined;
            if (record.dispatch && !firstDispatchTurn) {
              discardObservation(k, record, "submitted_turn_unavailable");
              continue;
            }
            // Without a collected answer, no completion timestamp or turn read
            // is needed to apply the fixed seven-day fallback to an idle owner.
            let latestAnswerVerified = false;
            const ack = record.acknowledgement;
            if (ack?.scope === record.scope && ack.result.outcome === "answer"
              && ack.result.threadId === record.threadId && ack.result.parentThreadId === record.parentThreadId) {
              try {
                const turn = await readLatestResultTurn(rpc, record.threadId);
                if (turn?.id === ack.result.turnId) {
                  latestAnswerVerified = firstDispatchTurn?.id === turn.id
                    ? (await dispatchAnswer(record, profile, rpc, turn))?.itemId === ack.result.itemId
                    : turn.status === "completed" && (await findFinalAnswer(rpc, record.threadId, turn.id)).id === ack.result.itemId;
                }
              } catch (error) { report(error); } // Unknown receipt validity uses the same fallback.
            }
            const next = { ...record, dueAt: archiveDeadline(record, latestAnswerVerified) };
            delete next.reviewAfter;
            delete next.issue;
            if (next.dueAt > now()) { save(k, next); outcomes.push({ threadId: record.threadId, status: "not_due" }); continue; }
            // Native archive recursively affects spawned descendants, even
            // those not registered here. Only a persisted leaf is eligible.
            reason = "history_unavailable";
            let hasDescendants = await hasSpawnHistory(rpc, record.threadId);
            for (const archived of hasDescendants ? [] : [false, true]) {
              const page: any = await rpc.request("thread/list", { ancestorThreadId: record.threadId,
                archived, sourceKinds: ["subAgentThreadSpawn"], modelProviders: [], limit: 1, useStateDbOnly: true });
              if (!Array.isArray(page?.data) || page.data.length === 0 && page.nextCursor != null) throw Error("Official descendant metadata is unavailable");
              if (page.data.length > 0) { hasDescendants = true; break; }
            }
            reason = "descendants_present";
            if (hasDescendants) throw Error("Archiving would affect other conversations; user review required");
            // Durable intent prevents re-archiving a manually restored chat if
            // the process dies between the mutation and confirmation write.
            reason = "storage_unavailable";
            save(k, { ...next, archivePending: true });
            event("delegation_retention_archive_requested", next);
            await rpc.request("thread/archive", { threadId: record.threadId });
            save(k, { ...next, archivedAt: now() });
            event("delegation_retention_archive_completed", next);
            outcomes.push({ threadId: record.threadId, status: "archived" });
          } catch (error) {
            // Keep the original archive deadline. Reuse the next-due timer for
            // a twelve-hour maintenance review; real lifecycle events can wake
            // it earlier. Never interrupt the official owner or retry a mutation
            // whose execution is uncertain.
            if (record.pendingFirstTurnId !== undefined) {
              if (records.get(k)?.pendingFirstTurnId !== undefined) {
                if (now() - record.enrolledAt >= METADATA_RETENTION) discardObservation(k, record, reason);
                else if (due && (record.reviewAfter ?? 0) <= now()) save(k, { ...record, reviewAfter: now() + HALF_DAY });
              }
              if (record.reviewAfter === undefined) report(error);
            } else if (records.get(k)?.archivePending) {
              report(error);
              outcomes.push({ threadId: record.threadId, status: "archive_unconfirmed" });
            } else {
              if (record.issue !== reason) {
                report(error);
                event("delegation_retention_deferred", record, reason);
              }
              // Repeated observations cannot push an already scheduled review
              // later. Lifecycle events always bypass this maintenance backstop.
              const reviewAfter = (record.reviewAfter ?? 0) > now() ? record.reviewAfter! : now() + HALF_DAY;
              save(k, { ...record, issue: reason, reviewAfter });
              outcomes.push({ threadId: record.threadId, status: "deferred" });
            }
          } finally { await rpc?.close(); }
        }
        return { outcomes, automaticDeleteEnabled: false };
      }, scheduled);
    },
    async close() { closed = true; if (timer) clearTimeout(timer); await queue; },
  };
  schedule();
  return api;
}
