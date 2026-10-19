import { randomUUID } from "node:crypto";
import { BROWSER_INSPECTION_INPUT, BROWSER_USER_HIDE, captureBrowserDiagnosticEvidence, type BrowserHost, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { capturePrivateDiagnosticValue, diagnosticFailureFields, diagnosticFingerprint, withDiagnosticContext, emitDiagnosticEvent } from "@chatgpt-tela/core";
import type {
  ChatGptAccountIdentity,
  ChatGptCapabilities,
  ChatGptConnectorObservation,
  ChatGptConnectorProbe,
  WebConversationProvider,
  ChatGptWebModelFamily,
} from "@chatgpt-tela/chatgpt";
import {
  ChatGptConnectorCatalogUnavailableError,
  ChatGptWebModelPickerControlUnavailableError,
  ChatGptWebLoginRequiredError,
  observeChatGptAccountIdentity,
  observeChatGptAccountDisplay,
  observeChatGptHistoryUi,
  type ChatGptHistoryUiReadiness,
  exerciseSavedChatCreateAndDelete,
  type SavedChatCleanupAcceptanceReceipt,
  recoverAndDeleteSyntheticSavedChat,
  type SyntheticSavedChatRecoveryReceipt,
} from "@chatgpt-tela/chatgpt";

export interface ChatGptProfileObservation {
  readonly capabilities: ChatGptCapabilities;
  readonly account: ChatGptAccountIdentity;
}

export type ChatGptAccountIdentityObserver = (
  surface: BrowserSurfaceLease,
  signal?: AbortSignal,
) => Promise<ChatGptAccountIdentity>;

export interface ElectronProfileSetupSurface {
  readonly leaseId: string;
  /** Exact owner-bound user-close signal, not account or turn authority. */
  onUserHide(observer: () => void): () => void;
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<ChatGptProfileObservation>;
  /** Owner-only, content-free official history UI preflight. Never clicks/deletes. */
  probeChatGptHistoryUi?(): Promise<ChatGptHistoryUiReadiness>;
  /** Explicit test-only saved chat, and official UI cleanup. Not a consumer Web action. */
  runSavedChatDeleteAcceptance?(): Promise<SavedChatCleanupAcceptanceReceipt>;
  /** Cleanup-only, never sends; exact one-item synthetic title/user proof required. */
  recoverSyntheticSavedChat?(): Promise<SyntheticSavedChatRecoveryReceipt>;
  reveal(): Promise<void>;
  close(): Promise<void>;
}

export type WebPreparationFailureStage = "account" | "model-discovery" | "connector" | "readiness";
export type WebPreparationFailureReason = "login_required" | "model_picker_control_unavailable" | "connector_catalog_unavailable" | "unknown";
export interface WebPreparationFailureDetail {
  readonly stage: WebPreparationFailureStage;
  readonly reasonClass: WebPreparationFailureReason;
}
const preparationFailures = new WeakMap<object, WebPreparationFailureDetail>();
export function webPreparationFailureDetail(error: unknown): WebPreparationFailureDetail | undefined {
  const recorded = typeof error === "object" && error !== null ? preparationFailures.get(error) : undefined;
  return recorded ?? (error instanceof ChatGptWebLoginRequiredError
    ? { stage: "account", reasonClass: "login_required" } : undefined);
}
function recordPreparationFailure(error: unknown, stage: WebPreparationFailureStage): void {
  if (typeof error !== "object" || error === null) return;
  const reasonClass: WebPreparationFailureReason =
    error instanceof ChatGptWebLoginRequiredError ? "login_required"
    : error instanceof ChatGptWebModelPickerControlUnavailableError ? "model_picker_control_unavailable"
    : error instanceof ChatGptConnectorCatalogUnavailableError ? "connector_catalog_unavailable" : "unknown";
  preparationFailures.set(error, Object.freeze({ stage, reasonClass }));
}

export interface ChatGptWebPreparationOptions {
  readonly signal?: AbortSignal;
  readonly onProfile: (profile: ChatGptProfileObservation) => void;
  readonly onFamilies?: (families: readonly ChatGptWebModelFamily[]) => void;
  readonly onConnectorStarting?: () => void;
  readonly onConnectorProven?: () => void;
}

export interface ChatGptProfileControl {
  probeChatGptAccount(signal?: AbortSignal): Promise<ChatGptAccountIdentity>;
  probeChatGptAccountDisplay(signal?: AbortSignal): ReturnType<typeof observeChatGptAccountDisplay>;
  prepareChatGptWebSession(options: ChatGptWebPreparationOptions): Promise<{
    readonly families: readonly ChatGptWebModelFamily[];
    readonly connector: ChatGptConnectorObservation;
    readonly capabilities: ChatGptCapabilities;
  }>;
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<ChatGptProfileObservation>;
  recoverChatGptConnectorProbeArtifact(
    signal?: AbortSignal,
    options?: { readonly allowUnknownSelectedConnector?: boolean },
  ): Promise<boolean>;
  probeChatGptConnector(signal?: AbortSignal): Promise<ChatGptConnectorObservation>;
  probeChatGptConnection(signal?: AbortSignal, onConnectorProven?: () => void): Promise<{
    readonly connector: ChatGptConnectorObservation;
    readonly capabilities: ChatGptCapabilities;
  }>;
  openProfileSetupSurface(options?: { readonly reveal?: boolean }): Promise<ElectronProfileSetupSurface>;
  close(): Promise<void>;
}

async function proveReadiness(
  surface: Parameters<Pick<WebConversationProvider, "observeCapabilities">["observeCapabilities"]>[0],
  provider: Pick<WebConversationProvider, "observeCapabilities">,
  signal?: AbortSignal,
): Promise<ChatGptCapabilities> {
  const observation = await provider.observeCapabilities(surface, signal);
  if (observation.state !== "proven") {
    throw new Error(
      `ChatGPT profile readiness is not proven: ${observation.state}; ${observation.evidence.join("; ")}`,
    );
  }
  if (!observation.value.observed.has("composer")) {
    throw new Error("ChatGPT profile readiness is missing a composer");
  }
  return observation.value;
}

async function proveProfile(
  surface: Parameters<Pick<WebConversationProvider, "observeCapabilities">["observeCapabilities"]>[0],
  provider: Pick<WebConversationProvider, "observeCapabilities">,
  accountIdentityObserver: ChatGptAccountIdentityObserver,
  signal?: AbortSignal,
): Promise<ChatGptProfileObservation> {
  // Authentication has its own contract and does not require an editable composer.
  // Prove it first so a signed-out page cannot become a generic hydration timeout.
  const account = await accountIdentityObserver(surface, signal);
  const capabilities = await proveReadiness(surface, provider, signal);
  return Object.freeze({ capabilities, account });
}

/**
 * Own only non-consequential ChatGPT profile-control surfaces.
 *
 * Readiness observes one isolated surface and submits nothing. Setup surfaces may be revealed for
 * human login/Developer Mode/connector preparation, but they never receive Native turn authority or
 * an MCP bearer. The BrowserHost itself remains caller-owned.
 */
export function createChatGptProfileControl(input: {
  readonly browserHost: BrowserHost;
  readonly provider: Pick<WebConversationProvider, "observeCapabilities"> & Partial<ChatGptConnectorProbe>;
  readonly accountIdentityObserver?: ChatGptAccountIdentityObserver;
  readonly diagnosticProfileFingerprint?: string;
  readonly modelFamilyDiscovery?: (surface: BrowserSurfaceLease, signal?: AbortSignal) => Promise<readonly ChatGptWebModelFamily[]>;
}): ChatGptProfileControl {
  const setupLeases = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const requireOpen = (): void => {
    if (closed || closing) throw new Error("ChatGPT profile control is closing");
  };
  const identityObserver = input.accountIdentityObserver ?? observeChatGptAccountIdentity;
  const accountIdentityObserver: ChatGptAccountIdentityObserver = (surface, signal) => input.diagnosticProfileFingerprint
    ? withDiagnosticContext({ profile_fingerprint: input.diagnosticProfileFingerprint }, () => identityObserver(surface, signal))
    : identityObserver(surface, signal);

  async function withConnectorSurface<T>(
    signal: AbortSignal | undefined,
    finish: (surface: BrowserSurfaceLease, connector: ChatGptConnectorObservation) => Promise<T>,
  ): Promise<T> {
    requireOpen();
    if (!input.provider.probeConnector) {
      throw new Error("ChatGPT provider does not support connector preflight");
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-connector-readiness",
        epochId: `connector-${randomUUID()}`,
      });
      try {
        const connector = await input.provider.probeConnector(lease, signal);
        signal?.throwIfAborted();
        return await finish(lease, connector);
      } catch (error) {
        if (!(error instanceof ChatGptConnectorCatalogUnavailableError) || attempt >= 2) throw error;
        emitDiagnosticEvent("chatgpt_tela_connector", "catalog_refresh", { attempt });
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    }
    throw new Error("ChatGPT connector catalog refresh exhausted unexpectedly");
  }

  return Object.freeze({
    async prepareChatGptWebSession(options: ChatGptWebPreparationOptions) {
      requireOpen();
      if (!input.provider.probeConnector || !input.modelFamilyDiscovery) {
        throw new Error("ChatGPT provider does not support Web preparation");
      }
      const { signal } = options;
      let originalAccount: ChatGptAccountIdentity | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        signal?.throwIfAborted();
        const surface = await input.browserHost.acquire({
          taskId: "chatgpt-tela-web-preparation", epochId: `preparation-${randomUUID()}`,
        });
        let stage: "account" | "model-discovery" | "connector" | "readiness" = "account";
        try {
          signal?.throwIfAborted();
          const profile = await proveProfile(surface, input.provider, accountIdentityObserver, signal);
          signal?.throwIfAborted();
          // A second disposable preparation page can never adopt a different
          // logged-in account or profile container from the original proof.
          if (originalAccount && (profile.account.accountFingerprint !== originalAccount.accountFingerprint
            || profile.account.containerFingerprint !== originalAccount.containerFingerprint
            || profile.account.accountStructure !== originalAccount.accountStructure)) {
            throw new Error("ChatGPT account changed during Web preparation recovery");
          }
          originalAccount ??= profile.account;
          options.onProfile(profile);
          signal?.throwIfAborted();
          stage = "model-discovery";
          const families = Object.freeze([...(await input.modelFamilyDiscovery(surface, signal))]);
          signal?.throwIfAborted();
          if (!families.length) throw new Error("Web model discovery is incomplete");
          options.onFamilies?.(families);
          signal?.throwIfAborted();
          stage = "connector";
          options.onConnectorStarting?.();
          signal?.throwIfAborted();
          const connector = await input.provider.probeConnector(surface, signal);
          signal?.throwIfAborted();
          options.onConnectorProven?.();
          // Connector proof settles its own draft before returning; the same document must
          // still be ready and belong to the account validated at the start of this lease.
          stage = "readiness";
          const capabilities = await proveReadiness(surface, input.provider, signal);
          const finalAccount = await accountIdentityObserver(surface, signal);
          signal?.throwIfAborted();
          requireOpen();
          if (finalAccount.accountFingerprint !== profile.account.accountFingerprint
            || finalAccount.containerFingerprint !== profile.account.containerFingerprint
            || finalAccount.accountStructure !== profile.account.accountStructure) {
            throw new Error("ChatGPT account changed during Web preparation");
          }
          return Object.freeze({ families, connector, capabilities });
        } catch (error) {
          // Preparation owns this exact lease until finally. Capture before release,
          // including failures outside the picker (account, connector, readiness).
          await withDiagnosticContext({ operation_fingerprint: diagnosticFingerprint(surface.epochId),
            surface_fingerprint: diagnosticFingerprint(surface.leaseId) }, async () => {
            emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_preparation_stage_failed", {
              proof_stage: stage, attempt, ...diagnosticFailureFields(error), cancelled: signal?.aborted ?? false,
            });
            try {
              capturePrivateDiagnosticValue("web_preparation_failure", { stage, attempt,
                error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "unknown" } });
              // The picker already captured its failure before restoring the selection.
              if (stage !== "model-discovery") await captureBrowserDiagnosticEvidence(surface, "web_preparation_failed");
            } catch { /* Evidence must not mask the original failure. */ }
          });
          if (error instanceof ChatGptWebModelPickerControlUnavailableError
            && stage === "model-discovery" && attempt === 1 && !signal?.aborted) {
            emitDiagnosticEvent("chatgpt_tela_work", "web_preparation_recovery", {
              reason_class: "model_picker_control_unavailable", attempt: 2,
            });
            // finally releases this exact old lease before the next iteration
            // re-proves the same account in a fresh disposable page. No model
            // or connector operation was sent on the failed first page.
            continue;
          }
          recordPreparationFailure(error, stage);
          if (!(error instanceof ChatGptConnectorCatalogUnavailableError) || attempt >= 2 || signal?.aborted) throw error;
          emitDiagnosticEvent("chatgpt_tela_connector", "catalog_refresh", { attempt });
        } finally {
          await input.browserHost.release(surface.leaseId);
        }
      }
      throw new Error("ChatGPT Web preparation exhausted unexpectedly");
    },
    async probeChatGptAccount(signal?: AbortSignal) {
      requireOpen();
      signal?.throwIfAborted();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-account-observation", epochId: `account-${randomUUID()}`,
      });
      try {
        signal?.throwIfAborted();
        return await accountIdentityObserver(lease, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async probeChatGptAccountDisplay(signal?: AbortSignal) {
      requireOpen();
      signal?.throwIfAborted();
      const lease = await input.browserHost.acquire({ taskId: "chatgpt-tela-account-display", epochId: `display-${randomUUID()}` });
      try {
        return await (input.diagnosticProfileFingerprint
          ? withDiagnosticContext({ profile_fingerprint: input.diagnosticProfileFingerprint }, () => observeChatGptAccountDisplay(lease, signal))
          : observeChatGptAccountDisplay(lease, signal));
      }
      finally { await input.browserHost.release(lease.leaseId); }
    },
    async probeChatGptReadiness(signal?: AbortSignal) {
      requireOpen();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-profile-readiness",
        epochId: `readiness-${randomUUID()}`,
      });
      try {
        return await proveReadiness(lease, input.provider, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async probeChatGptProfile(signal?: AbortSignal) {
      requireOpen();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-profile-identity",
        epochId: `identity-${randomUUID()}`,
      });
      try {
        return await proveProfile(lease, input.provider, accountIdentityObserver, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    probeChatGptConnector(signal?: AbortSignal) {
      return withConnectorSurface(signal, async (_surface, connector) => connector);
    },
    probeChatGptConnection(signal?: AbortSignal, onConnectorProven?: () => void) {
      return withConnectorSurface(signal, async (surface, connector) => {
        // probeConnector settles removal of its own draft/pill before resolving. Recheck the
        // clean isolated surface rather than create another page with the same ownership.
        onConnectorProven?.();
        const capabilities = await proveReadiness(surface, input.provider, signal);
        signal?.throwIfAborted();
        return Object.freeze({ connector, capabilities });
      });
    },
    async recoverChatGptConnectorProbeArtifact(
      signal?: AbortSignal,
      options: { readonly allowUnknownSelectedConnector?: boolean } = {},
    ) {
      requireOpen();
      if (!input.provider.recoverConnectorProbeArtifact) {
        throw new Error("ChatGPT provider does not support connector artifact recovery");
      }
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-connector-recovery",
        epochId: `connector-recovery-${randomUUID()}`,
      });
      try {
        return await input.provider.recoverConnectorProbeArtifact(lease, signal, options);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async openProfileSetupSurface(options: { readonly reveal?: boolean } = {}) {
      requireOpen();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-profile-setup",
        epochId: `setup-${randomUUID()}`,
      });
      try {
        if (options.reveal !== false) {
          lease.capability(BROWSER_INSPECTION_INPUT)?.setInteractive(true);
        }
        if (options.reveal !== false) await lease.reveal();
      } catch (error) {
        await input.browserHost.release(lease.leaseId).catch(() => {});
        throw error;
      }
      setupLeases.add(lease.leaseId);
      let surfaceClosed = false;
      const subscriptions = new Set<() => void>();
      const requireSurfaceOpen = (): void => {
        if (surfaceClosed || !setupLeases.has(lease.leaseId)) {
          throw new Error("ChatGPT profile setup surface is closed");
        }
      };
      return Object.freeze({
        leaseId: lease.leaseId,
        onUserHide(observer: () => void) {
          requireSurfaceOpen();
          const events = lease.capability(BROWSER_USER_HIDE);
          if (!events) throw new Error("owned browser does not expose user-close observation");
          const unsubscribe = events.onUserHide(observer);
          subscriptions.add(unsubscribe);
          return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
        },
        async probeChatGptReadiness(signal?: AbortSignal) {
          requireSurfaceOpen();
          return proveReadiness(lease, input.provider, signal);
        },
        async probeChatGptProfile(signal?: AbortSignal) {
          requireSurfaceOpen();
          return proveProfile(lease, input.provider, accountIdentityObserver, signal);
        },
        async probeChatGptHistoryUi() {
          requireSurfaceOpen();
          return observeChatGptHistoryUi(lease, AbortSignal.timeout(8_000));
        },
        async runSavedChatDeleteAcceptance() {
          requireSurfaceOpen();
          return exerciseSavedChatCreateAndDelete(lease);
        },
        async recoverSyntheticSavedChat() {
          requireSurfaceOpen();
          return recoverAndDeleteSyntheticSavedChat(lease);
        },
        async reveal() {
          requireSurfaceOpen();
          lease.capability(BROWSER_INSPECTION_INPUT)?.setInteractive(true);
          await lease.reveal();
        },
        async close() {
          if (surfaceClosed) return;
          surfaceClosed = true;
          for (const unsubscribe of subscriptions) unsubscribe();
          subscriptions.clear();
          if (!setupLeases.delete(lease.leaseId)) return;
          await input.browserHost.release(lease.leaseId);
        },
      });
    },
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      closing = (async () => {
        const leases = [...setupLeases];
        setupLeases.clear();
        const results = await Promise.allSettled(leases.map(leaseId => input.browserHost.release(leaseId)));
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        closed = true;
        if (failures.length > 0) {
          throw new AggregateError(failures, `${failures.length} ChatGPT profile-control surface(s) failed to close`);
        }
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  });
}
