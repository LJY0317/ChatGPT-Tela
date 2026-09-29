import { createBrowserSurfaceCapability } from "@chatgpt-tela/browser-host";
import type { BrowserMemoryFile } from "@chatgpt-tela/browser-host";
import type { ChatGptApprovalAutomationMode } from "./approval-policy";

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
  readonly contentFingerprint?: string;
  readonly phase?: ChatGptAssistantPhase;
  readonly text?: string;
  readonly failureDetail?: string;
}

export interface ChatGptSurfaceSnapshot {
  readonly revision: string;
  readonly url: string;
  readonly composers: readonly ChatGptComposerObservation[];
  readonly sendControls: readonly ChatGptSendObservation[];
  readonly turns: readonly ChatGptTurnObservation[];
}

/**
 * The ChatGPT integration catalog rendered successfully, but neither the configured direct App nor
 * packaged Plugin was present. Callers may refresh by reacquiring one fresh browser surface once;
 * repeated refreshes must fail closed instead of looping.
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
   * Optionally handle one structurally recognized ChatGPT tool-approval card. The implementation must
   * keep card text/tool arguments inside the renderer and must never activate an unrecognized choice.
   */
  processApprovalCard?(
    mode: ChatGptApprovalAutomationMode,
    signal?: AbortSignal,
  ): Promise<{ readonly status: "none" | "approved"; readonly reason: string }>;
  replaceComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void>;
  clearComposerText(composerKey: string, signal?: AbortSignal): Promise<void>;
  appendComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Install memory-backed files and prove the product rendered every exact filename as accepted. */
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
