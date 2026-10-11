import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatReviewChangeSummary, ChatReviewRecord, ChatReviewUntrackedSnapshot } from "./reviews";

const MAX_GIT_OUTPUT_BYTES = 12 * 1024 * 1024;

export interface ChatReviewDeltaFile {
  readonly path: string;
  readonly additions: number;
  readonly removals: number;
  readonly binary: boolean;
}

export interface ChatReviewDelta {
  readonly patch: string;
  readonly files: readonly ChatReviewDeltaFile[];
  readonly summary: ChatReviewChangeSummary;
}

async function git(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: Buffer | string;
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [
      "-c", "core.quotepath=false",
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      ...input.args,
    ], {
      cwd: input.cwd,
      env: { ...process.env, ...input.environment, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;
    const fail = (message: string): void => {
      if (failed) return;
      failed = true;
      try { child.kill(); } catch { /* best effort */ }
      reject(new Error(message));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) return fail("review comparison Git output exceeded its bound");
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) fail("review comparison Git diagnostics exceeded its bound");
    });
    child.once("error", () => fail("review comparison Git process could not start"));
    child.once("close", code => {
      if (failed) return;
      if (code !== 0) return reject(new Error(`review comparison Git command failed: ${input.args[0] ?? "unknown"}`));
      resolvePromise(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
    });
    child.stdin.once("error", () => { /* close/error is authoritative */ });
    child.stdin.end(input.stdin);
  });
}

function snapshotBytes(snapshot: ChatReviewUntrackedSnapshot): Buffer {
  if (snapshot.encoding === "base64") return Buffer.from(snapshot.content, "base64");
  return Buffer.from(snapshot.content, "utf8");
}

async function materializeCommit(input: {
  readonly workspaceRoot: string;
  readonly objectDirectory: string;
  readonly sourceObjectDirectory: string;
  readonly indexPath: string;
  readonly record: ChatReviewRecord;
}): Promise<string> {
  if (!input.record.head) throw new Error("review comparison requires a committed Git HEAD");
  const environment = {
    GIT_OBJECT_DIRECTORY: input.objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: input.sourceObjectDirectory,
    GIT_INDEX_FILE: input.indexPath,
    GIT_AUTHOR_NAME: "ChatGPT Tela",
    GIT_AUTHOR_EMAIL: "tela@users.noreply.local",
    GIT_COMMITTER_NAME: "ChatGPT Tela",
    GIT_COMMITTER_EMAIL: "tela@users.noreply.local",
  };
  await git({ cwd: input.workspaceRoot, args: ["read-tree", input.record.head], environment });
  if (input.record.patch) {
    await git({
      cwd: input.workspaceRoot,
      args: ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
      environment,
      stdin: input.record.patch,
    });
  }
  for (const snapshot of input.record.untracked) {
    const objectId = (await git({
      cwd: input.workspaceRoot,
      args: ["hash-object", "-w", "--stdin"],
      environment,
      stdin: snapshotBytes(snapshot),
    })).trim();
    await git({
      cwd: input.workspaceRoot,
      args: ["update-index", "--add", "--cacheinfo", snapshot.mode, objectId, snapshot.path],
      environment,
    });
  }
  const tree = (await git({ cwd: input.workspaceRoot, args: ["write-tree"], environment })).trim();
  return (await git({
    cwd: input.workspaceRoot,
    args: ["commit-tree", tree],
    environment,
    stdin: "Tela private review snapshot\n",
  })).trim();
}

function numstatFile(value: string): ChatReviewDeltaFile | undefined {
  const first = value.indexOf("\t");
  const second = first < 0 ? -1 : value.indexOf("\t", first + 1);
  if (first < 0 || second < 0) return undefined;
  const additionsText = value.slice(0, first);
  const removalsText = value.slice(first + 1, second);
  const path = value.slice(second + 1);
  if (!path) return undefined;
  const binary = additionsText === "-" || removalsText === "-";
  const additions = binary ? 0 : Number(additionsText);
  const removals = binary ? 0 : Number(removalsText);
  if ((!binary && (!Number.isSafeInteger(additions) || !Number.isSafeInteger(removals))) || additions < 0 || removals < 0) {
    throw new Error("review comparison numstat was invalid");
  }
  return Object.freeze({ path, additions, removals, binary });
}

export async function compareChatReviewRecords(input: {
  readonly workspaceRoot: string;
  readonly scratchRoot: string;
  readonly before: ChatReviewRecord;
  readonly after: ChatReviewRecord;
}): Promise<ChatReviewDelta> {
  if (input.before.workspaceId !== input.after.workspaceId) throw new Error("review comparison workspace identity mismatch");
  mkdirSync(input.scratchRoot, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(input.scratchRoot, "compare-"));
  try {
    const commonDirText = (await git({ cwd: input.workspaceRoot, args: ["rev-parse", "--git-common-dir"] })).trim();
    const commonDir = realpathSync(resolve(input.workspaceRoot, commonDirText));
    const sourceObjectDirectory = realpathSync(join(commonDir, "objects"));
    const objectDirectory = join(temporary, "objects");
    mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
    const beforeCommit = await materializeCommit({
      workspaceRoot: input.workspaceRoot,
      objectDirectory,
      sourceObjectDirectory,
      indexPath: join(temporary, "before.index"),
      record: input.before,
    });
    const afterCommit = await materializeCommit({
      workspaceRoot: input.workspaceRoot,
      objectDirectory,
      sourceObjectDirectory,
      indexPath: join(temporary, "after.index"),
      record: input.after,
    });
    const comparisonEnvironment = {
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjectDirectory,
    };
    const [patch, numstat] = await Promise.all([
      git({
        cwd: input.workspaceRoot,
        args: ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", beforeCommit, afterCommit, "--", "."],
        environment: comparisonEnvironment,
      }),
      git({
        cwd: input.workspaceRoot,
        args: ["diff", "--numstat", "-z", "--no-renames", beforeCommit, afterCommit, "--", "."],
        environment: comparisonEnvironment,
      }),
    ]);
    const files = Object.freeze(numstat.split("\u0000").filter(Boolean).map(numstatFile).filter((value): value is ChatReviewDeltaFile => value !== undefined));
    const untrackedPaths = new Set([...input.before.untracked, ...input.after.untracked].map(item => item.path));
    const untrackedFiles = files.filter(file => untrackedPaths.has(file.path)).length;
    const summary: ChatReviewChangeSummary = Object.freeze({
      files: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      removals: files.reduce((total, file) => total + file.removals, 0),
      trackedFiles: files.length - untrackedFiles,
      untrackedFiles,
      complete: files.every(file => !file.binary),
    });
    return Object.freeze({ patch, files, summary });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
