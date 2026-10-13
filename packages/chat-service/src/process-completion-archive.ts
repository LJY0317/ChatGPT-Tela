import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function sameRecord(left: object, right: object): boolean {
  const canonical = (value: object) => JSON.stringify(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)));
  return canonical(left) === canonical(right);
}

/** A separate, bounded history of *proven terminal* commands. The hot process
 * registry owns execution; this archive owns recent idempotency and readback.
 * A command is inserted here durably BEFORE its hot reservation is removed.
 */
export class ProcessCompletionArchive<T extends {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sessionId: number;
  readonly updatedAt: string;
  readonly state: string;
}> {
  readonly #database: DatabaseSync;
  readonly #key: Buffer;
  readonly #limit: number;

  constructor(path: string, key: string, limit = 10_000) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("invalid completion archive configuration");
    }
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) {
      throw new Error("unsafe completion archive directory");
    }
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new Error("unsafe completion archive file");
    }
    this.#key = Buffer.from(key, "hex");
    this.#limit = limit;
    this.#database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#database.exec(`
      pragma journal_mode = WAL;
      pragma synchronous = FULL;
      create table if not exists completed_operations (
        operation_id text primary key,
        session_id integer not null unique,
        workspace_id text not null,
        updated_at text not null,
        payload text not null,
        signature text not null
      );
      create index if not exists completed_operations_by_workspace
        on completed_operations(workspace_id, session_id);
      create index if not exists completed_operations_by_age
        on completed_operations(updated_at);
    `);
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#key)
      .update("tela-chat-completed-v1\0")
      .update(payload)
      .digest("hex");
  }

  #decode(row: { payload: string; signature: string }): T {
    const signature = Buffer.from(row.signature, "hex");
    const expected = Buffer.from(this.#sign(row.payload), "hex");
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new Error("completion archive authentication failed");
    }
    const result = JSON.parse(row.payload) as T;
    if (!result || typeof result !== "object" || !["exited", "signaled", "spawn_failed"].includes(result.state)
      || typeof result.operationId !== "string" || typeof result.workspaceId !== "string"
      || !Number.isSafeInteger(result.sessionId) || result.sessionId < 1
      || !Number.isFinite(Date.parse(result.updatedAt))) {
      throw new Error("completion archive operation is invalid");
    }
    return result;
  }

  count(): number {
    return (this.#database.prepare("select count(*) as n from completed_operations").get() as { n: number }).n;
  }

  get(id: string): T | undefined {
    const row = this.#database.prepare("select payload, signature from completed_operations where operation_id = ?")
      .get(id) as { payload: string; signature: string } | undefined;
    if (!row) return undefined;
    const result = this.#decode(row);
    if (result.operationId !== id || !["exited", "signaled", "spawn_failed"].includes(result.state)) {
      throw new Error("completion archive operation identity is invalid");
    }
    return result;
  }

  /** Exact-session lookup for post-completion owner-worker observations.
   * Callers still must validate workspace and execution mode.
   */
  getBySessionId(sessionId: number): T | undefined {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("invalid archive session id");
    const row = this.#database.prepare("select payload, signature from completed_operations where session_id = ?")
      .get(sessionId) as { payload: string; signature: string } | undefined;
    if (!row) return undefined;
    const result = this.#decode(row);
    if (result.sessionId !== sessionId) throw new Error("completion archive session identity is invalid");
    return result;
  }

  save(operation: T): void {
    this.saveMany([operation]);
  }

  /** One atomic batch for event-driven completion and initial hot-store drain.
   * Replaying an interrupted publication is idempotent; a changed receipt,
   * exhausted archive or failed transaction leaves the batch unpublished.
   */
  saveMany(operations: readonly T[]): void {
    if (!operations.length) return;
    this.#database.exec("begin immediate");
    try {
      let count = this.count();
      const insert = this.#database.prepare(`insert into completed_operations
        (operation_id, session_id, workspace_id, updated_at, payload, signature)
        values (?, ?, ?, ?, ?, ?)`);
      for (const operation of operations) {
        if (!["exited", "signaled", "spawn_failed"].includes(operation.state)) {
          throw new Error("unresolved execution cannot be archived");
        }
        const payload = JSON.stringify(operation);
        const prior = this.get(operation.operationId);
        if (prior) {
          if (!sameRecord(prior, operation)) throw new Error("completion archive reservation changed");
          continue; // Crash after archive commit but before hot-store removal.
        }
        if (count >= this.#limit) throw new Error("completion archive is at capacity; no execution was started");
        insert.run(operation.operationId, operation.sessionId,
          operation.workspaceId, operation.updatedAt, payload, this.#sign(payload));
        count++;
      }
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  remove(operation: T): void {
    const previous = this.get(operation.operationId);
    if (!previous || !sameRecord(previous, operation)) {
      throw new Error("completion archive reservation changed during retirement");
    }
    const result = this.#database.prepare("delete from completed_operations where operation_id = ?")
      .run(operation.operationId);
    if (result.changes !== 1) throw new Error("completion archive retirement was not committed");
  }

  oldestExpired(cutoff: string): T | undefined {
    const row = this.#database.prepare(`select payload, signature from completed_operations
      where updated_at <= ? order by updated_at, session_id limit 1`).get(cutoff) as { payload: string; signature: string } | undefined;
    return row ? this.#decode(row) : undefined;
  }

  page(workspaceId: string, afterSessionId: number, limit: number): T[] {
    const rows = this.#database.prepare(`select payload, signature from completed_operations
      where workspace_id = ? and session_id > ? order by session_id limit ?`)
      .all(workspaceId, afterSessionId, limit) as { payload: string; signature: string }[];
    return rows.map(row => this.#decode(row));
  }

  close(): void { this.#database.close(); }
}
