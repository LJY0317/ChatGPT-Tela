import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CanonicalCurrentTurnSource } from "./binding";
import {
  readCanonicalCurrentTurn,
  type CanonicalCurrentTurnEvidence,
} from "./rollout";

const MAX_SESSION_ENTRIES = 20_000;

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalRolloutName(name: string, threadId: string): boolean {
  const escaped = escapeRegExp(threadId);
  return new RegExp(`^rollout-.+-${escaped}(?:_[A-Za-z0-9-]+)?\\.jsonl$`, "i").test(name);
}

function validateRolloutPath(codexHome: string, candidate: string, threadId: string): string {
  if (!isAbsolute(candidate)) throw new Error("Codex state returned a non-absolute rollout path");
  const sessionsRoot = realpathSync(join(codexHome, "sessions"));
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("Codex rollout path is a symbolic link");
  const rolloutPath = realpathSync(candidate);
  if (!lstatSync(rolloutPath).isFile()) throw new Error("Codex rollout path is not a regular file");
  if (!contains(sessionsRoot, rolloutPath)) throw new Error("Codex rollout path escapes the sessions directory");
  if (!canonicalRolloutName(basename(rolloutPath), threadId)) {
    throw new Error("Codex rollout filename does not belong to the requested thread");
  }
  return rolloutPath;
}

function indexedRollout(sqliteHome: string, threadId: string): string | undefined | null {
  const databasePath = join(sqliteHome, "state_5.sqlite");
  if (!existsSync(databasePath)) return undefined;

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare(`
      SELECT rollout_path
      FROM threads
      WHERE id = ?
      LIMIT 1
    `).get(threadId) as { rollout_path?: unknown } | undefined;
    if (!row) return null;
    if (typeof row.rollout_path !== "string" || row.rollout_path.length === 0) {
      throw new Error("Codex state has an invalid rollout path for the requested thread");
    }
    return row.rollout_path;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Codex state has an invalid rollout path")) {
      throw error;
    }
    // State storage and schema are optional implementation details. Failure to query it never grants
    // authority; the canonical sessions tree may still prove one unique active rollout.
    return undefined;
  } finally {
    database?.close();
  }
}

function scanCanonicalRollouts(codexHome: string, threadId: string): readonly string[] {
  const sessionsRoot = join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const matches: string[] = [];
  let visited = 0;

  const visit = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_SESSION_ENTRIES) {
        throw new Error("Codex sessions directory is too large for an unindexed rollout lookup");
      }
      if (entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) {
        visit(child, depth + 1);
      } else if (entry.isFile() && depth === 3 && canonicalRolloutName(entry.name, threadId)) {
        matches.push(child);
      }
    }
  };

  visit(sessionsRoot, 0);
  return Object.freeze(matches);
}

/**
 * Resolve the one canonical active rollout under a Codex home. Indexed state is an optimization;
 * its path is still constrained to the live sessions tree. Without a usable index, lookup succeeds
 * only when the sessions tree contains one unambiguous rollout for the thread.
 */
export class CodexHomeCurrentTurnSource implements CanonicalCurrentTurnSource {
  readonly #codexHome: string;
  readonly #sqliteHome: string;

  constructor(options: { readonly codexHome: string; readonly sqliteHome?: string }) {
    this.#codexHome = resolve(options.codexHome);
    this.#sqliteHome = resolve(options.sqliteHome ?? options.codexHome);
  }

  async currentTurn(threadId: string): Promise<CanonicalCurrentTurnEvidence | undefined> {
    const indexed = indexedRollout(this.#sqliteHome, threadId);
    if (indexed === null) return undefined;

    let rolloutPath: string;
    if (indexed !== undefined) {
      rolloutPath = validateRolloutPath(this.#codexHome, indexed, threadId);
    } else {
      const matches = scanCanonicalRollouts(this.#codexHome, threadId);
      if (matches.length === 0) return undefined;
      if (matches.length > 1) {
        throw new Error("Codex has multiple canonical rollouts for the requested thread");
      }
      rolloutPath = validateRolloutPath(this.#codexHome, matches[0]!, threadId);
    }

    return readCanonicalCurrentTurn(rolloutPath, threadId);
  }
}
