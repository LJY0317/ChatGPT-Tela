import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndexedNativeItemsPage, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { acknowledgeNativeResult, assertManagedThread, findFinalAnswer, readLatestResultTurn, type ResultAcknowledgement, type ResultReference } from "./result-acknowledgement";

const DAY = 86_400_000, MAX_BYTES = 4 * 1024 * 1024;
const HALF_DAY = DAY / 2;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type State = {
  version: 1; scope: string; slot: number; parentThreadId?: string; threadId: string;
  enrolledAt: number; dueAt: number; acknowledgement?: ResultAcknowledgement;
  archivedAt?: number; releasedAt?: number; archivePending?: true; reviewAfter?: number; issue?: string; title?: string;
};
const settledAt = (record: State) => record.archivedAt ?? record.releasedAt;
export interface DelegatedRetentionProfile {
  /** Install identity + exact configured profile/home; never a model-supplied label. */
  scope: string;
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
  return Number.isFinite(collectedAt) ? collectedAt + HALF_DAY : record.enrolledAt + 7 * DAY;
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
  const records = new Map<string, State>();
  const key = (scope: string, threadId: string) => hash(JSON.stringify([scope, threadId]));
  const path = (k: string) => join(input.directory, k + ".json");
  // This service is the single writer. Interrupted atomic-write scratch files
  // contain no independent record and are reproducible from the committed file.
  for (const file of readdirSync(input.directory).filter(n => /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(n))) {
    const scratch = join(input.directory, file), stat = lstatSync(scratch);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(scratch);
  }
  for (const file of readdirSync(input.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const stat = lstatSync(join(input.directory, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw Error("Invalid delegation state file");
    const record = JSON.parse(readFileSync(join(input.directory, file), "utf8")) as State;
    if (record.version !== 1 || !Number.isInteger(record.slot) || record.slot < 1 || record.slot > 99
      || !/^[a-f0-9]{64}$/.test(record.scope) || !Number.isFinite(record.enrolledAt)
      || !Number.isFinite(record.dueAt) || record.reviewAfter != null && !Number.isFinite(record.reviewAfter)
      || record.archivedAt != null && !Number.isFinite(record.archivedAt)
      || record.releasedAt != null && !Number.isFinite(record.releasedAt)
      || key(record.scope, id(record.threadId)) + ".json" !== file) throw Error("Invalid delegation state");
    if (record.parentThreadId !== undefined) id(record.parentThreadId);
    const settled = settledAt(record);
    if (settled != null && now() - settled > 60 * DAY) unlinkSync(join(input.directory, file));
    else {
      // Old completion-based deadlines must not postpone the fixed fallback.
      record.dueAt = Math.min(record.dueAt, record.enrolledAt + 7 * DAY);
      records.set(file.slice(0, -5), record);
    }
  }
  const save = (k: string, record: State) => {
    const body = JSON.stringify(record) + "\n";
    const size = [...records].reduce((sum, [other, value]) => sum + (other === k ? 0 : Buffer.byteLength(JSON.stringify(value) + "\n")), Buffer.byteLength(body));
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
    timer = setTimeout(() => { void api.reconcile(undefined, true).catch(report); }, Math.min(Math.max(0, due - now()), 2_147_483_647));
    timer.unref?.();
  };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(() => { if (closed) throw Error("Delegation retention is closed"); return work(); });
    queue = result.then(() => undefined, () => undefined);
    return result.finally(schedule);
  };
  const event = (stage: string, record: State, reason?: string) => emitDiagnosticEvent("chatgpt_tela_codex", stage, {
    slot: record.slot, scope_fingerprint: record.scope, thread_fingerprint: hash(record.threadId),
    ...(reason ? { reason_class: reason } : {}),
  });
  const report = (error: unknown) => emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_failed", diagnosticFailureFields(error));
  const api = {
    enroll(slot: number, parentThreadId: string | undefined, threadId: string, firstWebTurnId?: string) {
      return serial(async () => {
        if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw Error("Invalid profile slot");
        if (parentThreadId !== undefined) id(parentThreadId);
        id(threadId);
        const standalone = parentThreadId === undefined;
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, threadId);
        const existing = records.get(k);
        if (firstWebTurnId !== undefined) {
          id(firstWebTurnId);
          // The persisted lineage is already verified. Observation cannot change
          // it or its archive state, and need not start another history reader.
          if (existing) {
            if (existing.parentThreadId !== parentThreadId) throw Error("Delegation lineage changed");
            return existing;
          }
        }
        const nameWebChat = standalone || firstWebTurnId !== undefined;
        const rpc = await profile.connect(threadId, false, nameWebChat);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false });
          assertManagedThread(data?.thread, threadId, parentThreadId);
          if (existing && settledAt(existing) == null) return existing;
          if (standalone && (typeof data.thread.model !== "string"
            || !/^chatgpt-tela-web\/family\/[a-f0-9]{20}$/.test(data.thread.model))) {
            throw Error("The selected standalone chat does not have a Web model");
          }
          if (firstWebTurnId !== undefined) {
            const first: any = await rpc.request("thread/turns/list", {
              threadId, limit: 1, sortDirection: "asc", itemsView: "notLoaded",
            });
            if (!first?.data?.[0]?.id) throw Error("Official first turn is unavailable");
            // A later model switch or an old restored chat is not creation consent.
            if (first?.data?.[0]?.id !== firstWebTurnId) return { enrolled: false, reason: "not_first_turn" };
          }
          const enrolledAt = now();
          const record: State = { version: 1, scope, slot, ...(standalone ? {} : { parentThreadId }), threadId, enrolledAt, dueAt: enrolledAt + 7 * DAY,
            ...(typeof data.thread.name === "string" ? { title: data.thread.name.slice(0, 200) } : {}) };
          save(k, record);
          event("delegation_retention_enrolled", record);
          if (nameWebChat && !record.title?.trimStart().startsWith("[Tela Agent]")) {
            const summary = record.title?.trim()
              || (typeof data.thread.preview === "string" ? data.thread.preview.trim().split(/\r?\n/, 1)[0] : undefined)
              || "Web task";
            const name = `[Tela Agent] ${summary}`.slice(0, 200);
            try {
              await rpc.request("thread/name/set", { threadId, name });
              save(k, { ...record, title: name });
              return { ...record, title: name };
            } catch (error) {
              emitDiagnosticEvent("chatgpt_tela_codex", "delegation_title_update_failed", {
                slot, thread_fingerprint: hash(threadId), ...diagnosticFailureFields(error),
              });
            }
          }
          return record;
        } finally { await rpc.close(); }
      });
    },
    // A null owner resolves the already-verified lineage from the exact registration.
    readResult(slot: number, parentThreadId: string | undefined | null, threadId: string, signal?: AbortSignal) {
      return serial(async () => {
        signal?.throwIfAborted();
        const profile = input.profile(slot), scope = hash(profile.scope);
        const record = records.get(key(scope, id(threadId)));
        if (!record || record.slot !== slot
          || (parentThreadId === null ? record.releasedAt != null : record.parentThreadId !== parentThreadId)) {
          throw Error("Register the selected Web delegation first");
        }
        const rpc = await profile.connect(threadId, false);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false }, signal);
          assertManagedThread(data?.thread, threadId, record.parentThreadId);
          const turn = await readLatestResultTurn(rpc, threadId, signal);
          if (turn === undefined) return { threadId, outcome: "pending" as const };
          const turnId = id(turn.id);
          const reference = { threadId, turnId };
          if (turn.status === "inProgress") return { ...reference, outcome: "pending" as const };
          if (turn.status === "failed" || turn.status === "interrupted") {
            return { ...reference, outcome: turn.status as "failed" | "interrupted" };
          }
          if (turn.status !== "completed") throw Error("The latest delegation turn has an unknown status");
          const item = await findFinalAnswer(rpc, threadId, turnId, signal);
          if (typeof item.text !== "string" || !item.text.trim()) throw Error("Final answer text is unavailable");
          return { ...reference, outcome: "answer" as const, itemId: item.id, text: item.text };
        } finally { await rpc.close(); }
      });
    },
    acknowledge(slot: number, requested: ResultReference, resolveRegistered = false) {
      return serial(async () => {
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, requested.threadId);
        const record = records.get(k);
        if (resolveRegistered && (!record || record.slot !== slot || record.releasedAt != null)) {
          throw Error("Register the selected Web delegation first");
        }
        const parent = resolveRegistered ? record?.parentThreadId : undefined;
        const result = parent === undefined ? requested : { ...requested, parentThreadId: parent };
        if (result.parentThreadId === undefined && (!record || record.parentThreadId !== undefined)) {
          throw Error("Register the selected standalone Web chat first");
        }
        const rpc = await profile.connect(result.threadId, false);
        try {
          const verified = await acknowledgeNativeResult({ rpc, result,
            directory: input.acknowledgementDirectory, scope: profile.scope, now: now() });
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
    status() {
      const observedAt = now();
      return { overdue: [...records].filter(([, r]) => settledAt(r) == null && r.dueAt <= observedAt).map(([trackingId, r]) => ({
        trackingId, enrolledAt: r.enrolledAt, slot: r.slot, threadId: r.threadId, title: r.title, dueAt: r.dueAt,
        reason: r.archivePending ? "archive_unconfirmed" : r.issue ?? "overdue",
      })), automaticDeleteEnabled: false };
    },
    stopTracking(trackingId: string, enrolledAt: number) {
      return serial(async () => {
        const record = records.get(trackingId), observedAt = now();
        if (!record || record.enrolledAt !== enrolledAt || settledAt(record) != null || record.dueAt > observedAt) {
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
        for (const [k, record] of records) {
          if (slot != null && record.slot !== slot || settledAt(record) != null) continue;
          if (record.archivePending) { outcomes.push({ threadId: record.threadId, status: "archive_unconfirmed" }); continue; }
          if (record.dueAt > now() || scheduled && (record.reviewAfter ?? 0) > now()) continue;
          let rpc: CodexAppServerRpc | undefined, reason = "profile_unavailable";
          try {
            const profile = input.profile(record.slot);
            reason = "ownership_changed";
            if (hash(profile.scope) !== record.scope) throw Error("Configured profile ownership changed");
            reason = "owner_unavailable";
            rpc = await profile.connect(record.threadId, true);
            // The installed engine acquires its writer here. Another owner must
            // release naturally; never send turn/start, interrupt, delete or retry.
            const resumed: any = await rpc.request("thread/resume", { threadId: record.threadId, excludeTurns: true });
            reason = "ownership_changed";
            assertManagedThread(resumed?.thread, record.threadId, record.parentThreadId);
            reason = "running";
            if (resumed.thread.status?.type !== "idle") throw Error("Delegation is not idle");
            // Without a collected answer, no completion timestamp or turn read
            // is needed to apply the fixed seven-day fallback to an idle owner.
            let latestAnswerVerified = false;
            const ack = record.acknowledgement;
            if (ack?.scope === record.scope && ack.result.outcome === "answer"
              && ack.result.threadId === record.threadId && ack.result.parentThreadId === record.parentThreadId) {
              try {
                const turn = await readLatestResultTurn(rpc, record.threadId);
                latestAnswerVerified = turn?.id === ack.result.turnId && turn.status === "completed"
                  && (await findFinalAnswer(rpc, record.threadId, turn.id)).id === ack.result.itemId;
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
            if (records.get(k)?.archivePending) {
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
      });
    },
    async close() { closed = true; if (timer) clearTimeout(timer); await queue; },
  };
  schedule();
  return api;
}
