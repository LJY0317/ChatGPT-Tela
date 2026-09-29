import { randomUUID } from "node:crypto";
import {
  BROWSER_READ_ONLY_PREVIEW,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import {
  createElectronMainProcessBrowserHost,
  type ElectronMainRuntimeLike,
} from "@chatgpt-tela/electron-host";
import {
  ChatGptSemanticProvider,
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
import { runBrowserContextCheckpoint, type ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import type { ContextCheckpointCache } from "./context-cache";
import {
  startDevelopmentRuntime,
  type DevelopmentMcpConfiguration,
  type DevelopmentRuntime,
  type DevelopmentWebTurnPlanner,
} from "./runtime";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";
import {
  createChatGptProfileControl,
  type ChatGptAccountIdentityObserver,
  type ElectronProfileSetupSurface,
} from "./profile-control";

export interface ElectronDevelopmentRuntime extends DevelopmentRuntime {
  /**
   * Prove that the persistent ChatGPT profile currently exposes one usable composer/send surface.
   * The probe owns no Native turn and submits nothing.
   */
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<{
    readonly capabilities: ChatGptCapabilities;
    readonly account: ChatGptAccountIdentity;
  }>;
  probeChatGptConnector(signal?: AbortSignal): Promise<ChatGptConnectorObservation>;
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
   * A preview is returned only when exactly one task/epoch surface is active.
   */
  observeBridgePreview(): Promise<{
    readonly activeSurfaceCount: number;
    readonly jpeg?: Uint8Array;
  }>;
  /**
   * Open one visible control-plane ChatGPT surface using the same persistent ChatGPT Tela profile partition.
   * It owns no Native turn authority and exists only for login/developer-mode/connector preparation.
   */
  openProfileSetupSurface(options?: { readonly reveal?: boolean }): Promise<ElectronProfileSetupSurface>;
}

export interface ElectronDevelopmentRuntimeOptions {
  readonly profileId: string;
  readonly connectorName?: string;
  readonly currentTurnSource: CanonicalCurrentTurnSource;
  readonly turns?: ActiveTurnRegistry;
  readonly mcp: DevelopmentMcpConfiguration;
  readonly planWebTurn?: DevelopmentWebTurnPlanner;
  readonly context?: {
    readonly checkpointCache?: ContextCheckpointCache;
    readonly budgetTokens?: number;
  };
  readonly provider?: WebConversationProvider;
  readonly approvalAutomationMode?: import("@chatgpt-tela/chatgpt").ChatGptApprovalAutomationMode;
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

/**
 * Development desktop composition root.
 *
 * It creates only the Electron browser-host implementation and delegates every correctness/lifecycle
 * rule to startDevelopmentRuntime. Launcher UI can wrap this later without becoming a second runtime.
 */
export async function startElectronDevelopmentRuntime(
  input: ElectronDevelopmentRuntimeOptions,
): Promise<ElectronDevelopmentRuntime> {
  const browserHost = await createElectronMainProcessBrowserHost({
    profileId: input.profileId,
    ...(input.electron?.userDataDir ? { userDataDir: input.electron.userDataDir } : {}),
    initialUrl: input.chatGptUrl ?? "https://chatgpt.com/",
    ...(input.electron?.window ? { window: input.electron.window } : {}),
    ...(input.electron?.loadRuntime ? { loadRuntime: input.electron.loadRuntime } : {}),
  });
  const provider = input.provider ?? new ChatGptSemanticProvider({
    ...(input.connectorName ? { connectorName: input.connectorName } : {}),
    ...(input.approvalAutomationMode ? { approvalAutomationMode: input.approvalAutomationMode } : {}),
  });
  const checkpointCache = input.context?.checkpointCache;
  const modelFamilyDiscovery = input.modelFamilyDiscovery ?? discoverWebModelFamilies;
  const modelSelectionCanary = input.modelSelectionCanary ?? probeWebModelSelection;
  const profileControl = createChatGptProfileControl({
    browserHost,
    provider,
    ...(input.accountIdentityObserver ? { accountIdentityObserver: input.accountIdentityObserver } : {}),
  });

  const runtime = await startDevelopmentRuntime({
    currentTurnSource: input.currentTurnSource,
    browserHost,
    ...(input.turns ? { turns: input.turns } : {}),
    mcp: input.mcp,
    planWebTurn: input.planWebTurn ?? createNativeRequestDevelopmentWebTurnPlanner({
      ...(checkpointCache ? { checkpointCache } : {}),
      ...(input.context?.budgetTokens !== undefined ? { budgetTokens: input.context.budgetTokens } : {}),
      ...(checkpointCache && input.checkpointProvider ? {
        checkpointProducer: async request => {
          const webEpochId = `checkpoint-${randomUUID()}`;
          const result = await runBrowserContextCheckpoint({
            browserHost,
            provider: input.checkpointProvider!,
            request: {
              nativeTaskId: request.nativeTaskId,
              webEpochId,
              sourceRevisionId: request.sourceRevisionId,
              physicalContext: request.physicalContext,
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
    ...(input.responses ? { responses: input.responses } : {}),
  });

  let stopping: Promise<void> | undefined;
  return Object.freeze({
    responses: runtime.responses,
    mcp: runtime.mcp,
    turns: runtime.turns,
    probeChatGptReadiness: (signal?: AbortSignal) => profileControl.probeChatGptReadiness(signal),
    probeChatGptProfile: (signal?: AbortSignal) => profileControl.probeChatGptProfile(signal),
    probeChatGptConnector: (signal?: AbortSignal) => profileControl.probeChatGptConnector(signal),
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
              "x".repeat(220_000),
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
    async observeBridgePreview() {
      const observed = browserHost.singleActiveCapability(BROWSER_READ_ONLY_PREVIEW);
      if (!observed.capability) return Object.freeze({ activeSurfaceCount: observed.activeSurfaceCount });
      return Object.freeze({
        activeSurfaceCount: observed.activeSurfaceCount,
        jpeg: await observed.capability.captureJpeg(),
      });
    },
    openProfileSetupSurface: (options?: { readonly reveal?: boolean }) => profileControl.openProfileSetupSurface(options),
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
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
