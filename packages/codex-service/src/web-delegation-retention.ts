import { watch, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnosticFailureClass, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { sameAccountOwner, webDelegationRetentionPath, type WebDelegationAdapters, type WebDelegationRecord } from "./web-delegation";

const DAY = 86_400_000;
interface Retention {
  state: "archived" | "excluded" | "deleted";
  archivedAt?: number;
  /** Native metadata after our archive, used to detect subsequent manual changes. */
  updatedAt?: number;
}
function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
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
  adapters.store.finishDeletedThreads();
  const now = input.now ?? Date.now();
  const groups = new Map<string, WebDelegationRecord[]>();
  for (const record of adapters.store.records()) {
    if (!record.threadId) continue;
    const key = `${record.slot}:${record.threadId}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  let next = Infinity;
  for (const jobs of groups.values()) {
    input.signal.throwIfAborted();
    jobs.sort((a, b) => a.createdAt - b.createdAt || (a.parentJobId === b.id ? 1 : b.parentJobId === a.id ? -1 : 0));
    const record = jobs.at(-1)!;
    const path = statePath(adapters, record), retained = load(path);
    if (retained?.state === "deleted" || retained?.state === "excluded") continue;
    const collected = adapters.store.collectedAt(record.id);
    const due = retained?.archivedAt !== undefined ? retained.archivedAt + 30 * DAY
      : collected !== undefined ? collected + DAY : record.createdAt + 7 * DAY;
    if (due > now) { next = Math.min(next, due); continue; }
    try {
      const owner = await adapters.owner(record.slot);
      if (!sameAccountOwner(record, owner)) continue;
      const rpc = await adapters.connect(owner.session.terminalEndpoint);
      try {
        // Native read metadata does not expose archive state. Read both official
        // list partitions (metadata only) and require complete pagination.
        const listed = new Map<string, { archived: boolean; thread: Record<string, any> }>();
        for (const archived of [false, true]) {
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = object(await rpc.request("thread/list", {
              archived, cwd: record.cwd, limit: 100, ...(cursor ? { cursor } : {}),
            }, input.signal));
            if (!Array.isArray(page?.data)) throw Error("Native thread inventory unavailable");
            for (const raw of page.data) {
              const thread = object(raw);
              if (thread && thread.id === record.threadId) listed.set(thread.id, { archived, thread });
            }
            const following = page.nextCursor;
            if (following != null && (typeof following !== "string" || !following || seen.has(following))) {
              throw Error("Native thread inventory cursor repeated");
            }
            cursor = following ?? undefined;
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        const present = listed.get(record.threadId!);
        if (!present) {
          save(path, { state: "deleted" });
          adapters.store.removeDeletedThread({ slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! });
          continue;
        }
        const updatedAt = present.thread.updatedAt;
        if (!Number.isFinite(updatedAt)) throw Error("Native thread activity time unavailable");
        if (present.archived !== (retained?.state === "archived")
          || retained?.state === "archived" && updatedAt !== retained.updatedAt) {
          // Manual archive, restore or an observed change while archived hands
          // control to the user. Never delete such a thread automatically.
          save(path, { state: "excluded" }); continue;
        }
        const tail = object(await rpc.request("thread/turns/list", {
          threadId: record.threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
        }, input.signal));
        const latest = Array.isArray(tail?.data) ? object(tail.data[0]) : undefined;
        if (!latest || !["completed", "failed", "interrupted"].includes(latest.status)
          || present.thread.status?.type === "active") continue;
        if (!jobs.some(job => job.turnId === latest.id)) {
          // The user continued the thread outside the managed journal.
          save(path, { state: "excluded" }); continue;
        }
        const queue = object(await rpc.request("thread/queue/list", { threadId: record.threadId, limit: 1 }, input.signal));
        if (!Array.isArray(queue?.data)) throw Error("Native queued work inventory unavailable");
        if (queue.data.length || queue.nextCursor != null) continue;
        if (!retained) {
          const lastActivity = Math.max(record.createdAt, updatedAt * 1000);
          const archiveDue = collected !== undefined ? Math.max(collected, lastActivity) + DAY : lastActivity + 7 * DAY;
          if (archiveDue > now) { next = Math.min(next, archiveDue); continue; }
        }
        // Session authority may change during metadata reads. Reuse the same
        // public account proof before performing either irreversible effect.
        if (!sameAccountOwner(record, await adapters.owner(record.slot))) continue;
        try {
          if (retained?.state === "archived") {
            await rpc.request("thread/delete", { threadId: record.threadId }, input.signal);
            save(path, { state: "deleted" });
          } else {
            await rpc.request("thread/archive", { threadId: record.threadId }, input.signal);
            const read = object(await rpc.request("thread/read", { threadId: record.threadId, includeTurns: false }, input.signal));
            const archivedUpdatedAt = object(read?.thread)?.updatedAt;
            if (!Number.isFinite(archivedUpdatedAt)) throw Error("Archived thread receipt unavailable");
            save(path, { state: "archived", archivedAt: now, updatedAt: archivedUpdatedAt });
            next = Math.min(next, now + 30 * DAY);
          }
        } catch (error) {
          // Unknown mutation outcomes are not permission to repeat a request.
          // Keep the Native conversation and relinquish automatic management.
          if (load(path)?.state !== "deleted") save(path, { state: "excluded" });
          throw error;
        }
        if (retained?.state === "archived") {
          adapters.store.removeDeletedThread({ slot: record.slot, accountFingerprint: record.owner.accountFingerprint, threadId: record.threadId! });
        }
      } finally { await rpc.close(); }
    } catch (error) {
      if (input.signal.aborted) throw error;
      emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_failed", { failure_class: diagnosticFailureClass(error) });
      // Reconsider on a real journal/profile change or the next daemon start,
      // not through a retry/polling loop.
    }
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
    if (filename && (/\.json(?:\.(?:completed|failed))?$/.test(String(filename)) || String(filename).endsWith(".collected"))) wake();
  });
  watcher.on("error", error => emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_retention_failed", { failure_class: diagnosticFailureClass(error) }));
  const stop = () => { closed = true; watcher.close(); if (timer) clearTimeout(timer); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop(); else wake();
  return { wake, async close() { stop(); signal.removeEventListener("abort", stop); await running; } };
}
