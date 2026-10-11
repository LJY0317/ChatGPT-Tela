import { readFileSync, statSync } from "node:fs";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { resolveExistingWorkspacePath } from "./paths";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_READ_MANY_FILES = 20;
const MAX_READ_MANY_LINES = 1_200;
const MAX_READ_MANY_BYTES = 512 * 1024;

export interface ChatReadResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly hasMore: boolean;
  readonly content: string;
}

export interface ChatReadManyResult extends ChatReadResult {
  /** All requested paths are accounted for; a failed file does not erase adjacent successes. */
  readonly status: "ok" | "error" | "skipped";
  readonly error?: {
    readonly code: "not_found" | "path_denied" | "not_regular_file" | "size_limit"
      | "binary" | "invalid_range" | "permission_denied" | "read_failed"
      | "batch_budget_exhausted";
    readonly message: string;
  };
}

type ChatReadManyError = NonNullable<ChatReadManyResult["error"]>;

function readFailure(error: unknown): ChatReadManyError {
  const message = error instanceof Error ? error.message : "";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // Explicit, bounded categories only. Do not expose raw platform exception
  // strings (which can contain full workspace paths or account information).
  if (code === "ENOENT" || message.startsWith("workspace path does not exist")) {
    return { code: "not_found", message: "File does not exist inside the workspace" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { code: "permission_denied", message: "Workspace file access was denied" };
  }
  if (message.includes("path escapes") || message.includes("resolves outside")
    || message.includes("must not be absolute") || message.includes("relative path is invalid")) {
    return { code: "path_denied", message: "Path is not an allowed workspace file" };
  }
  if (message.includes("not a regular file")) {
    return { code: "not_regular_file", message: "Path is not a regular file" };
  }
  if (message.includes("exceeds") && message.includes("bytes")) {
    return { code: "size_limit", message: "File exceeds the permitted size" };
  }
  if (message.includes("appears to be binary")) {
    return { code: "binary", message: "Binary files cannot be read as text" };
  }
  if (message.startsWith("read offset") || message.startsWith("read limit")) {
    return { code: "invalid_range", message: "Requested line range is invalid" };
  }
  return { code: "read_failed", message: "Unable to read this workspace file" };
}

function unreadable(
  path: string, status: "error" | "skipped", error: ChatReadManyError,
): ChatReadManyResult {
  return Object.freeze({
    path, status, error,
    content: "", startLine: 0, endLine: 0, totalLines: 0, hasMore: false,
  });
}

function positive(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${field} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export class ChatFileTools {
  constructor(readonly workspaces: ChatWorkspaceRegistry) {}

  read(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
  }): ChatReadResult {
    const workspace = this.workspaces.get(input.workspaceId);
    const absolute = resolveExistingWorkspacePath(workspace.root, input.path);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("read target is not a regular file");
    if (stat.size > MAX_FILE_BYTES) throw new Error(`read target exceeds ${MAX_FILE_BYTES} bytes`);
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) throw new Error("read target appears to be binary");
    const text = bytes.toString("utf8");
    const lines = text.length === 0 ? [] : text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const offset = positive(input.offset, 1, Math.max(1, lines.length + 1), "read offset");
    const limit = positive(input.limit, 200, MAX_READ_LINES, "read limit");
    const startIndex = offset - 1;
    const selected = lines.slice(startIndex, startIndex + limit);
    return Object.freeze({
      path: input.path,
      startLine: selected.length > 0 ? offset : Math.min(offset, lines.length + 1),
      endLine: selected.length > 0 ? offset + selected.length - 1 : Math.min(offset - 1, lines.length),
      totalLines: lines.length,
      hasMore: startIndex + selected.length < lines.length,
      content: selected.map((line, index) => `${offset + index}: ${line}`).join("\n"),
    });
  }

  readMany(input: {
    readonly workspaceId: string;
    readonly reads: readonly { readonly path: string; readonly offset?: number; readonly limit?: number }[];
  }): readonly ChatReadManyResult[] {
    if (input.reads.length < 1 || input.reads.length > MAX_READ_MANY_FILES) {
      throw new Error(`read_many requires 1-${MAX_READ_MANY_FILES} files`);
    }
    // Authorize the entire batch's workspace before classifying individual paths.
    // A missing/foreign workspace is not a recoverable per-file error.
    this.workspaces.get(input.workspaceId);
    let remainingLines = MAX_READ_MANY_LINES;
    let remainingBytes = MAX_READ_MANY_BYTES;
    const results: ChatReadManyResult[] = [];
    for (const read of input.reads) {
      if (remainingLines <= 0 || remainingBytes <= 0) {
        results.push(unreadable(read.path, "skipped", {
          code: "batch_budget_exhausted", message: "Batch budget exhausted; request this file separately",
        }));
        continue;
      }
      try {
        const requested = Math.min(read.limit ?? 200, remainingLines, MAX_READ_LINES);
        const result = this.read({ workspaceId: input.workspaceId, path: read.path,
          ...(read.offset === undefined ? {} : { offset: read.offset }), limit: requested });
        const bytes = Buffer.byteLength(result.content, "utf8");
        if (bytes > remainingBytes) {
          results.push(unreadable(read.path, "skipped", {
            code: "batch_budget_exhausted", message: "File output exceeds the remaining batch budget; read a smaller range",
          }));
          continue;
        }
        results.push(Object.freeze({ ...result, status: "ok" as const }));
        remainingBytes -= bytes;
        remainingLines -= Math.max(1, result.endLine - result.startLine + 1);
      } catch (error) {
        results.push(unreadable(read.path, "error", readFailure(error)));
      }
    }
    return Object.freeze(results);
  }
}
