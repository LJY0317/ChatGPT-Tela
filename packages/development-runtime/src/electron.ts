import { randomUUID } from "node:crypto";
import {
  createElectronMainProcessBrowserHost,
  type ElectronMainRuntimeLike,
} from "@chatgpt-tela/electron-host";
import {
  ChatGptSemanticProvider,
  type ChatGptAccountIdentity,
  type ChatGptCapabilities,
  type ChatGptConnectorObservation,
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
  recoverChatGptConnectorProbeArtifact(signal?: AbortSignal): Promise<boolean>;
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
  readonly webTurnTimeoutMs?: number;
  readonly accountIdentityObserver?: ChatGptAccountIdentityObserver;
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
  });
  const checkpointCache = input.context?.checkpointCache;
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
    recoverChatGptConnectorProbeArtifact: (signal?: AbortSignal) => (
      profileControl.recoverChatGptConnectorProbeArtifact(signal)
    ),
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
