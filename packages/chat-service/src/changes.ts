import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { compareChatReviewRecords, type ChatReviewDeltaFile } from "./review-diff";
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
  readonly reviewDelta:
    | {
        readonly available: true;
        readonly since: ChatReviewSince;
        readonly fromReviewRef: string;
        readonly toReviewRef: string;
        readonly patch: string;
        readonly files: readonly ChatReviewDeltaFile[];
        readonly summary: ChatReviewChangeSummary;
      }
    | { readonly available: false; readonly reason: string };
}

export type ChatReviewBaselineStatus =
  | { readonly available: true; readonly reviewRef: string; readonly openReviewRef: string; readonly reused: boolean }
  | { readonly available: false; readonly reason: string };

export type ChatReviewSince = "last_shown" | "workspace_open";

interface CurrentReviewSnapshot {
  readonly gitRoot: string;
  readonly head?: string;
  readonly status: string;
  readonly patch: string;
  readonly untracked: readonly string[];
  readonly review?: ChatReviewRecord;
  readonly reviewCheckpoint: ChatChangesResult["reviewCheckpoint"];
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
  readonly #comparisonRoot: string;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(
    readonly workspaces: ChatWorkspaceRegistry,
    readonly reviews: ChatReviewCheckpointStore,
    comparisonRoot: string,
  ) {
    this.#comparisonRoot = resolve(comparisonRoot);
  }

  async #exclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const ready = (this.#tails.get(workspaceId) ?? Promise.resolve()).catch(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const tail = ready.then(() => gate);
    this.#tails.set(workspaceId, tail);
    await ready;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(workspaceId) === tail) this.#tails.delete(workspaceId);
    }
  }

  async initializeWorkspace(workspaceId: string): Promise<ChatReviewBaselineStatus> {
    return this.#exclusive(workspaceId, async () => {
      let existing: string | undefined;
      try { existing = this.reviews.baselineRef(workspaceId); }
      catch { return Object.freeze({ available: false as const, reason: "review baseline state is unavailable" }); }
      if (existing) {
        try {
          this.reviews.read(workspaceId, existing);
          const openReviewRef = this.reviews.openBaselineRef(workspaceId) ?? existing;
          this.reviews.read(workspaceId, openReviewRef);
          return Object.freeze({ available: true as const, reviewRef: existing, openReviewRef, reused: true });
        } catch {
          try { this.reviews.clearBaseline(workspaceId); } catch { /* baseline remains fail-closed */ }
        }
      }
      try {
        const snapshot = await this.#captureCurrent(workspaceId);
        if (!snapshot.review) {
          return Object.freeze({ available: false as const, reason: snapshot.reviewCheckpoint.available
            ? "review baseline checkpoint was unavailable"
            : snapshot.reviewCheckpoint.reason });
        }
        this.reviews.setBaseline(workspaceId, snapshot.review.reviewRef);
        return Object.freeze({
          available: true as const,
          reviewRef: snapshot.review.reviewRef,
          openReviewRef: snapshot.review.reviewRef,
          reused: false,
        });
      } catch {
        return Object.freeze({ available: false as const, reason: "review baseline is unavailable for this workspace" });
      }
    });
  }

  async show(workspaceId: string, options: {
    readonly since?: ChatReviewSince;
    readonly markReviewed?: boolean;
  } = {}): Promise<ChatChangesResult> {
    return this.#exclusive(workspaceId, async () => {
      const since = options.since ?? "last_shown";
      const markReviewed = options.markReviewed ?? true;
      let baselineRef: string | undefined;
      let baseline: ChatReviewRecord | undefined;
      try {
        baselineRef = since === "workspace_open"
          ? this.reviews.openBaselineRef(workspaceId)
          : this.reviews.baselineRef(workspaceId);
        if (baselineRef) baseline = this.reviews.read(workspaceId, baselineRef);
      } catch {
        baselineRef = undefined;
        baseline = undefined;
        try { this.reviews.clearBaseline(workspaceId); } catch { /* baseline remains fail-closed */ }
      }
      const snapshot = await this.#captureCurrent(workspaceId);
      const summary = snapshot.review
        ? summarizeChatReview(snapshot.review)
        : summarizeLiveChatChanges(snapshot.patch, snapshot.untracked.length);
      let reviewDelta: ChatChangesResult["reviewDelta"];
      if (baseline && baselineRef && snapshot.review) {
        try {
          const delta = await compareChatReviewRecords({
            workspaceRoot: this.workspaces.get(workspaceId).root,
            scratchRoot: this.#comparisonRoot,
            before: baseline,
            after: snapshot.review,
          });
          if (markReviewed) this.reviews.setBaseline(workspaceId, snapshot.review.reviewRef);
          reviewDelta = Object.freeze({
            available: true as const,
            since,
            fromReviewRef: baselineRef,
            toReviewRef: snapshot.review.reviewRef,
            patch: delta.patch,
            files: delta.files,
            summary: delta.summary,
          });
        } catch {
          reviewDelta = Object.freeze({ available: false as const, reason: `${since.replace("_", "-")} review comparison was unavailable` });
        }
      } else if (snapshot.review) {
        try { if (markReviewed) this.reviews.setBaseline(workspaceId, snapshot.review.reviewRef); }
        catch { /* the returned checkpoint remains usable even if baseline state cannot advance */ }
        reviewDelta = Object.freeze({
          available: false as const,
          reason: markReviewed
            ? `${since.replace("_", "-")} baseline was unavailable; the current checkpoint established a new baseline`
            : `${since.replace("_", "-")} baseline was unavailable`,
        });
      } else {
        reviewDelta = Object.freeze({
          available: false as const,
          reason: snapshot.reviewCheckpoint.available
            ? "current review checkpoint was unavailable"
            : snapshot.reviewCheckpoint.reason,
        });
      }
      return Object.freeze({
        gitRoot: snapshot.gitRoot,
        ...(snapshot.head ? { head: snapshot.head } : {}),
        status: snapshot.status,
        patch: snapshot.patch,
        untracked: snapshot.untracked,
        historical: false as const,
        ...(snapshot.reviewCheckpoint.available ? { reviewRef: snapshot.reviewCheckpoint.reviewRef } : {}),
        reviewCheckpoint: snapshot.reviewCheckpoint,
        summary,
        reviewDelta,
      });
    });
  }

  async #captureCurrent(workspaceId: string): Promise<CurrentReviewSnapshot> {
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
      reviewCheckpoint: checkpoint,
      ...(captured ? { review: captured } : {}),
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
