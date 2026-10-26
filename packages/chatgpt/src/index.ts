import type { BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
export { WebCheckpointOperationClosed, WebCheckpointResponseRejected } from "./checkpoint-settlement";
import type {
  ChatGptContextAttachment,
  ChatGptContextAttachmentReference,
} from "./context-attachment";

export type ProofState = "proven" | "probable" | "ambiguous";

export type SemanticObservation<T> =
  | { readonly state: "proven"; readonly value: T; readonly evidence: readonly string[] }
  | { readonly state: "probable"; readonly value: T; readonly evidence: readonly string[] }
  | { readonly state: "ambiguous"; readonly candidates: readonly T[]; readonly evidence: readonly string[] };

export function requireProven<T>(observation: SemanticObservation<T>): T {
  if (observation.state !== "proven") {
    throw new Error(`consequential action requires proven state; observed ${observation.state}`);
  }
  return observation.value;
}

export interface ChatGptCapabilities {
  readonly observed: ReadonlySet<string>;
}

export type WebContextRevisionKind =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "steering";

export type WebPhysicalContextSegment =
  | {
      readonly type: "checkpoint";
      readonly checkpointId: string;
      readonly sourceRevisionId: string;
      readonly content: string;
    }
  | {
      readonly type: "revision";
      readonly revisionId: string;
      readonly kind: WebContextRevisionKind;
      readonly content: string;
      /** Canonical, ordered evidence identities bound to this exact logical revision.
       * The prose body is NOT proof of attachment ownership. */
      readonly evidence?: readonly import("@chatgpt-tela/core").NativeEvidenceReference[];
    };

export interface WebPhysicalContext {
  readonly headRevisionId: string;
  /** Exact canonical revision already represented by a retained Web conversation. */
  readonly baseRevisionId?: string;
  /** Latest active user/steering revision in the canonical Native lineage. */
  readonly activeRequestRevisionId?: string;
  readonly mode: "full" | "checkpoint-delta" | "retained-delta";
  readonly logicalTokens: number;
  readonly transferTokens: number;
  readonly segments: readonly WebPhysicalContextSegment[];
}

export interface WebToolBridgeContext {
  readonly protocol: "mcp";
  readonly contract: "development" | "stable";
  /** Opaque response-cycle bearer capability bound to an exact Native turn. Invalid after cycle retirement. */
  readonly turnCapability: string;
}

export interface WebTurnRequest {
  readonly nativeTaskId: string;
  readonly nativeTurnId: string;
  readonly webEpochId: string;
  readonly physicalContext: WebPhysicalContext;
  readonly contextAttachment?: ChatGptContextAttachmentReference;
  /** One tool-free response consumes this inert source AND returns its file receipt.
   * It cannot be combined with a preloaded reference, retained delta or tool bridge. */
  readonly inertSourceAttachment?: { readonly attachment: ChatGptContextAttachment; readonly receipt: string };
  readonly media?: readonly import("./turn-media").WebTurnMedia[];
  /** Independent work tools, optionally carrying a Goal-only control capability. */
  readonly chatTools?: { readonly defaultProfileSlot?: number; readonly nativeGoalControl?: string };
  /** Local execution lifecycle only; never serialized into the Web prompt. */
  readonly isToolExecutionPending?: () => boolean;
  readonly toolBridge?: WebToolBridgeContext;
}

export interface WebContextAttachmentPreloadRequest {
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly attachment: ChatGptContextAttachment;
}

export interface WebContextAttachmentPreloadResult {
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly attachmentName: string;
  readonly attachmentSha256: string;
  readonly providerOperationId: string;
}

export interface WebTurnHandle {
  readonly nativeTaskId: string;
  readonly nativeTurnId: string;
  readonly webEpochId: string;
  readonly providerTurnId: string;
}

export interface WebTurnState {
  readonly providerTurnId: string;
  readonly phase: "accepted" | "tool-wait" | "continuing" | "completed" | "failed";
}

export type WebTurnEvent =
  | {
      readonly kind: "progress";
      readonly providerTurnId: string;
      readonly summary: string;
    }
  | {
      readonly kind: "continuing";
      readonly providerTurnId: string;
    }
  | {
      readonly kind: "completed";
      readonly providerTurnId: string;
      /** Markdown for user-facing presentation. Never parse it as a protocol payload. */
      readonly answer: string;
      /** Unformatted text from the same proven owned body, when the adapter exposes it. */
      readonly plainAnswer?: string;
    }
  | {
      readonly kind: "failed";
      readonly providerTurnId: string;
      readonly detail: string;
    };

export interface WebToolContinuationBoundary {
  readonly providerTurnId: string;
  readonly callId: string;
}

/**
 * One-purpose, tool-free request for a disposable physical context checkpoint.
 *
 * There is intentionally no WebToolBridgeContext here. A checkpoint provider may summarize the
 * exact canonical prefix supplied by the runtime, but it cannot acquire the Native turn bearer or
 * become a route for tool execution.
 */
export interface WebContextCheckpointRequest {
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly sourceRevisionId: string;
  readonly physicalContext: WebPhysicalContext;
  readonly media?: readonly import("./turn-media").WebTurnMedia[];
}

export interface WebContextCheckpointResult {
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly sourceRevisionId: string;
  readonly providerOperationId: string;
  readonly content: string;
}

/** Dedicated semantic surface for checkpoint production; ordinary turn replies are not accepted. */
export interface WebContextCheckpointProvider {
  createContextCheckpoint(
    surface: BrowserSurfaceLease,
    request: WebContextCheckpointRequest,
    signal?: AbortSignal,
    onProgress?: (summary: string) => void,
  ): Promise<SemanticObservation<WebContextCheckpointResult>>;
}

/** Read-only status of an exact provider-owned unresolved approval episode. */
export interface WebApprovalWaitProjection {
  readonly phase: "pending" | "dispatch_sent" | "input_received" | "card_cleared" | "task_progress";
  readonly elapsedMs: number;
  readonly unverifiedDispatchCount: number;
  readonly operationState: "waiting" | "stopping";
}

/** Product locators and DOM structure stay behind this semantic provider boundary. */
export interface WebConversationProvider {
  /** Synchronous owned-state projection only; no browser read, click or authority grant. */
  inspectApprovalWait?(surface: BrowserSurfaceLease): WebApprovalWaitProjection | undefined;

  observeCapabilities(
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<ChatGptCapabilities>>;

  preloadContextAttachment?(
    surface: BrowserSurfaceLease,
    request: WebContextAttachmentPreloadRequest,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebContextAttachmentPreloadResult>>;

  submitTurn(
    surface: BrowserSurfaceLease,
    request: WebTurnRequest,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnHandle>>;

  observeTurn(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnState>>;

  /**
   * Arm a post-tool semantic observation before the MCP result is released back to ChatGPT.
   * A proven arm closes the race between Web result handoff and renderer continuation.
   */
  armToolContinuation(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    callId: string,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebToolContinuationBoundary>>;

  /** Retire exact operation authority and attempt public browser Stop with bounded observation.
   * The accepted remote outcome remains uncertain; this never resends a request. */
  cancelTurn?(surface: BrowserSurfaceLease, turn: WebTurnHandle): Promise<void>;

  /** Wait for the next semantic lifecycle event without requiring runtime polling. */
  waitForTurnEvent(
    surface: BrowserSurfaceLease,
    turn: WebTurnHandle,
    signal?: AbortSignal,
  ): Promise<SemanticObservation<WebTurnEvent>>;
}

export * from "./surface";
export * from "./account-identity";
export * from "./history-ui";
export * from "./saved-history-delete";
export * from "./saved-history-acceptance";
export * from "./saved-history-recovery";
export * from "./approval-policy";
export * from "./dom-driver";
export * from "./session";
export * from "./semantic-provider";
export * from "./model-picker";
export * from "./physical-limits";
export * from "./context-attachment";
export * from "./turn-media";
export * from "./checkpoint-provider";
