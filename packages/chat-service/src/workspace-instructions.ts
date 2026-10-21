import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { resolveExistingWorkspacePath } from "./paths";

const INSTRUCTION_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "dist", "build", "target"]);
const MAX_ROOT_INSTRUCTION_BYTES = 128 * 1024;
const MAX_TOTAL_ROOT_INSTRUCTION_BYTES = 256 * 1024;
const MAX_DISCOVERED_INSTRUCTION_FILES = 128;
const MAX_SCANNED_DIRECTORIES = 4_096;
const MAX_SCAN_DEPTH = 16;

export interface ChatLoadedInstruction {
  readonly path: string;
  readonly content: string;
  readonly source: "global" | "workspace";
  readonly scope: "user" | "project";
}

export interface ChatWorkspaceInstructionContext {
  readonly instructions: readonly ChatLoadedInstruction[];
  readonly availableInstructionFiles: readonly string[];
  readonly instructionScanComplete: boolean;
  readonly globalInstructionStatus: "loaded" | "oversized" | "missing";
}

function portableRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function readInstruction(root: string, path: string): { readonly bytes: number; readonly content: string } {
  const absolute = resolveExistingWorkspacePath(root, path);
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new Error(`workspace instruction is not a regular file: ${path}`);
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw new Error(`workspace instruction appears to be binary: ${path}`);
  return Object.freeze({ bytes: bytes.byteLength, content: bytes.toString("utf8") });
}

/**
 * Discover explicit workspace instruction files without silently injecting nested context.
 * Root instructions are loaded when bounded; nested instructions are advertised for an explicit read
 * before work under that subtree. Directory traversal is deterministic and bounded so opening a workspace
 * cannot become an unbounded repository crawl.
 */
export function discoverWorkspaceInstructions(root: string, options: { readonly codexHome?: string } = {}): ChatWorkspaceInstructionContext {
  const loaded: ChatLoadedInstruction[] = [];
  const available = new Set<string>();
  let loadedBytes = 0;
  let scanComplete = true;
  let globalInstructionStatus: ChatWorkspaceInstructionContext["globalInstructionStatus"] = "missing";

  // Standalone Chat has no Native instruction-revision channel. Read only the
  // conventional user Codex home file; workspace roots do not authorize arbitrary
  // reads elsewhere on the filesystem. Re-resolve it on each explicit discovery.
  const globalHome = resolve(options.codexHome ?? resolve(homedir(), ".codex"));
  const globalInstructionPath = resolve(globalHome, "AGENTS.md");
  try {
    const fileStat = lstatSync(globalInstructionPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("global Codex instructions must be a regular file");
    if (fileStat.size > MAX_ROOT_INSTRUCTION_BYTES) {
      globalInstructionStatus = "oversized";
    } else {
      const bytes = readFileSync(globalInstructionPath);
      if (bytes.includes(0)) throw new Error("global Codex instructions appear to be binary");
      const instruction = { bytes: bytes.byteLength, content: bytes.toString("utf8") };
      loaded.push(Object.freeze({ path: "~/.codex/AGENTS.md", content: instruction.content, source: "global", scope: "user" }));
      loadedBytes += instruction.bytes;
      globalInstructionStatus = "loaded";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Missing global instructions are normal; an existing unreadable or invalid
      // file should be surfaced rather than silently treated as absent.
      throw error;
    }
  }

  const rootEntries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of rootEntries) {
    if (!INSTRUCTION_NAMES.has(entry.name) || entry.isDirectory()) continue;
    const stat = lstatSync(resolve(root, entry.name));
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const instruction = readInstruction(root, entry.name);
    if (instruction.bytes <= MAX_ROOT_INSTRUCTION_BYTES
      && loadedBytes + instruction.bytes <= MAX_TOTAL_ROOT_INSTRUCTION_BYTES) {
      loaded.push(Object.freeze({ path: entry.name, content: instruction.content, source: "workspace", scope: "project" }));
      loadedBytes += instruction.bytes;
    } else {
      available.add(entry.name);
    }
  }

  const queue: Array<{ readonly absolute: string; readonly depth: number }> = rootEntries
    .filter(entry => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
    .map(entry => ({ absolute: resolve(root, entry.name), depth: 1 }));
  let scannedDirectories = 0;

  while (queue.length > 0) {
    if (scannedDirectories >= MAX_SCANNED_DIRECTORIES || available.size >= MAX_DISCOVERED_INSTRUCTION_FILES) {
      scanComplete = false;
      break;
    }
    const current = queue.shift()!;
    scannedDirectories += 1;
    if (current.depth > MAX_SCAN_DEPTH) {
      scanComplete = false;
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      scanComplete = false;
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          queue.push({ absolute: resolve(current.absolute, entry.name), depth: current.depth + 1 });
        }
        continue;
      }
      if (!INSTRUCTION_NAMES.has(entry.name)) continue;
      const path = portableRelative(root, resolve(current.absolute, entry.name));
      try {
        const absolute = resolve(current.absolute, entry.name);
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        available.add(path);
      } catch {
        // An instruction-shaped path that cannot be proven inside the workspace is not safe to advertise.
        scanComplete = false;
      }
      if (available.size >= MAX_DISCOVERED_INSTRUCTION_FILES) {
        scanComplete = false;
        break;
      }
    }
  }

  return Object.freeze({
    instructions: Object.freeze(loaded),
    availableInstructionFiles: Object.freeze([...available].sort()),
    instructionScanComplete: scanComplete,
    globalInstructionStatus,
  });
}
