import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndexedNativeItemsPage, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";

const RETENTION_MS = 60 * 86_400_000;
const RETENTION_BYTES = 4 * 1024 * 1024;

export type ResultReference = {
  readonly parentThreadId?: string;
  readonly threadId: string;
  readonly turnId: string;
} & ({ readonly outcome: "answer"; readonly itemId: string }
  | { readonly outcome: "failed" | "interrupted" });

export interface ResultAcknowledgement {
  readonly version: 1;
  readonly scope: string;
  readonly result: ResultReference;
  readonly acknowledgedAt: string;
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid official result metadata");
  return value as Record<string, any>;
}

function resultReference(value: ResultReference): ResultReference {
  const ids = [...(value.parentThreadId === undefined ? [] : [value.parentThreadId]), value.threadId, value.turnId,
    ...(value.outcome === "answer" ? [value.itemId] : [])];
  if (ids.some(id => typeof id !== "string" || !id.trim() || id.length > 512)
    || !["answer", "failed", "interrupted"].includes(value.outcome)) throw Error("Invalid result reference");
  return { ...(value.parentThreadId === undefined ? {} : { parentThreadId: value.parentThreadId }),
    threadId: value.threadId, turnId: value.turnId,
    ...(value.outcome === "answer" ? { outcome: value.outcome, itemId: value.itemId } : { outcome: value.outcome }) };
}

export function assertManagedThread(thread: any, threadId: string, parentThreadId?: string): void {
  const spawnParent = thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
  if (thread?.id !== threadId || spawnParent !== parentThreadId
    || thread.parentThreadId != null && thread.parentThreadId !== parentThreadId
    || parentThreadId === undefined && typeof thread.source !== "string") throw Error("Delegation lineage changed");
}

export async function readLatestResultTurn(rpc: Pick<CodexAppServerRpc, "request">,
  threadId: string, signal?: AbortSignal): Promise<{ id: string; status: string } | undefined> {
  const result = object(await rpc.request("thread/turns/list", {
    threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  }, signal));
  if (!Array.isArray(result.data) || result.data.length > 1 || result.data.length === 0 && result.nextCursor != null) {
    throw Error("Official latest-turn metadata is unavailable");
  }
  if (!result.data.length) return undefined;
  const turn = object(result.data[0]);
  if (typeof turn.id !== "string" || typeof turn.status !== "string") throw Error("Official latest-turn metadata is unavailable");
  return { id: turn.id, status: turn.status };
}

/** Read the newest final. Older finals from the same turn are not collection evidence. */
export async function findFinalAnswer(rpc: Pick<CodexAppServerRpc, "request">,
  threadId: string, turnId: string, signal?: AbortSignal) {
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await readIndexedNativeItemsPage(rpc, { threadId, turnId, limit: 32, sortDirection: "desc",
      ...(cursor ? { cursor } : {}),
    }, signal);
    const row = page.data.find(({ item }) => item.type === "agentMessage" && item.phase === "final_answer");
    if (row) return row.item;
    if (page.nextCursor == null) break;
    if (typeof page.nextCursor !== "string" || visited.has(page.nextCursor)) throw Error("Official result paging did not advance");
    cursor = page.nextCursor;
    visited.add(cursor);
  } while (cursor);
  throw Error("Final answer was not found in the specified turn");
}

/** Confirmation of one result, not task enrollment, completion, or authority to remove a chat. */
export async function acknowledgeNativeResult(input: {
  readonly rpc: Pick<CodexAppServerRpc, "request">;
  readonly directory: string;
  /** Install + exact configured profile/home identity, never a model-supplied account label. */
  readonly scope: string;
  readonly result: ResultReference;
  readonly now?: number;
  readonly signal?: AbortSignal;
}): Promise<ResultAcknowledgement> {
  const result = resultReference(input.result);
  const now = input.now ?? Date.now();
  if (!input.scope || !Number.isFinite(now) || now < 0) throw Error("Invalid acknowledgement scope or time");
  const thread = object(object(await input.rpc.request("thread/read", {
    threadId: result.threadId, includeTurns: false,
  }, input.signal)).thread);
  try { assertManagedThread(thread, result.threadId, result.parentThreadId); }
  catch (cause) { throw Error("Result does not belong to the specified parent and child or registered standalone chat", { cause }); }
  const latest = await readLatestResultTurn(input.rpc, result.threadId, input.signal);
  if (result.outcome === "answer") {
    if (latest?.id !== result.turnId || latest.status !== "completed") {
      throw Error("The selected answer is not from the latest completed turn");
    }
    const item = await findFinalAnswer(input.rpc, result.threadId, result.turnId, input.signal);
    if (item.id !== result.itemId) throw Error("The selected answer is no longer the latest final");
  } else if (latest?.id !== result.turnId || latest.status !== result.outcome) {
    throw Error("The specified terminal failure is not the latest recorded turn");
  }
  const scope = createHash("sha256").update(input.scope).digest("hex");
  const name = createHash("sha256").update(JSON.stringify({ scope, result })).digest("hex") + ".json";
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(input.directory).isDirectory() || lstatSync(input.directory).isSymbolicLink()) throw Error("Invalid acknowledgement directory");
  const path = join(input.directory, name);
  let receipt: ResultAcknowledgement = { version: 1, scope, result, acknowledgedAt: new Date(now).toISOString() };
  try {
    writeFileSync(path, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error("Invalid existing acknowledgement");
    const prior = JSON.parse(readFileSync(path, "utf8")) as ResultAcknowledgement;
    if (prior.version !== 1 || prior.scope !== scope || JSON.stringify(prior.result) !== JSON.stringify(result)
      || !Number.isFinite(Date.parse(prior.acknowledgedAt))) throw Error("Acknowledgement contents changed");
    receipt = prior; // Repeated acknowledgement never moves the first-confirmation clock.
  }
  try { pruneAcknowledgements(input.directory, path, now); }
  catch (error) { emitDiagnosticEvent("chatgpt_tela_codex", "result_ack_cleanup_failed", diagnosticFailureFields(error)); }
  return receipt;
}

/** Small derived receipts only. Expiry never removes a conversation or grants cleanup authority. */
function pruneAcknowledgements(directory: string, current: string, now: number): void {
  const files = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    return { path, stat };
  }).filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let bytes = lstatSync(current).size;
  for (const { path, stat } of files) {
    if (path === current) continue;
    if (now - stat.mtimeMs > RETENTION_MS || bytes + stat.size > RETENTION_BYTES) unlinkSync(path);
    else bytes += stat.size;
  }
}
