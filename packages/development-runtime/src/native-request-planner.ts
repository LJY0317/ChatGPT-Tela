import { classifyWebPreparationFailure } from "./web-preparation-diagnostics";
import { decodeTelaCompactionSummary, telaCompactionSummaryText } from "@chatgpt-tela/codex";
import { CheckpointPreparationBudget, CheckpointPreparationBudgetExceeded } from "./checkpoint-preparation-budget";
import { createHash } from "node:crypto";
import {
  NativeHistoryBootstrapRequired,
  type NativeThreadGoalObservation,
} from "@chatgpt-tela/codex";
import {
  RevisionLineage,
  NativeProjectionUnsupported,
  WebContextFitFailed,
  emitDiagnosticEvent,
  diagnosticFingerprint,
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
  chatGptWebCheckpointSourceTokenLimit,
  parseChatGptWebModelId,
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
import { produceNativePrefixCheckpoint } from "./native-visible-prefix-checkpoint";
import {
  nativeRequestPrefixSnapshot, selectNativeWorkingCheckpoint,
  workingCheckpointAnchor, withExactCurrentInstructions, nativeWorkingCheckpointScope,
} from "./native-working-context";
import { webWorkingContextPolicy } from "./web-working-context-policy";
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
  /** Verified Native Goal state, allowing its developer-only continuation suffix. */
  readonly currentGoalStatus?: string;
  /** Ephemeral exact-request bytes, never checkpoint authority or a persisted context cache. */
  readonly media: readonly WebTurnMedia[];
}

export interface NativeRequestCheckpointProductionRequest {
  readonly nativeTaskId: string;
  readonly sourceRevisionId: string;
  readonly physicalContext: WebPhysicalContext;
  /** Local durable settlement only; never serialized into model input. */
  readonly persistResult?: (result: NativeRequestCheckpointProductionResult) => Promise<void>;
  readonly media?: readonly WebTurnMedia[];
  readonly browserModel?: { readonly familyKey: string; readonly effort: ChatGptWebEffort };
}

export { nativeRequestPrefixSnapshot } from "./native-working-context";

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
  /** Monotonic input+estimated output of the exact owned physical generation. */
  readonly estimatedResidentTokens: number;
  readonly oversizedFreshSeed: boolean;
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
  onMiss?: (reason: string) => void,
): WebPhysicalContext | undefined {
  const miss = (reason: string): undefined => { onMiss?.(reason); return undefined; };
  if (committed.routeIdentity !== currentRouteIdentity) return miss("route_changed");
  const inputHeadIndex = projection.revisions.findIndex(item => (
    item.revision.id === committed.inputHeadRevisionId
  ));
  if (inputHeadIndex < 0) return miss("input_head_missing");

  // Match the answer to the immediately completed original Native request,
  // not to the last assistant message whose prose happens to repeat it.
  // Later completed turns may legitimately have identical final answers;
  // their entire canonical user/assistant suffix must reach the retained
  // page instead of disappearing behind a text-only fingerprint match.
  let assistantIndex = -1;
  for (let index = inputHeadIndex + 1; index < projection.revisions.length; index += 1) {
    const kind = projection.revisions[index]!.revision.kind;
    if (kind === "user" || kind === "steering"
      || (kind === "developer" && assistantIndex >= 0 && projection.currentGoalStatus === "active")) break;
    if (kind === "assistant") {
      // Attributed agent data and source-bound summaries cannot witness our final,
      // even if their serialized text happens to equal its answer fingerprint.
      if (projection.protectedRevisionIds.includes(projection.revisions[index]!.revision.id)) return miss("protected_answer_boundary");
      // Ambiguous multi-message Native completion has no single proven
      // committed answer boundary. Rebuild from canonical history.
      if (assistantIndex >= 0) return miss("ambiguous_answer_boundary");
      assistantIndex = index;
    } else if (assistantIndex >= 0) {
      // A later tool event after a purported final answer is not proven to
      // exist on the retained physical Web page.
      return miss("events_after_answer");
    }
  }
  if (assistantIndex < 0) return miss("answer_boundary_missing");
  const assistant = projection.revisions[assistantIndex]!;
  if (contentFingerprint(assistant.content) !== committed.answerFingerprint) return miss("answer_changed");

  const delta = projection.revisions.slice(assistantIndex + 1);
  if (delta.length === 0) return miss("empty_suffix");
  const activeRequest = [...delta].reverse().find(item => (
    item.revision.kind === "user" || item.revision.kind === "steering"
      || (item.revision.kind === "developer" && projection.currentGoalStatus === "active")
  ));
  if (!activeRequest) return miss("active_request_missing");
  const transferTokens = delta.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  if (budgetTokens !== undefined && transferTokens > budgetTokens) return miss("suffix_budget");
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

function admittedRetainedContext(
  projection: NativeRequestContextProjection,
  committed: CommittedRetainedContext,
  route: string,
  budgetTokens: number | undefined,
  outputReserveTokens: number,
  diagnostic?: { reason?: string },
): { readonly physicalContext: WebPhysicalContext; readonly media: readonly WebTurnMedia[];
  readonly pressure?: WebEpochPressure } | undefined {
  const delta = retainedDelta(projection, committed, route, budgetTokens,
    reason => { if (diagnostic) diagnostic.reason = reason; });
  if (!delta) return undefined;
  const bound = bindNativePhysicalEvidence(projection, delta);
  const media = includedMedia(projection, bound);
  const physicalContext = physicalMediaCost(bound, media);
  // The estimated task wrapper is not Native tokens and is not a provider-reported bill.
  const pressure = committed.physicalLimits ? assessWebEpochPressure({
    settledEpochTokens: committed.estimatedResidentTokens,
    nextInputTokens: physicalContext.transferTokens + 1_024,
    outputReserveTokens,
    rolloverTokenLimit: committed.physicalLimits.rolloverTokenLimit,
    contextWindowTokenLimit: committed.physicalLimits.contextWindowTokenLimit,
    oversizedFreshSeed: committed.oversizedFreshSeed,
  }) : undefined;
  return Object.freeze({ physicalContext, media, ...(pressure ? { pressure } : {}) });
}

function messageKind(role: unknown): RevisionKind {
  if (role === "system" || role === "developer") return role;
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  throw new Error(`unsupported Native message role: ${String(role)}`);
}

/** Request-owned author source shared by projection and compaction identity. Transport is separate. */
export function nativeRequestContentSource(value: unknown): { readonly instructions: unknown; readonly input: unknown } {
  const body = record(value);
  if (!body) throw new Error("Native request planner requires an object request body");
  return { instructions: body.instructions, input: body.input };
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
  const body = nativeRequestContentSource(value);
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
    // participates in retained-delta / compaction and changes only with operative
    // state. Accounting counters stay Native-owned: changing them on every turn
    // must not rewrite every following revision and invalidate the retained page.
    append("tool-result", stableJson({
      type: "native-thread-goal-observation",
      authority: "Native public thread/goal/get (read-only)",
      status: currentNativeGoal.status,
      objective: currentNativeGoal.objective,
      tokenBudget: currentNativeGoal.tokenBudget,
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

      if (type === "agent_message") {
        // Native inter-agent communication is attributed task data, never a user request,
        // high-priority instruction, or evidence of a completed Web answer. Do not copy
        // Native metadata or opaque/encrypted agent state into the Web transcript.
        if (typeof item.author !== "string" || !item.author.trim()
          || typeof item.recipient !== "string" || !item.recipient.trim()
          || !Array.isArray(item.content)) throw new NativeProjectionUnsupported();
        const content = item.content.map(raw => {
          const part = record(raw);
          if (part?.type !== "input_text" || typeof part.text !== "string") {
            throw new NativeProjectionUnsupported();
          }
          return { type: "input_text", text: part.text };
        });
        append("assistant", stableJson({ type, author: item.author, recipient: item.recipient, content }));
        protectedRevisionIds.push(projected.at(-1)!.revision.id);
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
        const summary = decodeTelaCompactionSummary(item.encrypted_content);
        if (summary !== undefined) {
          append("assistant", telaCompactionSummaryText(summary));
          continue;
        }
        if (visibleCompactionHistory !== undefined && type === "compaction"
          && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) continue;
        throw new Error("Native compaction content is opaque to the Tela Web provider; a readable Native summary is required");
      }

      // Native reasoning payloads can contain opaque/encrypted model state. They are intentionally
      // not copied into the Web prompt and are never treated as user-visible logical context.
      if (type === "reasoning" || type === "additional_tools") continue;

      throw new NativeProjectionUnsupported();
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
    ...(currentNativeGoal ? { currentGoalStatus: currentNativeGoal.status } : {}),
    media: Object.freeze(projectedMedia),
  });
}

function activeCheckpoint(
  projection: NativeRequestContextProjection,
  candidates: readonly CachedContextCheckpoint[],
  budgetTokens: number | undefined,
): CachedContextCheckpoint | undefined {
  const activeIds = new Set(projection.revisions.map(item => item.revision.id));
  const safeAnchor = workingCheckpointAnchor(projection);
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

function checkpointSourceContext(
  projection: NativeRequestContextProjection,
  anchor: ProjectedNativeRevision,
  previous?: CachedContextCheckpoint,
): WebPhysicalContext {
  const anchorIndex = projection.revisions.findIndex(item => item.revision.id === anchor.revision.id);
  if (anchorIndex < 0) throw new Error("checkpoint anchor is not on the active Native path");
  const previousIndex = previous ? projection.revisions.findIndex(item =>
    item.revision.id === previous.checkpoint.revisionId) : -1;
  if (previous && (previousIndex < 0 || previousIndex >= anchorIndex)) {
    throw new Error("Working checkpoint is not an ancestor of the new anchor");
  }
  const source = projection.revisions.slice(previousIndex + 1, anchorIndex + 1);
  const logicalTokens = projection.revisions.slice(0, anchorIndex + 1)
    .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  return bindNativePhysicalEvidence(projection, Object.freeze({
    headRevisionId: anchor.revision.id,
    mode: "full" as const,
    logicalTokens,
    transferTokens: source.reduce((sum, item) => sum + item.revision.estimatedTokens, 0)
      + (previous?.checkpoint.estimatedTokens ?? 0),
    segments: Object.freeze([...(previous ? [{ type: "checkpoint" as const,
      checkpointId: previous.checkpoint.id, sourceRevisionId: previous.checkpoint.revisionId,
      content: previous.content }] : []), ...source.map(item => Object.freeze({
      type: "revision" as const,
      revisionId: item.revision.id,
      kind: item.revision.kind,
      content: item.content,
    }))]),
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
  // A failed settlement and a retired physical surface must invalidate exactly
  // the same retained context; an unowned epoch cannot justify a token-saving delta.
  const clearRetainedContext = (threadId: string): void => {
    retainedByTask.delete(threadId);
    hotHistoryByTask.delete(threadId);
  };
  /** One transactional Web epoch commit/rollback for both retained and fresh plans. */
  const settleOwnedContext = (entry: {
    readonly threadId: string;
    readonly pending: symbol;
    readonly webEpochId: string;
    readonly inputHeadRevisionId: string;
    readonly routeIdentity: string;
    readonly previousResidentTokens: number;
    readonly inputTokens: number;
    readonly outputReserveTokens: number;
    readonly oversizedFreshSeed: boolean;
    readonly physicalLimits?: ChatGptWebPhysicalLimits;
    readonly hotHistory?: { readonly opaqueFingerprint: string; readonly visibleHistory: string };
  }) => (outcome: DevelopmentWebTurnSettlement): void => {
    if (pendingByTask.get(entry.threadId) !== entry.pending) return;
    pendingByTask.delete(entry.threadId);
    // A deterministic composer refusal before browser acquisition cannot have
    // changed the previously committed page. Keep its exact owner and anchor.
    if (outcome.status === "preflight-rejected") return;
    if (outcome.status !== "completed" || outcome.documentGeneration === undefined) {
      clearRetainedContext(entry.threadId);
      return;
    }
    if (!outcome.surfaceLeaseId.trim()) {
      clearRetainedContext(entry.threadId);
      throw new Error("completed Web context requires a physical surface owner");
    }
    const outputTokens = tokenEstimate(outcome.answer);
    const toolBytes = outcome.releasedToolResultBytes ?? 0;
    const rounds = outcome.toolRoundCount ?? 0;
    if (!Number.isSafeInteger(toolBytes) || toolBytes < 0
      || !Number.isSafeInteger(rounds) || rounds < 0) {
      clearRetainedContext(entry.threadId);
      return;
    }
    // Count only outputs actually released to this Web turn, and reserve some
    // Count observed serialized data only. Reserve future output in admission, not settlement.
    // Neither Native compaction nor a checkpoint
    // can subtract bytes already resident in the provider's conversation.
    const estimatedResidentTokens = entry.previousResidentTokens + entry.inputTokens
      + outputTokens + Math.ceil(toolBytes / 4);
    if (!Number.isSafeInteger(estimatedResidentTokens)) {
      clearRetainedContext(entry.threadId);
      return;
    }
    retainedByTask.set(entry.threadId, Object.freeze({
      webEpochId: entry.webEpochId,
      surfaceLeaseId: outcome.surfaceLeaseId,
      documentGeneration: outcome.documentGeneration,
      inputHeadRevisionId: entry.inputHeadRevisionId,
      answerFingerprint: contentFingerprint(outcome.answer),
      routeIdentity: entry.routeIdentity,
      estimatedResidentTokens,
      oversizedFreshSeed: entry.oversizedFreshSeed,
      ...(entry.physicalLimits ? { physicalLimits: entry.physicalLimits } : {}),
    }));
    if (entry.hotHistory) keepHotHistory(entry.threadId, entry.hotHistory);
    else hotHistoryByTask.delete(entry.threadId);
    emitDiagnosticEvent("chatgpt_tela_work", "web_context_settled", {
      status: "completed", epoch_fingerprint: diagnosticFingerprint(entry.webEpochId),
      surface_fingerprint: diagnosticFingerprint(outcome.surfaceLeaseId), document_generation: outcome.documentGeneration,
      head_revision_fingerprint: diagnosticFingerprint(entry.inputHeadRevisionId),
      resident_usage_estimate: estimatedResidentTokens, resident_usage_confidence: "conservative-estimate",
      tool_result_bytes: toolBytes, tool_round_count: rounds,
    });
  };
  const plan = async (turn: RegisteredTurn, nativeRequest: unknown, preparation?: Parameters<DevelopmentWebTurnPlanner>[2]): Promise<DevelopmentWebTurnPlan> => {
    // Failure-only stage observations are local to this request, not attached to errors.
    // Observer errors must not replace the original planner exception.
    let lastStage = "request_parse";
    let fitProjection: NativeRequestContextProjection | undefined;
    let fitBudget: number | undefined;
    let fitCheckpoint = false;
    const stage = (value: Parameters<NonNullable<NonNullable<Parameters<DevelopmentWebTurnPlanner>[2]>["onPlannerStage"]>>[0]): void => {
      lastStage = value;
      try { preparation?.onPlannerStage?.(value); } catch { /* Diagnostics are best effort. */ }
    };
    try {
    stage("request_parse");
    const threadId = turn.channel.binding.authority.threadId;
    if (pendingByTask.has(threadId)) {
      throw new Error("native task already has an unsettled Web context plan");
    }
    const opaque = nativeOpaqueCompaction(nativeRequest);
    const opaqueFingerprint = opaque.fingerprint;
    stage("model_route");
    const browserModel = nativeRequestBrowserModelRoute(nativeRequest);
    const workingPolicy = webWorkingContextPolicy(browserModel?.effort ?? "medium", options.checkpointPreparationPolicy);
    const preparationBudget = new CheckpointPreparationBudget(
      workingPolicy.checkpointSourceTokens, options.checkpointPreparationPolicy);
    const checkpointProducer = options.checkpointProducer ? preparationBudget.producer(options.checkpointProducer) : undefined;
    const physicalLimits = browserModel ? workingPolicy.hard : undefined;
    const budgetTokens = options.budgetTokens ?? (checkpointProducer ? physicalLimits?.rolloverTokenLimit : undefined);
    const currentRouteIdentity = routeIdentity(nativeRequest);
    const committed = retainedByTask.get(threadId);
    stage("retained_context");
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
      const trial = admittedRetainedContext(provisional, committed, currentRouteIdentity,
        budgetTokens, workingPolicy.outputReserveTokens);
      if (trial && (!committed.physicalLimits || (trial.pressure && !trial.pressure.shouldRollover))) {
        retainedHistory = hot.visibleHistory;
        provenRetainedProjection = provisional;
      }
    }
    emitDiagnosticEvent("chatgpt_tela_work", "web_retained_context_hot_probe", {
      prior_settlement_present: committed !== undefined, cached_history_present: hot !== undefined,
      opaque_matches: !!opaqueFingerprint && hot?.opaqueFingerprint === opaqueFingerprint,
      route_matches: committed?.routeIdentity === currentRouteIdentity,
      reuse_eligible: provenRetainedProjection !== undefined,
    });
    // The continuity resolver owns all cold-source and checkpoint decisions.
    // Native task authority and Web surface settlement stay in this planner.
    stage("native_continuity");
    const continuity = await resolveNativeContextContinuity({
      threadId, currentTurnId: turn.channel.binding.authority.turnId,
      authority: turn.channel.binding.authority,
      opaque,
      ...(retainedHistory !== undefined ? { retainedHistory } : {}),
      ...(browserModel ? { effort: browserModel.effort, browserModel } : {}),
      options: { ...options, ...(checkpointProducer ? { checkpointProducer } : {}) },
      preparationBudget,
      ...(preparation ? { preparation } : {}),
    });
    const visibleHistory = continuity.visibleHistory;
    const inlineHistoryAssets = continuity.inlineHistoryAssets;
    const historyReferences = continuity.historyReferences;
    const historyCheckpointReused = continuity.checkpointReused;
    const historyCheckpointProduced = continuity.checkpointProduced;
    const historyManualHandoff = continuity.manualHandoff;
    stage("logical_projection");
    const projection = continuity.mode === "retained" && provenRetainedProjection
      ? provenRetainedProjection
      : projectNativeRequestContext(threadId, nativeRequest,
        visibleHistory, inlineHistoryAssets, historyReferences, ingress,
        turn.channel.binding.canonicalEvidence.nativeGoal,
        turn.channel.binding.canonicalEvidence.nativeGoalState);
    // Only a dedicated producer can reduce a fresh canonical prefix. Reuse the calibrated Web
    // transport budget; Native context limits and canonical history remain untouched.
    const hotCandidate = opaqueFingerprint && visibleHistory
      && (historyCheckpointReused || historyCheckpointProduced || historyManualHandoff)
      ? Object.freeze({ opaqueFingerprint, visibleHistory }) : undefined;
    const currentAnchor = workingCheckpointAnchor(projection);
    const currentAnchorIndex = currentAnchor ? projection.revisions.indexOf(currentAnchor) : -1;
    const exactActiveTokens = projection.revisions.slice(currentAnchorIndex + 1)
      .reduce((sum, item) => sum + item.revision.estimatedTokens, 0)
      + projection.revisions.filter(item =>
        item.revision.kind === "system" || item.revision.kind === "developer")
        .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
    if (physicalLimits && exactActiveTokens + 2_048 >= physicalLimits.contextWindowTokenLimit) {
      // Required active work is irreducible. Do not burn model calls trying
      // to compress old context to fit a request that cannot fit by itself.
      emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_rejected", {
        phase: "active_work_fit", reason_class: "irreducible_current_work",
        exact_active_estimate: exactActiveTokens,
        calibrated_hard_limit: physicalLimits.contextWindowTokenLimit,
      });
      throw new NativeHistoryBootstrapRequired("source_budget");
    }
    // Soft rollover is for session runway, not a hard prohibition on a single
    // irreducible current request that can still pass the calibrated hard limit.
    const freshBudgetTokens = options.budgetTokens === undefined && physicalLimits
      && exactActiveTokens + 2_048 >= physicalLimits.rolloverTokenLimit
      ? physicalLimits.contextWindowTokenLimit : budgetTokens;
    const retentionDiagnostic: { reason?: string } = {};
    const admitted = committed ? admittedRetainedContext(projection, committed,
      currentRouteIdentity, budgetTokens, workingPolicy.outputReserveTokens, retentionDiagnostic) : undefined;
    const pressure = admitted?.pressure;
    const healthyRetained = !!(admitted && committed
      && (!committed.physicalLimits || pressure && !pressure.shouldRollover));
    emitDiagnosticEvent("chatgpt_tela_work", "web_retained_context_decision", {
      reason_class: !committed ? "no_committed_context" : !admitted ? retentionDiagnostic.reason ?? "unclassified"
        : pressure?.shouldRollover ? "physical_pressure" : healthyRetained ? "retained_match" : "pressure_unavailable",
      prior_settlement_present: committed !== undefined, reuse_eligible: healthyRetained,
      ...(pressure ? { epoch_input_estimate: pressure.estimatedEpochInputTokens,
        epoch_rollover_limit: pressure.effectiveRolloverTokenLimit, physical_rollover: pressure.shouldRollover } : {}),
    });
    // Maintenance is optional while the exact physical page is healthy.
    // A budget refusal BEFORE the first maintenance stage claim may defer
    // preparation; pending/uncertain sends and source/owner errors never may.
    stage("checkpoint_lookup");
    let working;
    try {
      working = await selectNativeWorkingCheckpoint({
        projection, currentTurnId: turn.channel.binding.authority.turnId,
        ...(options.checkpointCache ? { cache: options.checkpointCache } : {}),
        ...(options.visiblePrefix ? { visiblePrefix: options.visiblePrefix } : {}),
        ...(checkpointProducer ? { producer: checkpointProducer } : {}),
        ...(browserModel ? { browserModel } : {}),
        policy: workingPolicy, preparationBudget,
        ...(preparation ? { preparation, signal: preparation.signal } : {}),
      });
    } catch (error) {
      if (!healthyRetained || !(error instanceof CheckpointPreparationBudgetExceeded)
        || preparationBudget.modelCalls !== 0) throw error;
      emitDiagnosticEvent("chatgpt_tela_codex", "native_working_checkpoint_deferred", {
        reason_class: "preparation_budget", retained_page_proven: true,
      });
      working = { produced: false, reused: false, pendingSuffixTokens: 0 };
    }
    const pending = Symbol(threadId);
    if (healthyRetained && admitted && committed) {
      stage("media_binding");
      const { physicalContext, media } = admitted;
      stage("settlement");
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
          retained_input_head_fingerprint: diagnosticFingerprint(committed.inputHeadRevisionId),
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
          previousResidentTokens: committed.estimatedResidentTokens,
          oversizedFreshSeed: committed.oversizedFreshSeed,
          inputTokens: physicalContext.transferTokens + 1_024,
          outputReserveTokens: workingPolicy.outputReserveTokens,
          ...(committed.physicalLimits ? { physicalLimits: committed.physicalLimits } : {}),
          ...(hotCandidate ? { hotHistory: hotCandidate } : {}),
        }),
      });
    }
    const contentById = new Map(projection.revisions.map(item => [item.revision.id, item.content]));
    const candidates = await cachedCheckpoints(options.checkpointCache, threadId);
    let selected = working.checkpoint ?? (options.visiblePrefix && browserModel
      ? undefined : activeCheckpoint(projection, candidates, budgetTokens));
    const requestCheckpointFromCache = !working.produced && selected !== undefined;
    let requestCheckpointProduced = working.produced;
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
    fitProjection = projection;
    fitBudget = freshBudgetTokens;
    fitCheckpoint = selected !== undefined;
    stage("physical_context_fit");
    let prepared = await prepareWebContext({
      lineage: projection.lineage,
      headId: projection.headId,
      source: sourceFor(),
      ...(freshBudgetTokens !== undefined ? { budgetTokens: freshBudgetTokens } : {}),
      ...(selected ? { checkpoint: selected.checkpoint } : {}),
    });
    if (prepared.status === "checkpoint-required"
      && options.checkpointCache
      && checkpointProducer) {
      const anchor = workingCheckpointAnchor(projection);
      if (!anchor) {
        throw new WebContextFitFailed("newest_revision_oversize", {
          required: prepared.logicalTokens, budget: prepared.budgetTokens,
        });
      }
      // A current system/developer instruction is not historical work that may
      // be replaced by lossy prose. Keep it exact or refuse the oversized task.
      if (projection.revisions.slice(0, projection.revisions.indexOf(anchor) + 1)
        .every(item => item.revision.kind === "system" || item.revision.kind === "developer")) {
        throw new NativeHistoryBootstrapRequired("source_budget");
      }
      if (selected?.checkpoint.revisionId === anchor.revision.id) {
        throw new NativeHistoryBootstrapRequired("source_budget");
      }
      const scoped = options.visiblePrefix && browserModel
        ? nativeWorkingCheckpointScope(options.visiblePrefix.accountNamespace, threadId, browserModel)
        : undefined;
      const existingAtAnchor = candidates.some(candidate => (
        candidate.checkpoint.revisionId === anchor.revision.id
        && (scoped ? candidate.scopeFingerprint === scoped : candidate.scopeFingerprint === undefined)
      ));
      if (!existingAtAnchor) {
        const checkpointPhysicalContext = checkpointSourceContext(projection, anchor, selected);
        const checkpointMedia = includedMedia(projection, checkpointPhysicalContext);
        const bounded = boundedWebCheckpointSource(
          checkpointPhysicalContext, checkpointMedia,
          browserModel?.effort ?? "medium",
        );
        // A checkpoint producer is a real Web model operation, not a free
        // recursive compressor with unlimited input. Prevent the old
        // "compress -> immediately overflow -> compress again" cycle.
        const stageOwner = options.visiblePrefix;
        if (!bounded && (!stageOwner || checkpointMedia.length)) {
          emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_rejected", {
            phase: "checkpoint_budget", reason_class: "source_exceeds_web_budget",
            source_estimate: checkpointPhysicalContext.transferTokens,
            input_budget: chatGptWebCheckpointSourceTokenLimit(browserModel?.effort ?? "medium"),
            source_segment_count: checkpointPhysicalContext.segments.length,
            media_count: checkpointMedia.length,
            staged_checkpoint_available: !!stageOwner,
          });
          throw new NativeHistoryBootstrapRequired("source_budget");
        }
        stage("checkpoint_production");
        let produced: NativeRequestCheckpointProductionResult;
        let publication: {
          scopeFingerprint: string; revisionId: string; sourceRootDigest: string;
          stageKey: string; content: string; estimatedTokens: number;
        } | undefined;
        if (stageOwner && checkpointMedia.length === 0) {
          // Reuse the existing account-owned durable stage ledger, not a second
          // compressor or an unbounded retry of the same summarization request.
          // The exact immutable request prefix is the source; no history RPC is needed.
          const source = nativeRequestPrefixSnapshot(threadId, turn.channel.binding.authority.turnId, checkpointPhysicalContext);
          const summary = await produceNativePrefixCheckpoint({
            source, accountNamespace: stageOwner.accountNamespace, journal: stageOwner.journal,
            preparationBudget,
            producer: checkpointProducer, effort: browserModel?.effort ?? "medium",
            ...(browserModel ? { browserModel } : {}),
            confirmSource: async () => { preparation?.signal.throwIfAborted(); return source; },
            ...(preparation ? { preparation, signal: preparation.signal } : {}),
          });
          produced = { nativeTaskId: threadId, sourceRevisionId: anchor.revision.id, content: summary };
          if (browserModel) {
            const value = JSON.parse(summary) as { completedStageKey: string };
            publication = {
              scopeFingerprint: nativeWorkingCheckpointScope(stageOwner.accountNamespace, threadId, browserModel),
              revisionId: anchor.revision.id, sourceRootDigest: source.digest,
              stageKey: value.completedStageKey, content: summary, estimatedTokens: checkpointTokens(summary),
            };
            if (stageOwner.journal.publishCheckpoint) {
              await stageOwner.journal.publishCheckpoint(publication);
            }
          }
        } else produced = await checkpointProducer(Object.freeze({
          nativeTaskId: threadId,
          sourceRevisionId: anchor.revision.id,
          physicalContext: bounded!,
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
          ...(publication ? { scopeFingerprint: publication.scopeFingerprint } : {}),
        });
        requestCheckpointProduced = true;
        selectedContent = new Map([[selected.checkpoint.id, selected.content]]);
        fitCheckpoint = true;
        stage("physical_context_fit");
        prepared = await prepareWebContext({
          lineage: projection.lineage,
          headId: projection.headId,
          source: sourceFor(),
          ...(freshBudgetTokens !== undefined ? { budgetTokens: freshBudgetTokens } : {}),
          checkpoint: selected.checkpoint,
        });
      }
    }
    if (prepared.status !== "ready") {
      throw new WebContextFitFailed("checkpoint_required", {
        required: prepared.logicalTokens, budget: prepared.budgetTokens,
      });
    }
    // A Native source-bound checkpoint/handoff (or exact bounded original
    // history) is atomic transport context. Provider-level assistant
    // presentation trimming must not sever its provenance or limitations.
    stage("physical_context_fit");
    // Tool results are original evidence, not merely settled assistant style.
    // The shared checkpoint may summarize a sealed prefix with readback caveats,
    // but the fresh execution presenter must not quietly shorten unsummarized proof.
    const protectedNativeEvidence = Object.freeze([
      ...projection.protectedRevisionIds,
      ...projection.revisions.filter(item => item.revision.kind === "tool-result")
        .map(item => item.revision.id),
    ]);
    const withInstructions = withExactCurrentInstructions(prepared.physicalContext, projection);
    const providerProjection = physicalLimits
      ? fitFreshWebPhysicalContext(withInstructions, {
          ...physicalLimits, rolloverTokenLimit: workingPolicy.firstMessageTargetTokens,
        }, protectedNativeEvidence)
      : projectFreshWebPhysicalContext(withInstructions, undefined, {
          protectedRevisionIds: protectedNativeEvidence,
        });
    stage("media_binding");
    const boundContext = bindNativePhysicalEvidence(projection, providerProjection.context);
    const media = includedMedia(projection, boundContext, true);
    // One fresh task seed only: no separate file preload/ACK model turn.
    // The composer/hard-window preflight below must refuse irreducible oversize
    // rather than secretly spending an additional task conversation turn.
    const physicalContext = physicalMediaCost(boundContext, media);
    // On-demand byte partition of the already prepared seed. No bodies or extra
    // model work; irreducible user/authority/protected evidence stays explicit.
    const seedBytes = { authority: 0, user: 0, checkpoint: 0, protectedTool: 0, other: 0 };
    const protectedIds = new Set(protectedNativeEvidence);
    for (const segment of boundContext.segments) {
      const kind = segment.type === "checkpoint" ? "checkpoint"
        : segment.kind === "system" || segment.kind === "developer" ? "authority"
        : segment.kind === "user" || segment.kind === "steering" ? "user"
        : segment.kind === "tool-result" && protectedIds.has(segment.revisionId) ? "protectedTool" : "other";
      seedBytes[kind] += Buffer.byteLength(segment.content, "utf8");
    }
    const authority = boundContext.segments.filter(segment => segment.type !== "checkpoint").filter(segment => segment.kind === "system" || segment.kind === "developer");
    const authorityByContent = new Map(authority.map(segment => [createHash("sha256").update(segment.content).digest("hex"), Buffer.byteLength(segment.content, "utf8")]));
    const authorityUniqueBytes = [...authorityByContent.values()].reduce((sum, bytes) => sum + bytes, 0);
    emitDiagnosticEvent("chatgpt_tela_codex", "native_seed_authority_observed", {
      segment_count: authority.length, unique_segment_count: authorityByContent.size,
      authority_bytes: seedBytes.authority, unique_authority_bytes: authorityUniqueBytes,
      duplicate_authority_bytes: seedBytes.authority - authorityUniqueBytes,
      largest_segment_bytes: [...authorityByContent.values()].reduce((largest, bytes) => Math.max(largest, bytes), 0),
      system_bytes: authority.filter(segment => segment.kind === "system").reduce((sum, segment) => sum + Buffer.byteLength(segment.content, "utf8"), 0),
      developer_bytes: authority.filter(segment => segment.kind === "developer").reduce((sum, segment) => sum + Buffer.byteLength(segment.content, "utf8"), 0),
      native_instructions_bytes: typeof nativeRequestContentSource(nativeRequest).instructions === "string"
        ? Buffer.byteLength(nativeRequestContentSource(nativeRequest).instructions as string, "utf8") : 0,
    });
    const transportAnchor = prepared.plan.mode === "checkpoint-delta"
      ? `checkpoint:${prepared.plan.checkpointId}`
      : `full:${projection.headId}`;
    const epochId = webEpochId(threadId, transportAnchor, currentRouteIdentity);
    stage("settlement");
    pendingByTask.set(threadId, pending);
    return Object.freeze({
      nativeTaskId: threadId,
      webEpochId: epochId,
      physicalContext,
      ...(media.length ? { media } : {}),
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
        request_checkpoint_reused: requestCheckpointFromCache && physicalContext.segments.some(s => s.type === "checkpoint"),
        request_checkpoint_produced: requestCheckpointProduced,
        checkpoint_candidate_count: candidates.length,
        logical_revision_count: projection.revisions.length,
        physical_rollover: pressure?.shouldRollover === true,
        prior_settlement_present: committed !== undefined,
        fresh_seed_target: workingPolicy.firstMessageTargetTokens,
        fresh_seed_exceeds_target: physicalContext.transferTokens >= workingPolicy.firstMessageTargetTokens,
        fresh_seed_exceeds_rollover: !!physicalLimits && physicalContext.transferTokens >= physicalLimits.rolloverTokenLimit,
        seed_authority_bytes: seedBytes.authority, seed_user_bytes: seedBytes.user,
        seed_checkpoint_bytes: seedBytes.checkpoint, seed_protected_tool_bytes: seedBytes.protectedTool,
        seed_other_bytes: seedBytes.other,
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
        context_attachment: false,
        media_reference_count: media.length,
        media_file_count: new Set(media.map(item => item.file.name)).size,
        media_unique_bytes: [...new Map(media.map(item => [item.file.name, item.file.bytes.byteLength])).values()]
          .reduce((sum, count) => sum + count, 0),
      }),
      settle: settleOwnedContext({
        threadId, pending, webEpochId: epochId,
        inputHeadRevisionId: projection.headId, routeIdentity: currentRouteIdentity,
        previousResidentTokens: 0,
        oversizedFreshSeed: !!physicalLimits && physicalContext.transferTokens >= physicalLimits.rolloverTokenLimit,
        inputTokens: physicalContext.transferTokens + 1_024,
        outputReserveTokens: workingPolicy.outputReserveTokens,
        ...(physicalLimits ? { physicalLimits } : {}),
        ...(hotCandidate ? { hotHistory: hotCandidate } : {}),
      }),
    });
    } catch (error) {
      if (lastStage === "physical_context_fit" && fitProjection) {
        // Failure-only numeric evidence; no request, revision identity or exception prose.
        const revisions = fitProjection.revisions;
        const size = (kinds: readonly string[]) => revisions.filter(item => kinds.includes(item.revision.kind))
          .reduce((n, item) => n + Buffer.byteLength(item.content, "utf8"), 0);
        emitDiagnosticEvent("chatgpt_tela_codex", "native_context_fit_rejected", {
          reason_class: classifyWebPreparationFailure(error), phase: "physical_context_fit",
          logical_estimate: revisions.reduce((n, item) => n + item.revision.estimatedTokens, 0),
          revision_count: revisions.length, checkpoint_selected: fitCheckpoint,
          largest_revision_bytes: revisions.reduce((n, item) => Math.max(n, Buffer.byteLength(item.content, "utf8")), 0),
          authority_bytes: size(["system", "developer"]), user_bytes: size(["user", "steering"]),
          tool_bytes: size(["tool-call", "tool-result"]), media_count: fitProjection.media.length,
          ...(fitBudget === undefined ? {} : { fit_budget: fitBudget }),
        });
      }
      throw error;
    }
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
        clearRetainedContext(threadId);
      }
    },
  });
}
