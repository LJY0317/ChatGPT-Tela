import { WebObservationUnproven, WebSubmissionUnproven, webProviderFailureReason, type WebSubmissionProofReason } from "@chatgpt-tela/core";
import { authorFingerprint, assistantFor, baselineUserLineageKeys, resolveAssistantLineage, type TurnOwnership, type AssistantLineageResolution } from "./turn-ownership";
import { createHash } from "node:crypto";
import {
  BROWSER_PAGE_AUTOMATION,
  BROWSER_INPUT_OWNERSHIP,
  BROWSER_DOCUMENT_LIFETIME,
  captureBrowserDiagnosticEvidence,
  captureBrowserDiagnosticCheckpoint,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { WebRetainedContextUnproven, capturePrivateDiagnosticValue, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext, type WebRetainedContextReason } from "@chatgpt-tela/core";
import { ChatGptDomSurfaceDriver } from "./dom-driver";
import { decideChatGptApproval, type ChatGptApprovalAutomationMode } from "./approval-policy";
import { ChatGptApprovalObservation, approvalPreparationFailureSummary, approvalObservationSummary, type ApprovalObservationTransition } from "./approval-observation";
import {
  contextAttachmentReference,
  formatChatGptContextAttachmentStage,
  formatInertSourceAttachment,
  type ChatGptContextAttachmentReference,
} from "./context-attachment";
import { prepareWebTurnMedia, type WebTurnMedia } from "./turn-media";
import {
  CHATGPT_SURFACE_DRIVER,
  type ChatGptComposerObservation,
  type ChatGptSurfaceDriver,
  type ChatGptSurfaceSnapshot,
  type ChatGptTurnObservation,
} from "./surface";
import type {
  ChatGptCapabilities,
  SemanticObservation,
  WebContextAttachmentPreloadRequest,
  WebContextAttachmentPreloadResult,
  WebConversationProvider,
  WebPhysicalContext,
  WebToolContinuationBoundary,
  WebTurnEvent,
  WebTurnHandle,
  WebTurnRequest,
  WebTurnState,
  WebApprovalWaitProjection,
} from "./index";
import { isChatGptTemporaryChatUrl, isChatGptProvisionalConversationUrl } from "./session";

interface TrackedTurn extends TurnOwnership {
  readonly handle: WebTurnHandle;
  readonly surfaceLeaseId: string;
  readonly preSubmitApprovalRevision?: string;
  revision: string;
  readonly deliveryWaitTimeoutMs: number;
  readonly isToolExecutionPending?: () => boolean;
  deliveryWaitDeadline?: number;
  continuationBoundary?: {
    readonly callId: string;
    readonly assistantFingerprint: string;

  };
  pendingCompletedAnswer?: Pick<Extract<WebTurnEvent, { kind: "completed" }>, "answer" | "plainAnswer">;
  waitState?: string;
  deferredCompletionEvidence?: Set<string>;
  waitSnapshotCount?: number;
  lastWaitSnapshotAt?: number;
  diagnosticBoundaryCount?: number;
  publicProgress?: string;
  missingPublicProgressCaptured?: boolean;
  titleOnlyPublicProgressCaptured?: boolean;
  unmappedPublicProgressCaptured?: boolean;
  approvalProgress?: string;
  approvalPendingCaptured?: boolean;
  responseRetryState?: "dispatched" | "observed";
  approvalFailureCaptured?: string;
  readonly approvalObservation: ChatGptApprovalObservation;
  observeAgain?: boolean;
  readonly operationAbort: AbortController;
  retirement?: Promise<void>;
}

function observeProviderFailure(detail: string | undefined): void {
  // Keep only shape evidence when the provider's rendered error differs from its
  // underlying failure. Never retain the displayed error text.
  const normalized = detail?.trim().toLowerCase() ?? "";
  emitDiagnosticEvent("chatgpt_tela_work", "web_provider_failure_detail_classified", {
    reason_class: webProviderFailureReason(detail),
    detail_chars: detail?.length ?? 0,
    contains_length_term: /\b(long|length|large|limit)\b/.test(normalized),
    contains_submission_term: /\b(message|submitted|prompt)\b/.test(normalized),
  });
}

function logApprovalTransition(transition: ApprovalObservationTransition | undefined): void {
  if (!transition) return;
  emitDiagnosticEvent("chatgpt_tela_work", "approval_wait_transition", {
    phase: transition.phase, elapsed_ms: transition.elapsedMs,
    ...(transition.cardFingerprint ? { card_fingerprint: transition.cardFingerprint } : {}),
  });
}

export interface ChatGptSemanticProviderOptions {
  /** Exact ChatGPT connector display identity to attach only when a Web turn owns a tool bridge. */
  readonly connectorName?: string;
  /** Optional local approval policy. Disabled by default. */
  readonly approvalAutomationMode?: ChatGptApprovalAutomationMode;
  /** Optional bounded delay before inspecting the current one-shot approval card. */
  readonly approvalAutomationDelayMs?: number;
  /** Require the first send on each leased surface to start in a fresh Temporary Chat. */
  readonly requireTemporaryChat?: boolean;
  /** Bound only unproductive response delivery, not model generation or the whole Goal. */
  readonly deliveryWaitTimeoutMs?: number;
}

export interface ChatGptConnectorObservation {
  readonly connectorName: string;
  readonly connectorFingerprint: string;
  readonly routingMode: "explicit";
}

export interface ChatGptConnectorProbe {
  recoverConnectorProbeArtifact(
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
    options?: { readonly allowUnknownSelectedConnector?: boolean },
  ): Promise<boolean>;
  probeConnector(
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ): Promise<ChatGptConnectorObservation>;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Abort is a settlement boundary even when an adapter fails to observe its signal. */
async function waitOwned<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

function evidence(...parts: string[]): readonly string[] {
  return Object.freeze(parts);
}

/** Both representations belong to the same lineage-checked assistant body. */
function completedAnswerBody(assistant: ChatGptTurnObservation) {
  return {
    answer: assistant.text ?? "",
    ...(assistant.plainBodyText !== undefined ? { plainAnswer: assistant.plainBodyText } : {}),
  };
}

function routeKind(url: string): "home" | "conversation" | "auth" | "workspace" | "other" | "invalid" {
  try {
    const pathname = new URL(url).pathname;
    if (pathname === "/" || pathname === "") return "home";
    if (pathname.startsWith("/c/")) return "conversation";
    if (pathname.startsWith("/auth/")) return "auth";
    if (pathname.startsWith("/g/")) return "workspace";
    return "other";
  } catch {
    return "invalid";
  }
}

function surfaceDiagnostic(stage: string, snapshot: ChatGptSurfaceSnapshot, extra: Readonly<Record<string, number | boolean | string>> = {}): void {
  emitDiagnosticEvent("chatgpt_tela_surface", stage, {
    route_kind: routeKind(snapshot.url),
    composer_count: snapshot.composers.length,
    ready_composer_count: readyComposers(snapshot).length,
    send_count: snapshot.sendControls.length,
    turn_count: snapshot.turns.length,
    ...extra,
  });
}

function acceptanceProofReason(reason: string | undefined): WebSubmissionProofReason {
  return reason && ["author_root_missing", "ambiguous_author_root", "author_payload_empty", "author_payload_budget"].includes(reason)
    ? reason as WebSubmissionProofReason : "author_payload_unavailable";
}

/** Validate even injected drivers; no unknown strings or content enter diagnostics. */
function acceptanceStructure(turn: ChatGptTurnObservation | undefined) {
  const witness = turn?.userPayloadStructure;
  return witness && Number.isSafeInteger(witness.rootCount) && witness.rootCount >= 0 ? {
    author_root_count: Math.min(witness.rootCount, 65),
    ...(typeof witness.nestedRoots === "boolean" ? { author_roots_nested: witness.nestedRoots } : {}),
    ...(Number.isSafeInteger(witness.outerLength) && witness.outerLength! >= 0 && witness.outerLength! <= 1_048_576 ? { author_outer_length: witness.outerLength! } : {}),
    ...(Number.isSafeInteger(witness.innerLength) && witness.innerLength! >= 0 && witness.innerLength! <= 1_048_576 ? { author_inner_length: witness.innerLength! } : {}),
    ...(typeof witness.equivalentRoots === "boolean" ? { author_roots_equivalent: witness.equivalentRoots } : {}),
  } : {};
}

function driverFor(surface: BrowserSurfaceLease): ChatGptSurfaceDriver {
  const driver = surface.capability(CHATGPT_SURFACE_DRIVER);
  if (driver) return driver;
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (page) return new ChatGptDomSurfaceDriver(page);
  throw new Error("browser surface does not expose ChatGPT or page automation capability");
}

function readyComposers(snapshot: ChatGptSurfaceSnapshot): readonly ChatGptComposerObservation[] {
  return snapshot.composers.filter(composer => (
    composer.visible && composer.editable && composer.ownedByChatGptForm
  ));
}

function exactComposer(snapshot: ChatGptSurfaceSnapshot): ChatGptComposerObservation {
  const composers = readyComposers(snapshot);
  if (composers.length !== 1) {
    throw new Error(`ChatGPT semantic surface requires exactly one ready composer; observed ${composers.length}`);
  }
  return composers[0]!;
}

function composerAttachmentNames(composer: ChatGptComposerObservation): readonly string[] {
  // Older fixture/provider snapshots predate attachment observation; normalize them as empty at
  // this semantic boundary while production DOM snapshots always provide the explicit field.
  return composer.attachmentNames ?? [];
}

function exactSend(snapshot: ChatGptSurfaceSnapshot, composerKey: string) {
  const controls = snapshot.sendControls.filter(control => (
    control.semantic === "send"
    && control.composerKey === composerKey
    && control.visible
  ));
  if (controls.length !== 1) {
    throw new Error(`ChatGPT semantic surface requires exactly one send control; observed ${controls.length}`);
  }
  return controls[0]!;
}

function visibleSends(snapshot: ChatGptSurfaceSnapshot, composerKey: string) {
  return snapshot.sendControls.filter(control => (
    control.semantic === "send" && control.composerKey === composerKey && control.visible
  ));
}

const CHATGPT_READINESS_TIMEOUT_MS = 30_000;
const CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS = 5_000;
function timeoutSignal(caller: AbortSignal | undefined, timeoutMs: number): {
  readonly combined: AbortSignal;
  readonly timeout: AbortSignal;
} {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    combined: caller ? AbortSignal.any([caller, timeout]) : timeout,
    timeout,
  };
}

async function waitForHydratedComposer(
  driver: ChatGptSurfaceDriver,
  callerSignal?: AbortSignal,
): Promise<{ readonly snapshot: ChatGptSurfaceSnapshot; readonly timedOut: boolean }> {
  const deadline = timeoutSignal(callerSignal, CHATGPT_READINESS_TIMEOUT_MS);
  let snapshot = await driver.observe(deadline.combined);
  while (readyComposers(snapshot).length === 0) {
    try {
      snapshot = await driver.waitForChange(snapshot.revision, deadline.combined);
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (deadline.timeout.aborted) {
        surfaceDiagnostic("composer_hydration_timeout", snapshot, { timed_out: true });
        return { snapshot, timedOut: true };
      }
      throw error;
    }
  }
  return { snapshot, timedOut: false };
}

async function waitForSettledEmptyComposer(
  driver: ChatGptSurfaceDriver,
  initial: ChatGptSurfaceSnapshot,
  callerSignal?: AbortSignal,
): Promise<{ readonly snapshot: ChatGptSurfaceSnapshot; readonly timedOut: boolean }> {
  const deadline = timeoutSignal(callerSignal, CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS);
  let snapshot = initial;
  for (;;) {
    const composers = readyComposers(snapshot);
    if (composers.length !== 1
      || composers[0]?.textLength === 0
      || (composers[0]?.textLength ?? 0) > 1) {
      return { snapshot, timedOut: false };
    }
    try {
      snapshot = await driver.waitForChange(snapshot.revision, deadline.combined);
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (deadline.timeout.aborted) {
        surfaceDiagnostic("composer_settle_timeout", snapshot, { timed_out: true });
        return { snapshot, timedOut: true };
      }
      throw error;
    }
  }
}

async function restoreEmptyComposer(
  driver: ChatGptSurfaceDriver,
  composerKey: string,
): Promise<void> {
  await driver.clearComposerText(composerKey);
  const deadline = timeoutSignal(undefined, CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS);
  let snapshot = await driver.observe(deadline.combined);
  for (;;) {
    const composers = readyComposers(snapshot);
    if (composers.length === 1
      && composers[0]?.key === composerKey
      && composers[0]?.textLength === 0
      && composers[0]?.connectorFingerprints.length === 0
      && composerAttachmentNames(composers[0]!).length === 0) return;
    const current = composers.find(composer => composer.key === composerKey);
    if (current
      && current.textLength === 0
      && current.connectorFingerprints.length === 0
      && composerAttachmentNames(current).length > 0) {
      emitDiagnosticEvent("chatgpt_tela_readiness", "composer_cleanup_blocked_by_attachment", {
        attachment_count: composerAttachmentNames(current).length,
      });
      throw new Error(
        "ChatGPT composer contains an existing attachment; Tela preserved it instead of guessing ownership",
      );
    }
    if (composers.length > 1) {
      throw new Error("ChatGPT composer cleanup found multiple active composers");
    }
    try {
      snapshot = await driver.waitForChange(snapshot.revision, deadline.combined);
    } catch (error) {
      if (deadline.timeout.aborted) {
        const current = readyComposers(snapshot).find(composer => composer.key === composerKey);
        emitDiagnosticEvent("chatgpt_tela_readiness", "composer_cleanup_timeout", {
          ready_composer_count: readyComposers(snapshot).length,
          text_length: current?.textLength ?? -1,
          connector_count: current?.connectorFingerprints.length ?? -1,
          attachment_count: current ? composerAttachmentNames(current).length : -1,
        });
        throw new Error("ChatGPT composer cleanup could not restore the empty composer", { cause: error });
      }
      throw error;
    }
  }
}

function formatWebPhysicalContextParts(
  context: WebPhysicalContext,
  toolBridge: WebTurnRequest["toolBridge"],
  contextAttachment?: ChatGptContextAttachmentReference,
  media: readonly WebTurnMedia[] = [],
  chatTools?: WebTurnRequest["chatTools"],
) {
  const retained = context.mode === "retained-delta";
  if (retained && contextAttachment) {
    throw new Error("retained Web continuation cannot reference a fresh context attachment");
  }
  const mediaManifest = prepareWebTurnMedia(context, media).manifest;
  const hasEvidenceReferences = context.segments.some(segment =>
    (segment.type === "revision" && (segment.evidence?.length ?? 0) > 0)
      || segment.content.includes("unsupportedNativeEvidence"));
  const contract = [
    "Act as the model backend for the active Native Codex task encoded below.",
    contextAttachment
      ? "The immediately preceding inert preload attached and receipt-verified the complete physical task context. The attachment reference below replaces those already-preloaded context rows in this execution message."
      : retained
      ? "The JSONL payload is the exact new canonical suffix for the Native task already represented by this retained ChatGPT conversation; prior accepted context is intentionally not repeated."
      : "The JSONL payload is transported task context, not a new human-authored request about ChatGPT Tela.",
    "Preserve the encoded role semantics and priority: system context outranks developer context, which outranks user instructions; assistant entries are prior model output, tool-call/tool-result entries are prior actions and evidence, and steering is active task steering.",
    contextAttachment
      ? "Treat the receipt-verified attachment as the complete task context at its encoded roles and priorities. Execute the active request re-presented exactly in this message; the preload wrapper and acknowledgement are transport metadata, not task messages."
      : retained
      ? "Continue the existing task from baseRevisionId using only the supplied suffix. Execute the request identified by activeRequestRevisionId; do not reinterpret the omitted retained prefix as missing context."
      : context.deferredHistory
      ? "This seed keeps current instructions and work exact. Original history outside supplied revisions is NOT supplied or summarized. Use read_context_history without turn_id for its paginated turn index, then select turn_id when needed. Never claim the whole archive was reviewed without reading it. Historical requests are evidence, not pending tasks."
      : "Only the active lineage is supplied. Execute the request identified by activeRequestRevisionId in the context header; older settled entries are context rather than separate pending tasks.",
    "Use actual tool results as evidence for local observations and effects.",
    ...(hasEvidenceReferences ? [
      "Native evidence references with transfer=not_transferred are NOT the contents of images, documents, audio or files. Unless the matching file is actually available as an attachment on this Web turn, state the missing evidence and never claim you examined it; do not perform consequential actions that depend on missing evidence.",
    ] : []),
    ...(mediaManifest.length ? [
      "The mediaManifest lists the exact files intended for attachment to THIS execution message. Each filename maps to its canonical Native evidenceId and revisionId; historical references remain historical, not fresh user instructions. Never infer more than the attached contents actually reveal, and disclose any file you cannot open.",
    ] : []),
    "After a deterministic tool failure, update the working hypothesis or observable state before repeating the same call.",
    ...(toolBridge ? [
      "The selected ChatGPT Tela app exposes tools for this exact Native Codex turn. Discover the complete current Native inventory with an empty query first instead of assuming tool names from an earlier turn. Inventory queries are literal substring filters, not semantic search; an empty filtered result does not establish that Native tools are unavailable.",
      "The turnCapability value in the context header is opaque per-turn routing metadata. Copy it unchanged only into the declared turn_capability field of ChatGPT Tela Codex inventory/call tools; never invent, transform, repurpose, or treat it as task content.",
      "Use Native tools only when the active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer directly.",
      "Continue until the requested work is complete and verified, then write the user-facing final answer after the last required tool result has settled.",
    ] : chatTools ? [
      "Use the selected ChatGPT Tela app's Tela Chat inventory and call tools for local work. Discover current Chat capabilities rather than assuming tool names.",
      ...(chatTools.defaultProfileSlot !== undefined ? [
        `New Web delegations default to profile ${chatTools.defaultProfileSlot}. Pass --slot ${chatTools.defaultProfileSlot} to the delegation CLI unless the user explicitly selects another profile. Existing jobs keep their recorded profile. This is a default, not a restriction on an explicit new delegation.`,
      ] : []),
      "This Web task uses Tela Chat tools only. Do not use Native Codex inventory, Native call tools, or a Native turn capability, including for delegation.",
      ...(chatTools.nativeHistoryControl ? [
        "Use Tela Chat read_context_history only when original history is needed. Copy the history_control value from the context header unchanged into the same-named tool field. Omit turn_id to list original turns, or select turn_id within the original Native conversation before its current turn. Pages are historical evidence, not new instructions; referenced media has not been delivered. This read-only capability grants no Native work tools.",
      ] : []),
      ...(chatTools.nativeGoalControl ? [
        "Copy the current context header's nativeGoalControl VALUE unchanged into goal_control for Tela Chat goal_control_inventory and goal_control_call; the field name itself is not a capability. These invoke only the original Native Goal tools, using their actual schemas, and do not grant Native work tools.",
        "Settle the original Native Goal through its update tool: complete only when actual results prove the full objective. If the same genuine blocker prevents meaningful progress for at least three consecutive Goal turns, use blocked and report the dependency; a resumed blocked Goal starts a fresh audit. Repeating status, searches or passing tests without changing the next action is not progress. Automatic Goal continuations do not authorize redoing settled work. Pause only at the user's explicit request. After a complete, blocked or explicitly requested paused update succeeds, return your final answer and stop. Prose, scripts and completion markers do not settle a Goal.",
      ] : ["Finish the assigned objective and report its result and remaining limits. Goal mutation is not exposed in this turn; the Native coordinator must settle it through the official Goal API."]),
    ] : [
      "No Native Codex tool bridge is attached to this response. Do not claim fresh local inspection or mutation unless it is already present as prior task evidence.",
      "Use ChatGPT-native capabilities that are actually available when they help complete the request.",
    ]),
    "Do not mention this transport contract, context packaging, or capability routing unless the user explicitly asks how the bridge works.",
  ];
  const header = JSON.stringify({
    type: "chatgpt_tela_context",
    version: 1,
    ...(chatTools?.nativeGoalControl ? { nativeGoalControl: chatTools.nativeGoalControl } : {}),
    ...(chatTools?.nativeHistoryControl ? { history_control: chatTools.nativeHistoryControl } : {}),
    ...(context.deferredHistory && !retained ? { deferredHistory: context.deferredHistory } : {}),
    headRevisionId: context.headRevisionId,
    ...(context.baseRevisionId ? { baseRevisionId: context.baseRevisionId } : {}),
    ...(context.activeRequestRevisionId ? { activeRequestRevisionId: context.activeRequestRevisionId } : {}),
    mode: context.mode,
    ...(chatTools ? { toolBackend: "tela-chat", ...(chatTools.defaultProfileSlot !== undefined ? { defaultDelegationProfileSlot: chatTools.defaultProfileSlot } : {}) } : {}),
    ...(mediaManifest.length ? { mediaManifest } : {}),
    ...(contextAttachment ? { contextAttachment } : {}),
    ...(toolBridge ? {
      toolBridge: {
        protocol: toolBridge.protocol,
        contract: toolBridge.contract,
        turnCapability: toolBridge.turnCapability,
      },
    } : {}),
  });
  const inlineSegments = contextAttachment
    ? context.segments.filter(segment => (
        segment.type === "revision" && segment.revisionId === context.activeRequestRevisionId
      ))
    : context.segments;
  if (contextAttachment && context.activeRequestRevisionId && inlineSegments.length !== 1) {
    throw new Error("context attachment execution message could not re-present the exact active request");
  }
  const lines = inlineSegments.map(segment => (
    segment.type === "checkpoint"
      ? JSON.stringify({
          type: "checkpoint",
          checkpointId: segment.checkpointId,
          sourceRevisionId: segment.sourceRevisionId,
          content: segment.content,
        })
      : JSON.stringify({
          type: "revision",
          revisionId: segment.revisionId,
          kind: segment.kind,
          content: segment.content,
        })
  ));
  const text = [
    "<chatgpt_tela_transport_contract>",
    ...contract,
    "</chatgpt_tela_transport_contract>",
    "<chatgpt_tela_context_jsonl>",
    header,
    ...lines,
    "</chatgpt_tela_context_jsonl>",
    "<chatgpt_tela_transport_resume>",
    contextAttachment
      ? "The receipt-verified attached context plus the exact active request above is the active task context. Execute it now under the contract above."
      : retained
      ? "The retained conversation plus this exact canonical suffix is the active task context. Continue the latest request now under the contract above."
      : "The active task context is complete. Execute the latest active request now under the contract above.",
    "</chatgpt_tela_transport_resume>",
  ].join("\n");
  const composerBytes = Buffer.byteLength(text);
  const contextBytes = lines.reduce((n,line)=>n+Buffer.byteLength(line), Math.max(0,lines.length-1));
  return {text, composerBytes, contextBytes, protocolBytes:composerBytes-contextBytes};
}

export function formatWebPhysicalContext(context: WebPhysicalContext, toolBridge: WebTurnRequest["toolBridge"],
  contextAttachment?: ChatGptContextAttachmentReference, media: readonly WebTurnMedia[] = [], chatTools?: WebTurnRequest["chatTools"]): string {
  return formatWebPhysicalContextParts(context,toolBridge,contextAttachment,media,chatTools).text;
}



function assistantFingerprint(assistant: ChatGptTurnObservation | undefined): string {
  if (!assistant) return fingerprint("null");
  const { publicProgress: _presentation, progressProbe: _diagnostic, ...state } = assistant;
  return fingerprint(JSON.stringify(state));
}

function approvalAssistantVersion(assistant: ChatGptTurnObservation | undefined): string {
  // Renderer rekeys, timers and action controls are not substantive task progress.
  return fingerprint(JSON.stringify([assistant?.text ?? "", assistant?.publicProgress ?? []]));
}

/** Structural failure/transition evidence only; raw renderer keys, text and URLs stay private. */
async function recordDeferredCompletion(surface: BrowserSurfaceLease, tracked: TrackedTurn,
  snapshot: ChatGptSurfaceSnapshot, reason: "identity_pending" | "approval_pending" | "multiple_assistants"): Promise<void> {
  const completed = snapshot.turns.filter(turn => turn.role === "assistant" && turn.phase === "complete"
    && (reason !== "identity_pending" ? turn.parentUserTurnKey === tracked.userTurnKey
      : !turn.parentUserTurnKey || !tracked.baselineUserLineageKeys.has(turn.parentUserTurnKey)));
  // The first identity loss is evidence even if no assistant has completed yet.
  // A later completed answer gets its own structural receipt without another raw capture.
  const firstPending = reason === "identity_pending"
    && !tracked.deferredCompletionEvidence?.has("identity_pending_entry");
  const firstCompletion = completed.length > 0 && !tracked.deferredCompletionEvidence?.has(reason);
  if (!firstPending && !firstCompletion) return;
  const recorded = tracked.deferredCompletionEvidence ??= new Set<string>();
  if (firstPending) recorded.add("identity_pending_entry");
  if (firstCompletion) recorded.add(reason);
  try {
    await withDiagnosticContext({
      scope_fingerprint: diagnosticFingerprint(tracked.handle.nativeTaskId),
      operation_fingerprint: diagnosticFingerprint([tracked.handle.nativeTaskId, tracked.handle.nativeTurnId,
        tracked.handle.webEpochId].join("\n")),
      turn_fingerprint: diagnosticFingerprint(tracked.handle.nativeTurnId),
    }, async () => {
      if (firstPending) emitDiagnosticEvent("chatgpt_tela_work", "web_identity_pending_capture", {
        ...turnObservationFields(snapshot, tracked), reason_class: "identity_pending",
        current_authority_proven: false,
      });
      if (firstCompletion) emitDiagnosticEvent("chatgpt_tela_work", reason === "identity_pending"
        ? "web_completed_answer_deferred_anomaly" : "web_completed_answer_deferred", {
        ...turnObservationFields(snapshot, tracked),
        ...(completed.length === 1 ? retainedBoundaryFields(completed[0]) : {}),
        reason_class: reason, assistant_phase: "complete", assistant_count: completed.length,
        matched_assistant_count: completed.filter(turn => turn.parentUserTurnKey === tracked.userTurnKey).length,
        approval_card_count: snapshot.approval?.cardCount ?? 0,
        ...(snapshot.approval?.cardFingerprint ? { card_fingerprint: snapshot.approval.cardFingerprint } : {}),
        // A visible card has surface scope; its owner is not proven by the assistant lineage.
        current_authority_proven: false,
      });
      // Capture each distinct boundary once, sharing one snapshot if they coincide.
      // Neither snapshot authorizes delivery.
      await captureBrowserDiagnosticCheckpoint(surface, firstCompletion ? "completion_deferred" : "identity_pending");
    });
  } catch { /* Evidence collection cannot change delivery or task execution. */ }
}

/** A single deadline only while response identity/delivery is unresolved.
 * Provider generation, approvals and exact Native tool work suspend it; DOM noise does not renew it.
 */
function deliveryLineage(snapshot: ChatGptSurfaceSnapshot, tracked: TrackedTurn): AssistantLineageResolution {
  const lineage = resolveAssistantLineage(snapshot, tracked);
  const active = tracked.isToolExecutionPending?.() || pendingApproval(snapshot, tracked)?.cardCount
    || snapshot.turns.some(turn => turn.role === "assistant"
      && (turn.phase === "streaming" || turn.phase === "tool-wait" || turn.progressProbe?.stopVisible));
  const assistant = lineage.assistants.length === 1 ? lineage.assistants[0] : undefined;
  const terminal = !lineage.identityPending && !lineage.ambiguous && assistant
    && (assistant.phase === "complete" || assistant.phase === "failed")
    && (!tracked.continuationBoundary || assistantFingerprint(assistant) !== tracked.continuationBoundary.assistantFingerprint);
  const blocked = !active && !terminal;
  if (!blocked) {
    if (tracked.deliveryWaitDeadline !== undefined) emitDiagnosticEvent("chatgpt_tela_work", "web_delivery_wait_resumed", {
      ...tracked.diagnosticLineage, deadline_ms: tracked.deliveryWaitTimeoutMs,
    });
    delete tracked.deliveryWaitDeadline;
  } else if (tracked.deliveryWaitDeadline === undefined) {
    tracked.deliveryWaitDeadline = Date.now() + tracked.deliveryWaitTimeoutMs;
    emitDiagnosticEvent("chatgpt_tela_work", "web_delivery_wait_started", {
      ...tracked.diagnosticLineage, deadline_ms: tracked.deliveryWaitTimeoutMs,
      reason_class: lineage.identityPending ? "identity_pending" : assistant ? "response_unsettled" : "assistant_missing",
    });
  } else if (Date.now() >= tracked.deliveryWaitDeadline) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_delivery_wait_timeout", {
      ...tracked.diagnosticLineage, deadline_ms: tracked.deliveryWaitTimeoutMs,
      ...turnObservationFields(snapshot, tracked), remote_outcome: "unknown", retryable: false,
    });
    throw new WebObservationUnproven("response_wait_timeout");
  }
  return lineage;
}

async function waitForDeliveryChange(driver: ChatGptSurfaceDriver, tracked: TrackedTurn,
  revision: string, signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot> {
  if (tracked.deliveryWaitDeadline === undefined) return driver.waitForChange(revision, signal);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const changed = driver.waitForChange(revision, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]));
    const snapshot = await Promise.race([changed, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, tracked.deliveryWaitDeadline! - Date.now()));
      timer.unref?.();
    })]);
    signal?.throwIfAborted();
    if (snapshot) return snapshot;

    // Recheck completion races once, with a bound of its own so a hung renderer cannot
    // make the response-delivery deadline unbounded again.
    const observationAbort = new AbortController();
    const observationSignal = AbortSignal.any([observationAbort.signal, ...(signal ? [signal] : [])]);
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = { unavailable: true as const };
    const finalObservation = driver.observe(observationSignal).then(value => ({ value }), () => unavailable);
    const timeout = new Promise<typeof unavailable>(resolve => {
      observationTimer = setTimeout(() => { observationAbort.abort(); resolve(unavailable); }, 5_000);
      observationTimer.unref?.();
    });
    try {
      const result = await Promise.race([finalObservation, timeout]);
      signal?.throwIfAborted();
      if (!("value" in result)) {
        emitDiagnosticEvent("chatgpt_tela_work", "web_delivery_wait_timeout", {
          ...tracked.diagnosticLineage, deadline_ms: tracked.deliveryWaitTimeoutMs,
          final_observation: "unavailable", remote_outcome: "unknown", retryable: false,
        });
        throw new WebObservationUnproven("response_wait_timeout");
      }
      return result.value;
    } finally {
      if (observationTimer) clearTimeout(observationTimer);
      observationAbort.abort();
    }
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort(); // Only this DOM waiter; never the browser or a tool process.
  }
}

async function waitForLineage(
  surface: BrowserSurfaceLease, driver: ChatGptSurfaceDriver, tracked: TrackedTurn, signal?: AbortSignal,
): Promise<{ snapshot: ChatGptSurfaceSnapshot; lineage: AssistantLineageResolution }> {
  let snapshot = await driver.observe(signal);
  for (;;) {
    signal?.throwIfAborted();
    const lineage = deliveryLineage(snapshot, tracked);
    if (!lineage.identityPending) return { snapshot, lineage };
    await recordDeferredCompletion(surface, tracked, snapshot, "identity_pending");
    snapshot = await waitForDeliveryChange(driver, tracked, snapshot.revision, signal);
  }
}

function turnObservationFields(snapshot: ChatGptSurfaceSnapshot, tracked: TrackedTurn) {
  const assistants = snapshot.turns.filter(item => item.role === "assistant");
  const matched = assistants.filter(item => item.parentUserTurnKey === tracked.userTurnKey);
  return {
    turn_count: snapshot.turns.length,
    assistant_count: assistants.length,
    matched_assistant_count: matched.length,
    parentless_assistant_count: assistants.filter(item => !item.parentUserTurnKey).length,
    new_lineage_assistant_count: assistants.filter(item => item.parentUserTurnKey
      && !tracked.baselineUserLineageKeys.has(item.parentUserTurnKey)).length,
    complete_assistant_count: assistants.filter(item => item.phase === "complete").length,
    failed_assistant_count: assistants.filter(item => item.phase === "failed").length,
    accepted_user_present: snapshot.turns.some(item => item.role === "user" && item.key === tracked.userTurnKey),
    continuation_pending: !!tracked.continuationBoundary,
    approval_card_count: snapshot.approval?.cardCount ?? 0,
    ready_composer_count: readyComposers(snapshot).length,
    wait_snapshot_count: tracked.waitSnapshotCount ?? 0,
    public_progress_part_count: matched.reduce((count, item) => count + (item.publicProgress?.length ?? 0), 0),
    ...(tracked.lastWaitSnapshotAt === undefined ? {} : { last_wait_snapshot_age_ms: Math.max(0, Date.now() - tracked.lastWaitSnapshotAt) }),
  };
}

/** The owned browser turn has actually returned a completed final to its caller. */
function reportWebFinalObserved(tracked: TrackedTurn): void {
  emitDiagnosticEvent("chatgpt_tela_work", "web_turn_final_observed", {
    scope_fingerprint: diagnosticFingerprint(tracked.handle.nativeTaskId),
    turn_fingerprint: diagnosticFingerprint(tracked.handle.nativeTurnId),
    operation_fingerprint: diagnosticFingerprint([tracked.handle.nativeTaskId, tracked.handle.nativeTurnId,
      tracked.handle.webEpochId].join("\n")),
    assistant_phase: "complete",
  });
}

function answerBodyReason(assistant: ChatGptTurnObservation | undefined): string {
  // Renderer observations remain untrusted, including exception-like strings.
  return ["body_empty", "body_budget", "unsupported_node", "unsupported_link", "unsupported_list", "unsupported_table"]
    .find(value => value === assistant?.bodyProof?.reason) ?? "unclassified";
}

type RetainedAnswer = { readonly state: "verified"; readonly fingerprint: string }
  | { readonly state: "unavailable"; readonly reason: string };

function committedAnswerFingerprint(assistant: ChatGptTurnObservation): string | undefined {
  // The current composer Stop state can change phase labels on older DOM turns. Identity and
  // accepted answer content, rather than current-page activity labels, prove the retained prefix.
  if (assistant.bodyProof?.version !== 1 || assistant.bodyProof.digest === undefined) return undefined;
  return fingerprint(JSON.stringify([assistant.key, assistant.parentUserTurnKey,
    assistant.bodyProof.version, assistant.bodyProof.digest]));
}

function retainedBoundaryFields(assistant: ChatGptTurnObservation | undefined) {
  const structure = assistant?.bodyStructure;
  return {
    ...(assistant?.key ? { assistant_key_fingerprint: diagnosticFingerprint(assistant.key) } : {}),
    ...(assistant?.parentUserTurnKey ? { parent_key_fingerprint: diagnosticFingerprint(assistant.parentUserTurnKey) } : {}),
    assistant_phase: assistant?.phase ?? "absent",
    stop_visible: assistant?.progressProbe?.stopVisible ?? false,
    semantic_digest_fingerprint: assistant?.bodyProof?.digest ?? "unavailable",
    ...(structure ? {
      body_source: structure.source, body_root_candidates: structure.rootCandidateCount,
      body_visible_roots: structure.visibleRootCount, body_selected_index: structure.selectedRootIndex,
      body_selected_visible: structure.selectedRootVisible, body_block_count: structure.blockCount,
      body_visible_blocks: structure.visibleBlockCount,
      ...(structure.rootFingerprint ? { body_root_fingerprint: structure.rootFingerprint } : {}),
      ...(structure.blockFingerprint ? { body_blocks_fingerprint: structure.blockFingerprint } : {}),
      ...(structure.semanticPartCount !== undefined ? { semantic_part_count: structure.semanticPartCount } : {}),
    } : {}),
  };
}

/** An unchanged single card already present before send belongs to an earlier request. */
function pendingApproval(snapshot: ChatGptSurfaceSnapshot, tracked: TrackedTurn): ChatGptSurfaceSnapshot["approval"] {
  const card = snapshot.approval;
  return card?.cardCount === 1 && typeof tracked.preSubmitApprovalRevision === "string"
    && card.revisionFingerprint === tracked.preSubmitApprovalRevision
    ? undefined : card;
}

/** Pending decisions outrank presentation completion; failure always remains terminal. */
function assistantLifecyclePhase(snapshot: ChatGptSurfaceSnapshot, tracked: TrackedTurn,
  assistant: ChatGptTurnObservation | undefined): WebTurnState["phase"] {
  if (assistant?.phase === "failed") return "failed";
  if (pendingApproval(snapshot, tracked)?.cardCount || assistant?.phase === "tool-wait") return "tool-wait";
  if (assistant?.phase === "complete") return "completed";
  return assistant ? "continuing" : "accepted";
}

function stateFromSnapshot(
  snapshot: ChatGptSurfaceSnapshot,
  tracked: TrackedTurn,
): SemanticObservation<WebTurnState> {
  const lineage = deliveryLineage(snapshot, tracked);
  const assistants = lineage.assistants;
  if (lineage.identityPending) return {
    state: "probable", value: { providerTurnId: tracked.handle.providerTurnId, phase: "accepted" },
    evidence: evidence("accepted request retained; current renderer does not expose its user identity"),
  };
  if (lineage.ambiguous) {
    return {
      state: "ambiguous",
      candidates: Object.freeze(assistants.map(assistant => ({
        providerTurnId: tracked.handle.providerTurnId,
        phase: assistant.phase === "complete" ? "completed" as const : "continuing" as const,
      }))),
      evidence: evidence("multiple new assistant lineages appeared after one accepted ChatGPT turn"),
    };
  }
  if (assistants.length > 1) {
    return {
      state: "ambiguous",
      candidates: Object.freeze(assistants.map(assistant => ({
        providerTurnId: tracked.handle.providerTurnId,
        phase: assistant.phase === "complete" ? "completed" as const : "continuing" as const,
      }))),
      evidence: evidence("multiple assistant descendants for one accepted user turn"),
    };
  }
  const assistant = assistants[0];
  if (!assistant) {
    return {
      state: "proven",
      value: { providerTurnId: tracked.handle.providerTurnId, phase: "accepted" },
      evidence: evidence("accepted user turn has no assistant descendant yet"),
    };
  }
  const phase = assistantLifecyclePhase(snapshot, tracked, assistant);
  return {
    state: "proven",
    value: { providerTurnId: tracked.handle.providerTurnId, phase },
    evidence: evidence(`assistant descendant phase=${assistant.phase ?? "unknown"}`),
  };
}

/**
 * First structural ChatGPT provider. It consumes sanitized semantic snapshots/actions supplied by a
 * browser driver and keeps DOM selectors out of runtime/core. Structural proof predicates are exact;
 * no score or arbitrary confidence threshold authorizes submit, acceptance, continuation, or final.
 */
export class ChatGptSemanticProvider implements WebConversationProvider, ChatGptConnectorProbe {
  // One active Native turn per owned surface. Retiring a surface also releases cancelled
  // observation state, without treating a child event-wait cancellation as turn retirement.
  readonly #turns = new WeakMap<BrowserSurfaceLease, TrackedTurn>();
  readonly #connectorName: string | undefined;
  readonly #approvalAutomationMode: ChatGptApprovalAutomationMode;
  readonly #approvalAutomationDelayMs: number;
  readonly #requireTemporaryChat: boolean;
  readonly #deliveryWaitTimeoutMs: number;
  readonly #temporaryChatSurfaces = new WeakSet<BrowserSurfaceLease>();
  readonly #completedBySurface = new WeakMap<BrowserSurfaceLease, {
    readonly userTurnKey: string;
    readonly assistantKey: string;
    readonly retention: RetainedAnswer;
    readonly presentationFingerprint: string;
    readonly answerCharacters: number;
    readonly semanticVersion: number | undefined;
    readonly boundary: ReturnType<typeof retainedBoundaryFields> & { readonly approval_cards: number; readonly handoff_state: string };
    readonly privateBodyEvidence?: ChatGptTurnObservation["privateBodyEvidence"];
  }>();

  #commitAnswer(surface: BrowserSurfaceLease, tracked: TrackedTurn, assistant: ChatGptTurnObservation,
    snapshot: ChatGptSurfaceSnapshot, handoffState: "direct" | "post_tool_handoff"): void {
    const digest = committedAnswerFingerprint(assistant);
    const retention: RetainedAnswer = digest === undefined
      ? { state: "unavailable", reason: answerBodyReason(assistant) }
      : { state: "verified", fingerprint: digest };
    const boundary = { ...retainedBoundaryFields(assistant), approval_cards: snapshot.approval?.cardCount ?? 0,
      handoff_state: handoffState };
    this.#completedBySurface.set(surface, { userTurnKey: tracked.userTurnKey, assistantKey: assistant.key, retention, boundary,
      presentationFingerprint: fingerprint(assistant.text ?? ""), answerCharacters: assistant.text?.length ?? 0,
      semanticVersion: assistant.bodyProof?.version,
      ...(assistant.privateBodyEvidence ? { privateBodyEvidence: assistant.privateBodyEvidence } : {}),
    });
    // Final delivery and retained-context proof are distinct. Record the latter at
    // completion, not for the first time when the next request tries to reuse it.
    emitDiagnosticEvent("chatgpt_tela_work", "web_retained_answer_committed", {
      operation_fingerprint: diagnosticFingerprint([tracked.handle.nativeTaskId, tracked.handle.nativeTurnId,
        tracked.handle.webEpochId].join("\n")),
      ...boundary, answer_characters: assistant.text?.length ?? 0,
      ...(assistant.bodyProof ? { semantic_version: assistant.bodyProof.version } : {}),
      ...(retention.state === "verified" ? { retained_answer_fingerprint: diagnosticFingerprint(retention.fingerprint) } : {}),
      state: retention.state, semantic_answer_available: retention.state === "verified",
      ...(retention.state === "unavailable" ? { reason_class: retention.reason } : {}),
    });
  }

  #assertRetainedConversation(surface: BrowserSurfaceLease, snapshot: ChatGptSurfaceSnapshot): void {
    const anchor = this.#completedBySurface.get(surface);
    const assistants = anchor ? assistantFor(snapshot, anchor.userTurnKey) : [];
    const assistant = assistants.length === 1 ? assistants[0] : undefined;
    const sameKey = !!anchor && assistant?.key === anchor.assistantKey;
    const committedSemanticAvailable = anchor?.retention.state === "verified";
    const observedSemanticAvailable = assistant?.bodyProof?.version === 1 && assistant.bodyProof.digest !== undefined;
    const reason: WebRetainedContextReason = !anchor ? "anchor_missing"
      : !assistant ? "lineage_not_unique" : !sameKey ? "assistant_identity_changed"
      : !committedSemanticAvailable ? "committed_semantic_unavailable"
      : !assistant.bodyProof ? "observed_body_missing"
      : assistant.bodyProof.version !== 1 ? "observed_body_version_unsupported"
      : !observedSemanticAvailable ? "observed_body_incomplete"
      : assistant.text === undefined ? "answer_unavailable" : "semantic_digest_mismatch";
    const bodyReason = answerBodyReason(assistant);
    const observedAnswerFingerprint = assistant ? committedAnswerFingerprint(assistant) : undefined;
    const sameAnswer = !!anchor && !!assistant && assistant.text !== undefined
      && anchor.retention.state === "verified"
      && observedAnswerFingerprint === anchor.retention.fingerprint;
    if (!anchor || !assistant || !sameKey || !sameAnswer) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_retained_anchor_rejected", {
        ...retainedBoundaryFields(assistant),
        ...(anchor ? { committed_boundary_fingerprint: fingerprint(JSON.stringify(anchor.boundary)),
          committed_handoff_state: anchor.boundary.handoff_state,
          committed_approval_cards: anchor.boundary.approval_cards,
          committed_semantic_digest_fingerprint: anchor.boundary.semantic_digest_fingerprint,
          ...(anchor.semanticVersion !== undefined ? { committed_semantic_version: anchor.semanticVersion } : {}),
          ...(anchor.retention.state === "verified" ? { committed_answer_fingerprint: diagnosticFingerprint(anchor.retention.fingerprint) } : {}) } : {}),
        ...(assistant?.bodyProof ? { observed_semantic_version: assistant.bodyProof.version } : {}),
        ...(observedAnswerFingerprint ? {
          observed_answer_fingerprint: diagnosticFingerprint(observedAnswerFingerprint),
        } : {}),
        observed_approval_cards: snapshot.approval?.cardCount ?? 0,
        reason_class: reason,
        phase: bodyReason,
        anchor_present: !!anchor,
        matched_assistant_count: assistants.length,
        assistant_key_matches: sameKey,
        answer_present: assistant?.text !== undefined,
        answer_matches: sameAnswer,
        semantic_answer_available: assistant?.bodyProof?.digest !== undefined,
        committed_semantic_available: committedSemanticAvailable,
        observed_semantic_available: observedSemanticAvailable,
        presentation_matches: !!anchor && !!assistant && fingerprint(assistant.text ?? "") === anchor.presentationFingerprint,
        committed_answer_characters: anchor?.answerCharacters ?? 0,
        observed_answer_characters: assistant?.text?.length ?? 0,
        ...(assistant?.phase ? { assistant_phase: assistant.phase } : {}),
      });
      capturePrivateDiagnosticValue("retained_body_mismatch", {
        before: anchor?.privateBodyEvidence ?? null, after: assistant?.privateBodyEvidence ?? null,
        beforeDigest: anchor?.retention.state === "verified" ? anchor.retention.fingerprint : null,
        afterDigest: observedAnswerFingerprint ?? null,
        assistantKeyMatches: sameKey,
      });
      throw new WebRetainedContextUnproven(reason);
    }
  }

  constructor(options: ChatGptSemanticProviderOptions = {}) {
    const connectorName = options.connectorName?.trim();
    if (connectorName !== undefined
      && (!connectorName || connectorName.length > 128 || /[\u0000\r\n]/.test(connectorName))) {
      throw new Error("ChatGPT connector identity must be 1-128 visible single-line characters");
    }
    this.#connectorName = connectorName;
    this.#approvalAutomationMode = options.approvalAutomationMode ?? "off";
    const approvalDelayMs = options.approvalAutomationDelayMs ?? 0;
    if (!Number.isSafeInteger(approvalDelayMs) || approvalDelayMs < 0 || approvalDelayMs > 15_000) {
      throw new Error("ChatGPT approval automation delay must be 0-15000ms");
    }
    this.#approvalAutomationDelayMs = approvalDelayMs;
    this.#requireTemporaryChat = options.requireTemporaryChat ?? false;
    this.#deliveryWaitTimeoutMs = options.deliveryWaitTimeoutMs ?? 4 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.#deliveryWaitTimeoutMs) || this.#deliveryWaitTimeoutMs < 1) {
      throw new Error("response delivery wait must be a positive millisecond duration");
    }
  }

  #assertTemporaryChatSurface(surface: BrowserSurfaceLease, snapshot: ChatGptSurfaceSnapshot): void {
    if (!this.#requireTemporaryChat) return;
    if (isChatGptTemporaryChatUrl(snapshot.url)) return;
    if (this.#temporaryChatSurfaces.has(surface)
      && new URL(snapshot.url).origin === "https://chatgpt.com"
      && /^\/c\/[^/]+$/.test(new URL(snapshot.url).pathname)) return;
    throw new Error("ChatGPT Work send requires a verified Temporary Chat surface");
  }

  async #verifyConnectorCleanup(
    driver: ChatGptSurfaceDriver,
    composerKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const snapshot = await driver.observe(signal);
    const composer = exactComposer(snapshot);
    if (composer.key !== composerKey
      || composer.textLength !== 0
      || composer.connectorFingerprints.length !== 0) {
      throw new Error("ChatGPT connector cleanup did not leave an empty composer");
    }
  }

  async observeCapabilities(
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<ChatGptCapabilities>> {
    const driver = driverFor(surface);
    const hydrated = await waitForHydratedComposer(driver, signal);
    const settled = await waitForSettledEmptyComposer(driver, hydrated.snapshot, signal);
    const snapshot = settled.snapshot;
    const composers = readyComposers(snapshot);
    if (composers.length === 0) {
      return {
        state: "probable",
        value: { observed: new Set<string>() },
        evidence: evidence(
          hydrated.timedOut
            ? "no visible editable ChatGPT-owned composer before readiness deadline"
            : "no visible editable ChatGPT-owned composer",
        ),
      };
    }
    if (composers.length > 1) {
      return {
        state: "ambiguous",
        candidates: Object.freeze(composers.map(composer => ({
          observed: new Set([`composer:${composer.key}`]),
        }))),
        evidence: evidence("multiple visible editable ChatGPT-owned composers"),
      };
    }
    const composer = composers[0]!;
    if (composer.textLength !== 0) {
      emitDiagnosticEvent("chatgpt_tela_readiness", "existing_draft", {
        text_length: composer.textLength,
        connector_count: composer.connectorFingerprints.length,
        settle_timed_out: settled.timedOut,
      });
      return {
        state: "probable",
        value: { observed: new Set(["composer"]) },
        evidence: evidence(
          settled.timedOut
            ? "composer retained a non-empty draft after hydration settle deadline"
            : "composer contains an existing draft",
        ),
      };
    }
    if (composer.connectorFingerprints.length !== 0) {
      emitDiagnosticEvent("chatgpt_tela_readiness", "retained_connector", {
        text_length: composer.textLength,
        connector_count: composer.connectorFingerprints.length,
      });
      return {
        state: "probable",
        value: { observed: new Set(["composer"]) },
        evidence: evidence("composer retains a selected connector from prior browser state"),
      };
    }
    const sends = visibleSends(snapshot, composer.key);
    // The empty-composer send button can appear only after typing. Readiness
    // must not mutate the user's draft; submitTurn checks actual send admission.
    return {
      state: "proven",
      value: { observed: new Set(sends.length === 1 ? ["composer", "send"] : ["composer"]) },
      evidence: evidence("one empty ChatGPT-owned composer; send is checked after payload fill"),
    };
  }

  async probeConnector(
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ): Promise<ChatGptConnectorObservation> {
    const connectorName = this.#connectorName;
    if (!connectorName) throw new Error("ChatGPT connector probe requires an explicit connector identity");
    const expectedConnectorFingerprint = fingerprint(connectorName);
    const driver = driverFor(surface);
    await driver.dismissTransientUi(signal);
    const hydrated = await waitForHydratedComposer(driver, signal);
    const settled = await waitForSettledEmptyComposer(driver, hydrated.snapshot, signal);
    let composer = exactComposer(settled.snapshot);
    if (composer.textLength !== 0) {
      throw new Error("ChatGPT connector probe refuses a non-empty composer draft");
    }
    if (composer.connectorFingerprints.length > 1) {
      throw new Error("ChatGPT connector probe found multiple selected connectors");
    }
    if (composer.connectorFingerprints.length === 1
      && composer.connectorFingerprints[0] !== expectedConnectorFingerprint) {
      throw new Error("ChatGPT connector probe found a different selected connector");
    }
    let cleanupNeeded = composer.connectorFingerprints.length === 1;
    try {
      if (composer.connectorFingerprints.length === 0) {
        cleanupNeeded = true;
        await driver.selectConnector(composer.key, connectorName, signal);
      }
      const deadline = timeoutSignal(signal, CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS);
      const observed = await driver.observe(deadline.combined);
      composer = exactComposer(observed);
      if (composer.textLength !== 0
        || composer.connectorFingerprints.length !== 1
        || composer.connectorFingerprints[0] !== expectedConnectorFingerprint) {
        throw new Error("ChatGPT connector selection was not structurally proven by the preflight probe");
      }
      return Object.freeze({
        connectorName,
        connectorFingerprint: expectedConnectorFingerprint,
        routingMode: "explicit" as const,
      });
    } finally {
      if (cleanupNeeded) {
        await restoreEmptyComposer(driver, composer.key);
      }
    }
  }

  async recoverConnectorProbeArtifact(
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
    options: { readonly allowUnknownSelectedConnector?: boolean } = {},
  ): Promise<boolean> {
    const driver = driverFor(surface);
    await driver.dismissTransientUi(signal);
    const hydrated = await waitForHydratedComposer(driver, signal);
    const hydratedComposers = readyComposers(hydrated.snapshot);
    if (hydratedComposers.length === 0) return false;
    const composer = exactComposer(hydrated.snapshot);
    if (composer.textLength === 0
      && composer.connectorFingerprints.length === 0
      && composerAttachmentNames(composer).length === 0) return false;
    if (composer.connectorFingerprints.length === 0
      && driver.recoverContextPreloadArtifact
      && await driver.recoverContextPreloadArtifact(composer.key, signal)) {
      await this.#verifyConnectorCleanup(driver, composer.key, signal);
      return true;
    }
    // A matching Tela mention or connector pill does not establish ownership of an attachment
    // beside it. Leave the entire draft intact until the attachment itself is proven to be ours.
    if (composerAttachmentNames(composer).length > 0) return false;
    const connectorName = this.#connectorName;
    if (!connectorName) return false;
    const expectedConnectorFingerprint = fingerprint(connectorName);
    const productOwnedPlainTextArtifacts = [
      `@${connectorName}`,
      `@${connectorName} `,
    ];
    const isPlainTextArtifact = composer.connectorFingerprints.length === 0
      && productOwnedPlainTextArtifacts.some(artifact => (
        composer.textLength === artifact.length && composer.textFingerprint === fingerprint(artifact)
      ));
    const isSelectedConnectorArtifact = composer.textLength === 0
      && composer.connectorFingerprints.length === 1
      && composer.connectorFingerprints[0] === expectedConnectorFingerprint;
    if (isPlainTextArtifact || isSelectedConnectorArtifact) {
      await restoreEmptyComposer(driver, composer.key);
      return true;
    }
    if (options.allowUnknownSelectedConnector === true
      && composer.textLength === 0
      && composer.connectorFingerprints.length === 1) {
      await restoreEmptyComposer(driver, composer.key);
      return true;
    }
    if (!await driver.recoverConnectorArtifact(composer.key, connectorName, signal)) return false;
    await this.#verifyConnectorCleanup(driver, composer.key, signal);
    return true;
  }

  async preloadContextAttachment(
    surface: BrowserSurfaceLease,
    request: WebContextAttachmentPreloadRequest,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebContextAttachmentPreloadResult>> {
    const startedAt = Date.now();
    const driver = driverFor(surface);
    if (!driver.attachFiles) throw new Error("ChatGPT surface does not support memory-backed context attachments");
    const stage = formatChatGptContextAttachmentStage(request.attachment);
    const deadline = timeoutSignal(signal, 120_000);
    let phase = "composer";
    emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_preload_start", {
      context_chars: request.attachment.contextJson.length,
      context_bytes: Buffer.byteLength(request.attachment.contextJson, "utf8"),
      file_bytes: stage.file.bytes.byteLength,
    });

    try {
    const hydrated = await waitForHydratedComposer(driver, deadline.combined);
    const settled = await waitForSettledEmptyComposer(driver, hydrated.snapshot, deadline.combined);
    let baseline = settled.snapshot;
    let composer = exactComposer(baseline);
    if (composer.textLength !== 0
      && composer.connectorFingerprints.length === 0
      && composerAttachmentNames(composer).length === 0
      && driver.recoverContextPreloadArtifact
      && await driver.recoverContextPreloadArtifact(composer.key, deadline.combined)) {
      baseline = await driver.observe(deadline.combined);
      composer = exactComposer(baseline);
      emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_stale_draft_cleared");
    }
    if (composer.textLength !== 0
      || composer.connectorFingerprints.length !== 0
      || composerAttachmentNames(composer).length !== 0) {
      throw new Error("ChatGPT context preload requires one empty connector-free attachment-free composer");
    }
    const baselineTurnKeys = new Set(baseline.turns.map(turn => turn.key));
    const baselineLineage = baselineUserLineageKeys(baseline);
    const expectedPromptFingerprint = fingerprint(stage.text);
    this.#assertTemporaryChatSurface(surface, baseline);

    phase = "prompt";
    await driver.replaceComposerText(composer.key, stage.text, deadline.combined);
    let prepared = await driver.observe(deadline.combined);
    let preparedComposer = exactComposer(prepared);
    if (preparedComposer.textLength !== stage.text.length
      || preparedComposer.textFingerprint !== expectedPromptFingerprint
      || preparedComposer.connectorFingerprints.length !== 0) {
      throw new Error("ChatGPT context preload prompt did not have exact connector-free readback");
    }
    emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_prompt_ready");
    phase = "file_upload";
    await driver.attachFiles(composer.key, [stage.file], deadline.combined);
    emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_file_accepted");
    prepared = await driver.observe(deadline.combined);
    preparedComposer = exactComposer(prepared);
    if (preparedComposer.textLength !== stage.text.length
      || preparedComposer.textFingerprint !== expectedPromptFingerprint
      || preparedComposer.connectorFingerprints.length !== 0
      || composerAttachmentNames(preparedComposer).length === 0) {
      throw new Error("ChatGPT context preload did not preserve exact prompt/file acceptance");
    }
    phase = "submission";
    const sends = visibleSends(prepared, composer.key);
    if (sends.length !== 1 || !sends[0]!.enabled) {
      throw new Error("ChatGPT context preload did not expose one enabled send control after file acceptance");
    }

    this.#assertTemporaryChatSurface(surface, prepared);
    deadline.combined.throwIfAborted();
    emitDiagnosticEvent("chatgpt_tela_work", "web_send_activation_started", { phase: "context_preload" });
    await driver.activateSend(sends[0]!.key, deadline.combined);
    this.#temporaryChatSurfaces.add(surface);
    emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_send_activated");
    let snapshot = await driver.waitForChange(prepared.revision, deadline.combined);
    let userTurnKey: string | undefined;
    phase = "acceptance";
    for (;;) {
      const newUsers = snapshot.turns.filter(turn => turn.role === "user" && !baselineTurnKeys.has(turn.key));
      if (newUsers.length > 1) {
        return {
          state: "ambiguous",
          candidates: Object.freeze(newUsers.map(turn => ({
            nativeTaskId: request.nativeTaskId,
            webEpochId: request.webEpochId,
            attachmentName: request.attachment.name,
            attachmentSha256: request.attachment.sha256,
            providerOperationId: turn.key,
          }))),
          evidence: evidence("multiple new user turns appeared after one inert context preload send"),
        };
      }
      if (newUsers.length === 1) {
        userTurnKey = newUsers[0]!.key;
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_user_turn_observed");
        break;
      }
      snapshot = await driver.waitForChange(snapshot.revision, deadline.combined);
    }

    phase = "receipt";
    for (;;) {
      let assistants = snapshot.turns.filter(turn => (
        turn.role === "assistant" && turn.parentUserTurnKey === userTurnKey
      ));
      if (assistants.length === 0) {
        const byParent = new Map<string, ChatGptTurnObservation[]>();
        for (const turn of snapshot.turns) {
          if (turn.role !== "assistant" || !turn.parentUserTurnKey || baselineLineage.has(turn.parentUserTurnKey)) continue;
          const values = byParent.get(turn.parentUserTurnKey) ?? [];
          values.push(turn);
          byParent.set(turn.parentUserTurnKey, values);
        }
        if (byParent.size > 1) {
          return {
            state: "ambiguous",
            candidates: Object.freeze([...byParent.entries()].map(([parent]) => ({
              nativeTaskId: request.nativeTaskId,
              webEpochId: request.webEpochId,
              attachmentName: request.attachment.name,
              attachmentSha256: request.attachment.sha256,
              providerOperationId: parent,
            }))),
            evidence: evidence("multiple assistant lineages appeared after the context preload"),
          };
        }
        if (byParent.size === 1) {
          const [parent, values] = byParent.entries().next().value!;
          userTurnKey = parent;
          assistants = values;
        }
      }
      if (assistants.length > 1) {
        return {
          state: "ambiguous",
          candidates: Object.freeze(assistants.map(assistant => ({
            nativeTaskId: request.nativeTaskId,
            webEpochId: request.webEpochId,
            attachmentName: request.attachment.name,
            attachmentSha256: request.attachment.sha256,
            providerOperationId: assistant.key,
          }))),
          evidence: evidence("multiple assistant descendants appeared after the context preload"),
        };
      }
      const assistant = assistants[0];
      if (assistant?.phase === "failed") {
        throw new Error("ChatGPT context attachment preload assistant failed");
      }
      if (assistant?.phase === "complete") {
        const result = Object.freeze({
          nativeTaskId: request.nativeTaskId,
          webEpochId: request.webEpochId,
          attachmentName: request.attachment.name,
          attachmentSha256: request.attachment.sha256,
          providerOperationId: userTurnKey,
        });
        if (assistant.plainBodyFingerprint !== fingerprint(stage.acknowledgement)) {
          // Capture at the owning surface before the caller retires this preload.
          // Routine evidence stays payload-free; private values require existing opt-in.
          await withDiagnosticContext({
            operation_fingerprint: diagnosticFingerprint([surface.taskId, surface.epochId].join("\n")),
          }, async () => {
            emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_receipt_mismatch", {
              assistant_chars: assistant.text?.length ?? 0,
              receipt_present: assistant.text?.includes(stage.acknowledgement) === true,
              parent_matches: assistant.parentUserTurnKey === userTurnKey,
              logical_anchor_present: assistant.lineageAnchor !== undefined,
              plain_body_observed: assistant.plainBodyFingerprint !== undefined,
              preload_ms: Math.max(0, Date.now() - startedAt),
            });
            capturePrivateDiagnosticValue("context_preload_failure", {
              expectedReceipt: stage.acknowledgement,
              assistantText: assistant.text ?? "",
              assistantPhase: assistant.phase,
              parentMatches: assistant.parentUserTurnKey === userTurnKey,
              assistantFingerprint: fingerprint(assistant.text ?? ""),
              plainBodyFingerprint: assistant.plainBodyFingerprint,
            });
            await captureBrowserDiagnosticEvidence(surface, "turn_failure");
          });
          return {
            state: "probable",
            value: result,
            evidence: evidence("context attachment assistant completed without the exact file-only receipt"),
          };
        }
        const finalComposer = exactComposer(snapshot);
        if (finalComposer.textLength !== 0
          || finalComposer.connectorFingerprints.length !== 0
          || composerAttachmentNames(finalComposer).length !== 0) {
          throw new Error("ChatGPT context preload completed but composer state was not fully cleared");
        }
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_preload_complete", {
          preload_ms: Math.max(0, Date.now() - startedAt),
          receipt_verified: true,
        });
        return {
          state: "proven",
          value: result,
          evidence: evidence("exact one-shot receipt proved memory-backed context file access"),
        };
      }
      try {
        snapshot = await driver.waitForChange(snapshot.revision, deadline.combined);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (deadline.timeout.aborted) {
          throw new Error("ChatGPT context attachment preload timed out before exact receipt verification", { cause: error });
        }
        throw error;
      }
    }
    } catch (error) {
      // Preserve the first cause before the caller releases the exact physical surface.
      await withDiagnosticContext({
        operation_fingerprint: diagnosticFingerprint([surface.taskId, surface.epochId].join("\n")),
      }, async () => {
        emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_preload_failed", {
          phase, preload_ms: Math.max(0, Date.now() - startedAt),
          reason_class: signal?.aborted ? "owner_cancelled" : deadline.timeout.aborted ? "deadline" : "preload_boundary_failed",
        });
        capturePrivateDiagnosticValue("context_preload_failure", {
          phase, errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: error instanceof Error ? error.message : undefined,
        });
        await captureBrowserDiagnosticEvidence(surface, "turn_failure");
      });
      throw error;
    }
  }

  async submitTurn(
    surface: BrowserSurfaceLease,
    request: WebTurnRequest,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnHandle>> {
    if (request.chatTools && request.toolBridge) throw Error("Web tools must select one backend");
    const usesConnector = !!(request.chatTools || request.toolBridge);
    if (request.inertSourceAttachment && (usesConnector || request.contextAttachment || request.physicalContext.mode === "retained-delta")) {
      throw Error("inert source requires an isolated tool-free non-preloaded submission");
    }
    const sourceUpload = request.inertSourceAttachment
      ? formatInertSourceAttachment(request.inertSourceAttachment.attachment, request.inertSourceAttachment.receipt) : undefined;
    const driver = driverFor(surface);
    const hydrated = await waitForHydratedComposer(driver, signal);
    const settled = await waitForSettledEmptyComposer(driver, hydrated.snapshot, signal);
    const baseline = settled.snapshot;
    this.#assertTemporaryChatSurface(surface, baseline);
    if (request.physicalContext.mode === "retained-delta") this.#assertRetainedConversation(surface, baseline);
    let composer = exactComposer(baseline);
    if (composer.textLength !== 0) {
      throw new Error("ChatGPT semantic submit refuses to overwrite a non-empty composer draft");
    }
    if (composerAttachmentNames(composer).length !== 0) {
      throw new Error("ChatGPT semantic submit refuses a retained composer attachment");
    }
    const connectorName = this.#connectorName;
    const expectedConnectorFingerprint = connectorName ? fingerprint(connectorName) : undefined;
    if (!usesConnector && composer.connectorFingerprints.length !== 0) {
      throw new Error("tool-free ChatGPT semantic submit refuses a selected connector");
    }
    if (usesConnector && !connectorName) {
      throw new Error("ChatGPT tool bridge requires an explicit connector identity");
    }
    let cleanupAttempted = false;
    let sendActivationAttempted = false;
    const cleanupPreparedComposer = async (): Promise<void> => {
      if (cleanupAttempted) return;
      cleanupAttempted = true;
      await restoreEmptyComposer(driver, composer.key);
    };
    const probableBeforeSend = async (
      revision: string,
      detail: string,
    ): Promise<SemanticObservation<WebTurnHandle>> => {
      await cleanupPreparedComposer();
      return {
        state: "probable",
        value: {
          nativeTaskId: request.nativeTaskId,
          nativeTurnId: request.nativeTurnId,
          webEpochId: request.webEpochId,
          providerTurnId: `unaccepted:${revision}`,
        },
        evidence: evidence(detail),
      };
    };

    let filled: ChatGptSurfaceSnapshot;
    let baselineTurnKeys: Set<string>;
    let preSubmitUserLineageKeys: ReadonlySet<string>;
    const upload = prepareWebTurnMedia(request.physicalContext, request.media ?? []);
    const files = [...(sourceUpload ? [sourceUpload.file] : []), ...upload.files];
    if (new Set(files.map(file => file.name)).size !== files.length) throw Error("source and media attachments have duplicate names");
    const formatted = formatWebPhysicalContextParts(request.physicalContext, request.toolBridge, request.contextAttachment, request.media, request.chatTools);
    const text = formatted.text;
    const seenSources = new Set<string>();
    let sourceBytes = 0, duplicateSourceBytes = 0, duplicateSourceCount = 0;
    for (const segment of request.physicalContext.segments) {
      const bytes = Buffer.byteLength(segment.content);
      sourceBytes += bytes;
      if (seenSources.has(segment.content)) { duplicateSourceBytes += bytes; duplicateSourceCount++; }
      else seenSources.add(segment.content);
    }
    const activeRevision = request.physicalContext.segments.find(segment => segment.type === "revision"
      && segment.revisionId === request.physicalContext.activeRequestRevisionId);
    emitDiagnosticEvent("chatgpt_tela_work", "browser_message_prepared", {
      operation_fingerprint: diagnosticFingerprint([request.nativeTaskId, request.nativeTurnId,
        request.webEpochId].join("\n")),
      context_mode: request.physicalContext.mode,
      epoch_fingerprint: diagnosticFingerprint(request.webEpochId),
      message_fingerprint: diagnosticFingerprint(fingerprint(text)),
      ...(activeRevision?.type === "revision" ? {
        active_revision_fingerprint: diagnosticFingerprint(activeRevision.revisionId),
        active_input_fingerprint: diagnosticFingerprint(fingerprint(activeRevision.content)),
        request_role: activeRevision.kind,
      } : {}),
      kind: sourceUpload ? "source_file" : request.contextAttachment ? "preloaded_reference" : "inline",
      source_segment_count: request.physicalContext.segments.length,
      duplicate_source_segment_count: duplicateSourceCount,
      source_bytes: sourceBytes,
      duplicate_source_bytes: duplicateSourceBytes,
      message_chars: text.length,
      composer_wire_bytes: formatted.composerBytes, context_wire_bytes: formatted.contextBytes,
      protocol_wire_bytes: formatted.protocolBytes,
      source_file_bytes: sourceUpload?.file.bytes.byteLength ?? 0,
      media_file_bytes: upload.statistics.uniqueBytes,
      attachment_count: files.length,
      logical_estimate: request.physicalContext.logicalTokens,
      transfer_estimate: request.physicalContext.transferTokens,
    });
    const expectedFingerprint = fingerprint(text);
    const inputOwner = surface.capability(BROWSER_INPUT_OWNERSHIP);
    const documentLifetime = surface.capability(BROWSER_DOCUMENT_LIFETIME);
    const diagnosticBoundary: NonNullable<TurnOwnership["diagnosticBoundary"]> = () => {
      const document = documentLifetime?.current();
      const input = inputOwner?.current();
      const observation = inputOwner?.observationCurrent?.();
      return {
        documentGeneration: document?.generation ?? -1,
        documentRevoked: document?.signal.aborted ?? false,
        inputRevision: input?.revision ?? -1,
        inputAvailable: input?.available ?? false,
        inputRevoked: input?.signal.aborted ?? false,
        observationRevision: observation?.revision ?? -1,
        observationPending: observation?.pending ?? false,
        observationSource: observation ? "inspection_input" : "unavailable",
      };
    };
    // Capture before consequential input, never infer exclusivity from missing support.
    const inputBaseline = inputOwner?.current();
    const observationBaseline = inputOwner?.observationCurrent?.();
    const observationInputState = observationBaseline?.available && !observationBaseline.pending
      ? (): "unchanged" | "pending" | "changed" => {
        const now = inputOwner!.observationCurrent!();
        if (!now.available || now.revision !== observationBaseline.revision) return "changed";
        return now.pending ? "pending" : "unchanged";
      } : undefined;
    const inputUnchanged = inputBaseline?.available && inputBaseline.signal && !inputBaseline.signal.aborted && Number.isSafeInteger(inputBaseline.revision)
      ? () => {
        const now = inputOwner!.current();
        return now.available && now.revision === inputBaseline.revision && !inputBaseline.signal.aborted;
      } : undefined;
    const assertCausalInputUnchanged = inputUnchanged
      ? () => {
        if (!inputUnchanged()) {
          const now = inputOwner!.current();
          emitDiagnosticEvent("chatgpt_tela_work", "web_submission_input_revoked", {
            host_available: now.available, revision_matches: now.revision === inputBaseline!.revision,
            input_aborted: inputBaseline!.signal.aborted,
          });
          throw new WebSubmissionUnproven("author_payload_unavailable");
        }
      } : undefined;
    if (assertCausalInputUnchanged) signal = signal
      ? AbortSignal.any([signal, inputBaseline!.signal]) : inputBaseline!.signal;
    try {
      let preparedBaseline = baseline;
      if (usesConnector) {
        const selected = composer.connectorFingerprints;
        if (selected.length > 1) throw new Error("ChatGPT composer has multiple selected connectors");
        if (selected.length === 1 && selected[0] !== expectedConnectorFingerprint) {
          throw new Error("ChatGPT composer has a different selected connector");
        }
        if (selected.length === 0) {
          await driver.selectConnector(composer.key, connectorName!, signal);
          preparedBaseline = await driver.observe(signal);
          composer = exactComposer(preparedBaseline);
        }
        if (composer.textLength !== 0
          || composer.connectorFingerprints.length !== 1
          || composer.connectorFingerprints[0] !== expectedConnectorFingerprint) {
          throw new Error("ChatGPT connector selection was not structurally proven");
        }
      }
      const baselineSends = visibleSends(preparedBaseline, composer.key);
      if (baselineSends.length > 1) {
        throw new Error(`ChatGPT semantic surface requires at most one baseline send control; observed ${baselineSends.length}`);
      }
      const baselineSendKey = baselineSends[0]?.key;
      baselineTurnKeys = new Set(preparedBaseline.turns.map(turn => turn.key));
      preSubmitUserLineageKeys = baselineUserLineageKeys(preparedBaseline);

      if (usesConnector) {
        await driver.appendComposerText(composer.key, ` ${text}`, signal);
      } else {
        await driver.replaceComposerText(composer.key, text, signal);
      }
      const settle = timeoutSignal(signal, CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS);
      filled = await driver.observe(settle.combined);
      let sendAfterFill: ReturnType<typeof exactSend> | undefined;
      for (;;) {
        const filledComposers = readyComposers(filled);
        if (filledComposers.length > 1) {
          throw new Error(`ChatGPT semantic surface requires exactly one ready composer after fill; observed ${filledComposers.length}`);
        }
        const filledComposer = filledComposers.length === 1 ? filledComposers[0]! : undefined;
        const exactReadback = filledComposer?.key === composer.key
          && filledComposer.textFingerprint === expectedFingerprint
          && filledComposer.textLength === text.length;
        const connectorPreserved = !usesConnector
          || (filledComposer?.connectorFingerprints.length === 1
            && filledComposer.connectorFingerprints[0] === expectedConnectorFingerprint);
        if (filledComposer?.key === composer.key && filledComposer.textLength > 0 && !exactReadback) {
          return await probableBeforeSend(
            filled.revision,
            "composer readback did not prove the exact prepared payload",
          );
        }
        if (exactReadback && !connectorPreserved) {
          throw new Error("ChatGPT connector selection was lost while attaching the exact payload");
        }
        const sendsAfterFill = exactReadback && connectorPreserved ? visibleSends(filled, composer.key) : [];
        if (sendsAfterFill.length > 1) {
          throw new Error(`ChatGPT semantic surface requires exactly one send control after fill; observed ${sendsAfterFill.length}`);
        }
        if (exactReadback && sendsAfterFill.length === 1 && sendsAfterFill[0]!.enabled) {
          sendAfterFill = sendsAfterFill[0]!;
          break;
        }
        try {
          filled = await driver.waitForChange(filled.revision, settle.combined);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (settle.timeout.aborted) {
            return await probableBeforeSend(
              filled.revision,
              exactReadback
                ? "send control was not uniquely enabled after exact composer readback before submit deadline"
                : "composer readback did not prove the exact prepared payload before submit deadline",
            );
          }
          throw error;
        }
      }
      if (baselineSendKey && sendAfterFill.key !== baselineSendKey) {
        return await probableBeforeSend(
          filled.revision,
          "send control identity changed after exact composer readback",
        );
      }
      if (files.length) {
        if (!driver.attachFiles) throw new Error("ChatGPT surface lacks a verified media upload adapter");
        const imageCount = files.filter(file => file.mimeType.startsWith("image/")).length;
        emitDiagnosticEvent("chatgpt_tela_work", "web_media_upload_started", {
          file_count: files.length,
          image_count: imageCount,
          other_file_count: files.length - imageCount,
          evidence_count: upload.statistics.logicalReferences,
          total_bytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
        });
        try {
          await driver.attachFiles(composer.key, files, signal);
        } catch (error) {
          emitDiagnosticEvent("chatgpt_tela_work", "web_media_upload_failed", {
            phase: "attach_files",
            image_count: imageCount,
            other_file_count: files.length - imageCount,
            aborted: signal?.aborted === true,
            error_kind: error instanceof Error ? error.name : "unknown",
          });
          throw error;
        }
        filled = await driver.observe(signal);
        const verified = filled.composers.find(c => c.key === composer.key);
        const send = visibleSends(filled, composer.key);
        if (!verified || verified.textLength !== text.length
          || verified.textFingerprint !== expectedFingerprint
          || verified.attachmentNames.length === 0
          || (usesConnector && (verified.connectorFingerprints.length !== 1
            || verified.connectorFingerprints[0] !== expectedConnectorFingerprint))
          || send.length !== 1 || !send[0]!.enabled || send[0]!.key !== sendAfterFill.key) {
          throw new Error("ChatGPT Web media upload lost exact composer, connector, or send ownership");
        }
        emitDiagnosticEvent("chatgpt_tela_work", "web_media_composer_accepted", {
          file_count: files.length,
          image_count: imageCount,
          evidence_count: upload.statistics.logicalReferences,
          // Composer observation is not a server receipt or proof of content understanding.
          proof_scope: "composer_attachment_surface_only",
        });
      }

      // From this point activation itself may have submitted the message. Mark the boundary before
      // calling the driver so an exception can never authorize cleanup or implicit retry.
      signal?.throwIfAborted();
      this.#assertTemporaryChatSurface(surface, filled);
      if (request.physicalContext.mode === "retained-delta") this.#assertRetainedConversation(surface, filled);
      await captureBrowserDiagnosticCheckpoint(surface, "before_submit");
      signal?.throwIfAborted();
      assertCausalInputUnchanged?.();
      const bridgeComposer = filled.composers.find(item => item.key === composer.key);
      emitDiagnosticEvent("chatgpt_tela_work", "web_tool_bridge_prepared", {
        bridge_attached: !!request.toolBridge,
        tool_backend: request.chatTools ? "tela-chat" : request.toolBridge ? "legacy-native" : "none",
        connector_count: bridgeComposer?.connectorFingerprints.length ?? 0,
        expected_connector_present: !!expectedConnectorFingerprint && bridgeComposer?.connectorFingerprints.includes(expectedConnectorFingerprint) === true,
        context_header_attached: !!request.toolBridge,
        remote_tool_visibility_observed: false,
      });
      sendActivationAttempted = true;
      emitDiagnosticEvent("chatgpt_tela_work", "web_send_activation_started", { phase: "turn", composer_wire_bytes:formatted.composerBytes,
        context_wire_bytes:formatted.contextBytes,protocol_wire_bytes:formatted.protocolBytes });
      await driver.activateSend(sendAfterFill.key, signal);
      emitDiagnosticEvent("chatgpt_tela_work", "web_send_activation_settled", { phase: "turn", remote_terminal_proven: false });
      this.#temporaryChatSurfaces.add(surface);
    } catch (error) {
      if (!sendActivationAttempted && !cleanupAttempted) {
        try {
          await cleanupPreparedComposer();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "ChatGPT pre-submit preparation failed and composer cleanup was incomplete",
          );
        }
      }
      throw error;
    }

    // Send activation may already have succeeded. Bound only the local receipt
    // observation; expiry cannot authorize another send or adopt an unbound answer.
    const acceptance = timeoutSignal(signal, CHATGPT_READINESS_TIMEOUT_MS);
    let snapshot = filled;
    let acceptancePendingRecorded = false;
    let firstProofReason: WebSubmissionProofReason | undefined;
    let lastWitness = "", witnessCount = 0;
    let pendingCausalUser: ChatGptTurnObservation | undefined;
    try {
      snapshot = await driver.waitForChange(filled.revision, acceptance.combined);
      for (;;) {
        assertCausalInputUnchanged?.();
        let newUserTurns = snapshot.turns.filter(turn => (
          turn.role === "user" && !baselineTurnKeys.has(turn.key)
        ));
        const renderedNewUserCount = newUserTurns.length;
        // Virtualization may unmount the user before its paired assistant mounts.
        // Carry evidence, never authority: only the same unique logical parent may
        // finish this receipt, under the unchanged host input boundary.
        if (pendingCausalUser && newUserTurns.some(turn => turn.lineageAnchor !== pendingCausalUser!.lineageAnchor)) {
          throw new WebSubmissionUnproven("author_payload_unavailable");
        }
        if (!newUserTurns.length && pendingCausalUser && snapshot.turns.some(turn => turn.role === "assistant"
          && turn.parentUserTurnKey === pendingCausalUser!.key && turn.lineageAnchor === pendingCausalUser!.lineageAnchor)) {
          newUserTurns = [pendingCausalUser];
        }
        const candidate = newUserTurns.length === 1 ? newUserTurns[0] : undefined;
        const observedFingerprint = authorFingerprint(candidate, expectedFingerprint);
        const beforeRoute = new URL(filled.url), afterRoute = new URL(snapshot.url);
        const sameRoute = beforeRoute.origin + beforeRoute.pathname === afterRoute.origin + afterRoute.pathname;
        const canonicalHydration = beforeRoute.origin === afterRoute.origin
          && (beforeRoute.pathname === "/" || isChatGptProvisionalConversationUrl(filled.url))
          && /^\/c\/[^/]+$/.test(afterRoute.pathname)
          && (!isChatGptProvisionalConversationUrl(snapshot.url) || beforeRoute.pathname === "/");
        const pairedAssistants = candidate ? snapshot.turns.filter(turn => turn.role === "assistant"
          && turn.parentUserTurnKey === candidate.key) : [];
        const newAssistantParents = new Set(snapshot.turns.flatMap(turn => turn.role === "assistant"
          && turn.parentUserTurnKey && !preSubmitUserLineageKeys.has(turn.parentUserTurnKey) ? [turn.parentUserTurnKey] : []));
        const composerConsumed = snapshot.composers.filter(item => item.key === composer.key).length === 1
          && snapshot.composers.find(item => item.key === composer.key)!.textLength === 0;
        // Causality is independent of whether the initial renderer happens to expose
        // the body. Preserve the stronger host fence for readable submissions too;
        // a later preview expansion cannot replace the submitted composer identity.
        const causalReceipt = !!assertCausalInputUnchanged
          && !!candidate?.lineageAnchor && !filled.turns.some(turn => turn.lineageAnchor === candidate.lineageAnchor)
          && composerConsumed && (sameRoute || canonicalHydration) && pairedAssistants.length === 1
          && newAssistantParents.size === 1
          && pairedAssistants[0]!.lineageAnchor === candidate.lineageAnchor;
        if (causalReceipt) assertCausalInputUnchanged!();
        if (candidate?.lineageAnchor && assertCausalInputUnchanged && composerConsumed
          && !filled.turns.some(turn => turn.lineageAnchor === candidate.lineageAnchor) && (sameRoute || canonicalHydration)) {
          pendingCausalUser = candidate;
        }
        const reason = candidate ? acceptanceProofReason(candidate.userPayloadReason) : "new_author_unavailable";
        const fields = { reason_class: reason, user_count: renderedNewUserCount,
          carried_user_witness: renderedNewUserCount === 0 && newUserTurns.length === 1,
          logical_anchor_present: candidate?.lineageAnchor !== undefined,
          expected_payload_matches: authorFingerprint(candidate, expectedFingerprint) === expectedFingerprint,
          causal_receipt: causalReceipt, composer_consumed: composerConsumed,
          input_boundary_available: assertCausalInputUnchanged !== undefined,
          paired_assistant_count: pairedAssistants.length,
          paired_anchor_matches: !!candidate?.lineageAnchor && pairedAssistants.length === 1
            && pairedAssistants[0]!.lineageAnchor === candidate.lineageAnchor,
          route_matches: new URL(snapshot.url).origin + new URL(snapshot.url).pathname === new URL(filled.url).origin + new URL(filled.url).pathname,
          ...acceptanceStructure(candidate) };
        const witness = JSON.stringify(fields);
        if (lastWitness !== witness && witnessCount < 16) {
          lastWitness = witness; witnessCount++;
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_acceptance_observed", { ...fields, witness_count: witnessCount });
        }
        if (newUserTurns.length > 1) {
          return {
            state: "ambiguous",
            candidates: Object.freeze(newUserTurns.map(turn => ({
              nativeTaskId: request.nativeTaskId,
              nativeTurnId: request.nativeTurnId,
              webEpochId: request.webEpochId,
              providerTurnId: turn.key,
            }))),
            evidence: evidence("multiple new user turns appeared after one exact send activation"),
          };
        }
        if (newUserTurns.length === 1 && (observedFingerprint !== undefined || causalReceipt)) {
          const userTurn = newUserTurns[0]!;
          const acceptedFingerprint = causalReceipt ? expectedFingerprint : observedFingerprint!;
          const handle = Object.freeze({
            nativeTaskId: request.nativeTaskId,
            nativeTurnId: request.nativeTurnId,
            webEpochId: request.webEpochId,
            providerTurnId: userTurn.key,
          });
          acceptance.combined.throwIfAborted();
          await captureBrowserDiagnosticCheckpoint(surface, "turn_accepted");
          if (causalReceipt) assertCausalInputUnchanged!();
          const acceptedBoundary = diagnosticBoundary();
          const leaseFingerprint = diagnosticFingerprint(surface.leaseId);
          this.#turns.set(surface, {
            handle,
            surfaceLeaseId: surface.leaseId,
            deliveryWaitTimeoutMs: this.#deliveryWaitTimeoutMs,
            ...(request.isToolExecutionPending ? { isToolExecutionPending: request.isToolExecutionPending } : {}),
            userTurnKey: userTurn.key,
            acceptedUserFingerprint: acceptedFingerprint,
            ...(inputUnchanged ? { inputUnchanged } : {}),
            ...(observationInputState ? { observationInputState } : {}),
            diagnosticBoundary,
            diagnosticLeaseFingerprint: leaseFingerprint,
            acceptedDocumentGeneration: acceptedBoundary.documentGeneration,
            acceptedInputRevision: acceptedBoundary.inputRevision,
            acceptedObservationRevision: acceptedBoundary.observationRevision,
            acceptedObservationSource: acceptedBoundary.observationSource,
            acceptedUserCharacters: text.length,
            diagnosticLineage: {
              operation_fingerprint: diagnosticFingerprint([request.nativeTaskId, request.nativeTurnId, request.webEpochId].join("\n")),
              native_task_fingerprint: diagnosticFingerprint(request.nativeTaskId),
              native_turn_fingerprint: diagnosticFingerprint(request.nativeTurnId),
              web_epoch_fingerprint: diagnosticFingerprint(request.webEpochId),
              request_lineage_fingerprint: diagnosticFingerprint([request.nativeTaskId, request.nativeTurnId,
                request.webEpochId, request.physicalContext.activeRequestRevisionId ?? "unavailable"].join("\n")),
              ...(request.physicalContext.activeRequestRevisionId
                ? { active_request_revision_fingerprint: diagnosticFingerprint(request.physicalContext.activeRequestRevisionId) } : {}),
              head_revision_fingerprint: diagnosticFingerprint(request.physicalContext.headRevisionId),
              ...(request.physicalContext.baseRevisionId
                ? { base_revision_fingerprint: diagnosticFingerprint(request.physicalContext.baseRevisionId) } : {}),
              context_mode: request.physicalContext.mode,
            },
            ...(causalReceipt ? { causalReceipt: true } : {}),
            ...(userTurn.lineageAnchor ? { acceptedLineageAnchor: userTurn.lineageAnchor } : {}),
            conversationRoute: new URL(snapshot.url).origin + new URL(snapshot.url).pathname,
            baselineUserLineageKeys: preSubmitUserLineageKeys,
            revision: snapshot.revision,
            observeAgain: true,
            ...(filled.approval?.cardCount === 1 && typeof filled.approval.revisionFingerprint === "string"
              ? { preSubmitApprovalRevision: filled.approval.revisionFingerprint } : {}),
            approvalObservation: new ChatGptApprovalObservation(),
            operationAbort: new AbortController(),
          });
          const acceptedRoute = new URL(snapshot.url);
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_accepted", {
            operation_fingerprint: diagnosticFingerprint([request.nativeTaskId, request.nativeTurnId,
              request.webEpochId].join("\n")),
            lease_fingerprint: leaseFingerprint,
            accepted_document_generation: acceptedBoundary.documentGeneration,
            document_generation: acceptedBoundary.documentGeneration,
            document_revoked: acceptedBoundary.documentRevoked,
            accepted_input_revision: acceptedBoundary.inputRevision,
            input_revision: acceptedBoundary.inputRevision,
            input_available: acceptedBoundary.inputAvailable,
            input_revoked: acceptedBoundary.inputRevoked,
            accepted_observation_revision: acceptedBoundary.observationRevision,
            observation_revision: acceptedBoundary.observationRevision,
            observation_pending: acceptedBoundary.observationPending,
            observation_source: acceptedBoundary.observationSource,
            route_kind: acceptedRoute.pathname === "/" ? "initial"
              : isChatGptProvisionalConversationUrl(snapshot.url) ? "provisional"
              : /^\/c\/[^/]+$/.test(acceptedRoute.pathname) ? "conversation" : "other",
            user_count: snapshot.turns.filter(turn => turn.role === "user").length,
            baseline_lineage_count: preSubmitUserLineageKeys.size,
            preexisting_approval_card_count: filled.approval?.cardCount ?? 0,
            accepted_fingerprint_matches: observedFingerprint === expectedFingerprint,
            causal_receipt: causalReceipt,
            logical_anchor_present: userTurn.lineageAnchor !== undefined,
            ...acceptanceStructure(userTurn),
          });
          return {
            state: "proven",
            value: handle,
            evidence: evidence(
              causalReceipt ? "exact composer and one send consumed into a unique new logical user and assistant under unchanged owned input"
              : acceptedFingerprint === expectedFingerprint
                ? "one new stable user turn acknowledges the exact submitted payload fingerprint"
                : "one new stable user turn acknowledges the exact pre-send composer readback and send activation",
            ),
          };
        }
        if (newUserTurns.length === 1 && !acceptancePendingRecorded) {
          acceptancePendingRecorded = true;
          firstProofReason = acceptanceProofReason(newUserTurns[0]!.userPayloadReason);
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_acceptance_pending", {
            reason_class: acceptanceProofReason(newUserTurns[0]!.userPayloadReason), user_count: 1,
            ...acceptanceStructure(newUserTurns[0]),
            logical_anchor_present: newUserTurns[0]!.lineageAnchor !== undefined,
          });
        }
        snapshot = await driver.waitForChange(snapshot.revision, acceptance.combined);
      }
    } catch (error) {
      if (signal?.aborted || !acceptance.timeout.aborted) throw error;
      const users = snapshot.turns.filter(turn => turn.role === "user" && !baselineTurnKeys.has(turn.key));
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_acceptance_timeout", {
        reason_class: users.length === 1 ? acceptanceProofReason(users[0]!.userPayloadReason) : "new_author_unavailable",
        ...(firstProofReason ? { first_reason_class: firstProofReason } : {}),
        witness_count: witnessCount,
        user_count: users.length, accepted: false, remote_terminal_proven: false,
        ...acceptanceStructure(users.length === 1 ? users[0] : undefined),
        assistant_complete_observed: snapshot.turns.some(turn => turn.role === "assistant" && turn.phase === "complete"),
      });
      throw new WebSubmissionUnproven(firstProofReason ?? (users.length === 1
        ? acceptanceProofReason(users[0]!.userPayloadReason) : "new_author_unavailable"));
    }
  }

  async observeTurn(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnState>> {
    signal?.throwIfAborted();
    const tracked = this.#tracked(surface, turn);
    signal = AbortSignal.any([...(signal ? [signal] : []), tracked.operationAbort.signal]);
    const snapshot = await waitOwned(signal, () => driverFor(surface).observe(signal));
    signal.throwIfAborted();
    this.#tracked(surface, turn);
    tracked.revision = snapshot.revision;
    const state = stateFromSnapshot(snapshot, tracked);
    if (tracked.identityPending) await recordDeferredCompletion(surface, tracked, snapshot, "identity_pending");
    if (!tracked.identityPending) {
      const assistants = assistantFor(snapshot, tracked.userTurnKey);
      this.#observeApproval(surface, tracked, snapshot, assistants.length === 1 ? assistants[0] : undefined);
    }
    emitDiagnosticEvent("chatgpt_tela_work", "web_semantic_state_observed", {
      ...turnObservationFields(snapshot, tracked), state: state.state,
      ...(state.state === "proven" ? { phase: state.value.phase } : {}),
    });
    return state;
  }

  async armToolContinuation(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    callId: string,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebToolContinuationBoundary>> {
    if (!callId.trim()) throw new Error("Web tool continuation call id must be non-empty");
    const tracked = this.#tracked(surface, turn);
    signal = AbortSignal.any([...(signal ? [signal] : []), tracked.operationAbort.signal]);
    const { snapshot, lineage } = await waitOwned(signal, () => waitForLineage(surface, driverFor(surface), tracked, signal));
    signal?.throwIfAborted();
    this.#tracked(surface, turn);
    const assistants = lineage.assistants;
    if (lineage.ambiguous) {
      return {
        state: "ambiguous",
        candidates: Object.freeze(assistants.map(() => ({
          providerTurnId: tracked.handle.providerTurnId,
          callId,
        }))),
        evidence: evidence("multiple new assistant lineages exist at the exact tool-result boundary"),
      };
    }
    if (assistants.length > 1) {
      return {
        state: "ambiguous",
        candidates: Object.freeze(assistants.map(() => ({
          providerTurnId: tracked.handle.providerTurnId,
          callId,
        }))),
        evidence: evidence("multiple assistant descendants exist at the exact tool-result boundary"),
      };
    }
    const assistant = assistants[0];
    this.#observeApproval(surface, tracked, snapshot, assistant);
    const phase = assistantLifecyclePhase(snapshot, tracked, assistant);
    if (phase === "completed" || phase === "failed") {
      emitDiagnosticEvent("chatgpt_tela_work", "web_tool_handoff_rejected", {
        ...turnObservationFields(snapshot, tracked), assistant_phase: assistant!.phase!,
        reason_class: phase === "failed" ? "assistant_failed" : "assistant_completed",
      });
      return {
        state: "probable",
        value: { providerTurnId: tracked.handle.providerTurnId, callId },
        evidence: evidence(`assistant was already ${assistant!.phase} before MCP result handoff`),
      };
    }
    tracked.revision = snapshot.revision;
    tracked.continuationBoundary = {
      callId,
      assistantFingerprint: assistantFingerprint(assistant),
    };
    if ((tracked.diagnosticBoundaryCount ?? 0) < 16) {
      tracked.diagnosticBoundaryCount = (tracked.diagnosticBoundaryCount ?? 0) + 1;
      emitDiagnosticEvent("chatgpt_tela_work", "web_tool_continuation_armed", {
        ...turnObservationFields(snapshot, tracked), assistant_phase: assistant?.phase ?? "absent",
        ...(tracked.approvalObservation.phase ? { phase: tracked.approvalObservation.phase } : {}),
        ...(tracked.approvalObservation.cardFingerprint ? { card_fingerprint: tracked.approvalObservation.cardFingerprint } : {}),
        // A returned Native result is evidence, not proof that a particular approval was accepted.
        tool_result_observed: true,
      });
    }
    return {
      state: "proven",
      value: { providerTurnId: tracked.handle.providerTurnId, callId },
      evidence: evidence("captured exact assistant state before MCP result handoff"),
    };
  }

  inspectApprovalWait(surface: BrowserSurfaceLease): WebApprovalWaitProjection | undefined {
    const tracked = this.#turns.get(surface);
    if (!tracked || tracked.surfaceLeaseId !== surface.leaseId) return;
    const elapsedMs = tracked.approvalObservation.pendingElapsedMs(Date.now());
    const phase = tracked.approvalObservation.phase;
    if (elapsedMs === undefined || phase === undefined) return;
    return Object.freeze({ phase, elapsedMs,
      unverifiedDispatchCount: tracked.approvalObservation.unverifiedDispatchCount,
      operationState: tracked.operationAbort.signal.aborted || tracked.retirement ? "stopping" : "waiting" });
  }

  #retireTurn(surface: BrowserSurfaceLease, tracked: TrackedTurn): void {
    if (this.#turns.get(surface) === tracked) this.#turns.delete(surface);
  }

  #observeApproval(surface: BrowserSurfaceLease, tracked: TrackedTurn, snapshot: ChatGptSurfaceSnapshot,
    assistant: ChatGptTurnObservation | undefined): void {
    logApprovalTransition(tracked.approvalObservation.recordInputReceipt(snapshot.approvalInputReceipt, Date.now()));
    const transition = tracked.approvalObservation.observe(pendingApproval(snapshot, tracked), approvalAssistantVersion(assistant),
      assistant !== undefined && assistant.phase !== "failed", Date.now());
    logApprovalTransition(transition);
  }

  async cancelTurn(surface: BrowserSurfaceLease, turn: WebTurnHandle): Promise<void> {
    const tracked = this.#turns.get(surface);
    if (!tracked) return; // Already retired by expiry or a completed observation.
    this.#tracked(surface, turn, true);
    if (tracked.retirement) return tracked.retirement;
    // Fence first. Late approval preparation/observation cannot regain this operation.
    tracked.operationAbort.abort(new Error("Owned Web operation retired"));
    tracked.retirement = this.#stopOwnedTurn(surface, tracked);
    return tracked.retirement;
  }

  async #stopOwnedTurn(surface: BrowserSurfaceLease, tracked: TrackedTurn): Promise<void> {
    const driver = driverFor(surface);
    const timeout = AbortSignal.timeout(5_000);
    let status = "unavailable";
    try {
      if (driver.stopGeneration) {
        const stopped = (async () => {
          const snapshot = await driver.observe(timeout);
          timeout.throwIfAborted();
          // Reuse accepted-request ownership proof. Stable renderer keys alone cannot authorize Stop.
          const lineage = resolveAssistantLineage(snapshot, tracked);
          const users = snapshot.turns.filter(item => item.role === "user" && item.key === tracked.userTurnKey);
          if (lineage.identityPending || lineage.ambiguous || lineage.assistants.length !== 1 || users.length !== 1) {
            return { status: "ownership_changed" as const };
          }
          const userFingerprint = users[0]!.contentFingerprint;
          if (!userFingerprint) return { status: "unavailable" as const };
          return driver.stopGeneration!({ assistantKey: lineage.assistants[0]!.key,
            userTurnKey: tracked.userTurnKey, userFingerprint }, timeout);
        })();
        const deadline = new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }));
        status = (await Promise.race([stopped, deadline])).status;
      }
    } catch (error) {
      status = error && typeof error === "object" && "code" in error && error.code === "tela_web_observation_unproven"
        ? "ownership_changed" : "unconfirmed";
    }
    emitDiagnosticEvent("chatgpt_tela_work", "web_owned_stop", { status, remote_outcome: "uncertain" });
    this.#retireTurn(surface, tracked);
  }

  async waitForTurnEvent(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnEvent>> {
    signal?.throwIfAborted();
    const tracked = this.#tracked(surface, turn);
    signal = AbortSignal.any([...(signal ? [signal] : []), tracked.operationAbort.signal]);
    const driver = driverFor(surface);

    if (tracked.pendingCompletedAnswer !== undefined) {
      const { snapshot } = await waitOwned(signal, () => waitForLineage(surface, driver, tracked, signal));
      signal.throwIfAborted();
      this.#tracked(surface, turn);
      const ownership = resolveAssistantLineage(snapshot, tracked);
      if (ownership.ambiguous || ownership.assistants.length !== 1) {
        throw new Error("ChatGPT pending completion no longer has one proven assistant identity");
      }
      this.#observeApproval(surface, tracked, snapshot, ownership.assistants[0]);
      const answer = tracked.pendingCompletedAnswer;
      delete tracked.pendingCompletedAnswer;
      // A new approval can render after completion controls. It still blocks final delivery.
      if (assistantLifecyclePhase(snapshot, tracked, ownership.assistants[0]) === "failed") {
        signal?.throwIfAborted();
        observeProviderFailure(ownership.assistants[0]!.failureDetail);
        this.#retireTurn(surface, tracked);
        return { state: "proven", value: { kind: "failed", providerTurnId: tracked.handle.providerTurnId,
          detail: ownership.assistants[0]!.failureDetail ?? "ChatGPT turn failed" },
          evidence: evidence("assistant failure superseded pending completion") };
      }
      if (!pendingApproval(snapshot, tracked)?.cardCount) {
        signal?.throwIfAborted();
        this.#retireTurn(surface, tracked);
        reportWebFinalObserved(tracked);
        return {
          state: "proven",
          value: { kind: "completed", providerTurnId: tracked.handle.providerTurnId, ...answer },
          evidence: evidence("assistant completion followed a proven post-tool continuation boundary"),
        };
      }
      await recordDeferredCompletion(surface, tracked, snapshot, "approval_pending");
    }

    for (;;) {
      const snapshot = await waitOwned(signal, () => tracked.observeAgain
        ? driver.observe(signal) : waitForDeliveryChange(driver, tracked, tracked.revision, signal));
      signal?.throwIfAborted();
      this.#tracked(surface, turn);
      tracked.observeAgain = false;
      tracked.revision = snapshot.revision;
      tracked.waitSnapshotCount = Math.min((tracked.waitSnapshotCount ?? 0) + 1, Number.MAX_SAFE_INTEGER);
      tracked.lastWaitSnapshotAt = Date.now();
      const lineage = deliveryLineage(snapshot, tracked);
      if (lineage.identityPending) {
        await recordDeferredCompletion(surface, tracked, snapshot, "identity_pending");
        continue;
      }
      const assistants = lineage.assistants;
      if (lineage.ambiguous || assistants.length > 1) {
        await recordDeferredCompletion(surface, tracked, snapshot, "multiple_assistants");
      }
      if (lineage.ambiguous) {
        return {
          state: "ambiguous",
          candidates: Object.freeze(assistants.map(() => ({
            kind: "continuing" as const,
            providerTurnId: tracked.handle.providerTurnId,
          }))),
          evidence: evidence("multiple new assistant lineages appeared after one accepted ChatGPT turn"),
        };
      }
      if (assistants.length > 1) {
        return {
          state: "ambiguous",
          candidates: Object.freeze(assistants.map(() => ({
            kind: "continuing" as const,
            providerTurnId: tracked.handle.providerTurnId,
          }))),
          evidence: evidence("multiple assistant descendants for one accepted user turn"),
        };
      }
      const assistant = assistants[0];
      if (assistant?.phase === "failed" && webProviderFailureReason(assistant.failureDetail) === "message_stream_failed"
        && !tracked.responseRetryState && driver.retryFailedResponse) {
        // Record dispatch before awaiting input: a thrown click may already have reached the page.
        tracked.responseRetryState = "dispatched";
        if (await waitOwned(signal, () => driver.retryFailedResponse!(assistant.key, signal))) {
          tracked.observeAgain = true;
          continue;
        }
        delete tracked.responseRetryState;
      }
      if (tracked.responseRetryState === "dispatched") {
        // A successful click does not clear the old failure synchronously. Keep the owned
        // observation alive until the retried response changes phase or ownership is cancelled.
        if (assistant?.phase === "failed") continue;
        if (assistant) tracked.responseRetryState = "observed";
      }
      const observedApproval = pendingApproval(snapshot, tracked);
      const waitState = JSON.stringify([assistant?.phase ?? "absent", observedApproval ?? null]);
      this.#observeApproval(surface, tracked, snapshot, assistant);
      const approvalChoice = observedApproval
        ? decideChatGptApproval(this.#approvalAutomationMode, observedApproval) : undefined;
      if (observedApproval?.cardCount && !tracked.approvalPendingCaptured) {
        tracked.approvalPendingCaptured = true;
        await waitOwned(signal, () => captureBrowserDiagnosticCheckpoint(surface, "approval_pending"));
        signal?.throwIfAborted();
      }
      if (tracked.waitState !== waitState) {
        tracked.waitState = waitState;
        emitDiagnosticEvent("chatgpt_tela_work", "web_turn_observed", {
          ...turnObservationFields(snapshot, tracked),
          assistant_phase: assistant?.phase ?? "absent",
          approval_card_count: snapshot.approval?.cardCount ?? 0,
          approval_mode: this.#approvalAutomationMode,
          ...(snapshot.approval ? { deny_count: snapshot.approval.denyCount, allow_count: snapshot.approval.allowCount,
            allow_once_count: snapshot.approval.allowOnceCount, always_allow_count: snapshot.approval.alwaysAllowCount,
            unknown_count: snapshot.approval.unknownCount } : {}),
        });
        if (observedApproval?.cardCount && this.#approvalAutomationMode !== "off"
          && approvalChoice?.action === "none") {
          emitDiagnosticEvent("chatgpt_tela_work", "approval_card_anomaly", {
            reason_class: approvalChoice.reason, approval_card_count: observedApproval.cardCount,
          });
          await waitOwned(signal, () => captureBrowserDiagnosticEvidence(surface, "approval_anomaly"));
        }
      }
      let preparationFailure: string | undefined;
      if (observedApproval?.cardCount && observedApproval.cardFingerprint
        && !tracked.approvalObservation.wasDispatched(observedApproval.cardFingerprint)
        && assistant?.phase !== "failed" && driver.processApprovalCard
        && approvalChoice?.action !== "none" && approvalChoice !== undefined) {
        signal?.throwIfAborted();
        const action = await waitOwned(signal, () => driver.processApprovalCard!(this.#approvalAutomationMode, signal,
          this.#approvalAutomationDelayMs, { cardFingerprint: observedApproval.cardFingerprint!,
            revisionFingerprint: observedApproval.revisionFingerprint }));
        signal?.throwIfAborted();
        this.#tracked(surface, turn);
        if (action.status === "dispatched" || action.reason === "already_activated") {
          const card = action.status === "dispatched" ? action.cardFingerprint : observedApproval.cardFingerprint;
          logApprovalTransition(tracked.approvalObservation.dispatched(card, Date.now(),
            action.status === "dispatched" ? action.revisionFingerprint : undefined));
        } else {
          preparationFailure = approvalPreparationFailureSummary(action.reason);
          const failure = JSON.stringify([observedApproval.cardFingerprint, observedApproval.revisionFingerprint, action.reason]);
          if (tracked.approvalFailureCaptured !== failure) {
            tracked.approvalFailureCaptured = failure;
            await waitOwned(signal, () => captureBrowserDiagnosticEvidence(surface, "approval_preparation_failed"));
          }
        }
      }
      signal?.throwIfAborted();
      const approvalPhase = tracked.approvalObservation.phase;
      const approvalProgress = preparationFailure ?? (approvalPhase ? approvalObservationSummary(approvalPhase) : "");
      if (approvalProgress && tracked.approvalProgress !== approvalProgress) {
        tracked.approvalProgress = approvalProgress;
        tracked.observeAgain = true;
        return { state: "proven", value: { kind: "progress", providerTurnId: tracked.handle.providerTurnId,
          summary: approvalProgress }, evidence: evidence("owned Web approval state observed") };
      }
      const publicProgress = assistant?.publicProgress?.join("\n\n");
      if (assistant?.phase === "streaming" && assistant.progressProbe?.titleCount
        && assistant.progressProbe.descriptionCount === 0 && !tracked.titleOnlyPublicProgressCaptured) {
        tracked.titleOnlyPublicProgressCaptured = true;
        emitDiagnosticEvent("chatgpt_tela_work", "web_public_progress_title_only", {
          assistant_phase: assistant.phase, title_count: assistant.progressProbe.titleCount,
          description_count: 0,
        });
        await waitOwned(signal, () => captureBrowserDiagnosticCheckpoint(surface, "progress_description_missing"));
      }
      if (assistant?.phase === "streaming" && assistant.progressProbe?.descriptionCount === 0
        && assistant.progressProbe.unmappedVisibleProsePresent && !tracked.unmappedPublicProgressCaptured) {
        tracked.unmappedPublicProgressCaptured = true;
        emitDiagnosticEvent("chatgpt_tela_work", "web_public_progress_unmapped_prose", {
          assistant_phase: assistant.phase, description_count: 0, visible_prose_observed: true,
        });
        await waitOwned(signal, () => captureBrowserDiagnosticCheckpoint(surface, "progress_prose_unmapped"));
      }
      if (!publicProgress && assistant?.phase === "streaming" && !tracked.missingPublicProgressCaptured) {
        tracked.missingPublicProgressCaptured = true;
        emitDiagnosticEvent("chatgpt_tela_work", "web_public_progress_missing", {
          assistant_phase: assistant.phase, matched_assistant_count: lineage.assistants.length,
        });
        await waitOwned(signal, () => captureBrowserDiagnosticCheckpoint(surface, "surface_anomaly"));
      }
      signal?.throwIfAborted();
      if (publicProgress && publicProgress.length <= 16384 && tracked.publicProgress !== publicProgress) {
        tracked.publicProgress = publicProgress;
        emitDiagnosticEvent("chatgpt_tela_work", "web_public_progress_ready", {
          progress_characters: publicProgress.length, public_progress_part_count: assistant?.publicProgress?.length ?? 0,
          assistant_phase: assistant?.phase ?? "unknown",
        });
        tracked.observeAgain = true;
        return { state: "proven", value: { kind: "progress", providerTurnId: tracked.handle.providerTurnId,
          summary: publicProgress }, evidence: evidence("public progress from the proven assistant lineage") };
      }
      // Pending authority decisions dominate display completion controls. Never commit a
      // progress message or clear a tool continuation while its approval remains unresolved.
      if (observedApproval?.cardCount && assistant?.phase !== "failed") {
        await recordDeferredCompletion(surface, tracked, snapshot, "approval_pending");
        continue;
      }
      if (!assistant) continue;
      const boundary = tracked.continuationBoundary;
      if (boundary) {
        if (assistantFingerprint(assistant) === boundary.assistantFingerprint) continue;
        delete tracked.continuationBoundary;
        if (assistant.phase === "failed") {
          signal?.throwIfAborted();
          observeProviderFailure(assistant.failureDetail);
          this.#retireTurn(surface, tracked);
          return {
            state: "proven",
            value: {
              kind: "failed",
              providerTurnId: tracked.handle.providerTurnId,
              detail: assistant.failureDetail ?? "ChatGPT turn failed",
            },
            evidence: evidence(`assistant failed after MCP result handoff for ${boundary.callId}`),
          };
        }
        if (assistant.phase === "complete") {
          this.#commitAnswer(surface, tracked, assistant, snapshot, "post_tool_handoff");
          tracked.pendingCompletedAnswer = completedAnswerBody(assistant);
        }
        return {
          state: "proven",
          value: { kind: "continuing", providerTurnId: tracked.handle.providerTurnId },
          evidence: evidence(`assistant state changed after exact MCP result handoff for ${boundary.callId}`),
        };
      }
      if (assistant.phase === "complete") {
        signal?.throwIfAborted();
        this.#commitAnswer(surface, tracked, assistant, snapshot, "direct");
        this.#retireTurn(surface, tracked);
        reportWebFinalObserved(tracked);
        return {
          state: "proven",
          value: {
            kind: "completed",
            providerTurnId: tracked.handle.providerTurnId,
            ...completedAnswerBody(assistant),
          },
          evidence: evidence("one assistant descendant reached complete state"),
        };
      }
      if (assistant.phase === "failed") {
        signal?.throwIfAborted();
        observeProviderFailure(assistant.failureDetail);
        this.#retireTurn(surface, tracked);
        return {
          state: "proven",
          value: {
            kind: "failed",
            providerTurnId: tracked.handle.providerTurnId,
            detail: assistant.failureDetail ?? "ChatGPT turn failed",
          },
          evidence: evidence("one assistant descendant reached failed state"),
        };
      }
    }
  }

  #tracked(surface: BrowserSurfaceLease, turn: WebTurnHandle, allowRetired = false): TrackedTurn {
    const tracked = this.#turns.get(surface);
    if (!tracked || tracked.surfaceLeaseId !== surface.leaseId
      || tracked.handle.providerTurnId !== turn.providerTurnId
      || tracked.handle.nativeTaskId !== turn.nativeTaskId
      || tracked.handle.nativeTurnId !== turn.nativeTurnId
      || tracked.handle.webEpochId !== turn.webEpochId) {
      throw new Error("ChatGPT turn handle is not bound to this browser surface and Native turn");
    }
    if (!allowRetired) tracked.operationAbort.signal.throwIfAborted();
    return tracked;
  }
}
