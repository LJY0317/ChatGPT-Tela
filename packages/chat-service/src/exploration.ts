import { lstatSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { resolveExistingWorkspacePath, resolveWorkspaceDirectory } from "./paths";

const SKIPPED_SEARCH_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "dist", "build", "target"]);
const MAX_DIRECTORY_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 4_096;
const MAX_SEARCH_DIRECTORIES = 4_096;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 400;

export interface ChatDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface ChatDirectoryListing {
  readonly path: string;
  readonly entries: readonly ChatDirectoryEntry[];
  readonly hasMore: boolean;
}

export interface ChatTextSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export interface ChatTextSearchResult {
  readonly path: string;
  readonly matches: readonly ChatTextSearchMatch[];
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly binaryFilesSkipped: number;
  readonly oversizedFilesSkipped: number;
  readonly hasMore: boolean;
  readonly scanComplete: boolean;
}

function portableRelative(root: string, absolute: string): string {
  const value = relative(root, absolute).split(sep).join("/");
  return value || ".";
}

function entryKind(entry: Dirent): ChatDirectoryEntry["kind"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function boundedPreview(line: string): string {
  if (line.length <= MAX_PREVIEW_CHARS) return line;
  return `${line.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}

export class ChatExplorationTools {
  constructor(readonly workspaces: ChatWorkspaceRegistry) {}

  listDirectory(input: {
    readonly workspaceId: string;
    readonly path?: string;
    readonly limit?: number;
  }): ChatDirectoryListing {
    const workspace = this.workspaces.get(input.workspaceId);
    const absolute = resolveWorkspaceDirectory(workspace.root, input.path);
    const limit = input.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`directory limit must be an integer from 1 to ${MAX_DIRECTORY_ENTRIES}`);
    }
    const entries = readdirSync(absolute, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    return Object.freeze({
      path: portableRelative(workspace.root, absolute),
      entries: Object.freeze(entries.slice(0, limit).map(entry => Object.freeze({
        name: entry.name,
        kind: entryKind(entry),
      }))),
      hasMore: entries.length > limit,
    });
  }

  searchText(input: {
    readonly workspaceId: string;
    readonly query: string;
    readonly path?: string;
    readonly caseSensitive?: boolean;
    readonly maxResults?: number;
  }): ChatTextSearchResult {
    const workspace = this.workspaces.get(input.workspaceId);
    if (typeof input.query !== "string" || !input.query || input.query.includes("\u0000")) {
      throw new Error("search query is invalid");
    }
    const maxResults = input.maxResults ?? 50;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      throw new Error(`max_results must be an integer from 1 to ${MAX_SEARCH_RESULTS}`);
    }
    const start = input.path === undefined || input.path.trim() === "" || input.path === "."
      ? workspace.root
      : resolveExistingWorkspacePath(workspace.root, input.path);
    const startStat = lstatSync(start);
    const query = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    const matches: ChatTextSearchMatch[] = [];
    const files: string[] = [];
    const directories: string[] = [];
    if (startStat.isFile()) files.push(start);
    else if (startStat.isDirectory()) directories.push(start);
    else throw new Error("search path is not a regular file or directory");

    let filesScanned = 0;
    let directoriesScanned = 0;
    let bytesScanned = 0;
    let binaryFilesSkipped = 0;
    let oversizedFilesSkipped = 0;
    let scanComplete = true;
    let hasMore = false;

    while (directories.length > 0) {
      if (directoriesScanned >= MAX_SEARCH_DIRECTORIES || files.length >= MAX_SEARCH_FILES) {
        scanComplete = false;
        break;
      }
      const directory = directories.shift()!;
      directoriesScanned += 1;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        scanComplete = false;
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_SEARCH_DIRECTORIES.has(entry.name)) directories.push(absolute);
          continue;
        }
        if (entry.isFile()) files.push(absolute);
        if (files.length >= MAX_SEARCH_FILES) {
          scanComplete = false;
          break;
        }
      }
    }

    for (const absolute of files) {
      if (filesScanned >= MAX_SEARCH_FILES) {
        scanComplete = false;
        break;
      }
      const stat = statSync(absolute);
      if (stat.size > MAX_SEARCH_FILE_BYTES) {
        oversizedFilesSkipped += 1;
        scanComplete = false;
        continue;
      }
      if (bytesScanned + stat.size > MAX_SEARCH_TOTAL_BYTES) {
        scanComplete = false;
        break;
      }
      const bytes = readFileSync(absolute);
      filesScanned += 1;
      bytesScanned += bytes.byteLength;
      if (bytes.includes(0)) {
        binaryFilesSkipped += 1;
        continue;
      }
      const lines = bytes.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const candidate = input.caseSensitive ? line : line.toLocaleLowerCase();
        if (!candidate.includes(query)) continue;
        matches.push(Object.freeze({
          path: portableRelative(workspace.root, absolute),
          line: index + 1,
          preview: boundedPreview(line),
        }));
        if (matches.length >= maxResults) {
          hasMore = true;
          scanComplete = false;
          break;
        }
      }
      if (hasMore) break;
    }

    return Object.freeze({
      path: portableRelative(workspace.root, start),
      matches: Object.freeze(matches),
      filesScanned,
      bytesScanned,
      binaryFilesSkipped,
      oversizedFilesSkipped,
      hasMore,
      scanComplete,
    });
  }
}
