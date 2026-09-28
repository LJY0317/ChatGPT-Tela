import { createBrowserSurfaceCapability } from "@chatgpt-tela/browser-host";

export interface ChatGptComposerObservation {
  readonly key: string;
  readonly visible: boolean;
  readonly editable: boolean;
  readonly ownedByChatGptForm: boolean;
  readonly textLength: number;
  readonly textFingerprint?: string;
  /** SHA-256/base64url identities of currently selected ChatGPT connector pills. */
  readonly connectorFingerprints: readonly string[];
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
 * Low-level browser capability owned by the ChatGPT provider adapter. The browser-host package stays
 * product-agnostic; Electron/Playwright implementations only need to supply this capability for a
 * leased ChatGPT surface.
 */
export interface ChatGptSurfaceDriver {
  observe(signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot>;
  replaceComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void>;
  clearComposerText(composerKey: string, signal?: AbortSignal): Promise<void>;
  appendComposerText(composerKey: string, text: string, signal?: AbortSignal): Promise<void>;
  selectConnector(composerKey: string, connectorName: string, signal?: AbortSignal): Promise<void>;
  activateSend(controlKey: string, signal?: AbortSignal): Promise<void>;
  waitForChange(afterRevision: string, signal?: AbortSignal): Promise<ChatGptSurfaceSnapshot>;
}

export const CHATGPT_SURFACE_DRIVER = createBrowserSurfaceCapability<ChatGptSurfaceDriver>(
  "chatgpt-tela.chatgpt.surface-driver.v1",
);
