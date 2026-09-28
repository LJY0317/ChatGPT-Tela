import { readFileSync, statSync } from "node:fs";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { resolveExistingWorkspacePath } from "./paths";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_READ_MANY_FILES = 20;
const MAX_READ_MANY_LINES = 1_200;

export interface ChatReadResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly hasMore: boolean;
  readonly content: string;
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
  }): readonly ChatReadResult[] {
    if (input.reads.length < 1 || input.reads.length > MAX_READ_MANY_FILES) {
      throw new Error(`read_many requires 1-${MAX_READ_MANY_FILES} files`);
    }
    let remainingLines = MAX_READ_MANY_LINES;
    const results: ChatReadResult[] = [];
    for (const read of input.reads) {
      if (remainingLines <= 0) break;
      const requested = Math.min(read.limit ?? 200, remainingLines, MAX_READ_LINES);
      const result = this.read({ workspaceId: input.workspaceId, path: read.path,
        ...(read.offset === undefined ? {} : { offset: read.offset }), limit: requested });
      results.push(result);
      remainingLines -= Math.max(1, result.endLine - result.startLine + 1);
    }
    return Object.freeze(results);
  }
}
