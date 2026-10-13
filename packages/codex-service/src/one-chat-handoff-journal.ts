import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Source-independent, local SQLite ledger for one-click single-conversation
 * checkpoint transfer. No prompt, chat text, account login or cookie is stored.
 *
 * Record admission BEFORE any destination Native mutation. An interrupted
 * attempt is uncertain after restart, not permission to blindly send again.
 * The official destination account may need manual owner-verified inspection.
 */
export interface HandoffJournalRecord {
  readonly operationId: string;
  readonly intentFingerprint: string;
  readonly state: "reserved" | "created" | "seeded" | "uncertain";
  readonly createdAtMs: number;
  readonly destinationThreadId?: string;
  readonly destinationTurnId?: string;
}

export interface OneChatHandoffJournal {
  reserve(operationId: string, intentFingerprint: string): void;
  markCreated(operationId: string, intentFingerprint: string, destinationThreadId: string): void;
  markSeeded(operationId: string, intentFingerprint: string, destinationTurnId: string): void;
  markUncertain(operationId: string, intentFingerprint: string): void;
  get(operationId: string): HandoffJournalRecord | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 10_000;

function requiredId(id: string): void {
  if (!UUID.test(id)) throw new Error("One-chat handoff requires an exact operation UUID");
}

export class SqliteOneChatHandoffJournal implements OneChatHandoffJournal {
  readonly #database: DatabaseSync;
  constructor(path: string) {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()
      || (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()))) {
      throw new Error("Unsafe one-chat handoff journal ownership");
    }
    this.#database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#database.exec(`
      pragma journal_mode = WAL;
      pragma synchronous = FULL;
      create table if not exists handoff (
        operation_id text primary key,
        intent_fingerprint text not null,
        state text not null,
        created_at_ms integer not null,
        destination_thread_id text,
        destination_turn_id text
      );
      create unique index if not exists handoff_by_exact_intent
        on handoff(intent_fingerprint);
    `);
  }

  close(): void { this.#database.close(); }

  get(operationId: string): HandoffJournalRecord | undefined {
    requiredId(operationId);
    const row = this.#database.prepare(`
      select operation_id, intent_fingerprint, state, created_at_ms,
        destination_thread_id, destination_turn_id from handoff where operation_id = ?
    `).get(operationId) as {
      operation_id: string; intent_fingerprint: string; state: string; created_at_ms: number;
      destination_thread_id: string | null; destination_turn_id: string | null;
    } | undefined;
    if (!row) return undefined;
    if (row.operation_id !== operationId || !SHA.test(row.intent_fingerprint)
      || !["reserved", "created", "seeded", "uncertain"].includes(row.state)
      || !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms <= 0
      || (row.destination_thread_id !== null && !UUID.test(row.destination_thread_id))
      || (row.destination_turn_id !== null && !UUID.test(row.destination_turn_id))) {
      throw new Error("One-chat handoff journal integrity is invalid");
    }
    return Object.freeze({
      operationId, intentFingerprint: row.intent_fingerprint,
      state: row.state as HandoffJournalRecord["state"], createdAtMs: row.created_at_ms,
      ...(row.destination_thread_id ? { destinationThreadId: row.destination_thread_id } : {}),
      ...(row.destination_turn_id ? { destinationTurnId: row.destination_turn_id } : {}),
    });
  }

  reserve(operationId: string, intentFingerprint: string): void {
    requiredId(operationId);
    if (!SHA.test(intentFingerprint)) throw new Error("Invalid one-chat handoff intent fingerprint");
    this.#database.exec("begin immediate");
    try {
      const prior = this.get(operationId);
      if (prior) {
        if (prior.intentFingerprint !== intentFingerprint) {
          throw new Error("One-chat handoff operation ID was reused for a different conversation");
        }
        throw new Error("One-chat handoff may have created a destination; never retry automatically");
      }
      const sameIntent = this.#database.prepare(
        "select operation_id from handoff where intent_fingerprint = ?",
      ).get(intentFingerprint) as { operation_id: string } | undefined;
      if (sameIntent) {
        throw new Error("One-chat handoff with this original conversation and target was already attempted");
      }
      const count = this.#database.prepare("select count(*) as n from handoff").get() as { n: number };
      if (count.n >= MAX_ENTRIES) throw new Error("One-chat handoff journal is at capacity");
      this.#database.prepare(`
        insert into handoff (operation_id, intent_fingerprint, state, created_at_ms)
        values (?, ?, 'reserved', ?)
      `).run(operationId, intentFingerprint, Date.now());
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  #transition(operationId: string, fingerprint: string, to: HandoffJournalRecord["state"],
    thread?: string, turn?: string): void {
    requiredId(operationId);
    if (!SHA.test(fingerprint) || (thread && !UUID.test(thread)) || (turn && !UUID.test(turn))) {
      throw new Error("One-chat handoff journal transition has invalid identities");
    }
    this.#database.exec("begin immediate");
    try {
      const prior = this.get(operationId);
      if (!prior || prior.intentFingerprint !== fingerprint || prior.state === "uncertain"
        || (to === "created" && (prior.state !== "reserved" || !thread))
        || (to === "seeded" && (prior.state !== "created" || !prior.destinationThreadId || !turn))
        || (to === "uncertain" && prior.state === "seeded")) {
        throw new Error("One-chat handoff journal cannot confirm this state change");
      }
      const update = this.#database.prepare(`
        update handoff set state = ?, destination_thread_id = ?, destination_turn_id = ?
        where operation_id = ? and intent_fingerprint = ?
      `);
      update.run(to, thread ?? prior.destinationThreadId ?? null,
        turn ?? prior.destinationTurnId ?? null, operationId, fingerprint);
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  markCreated(operationId: string, fingerprint: string, threadId: string): void {
    this.#transition(operationId, fingerprint, "created", threadId);
  }
  markSeeded(operationId: string, fingerprint: string, turnId: string): void {
    this.#transition(operationId, fingerprint, "seeded", undefined, turnId);
  }
  markUncertain(operationId: string, fingerprint: string): void {
    this.#transition(operationId, fingerprint, "uncertain");
  }
}
