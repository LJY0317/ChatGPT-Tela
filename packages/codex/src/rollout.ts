import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { NativeSandboxAuthority } from "@chatgpt-tela/core";

export type CanonicalCurrentTurnProof =
  | "turn-context"
  | "current-task-inherited-context"
  | "app-server-active-turn";

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
}

interface RolloutEnvironment {
  readonly sourceTurnId: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly sandbox: NativeSandboxAuthority;
}

interface SessionOwner {
  readonly threadId: string;
  readonly parentThreadId?: string;
  readonly agentName?: string;
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

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function networkAuthority(
  sandbox: Record<string, unknown>,
  profile: Record<string, unknown>,
): "enabled" | "restricted" {
  const profileNetwork = profile.network;
  if (profileNetwork !== undefined
    && profileNetwork !== "enabled"
    && profileNetwork !== "restricted") {
    throw new Error("canonical Codex rollout permission profile has invalid network authority");
  }
  const legacyNetwork = typeof sandbox.network_access === "boolean"
    ? (sandbox.network_access ? "enabled" as const : "restricted" as const)
    : undefined;
  if (profileNetwork !== undefined && legacyNetwork !== undefined && profileNetwork !== legacyNetwork) {
    throw new Error("canonical Codex rollout network policy is inconsistent");
  }
  const network = profileNetwork ?? legacyNetwork;
  if (!network) {
    throw new Error("canonical Codex rollout is missing network authority");
  }
  return network;
}

function validateRestrictedProfile(payload: Record<string, unknown>): Record<string, unknown> {
  const profile = record(payload.permission_profile);
  if (profile?.type !== "managed" || record(profile.file_system)?.type !== "restricted") {
    throw new Error("canonical Codex rollout permission profile is inconsistent");
  }
  const split = payload.file_system_sandbox_policy;
  if (split !== undefined && split !== null && record(split)?.kind !== "restricted") {
    throw new Error("canonical Codex rollout filesystem policy is inconsistent");
  }
  return profile;
}

function sandboxAuthority(
  cwd: string,
  roots: readonly string[],
  payload: Record<string, unknown>,
): NativeSandboxAuthority {
  const sandbox = record(payload.sandbox_policy);
  const profile = record(payload.permission_profile);
  if (!sandbox || !profile) {
    throw new Error("canonical Codex rollout is missing sandbox authority");
  }

  if (sandbox.type === "danger-full-access" && profile.type === "disabled") {
    const split = payload.file_system_sandbox_policy;
    if (split !== undefined && split !== null && record(split)?.kind !== "unrestricted") {
      throw new Error("canonical Codex rollout full-access policies are inconsistent");
    }
    return Object.freeze({ kind: "danger-full-access" as const });
  }

  if (sandbox.type === "read-only") {
    const managed = validateRestrictedProfile(payload);
    return Object.freeze({
      kind: "read-only" as const,
      network: networkAuthority(sandbox, managed),
    });
  }

  if (sandbox.type === "workspace-write") {
    const managed = validateRestrictedProfile(payload);
    const declaredWritableRoots = sandbox.writable_roots === undefined
      ? []
      : absolutePaths(sandbox.writable_roots, "sandbox writable_roots");
    const writableRoots = Object.freeze([...new Set([cwd, ...declaredWritableRoots])]);
    if (writableRoots.some(path => !roots.some(root => contains(root, path)))) {
      throw new Error("canonical Codex rollout writable root is outside workspace_roots");
    }
    return Object.freeze({
      kind: "workspace-write" as const,
      writableRoots,
      network: networkAuthority(sandbox, managed),
    });
  }

  throw new Error("canonical Codex rollout sandbox policy is unsupported");
}

function environment(payload: Record<string, unknown>): RolloutEnvironment {
  const sourceTurnId = identifier(payload.turn_id, "turn_context turn_id");
  const cwd = absolutePath(payload.cwd, "cwd");
  const workspaceRoots = payload.workspace_roots === undefined
    ? Object.freeze([cwd])
    : absolutePaths(payload.workspace_roots, "workspace_roots");
  if (workspaceRoots.length === 0 || !workspaceRoots.some(root => contains(root, cwd))) {
    throw new Error("canonical Codex rollout cwd is outside workspace_roots");
  }
  return Object.freeze({
    sourceTurnId,
    cwd,
    workspaceRoots,
    sandbox: sandboxAuthority(cwd, workspaceRoots, payload),
  });
}

function sessionOwner(payload: Record<string, unknown>, expectedThreadId: string): SessionOwner {
  if (payload.id !== expectedThreadId) {
    throw new Error("canonical Codex rollout session does not match the requested thread");
  }
  const parentThreadId = optionalString(payload.parent_thread_id);
  const agentName = optionalString(payload.agent_path);
  return Object.freeze({
    threadId: expectedThreadId,
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(agentName ? { agentName } : {}),
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
  let owner: SessionOwner | undefined;
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
      if (!payload) throw new Error("canonical Codex rollout has invalid session metadata");
      const observed = sessionOwner(payload, expectedThreadId);
      if (owner) throw new Error("canonical Codex rollout repeats session metadata");
      owner = observed;
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

  if (!owner) throw new Error("canonical Codex rollout is missing authenticated session metadata");
  if (!currentTurnId) throw new Error("canonical Codex rollout has no current task boundary");

  const selected = currentTaskEnvironment ?? environmentBeforeCurrentTask;
  if (!selected) {
    throw new Error("canonical Codex rollout has no complete environment for the current task");
  }

  return Object.freeze({
    threadId: owner.threadId,
    turnId: currentTurnId,
    ...(owner.parentThreadId ? { parentThreadId: owner.parentThreadId } : {}),
    ...(owner.agentName ? { agentName: owner.agentName } : {}),
    cwd: selected.cwd,
    workspaceRoots: selected.workspaceRoots,
    sandbox: selected.sandbox,
    proof: currentTaskEnvironment ? "turn-context" : "current-task-inherited-context",
    environmentSourceTurnId: selected.sourceTurnId,
  });
}
