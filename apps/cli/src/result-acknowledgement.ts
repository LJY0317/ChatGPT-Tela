import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndexedNativeItemsPage, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";

const RETENTION_MS = 60 * 86_400_000;
const RETENTION_BYTES = 4 * 1024 * 1024;

export type ResultReference = {
  readonly parentThreadId: string;
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
  const ids = [value.parentThreadId, value.threadId, value.turnId,
    ...(value.outcome === "answer" ? [value.itemId] : [])];
  if (ids.some(id => typeof id !== "string" || !id.trim() || id.length > 512)
    || !["answer", "failed", "interrupted"].includes(value.outcome)) throw Error("Invalid result reference");
  return { parentThreadId: value.parentThreadId, threadId: value.threadId, turnId: value.turnId,
    ...(value.outcome === "answer" ? { outcome: value.outcome, itemId: value.itemId } : { outcome: value.outcome }) };
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
  const source = object(object(object(thread.source).subAgent).thread_spawn);
  if (thread.id !== result.threadId || source.parent_thread_id !== result.parentThreadId
    || thread.parentThreadId != null && thread.parentThreadId !== result.parentThreadId) {
    throw Error("Result does not belong to the specified parent and child");
  }
  if (result.outcome === "answer") {
    let cursor: string | undefined;
    const visited = new Set<string>();
    let found = false;
    do {
      const page = await readIndexedNativeItemsPage(input.rpc, {
        threadId: result.threadId, turnId: result.turnId, limit: 32, sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      }, input.signal ?? new AbortController().signal);
      const item = page.data.find(row => row.item.id === result.itemId)?.item;
      if (item) {
        if (item.type !== "agentMessage" || item.phase !== "final_answer") throw Error("Selected item is not a final answer");
        found = true;
        break;
      }
      if (page.nextCursor == null) break;
      if (typeof page.nextCursor !== "string" || visited.has(page.nextCursor)) throw Error("Official result paging did not advance");
      cursor = page.nextCursor;
      visited.add(cursor);
    } while (cursor);
    if (!found) throw Error("Final answer was not found in the specified turn");
  } else {
    // Failures need a terminal turn receipt; they may have no assistant message.
    const turns = object(await input.rpc.request("thread/turns/list", {
      threadId: result.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
    }, input.signal));
    const latest = Array.isArray(turns.data) ? turns.data[0] : undefined;
    if (latest?.id !== result.turnId || latest.status !== result.outcome) {
      throw Error("The specified terminal failure is not the latest recorded turn");
    }
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
