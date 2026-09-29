import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";
import {
  ChatReviewCheckpointStore,
  summarizeChatReview,
  summarizeLiveChatChanges,
  type ChatReviewChangeSummary,
  type ChatReviewRecord,
  type ChatReviewSummary,
} from "./reviews";
import type { ChatWorkspaceRegistry } from "./workspaces";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

export interface ChatChangesResult {
  readonly gitRoot: string;
  readonly head?: string;
  readonly status: string;
  readonly patch: string;
  readonly untracked: readonly string[];
  readonly historical: false;
  readonly reviewRef?: string;
  readonly reviewCheckpoint:
    | { readonly available: true; readonly reviewRef: string }
    | { readonly available: false; readonly reason: string };
  readonly summary: ChatReviewChangeSummary;
}

function untrackedFromPorcelainZ(value: string): readonly string[] {
  return Object.freeze(value.split("\u0000")
    .filter(entry => entry.startsWith("?? "))
    .map(entry => entry.slice(3)));
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
    },
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return result.stdout;
}

export class ChatChangeReviewer {
  constructor(
    readonly workspaces: ChatWorkspaceRegistry,
    readonly reviews: ChatReviewCheckpointStore,
  ) {}

  async show(workspaceId: string): Promise<ChatChangesResult> {
    const workspace = this.workspaces.get(workspaceId);
    let gitRoot: string;
    try {
      gitRoot = (await git(workspace.root, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
      throw new Error("show_changes requires a Git-backed workspace", { cause: error });
    }
    const canonicalGitRoot = realpathSync(gitRoot);
    const gitRootIdentity = statSync(canonicalGitRoot, { bigint: true });
    if (
      gitRootIdentity.dev.toString() !== workspace.device
      || gitRootIdentity.ino.toString() !== workspace.inode
    ) {
      throw new Error("show_changes refuses a Git repository whose root is outside the approved workspace root");
    }
    let head: string | undefined;
    try { head = (await git(workspace.root, ["rev-parse", "HEAD"])).trim() || undefined; }
    catch { /* An unborn repository has no HEAD yet. */ }
    const status = await git(workspace.root, ["status", "--short", "--untracked-files=all", "--", "."]);
    const patch = head
      ? await git(workspace.root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", "."])
      : "";
    const untracked = untrackedFromPorcelainZ(await git(workspace.root, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--", ".",
    ]));
    let checkpoint: ChatChangesResult["reviewCheckpoint"];
    let captured: ChatReviewRecord | undefined;
    try {
      const review = this.reviews.capture({
        workspaceId,
        workspaceRoot: workspace.root,
        ...(head ? { head } : {}),
        status,
        patch,
        untrackedPaths: untracked,
      });
      captured = review;
      checkpoint = Object.freeze({ available: true as const, reviewRef: review.reviewRef });
    } catch (error) {
      checkpoint = Object.freeze({ available: false as const,
        reason: error instanceof Error ? error.message : String(error) });
    }
    return Object.freeze({
      gitRoot: canonicalGitRoot,
      ...(head ? { head } : {}),
      status,
      patch,
      untracked,
      historical: false as const,
      ...(checkpoint.available ? { reviewRef: checkpoint.reviewRef } : {}),
      reviewCheckpoint: checkpoint,
      summary: captured ? summarizeChatReview(captured) : summarizeLiveChatChanges(patch, untracked.length),
    });
  }

  showReview(workspaceId: string, ref: string): ChatReviewRecord & { readonly historical: true; readonly summary: ChatReviewChangeSummary } {
    const review = this.reviews.read(workspaceId, ref);
    return Object.freeze({ ...review, historical: true as const, summary: summarizeChatReview(review) });
  }

  listReviews(workspaceId: string): readonly ChatReviewSummary[] {
    return this.reviews.list(workspaceId);
  }
}
