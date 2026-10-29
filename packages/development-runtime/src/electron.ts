import { randomUUID } from "node:crypto";
import {
  BROWSER_READ_ONLY_PREVIEW,
  BROWSER_INSPECTION_INPUT,
  BROWSER_PAGE_AUTOMATION,
  type BrowserHost,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  createElectronMainProcessBrowserHost,
  type ElectronMainRuntimeLike,
} from "@chatgpt-tela/electron-host";
import {
  CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS,
  ChatGptSemanticProvider,
  ChatGptDomSurfaceDriver,
  selectChatGptWebModel,
  isChatGptTemporaryChatUrl,
  createChatGptContextAttachment,
  discoverChatGptWebModelFamilies as discoverWebModelFamilies,
  probeChatGptWebModelSelection as probeWebModelSelection,
  requireProven,
  type ChatGptAccountIdentity,
  type ChatGptCapabilities,
  type ChatGptConnectorObservation,
  type ChatGptWebModelFamily,
  type ChatGptWebModelSelectionCanary,
  type WebConversationProvider,
  type WebContextCheckpointProvider,
} from "@chatgpt-tela/chatgpt";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import { ActiveTurnRegistry, settleNativeCompactionToolResult, runBrowserContextCheckpoint } from "@chatgpt-tela/runtime";
import type { ContextCheckpointCache } from "./context-cache";
import {
  startDevelopmentRuntime,
  type DevelopmentMcpConfiguration,
  type DevelopmentRuntime,
  type DevelopmentWebTurnPlanner,
} from "./runtime";
import { createNativeLocalCompactionRouter } from "./native-local-compaction";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";
import {
  createChatGptProfileControl,
  type ChatGptAccountIdentityObserver,
  type ElectronProfileSetupSurface,
  type ChatGptProfileControl,
} from "./profile-control";

export interface ElectronDevelopmentRuntime extends DevelopmentRuntime {
  /** On-demand session identity only; no composer input, submission, or sign-in mutation. */
  probeChatGptAccount: ChatGptProfileControl["probeChatGptAccount"];
  probeChatGptAccountDisplay: ChatGptProfileControl["probeChatGptAccountDisplay"];
  prepareChatGptWebSession: ChatGptProfileControl["prepareChatGptWebSession"];
  /**
   * Read-only observation of a usable empty ChatGPT composer.
   * The actual send control is verified only after the real request is filled.
   */
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<{
    readonly capabilities: ChatGptCapabilities;
    readonly account: ChatGptAccountIdentity;
  }>;
  probeChatGptConnector(signal?: AbortSignal): Promise<ChatGptConnectorObservation>;
  probeChatGptConnection(signal?: AbortSignal, onConnectorProven?: () => void): Promise<{
    readonly connector: ChatGptConnectorObservation;
    readonly capabilities: ChatGptCapabilities;
  }>;
  recoverChatGptConnectorProbeArtifact(
    signal?: AbortSignal,
    options?: { readonly allowUnknownSelectedConnector?: boolean },
  ): Promise<boolean>;
  /** Read the authenticated ChatGPT account's current selectable Web model families and efforts. */
  discoverChatGptWebModelFamilies(signal?: AbortSignal): Promise<readonly ChatGptWebModelFamily[]>;
  /** Non-submit exact model/effort selection + restoration canary on one disposable surface. */
  probeChatGptWebModelSelection(signal?: AbortSignal): Promise<ChatGptWebModelSelectionCanary>;
  /** Inert live canary for memory-backed attachment acceptance + exact receipt verification. */
  probeChatGptContextAttachment(signal?: AbortSignal): Promise<{
    readonly attachmentBytes: number;
    readonly receiptVerified: true;
  }>;
  /**
   * Observe the hidden bridge without revealing/focusing it or sending any page input.
   * Multiple surfaces require explicit selection of a currently owned lease.
   */
  revealBridgeSurface(id: string, interactive?: boolean): Promise<void>;
  bridgeSurfaces(): { readonly revision: number; readonly surfaces: readonly { readonly id: string; readonly label: string; readonly taskId: string }[] };
  onBridgeSurfacesChanged(listener: () => void): () => void;
  observeBridgePreview(id?: string): Promise<{
    readonly activeSurfaceCount: number;
    readonly surfaces?: readonly { readonly id: string; readonly label: string }[];
    readonly selectedSurfaceId?: string;
    readonly jpeg?: Uint8Array;
    readonly approvalState?: "pending" | "none" | "unavailable";
    readonly approvalObservationReason?: "automation_unavailable" | "dom_observation_failed";
    readonly approvalWait?: import("@chatgpt-tela/chatgpt").WebApprovalWaitProjection;
  }>;
  /**
   * Open one visible control-plane ChatGPT surface using the same persistent ChatGPT Tela profile partition.
   * It owns no Native turn authority and exists only for login/developer-mode/connector preparation.
   */
  openProfileSetupSurface(options?: { readonly reveal?: boolean }): Promise<ElectronProfileSetupSurface>;
}

export interface ElectronDevelopmentRuntimeOptions {
  readonly profileSlot?: number;
  readonly profileId: string;
  readonly connectorName?: string;
  readonly currentTurnSource: CanonicalCurrentTurnSource;
  readonly turns?: ActiveTurnRegistry;
  readonly mcp: DevelopmentMcpConfiguration;
  readonly planWebTurn?: DevelopmentWebTurnPlanner;
  readonly context?: {
    readonly checkpointCache?: ContextCheckpointCache;
    readonly historyCheckpointCache?: ContextCheckpointCache;
    readonly visiblePrefix?: NonNullable<Parameters<typeof createNativeRequestDevelopmentWebTurnPlanner>[0]>["visiblePrefix"];
    readonly budgetTokens?: number;
    readonly checkpointPreparationPolicy?: import("./checkpoint-preparation-budget").CheckpointPreparationPolicy;
  };
  readonly provider?: WebConversationProvider;
  readonly approvalAutomationMode?: import("@chatgpt-tela/chatgpt").ChatGptApprovalAutomationMode;
  readonly approvalAutomationDelayMs?: number;
  readonly webTurnTimeoutMs?: number;
  readonly accountIdentityObserver?: ChatGptAccountIdentityObserver;
  /** Test/provider seam; production uses the ChatGPT semantic model-picker implementation. */
  readonly modelFamilyDiscovery?: (
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ) => Promise<readonly ChatGptWebModelFamily[]>;
  readonly modelSelectionCanary?: (
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ) => Promise<ChatGptWebModelSelectionCanary>;
  /**
   * Explicit one-purpose checkpoint provider. The default ChatGPT turn provider is not reused
   * implicitly because ordinary assistant replies are not checkpoint authority.
   */
  readonly checkpointProvider?: WebContextCheckpointProvider;
  readonly compactionHistory?: NonNullable<Parameters<typeof createNativeRequestDevelopmentWebTurnPlanner>[0]>["compactionHistory"];
  readonly compactionAnchor?: NonNullable<Parameters<typeof createNativeRequestDevelopmentWebTurnPlanner>[0]>["compactionAnchor"];
  readonly nativeWebHandoff?: NonNullable<Parameters<typeof createNativeRequestDevelopmentWebTurnPlanner>[0]>["nativeWebHandoff"];
  readonly verifyNativeWebHandoff?: NonNullable<Parameters<typeof createNativeRequestDevelopmentWebTurnPlanner>[0]>["verifyNativeWebHandoff"];
  readonly chatGptUrl?: string;
  readonly responses?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly runtimeToken?: string;
    readonly authentication?: import("@chatgpt-tela/local-server").LocalResponsesAuthentication;
    readonly requestRouter?: import("@chatgpt-tela/local-server").LocalResponsesRequestRouter;
    readonly maxRequestBodyBytes?: number;
  };
  readonly electron?: {
    readonly userDataDir?: string;
    readonly loadRuntime?: () => Promise<ElectronMainRuntimeLike>;
    readonly window?: {
      readonly width?: number;
      readonly height?: number;
      readonly minWidth?: number;
      readonly minHeight?: number;
      readonly title?: string;
    };
  };
}

/** Classify all acquired pages at the one browser-host seam, including zero-model-call probes.
 * These are surface counters, NOT billing or a second execution/retry ledger. */
function webSurfacePurpose(input: { taskId: string; epochId: string }):
  "task" | "summary" | "account_probe" | "profile_probe" | "profile_setup" {
  if (input.epochId.startsWith("checkpoint-") || input.epochId.startsWith("native-compact-")) {
    return "summary";
  }
  if (input.taskId === "chatgpt-tela-account-observation"
    || input.taskId === "chatgpt-tela-account-display") return "account_probe";
  if (input.taskId === "chatgpt-tela-profile-setup") return "profile_setup";
  if (input.taskId.startsWith("chatgpt-tela-")
    || input.taskId.startsWith("profile-")) return "profile_probe";
  return "task";
}

function countedWebSurfaceHost(
  physical: Awaited<ReturnType<typeof createElectronMainProcessBrowserHost>>,
): BrowserHost & Pick<typeof physical, "selectedCapability" | "selectedSurfaceLease" | "listSurfaces" | "revealSurface" | "surfaceRevision" | "onSurfacesChanged"> {
  let total = 0;
  const perPurpose = new Map<ReturnType<typeof webSurfacePurpose>, number>();
  return Object.freeze({
    async acquire(input: { taskId: string; epochId: string }) {
      // Count only successfully owned acquisitions; a host failure may still
      // create an unowned partial OS window and remains unknown.
      const lease = await physical.acquire(input);
      const purpose = webSurfacePurpose(input);
      total++;
      const purposeCount = (perPurpose.get(purpose) ?? 0) + 1;
      perPurpose.set(purpose, purposeCount);
      emitDiagnosticEvent("chatgpt_tela_work", "web_surface_acquired", {
        kind: purpose, surface_total: total, purpose_count: purposeCount,
        model_send_possible: purpose === "task" || purpose === "summary",
        evidence_class: "owned_browser_lease",
      });
      return lease;
    },
    release: (leaseId: string) => physical.release(leaseId),
    close: () => physical.close(),
    // The Electron composition's inspection UI is read-only and retains its
    // existing capabilities; acquisition telemetry must never hide them.
    selectedCapability: physical.selectedCapability.bind(physical),
    selectedSurfaceLease: physical.selectedSurfaceLease.bind(physical),
    listSurfaces: () => physical.listSurfaces(),
    get surfaceRevision() { return physical.surfaceRevision; },
    onSurfacesChanged: (listener: () => void) => physical.onSurfacesChanged(listener),
    revealSurface: (leaseId: string) => physical.revealSurface(leaseId),
  });
}

/**
 * Development desktop composition root.
 *
 * It creates only the Electron browser-host implementation and delegates every correctness/lifecycle
 * rule to startDevelopmentRuntime. Launcher UI can wrap this later without becoming a second runtime.
 */
export async function startElectronDevelopmentRuntime(
  input: ElectronDevelopmentRuntimeOptions,
): Promise<ElectronDevelopmentRuntime> {
  const browserHost = countedWebSurfaceHost(await createElectronMainProcessBrowserHost({
    profileId: input.profileId,
    ...(input.electron?.userDataDir ? { userDataDir: input.electron.userDataDir } : {}),
    initialUrl: input.chatGptUrl ?? "https://chatgpt.com/",
    ...(input.electron?.window ? { window: input.electron.window } : {}),
    ...(input.electron?.loadRuntime ? { loadRuntime: input.electron.loadRuntime } : {}),
  }));
  const provider = input.provider ?? new ChatGptSemanticProvider({
    requireTemporaryChat: isChatGptTemporaryChatUrl(input.chatGptUrl ?? ""),
    ...(input.connectorName ? { connectorName: input.connectorName } : {}),
    ...(input.approvalAutomationMode ? { approvalAutomationMode: input.approvalAutomationMode } : {}),
    ...(input.approvalAutomationDelayMs !== undefined
      ? { approvalAutomationDelayMs: input.approvalAutomationDelayMs }
      : {}),
  });
  const checkpointCache = input.context?.checkpointCache;
  const historyCheckpointCache = input.context?.historyCheckpointCache;
  const modelFamilyDiscovery = input.modelFamilyDiscovery ?? discoverWebModelFamilies;
  const modelSelectionCanary = input.modelSelectionCanary ?? probeWebModelSelection;
  const profileControl = createChatGptProfileControl({
    browserHost,
    provider,
    modelFamilyDiscovery,
    diagnosticProfileFingerprint: diagnosticFingerprint(input.profileId),
    ...(input.accountIdentityObserver ? { accountIdentityObserver: input.accountIdentityObserver } : {}),
  });

  const checkpointController = new AbortController();
  const checkpointRuns = new Set<Promise<unknown>>();
  const runOwnedContextCheckpoint = (request: Parameters<typeof runBrowserContextCheckpoint>[0]) => {
    checkpointController.signal.throwIfAborted();
    const signal = request.signal
      ? AbortSignal.any([request.signal, checkpointController.signal]) : checkpointController.signal;
    const run = runBrowserContextCheckpoint({ ...request, signal });
    checkpointRuns.add(run);
    void run.finally(() => checkpointRuns.delete(run)).catch(() => {});
    return run;
  };

  const turns = input.turns ?? new ActiveTurnRegistry();
  const localCompactionRouter = input.checkpointProvider ? createNativeLocalCompactionRouter({
    source: input.currentTurnSource,
    settlePendingToolResult: (threadId, turnId, body) => settleNativeCompactionToolResult(turns, threadId, turnId, body),
    ...(checkpointCache ? { checkpointCache } : {}),
    ...(input.context?.checkpointPreparationPolicy ? { checkpointPreparationPolicy: input.context.checkpointPreparationPolicy } : {}),
    ...(input.context?.visiblePrefix ? { visiblePrefix: input.context.visiblePrefix } : {}),
    ...(input.compactionHistory ? { compactionHistory: input.compactionHistory } : {}),
    ...(input.compactionAnchor ? { compactionAnchor: input.compactionAnchor } : {}),
    ...(input.nativeWebHandoff ? { nativeWebHandoff: input.nativeWebHandoff } : {}),
    ...(input.verifyNativeWebHandoff ? { verifyNativeWebHandoff: input.verifyNativeWebHandoff } : {}),
    ...(historyCheckpointCache ? { historyCheckpointCache } : {}),
    summarize: async request => {
      const result = await runOwnedContextCheckpoint({
        browserHost, provider: input.checkpointProvider!,
        ...(request.persistResult ? { persistResult: async result => request.persistResult!({
          nativeTaskId: result.nativeTaskId, sourceRevisionId: result.sourceRevisionId, content: result.content,
        })} : {}),
        ...(input.webTurnTimeoutMs !== undefined
          ? { signal: AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(input.webTurnTimeoutMs)]) }
          : request.signal ? { signal: request.signal } : {}),
        prepareForSubmit: (surface, signal) => selectChatGptWebModel(surface, request.browserModel, signal),
        request: { nativeTaskId: request.nativeTaskId, webEpochId: `native-compact-${randomUUID()}`,
          sourceRevisionId: request.sourceRevisionId, physicalContext: request.physicalContext,
          ...(request.media ? { media: request.media } : {}) },
      });
      return result.content;
    },
  }) : undefined;

  const runtime = await startDevelopmentRuntime({
    ...(input.profileSlot !== undefined ? { profileSlot: input.profileSlot } : {}),
    currentTurnSource: input.currentTurnSource,
    browserHost,
    turns,
    mcp: input.mcp,
    planWebTurn: input.planWebTurn ?? createNativeRequestDevelopmentWebTurnPlanner({
      ...(localCompactionRouter ? { preparationBudgetFor: localCompactionRouter.preparationBudgetFor } : {}),
      ...(input.context?.visiblePrefix ? { visiblePrefix: input.context.visiblePrefix } : {}),
      ...(input.compactionHistory ? { compactionHistory: input.compactionHistory } : {}),
      ...(input.compactionAnchor ? { compactionAnchor: input.compactionAnchor } : {}),
      ...(input.nativeWebHandoff ? { nativeWebHandoff: input.nativeWebHandoff } : {}),
      ...(input.verifyNativeWebHandoff ? { verifyNativeWebHandoff: input.verifyNativeWebHandoff } : {}),
      ...(checkpointCache ? { checkpointCache } : {}),
      ...(historyCheckpointCache ? { historyCheckpointCache } : {}),
      ...(input.context?.budgetTokens !== undefined ? { budgetTokens: input.context.budgetTokens } : {}),
      ...(input.context?.checkpointPreparationPolicy ? { checkpointPreparationPolicy: input.context.checkpointPreparationPolicy } : {}),
      ...(checkpointCache && input.checkpointProvider ? {
        checkpointProducer: async (request, preparation) => {
          const webEpochId = `checkpoint-${randomUUID()}`;
          const result = await runOwnedContextCheckpoint({
            browserHost,
            provider: input.checkpointProvider!,
            ...(request.persistResult ? { persistResult: async result => request.persistResult!({
              nativeTaskId: result.nativeTaskId, sourceRevisionId: result.sourceRevisionId, content: result.content,
            })} : {}),
            ...(request.browserModel ? {
              prepareForSubmit: (surface, signal) => selectChatGptWebModel(surface, request.browserModel!, signal),
            } : {}),
            ...(input.webTurnTimeoutMs !== undefined
              ? { signal: AbortSignal.any([...(preparation ? [preparation.signal] : []), AbortSignal.timeout(input.webTurnTimeoutMs)]) }
              : preparation ? { signal: preparation.signal } : {}),
            ...(preparation ? { onProgress: preparation.onProgress } : {}),
            request: {
              nativeTaskId: request.nativeTaskId,
              webEpochId,
              sourceRevisionId: request.sourceRevisionId,
              physicalContext: request.physicalContext,
              ...(request.media ? { media: request.media } : {}),
            },
          });
          return Object.freeze({
            nativeTaskId: result.nativeTaskId,
            sourceRevisionId: result.sourceRevisionId,
            content: result.content,
          });
        },
      } : {}),
    }),
    provider,
    ...(input.webTurnTimeoutMs !== undefined ? { webTurnTimeoutMs: input.webTurnTimeoutMs } : {}),
    ...((input.responses || localCompactionRouter) ? { responses: {
      ...input.responses,
      requestRouter: async request => (await localCompactionRouter?.(request.clone()))
        ?? input.responses?.requestRouter?.(request),
    } } : {}),
  });

  let stopping: Promise<void> | undefined;
  return Object.freeze({
    responses: runtime.responses,
    mcp: runtime.mcp,
    turns: runtime.turns,
    prepareChatGptWebSession: (options: Parameters<ChatGptProfileControl["prepareChatGptWebSession"]>[0]) => profileControl.prepareChatGptWebSession(options),
    probeChatGptReadiness: (signal?: AbortSignal) => profileControl.probeChatGptReadiness(signal),
    probeChatGptProfile: (signal?: AbortSignal) => profileControl.probeChatGptProfile(signal),
    probeChatGptAccount: (signal?: AbortSignal) => profileControl.probeChatGptAccount(signal),
    probeChatGptAccountDisplay: (signal?: AbortSignal) => profileControl.probeChatGptAccountDisplay(signal),
    probeChatGptConnector: (signal?: AbortSignal) => profileControl.probeChatGptConnector(signal),
    probeChatGptConnection: (signal?: AbortSignal, onConnectorProven?: () => void) => profileControl.probeChatGptConnection(signal, onConnectorProven),
    recoverChatGptConnectorProbeArtifact: (
      signal?: AbortSignal,
      options?: { readonly allowUnknownSelectedConnector?: boolean },
    ) => (
      profileControl.recoverChatGptConnectorProbeArtifact(signal, options)
    ),
    async discoverChatGptWebModelFamilies(signal?: AbortSignal) {
      const epochId = `profile-model-catalog-${randomUUID()}`;
      const surface = await browserHost.acquire({
        taskId: `profile-model-catalog:${input.profileId}`,
        epochId,
      });
      try {
        return await modelFamilyDiscovery(surface, signal);
      } finally {
        await browserHost.release(surface.leaseId);
      }
    },
    async probeChatGptWebModelSelection(signal?: AbortSignal) {
      const epochId = `profile-model-canary-${randomUUID()}`;
      const surface = await browserHost.acquire({
        taskId: `profile-model-canary:${input.profileId}`,
        epochId,
      });
      try {
        return await modelSelectionCanary(surface, signal);
      } finally {
        await browserHost.release(surface.leaseId);
      }
    },
    async probeChatGptContextAttachment(signal?: AbortSignal) {
      const epochId = `profile-context-canary-${randomUUID()}`;
      const taskId = `profile-context-canary:${input.profileId}`;
      const surface = await browserHost.acquire({ taskId, epochId });
      try {
        const preload = provider.preloadContextAttachment;
        if (!preload) throw new Error("Web provider does not support context attachment preload");
        const attachment = createChatGptContextAttachment(Object.freeze({
          headRevisionId: "context-canary-r1",
          activeRequestRevisionId: "context-canary-r1",
          mode: "full" as const,
          logicalTokens: 12,
          transferTokens: 12,
          segments: Object.freeze([Object.freeze({
            type: "revision" as const,
            revisionId: "context-canary-r1",
            kind: "user" as const,
            content: [
              "ChatGPT Tela context attachment live canary. No task execution is requested.",
              "x".repeat(CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS),
            ].join("\n"),
          })]),
        }));
        const result = requireProven(await preload.call(provider, surface, {
          nativeTaskId: taskId,
          webEpochId: epochId,
          attachment,
        }, signal));
        if (result.nativeTaskId !== taskId
          || result.webEpochId !== epochId
          || result.attachmentName !== attachment.name
          || result.attachmentSha256 !== attachment.sha256) {
          throw new Error("context attachment canary receipt belongs to a different physical transaction");
        }
        return Object.freeze({
          attachmentBytes: Buffer.byteLength(attachment.contextJson, "utf8"),
          receiptVerified: true as const,
        });
      } finally {
        await browserHost.release(surface.leaseId);
      }
    },
    async revealBridgeSurface(id: string, interactive = false) {
      const controls = browserHost.selectedCapability(id, BROWSER_INSPECTION_INPUT);
      if (!controls) throw new Error("browser inspection input controls are unavailable");
      controls.setInteractive(interactive);
      await browserHost.revealSurface(id);
    },
    bridgeSurfaces: () => ({ revision: browserHost.surfaceRevision, surfaces: browserHost.listSurfaces() }),
    onBridgeSurfacesChanged: (listener: () => void) => browserHost.onSurfacesChanged(listener),
    async observeBridgePreview(id?: string) {
      const surfaces = browserHost.listSurfaces();
      const selected = id ?? (surfaces.length === 1 ? surfaces[0]!.id : undefined);
      const capability = selected ? browserHost.selectedCapability(selected, BROWSER_READ_ONLY_PREVIEW) : undefined;
      const automation = selected ? browserHost.selectedCapability(selected, BROWSER_PAGE_AUTOMATION) : undefined;
      let approvalState: "pending" | "none" | "unavailable" = "unavailable";
      let approvalObservationReason: "automation_unavailable" | "dom_observation_failed" | undefined;
      if (automation) {
        try {
          const observation = await new ChatGptDomSurfaceDriver(automation).observe();
          approvalState = observation.approval?.cardCount ? "pending" : "none";
        } catch {
          // Never interpret a failed DOM read as clearance or as authorization to click.
          approvalObservationReason = "dom_observation_failed";
        }
      } else if (selected) {
        approvalObservationReason = "automation_unavailable";
      }
      if (approvalObservationReason) {
        emitDiagnosticEvent("chatgpt_tela_work", "bridge_approval_observation_unavailable", {
          reason_class: approvalObservationReason,
        });
      }
      const approvalWait = selected ? provider.inspectApprovalWait?.(browserHost.selectedSurfaceLease(selected)) : undefined;
      return Object.freeze({ activeSurfaceCount: surfaces.length, surfaces,
        ...(selected ? { selectedSurfaceId: selected } : {}),
        ...(selected ? { approvalState } : {}),
        ...(approvalObservationReason ? { approvalObservationReason } : {}),
        ...(approvalWait ? { approvalWait } : {}),
        ...(capability ? { jpeg: await capability.captureJpeg() } : {}),
      });
    },
    openProfileSetupSurface: (options?: { readonly reveal?: boolean }) => profileControl.openProfileSetupSurface(options),
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        checkpointController.abort(new Error("Electron checkpoint runtime stopped"));
        await Promise.allSettled([...checkpointRuns]);
        const failures: unknown[] = [];
        try {
          await profileControl.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await runtime.stop();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Electron development runtime did not fully close owned state");
        }
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
  });
}
