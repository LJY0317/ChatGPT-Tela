import type { BrowserHost } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  ChatGptSemanticProvider,
  selectChatGptWebModel,
  type ChatGptWebEffort,
  type ChatGptWebPhysicalLimits,
  type WebConversationProvider,
  type WebPhysicalContext,
} from "@chatgpt-tela/chatgpt";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  startLocalResponsesServer,
  type LocalResponsesAuthentication,
  type LocalResponsesRequestRouter,
  type LocalResponsesServer,
} from "@chatgpt-tela/local-server";
import {
  connectCodexBridgeMcpServer,
  connectDevelopmentMcpServer,
  type CodexBridgeMcpConnection,
  type CodexBridgeMcpExposureFactory,
  type CodexBridgeMcpHttpAuthentication,
  type CodexBridgeMcpHttpExposure,
  type CodexBridgeMcpTransport,
  type DevelopmentMcpConnection,
  type DevelopmentMcpExposureFactory,
  type DevelopmentMcpHttpAuthentication,
  type DevelopmentMcpHttpExposure,
  type DevelopmentMcpTransport,
  startCodexBridgeMcpHttpExposure,
  startDevelopmentMcpHttpExposure,
} from "@chatgpt-tela/mcp";
import {
  ActiveTurnRegistry,
  NativeResponsesGateway,
  RetainedBrowserEpochRegistry,
  runBrowserTurnOnSurface,
  type RegisteredTurn,
} from "@chatgpt-tela/runtime";

export type DevelopmentWebTurnSettlement =
  | { readonly status: "completed"; readonly answer: string }
  | { readonly status: "failed" };

export interface DevelopmentWebTurnPlan {
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly physicalContext: WebPhysicalContext;
  readonly browserModel?: {
    readonly familyKey: string;
    readonly effort: ChatGptWebEffort;
  };
  readonly physicalLimits?: ChatGptWebPhysicalLimits;
  readonly diagnostics?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Planner-owned transactional settlement. Implementations may advance retained-context state only
   * after a completed Web answer; failed/ambiguous turns must leave the prior committed state intact.
   */
  readonly settle?: (outcome: DevelopmentWebTurnSettlement) => void;
}

export type DevelopmentWebTurnPlanner = (
  turn: RegisteredTurn,
  nativeRequest: unknown,
) => Promise<DevelopmentWebTurnPlan> | DevelopmentWebTurnPlan;

export interface DevelopmentRuntime {
  readonly responses: LocalResponsesServer;
  readonly mcp: DevelopmentMcpRuntime;
  readonly turns: ActiveTurnRegistry;
  stop(): Promise<void>;
}

export type DevelopmentMcpAbi = "development" | "stable";
export type ExternalDevelopmentMcpAbi = DevelopmentMcpAbi;

export type DevelopmentMcpConfiguration =
  | {
      readonly kind: "external";
      readonly abi: ExternalDevelopmentMcpAbi;
    }
  | {
      readonly kind: "transport";
      readonly abi?: DevelopmentMcpAbi;
      readonly transport: DevelopmentMcpTransport | CodexBridgeMcpTransport;
    }
  | {
      readonly kind: "http-exposure";
      readonly abi?: DevelopmentMcpAbi;
      readonly exposure: DevelopmentMcpExposureFactory | CodexBridgeMcpExposureFactory;
      readonly local?: {
        readonly hostname?: string;
        readonly port?: number;
        readonly path?: string;
        readonly authentication?: DevelopmentMcpHttpAuthentication | CodexBridgeMcpHttpAuthentication;
        readonly maxRequestBodyBytes?: number;
        readonly maxSessions?: number;
      };
      readonly allowUnauthenticatedPublicEndpoint?: boolean;
    };

export type DevelopmentMcpRuntime =
  | {
      readonly kind: "external";
      readonly abi: ExternalDevelopmentMcpAbi;
      close(): Promise<void>;
    }
  | {
      readonly kind: "transport";
      readonly abi: DevelopmentMcpAbi;
      readonly connection: DevelopmentMcpConnection | CodexBridgeMcpConnection;
      close(): Promise<void>;
    }
  | {
      readonly kind: "http-exposure";
      readonly abi: DevelopmentMcpAbi;
      readonly exposure: DevelopmentMcpHttpExposure | CodexBridgeMcpHttpExposure;
      close(): Promise<void>;
    };

export interface DevelopmentRuntimeOptions {
  readonly currentTurnSource: CanonicalCurrentTurnSource;
  readonly browserHost: BrowserHost;
  readonly turns?: ActiveTurnRegistry;
  readonly mcp: DevelopmentMcpConfiguration;
  readonly planWebTurn: DevelopmentWebTurnPlanner;
  readonly provider?: WebConversationProvider;
  /** Optional per-Web-turn deadline used by bounded development/canary runs. */
  readonly webTurnTimeoutMs?: number;
  readonly responses?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly runtimeToken?: string;
    readonly authentication?: LocalResponsesAuthentication;
    readonly requestRouter?: LocalResponsesRequestRouter;
    readonly maxRequestBodyBytes?: number;
  };
}

/**
 * Compose ChatGPT Tela's current development execution path under one lifecycle owner.
 *
 * Ownership transfers to this runtime on successful start: the local Native endpoint, development
 * MCP connection, browser host, active-turn registry, and every launched Web turn are stopped
 * together. The caller supplies only canonical Native authority, a browser host implementation, an
 * MCP transport/exposure, and an explicit physical-context plan for each newly bound turn.
 */
export async function startDevelopmentRuntime(input: DevelopmentRuntimeOptions): Promise<DevelopmentRuntime> {
  if (input.webTurnTimeoutMs !== undefined
    && (!Number.isSafeInteger(input.webTurnTimeoutMs) || input.webTurnTimeoutMs < 1)) {
    throw new Error("development Web turn timeout must be a positive safe integer");
  }
  const turns = input.turns ?? new ActiveTurnRegistry();
  const webMcpContract: ExternalDevelopmentMcpAbi = input.mcp.abi ?? "development";
  const provider = input.provider ?? new ChatGptSemanticProvider();
  const abortController = new AbortController();
  const webRuns = new Set<Promise<unknown>>();
  const browserEpochs = new RetainedBrowserEpochRegistry(input.browserHost);

  const startWebTurn = (turn: RegisteredTurn, nativeRequest: unknown): Promise<unknown> => {
    const run = (async () => {
      const plan = await input.planWebTurn(turn, nativeRequest);
      const execute = async (signal: AbortSignal): Promise<string> => {
        let acquired: Awaited<ReturnType<RetainedBrowserEpochRegistry["acquire"]>> | undefined;
        try {
          acquired = await browserEpochs.acquire(plan.nativeTaskId, plan.webEpochId);
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_plan", {
            context_mode: plan.physicalContext.mode,
            logical_tokens: plan.physicalContext.logicalTokens,
            transfer_tokens: plan.physicalContext.transferTokens,
            retained_surface: acquired.reused,
            ...(plan.diagnostics ?? {}),
          });
          const answer = await runBrowserTurnOnSurface({
            surface: acquired.surface,
            provider,
            channel: turn.channel,
            nativeTaskId: plan.nativeTaskId,
            webEpochId: plan.webEpochId,
            physicalContext: plan.physicalContext,
            ...(plan.physicalLimits ? { physicalLimits: plan.physicalLimits } : {}),
            toolBridge: {
              protocol: "mcp",
              contract: webMcpContract,
              turnCapability: turn.capability,
            },
            proveCapabilities: !acquired.reused,
            ...(plan.browserModel ? {
              prepareForSubmit: (surface, signal) => selectChatGptWebModel(
                surface,
                plan.browserModel!,
                signal,
              ),
            } : {}),
            signal,
          });
          plan.settle?.({ status: "completed", answer });
          browserEpochs.complete(plan.nativeTaskId, plan.webEpochId);
          return answer;
        } catch (error) {
          plan.settle?.({ status: "failed" });
          if (acquired) {
            try {
              await browserEpochs.fail(plan.nativeTaskId, plan.webEpochId);
            } catch (releaseError) {
              throw new AggregateError(
                [error, releaseError],
                "Web turn failed and its retained browser surface could not be retired",
              );
            }
          }
          throw error;
        }
      };
      if (input.webTurnTimeoutMs === undefined) {
        return execute(abortController.signal);
      }

      const turnController = new AbortController();
      const forwardRuntimeAbort = () => turnController.abort(abortController.signal.reason);
      if (abortController.signal.aborted) forwardRuntimeAbort();
      else abortController.signal.addEventListener("abort", forwardRuntimeAbort, { once: true });
      const timeout = setTimeout(() => {
        turnController.abort(new Error(
          `development Web turn timed out after ${input.webTurnTimeoutMs}ms`,
        ));
      }, input.webTurnTimeoutMs);
      try {
        return await execute(turnController.signal);
      } finally {
        clearTimeout(timeout);
        abortController.signal.removeEventListener("abort", forwardRuntimeAbort);
      }
    })();
    webRuns.add(run);
    void run.finally(() => webRuns.delete(run)).catch(() => {});
    return run;
  };

  const gateway = new NativeResponsesGateway(input.currentTurnSource, turns, startWebTurn);
  let mcp: DevelopmentMcpRuntime | undefined;
  let responses: LocalResponsesServer | undefined;

  try {
    if (input.mcp.kind === "external") {
      mcp = Object.freeze({
        kind: "external" as const,
        abi: webMcpContract,
        async close() {},
      });
    } else if (input.mcp.kind === "transport") {
      const hostedAbi = input.mcp.abi ?? "development";
      const connection = hostedAbi === "stable"
        ? await connectCodexBridgeMcpServer(turns, input.mcp.transport)
        : await connectDevelopmentMcpServer(turns, input.mcp.transport);
      mcp = Object.freeze({
        kind: "transport" as const,
        abi: hostedAbi,
        connection,
        close: () => connection.close(),
      });
    } else {
      const hostedAbi = input.mcp.abi ?? "development";
      const exposure = await (hostedAbi === "stable"
        ? startCodexBridgeMcpHttpExposure
        : startDevelopmentMcpHttpExposure)({
        turns,
        exposure: input.mcp.exposure,
        ...(input.mcp.local ? { local: input.mcp.local } : {}),
        ...(input.mcp.allowUnauthenticatedPublicEndpoint === true
          ? { allowUnauthenticatedPublicEndpoint: true }
          : {}),
        signal: abortController.signal,
      });
      mcp = Object.freeze({
        kind: "http-exposure" as const,
        abi: hostedAbi,
        exposure,
        close: () => exposure.close(),
      });
    }
    responses = await startLocalResponsesServer({
      gateway,
      ...(input.responses?.hostname ? { hostname: input.responses.hostname } : {}),
      ...(input.responses?.port !== undefined ? { port: input.responses.port } : {}),
      ...(input.responses?.runtimeToken ? { runtimeToken: input.responses.runtimeToken } : {}),
      ...(input.responses?.authentication ? { authentication: input.responses.authentication } : {}),
      ...(input.responses?.requestRouter ? { requestRouter: input.responses.requestRouter } : {}),
      ...(input.responses?.maxRequestBodyBytes !== undefined
        ? { maxRequestBodyBytes: input.responses.maxRequestBodyBytes }
        : {}),
    });
  } catch (error) {
    abortController.abort(error);
    turns.cancelAll(error);
    await Promise.allSettled([
      ...(mcp ? [mcp.close()] : []),
      input.browserHost.close(),
      ...webRuns,
    ]);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return Object.freeze({
    responses,
    mcp,
    turns,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        const reason = new Error("ChatGPT Tela development runtime stopped");
        await responses.stop();
        abortController.abort(reason);
        turns.cancelAll(reason);
        await Promise.allSettled([
          mcp.close(),
          input.browserHost.close(),
          ...webRuns,
        ]);
      })();
      return stopping;
    },
  });
}
