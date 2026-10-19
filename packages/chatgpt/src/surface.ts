import { createBrowserSurfaceCapability } from "@chatgpt-tela/browser-host";
import type { BrowserMemoryFile } from "@chatgpt-tela/browser-host";
import type { ChatGptApprovalCardObservation, ChatGptApprovalAutomationMode } from "./approval-policy";

export interface ChatGptComposerObservation {
  readonly key: string;
  readonly visible: boolean;
  readonly editable: boolean;
  readonly ownedByChatGptForm: boolean;
  readonly textLength: number;
  readonly textFingerprint?: string;
  /** SHA-256/base64url identities of currently selected ChatGPT connector pills. */
  readonly connectorFingerprints: readonly string[];
  /** Visible filenames from the product-owned composer attachment surface only. */
  readonly attachmentNames: readonly string[];
}

export interface ChatGptSendObservation {
  readonly key: string;
  readonly composerKey: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly semantic: "send";
}

export type ChatGptAssistantPhase =
  | "thinking"
  | "tool-wait"
  | "streaming"
  | "complete"
  | "failed";

export interface ChatGptTurnObservation {
  readonly key: string;
  readonly role: "user" | "assistant";
  readonly parentUserTurnKey?: string;
  /** Adapter-proven unique logical turn in the same renderer document; never a position guess. */
  readonly lineageAnchor?: string;
  /** Author payload only, never whole-bubble innerText; absent means proof unavailable. */
  readonly contentFingerprint?: string;
  /** Bounded unequal-chain endpoints; alternatives only, never standalone author proof. */
  readonly candidateFingerprints?: readonly string[];
  readonly userPayloadReason?: string;
  /** Content-free adapter witness, count saturated at 65; never acceptance authority. */
  readonly userPayloadProbe?: Readonly<Record<string, number | boolean>>;
  readonly userPayloadStructure?: { readonly rootCount: number; readonly nestedRoots?: boolean; readonly equivalentRoots?: boolean; readonly outerLength?: number; readonly innerLength?: number };
  /** Delivered answer serialization, including presentation-hidden author text; excludes DOM attributes. */
  readonly bodyProof?: { readonly version: 1; readonly digest?: string; readonly reason?: string };
  /** Opt-in bounded diagnostic witness; never authority or public progress. */
  readonly privateBodyEvidence?: { readonly chunks: readonly string[]; readonly complete: boolean };
  /** Trimmed literal owned-body text before Markdown conversion; protocol equality only. */
  readonly plainBodyFingerprint?: string;
  /** Literal DOM text without layout-derived line breaks; machine-readable consumers require it. */
  readonly plainBodyText?: string;
  readonly phase?: ChatGptAssistantPhase;
  /** Observed owned body, possibly partial; only phase/lineage authorize final delivery. */
  readonly text?: string;
  readonly failureDetail?: string;
  /** Publicly rendered progress only; hidden/expanded internal reasoning is never read. */
  readonly publicProgress?: readonly string[];
  /** Content-free presentation diagnosis; never turn identity or completion authority. */
  readonly progressProbe?: { readonly titleCount: number; readonly descriptionCount: number; readonly unmappedVisibleProsePresent?: boolean };
}

export interface ChatGptSurfaceSnapshot {
  readonly revision: string;
  /** Structural approval state; no card text or tool arguments cross this boundary. */
  readonly approval?: ChatGptApprovalCardObservation & {
    readonly revisionFingerprint: string;
    /** Disposable card identity and trusted input receipt; neither proves approval acceptance. */
    readonly cardFingerprint?: string;
    readonly inputReceived?: boolean;
  };
  /** Last prepared trusted input, independent of the card's continued presence. Not approval authority. */
  readonly approvalInputReceipt?: { readonly cardFingerprint: string; readonly revisionFingerprint: string };
  readonly url: string;
  readonly composers: readonly ChatGptComposerObservation[];
  readonly sendControls: readonly ChatGptSendObservation[];
  readonly turns: readonly ChatGptTurnObservation[];
}

/**
 * The ChatGPT integration catalog rendered successfully, but neither the configured direct App nor
 * packaged Plugin was present. Tool-capable callers fail closed rather than submitting an unbound
 * prompt and assuming ChatGPT will route it to the intended connector automatically.
 */
export class ChatGptConnectorCatalogUnavailableError extends Error {
  constructor() {
    super("ChatGPT integration catalog does not expose the configured connector");
    this.name = "ChatGptConnectorCatalogUnavailableError";
  }
}

/**
 * Low-level browser capability owned by the ChatGPT provider adapter. The browser-host package stays
 * product-agnostic; Electron/Playwright implementations only need to supply this capability for a
 * leased ChatGPT surface.
 */
export interface ChatGptSurfaceDriver {
  observe(signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot>;
  /** Close transient ChatGPT menus/popovers without submitting or altering durable user content. */
  dismissTransientUi(signal?: AbortSignal): Promise<void>;
  /**
   * Clear only a renderer-local connector artifact that can be structurally proven to belong to
   * the configured connector. Raw composer text never leaves the renderer for this proof.
   */
  recoverConnectorArtifact(composerKey: string, connectorName: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Clear only an exact Tela-owned inert context-preload draft. Raw draft text stays inside the
   * renderer for classification; arbitrary/user-authored drafts must return false unchanged.
   */
  recoverContextPreloadArtifact?(composerKey: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Optionally handle one visible ChatGPT tool-approval card. The implementation must
   * keep card text/tool arguments inside the renderer and activate only a unique supported choice.
   * Dispatch is not approval receipt. The provider supplies the exact previously observed card proof.
   */
  processApprovalCard?(
    mode: ChatGptApprovalAutomationMode,
    signal?: AbortSignal,
    delayMs?: number,
    expected?: { readonly cardFingerprint: string; readonly revisionFingerprint: string },
  ): Promise<{ readonly status: "none"; readonly reason: string }
    | { readonly status: "dispatched"; readonly reason: "allow" | "allow_once" | "allow_conversation";
        readonly cardFingerprint: string; readonly revisionFingerprint?: string }>;
  /** Stop only the exact owned assistant through the provider's public Stop affordance.
   * Absence of generation controls is not proof of successful remote task completion. */
  stopGeneration?(
    expected: { readonly assistantKey: string; readonly userTurnKey: string; readonly userFingerprint: string },
    signal?: AbortSignal,
  ): Promise<{ readonly status: "stopped" | "stop_sent" | "unavailable" | "ownership_changed" }>;
  replaceComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void>;
  clearComposerText(composerKey: string, signal?: AbortSignal): Promise<void>;
  appendComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void>;
  /**
   * Install the exact memory-backed files on the proven browser input and do not return until the
   * composer structurally accepts the resulting attachment set. ChatGPT may normalize visible chip
   * labels, so exact file identity belongs to the input readback and any higher-level content proof,
   * not to presentation text alone.
   */
  attachFiles?(
    composerKey: string,
    files: readonly BrowserMemoryFile[],
    signal?: AbortSignal,
  ): Promise<void>;
  selectConnector(composerKey: string, connectorName: string, signal?: AbortSignal): Promise<void>;
  activateSend(controlKey: string, signal?: AbortSignal): Promise<void>;
  waitForChange(afterRevision: string, signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot>;
}

export const CHATGPT_SURFACE_DRIVER = createBrowserSurfaceCapability<ChatGptSurfaceDriver>(
  "chatgpt-tela.chatgpt.surface-driver.v1",
);
