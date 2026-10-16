import { WebSubmissionUnproven, type WebSubmissionProofReason } from "@chatgpt-tela/core";
import { assistantFor, baselineUserLineageKeys, resolveAssistantLineage, type TurnOwnership, type AssistantLineageResolution } from "./turn-ownership";
import { createHash } from "node:crypto";
import {
  BROWSER_PAGE_AUTOMATION,
  captureBrowserDiagnosticEvidence,
  captureBrowserDiagnosticCheckpoint,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { WebRetainedContextUnproven, capturePrivateDiagnosticValue, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext, type WebRetainedContextReason } from "@chatgpt-tela/core";
import { ChatGptDomSurfaceDriver } from "./dom-driver";
import { decideChatGptApproval, type ChatGptApprovalAutomationMode } from "./approval-policy";
import { ChatGptApprovalObservation, approvalObservationSummary, type ApprovalObservationTransition } from "./approval-observation";
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
} from "./index";
import { isChatGptTemporaryChatUrl, isChatGptProvisionalConversationUrl } from "./session";

interface TrackedTurn extends TurnOwnership {
  readonly handle: WebTurnHandle;
  readonly surfaceLeaseId: string;
  readonly retainedContext: boolean;
  revision: string;
  continuationBoundary?: {
    readonly callId: string;
    readonly assistantFingerprint: string;

  };
  pendingCompletedAnswer?: Pick<Extract<WebTurnEvent, { kind: "completed" }>, "answer" | "plainAnswer">;
  waitState?: string;
  waitSnapshotCount?: number;
  lastWaitSnapshotAt?: number;
  diagnosticBoundaryCount?: number;
  publicProgress?: string;
  missingPublicProgressCaptured?: boolean;
  approvalProgress?: string;
  approvalPendingCaptured?: boolean;
  approvalResolutionRecorded?: boolean;
  readonly approvalObservation: ChatGptApprovalObservation;
  observeAgain?: boolean;
}

export interface ChatGptSemanticProviderOptions {
  /** Exact ChatGPT connector display identity to attach only when a Web turn owns a tool bridge. */
  readonly connectorName?: string;
  /**
   * Bounded post-cleanup window for ChatGPT to persist removal of a connector mention draft.
   * Production defaults to 5s; tests may set 0 because fixture state is synchronous.
   */
  readonly connectorDraftPersistenceSettleMs?: number;
  /** Optional local approval policy. Disabled by default and never selects persistent Always allow. */
  readonly approvalAutomationMode?: ChatGptApprovalAutomationMode;
  /** Optional bounded delay before inspecting the current one-shot approval card. */
  readonly approvalAutomationDelayMs?: number;
  /** Require the first send on each leased surface to start in a fresh Temporary Chat. */
  readonly requireTemporaryChat?: boolean;
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

const READINESS_PROBE_TEXT = "ChatGPT Tela readiness probe";
const CHATGPT_READINESS_TIMEOUT_MS = 30_000;
const CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS = 5_000;
const CHATGPT_CONNECTOR_DRAFT_PERSISTENCE_SETTLE_MS = 5_000;

async function waitForDuration(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 0) return;
  if (signal?.aborted) throw signal.reason ?? new DOMException("operation aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new DOMException("operation aborted", "AbortError")));
    timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

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
      throw new Error("ChatGPT readiness probe cleanup found multiple active composers");
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
        throw new Error("ChatGPT readiness probe could not restore the empty composer", { cause: error });
      }
      throw error;
    }
  }
}

export function formatWebPhysicalContext(
  context: WebPhysicalContext,
  toolBridge: WebTurnRequest["toolBridge"],
  contextAttachment?: ChatGptContextAttachmentReference,
  media: readonly WebTurnMedia[] = [],
): string {
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
      : "Only the active lineage is supplied. Execute the request identified by activeRequestRevisionId in the context header; older settled entries are context rather than separate pending tasks.",
    "Use actual tool results as evidence for local observations and effects. Do not claim a local action, permission failure, or safety block without a corresponding tool result or platform error.",
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
    ] : [
      "No Native Codex tool bridge is attached to this response. Do not claim fresh local inspection or mutation unless it is already present as prior task evidence.",
      "Use ChatGPT-native capabilities that are actually available when they help complete the request.",
    ]),
    "Do not mention this transport contract, context packaging, or capability routing unless the user explicitly asks how the bridge works.",
  ];
  const header = JSON.stringify({
    type: "chatgpt_tela_context",
    version: 1,
    headRevisionId: context.headRevisionId,
    ...(context.baseRevisionId ? { baseRevisionId: context.baseRevisionId } : {}),
    ...(context.activeRequestRevisionId ? { activeRequestRevisionId: context.activeRequestRevisionId } : {}),
    mode: context.mode,
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
  return [
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
}


function assistantFingerprint(assistant: ChatGptTurnObservation | undefined): string {
  if (!assistant) return fingerprint("null");
  const { publicProgress: _presentation, ...state } = assistant;
  return fingerprint(JSON.stringify(state));
}

function approvalAssistantVersion(assistant: ChatGptTurnObservation | undefined): string {
  // Renderer rekeys, timers and action controls are not substantive task progress.
  return fingerprint(JSON.stringify([assistant?.text ?? "", assistant?.publicProgress ?? []]));
}

function approvalTransitionDiagnostic(transition: ApprovalObservationTransition): void {
  emitDiagnosticEvent("chatgpt_tela_work", "approval_wait_transition", {
    phase: transition.phase, elapsed_ms: transition.elapsedMs,
    ...(transition.cardFingerprint ? { card_fingerprint: transition.cardFingerprint } : {}),
  });
}

/** Structural failure/transition evidence only; no renderer keys, text, URLs or fingerprints of text. */
async function waitForLineage(
  driver: ChatGptSurfaceDriver, tracked: TrackedTurn, signal?: AbortSignal,
): Promise<{ snapshot: ChatGptSurfaceSnapshot; lineage: AssistantLineageResolution }> {
  let snapshot = await driver.observe(signal);
  for (;;) {
    signal?.throwIfAborted();
    const lineage = resolveAssistantLineage(snapshot, tracked);
    if (!lineage.identityPending) return { snapshot, lineage };
    snapshot = await driver.waitForChange(snapshot.revision, signal);
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

function committedAnswerFingerprint(assistant: ChatGptTurnObservation): string | undefined {
  // The current composer Stop state can change phase labels on older DOM turns. Identity and
  // accepted answer content, rather than current-page activity labels, prove the retained prefix.
  if (assistant.bodyProof?.version !== 1 || assistant.bodyProof.digest === undefined) return undefined;
  return fingerprint(JSON.stringify([assistant.key, assistant.parentUserTurnKey,
    assistant.bodyProof.version, assistant.bodyProof.digest]));
}

/** Pending decisions outrank presentation completion; failure always remains terminal. */
function assistantLifecyclePhase(snapshot: ChatGptSurfaceSnapshot, assistant: ChatGptTurnObservation | undefined): WebTurnState["phase"] {
  if (assistant?.phase === "failed") return "failed";
  if (snapshot.approval?.cardCount || assistant?.phase === "tool-wait") return "tool-wait";
  if (assistant?.phase === "complete") return "completed";
  return assistant ? "continuing" : "accepted";
}

function stateFromSnapshot(
  snapshot: ChatGptSurfaceSnapshot,
  tracked: TrackedTurn,
): SemanticObservation<WebTurnState> {
  const lineage = resolveAssistantLineage(snapshot, tracked);
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
  const phase = assistantLifecyclePhase(snapshot, assistant);
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
  readonly #connectorDraftPersistenceSettleMs: number;
  readonly #approvalAutomationMode: ChatGptApprovalAutomationMode;
  readonly #approvalAutomationDelayMs: number;
  readonly #requireTemporaryChat: boolean;
  readonly #temporaryChatSurfaces = new WeakSet<BrowserSurfaceLease>();
  readonly #retainedBodyPending = new WeakSet<BrowserSurfaceLease>();
  readonly #completedBySurface = new WeakMap<BrowserSurfaceLease, {
    readonly userTurnKey: string;
    readonly assistantKey: string;
    readonly assistantFingerprint: string | undefined;
    readonly presentationFingerprint: string;
    readonly answerCharacters: number;
    readonly privateBodyEvidence?: ChatGptTurnObservation["privateBodyEvidence"];
  }>();

  #commitAnswer(surface: BrowserSurfaceLease, userTurnKey: string, assistant: ChatGptTurnObservation): void {
    this.#completedBySurface.set(surface, { userTurnKey, assistantKey: assistant.key,
      assistantFingerprint: committedAnswerFingerprint(assistant),
      presentationFingerprint: fingerprint(assistant.text ?? ""), answerCharacters: assistant.text?.length ?? 0,
      ...(assistant.privateBodyEvidence ? { privateBodyEvidence: assistant.privateBodyEvidence } : {}),
    });
    this.#retainedBodyPending.delete(surface);
  }

  #assertRetainedConversation(surface: BrowserSurfaceLease, snapshot: ChatGptSurfaceSnapshot, allowUnavailable = false): boolean {
    const anchor = this.#completedBySurface.get(surface);
    const assistants = anchor ? assistantFor(snapshot, anchor.userTurnKey) : [];
    const assistant = assistants.length === 1 ? assistants[0] : undefined;
    const sameKey = !!anchor && assistant?.key === anchor.assistantKey;
    const committedSemanticAvailable = anchor?.assistantFingerprint !== undefined;
    const observedSemanticAvailable = assistant?.bodyProof?.version === 1 && assistant.bodyProof.digest !== undefined;
    const reason: WebRetainedContextReason = !anchor ? "anchor_missing"
      : !assistant ? "lineage_not_unique" : !sameKey ? "assistant_identity_changed"
      : !committedSemanticAvailable ? "committed_semantic_unavailable"
      : !assistant.bodyProof ? "observed_body_missing"
      : assistant.bodyProof.version !== 1 ? "observed_body_version_unsupported"
      : !observedSemanticAvailable ? "observed_body_incomplete"
      : assistant.text === undefined ? "answer_unavailable" : "semantic_digest_mismatch";
    // The renderer reason is untrusted. Keep only the codec's closed vocabulary.
    const bodyReason = ["body_empty", "body_budget", "unsupported_node", "unsupported_link", "unsupported_list", "unsupported_table"]
      .find(value => value === assistant?.bodyProof?.reason) ?? "unclassified";
    const sameAnswer = !!anchor && !!assistant && assistant.text !== undefined
      && anchor.assistantFingerprint !== undefined
      && committedAnswerFingerprint(assistant) === anchor.assistantFingerprint;
    if (allowUnavailable && anchor?.assistantFingerprint !== undefined && assistant && sameKey
      && assistant.bodyProof?.digest === undefined) {
      if (!this.#retainedBodyPending.has(surface)) {
        this.#retainedBodyPending.add(surface);
        emitDiagnosticEvent("chatgpt_tela_work", "web_retained_body_pending", {
          reason_class: reason, assistant_key_matches: true,
          committed_semantic_available: committedSemanticAvailable,
          observed_semantic_available: observedSemanticAvailable,
        });
      }
      return false;
    }
    if (!anchor || !assistant || !sameKey || !sameAnswer) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_retained_anchor_rejected", {
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
        beforeDigest: anchor?.assistantFingerprint ?? null,
        afterDigest: assistant ? committedAnswerFingerprint(assistant) ?? null : null,
        assistantKeyMatches: sameKey,
      });
      throw new WebRetainedContextUnproven(reason);
    }
    if (this.#retainedBodyPending.delete(surface)) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_retained_body_recovered", { reason_class: "body_proven" });
    }
    return true;
  }

  async #waitForRetainedConversation(surface: BrowserSurfaceLease, snapshot: ChatGptSurfaceSnapshot,
    tracked: TrackedTurn, signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot> {
    const driver = driverFor(surface);
    for (;;) {
      signal?.throwIfAborted();
      const lineage = resolveAssistantLineage(snapshot, tracked);
      if (!lineage.identityPending && this.#assertRetainedConversation(surface, snapshot, true)) return snapshot;
      snapshot = await driver.waitForChange(snapshot.revision, signal);
    }
  }

  constructor(options: ChatGptSemanticProviderOptions = {}) {
    const connectorName = options.connectorName?.trim();
    if (connectorName !== undefined
      && (!connectorName || connectorName.length > 128 || /[\u0000\r\n]/.test(connectorName))) {
      throw new Error("ChatGPT connector identity must be 1-128 visible single-line characters");
    }
    const settleMs = options.connectorDraftPersistenceSettleMs
      ?? CHATGPT_CONNECTOR_DRAFT_PERSISTENCE_SETTLE_MS;
    if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 30_000) {
      throw new Error("ChatGPT connector draft persistence settle must be 0-30000ms");
    }
    this.#connectorName = connectorName;
    this.#connectorDraftPersistenceSettleMs = settleMs;
    this.#approvalAutomationMode = options.approvalAutomationMode ?? "off";
    const approvalDelayMs = options.approvalAutomationDelayMs ?? 0;
    if (!Number.isSafeInteger(approvalDelayMs) || approvalDelayMs < 0 || approvalDelayMs > 15_000) {
      throw new Error("ChatGPT approval automation delay must be 0-15000ms");
    }
    this.#approvalAutomationDelayMs = approvalDelayMs;
    this.#requireTemporaryChat = options.requireTemporaryChat ?? false;
  }

  #assertTemporaryChatSurface(surface: BrowserSurfaceLease, snapshot: ChatGptSurfaceSnapshot): void {
    if (!this.#requireTemporaryChat) return;
    if (isChatGptTemporaryChatUrl(snapshot.url)) return;
    if (this.#temporaryChatSurfaces.has(surface)
      && new URL(snapshot.url).origin === "https://chatgpt.com"
      && /^\/c\/[^/]+$/.test(new URL(snapshot.url).pathname)) return;
    throw new Error("ChatGPT Work send requires a verified Temporary Chat surface");
  }

  async #settleConnectorDraftPersistence(
    driver: ChatGptSurfaceDriver,
    composerKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await waitForDuration(this.#connectorDraftPersistenceSettleMs, signal);
    const snapshot = await driver.observe(signal);
    const composer = exactComposer(snapshot);
    if (composer.key !== composerKey
      || composer.textLength !== 0
      || composer.connectorFingerprints.length !== 0) {
      throw new Error("ChatGPT connector cleanup did not remain empty through the draft persistence window");
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
    if (sends.length !== 1) {
      if (sends.length > 1) {
        return {
            state: "ambiguous",
            candidates: Object.freeze(sends.map(send => ({ observed: new Set(["composer", `send:${send.key}`]) }))),
            evidence: evidence("multiple send controls belong to the same composer"),
          };
      }
      let probeStarted = false;
      try {
        probeStarted = true;
        await driver.replaceComposerText(composer.key, READINESS_PROBE_TEXT, signal);
        const deadline = timeoutSignal(signal, CHATGPT_COMPOSER_SETTLE_TIMEOUT_MS);
        let filled = await driver.observe(deadline.combined);
        for (;;) {
          const filledComposers = readyComposers(filled);
          if (filledComposers.length > 1) {
            return {
              state: "ambiguous",
              candidates: Object.freeze(filledComposers.map(candidate => ({
                observed: new Set([`composer:${candidate.key}`]),
              }))),
              evidence: evidence("readiness probe made the active composer ambiguous"),
            };
          }
          const filledComposer = filledComposers.length === 1 ? filledComposers[0]! : undefined;
          const exactReadback = filledComposer?.key === composer.key
            && filledComposer.textLength === READINESS_PROBE_TEXT.length
            && filledComposer.textFingerprint === fingerprint(READINESS_PROBE_TEXT);
          const probedSends = exactReadback ? visibleSends(filled, composer.key) : [];
          if (probedSends.length > 1) {
            return {
              state: "ambiguous",
              candidates: Object.freeze(probedSends.map(send => ({
                observed: new Set(["composer", `send:${send.key}`]),
              }))),
              evidence: evidence("multiple send controls appeared during inert readiness probe"),
            };
          }
          if (exactReadback && probedSends.length === 1) {
            return {
              state: "proven",
              value: { observed: new Set(["composer", "send"]) },
              evidence: evidence(
                "one ChatGPT-owned composer",
                "one matching visible send control after exact inert non-submitting probe",
              ),
            };
          }
          try {
            filled = await driver.waitForChange(filled.revision, deadline.combined);
          } catch (error) {
            if (signal?.aborted) throw error;
            if (deadline.timeout.aborted) {
              return {
                state: "probable",
                value: { observed: new Set(["composer"]) },
                evidence: evidence(
                  exactReadback
                    ? "send control did not appear after exact inert composer readback before readiness deadline"
                    : "readiness probe composer readback did not settle before readiness deadline",
                ),
              };
            }
            throw error;
          }
        }
      } finally {
        if (probeStarted) {
          await restoreEmptyComposer(driver, composer.key);
        }
      }
    }
    return {
      state: "proven",
      value: { observed: new Set(["composer", "send"]) },
      evidence: evidence("one ChatGPT-owned composer", "one matching visible send control"),
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
        await this.#settleConnectorDraftPersistence(driver, composer.key, signal);
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
      await this.#settleConnectorDraftPersistence(driver, composer.key, signal);
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
      await this.#settleConnectorDraftPersistence(driver, composer.key, signal);
      return true;
    }
    if (options.allowUnknownSelectedConnector === true
      && composer.textLength === 0
      && composer.connectorFingerprints.length === 1) {
      await restoreEmptyComposer(driver, composer.key);
      await this.#settleConnectorDraftPersistence(driver, composer.key, signal);
      return true;
    }
    if (!await driver.recoverConnectorArtifact(composer.key, connectorName, signal)) return false;
    await this.#settleConnectorDraftPersistence(driver, composer.key, signal);
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
      await this.#settleConnectorDraftPersistence(driver, composer.key, deadline.combined);
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
    if (request.inertSourceAttachment && (request.toolBridge || request.contextAttachment || request.physicalContext.mode === "retained-delta")) {
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
    if (!request.toolBridge && composer.connectorFingerprints.length !== 0) {
      throw new Error("tool-free ChatGPT semantic submit refuses a selected connector");
    }
    if (request.toolBridge && !connectorName) {
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
    const text = formatWebPhysicalContext(request.physicalContext, request.toolBridge, request.contextAttachment, request.media);
    emitDiagnosticEvent("chatgpt_tela_work", "browser_message_prepared", {
      context_mode: request.physicalContext.mode,
      message_chars: text.length,
      logical_estimate: request.physicalContext.logicalTokens,
      transfer_estimate: request.physicalContext.transferTokens,
    });
    const expectedFingerprint = fingerprint(text);
    try {
      let preparedBaseline = baseline;
      if (request.toolBridge) {
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

      if (request.toolBridge) {
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
        const connectorPreserved = !request.toolBridge
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
        emitDiagnosticEvent("chatgpt_tela_work", "web_media_upload_started", {
          file_count: files.length,
          evidence_count: upload.statistics.logicalReferences,
          total_bytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
        });
        await driver.attachFiles(composer.key, files, signal);
        filled = await driver.observe(signal);
        const verified = filled.composers.find(c => c.key === composer.key);
        const send = visibleSends(filled, composer.key);
        if (!verified || verified.textLength !== text.length
          || verified.textFingerprint !== expectedFingerprint
          || verified.attachmentNames.length === 0
          || (request.toolBridge && (verified.connectorFingerprints.length !== 1
            || verified.connectorFingerprints[0] !== expectedConnectorFingerprint))
          || send.length !== 1 || !send[0]!.enabled || send[0]!.key !== sendAfterFill.key) {
          throw new Error("ChatGPT Web media upload lost exact composer, connector, or send ownership");
        }
        emitDiagnosticEvent("chatgpt_tela_work", "web_media_composer_accepted", {
          file_count: files.length,
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
      await captureBrowserDiagnosticCheckpoint(surface,"before_submit");
      signal?.throwIfAborted();
      sendActivationAttempted = true;
      emitDiagnosticEvent("chatgpt_tela_work", "web_send_activation_started", { phase: "turn" });
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
    try {
      snapshot = await driver.waitForChange(filled.revision, acceptance.combined);
      for (;;) {
        const newUserTurns = snapshot.turns.filter(turn => (
          turn.role === "user" && !baselineTurnKeys.has(turn.key)
        ));
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
        if (newUserTurns.length === 1 && newUserTurns[0]!.contentFingerprint !== undefined) {
          const userTurn = newUserTurns[0]!;
          const handle = Object.freeze({
            nativeTaskId: request.nativeTaskId,
            nativeTurnId: request.nativeTurnId,
            webEpochId: request.webEpochId,
            providerTurnId: userTurn.key,
          });
          acceptance.combined.throwIfAborted();
          await captureBrowserDiagnosticCheckpoint(surface,"turn_accepted");
          this.#turns.set(surface, {
            handle,
            surfaceLeaseId: surface.leaseId,
            retainedContext: request.physicalContext.mode === "retained-delta",
            userTurnKey: userTurn.key,
            acceptedUserFingerprint: userTurn.contentFingerprint!,
            ...(userTurn.lineageAnchor ? { acceptedLineageAnchor: userTurn.lineageAnchor } : {}),
            conversationRoute: new URL(snapshot.url).origin + new URL(snapshot.url).pathname,
            baselineUserLineageKeys: preSubmitUserLineageKeys,
            revision: snapshot.revision,
            approvalObservation: new ChatGptApprovalObservation(),
          });
          const acceptedRoute = new URL(snapshot.url);
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_accepted", {
            route_kind: acceptedRoute.pathname === "/" ? "initial"
              : isChatGptProvisionalConversationUrl(snapshot.url) ? "provisional"
              : /^\/c\/[^/]+$/.test(acceptedRoute.pathname) ? "conversation" : "other",
            user_count: snapshot.turns.filter(turn => turn.role === "user").length,
            baseline_lineage_count: preSubmitUserLineageKeys.size,
            accepted_fingerprint_matches: userTurn.contentFingerprint === expectedFingerprint,
            logical_anchor_present: userTurn.lineageAnchor !== undefined,
          });
          return {
            state: "proven",
            value: handle,
            evidence: evidence(
              userTurn.contentFingerprint === expectedFingerprint
                ? "one new stable user turn acknowledges the exact submitted payload fingerprint"
                : "one new stable user turn acknowledges the exact pre-send composer readback and send activation",
            ),
          };
        }
        if (newUserTurns.length === 1 && !acceptancePendingRecorded) {
          acceptancePendingRecorded = true;
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
        user_count: users.length, accepted: false, remote_terminal_proven: false,
        ...acceptanceStructure(users.length === 1 ? users[0] : undefined),
        assistant_complete_observed: snapshot.turns.some(turn => turn.role === "assistant" && turn.phase === "complete"),
      });
      throw new WebSubmissionUnproven(users.length === 1
        ? acceptanceProofReason(users[0]!.userPayloadReason) : "new_author_unavailable");
    }
  }

  async observeTurn(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnState>> {
    signal?.throwIfAborted();
    const tracked = this.#tracked(surface, turn);
    const snapshot = await driverFor(surface).observe(signal);
    signal?.throwIfAborted();
    tracked.revision = snapshot.revision;
    const state = stateFromSnapshot(snapshot, tracked);
    if (tracked.retainedContext && !tracked.identityPending && !this.#assertRetainedConversation(surface, snapshot, true)) {
      return { state: "probable", value: { providerTurnId: turn.providerTurnId, phase: "accepted" },
        evidence: evidence("retained author body is temporarily unavailable") };
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
    let { snapshot, lineage } = await waitForLineage(driverFor(surface), tracked, signal);
    if (tracked.retainedContext) {
      snapshot = await this.#waitForRetainedConversation(surface, snapshot, tracked, signal);
      lineage = resolveAssistantLineage(snapshot, tracked);
    }
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
    const phase = assistantLifecyclePhase(snapshot, assistant);
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
    tracked.approvalObservation.recordNativeResult();
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

  async waitForTurnEvent(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnEvent>> {
    signal?.throwIfAborted();
    const tracked = this.#tracked(surface, turn);
    const driver = driverFor(surface);

    if (tracked.pendingCompletedAnswer !== undefined) {
      let { snapshot } = await waitForLineage(driver, tracked, signal);
      snapshot = await this.#waitForRetainedConversation(surface, snapshot, tracked, signal);
      const ownership = resolveAssistantLineage(snapshot, tracked);
      if (ownership.ambiguous || ownership.assistants.length !== 1) {
        throw new Error("ChatGPT pending completion no longer has one proven assistant identity");
      }
      const answer = tracked.pendingCompletedAnswer;
      delete tracked.pendingCompletedAnswer;
      // A new approval can render after completion controls. It still blocks final delivery.
      if (assistantLifecyclePhase(snapshot, ownership.assistants[0]) === "failed") {
        await this.#recordApprovalResolution(surface, tracked, "failed");
        this.#turns.delete(surface);
        return { state: "proven", value: { kind: "failed", providerTurnId: tracked.handle.providerTurnId,
          detail: ownership.assistants[0]!.failureDetail ?? "ChatGPT turn failed" },
          evidence: evidence("assistant failure superseded pending completion") };
      }
      if (!snapshot.approval?.cardCount) {
        await this.#recordApprovalResolution(surface, tracked, "completed");
        this.#turns.delete(surface);
        return {
          state: "proven",
          value: { kind: "completed", providerTurnId: tracked.handle.providerTurnId, ...answer },
          evidence: evidence("assistant completion followed a proven post-tool continuation boundary"),
        };
      }
    }

    for (;;) {
      const snapshot = tracked.observeAgain
        ? await driver.observe(signal)
        : await driver.waitForChange(tracked.revision, signal);
      signal?.throwIfAborted();
      tracked.observeAgain = false;
      tracked.revision = snapshot.revision;
      tracked.waitSnapshotCount = Math.min((tracked.waitSnapshotCount ?? 0) + 1, Number.MAX_SAFE_INTEGER);
      tracked.lastWaitSnapshotAt = Date.now();
      const lineage = resolveAssistantLineage(snapshot, tracked);
      if (lineage.identityPending) continue;
      if (tracked.retainedContext && !this.#assertRetainedConversation(surface, snapshot, true)) continue;
      const assistants = lineage.assistants;
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
      const waitState = JSON.stringify([assistant?.phase ?? "absent", snapshot.approval ?? null]);
      const inputReceiptTransition = tracked.approvalObservation.recordInputReceipt(snapshot.approvalInputReceipt, Date.now());
      if (inputReceiptTransition) approvalTransitionDiagnostic(inputReceiptTransition);
      const approvalTransition = tracked.approvalObservation.observe(snapshot.approval,
        approvalAssistantVersion(assistant), assistant !== undefined && assistant.phase !== "failed", Date.now());
      if (approvalTransition) approvalTransitionDiagnostic(approvalTransition);
      if (snapshot.approval?.cardCount && !tracked.approvalPendingCaptured) {
        tracked.approvalPendingCaptured = true;
        // Capture the first exact card before dispatch; private opt-in only, bounded once per turn.
        await captureBrowserDiagnosticCheckpoint(surface, "approval_pending");
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
        if (snapshot.approval?.cardCount && this.#approvalAutomationMode !== "off") {
          const decision = decideChatGptApproval(this.#approvalAutomationMode, snapshot.approval);
          if (decision.action === "none") {
            await captureBrowserDiagnosticEvidence(surface, "approval_anomaly");
            emitDiagnosticEvent("chatgpt_tela_work", "approval_card_anomaly", {
              reason_class: decision.reason, approval_card_count: snapshot.approval.cardCount,
            });
          }
        }
      }
      const observedApproval = snapshot.approval;
      if (observedApproval?.cardCount === 1 && observedApproval.cardFingerprint
        && !tracked.approvalObservation.wasDispatched(observedApproval.cardFingerprint)
        && assistant?.phase !== "failed" && driver.processApprovalCard
        && decideChatGptApproval(this.#approvalAutomationMode, observedApproval).action === "approve_once") {
        const action = await driver.processApprovalCard(this.#approvalAutomationMode, signal,
          this.#approvalAutomationDelayMs, { cardFingerprint: observedApproval.cardFingerprint,
            revisionFingerprint: observedApproval.revisionFingerprint });
        if (action.status === "dispatched" || action.reason === "already_activated") {
          const card = action.status === "dispatched" ? action.cardFingerprint : observedApproval.cardFingerprint;
          const transition = tracked.approvalObservation.dispatched(card, Date.now());
          approvalTransitionDiagnostic(transition);
        }
      }
      const approvalPhase = tracked.approvalObservation.phase;
      const approvalProgress = approvalPhase ? approvalObservationSummary(approvalPhase) : "";
      if (approvalProgress && tracked.approvalProgress !== approvalProgress) {
        tracked.approvalProgress = approvalProgress;
        tracked.observeAgain = true;
        return { state: "proven", value: { kind: "progress", providerTurnId: tracked.handle.providerTurnId,
          summary: approvalProgress }, evidence: evidence("owned Web approval state observed") };
      }
      const publicProgress = assistant?.publicProgress?.join("\n\n");
      if (!publicProgress && assistant?.phase === "streaming" && !tracked.missingPublicProgressCaptured) {
        tracked.missingPublicProgressCaptured = true;
        emitDiagnosticEvent("chatgpt_tela_work", "web_public_progress_missing", {
          assistant_phase: assistant.phase, matched_assistant_count: lineage.assistants.length,
        });
        await captureBrowserDiagnosticCheckpoint(surface, "surface_anomaly");
      }
      if (publicProgress && publicProgress.length <= 16384 && tracked.publicProgress !== publicProgress) {
        tracked.publicProgress = publicProgress;
        tracked.observeAgain = true;
        return { state: "proven", value: { kind: "progress", providerTurnId: tracked.handle.providerTurnId,
          summary: publicProgress }, evidence: evidence("public progress from the proven assistant lineage") };
      }
      // Pending authority decisions dominate display completion controls. Never commit a
      // progress message or clear a tool continuation while its approval remains unresolved.
      if (snapshot.approval?.cardCount && assistantLifecyclePhase(snapshot, assistant) !== "failed") continue;
      if (!assistant) continue;
      const boundary = tracked.continuationBoundary;
      if (boundary) {
        if (assistantFingerprint(assistant) === boundary.assistantFingerprint) continue;
        delete tracked.continuationBoundary;
        if (assistant.phase === "failed") {
          await this.#recordApprovalResolution(surface, tracked, "failed");
          this.#turns.delete(surface);
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
          this.#commitAnswer(surface, tracked.userTurnKey, assistant);
          tracked.pendingCompletedAnswer = completedAnswerBody(assistant);
        }
        return {
          state: "proven",
          value: { kind: "continuing", providerTurnId: tracked.handle.providerTurnId },
          evidence: evidence(`assistant state changed after exact MCP result handoff for ${boundary.callId}`),
        };
      }
      if (assistant.phase === "complete") {
        this.#commitAnswer(surface, tracked.userTurnKey, assistant);
        await this.#recordApprovalResolution(surface, tracked, "completed");
        this.#turns.delete(surface);
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
        await this.#recordApprovalResolution(surface, tracked, "failed");
        this.#turns.delete(surface);
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

  async #recordApprovalResolution(surface: BrowserSurfaceLease, tracked: TrackedTurn, phase: "completed" | "failed"): Promise<void> {
    const audit = tracked.approvalObservation.audit;
    if (!audit.approval_count || tracked.approvalResolutionRecorded) return;
    tracked.approvalResolutionRecorded = true;
    // This is turn-level evidence: it does not attribute a Native result to a particular approval.
    emitDiagnosticEvent("chatgpt_tela_work", "approval_turn_resolution", {
      ...audit, assistant_phase: phase,
      execution_evidence: audit.native_result_count ? "native_result_observed" : "unverified",
      decision_evidence: "unverified",
    });
    if (!audit.native_result_count || phase === "failed") {
      emitDiagnosticEvent("chatgpt_tela_work", "approval_resolution_anomaly", {
        ...audit, assistant_phase: phase, reason_class: "approval_without_verified_execution",
      });
      await captureBrowserDiagnosticCheckpoint(surface, "approval_resolution");
    }
  }

  #tracked(surface: BrowserSurfaceLease, turn: WebTurnHandle): TrackedTurn {
    const tracked = this.#turns.get(surface);
    if (!tracked || tracked.surfaceLeaseId !== surface.leaseId
      || tracked.handle.providerTurnId !== turn.providerTurnId
      || tracked.handle.nativeTaskId !== turn.nativeTaskId
      || tracked.handle.nativeTurnId !== turn.nativeTurnId
      || tracked.handle.webEpochId !== turn.webEpochId) {
      throw new Error("ChatGPT turn handle is not bound to this browser surface and Native turn");
    }
    return tracked;
  }
}
