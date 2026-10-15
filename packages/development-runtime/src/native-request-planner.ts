import { createHash } from "node:crypto";
import {
  NativeHistoryBootstrapRequired,
  type NativeThreadGoalObservation,
} from "@chatgpt-tela/codex";
import {
  RevisionLineage,
  emitDiagnosticEvent,
  planPhysicalContext,
  type ContextCheckpoint,
  type LogicalRevision,
  type NativeInlineHistoryAsset,
  type NativeIngressTurnMedia,
  type NativeEvidenceReference,
  type RevisionKind,
} from "@chatgpt-tela/core";
import {
  CHATGPT_WEB_EFFORTS,
  chatGptWebPhysicalLimits,
  createChatGptContextAttachment,
  estimateChatGptContextAttachmentTransferTokens,
  parseChatGptWebModelId,
  shouldUseChatGptContextAttachment,
  prepareWebTurnMedia,
  webEvidenceFilename,
  type ChatGptWebEffort,
  type ChatGptWebPhysicalLimits,
  type WebPhysicalContext,
  type WebTurnMedia,
} from "@chatgpt-tela/chatgpt";
import {
  prepareWebContext,
  type ContextProjectionSource,
  type RegisteredTurn,
} from "@chatgpt-tela/runtime";
import type {
  CachedContextCheckpoint,
  ContextCheckpointCache,
} from "./context-cache";
import {
  nativeOpaqueCompaction,
  resolveNativeContextContinuity,
  type NativeContinuitySources,
} from "./native-context-continuity";
import { boundedWebCheckpointSource } from "./web-checkpoint-source";
import type {
  DevelopmentWebTurnPlan,
  DevelopmentWebTurnPlanner,
  DevelopmentWebTurnSettlement,
  RetiringDevelopmentWebTurnPlanner,
} from "./runtime";
import {
  fitFreshWebPhysicalContext,
  projectFreshWebPhysicalContext,
} from "./provider-projection";
import { assessWebEpochPressure, type WebEpochPressure } from "./web-epoch-pressure";
import { projectNativeUserContent, projectNativeToolEvidence, type NativeProjectedMedia } from "./native-evidence";

export interface ProjectedNativeRevision {
  readonly revision: LogicalRevision;
  readonly content: string;
  readonly evidence?: readonly NativeEvidenceReference[];
}

export interface NativeRequestContextProjection {
  readonly nativeTaskId: string;
  readonly revisions: readonly ProjectedNativeRevision[];
  readonly lineage: RevisionLineage;
  readonly headId: string;
  /** Source-bound Native state (continuity and current Goal) is exact, not disposable provider prose. */
  readonly protectedRevisionIds: readonly string[];
  /** Ephemeral exact-request bytes, never checkpoint authority or a persisted context cache. */
  readonly media: readonly WebTurnMedia[];
}

export interface NativeRequestCheckpointProductionRequest {
  readonly nativeTaskId: string;
  readonly sourceRevisionId: string;
  readonly physicalContext: WebPhysicalContext;
  readonly media?: readonly WebTurnMedia[];
  readonly browserModel?: { readonly familyKey: string; readonly effort: ChatGptWebEffort };
}

export interface NativeRequestCheckpointProductionResult {
  readonly nativeTaskId: string;
  readonly sourceRevisionId: string;
  readonly content: string;
}

export type NativeRequestCheckpointProducer = (
  request: NativeRequestCheckpointProductionRequest,
  preparation?: { readonly signal: AbortSignal; readonly onProgress: (summary: string) => void },
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

function webEpochId(nativeTaskId: string, transportAnchor: string, routeIdentity: string): string {
  const digest = createHash("sha256")
    .update("chatgpt-tela-web-epoch-v1")
    .update("\0")
    .update(nativeTaskId)
    .update("\0")
    .update(transportAnchor)
    .update("\0")
    .update(routeIdentity)
    .digest("base64url")
    .slice(0, 24);
  return `dev_epoch_${digest}`;
}

function routeIdentity(value: unknown): string {
  const body = record(value);
  const reasoning = record(body?.reasoning);
  const normalized = stableJson({
    model: typeof body?.model === "string" ? body.model : null,
    effort: typeof reasoning?.effort === "string" ? reasoning.effort : null,
  });
  return createHash("sha256")
    .update("chatgpt-tela-web-route-v1")
    .update("\0")
    .update(normalized)
    .digest("base64url")
    .slice(0, 20);
}

export function nativeRequestBrowserModelRoute(value: unknown): {
  readonly familyKey: string;
  readonly effort: ChatGptWebEffort;
} | undefined {
  const body = record(value);
  const model = typeof body?.model === "string" ? body.model : undefined;
  if (!model) return undefined;
  const parsed = parseChatGptWebModelId(model);
  if (!parsed) return undefined;
  const reasoning = record(body?.reasoning);
  const effort = typeof reasoning?.effort === "string" ? reasoning.effort : undefined;
  if (!effort || !(CHATGPT_WEB_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error("ChatGPT Web model requires one supported reasoning effort from the Native request");
  }
  return Object.freeze({ familyKey: parsed.familyKey, effort: effort as ChatGptWebEffort });
}

function contentFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

interface CommittedRetainedContext {
  readonly webEpochId: string;
  readonly surfaceLeaseId: string;
  readonly documentGeneration: number;
  readonly inputHeadRevisionId: string;
  readonly answerFingerprint: string;
  readonly routeIdentity: string;
  readonly baseLogicalInputTokens: number;
  readonly baseTransferInputTokens: number;
  readonly physicalLimits?: ChatGptWebPhysicalLimits;
}

/** No upload bytes survive planner settlement; retained exact physical messages need only suffix media. */
function includedMedia(
  projection: NativeRequestContextProjection,
  context: WebPhysicalContext,
  strictFullContext = false,
): readonly WebTurnMedia[] {
  const segments = new Map(context.segments.filter(s => s.type === "revision")
    .map(s => [s.revisionId, s]));
  const original = new Map(projection.revisions.map(item => [item.revision.id, item.content]));
  const media = projection.media.filter(item => {
    const segment = segments.get(item.revisionId);
    if (!segment || segment.type !== "revision") return false;
    const bound = segment.evidence?.some(ref => ref.id === item.evidence.id);
    if (bound && segment.content !== original.get(item.revisionId)) {
      throw new Error("Web physical context discarded verified Native evidence during fitting");
    }
    return bound === true;
  });
  if (strictFullContext && context.mode === "full" && media.length !== projection.media.length) {
    throw new Error("Web physical context discarded verified Native evidence during fitting");
  }
  prepareWebTurnMedia(context, media);
  return Object.freeze(media);
}

/** Physical revision ownership is typed; bytes and availability remain separate from text. */
export function bindNativePhysicalEvidence(
  projection: NativeRequestContextProjection,
  context: WebPhysicalContext,
): WebPhysicalContext {
  const byId = new Map(projection.revisions.map(item => [item.revision.id, item]));
  let extraBytes = 0;
  const segments = context.segments.map(segment => {
    if (segment.type !== "revision") return segment;
    const evidence = byId.get(segment.revisionId)?.evidence;
    if (!evidence?.length) return segment;
    extraBytes += Buffer.byteLength(JSON.stringify(evidence), "utf8");
    return Object.freeze({ ...segment, evidence });
  });
  if (!extraBytes) return context;
  return Object.freeze({
    ...context, segments: Object.freeze(segments),
    transferTokens: context.transferTokens + Math.ceil(extraBytes / 4),
  });
}

function physicalMediaCost(context: WebPhysicalContext, media: readonly WebTurnMedia[]): WebPhysicalContext {
  if (media.length === 0) return context;
  const bytes = [...new Map(media.map(item => [item.file.name, item.file.bytes.byteLength])).values()]
    .reduce((sum, count) => sum + count, 0);
  return Object.freeze({ ...context, transferTokens: context.transferTokens + Math.ceil(bytes / 4) });
}

function retainedDelta(
  projection: NativeRequestContextProjection,
  committed: CommittedRetainedContext,
  currentRouteIdentity: string,
  budgetTokens: number | undefined,
): WebPhysicalContext | undefined {
  if (committed.routeIdentity !== currentRouteIdentity) return undefined;
  const inputHeadIndex = projection.revisions.findIndex(item => (
    item.revision.id === committed.inputHeadRevisionId
  ));
  if (inputHeadIndex < 0) return undefined;

  // Match the answer to the immediately completed original Native request,
  // not to the last assistant message whose prose happens to repeat it.
  // Later completed turns may legitimately have identical final answers;
  // their entire canonical user/assistant suffix must reach the retained
  // page instead of disappearing behind a text-only fingerprint match.
  let assistantIndex = -1;
  for (let index = inputHeadIndex + 1; index < projection.revisions.length; index += 1) {
    const kind = projection.revisions[index]!.revision.kind;
    if (kind === "user" || kind === "steering") break;
    if (kind === "assistant") {
      // Ambiguous multi-message Native completion has no single proven
      // committed answer boundary. Rebuild from canonical history.
      if (assistantIndex >= 0) return undefined;
      assistantIndex = index;
    } else if (assistantIndex >= 0) {
      // A later tool event after a purported final answer is not proven to
      // exist on the retained physical Web page.
      return undefined;
    }
  }
  if (assistantIndex < 0) return undefined;
  const assistant = projection.revisions[assistantIndex]!;
  if (contentFingerprint(assistant.content) !== committed.answerFingerprint) return undefined;

  const delta = projection.revisions.slice(assistantIndex + 1);
  if (delta.length === 0) return undefined;
  const activeRequest = [...delta].reverse().find(item => (
    item.revision.kind === "user" || item.revision.kind === "steering"
  ));
  if (!activeRequest) return undefined;
  const transferTokens = delta.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  if (budgetTokens !== undefined && transferTokens > budgetTokens) return undefined;
  const logicalTokens = projection.revisions
    .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  return Object.freeze({
    headRevisionId: projection.headId,
    baseRevisionId: assistant.revision.id,
    activeRequestRevisionId: activeRequest.revision.id,
    mode: "retained-delta" as const,
    logicalTokens,
    transferTokens,
    segments: Object.freeze(delta.map(item => Object.freeze({
      type: "revision" as const,
      revisionId: item.revision.id,
      kind: item.revision.kind,
      content: item.content,
    }))),
  });
}

function messageKind(role: unknown): RevisionKind {
  if (role === "system" || role === "developer") return role;
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
  visibleCompactionHistory?: string,
  inlineHistoryAssets: readonly NativeInlineHistoryAsset[] = [],
  historyReferences?: readonly NativeEvidenceReference[],
  currentIngressMedia?: NativeIngressTurnMedia,
  currentNativeGoal?: NativeThreadGoalObservation,
  currentNativeGoalState?: "absent" | "unavailable",
): NativeRequestContextProjection {
  const body = record(value);
  if (!body) throw new Error("Native request planner requires an object request body");
  const taskId = nativeTaskId.trim();
  if (!taskId) throw new Error("Native request context requires a native task id");
  const projected: ProjectedNativeRevision[] = [];
  const projectedMedia: WebTurnMedia[] = [];
  let parentId: string | null = null;
  const protectedRevisionIds: string[] = [];

  const append = (kind: RevisionKind, content: string, media: readonly NativeProjectedMedia[] = []): void => {
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
      ...(media.length ? { evidence: Object.freeze(media.map(entry => entry.evidence)) } : {}),
    }));
    for (const entry of media) {
      if (entry.file) projectedMedia.push(Object.freeze({
        revisionId: id, evidence: entry.evidence, file: entry.file,
      }));
    }
    parentId = id;
  };

  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    append("system", body.instructions);
  }
  if (visibleCompactionHistory !== undefined) {
    if (!visibleCompactionHistory.trim()) throw new Error("Native visible compaction history is empty");
    const inlineById = new Map(inlineHistoryAssets.map(asset => [asset.evidence.id, asset]));
    const records = historyReferences ?? inlineHistoryAssets.map(asset => asset.evidence);
    for (const asset of inlineHistoryAssets) {
      const matching = records.find(ref => ref.id === asset.evidence.id
        && ref.sha256 === asset.evidence.sha256 && ref.bytes === asset.evidence.bytes);
      if (!matching) throw new Error("Native inline historical assets require matching structured history evidence");
    }
    // A derived assistant-side historical projection cannot become the latest user request.
    append("assistant", visibleCompactionHistory, records.map(evidence => {
      const asset = inlineById.get(evidence.id);
      return {
        evidence,
        ...(asset ? { file: {
          name: webEvidenceFilename(evidence.sha256 ?? "", asset.mimeType),
          mimeType: asset.mimeType, bytes: asset.bytes,
        } } : {}),
      };
    }));
    protectedRevisionIds.push(projected.at(-1)!.revision.id);
  } else if (inlineHistoryAssets.length > 0) {
    throw new Error("Native inline historical assets require a matching visible history projection");
  }

  if (currentNativeGoal && currentNativeGoalState) {
    throw new Error("Native goal observation is contradictory");
  }
  if (currentNativeGoal) {
    if (currentNativeGoal.threadId !== taskId) throw new Error("Native current goal belongs to a different thread");
    // Goal text is ordinary Native-owned task data, not a high-priority system
    // instruction or an independent scheduler. Versioned tool-result revision
    // participates in retained-delta / compaction and changes only with state.
    append("tool-result", stableJson({
      type: "native-thread-goal-observation",
      authority: "Native public thread/goal/get (read-only)",
      status: currentNativeGoal.status,
      objective: currentNativeGoal.objective,
      tokenBudget: currentNativeGoal.tokenBudget,
      tokensUsed: currentNativeGoal.tokensUsed,
      timeUsedSeconds: currentNativeGoal.timeUsedSeconds,
      updatedAt: currentNativeGoal.updatedAt,
    }));
    protectedRevisionIds.push(projected.at(-1)!.revision.id);
  } else if (currentNativeGoalState) {
    append("tool-result", stableJson({
      type: "native-thread-goal-observation",
      authority: "Native public thread/goal/get (read-only)",
      status: currentNativeGoalState,
      explanation: currentNativeGoalState === "absent"
        ? "Native reports no goal for this thread."
        : "Native Goal state is not exposed by this runtime; do not claim it is available.",
    }));
    protectedRevisionIds.push(projected.at(-1)!.revision.id);
  }

  if (typeof body.input === "string") {
    append("user", body.input);
  } else if (Array.isArray(body.input)) {
    // A completed, readable local Native compaction replaces the preceding
    // model-visible transcript. On the first Web use after a long Native-only
    // session, retaining those superseded turns can overflow Web context and
    // reintroduce tool results that Native itself no longer sees.
    // Check every marker before selecting the latest boundary: an invalid
    // older marker must not be silently bypassed by a later valid marker.
    let startAt = 0;
    for (const [index, raw] of body.input.entries()) {
      const marker = record(raw);
      if (marker?.type !== "context_compaction" || marker.encrypted_content !== undefined) continue;
      const summary = record(body.input[index + 1]);
      if (!summary || (summary.type !== undefined && summary.type !== "message")
        || summary.role !== "user"
        || !textFromContent(summary.content, "Native local compaction summary").trim()) {
        throw new Error("Native local compaction marker requires a following readable user summary");
      }
      // The verified summary remains on the original Native input path.
      // Current instructions, separate Native history and goal evidence
      // have already been appended and therefore remain intact.
      startAt = index + 1;
    }
    let awaitingCompactionSummary = false;
    for (let index = startAt; index < body.input.length; index++) {
      const raw = body.input[index];
      if (awaitingCompactionSummary) {
        const summary = record(raw);
        if (!summary || (summary.type !== undefined && summary.type !== "message") || summary.role !== "user"
          || !textFromContent(summary.content, `input[${index}].content`).trim()) {
          throw new Error("Native local compaction marker requires a following readable user summary");
        }
        awaitingCompactionSummary = false;
      }
      if (typeof raw === "string") {
        append("user", raw);
        continue;
      }
      const item = record(raw);
      if (!item) throw new Error(`unsupported Native request input at index ${index}`);
      const type = typeof item.type === "string" ? item.type : undefined;

      if (type === "message" || (type === undefined && typeof item.role === "string")) {
        const kind = messageKind(item.role);
        if (kind === "user") {
          const user = projectNativeUserContent(item.content, taskId, `input:${index}`);
          append(kind, user.text, user.media);
        } else {
          append(kind, textFromContent(item.content, `input[${index}].content`));
        }
        continue;
      }

      if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
        const tool = projectNativeToolEvidence(item, taskId, `input:${index}`);
        append("tool-call", stableJson(tool.item), tool.media);
        continue;
      }

      // Public Native Responses may carry a still-structured MCP result before it is
      // normalized into function_call_output. Preserve its original content parts.
      if (type === "function_call_output" || type === "mcp_tool_call_output"
        || type === "custom_tool_call_output" || type === "tool_search_output") {
        const tool = projectNativeToolEvidence(item, taskId, `input:${index}`);
        append("tool-result", stableJson(tool.item), tool.media);
        continue;
      }

      // Native local compaction may place a marker immediately before its canonical readable
      // summary message. The marker carries no model-visible content; the following message does.
      if (type === "context_compaction" && item.encrypted_content === undefined) {
        awaitingCompactionSummary = true;
        continue;
      }
      if (type === "compaction" || type === "compaction_summary" || type === "context_compaction") {
        if (visibleCompactionHistory !== undefined && type === "compaction"
          && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) continue;
        throw new Error("Native compaction content is opaque to the Tela Web provider; a readable Native summary is required");
      }

      // Native reasoning payloads can contain opaque/encrypted model state. They are intentionally
      // not copied into the Web prompt and are never treated as user-visible logical context.
      if (type === "reasoning" || type === "additional_tools") continue;

      throw new Error(`unsupported Native request input type at index ${index}: ${type ?? "unknown"}`);
    }
    if (awaitingCompactionSummary) {
      throw new Error("Native local compaction marker requires a following readable user summary");
    }
  } else if (body.input !== undefined) {
    throw new Error("Native request input must be a string or array");
  }

  // Native can prepare/replace original image input before constructing its
  // Responses body. Public turn/start ingress retained the exact bytes before
  // that transformation; the authenticated thread/read owner supplied the
  // matching current turn ID. Attach to the latest current user revision, not
  // a past instruction or historical user message.
  if (currentIngressMedia) {
    if (currentIngressMedia.threadId !== taskId) {
      throw new Error("Native ingress media belongs to a different thread");
    }
    if (currentIngressMedia.unavailable > 0) {
      throw new Error("Native current turn contains media unavailable for Web upload");
    }
    if (currentIngressMedia.assets.length) {
      let userIndex = -1;
      for (let index = projected.length - 1; index >= 0; index -= 1) {
        if (projected[index]!.revision.kind === "user") { userIndex = index; break; }
      }
      if (userIndex < 0) throw new Error("Native ingress media has no current user revision");
      const target = projected[userIndex]!;
      const originalMedia = target.evidence ?? [];
      const newMedia: NativeEvidenceReference[] = [];
      for (const asset of currentIngressMedia.assets) {
        if (asset.evidence.origin !== "current-user" || asset.evidence.source !== "native_request"
          || asset.evidence.kind !== "image"
          || asset.bytes.byteLength !== asset.evidence.bytes) {
          throw new Error("Native ingress media is not a verified current user image");
        }
        const name = webEvidenceFilename(asset.evidence.sha256 ?? "", asset.mimeType);
        if (projectedMedia.some(item => item.revisionId === target.revision.id && item.file.name === name)) continue;
        projectedMedia.push(Object.freeze({
          revisionId: target.revision.id, evidence: asset.evidence,
          file: Object.freeze({ name, mimeType: asset.mimeType, bytes: asset.bytes }),
        }));
        newMedia.push(asset.evidence);
      }
      if (newMedia.length) projected[userIndex] = Object.freeze({
        ...target, evidence: Object.freeze([...originalMedia, ...newMedia]),
      });
    }
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
    protectedRevisionIds: Object.freeze(protectedRevisionIds),
    media: Object.freeze(projectedMedia),
  });
}

function activeCheckpoint(
  projection: NativeRequestContextProjection,
  candidates: readonly CachedContextCheckpoint[],
  budgetTokens: number | undefined,
): CachedContextCheckpoint | undefined {
  const activeIds = new Set(projection.revisions.map(item => item.revision.id));
  const safeAnchor = checkpointAnchor(projection);
  const safeIndex = safeAnchor ? projection.revisions.indexOf(safeAnchor) : -1;
  let selected: { readonly cached: CachedContextCheckpoint; readonly transferTokens: number } | undefined;
  for (const cached of candidates) {
    if (!activeIds.has(cached.checkpoint.revisionId)) continue;
    if (projection.revisions.findIndex(item => item.revision.id === cached.checkpoint.revisionId) > safeIndex) continue;
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
  // Keep the latest user request and all subsequent tool rounds exact, including mid-turn plans.
  let latestUser = -1;
  for (let index = projection.revisions.length - 1; index >= 0; index -= 1) {
    if (projection.revisions[index]!.revision.kind === "user") { latestUser = index; break; }
  }
  const boundary = latestUser >= 0 ? latestUser : projection.revisions.length - 1;
  return boundary > 0 ? projection.revisions[boundary - 1] : undefined;
}

function checkpointSourceContext(
  projection: NativeRequestContextProjection,
  anchor: ProjectedNativeRevision,
): WebPhysicalContext {
  const anchorIndex = projection.revisions.findIndex(item => item.revision.id === anchor.revision.id);
  if (anchorIndex < 0) throw new Error("checkpoint anchor is not on the active Native path");
  const source = projection.revisions.slice(0, anchorIndex + 1);
  const logicalTokens = source.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  return bindNativePhysicalEvidence(projection, Object.freeze({
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
  }));
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
export function createNativeRequestDevelopmentWebTurnPlanner(options: NativeContinuitySources & {
  readonly checkpointCache?: ContextCheckpointCache;
  readonly budgetTokens?: number;
} = {}): RetiringDevelopmentWebTurnPlanner {
  const retainedByTask = new Map<string, CommittedRetainedContext>();
  // Derived Web summaries are tiny and disposable; only a proven surviving
  // physical Web epoch may skip repeat Native compaction-marker discovery.
  // Native current-turn evidence is still checked independently per request.
  const hotHistoryByTask = new Map<string, {
    readonly opaqueFingerprint: string;
    readonly visibleHistory: string;
  }>();
  const keepHotHistory = (threadId: string, history: {
    readonly opaqueFingerprint: string; readonly visibleHistory: string;
  }): void => {
    hotHistoryByTask.delete(threadId);
    if (hotHistoryByTask.size >= 64) {
      const oldest = hotHistoryByTask.keys().next().value;
      if (oldest) hotHistoryByTask.delete(oldest);
    }
    hotHistoryByTask.set(threadId, history);
  };
  const pendingByTask = new Map<string, symbol>();
  const planningByTask = new Set<string>();
  /** One transactional Web epoch commit/rollback for both retained and fresh plans. */
  const settleOwnedContext = (entry: {
    readonly threadId: string;
    readonly pending: symbol;
    readonly webEpochId: string;
    readonly inputHeadRevisionId: string;
    readonly routeIdentity: string;
    readonly baseLogicalInputTokens: number;
    readonly baseTransferInputTokens: number;
    readonly physicalLimits?: ChatGptWebPhysicalLimits;
    readonly hotHistory?: { readonly opaqueFingerprint: string; readonly visibleHistory: string };
  }) => (outcome: DevelopmentWebTurnSettlement): void => {
    if (pendingByTask.get(entry.threadId) !== entry.pending) return;
    pendingByTask.delete(entry.threadId);
    if (outcome.status !== "completed" || outcome.documentGeneration === undefined) {
      retainedByTask.delete(entry.threadId);
      hotHistoryByTask.delete(entry.threadId);
      return;
    }
    if (!outcome.surfaceLeaseId.trim()) {
      retainedByTask.delete(entry.threadId);
      hotHistoryByTask.delete(entry.threadId);
      throw new Error("completed Web context requires a physical surface owner");
    }
    retainedByTask.set(entry.threadId, Object.freeze({
      webEpochId: entry.webEpochId,
      surfaceLeaseId: outcome.surfaceLeaseId,
      documentGeneration: outcome.documentGeneration,
      inputHeadRevisionId: entry.inputHeadRevisionId,
      answerFingerprint: contentFingerprint(outcome.answer),
      routeIdentity: entry.routeIdentity,
      baseLogicalInputTokens: entry.baseLogicalInputTokens,
      baseTransferInputTokens: entry.baseTransferInputTokens,
      ...(entry.physicalLimits ? { physicalLimits: entry.physicalLimits } : {}),
    }));
    if (entry.hotHistory) keepHotHistory(entry.threadId, entry.hotHistory);
    else hotHistoryByTask.delete(entry.threadId);
  };
  const plan = async (turn: RegisteredTurn, nativeRequest: unknown, preparation?: Parameters<DevelopmentWebTurnPlanner>[2]): Promise<DevelopmentWebTurnPlan> => {
    const threadId = turn.channel.binding.authority.threadId;
    if (pendingByTask.has(threadId)) {
      throw new Error("native task already has an unsettled Web context plan");
    }
    const opaque = nativeOpaqueCompaction(nativeRequest);
    const opaqueFingerprint = opaque.fingerprint;
    const browserModel = nativeRequestBrowserModelRoute(nativeRequest);
    const physicalLimits = browserModel ? chatGptWebPhysicalLimits(browserModel.effort) : undefined;
    const budgetTokens = options.budgetTokens ?? (options.checkpointProducer ? physicalLimits?.rolloverTokenLimit : undefined);
    const currentRouteIdentity = routeIdentity(nativeRequest);
    const committed = retainedByTask.get(threadId);
    const ingress = turn.channel.binding.canonicalEvidence.ingressMedia;
    if (ingress && ingress.turnId !== turn.channel.binding.authority.turnId) {
      throw new Error("Native ingress media belongs to a different current turn");
    }
    // Prove a surviving Web page against the exact route, canonical input
    // ancestry, preceding assistant answer, and effective physical pressure.
    // The resolver can then reuse only that already-owned physical history.
    let retainedHistory: string | undefined;
    let provenRetainedProjection: NativeRequestContextProjection | undefined;
    const hot = hotHistoryByTask.get(threadId);
    if (opaqueFingerprint && hot?.opaqueFingerprint === opaqueFingerprint && committed
      && committed.routeIdentity === currentRouteIdentity) {
      const provisional = projectNativeRequestContext(threadId, nativeRequest,
        hot.visibleHistory, [], undefined, ingress,
        turn.channel.binding.canonicalEvidence.nativeGoal,
        turn.channel.binding.canonicalEvidence.nativeGoalState);
      const logical = provisional.revisions.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
      const pressure = committed.physicalLimits ? assessWebEpochPressure({
        baseLogicalInputTokens: committed.baseLogicalInputTokens,
        baseTransferInputTokens: committed.baseTransferInputTokens,
        rolloverTokenLimit: committed.physicalLimits.rolloverTokenLimit,
        contextWindowTokenLimit: committed.physicalLimits.contextWindowTokenLimit,
        currentLogicalInputTokens: logical,
      }) : undefined;
      if (pressure?.shouldRollover !== true
        && retainedDelta(provisional, committed, currentRouteIdentity, budgetTokens)) {
        retainedHistory = hot.visibleHistory;
        provenRetainedProjection = provisional;
      }
    }
    // The continuity resolver owns all cold-source and checkpoint decisions.
    // Native task authority and Web surface settlement stay in this planner.
    const continuity = await resolveNativeContextContinuity({
      threadId, currentTurnId: turn.channel.binding.authority.turnId,
      authority: turn.channel.binding.authority,
      opaque,
      ...(retainedHistory !== undefined ? { retainedHistory } : {}),
      ...(browserModel ? { effort: browserModel.effort, browserModel } : {}),
      options,
      ...(preparation ? { preparation } : {}),
    });
    const visibleHistory = continuity.visibleHistory;
    const inlineHistoryAssets = continuity.inlineHistoryAssets;
    const historyReferences = continuity.historyReferences;
    const historyCheckpointReused = continuity.checkpointReused;
    const historyCheckpointProduced = continuity.checkpointProduced;
    const historyManualHandoff = continuity.manualHandoff;
    const projection = continuity.mode === "retained" && provenRetainedProjection
      ? provenRetainedProjection
      : projectNativeRequestContext(threadId, nativeRequest,
        visibleHistory, inlineHistoryAssets, historyReferences, ingress,
        turn.channel.binding.canonicalEvidence.nativeGoal,
        turn.channel.binding.canonicalEvidence.nativeGoalState);
    // Only a dedicated producer can reduce a fresh canonical prefix. Reuse the calibrated Web
    // transport budget; Native context limits and canonical history remain untouched.
    const hotCandidate = opaqueFingerprint && visibleHistory
      && (historyCheckpointReused || historyCheckpointProduced || historyManualHandoff
        || continuity.mode === "automatic-handoff")
      ? Object.freeze({ opaqueFingerprint, visibleHistory }) : undefined;
    const currentLogicalInputTokens = projection.revisions
      .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
    const pressure: WebEpochPressure | undefined = committed?.physicalLimits
      ? assessWebEpochPressure({
          baseLogicalInputTokens: committed.baseLogicalInputTokens,
          baseTransferInputTokens: committed.baseTransferInputTokens,
          rolloverTokenLimit: committed.physicalLimits.rolloverTokenLimit,
          contextWindowTokenLimit: committed.physicalLimits.contextWindowTokenLimit,
          currentLogicalInputTokens,
        })
      : undefined;
    const retained = committed && pressure?.shouldRollover !== true
      ? retainedDelta(projection, committed, currentRouteIdentity, budgetTokens)
      : undefined;
    const pending = Symbol(threadId);
    if (retained && committed) {
      const bound = bindNativePhysicalEvidence(projection, retained);
      const media = includedMedia(projection, bound);
      const physicalContext = physicalMediaCost(bound, media);
      pendingByTask.set(threadId, pending);
      return Object.freeze({
        nativeTaskId: threadId,
        webEpochId: committed.webEpochId,
        retainedSurfaceLeaseId: committed.surfaceLeaseId,
        retainedDocumentGeneration: committed.documentGeneration,
        physicalContext,
        ...(media.length ? { media } : {}),
        ...(browserModel ? { browserModel } : {}),
        diagnostics: Object.freeze({
          provider_projection: false,
          retained_delta: true,
          history_checkpoint_reused: historyCheckpointReused,
          history_checkpoint_produced: historyCheckpointProduced,
          history_manual_handoff: historyManualHandoff,
          continuity_source: continuity.mode,
          ...(pressure ? {
            epoch_input_estimate: pressure.estimatedEpochInputTokens,
            epoch_rollover_limit: pressure.effectiveRolloverTokenLimit,
            physical_rollover: false,
          } : {}),
        }),
        settle: settleOwnedContext({
          threadId, pending, webEpochId: committed.webEpochId,
          inputHeadRevisionId: projection.headId, routeIdentity: currentRouteIdentity,
          baseLogicalInputTokens: committed.baseLogicalInputTokens,
          baseTransferInputTokens: committed.baseTransferInputTokens,
          ...(committed.physicalLimits ? { physicalLimits: committed.physicalLimits } : {}),
          ...(hotCandidate ? { hotHistory: hotCandidate } : {}),
        }),
      });
    }
    const contentById = new Map(projection.revisions.map(item => [item.revision.id, item.content]));
    const candidates = await cachedCheckpoints(options.checkpointCache, threadId);
    let selected = activeCheckpoint(projection, candidates, budgetTokens);
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
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
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
        const checkpointPhysicalContext = checkpointSourceContext(projection, anchor);
        const checkpointMedia = includedMedia(projection, checkpointPhysicalContext);
        const bounded = boundedWebCheckpointSource(
          checkpointPhysicalContext, checkpointMedia,
          browserModel?.effort ?? "medium",
        );
        // A checkpoint producer is a real Web model operation, not a free
        // recursive compressor with unlimited input. Prevent the old
        // "compress -> immediately overflow -> compress again" cycle.
        if (!bounded) {
          emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_rejected", {
            phase: "checkpoint_budget", reason_class: "source_exceeds_web_budget",
            source_estimate: checkpointPhysicalContext.transferTokens,
          });
          throw new NativeHistoryBootstrapRequired();
        }
        const produced = await options.checkpointProducer(Object.freeze({
          nativeTaskId: threadId,
          sourceRevisionId: anchor.revision.id,
          physicalContext: bounded,
          ...(browserModel ? { browserModel } : {}),
          ...(checkpointMedia.length ? { media: checkpointMedia } : {}),
        }), preparation);
        preparation?.signal.throwIfAborted();
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
          ...(budgetTokens !== undefined ? { budgetTokens } : {}),
          checkpoint: selected.checkpoint,
        });
      }
    }
    if (prepared.status !== "ready") {
      throw new Error(
        `Native request context requires a checkpoint to fit the ${prepared.budgetTokens}-token Web budget`,
      );
    }
    // A Native source-bound checkpoint/handoff (or exact bounded original
    // history) is atomic transport context. Provider-level assistant
    // presentation trimming must not sever its provenance or limitations.
    const providerProjection = physicalLimits
      ? fitFreshWebPhysicalContext(prepared.physicalContext, physicalLimits, projection.protectedRevisionIds)
      : projectFreshWebPhysicalContext(prepared.physicalContext, undefined, {
          protectedRevisionIds: projection.protectedRevisionIds,
        });
    const boundContext = bindNativePhysicalEvidence(projection, providerProjection.context);
    const media = includedMedia(projection, boundContext, true);
    const contextAttachment = browserModel && shouldUseChatGptContextAttachment(boundContext)
      ? createChatGptContextAttachment(boundContext)
      : undefined;
    const contextWithFileCost = contextAttachment
      ? Object.freeze({
          ...boundContext,
          transferTokens: Math.max(
            boundContext.transferTokens,
            estimateChatGptContextAttachmentTransferTokens(contextAttachment),
          ),
        })
      : boundContext;
    const physicalContext = physicalMediaCost(contextWithFileCost, media);
    const transportAnchor = prepared.plan.mode === "checkpoint-delta"
      ? `checkpoint:${prepared.plan.checkpointId}`
      : `full:${projection.headId}`;
    const epochId = webEpochId(threadId, transportAnchor, currentRouteIdentity);
    pendingByTask.set(threadId, pending);
    return Object.freeze({
      nativeTaskId: threadId,
      webEpochId: epochId,
      physicalContext,
      ...(media.length ? { media } : {}),
      ...(contextAttachment ? { contextAttachment } : {}),
      ...(browserModel ? { browserModel } : {}),
      ...(physicalLimits ? { physicalLimits } : {}),
      diagnostics: Object.freeze({
        provider_projection: true,
        visible_compaction_history: visibleHistory !== undefined,
        history_checkpoint_reused: historyCheckpointReused,
        history_checkpoint_produced: historyCheckpointProduced,
        history_manual_handoff: historyManualHandoff,
        continuity_source: continuity.mode,
        retained_delta: false,
        physical_rollover: pressure?.shouldRollover === true,
        ...(pressure ? {
          previous_epoch_input_estimate: pressure.estimatedEpochInputTokens,
          previous_epoch_rollover_limit: pressure.effectiveRolloverTokenLimit,
        } : {}),
        projection_original_bytes: providerProjection.stats.originalRevisionBytes,
        projection_projected_bytes: providerProjection.stats.projectedRevisionBytes,
        projection_truncated_assistant: providerProjection.stats.truncatedAssistantRevisions,
        projection_omitted_assistant: providerProjection.stats.omittedAssistantRevisions,
        projection_truncated_tool_results: providerProjection.stats.truncatedToolResults,
        projection_omitted_tool_results: providerProjection.stats.omittedToolResults,
        projection_retention_step: providerProjection.stats.retentionStep,
        projection_fit_target: providerProjection.stats.fitTarget,
        context_attachment: contextAttachment !== undefined,
        media_reference_count: media.length,
        media_file_count: new Set(media.map(item => item.file.name)).size,
        media_unique_bytes: [...new Map(media.map(item => [item.file.name, item.file.bytes.byteLength])).values()]
          .reduce((sum, count) => sum + count, 0),
        ...(contextAttachment ? {
          context_attachment_chars: contextAttachment.contextJson.length,
          context_attachment_bytes: Buffer.byteLength(contextAttachment.contextJson, "utf8"),
        } : {}),
      }),
      settle: settleOwnedContext({
        threadId, pending, webEpochId: epochId,
        inputHeadRevisionId: projection.headId, routeIdentity: currentRouteIdentity,
        baseLogicalInputTokens: currentLogicalInputTokens,
        baseTransferInputTokens: physicalContext.transferTokens,
        ...(physicalLimits ? { physicalLimits } : {}),
        ...(hotCandidate ? { hotHistory: hotCandidate } : {}),
      }),
    });
  };
  const planner: DevelopmentWebTurnPlanner = async (turn, request, preparation) => {
    const threadId = turn.channel.binding.authority.threadId;
    if (planningByTask.has(threadId)) throw new Error("native task already has an unsettled Web context plan");
    planningByTask.add(threadId);
    try {
      preparation?.signal.throwIfAborted();
      return await plan(turn, request, preparation);
    } finally {
      planningByTask.delete(threadId);
    }
  };
  return Object.assign(planner, {
    retireSurface(threadId: string, surfaceLeaseId: string) {
      if (retainedByTask.get(threadId)?.surfaceLeaseId === surfaceLeaseId) {
        retainedByTask.delete(threadId);
        hotHistoryByTask.delete(threadId);
      }
    },
  });
}
