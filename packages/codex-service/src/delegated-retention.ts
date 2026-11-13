import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { acknowledgeNativeResult, type ResultAcknowledgement, type ResultReference } from "./result-acknowledgement";

const DAY = 86_400_000, MAX_BYTES = 4 * 1024 * 1024;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type State = {
  version: 1; scope: string; slot: number; parentThreadId: string; threadId: string;
  enrolledAt: number; dueAt: number; acknowledgement?: ResultAcknowledgement;
  archivedAt?: number; archivePending?: true; deferred?: string;
};
export interface DelegatedRetentionProfile {
  /** Install identity + exact configured profile/home; never a model-supplied label. */
  scope: string;
  connect(threadId: string, lifecycle: boolean): Promise<CodexAppServerRpc>;
}
function id(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw Error("Invalid delegation identity");
  return value;
}
function lineage(thread: any, parent: string, child: string): void {
  if (thread?.id !== child || thread.source?.subAgent?.thread_spawn?.parent_thread_id !== parent
    || thread.parentThreadId != null && thread.parentThreadId !== parent) throw Error("Delegation lineage changed");
}
function terminalTime(turn: any): number | undefined {
  return ["completed", "failed", "interrupted"].includes(turn?.status)
    && typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt) && turn.completedAt >= 0
    ? turn.completedAt * 1000 : undefined;
}
async function latest(rpc: CodexAppServerRpc, threadId: string): Promise<any> {
  const result: any = await rpc.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  return result?.data?.[0];
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
      || !Number.isFinite(record.dueAt) || record.archivedAt != null && !Number.isFinite(record.archivedAt)
      || key(record.scope, id(record.threadId)) + ".json" !== file) throw Error("Invalid delegation state");
    id(record.parentThreadId);
    if (record.archivedAt != null && now() - record.archivedAt > 60 * DAY) unlinkSync(join(input.directory, file));
    else records.set(file.slice(0, -5), record);
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
    const due = Math.min(...[...records.values()].filter(r => r.archivedAt == null && !r.archivePending && !r.deferred).map(r => r.dueAt));
    if (!Number.isFinite(due)) return;
    timer = setTimeout(() => { void api.reconcile().catch(report); }, Math.min(Math.max(0, due - now()), 2_147_483_647));
    timer.unref?.();
  };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(() => { if (closed) throw Error("Delegation retention is closed"); return work(); });
    queue = result.then(() => undefined, () => undefined);
    return result.finally(schedule);
  };
  const event = (stage: string, record: State) => emitDiagnosticEvent("chatgpt_tela_codex", stage, {
    slot: record.slot, scope_fingerprint: record.scope, thread_fingerprint: hash(record.threadId),
  });
  const report = (error: unknown) => emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_failed", diagnosticFailureFields(error));
  const api = {
    enroll(slot: number, parentThreadId: string, threadId: string) {
      return serial(async () => {
        if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw Error("Invalid profile slot");
        id(parentThreadId); id(threadId);
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, threadId);
        const rpc = await profile.connect(threadId, false);
        try {
          const data: any = await rpc.request("thread/read", { threadId, includeTurns: false });
          lineage(data?.thread, parentThreadId, threadId);
          const existing = records.get(k);
          if (existing && existing.archivedAt == null) return existing;
          const turn = await latest(rpc, threadId);
          // Enrollment time is only an initial observation for active/missing history;
          // no archive can occur until an official terminal completedAt is available.
          const dueAt = (terminalTime(turn) ?? now()) + 7 * DAY;
          const record: State = { version: 1, scope, slot, parentThreadId, threadId, enrolledAt: now(), dueAt };
          save(k, record);
          event("delegation_retention_enrolled", record);
          return record;
        } finally { await rpc.close(); }
      });
    },
    acknowledge(slot: number, result: ResultReference) {
      return serial(async () => {
        const profile = input.profile(slot), scope = hash(profile.scope), k = key(scope, result.threadId);
        const rpc = await profile.connect(result.threadId, false);
        try {
          const verified = await acknowledgeNativeResult({ rpc, result,
            directory: input.acknowledgementDirectory, scope: profile.scope, now: now() });
          const record = records.get(k);
          const acknowledgement = record?.acknowledgement?.scope === scope
            && JSON.stringify(record.acknowledgement.result) === JSON.stringify(verified.result)
            ? record.acknowledgement : verified;
          if (record && record.archivedAt == null && !record.archivePending) {
            if (record.parentThreadId !== result.parentThreadId) throw Error("Acknowledgement parent changed");
            const turn = await latest(rpc, result.threadId), activity = terminalTime(turn);
            if (turn?.id === result.turnId && activity != null) {
              const next = { ...record, acknowledgement, dueAt: Math.max(activity, Date.parse(acknowledgement.acknowledgedAt)) + DAY / 2 };
              delete next.deferred;
              save(k, next);
              if (record.acknowledgement?.acknowledgedAt !== acknowledgement.acknowledgedAt
                || record.acknowledgement?.result.turnId !== acknowledgement.result.turnId) event("delegation_retention_acknowledged", next);
            }
          }
          return { acknowledgement, enrolled: !!record, automaticArchiveEnabled: !!record && record.archivedAt == null && !record.archivePending, automaticDeleteEnabled: false };
        } finally { await rpc.close(); }
      });
    },
    reconcile(slot?: number) {
      return serial(async () => {
        const outcomes: { threadId: string; status: string }[] = [];
        for (const [k, record] of records) {
          if (slot != null && record.slot !== slot || record.archivedAt != null) continue;
          if (record.archivePending) { outcomes.push({ threadId: record.threadId, status: "archive_unconfirmed" }); continue; }
          if (record.dueAt > now()) continue;
          let rpc: CodexAppServerRpc | undefined;
          try {
            const profile = input.profile(record.slot);
            if (hash(profile.scope) !== record.scope) throw Error("Configured profile ownership changed");
            rpc = await profile.connect(record.threadId, true);
            // The installed engine acquires its writer here. Another owner must
            // release naturally; never send turn/start, interrupt, delete or retry.
            const resumed: any = await rpc.request("thread/resume", { threadId: record.threadId, excludeTurns: true });
            lineage(resumed?.thread, record.parentThreadId, record.threadId);
            if (resumed.thread.status?.type !== "idle") throw Error("Delegation is not idle");
            const turn = await latest(rpc, record.threadId), activity = terminalTime(turn);
            if (activity == null) throw Error("Official terminal activity time is unavailable");
            const ack = record.acknowledgement;
            const confirmed = ack?.scope === record.scope && ack.result.parentThreadId === record.parentThreadId
              && ack.result.threadId === record.threadId && ack.result.turnId === turn.id;
            const dueAt = confirmed ? Math.max(activity, Date.parse(ack!.acknowledgedAt)) + DAY / 2 : activity + 7 * DAY;
            if (!Number.isFinite(dueAt)) throw Error("Invalid result acknowledgement time");
            const next = { ...record, dueAt };
            delete next.deferred;
            if (dueAt > now()) { save(k, next); outcomes.push({ threadId: record.threadId, status: "not_due" }); continue; }
            // Durable intent prevents re-archiving a manually restored chat if
            // the process dies between the mutation and confirmation write.
            save(k, { ...next, archivePending: true });
            event("delegation_retention_archive_requested", next);
            await rpc.request("thread/archive", { threadId: record.threadId });
            save(k, { ...next, archivedAt: now() });
            event("delegation_retention_archive_completed", next);
            outcomes.push({ threadId: record.threadId, status: "archived" });
          } catch (error) {
            // No busy-loop: only startup or an explicit management event can
            // revisit a due-but-deferred record. Task execution is unaffected.
            if (records.get(k)?.archivePending) report(error);
            else if (!record.deferred) {
              report(error); save(k, { ...record, deferred: "lifecycle_unavailable" });
              event("delegation_retention_deferred", record);
            }
            outcomes.push({ threadId: record.threadId, status: "deferred" });
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
