import { watch, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isExactDeletedNativeThreadAbsent } from "./one-chat-native-destination";
import { diagnosticFailureClass, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { sameAccountOwner, verifiedWebDelegationAnswer, webDelegationRetentionPath, type WebDelegationAdapters, type WebDelegationRecord, type WebDelegationThreadKey } from "./web-delegation";

const DAY = 86_400_000;
const UNARCHIVED_THREAD_TARGET = 32;
const cleanupActions: Readonly<Record<string, string>> = {
  uncollected_answers: "collect_answer", manually_managed: "keep_manual_control",
  active_or_unresolved_tail: "wait_for_work", queued_work: "wait_for_work",
  not_yet_due_or_unverified: "wait_for_due_time",
};
interface Retention {
  state: "archived" | "excluded" | "deleted";
  archivedAt?: number;
  /** Native metadata after our archive, used to detect subsequent manual changes. */
  updatedAt?: number;
}
function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function publicErrorKind(error: unknown): string {
  const value = object(error);
  const code = typeof value?.code === "string" ? value.code : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timeout|timed out/.test(message) || /TIMEOUT/.test(code)) return "timeout";
  if (/^(ECONNREFUSED|ECONNRESET|EPIPE|ECONNABORTED|ENOTFOUND|EHOSTUNREACH)$/.test(code)
    || /socket closed|connection closed|websocket.*closed/.test(message)) return "transport";
  if (message.startsWith("thread not loaded:")) return "thread_not_loaded";
  if (message.startsWith("thread not found:")) return "thread_not_found";
  if (/cursor/.test(message)) return "pagination";
  if (/inventory|queued work|activity time/.test(message)) return "invalid_public_response";
  if (/owner|account/.test(message)) return "owner_resolution";
  return "other";
}
// The daemon's owned-session resolver reports this exact readiness state while
// profiles are stopping or reconnecting. Other owner/proof errors remain failures.
function ownerTemporarilyUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === "terminal requires a running Tela profile";
}
function statePath(adapters: WebDelegationAdapters, record: WebDelegationRecord): string {
  // Thread IDs originate from acknowledged Native creation, not user-selected filenames.
  if (!/^[a-f0-9-]{36}$/i.test(record.threadId!)) throw Error("Invalid managed thread ID");
  return webDelegationRetentionPath(adapters.store.root, { slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! });
}
function load(path: string): Retention | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Retention;
  if (!["archived", "excluded", "deleted"].includes(value.state)
    || value.state === "archived" && (!Number.isFinite(value.archivedAt) || !Number.isFinite(value.updatedAt))) {
    throw Error("Invalid Web thread retention receipt");
  }
  return value;
}
function save(path: string, value: Retention): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(tmp, path); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

/** One daemon-owned retention pass. Terminal result receipts remain immutable.
 * Only threads already owned by the managed journal can be archived/deleted. */
export async function settleWebDelegationRetention(adapters: WebDelegationAdapters, input: {
  now?: number; signal: AbortSignal;
}): Promise<number | undefined> {
  const now = input.now ?? Date.now();
  adapters.store.beginCleanupObservation();
  const groups = new Map<string, WebDelegationRecord[]>();
  for (const record of adapters.store.records()) {
    if (!record.threadId) continue;
    const key = `${record.slot}:${record.owner.accountFingerprint}:${record.threadId}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  for (const jobs of groups.values()) {
    jobs.sort((a, b) => a.createdAt - b.createdAt || (a.parentJobId === b.id ? 1 : b.parentJobId === a.id ? -1 : 0));
  }
  const collections = new Map([...groups.values()].flatMap(jobs =>
    jobs.map(job => [job.id, adapters.store.collectedAt(job.id)] as const)));
  let next = Infinity;
  const historyEligible = new Set<string>();
  const connections = new Map<string, Awaited<ReturnType<WebDelegationAdapters["connect"]>>>();
  const confirmAbsent = async (record: WebDelegationRecord, rpc: Awaited<ReturnType<WebDelegationAdapters["connect"]>>): Promise<void> => {
    const key = { slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! };
    const path = statePath(adapters, record);
    try {
      const read = object(await rpc.request("thread/read", { threadId: key.threadId, includeTurns: false }, input.signal));
      // A missing list entry is not a user opt-out. Only a stale deletion
      // receipt must relinquish deletion authority when the thread still exists.
      if (object(read?.thread)?.id === key.threadId && load(path)?.state === "deleted") save(path, { state: "excluded" });
      return;
    } catch (error) {
      if (!isExactDeletedNativeThreadAbsent(error, key.threadId)) throw error;
    }
    if (!sameAccountOwner(record, await adapters.owner(record.slot))) return;
    save(path, { state: "deleted" });
    adapters.store.removeDeletedThread(key);
  };
  for (const key of adapters.store.pendingDeletedThreads()) {
    const record = adapters.store.recordsForThread(key)[0];
    if (!record) {
      adapters.store.removeDeletedThread(key);
      continue;
    }
    try {
      const owner = await adapters.owner(key.slot);
      if (!sameAccountOwner(record, owner)) continue;
      const rpc = await adapters.connect(owner.session.terminalEndpoint);
      try { await confirmAbsent(record, rpc); }
      finally { await rpc.close(); }
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (ownerTemporarilyUnavailable(error)) continue;
      emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_failed", { failure_class: diagnosticFailureClass(error) });
    }
  }
  const inventories = new Map<string, Map<string, { archived: boolean; thread: Record<string, any> }>>();
  const occupancy = new Map<string, { slot: number; before: number; current: number; uncertain: boolean;
    protected: Map<string, { reason: string; dueAt?: string }> }>();
  let pending = [...groups.values()];
  try {
  while (pending.length) {
    const jobs = pending.pop()!;
    input.signal.throwIfAborted();
    const record = jobs.at(-1)!;
    const path = statePath(adapters, record), retained = load(path);
    if (retained?.state === "deleted") continue;
    const reviewedAt = adapters.store.requests.header(record.id)?.settlement?.at;
    const ownCollection = collections.get(record.id) ?? reviewedAt;
    const collected = ownCollection ?? (record.state === "failed" && !verifiedWebDelegationAnswer(record)
      ? Math.max(0, ...jobs.map(job => collections.get(job.id) ?? 0)) || undefined : undefined);
    let dueBasis = retained?.archivedAt !== undefined ? "archive_expiry"
      : collected !== undefined ? "collected_result" : "idle_activity";
    let due = retained?.archivedAt !== undefined ? retained.archivedAt + 30 * DAY
      : collected !== undefined ? collected + DAY : record.createdAt + 7 * DAY;
    if (due > now && retained?.state !== "excluded") next = Math.min(next, due);
    let publicOperation = "owner_resolution";
    let scopeConnection: string | undefined;
    let unarchived = false;
    const protect = (reason: string) => {
      if (unarchived && scopeConnection) occupancy.get(scopeConnection)?.protected.set(record.threadId!, {
        reason, ...(reason === "not_yet_due_or_unverified" ? { dueAt: new Date(due).toISOString() } : {}),
      });
    };
    const skipped = (reason: string, relation = "unknown", error?: unknown) => {
      protect(reason);
      if (due > now || retained?.state === "excluded") return;
      emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_skipped", {
        reason_class: reason, due_at: due, kind: relation, policy: dueBasis, next_action: publicOperation,
        ...(error === undefined ? {} : { failure_class: diagnosticFailureClass(error) }),
      });
    };
    try {
      const owner = await adapters.owner(record.slot);
      if (!sameAccountOwner(record, owner)) { skipped("owner_unavailable_or_changed"); continue; }
      scopeConnection = JSON.stringify([record.slot, record.owner.accountFingerprint, owner.session.terminalEndpoint]);
      let rpc = connections.get(scopeConnection);
      if (!rpc) {
        publicOperation = "connect";
        rpc = await adapters.connect(owner.session.terminalEndpoint);
        connections.set(scopeConnection, rpc);
      }
      try {
        // Native read metadata does not expose archive state. Read both official
        // list partitions (metadata only) and require complete pagination.
        const scope = scopeConnection;
        let listed = inventories.get(scope);
        if (!listed) {
          listed = new Map<string, { archived: boolean; thread: Record<string, any> }>();
          for (const archived of [false, true]) {
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            publicOperation = "thread_list";
            const page = object(await rpc.request("thread/list", {
              archived, limit: 100, ...(cursor ? { cursor } : {}),
            }, input.signal));
            if (!Array.isArray(page?.data)) throw Error("Native thread inventory unavailable");
            for (const raw of page.data) {
              const thread = object(raw);
              if (thread && typeof thread.id === "string") listed.set(thread.id, { archived, thread });
            }
            const following = page.nextCursor;
            if (following != null && (typeof following !== "string" || !following || seen.has(following))) {
              throw Error("Native thread inventory cursor repeated");
            }
            cursor = following ?? undefined;
            if (cursor) seen.add(cursor);
          } while (cursor);
          }
          inventories.set(scope, listed);
          const sameProfile = (other: WebDelegationRecord[]) => other.at(-1)!.slot === record.slot
            && other.at(-1)!.owner.accountFingerprint === record.owner.accountFingerprint;
          const count = [...groups.values()].filter(other => sameProfile(other)
            && listed!.get(other.at(-1)!.threadId!)?.archived === false).length;
          occupancy.set(scope, {slot: record.slot, before: count, current: count, uncertain: false, protected: new Map()});
          if (count > UNARCHIVED_THREAD_TARGET) {
            // Reuse this complete inventory. Oldest real activity/collection first,
            // not journal filename, creation order, or conversation title.
            const activity = (other: WebDelegationRecord[]) => {
              const latest = other.at(-1)!;
              return Math.max(latest.createdAt, collections.get(latest.id) ?? 0,
                Number(listed!.get(latest.threadId!)?.thread.updatedAt ?? 0) * 1000);
            };
            const peers = [jobs, ...pending.filter(sameProfile)].sort((a, b) => activity(b) - activity(a));
            pending = [...pending.filter(other => !sameProfile(other)), ...peers];
            continue;
          }
        }
        const present = listed.get(record.threadId!);
        if (!present) {
          skipped("public_inventory_absent");
          publicOperation = "thread_read_after_absence";
          await confirmAbsent(record, rpc);
          continue;
        }
        unarchived = !present.archived;
        const nativeState = typeof present.thread.status === "string"
          ? present.thread.status : present.thread.status?.type;
        const updatedAt = present.thread.updatedAt;
        if (!Number.isFinite(updatedAt)) throw Error("Native thread activity time unavailable");
        const activity = Math.max(record.createdAt, Number(updatedAt) * 1000);
        if (retained?.archivedAt !== undefined) dueBasis = "archive_expiry";
        else if (collected !== undefined) {
          due = Math.max(collected, activity) + DAY;
          dueBasis = "collection_and_activity";
        } else {
          due = activity + 7 * DAY;
          dueBasis = "native_activity";
        }
        if (due > now && retained?.state !== "excluded") next = Math.min(next, due);
        if (retained?.state === "excluded") {
          protect("manually_managed");
          // A manual archive/restore hands over Native ownership. Local history
          // is reclaimable only after a fresh idle/queue/turn proof.
          publicOperation = "thread_turns_list";
          const tail = object(await rpc.request("thread/turns/list", {
            threadId: record.threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
          }, input.signal));
          const latest = Array.isArray(tail?.data) ? object(tail.data[0]) : undefined;
          if (!latest || !["completed", "failed", "interrupted"].includes(latest.status)
            || nativeState === "active" || !jobs.some(job => job.turnId === latest.id)) continue;
          if (!present.archived) {
            publicOperation = "thread_queue_list";
            const queue = object(await rpc.request("thread/queue/list", { threadId: record.threadId, limit: 1 }, input.signal));
            if (!Array.isArray(queue?.data) || queue.data.length || queue.nextCursor != null) continue;
          }
          if (!sameAccountOwner(record, await adapters.owner(record.slot))) continue;
          historyEligible.add(`${record.slot}:${record.owner.accountFingerprint}:${record.threadId}`);
          // The receipt's file time is the exclusion boundary for old and new receipts.
          // A copied/touched receipt with a newer time cannot reclaim older work.
          const excludedAt = statSync(path).mtimeMs;
          if (!Number.isFinite(excludedAt) || present.archived
            || !jobs.some(job => job.createdAt > excludedAt && job.turnId === latest.id)) continue;
          unlinkSync(path);
          const activity = Math.max(record.createdAt, Number(present.thread.updatedAt) * 1000);
          const archiveDue = collected !== undefined ? Math.max(collected, activity) + DAY : activity + 7 * DAY;
          if (Number.isFinite(archiveDue)) next = Math.min(next, archiveDue);
          continue;
        }
        if (present.archived !== (retained?.state === "archived")
          || retained?.state === "archived" && updatedAt !== retained.updatedAt) {
          // Manual archive, restore or an observed change while archived hands
          // control to the user. Never delete such a thread automatically.
          protect("manually_managed");
          save(path, { state: "excluded" }); continue;
        }
        // Pressure may shorten the age policy only for collected answers. Keep
        // uncollected sibling results and uncertain/failed latest work on their
        // normal retention path; capacity never becomes an admission condition.
        if (!present.archived && !retained && !occupancy.get(scope)!.uncertain
          && occupancy.get(scope)!.current > UNARCHIVED_THREAD_TARGET
          && ownCollection !== undefined && (verifiedWebDelegationAnswer(record) || record.state === "failed" && reviewedAt !== undefined)
          && jobs.every(job => !verifiedWebDelegationAnswer(job) || collections.get(job.id) !== undefined)) {
          due = now;
          dueBasis = "capacity_pressure";
        }
        if (due > now) {
          protect(nativeState === "active" || jobs.some(job => !["completed", "failed", "linked"].includes(job.state))
            ? "active_or_unresolved_tail"
            : jobs.some(job => verifiedWebDelegationAnswer(job) && collections.get(job.id) === undefined)
              ? "uncollected_answers" : "not_yet_due_or_unverified");
          continue;
        }
        // Archive is reversible and needs current idle/queue proof, not a
        // readable execution rollout or an exact journal entry for every turn.
        if (nativeState === "active"
          || jobs.some(job => !["completed", "failed", "linked"].includes(job.state))) {
          skipped("active_or_unresolved_tail"); continue;
        }
        // Archived Native threads reject Queue access. Their unchanged archive
        // receipt already proves the lifecycle boundary; only live threads need it.
        if (!present.archived) {
          publicOperation = "thread_queue_list";
          const queue = object(await rpc.request("thread/queue/list", { threadId: record.threadId, limit: 1 }, input.signal));
          if (!Array.isArray(queue?.data)) throw Error("Native queued work inventory unavailable");
          if (queue.data.length || queue.nextCursor != null) { skipped("queued_work", "managed"); continue; }
        }
        // Recheck the account before changing Native conversation state.
        publicOperation = "owner_recheck";
        if (!sameAccountOwner(record, await adapters.owner(record.slot))) { skipped("owner_changed_before_mutation", "managed"); continue; }
        // On an error, retain the receipt and observe public state next pass.
        if (retained?.state === "archived") {
          publicOperation = "thread_delete";
          await rpc.request("thread/delete", { threadId: record.threadId }, input.signal);
          publicOperation = "thread_read_after_delete";
          await confirmAbsent(record, rpc);
        } else {
          publicOperation = "thread_archive";
          await rpc.request("thread/archive", { threadId: record.threadId }, input.signal);
          present.archived = true;
          occupancy.get(scope)!.current--;
          publicOperation = "thread_read_after_archive";
          const read = object(await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false }, input.signal));
          const archivedUpdatedAt = object(read?.thread)?.updatedAt;
          if (!Number.isFinite(archivedUpdatedAt)) throw Error("Archived thread receipt unavailable");
          save(path, { state: "archived", archivedAt: now, updatedAt: archivedUpdatedAt });
          next = Math.min(next, now + 30 * DAY);
        }
      } finally { /* Shared owner connection closes after the pass. */ }
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (publicOperation === "thread_archive" && scopeConnection && occupancy.has(scopeConnection)) {
        // Re-observe this account before any more pressure-driven mutations.
        occupancy.get(scopeConnection)!.uncertain = true;
      }
      if (publicOperation === "owner_resolution" && ownerTemporarilyUnavailable(error)) continue;
      skipped("public_metadata_or_retention_error", "unknown", error);
      emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_failed", {
        failure_class: diagnosticFailureClass(error), kind: publicErrorKind(error), next_action: publicOperation,
      });
      // Reconsider on a real journal/profile change or the next daemon start,
      // not through a retry/polling loop.
    }
  }
  } finally {
    for (const count of occupancy.values()) {
      const protectedCounts: Record<string, number> = {};
      for (const { reason } of count.protected.values()) protectedCounts[reason] = (protectedCounts[reason] ?? 0) + 1;
      if (!input.signal.aborted) adapters.store.observeCleanup(count.slot, { observedAt: new Date(now).toISOString(),
        unarchived: count.current, target: UNARCHIVED_THREAD_TARGET, uncertain: count.uncertain, protected: protectedCounts,
        protectedThreads: [...count.protected].map(([threadId, item]) => ({ threadId, ...item,
          nextAction: cleanupActions[item.reason] ?? "inspect_thread" })) });
      if (count.before <= UNARCHIVED_THREAD_TARGET) continue;
      emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_capacity", {
        thread_count: count.current, target_count: UNARCHIVED_THREAD_TARGET,
        archived_count: count.before - count.current,
        over_target_count: Math.max(0, count.current - UNARCHIVED_THREAD_TARGET),
        archive_outcome_uncertain: count.uncertain,
      });
    }
    await Promise.allSettled([...connections.values()].map(rpc => rpc.close()));
  }
  if (!input.signal.aborted) {
    const history = adapters.store.pruneCollectedHistory(historyEligible, now);
    const requests = adapters.store.requests.prune(now);
    if (requests.next !== undefined) next = Math.min(next, requests.next);
    adapters.store.pruneOrphanedExcludedReceipts();
    if (history.next !== undefined) next = Math.min(next, history.next);
  }
  return next === Infinity ? undefined : next;
}

/** Existing daemon lifecycle, one next-expiry timer and journal-change events.
 * No background polling or new service. A parked active/unavailable thread is
 * reconsidered after real managed-job changes, profile reconnect or restart. */
export function startWebDelegationRetention(adapters: WebDelegationAdapters, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  let closed = false;
  const wake = () => {
    if (closed || signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    dirty = true;
    if (running) return;
    running = (async () => {
      do {
        dirty = false;
        const next = await settleWebDelegationRetention(adapters, { signal });
        if (!dirty && next !== undefined && !closed && !signal.aborted) {
          timer = setTimeout(wake, Math.max(1, Math.min(next - Date.now(), 2_147_483_647)));
          timer.unref?.();
        }
      } while (dirty && !closed && !signal.aborted);
    })().catch(error => {
      if (!signal.aborted) emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_failed", { failure_class: diagnosticFailureClass(error) });
    }).finally(() => { running = undefined; });
  };
  const watcher = watch(adapters.store.root, (_event, filename) => {
    if (filename && (/\.json(?:\.(?:completed|failed))?$/.test(String(filename))
      || String(filename).endsWith(".request.ndjson") || String(filename).endsWith(".collected"))) wake();
  });
  watcher.on("error", error => emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_failed", { failure_class: diagnosticFailureClass(error) }));
  const stop = () => { closed = true; watcher.close(); if (timer) clearTimeout(timer); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop(); else wake();
  return { wake, async close() { stop(); signal.removeEventListener("abort", stop); await running; } };
}
