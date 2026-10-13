import { BROWSER_DOCUMENT_LIFETIME, captureBrowserDiagnosticEvidence, type BrowserHost } from "@chatgpt-tela/browser-host";
import { classifyNetworkFailure, diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext, observeDiagnosticInventory, observeDiagnosticContextPressure, capturePrivateDiagnosticValue } from "@chatgpt-tela/core";
import {
  ChatGptSemanticProvider,
  selectChatGptWebModel,
  type ChatGptContextAttachment,
  type ChatGptWebEffort,
  type ChatGptWebPhysicalLimits,
  type WebConversationProvider,
  type WebPhysicalContext,
} from "@chatgpt-tela/chatgpt";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import { classifyWebPreparationFailure } from "./web-preparation-diagnostics";
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
  | { readonly status: "completed"; readonly answer: string; readonly surfaceLeaseId: string; readonly documentGeneration?: number }
  | { readonly status: "failed" };

export interface DevelopmentWebTurnPlan {
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly physicalContext: WebPhysicalContext;
  /** Exact physical owner of the committed prefix; required for retained-delta submission. */
  readonly retainedSurfaceLeaseId?: string;
  readonly retainedDocumentGeneration?: number;
  readonly contextAttachment?: ChatGptContextAttachment;
  readonly media?: readonly import("@chatgpt-tela/chatgpt").WebTurnMedia[];
  readonly browserModel?: {
    readonly familyKey: string;
    readonly effort: ChatGptWebEffort;
  };
  readonly physicalLimits?: ChatGptWebPhysicalLimits;
  readonly diagnostics?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Planner-owned transactional settlement. Implementations may advance retained-context state only
   * after a completed Web answer bound to its physical surface. Failed/ambiguous turns invalidate
   * the transport anchor; canonical Native history remains the reconstruction authority.
   */
  readonly settle?: (outcome: DevelopmentWebTurnSettlement) => void;
}

export type DevelopmentWebTurnPlanner = (
  turn: RegisteredTurn,
  nativeRequest: unknown,
  preparation?: { readonly signal: AbortSignal; readonly onProgress: (summary: string) => void },
) => Promise<DevelopmentWebTurnPlan> | DevelopmentWebTurnPlan;

export type RetiringDevelopmentWebTurnPlanner = DevelopmentWebTurnPlanner & {
  readonly retireSurface: (nativeTaskId: string, surfaceLeaseId: string) => void;
};

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
  /** Optional measured policy; requires coordinated planner retirement, never evicts busy turns. */
  readonly maxIdleBrowserEpochs?: number;
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
  const planner = input.planWebTurn as DevelopmentWebTurnPlanner & Partial<RetiringDevelopmentWebTurnPlanner>;
  if (input.maxIdleBrowserEpochs !== undefined && typeof planner.retireSurface !== "function") {
    throw new Error("bounded browser retention requires coordinated planner retirement");
  }
  const browserEpochs = new RetainedBrowserEpochRegistry(input.browserHost, {
    ...(input.maxIdleBrowserEpochs !== undefined ? { maxIdleEpochs: input.maxIdleBrowserEpochs } : {}),
    ...(planner.retireSurface ? { onRetire: (taskId: string, leaseId: string) => planner.retireSurface!(taskId, leaseId) } : {}),
  });

  const startWebTurn = (turn: RegisteredTurn, nativeRequest: unknown): Promise<unknown> => {
    const run = (async () => {
      const authority = turn.channel.binding.authority;
      const preparationStartedAt = Date.now();
      let preparationPhase = "native_watch";
      let executionStarted = false;
      let watch: Awaited<ReturnType<NonNullable<CanonicalCurrentTurnSource["watchTurn"]>>> = undefined;
      try {
      watch = await input.currentTurnSource.watchTurn?.(authority.threadId, authority.turnId, abortController.signal);
      const nativeSignal = watch ? AbortSignal.any([abortController.signal, watch.signal]) : abortController.signal;
      nativeSignal.throwIfAborted();
      preparationPhase = "context_plan";
      const plan = await input.planWebTurn(turn, nativeRequest, { signal: nativeSignal, onProgress: summary => turn.channel.publishProgress(summary) });
      // Planning may successfully reserve the task's transactional context
      // before the original Native owner revokes its signal. This boundary is
      // still pre-execution, so the browser catch/settlement path has not been
      // entered. Release the reserved plan rather than poisoning the next
      // independently authorized Native turn with an unsettled transaction.
      if (nativeSignal.aborted) {
        plan.settle?.({ status: "failed" });
        nativeSignal.throwIfAborted();
      }
      executionStarted = true;
      const startedAt = Date.now();
      const diagnosticIdentity = {
        scope_fingerprint: diagnosticFingerprint(plan.nativeTaskId),
        turn_fingerprint: diagnosticFingerprint(turn.channel.binding.authority.turnId),
        operation_fingerprint: diagnosticFingerprint([
          plan.nativeTaskId, turn.channel.binding.authority.turnId, plan.webEpochId,
        ].join("\n")),
      };
      const execute = (signal: AbortSignal): Promise<string> => withDiagnosticContext(diagnosticIdentity, async () => {
        capturePrivateDiagnosticValue("web_context",plan.physicalContext);
        observeDiagnosticInventory(plan.nativeTaskId, turn.channel.binding.tools.list());
        const diagnosticToolResults = plan.physicalContext.segments.filter(segment => segment.type === "revision" && segment.kind === "tool-result");
        observeDiagnosticContextPressure(plan.nativeTaskId, plan.physicalContext.logicalTokens,
          plan.physicalContext.segments.length, plan.physicalContext.segments.some(segment => segment.type === "checkpoint"), {
            toolResultCount: diagnosticToolResults.length,
            toolResultBytes: diagnosticToolResults.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0),
          });
        let acquired: Awaited<ReturnType<RetainedBrowserEpochRegistry["acquire"]>> | undefined;
        try {
          acquired = await browserEpochs.acquire(plan.nativeTaskId, plan.webEpochId);
          const document = acquired.surface.capability(BROWSER_DOCUMENT_LIFETIME)?.current();
          if (plan.physicalContext.mode === "retained-delta"
            && (!acquired.reused || plan.retainedSurfaceLeaseId !== acquired.surface.leaseId
              || !document || document.signal.aborted
              || plan.retainedDocumentGeneration !== document.generation)) {
            throw new Error("retained Web context does not own the surviving physical surface");
          }
          const executionSignal = document ? AbortSignal.any([signal, document.signal]) : signal;
          executionSignal.throwIfAborted();
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_plan", {
            ...diagnosticIdentity,
            context_mode: plan.physicalContext.mode,
            logical_estimate: plan.physicalContext.logicalTokens,
            transfer_estimate: plan.physicalContext.transferTokens,
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
            ...(plan.contextAttachment ? { contextAttachment: plan.contextAttachment } : {}),
            ...(plan.media ? { media: plan.media } : {}),
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
            signal: executionSignal,
          });
          executionSignal.throwIfAborted();
          const surfaceLeaseId = acquired.surface.leaseId;
          await browserEpochs.complete(plan.nativeTaskId, plan.webEpochId, () => {
            plan.settle?.({ status: "completed", answer, surfaceLeaseId,
              ...(document ? { documentGeneration: document.generation } : {}),
            });
          });
          return answer;
        } catch (error) {
          if (acquired) await captureBrowserDiagnosticEvidence(acquired.surface, "turn_failure");
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_failed", {
            ...diagnosticIdentity,
            duration_ms: diagnosticDurationMs(startedAt),
            turn_phase: turn.channel.phase,
            tool_round_count: turn.channel.toolRoundCount,
            network_kind: classifyNetworkFailure(error),
          });
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
      });
      if (input.webTurnTimeoutMs === undefined) {
        return await execute(nativeSignal);
      }

      const turnController = new AbortController();
      const forwardRuntimeAbort = () => turnController.abort(nativeSignal.reason);
      if (nativeSignal.aborted) forwardRuntimeAbort();
      else nativeSignal.addEventListener("abort", forwardRuntimeAbort, { once: true });
      const timeout = setTimeout(() => {
        const state = turn.channel.state();
        emitDiagnosticEvent("chatgpt_tela_work", "web_turn_timeout", {
          ...diagnosticIdentity,
          duration_ms: diagnosticDurationMs(startedAt),
          deadline_ms: input.webTurnTimeoutMs!,
          turn_phase: state.phase,
          tool_round_count: state.toolRoundCount,
          tool_pending: state.outstandingToolCallId !== undefined,
          native_result_ready: state.nativeResultReady === true,
        });
        turnController.abort(new Error(
          `development Web turn timed out after ${input.webTurnTimeoutMs}ms`,
        ));
      }, input.webTurnTimeoutMs);
      try {
        return await execute(turnController.signal);
      } finally {
        clearTimeout(timeout);
        nativeSignal.removeEventListener("abort", forwardRuntimeAbort);
      }
      } catch (error) {
        if (!executionStarted) withDiagnosticContext({
          scope_fingerprint: diagnosticFingerprint(authority.threadId),
          turn_fingerprint: diagnosticFingerprint(authority.turnId),
        }, () => {
          capturePrivateDiagnosticValue("web_preparation_failure", {
            phase: preparationPhase, request: nativeRequest,
            error: error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown" },
          });
          emitDiagnosticEvent("chatgpt_tela_work", "web_preparation_failed", {
            phase: preparationPhase, reason_class: classifyWebPreparationFailure(error),
            network_kind: classifyNetworkFailure(error),
            duration_ms: diagnosticDurationMs(preparationStartedAt),
            turn_phase: turn.channel.phase, tool_round_count: turn.channel.toolRoundCount,
          });
        });
        throw error;
      } finally {
        if (watch?.signal.aborted) {
          const phase = turn.channel.phase;
          if (!["completed", "cancelled", "failed-before-acceptance", "indeterminate-after-acceptance"].includes(phase)) {
            turn.channel.cancel(watch.signal.reason);
          }
          if (turns.active(authority.threadId, authority.turnId)?.capability === turn.capability) {
            turns.retire(turn.capability);
          }
        }
        await watch?.close();
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
