import { createReadStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { NativeSandboxAuthority, NativeIngressTurnMedia } from "@chatgpt-tela/core";

export type CanonicalCurrentTurnProof =
  | "turn-context"
  | "current-task-inherited-context"
  | "app-server-active-turn"
  | "app-server-acknowledged-live-turn";

/** Current Native public goal state. This is observation, not execution authority. */
export interface NativeThreadGoalObservation {
  readonly threadId: string;
  readonly objective: string;
  readonly status: string;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly updatedAt: number;
}

export interface CanonicalCurrentTurnEvidence {
  readonly threadId: string;
  readonly turnId: string;
  readonly parentThreadId?: string;
  readonly agentName?: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly sandbox: NativeSandboxAuthority;
  readonly proof: CanonicalCurrentTurnProof;
  readonly environmentSourceTurnId: string;
  /** Observed public Native ingress bytes; never a substitute for current-turn authority. */
  readonly ingressMedia?: NativeIngressTurnMedia;
  /** Optional, exact-thread read-only public Native goal snapshot. */
  readonly nativeGoal?: NativeThreadGoalObservation;
  /** Read-only public goal discovery: absent is distinct from unsupported. */
  readonly nativeGoalState?: "absent" | "unavailable";
}

interface RolloutEnvironment {
  readonly sourceTurnId: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly sandbox: NativeSandboxAuthority;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`canonical Codex rollout has invalid ${field}`);
  }
  return value.trim();
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`canonical Codex rollout has invalid ${field}`);
  }
  return resolve(value);
}

function absolutePaths(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`canonical Codex rollout has invalid ${field}`);
  return Object.freeze([...new Set(value.map(path => absolutePath(path, field)))]);
}

function environment(payload: Record<string, unknown>): RolloutEnvironment {
  const sourceTurnId = identifier(payload.turn_id, "turn_context turn_id");
  const cwd = absolutePath(payload.cwd, "cwd");
  const workspaceRoots = payload.workspace_roots === undefined
    ? Object.freeze([cwd])
    : absolutePaths(payload.workspace_roots, "workspace_roots");
  return Object.freeze({
    sourceTurnId,
    cwd,
    workspaceRoots,
    sandbox: Object.freeze({ kind: "danger-full-access" as const }),
  });
}

/**
 * Authenticate the latest Native task and its filesystem authority from one canonical rollout.
 *
 * Codex can write `task_started` before it emits the new turn_context. In that interval, the task
 * boundary proves the exact current turn while the latest prior canonical turn_context remains the
 * conservative environment source. Request metadata never fills in a missing canonical context.
 */
export async function readCanonicalCurrentTurn(
  rolloutPath: string,
  expectedThreadId: string,
): Promise<CanonicalCurrentTurnEvidence> {
  let currentTurnId: string | undefined;
  let latestEnvironment: RolloutEnvironment | undefined;
  let environmentBeforeCurrentTask: RolloutEnvironment | undefined;
  let currentTaskEnvironment: RolloutEnvironment | undefined;

  const lines = createInterface({
    input: createReadStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (line.length === 0) continue;
    if (line.length > 8 * 1024 * 1024) {
      throw new Error("canonical Codex rollout record exceeds the bounded record size");
    }

    let item: Record<string, unknown> | undefined;
    try {
      item = record(JSON.parse(line.replace(/^\uFEFF/, "")));
    } catch {
      throw new Error("canonical Codex rollout contains invalid JSON");
    }
    if (!item) throw new Error("canonical Codex rollout record must be an object");
    const payload = record(item.payload);

    if (item.type === "session_meta") {
      continue;
    }

    if (item.type === "event_msg" && payload?.type === "task_started") {
      currentTurnId = identifier(payload.turn_id, "task_started turn_id");
      environmentBeforeCurrentTask = latestEnvironment;
      currentTaskEnvironment = undefined;
      continue;
    }

    if (item.type === "turn_context" && payload) {
      const observed = environment(payload);
      latestEnvironment = observed;
      if (currentTurnId !== undefined) {
        if (observed.sourceTurnId === currentTurnId) {
          currentTaskEnvironment = observed;
        } else {
          throw new Error("canonical Codex rollout turn_context conflicts with the current task");
        }
      }
    }
  }

  if (!currentTurnId) throw new Error("canonical Codex rollout has no current task boundary");

  const selected = currentTaskEnvironment ?? environmentBeforeCurrentTask;
  if (!selected) {
    throw new Error("canonical Codex rollout has no complete environment for the current task");
  }

  return Object.freeze({
    threadId: expectedThreadId,
    turnId: currentTurnId,
    cwd: selected.cwd,
    workspaceRoots: selected.workspaceRoots,
    sandbox: selected.sandbox,
    proof: currentTaskEnvironment ? "turn-context" : "current-task-inherited-context",
    environmentSourceTurnId: selected.sourceTurnId,
  });
}
