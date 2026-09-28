import { createHash } from "node:crypto";
import {
  RevisionLineage,
  planPhysicalContext,
  type ContextCheckpoint,
  type LogicalRevision,
  type RevisionKind,
} from "@chatgpt-tela/core";
import type { WebPhysicalContext } from "@chatgpt-tela/chatgpt";
import {
  prepareWebContext,
  type ContextProjectionSource,
  type RegisteredTurn,
} from "@chatgpt-tela/runtime";
import type {
  CachedContextCheckpoint,
  ContextCheckpointCache,
} from "./context-cache";
import type {
  DevelopmentWebTurnPlan,
  DevelopmentWebTurnPlanner,
} from "./runtime";

export interface ProjectedNativeRevision {
  readonly revision: LogicalRevision;
  readonly content: string;
}

export interface NativeRequestContextProjection {
  readonly nativeTaskId: string;
  readonly revisions: readonly ProjectedNativeRevision[];
  readonly lineage: RevisionLineage;
  readonly headId: string;
}

export interface NativeRequestCheckpointProductionRequest {
  readonly nativeTaskId: string;
  readonly sourceRevisionId: string;
  readonly physicalContext: WebPhysicalContext;
}

export interface NativeRequestCheckpointProductionResult {
  readonly nativeTaskId: string;
  readonly sourceRevisionId: string;
  readonly content: string;
}

export type NativeRequestCheckpointProducer = (
  request: NativeRequestCheckpointProductionRequest,
) => Promise<NativeRequestCheckpointProductionResult> | NativeRequestCheckpointProductionResult;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)));
  });
}

function textFromContent(value: unknown, context: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    if (value === null || value === undefined) return "";
    throw new Error(`unsupported Native request content at ${context}`);
  }

  const parts: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    const part = record(raw);
    if (!part) throw new Error(`unsupported Native request content at ${context}[${index}]`);
    const type = typeof part.type === "string" ? part.type : undefined;
    if (type === "input_text" || type === "output_text" || type === "text") {
      if (typeof part.text !== "string") {
        throw new Error(`Native text content is missing text at ${context}[${index}]`);
      }
      parts.push(part.text);
      continue;
    }
    // Attachments need their own browser upload/identity proof. Silently stringifying them into the
    // prompt would change meaning and bypass that future boundary.
    if (type === "input_image" || type === "input_file" || type === "image" || type === "file") {
      throw new Error(`Native ${type} content is not supported by the development Web planner yet`);
    }
    throw new Error(`unsupported Native request content type at ${context}[${index}]: ${type ?? "unknown"}`);
  }
  return parts.join("\n");
}

function tokenEstimate(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function revisionId(
  nativeTaskId: string,
  parentId: string | null,
  kind: RevisionKind,
  content: string,
): string {
  const digest = createHash("sha256")
    .update("chatgpt-tela-native-context-v1")
    .update("\0")
    .update(nativeTaskId)
    .update("\0")
    .update(parentId ?? "<root>")
    .update("\0")
    .update(kind)
    .update("\0")
    .update(content)
    .digest("base64url")
    .slice(0, 20);
  return `native_${digest}`;
}

function webEpochId(nativeTaskId: string, transportAnchor: string): string {
  const digest = createHash("sha256")
    .update("chatgpt-tela-web-epoch-v1")
    .update("\0")
    .update(nativeTaskId)
    .update("\0")
    .update(transportAnchor)
    .digest("base64url")
    .slice(0, 24);
  return `dev_epoch_${digest}`;
}

function messageKind(role: unknown): RevisionKind {
  if (role === "system" || role === "developer") return "system";
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  throw new Error(`unsupported Native message role: ${String(role)}`);
}

/**
 * Deterministically project the complete current Native request into a logical active path.
 *
 * Revision ids depend on Native task id + semantic parent + kind + content, not on the current turn
 * id. Repeated canonical prefixes therefore keep the same ids across provider rounds, restart, and
 * later turns. Diverging canonical history creates a new branch automatically; no cache is consulted
 * and no DOM edit/steering inference participates in correctness.
 */
export function projectNativeRequestContext(
  nativeTaskId: string,
  value: unknown,
): NativeRequestContextProjection {
  const body = record(value);
  if (!body) throw new Error("Native request planner requires an object request body");
  const taskId = nativeTaskId.trim();
  if (!taskId) throw new Error("Native request context requires a native task id");
  const projected: ProjectedNativeRevision[] = [];
  let parentId: string | null = null;

  const append = (kind: RevisionKind, content: string): void => {
    if (!content) return;
    const id = revisionId(taskId, parentId, kind, content);
    projected.push(Object.freeze({
      revision: Object.freeze({
        id,
        parentId,
        kind,
        estimatedTokens: tokenEstimate(content),
        contentRef: `native-request:${id}`,
      }),
      content,
    }));
    parentId = id;
  };

  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    append("system", body.instructions);
  }

  if (typeof body.input === "string") {
    append("user", body.input);
  } else if (Array.isArray(body.input)) {
    for (const [index, raw] of body.input.entries()) {
      if (typeof raw === "string") {
        append("user", raw);
        continue;
      }
      const item = record(raw);
      if (!item) throw new Error(`unsupported Native request input at index ${index}`);
      const type = typeof item.type === "string" ? item.type : undefined;

      if (type === "message" || (type === undefined && typeof item.role === "string")) {
        append(
          messageKind(item.role),
          textFromContent(item.content, `input[${index}].content`),
        );
        continue;
      }

      if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
        append("tool-call", stableJson(item));
        continue;
      }

      if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
        append("tool-result", stableJson(item));
        continue;
      }

      // Native reasoning payloads can contain opaque/encrypted model state. They are intentionally
      // not copied into the Web prompt and are never treated as user-visible logical context.
      if (type === "reasoning" || type === "additional_tools") continue;

      throw new Error(`unsupported Native request input type at index ${index}: ${type ?? "unknown"}`);
    }
  } else if (body.input !== undefined) {
    throw new Error("Native request input must be a string or array");
  }

  if (projected.length === 0) {
    throw new Error("Native request contains no supported logical context for the Web turn");
  }
  const revisions = Object.freeze(projected);
  const lineage = new RevisionLineage(revisions.map(item => item.revision));
  return Object.freeze({
    nativeTaskId: taskId,
    revisions,
    lineage,
    headId: revisions.at(-1)!.revision.id,
  });
}

function activeCheckpoint(
  projection: NativeRequestContextProjection,
  candidates: readonly CachedContextCheckpoint[],
  budgetTokens: number | undefined,
): CachedContextCheckpoint | undefined {
  const activeIds = new Set(projection.revisions.map(item => item.revision.id));
  let selected: { readonly cached: CachedContextCheckpoint; readonly transferTokens: number } | undefined;
  for (const cached of candidates) {
    if (!activeIds.has(cached.checkpoint.revisionId)) continue;
    const plan = planPhysicalContext({
      lineage: projection.lineage,
      headId: projection.headId,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      checkpoint: cached.checkpoint,
    });
    if (plan.status !== "ready" || plan.mode !== "checkpoint-delta") continue;
    if (!selected || plan.transferTokens < selected.transferTokens) {
      selected = Object.freeze({ cached, transferTokens: plan.transferTokens });
    }
  }
  return selected?.cached;
}

async function cachedCheckpoints(
  cache: ContextCheckpointCache | undefined,
  nativeTaskId: string,
): Promise<readonly CachedContextCheckpoint[]> {
  if (!cache) return [];
  try {
    return await cache.list(nativeTaskId);
  } catch {
    // Checkpoints are replaceable derived projections. Losing cache availability may increase
    // transfer cost, but must never change which Native history is authoritative.
    return [];
  }
}

function checkpointAnchor(projection: NativeRequestContextProjection): ProjectedNativeRevision | undefined {
  // Keep the newest canonical revision byte-for-byte in the delta. A one-revision context therefore
  // has nothing older that a disposable checkpoint may safely replace.
  return projection.revisions.length >= 2
    ? projection.revisions[projection.revisions.length - 2]
    : undefined;
}

function checkpointSourceContext(
  projection: NativeRequestContextProjection,
  anchor: ProjectedNativeRevision,
): WebPhysicalContext {
  const anchorIndex = projection.revisions.findIndex(item => item.revision.id === anchor.revision.id);
  if (anchorIndex < 0) throw new Error("checkpoint anchor is not on the active Native path");
  const source = projection.revisions.slice(0, anchorIndex + 1);
  const logicalTokens = source.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  return Object.freeze({
    headRevisionId: anchor.revision.id,
    mode: "full" as const,
    logicalTokens,
    transferTokens: logicalTokens,
    segments: Object.freeze(source.map(item => Object.freeze({
      type: "revision" as const,
      revisionId: item.revision.id,
      kind: item.revision.kind,
      content: item.content,
    }))),
  });
}

function checkpointTokens(content: string): number {
  return tokenEstimate(content);
}

/**
 * Planner for the live text path with optional persistent derived checkpoints.
 *
 * Every invocation first rebuilds the full active logical path from the current Native request. A
 * checkpoint may only replace transport for a revision that is still on that path; stale branch state
 * is ignored. Deleting/corrupting the cache therefore cannot change logical history, only transfer cost.
 */
export function createNativeRequestDevelopmentWebTurnPlanner(options: {
  readonly checkpointCache?: ContextCheckpointCache;
  readonly budgetTokens?: number;
  readonly checkpointProducer?: NativeRequestCheckpointProducer;
} = {}): DevelopmentWebTurnPlanner {
  return async (turn: RegisteredTurn, nativeRequest: unknown): Promise<DevelopmentWebTurnPlan> => {
    const threadId = turn.channel.binding.authority.threadId;
    const projection = projectNativeRequestContext(threadId, nativeRequest);
    const contentById = new Map(projection.revisions.map(item => [item.revision.id, item.content]));
    const candidates = await cachedCheckpoints(options.checkpointCache, threadId);
    let selected = activeCheckpoint(projection, candidates, options.budgetTokens);
    let selectedContent = selected
      ? new Map([[selected.checkpoint.id, selected.content]])
      : new Map<string, string>();
    const sourceFor = (): ContextProjectionSource => ({
      async revisionContent(revision) {
        const content = contentById.get(revision.id);
        if (content === undefined) throw new Error(`missing Native request revision content: ${revision.id}`);
        return content;
      },
      async checkpointContent(checkpoint: ContextCheckpoint) {
        const content = selectedContent.get(checkpoint.id);
        if (content === undefined) throw new Error(`missing cached checkpoint projection: ${checkpoint.id}`);
        return content;
      },
    });
    let prepared = await prepareWebContext({
      lineage: projection.lineage,
      headId: projection.headId,
      source: sourceFor(),
      ...(options.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
      ...(selected ? { checkpoint: selected.checkpoint } : {}),
    });
    if (prepared.status === "checkpoint-required"
      && options.checkpointCache
      && options.checkpointProducer) {
      const anchor = checkpointAnchor(projection);
      if (!anchor) {
        throw new Error(
          `Native request context cannot preserve its newest revision within the ${prepared.budgetTokens}-token Web budget`,
        );
      }
      const existingAtAnchor = candidates.some(candidate => (
        candidate.checkpoint.revisionId === anchor.revision.id
      ));
      if (!existingAtAnchor) {
        const produced = await options.checkpointProducer(Object.freeze({
          nativeTaskId: threadId,
          sourceRevisionId: anchor.revision.id,
          physicalContext: checkpointSourceContext(projection, anchor),
        }));
        if (produced.nativeTaskId !== threadId
          || produced.sourceRevisionId !== anchor.revision.id) {
          throw new Error("checkpoint producer returned a projection for a different Native source");
        }
        const content = produced.content.trim();
        if (!content) throw new Error("checkpoint producer returned empty content");
        selected = await options.checkpointCache.put({
          nativeTaskId: threadId,
          revisionId: anchor.revision.id,
          content,
          estimatedTokens: checkpointTokens(content),
        });
        selectedContent = new Map([[selected.checkpoint.id, selected.content]]);
        prepared = await prepareWebContext({
          lineage: projection.lineage,
          headId: projection.headId,
          source: sourceFor(),
          ...(options.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
          checkpoint: selected.checkpoint,
        });
      }
    }
    if (prepared.status !== "ready") {
      throw new Error(
        `Native request context requires a checkpoint to fit the ${prepared.budgetTokens}-token Web budget`,
      );
    }
    const transportAnchor = prepared.plan.mode === "checkpoint-delta"
      ? `checkpoint:${prepared.plan.checkpointId}`
      : `full:${projection.headId}`;
    return Object.freeze({
      nativeTaskId: threadId,
      webEpochId: webEpochId(threadId, transportAnchor),
      physicalContext: prepared.physicalContext,
    });
  };
}
