import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_EVIDENCE_MAX_BYTES } from "@chatgpt-tela/core";
import type { WebDelegationRecord } from "./web-delegation";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEADER_BYTES = 16 * 1024;
// JSON escaping may expand supported text sixfold; inline image data remains base64.
const INPUT_BYTES = 6 * 576 * 1024 + 8 * (Math.ceil(NATIVE_EVIDENCE_MAX_BYTES / 3) * 4 + 128);
const RETENTION_MS = 30 * 86_400_000, HISTORY_BYTES = 16 * 1024 * 1024;
export interface OriginalWebInput { readonly prompt: string; readonly images?: readonly string[];
  readonly recoveredAnswer?: string }
interface RequestHeader {
  readonly jobId: string;
  readonly slot: number;
  readonly accountFingerprint: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly inputBytes: number;
  readonly inputHash: string;
  readonly execution: Pick<WebDelegationRecord, "state" | "parentJobId" | "threadId" | "turnId" | "failure" | "failureNativeCode" | "toolItems" | "toolResultItems">;
  readonly settlement?: { readonly answerJobId: string; readonly at: number };
}
function execution(record: WebDelegationRecord): RequestHeader["execution"] {
  return { state: record.state, ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.parentJobId ? { parentJobId: record.parentJobId } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}), ...(record.failure ? { failure: record.failure } : {}),
    ...(record.toolItems === undefined ? {} : { toolItems: record.toolItems }),
    ...(record.toolResultItems === undefined ? {} : { toolResultItems: record.toolResultItems }),
    ...(record.failureNativeCode ? { failureNativeCode: record.failureNativeCode } : {}) };
}

/** Original inputs are private sidecars in the existing job journal, not a replay queue.
 * Two JSON lines keep inventory reads independent of potentially large inline images. */
export class WebDelegationRequests {
  constructor(readonly root: string) {}
  #path(id: string): string {
    if (!UUID.test(id)) throw Error("Invalid original Web request ID");
    return join(this.root, `${id}.request.ndjson`);
  }
  header(id: string): RequestHeader | undefined {
    const path = this.#path(id);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > INPUT_BYTES + HEADER_BYTES) throw Error("Invalid original Web request file");
    const fd = openSync(path, "r"), bytes = Buffer.alloc(HEADER_BYTES);
    try {
      const count = readSync(fd, bytes, 0, bytes.length, 0), end = bytes.subarray(0, count).indexOf(10);
      if (end < 0) throw Error("Invalid original Web request header");
      const header = JSON.parse(bytes.subarray(0, end).toString()) as RequestHeader;
      if (header.jobId !== id || !Number.isSafeInteger(header.inputBytes) || header.inputBytes < 1
        || header.inputBytes > INPUT_BYTES) throw Error("Invalid original Web request identity");
      return header;
    } finally { closeSync(fd); }
  }
  #body(id: string, header: RequestHeader): Buffer {
    const all = readFileSync(this.#path(id)), body = all.subarray(all.indexOf(10) + 1);
    if (body.length !== header.inputBytes || createHash("sha256").update(body).digest("hex") !== header.inputHash) {
      throw Error("Original Web input changed; do not replay it");
    }
    return body;
  }
  #write(header: RequestHeader, body: string | Buffer): void {
    const path = this.#path(header.jobId), tmp = `${path}.${randomUUID()}.tmp`;
    const first = JSON.stringify(header) + "\n";
    if (Buffer.byteLength(first) > HEADER_BYTES) throw Error("Original Web request metadata exceeds its bound");
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, first); writeFileSync(fd, body); fsyncSync(fd); }
    catch (error) { closeSync(fd); unlinkSync(tmp); throw error; }
    closeSync(fd);
    try { renameSync(tmp, path); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  capture(record: WebDelegationRecord, input: OriginalWebInput): void {
    if (existsSync(this.#path(record.id))) throw Error("Original request already exists; reconcile the existing job");
    const body = JSON.stringify(input) + "\n", inputBytes = Buffer.byteLength(body);
    if (inputBytes > INPUT_BYTES) throw Error("Original Web input exceeds the supported Native input bound");
    this.#write({ jobId: record.id, slot: record.slot, accountFingerprint: record.owner.accountFingerprint,
      cwd: record.cwd, createdAt: record.createdAt, inputBytes,
      inputHash: createHash("sha256").update(body).digest("hex"), execution: execution(record) }, body);
  }
  input(id: string): OriginalWebInput {
    const header = this.header(id);
    if (!header) throw Error("Original input was not preserved for this older job");
    return JSON.parse(this.#body(id, header).toString()) as OriginalWebInput;
  }
  /** Preserve the last execution evidence before its Native chat/job history disappears. */
  remember(record: WebDelegationRecord, answer?: string): void {
    const header = this.header(record.id);
    if (!header) return;
    const input = JSON.parse(this.#body(record.id, header).toString()) as OriginalWebInput;
    const body = JSON.stringify({ ...input, ...(answer && !header.settlement ? { recoveredAnswer: answer } : {}) }) + "\n";
    this.#write({ ...header, execution: execution(record), inputBytes: Buffer.byteLength(body),
      inputHash: createHash("sha256").update(body).digest("hex") }, body);
  }
  /** Caller has explicitly reviewed a verified answer; transport collection never calls this. */
  settle(id: string, answerJobId: string, answer: string, now = Date.now()): void {
    const header = this.header(id);
    if (!header || !UUID.test(answerJobId)) throw Error("Original request or answer identity is unavailable");
    if (header.settlement) return;
    const input = this.input(id);
    const body = JSON.stringify({ ...input, recoveredAnswer: answer }) + "\n";
    this.#write({ ...header, settlement: { answerJobId, at: now }, inputBytes: Buffer.byteLength(body),
      inputHash: createHash("sha256").update(body).digest("hex") }, body);
  }
  list(input: { slot?: number; after?: string; limit?: number } = {}) {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error("Request page size must be positive");
    const entries: RequestHeader[] = [];
    const ids = readdirSync(this.root).flatMap(name => {
      const id = name.replace(/\.request\.ndjson$/, "");
      return name.endsWith(".request.ndjson") && UUID.test(id) ? [id] : [];
    }).sort();
    for (const id of ids) {
      if (input.after && id <= input.after) continue;
      const header = this.header(id)!;
      if (header.settlement || input.slot !== undefined && header.slot !== input.slot) continue;
      entries.push(header);
      if (entries.length > limit) return { data: entries.slice(0, limit), nextCursor: entries[limit - 1]!.jobId };
    }
    return { data: entries, nextCursor: null };
  }
  /** Existing retention pass owns age/byte cleanup. Unanswered work is never discarded to meet a target. */
  prune(now = Date.now()): { next?: number; pendingBytes: number } {
    const entries = readdirSync(this.root).flatMap(name => {
      const id = name.replace(/\.request\.ndjson$/, "");
      if (!name.endsWith(".request.ndjson") || !UUID.test(id)) return [];
      return [{ id, header: this.header(id)!, bytes: lstatSync(this.#path(id)).size }];
    });
    let bytes = entries.reduce((n, row) => n + row.bytes, 0), next = Infinity;
    for (const row of entries.filter(row => row.header.settlement)
      .sort((a, b) => a.header.settlement!.at - b.header.settlement!.at)) {
      // The job's existing lifecycle still needs this review receipt to reclaim failed history.
      if (existsSync(join(this.root, `${row.id}.json`))) continue;
      const expiry = row.header.settlement!.at + RETENTION_MS;
      if (expiry > now && bytes <= HISTORY_BYTES) { next = Math.min(next, expiry); continue; }
      unlinkSync(this.#path(row.id)); bytes -= row.bytes;
    }
    return { pendingBytes: entries.filter(row => !row.header.settlement).reduce((n, row) => n + row.bytes, 0),
      ...(next === Infinity ? {} : { next }) };
  }
}
