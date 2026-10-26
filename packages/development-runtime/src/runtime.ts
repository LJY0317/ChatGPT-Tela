import { webObservationFailureReason } from "@chatgpt-tela/core";
import { WebContextFitFailed } from "@chatgpt-tela/core";
import { BROWSER_DOCUMENT_LIFETIME, captureBrowserDiagnosticEvidence, type BrowserHost } from "@chatgpt-tela/browser-host";
import { classifyNetworkFailure, diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext, observeDiagnosticInventory, observeDiagnosticContextPressure, capturePrivateDiagnosticValue, isWebContextPlannerStage, isWebContextPlannerSubstage, type WebContextPlannerStage, type WebContextPlannerSubstage } from "@chatgpt-tela/core";
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
import { classifyWebPreparationErrorKind, classifyWebPreparationFailure } from "./web-preparation-diagnostics";
import { failedNativeRequestFingerprint, type NativeProjectionError } from "./native-projection-diagnostics";
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
  assertWebMessageFitsComposer,
  runBrowserTurnOnSurface,
  type RegisteredTurn,
} from "@chatgpt-tela/runtime";

export type DevelopmentWebTurnSettlement =
  | { readonly status: "completed"; readonly answer: string; readonly surfaceLeaseId: string; readonly documentGeneration?: number;
    /** Actual Native result bytes delivered to the same Web generation; never Native logical history. */
    readonly releasedToolResultBytes?: number; readonly toolRoundCount?: number }
  | { readonly status: "preflight-rejected" }
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
  /** Disabled compatibility path for isolated historical Native tool roundtrips. */
  readonly legacyNativeToolBridge?: boolean;
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
  preparation?: {
    readonly signal: AbortSignal;
    readonly onProgress: (summary: string) => void;
    /** Optional diagnostic observer. */
    readonly onPlannerStage?: (stage: WebContextPlannerStage) => void;
    /** Closed substage vocabulary for diagnosing failures inside checkpoint lookup. */
    readonly onPlannerSubstage?: (stage: WebContextPlannerSubstage) => void;
  },
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
  readonly profileSlot?: number;
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

  const startWebTurn = (turn: RegisteredTurn, nativeRequest: unknown, ownerSignal?: AbortSignal): Promise<unknown> => {
    const run = (async () => {
      const authority = turn.channel.binding.authority;
      const preparationStartedAt = Date.now();
      let preparationPhase = "native_watch";
      let plannerStage: WebContextPlannerStage | undefined;
      let plannerSubstage: WebContextPlannerSubstage | undefined;
      let executionStarted = false;
      try {
      const nativeSignal = ownerSignal ? AbortSignal.any([abortController.signal, ownerSignal]) : abortController.signal;
      nativeSignal.throwIfAborted();
      preparationPhase = "context_plan";
      const plan = await input.planWebTurn(turn, nativeRequest, {
        signal: nativeSignal,
        onProgress: summary => turn.channel.publishProgress(summary),
        onPlannerStage: stage => {
          // Custom planners are not trusted to send a valid diagnostic enum.
          if (isWebContextPlannerStage(stage)) {
            plannerStage = stage;
            plannerSubstage = stage === "checkpoint_lookup" ? "checkpoint_lookup_started" : undefined;
          }
        },
        onPlannerSubstage: stage => {
          if (isWebContextPlannerSubstage(stage)) plannerSubstage = stage;
        },
      });
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
        let rejectedBeforeAcquisition = false;
        try {
          signal.throwIfAborted();
          // Web requests use the independent Tela Chat connector. The Native
          // tool bridge is retained only for explicitly requested legacy fixtures.
          const toolBridge = plan.legacyNativeToolBridge === true ? {
            protocol: "mcp" as const,
            contract: webMcpContract,
            turnCapability: turn.capability,
          } : undefined;
          const nativeGoalControl = toolBridge ? undefined : turns.goalControl(turn.capability);
          const chatTools = {
            ...(input.profileSlot !== undefined ? { defaultProfileSlot: input.profileSlot } : {}),
            ...(nativeGoalControl ? { nativeGoalControl } : {}),
          };
          // A deterministic size refusal must not retire a reusable Web page,
          // open a fresh Temporary Chat, or spend a model turn on preload.
          try {
            assertWebMessageFitsComposer({
              physicalContext: plan.physicalContext,
              ...(plan.physicalLimits ? { physicalLimits: plan.physicalLimits } : {}),
              ...(plan.contextAttachment ? { contextAttachment: plan.contextAttachment } : {}),
              ...(plan.media ? { media: plan.media } : {}),
              ...(toolBridge ? { toolBridge } : { chatTools }),
            });
          } catch (error) {
            rejectedBeforeAcquisition = true;
            throw error;
          }
          if (plan.physicalContext.mode !== "retained-delta") {
            // A fresh/full canonical projection is a new logical Web
            // conversation, not a message to append to any prior surface.
            // Epoch IDs derive from Native source anchors; two *different*
            // original Native turns can have an identical head and route.
            // Without this explicit retirement, the registry can reuse the
            // old Web conversation merely because the epoch ID collided,
            // leaking invisible previous Web context into the fresh turn.
            await browserEpochs.retire(plan.nativeTaskId);
          }
          signal.throwIfAborted();
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
          const checkpoints = plan.physicalContext.segments.filter(segment => segment.type === "checkpoint");
          const contextEvidence = {
            epoch_fingerprint: diagnosticFingerprint(plan.webEpochId),
            surface_fingerprint: diagnosticFingerprint(acquired.surface.leaseId),
            ...(document ? { document_generation: document.generation } : {}),
            head_revision_fingerprint: diagnosticFingerprint(plan.physicalContext.headRevisionId),
            ...(plan.physicalContext.activeRequestRevisionId ? {
              active_request_revision_fingerprint: diagnosticFingerprint(plan.physicalContext.activeRequestRevisionId),
              active_request_kind: plan.physicalContext.segments.flatMap(s => s.type === "revision"
                && s.revisionId === plan.physicalContext.activeRequestRevisionId ? [s.kind] : [])[0] ?? "not_inline",
            } : {}),
            ...(plan.physicalContext.baseRevisionId ? { base_revision_fingerprint: diagnosticFingerprint(plan.physicalContext.baseRevisionId) } : {}),
            checkpoint_count: checkpoints.length,
            ...(checkpoints.length ? { checkpoint_fingerprint: diagnosticFingerprint(JSON.stringify(checkpoints.map(s => s.checkpointId))) } : {}),
            physical_revision_count: plan.physicalContext.segments.filter(s => s.type === "revision").length,
            ...(plan.physicalContext.activeRequestRevisionId ? { active_request_inline: plan.physicalContext.segments.some(s => s.type === "revision" && s.revisionId === plan.physicalContext.activeRequestRevisionId) } : {}),
          };
          emitDiagnosticEvent("chatgpt_tela_work", "web_turn_plan", {
            ...diagnosticIdentity,
            ...contextEvidence,
            provider_kind: "web",
            ...(typeof nativeRequest === "object" && nativeRequest !== null
              && typeof (nativeRequest as {model?:unknown}).model === "string"
              && ((nativeRequest as {model:string}).model).length > 0
              && ((nativeRequest as {model:string}).model).length <= 512
              && !((nativeRequest as {model:string}).model).includes("\u0000")
              ? { model_fingerprint: diagnosticFingerprint((nativeRequest as {model:string}).model) } : {}),
            context_mode: plan.physicalContext.mode,
            logical_estimate: plan.physicalContext.logicalTokens,
            transfer_estimate: plan.physicalContext.transferTokens,
            // This is a projection-only upper-bound proxy, not a billing
            // receipt or provider-reported input-token saving.
            estimated_reused_context: plan.physicalContext.mode === "retained-delta"
              ? Math.max(0, plan.physicalContext.logicalTokens - plan.physicalContext.transferTokens)
              : 0,
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
            ...(toolBridge ? { toolBridge } : { chatTools }),
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
              releasedToolResultBytes: turn.channel.releasedToolResultBytes,
              toolRoundCount: turn.channel.toolRoundCount,
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
          plan.settle?.({ status: rejectedBeforeAcquisition ? "preflight-rejected" : "failed" });
          if (acquired) {
            try {
              await browserEpochs.fail(plan.nativeTaskId, plan.webEpochId,
                webObservationFailureReason(error) === "response_wait_timeout");
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
        const failedRequestFingerprint = !executionStarted ? failedNativeRequestFingerprint(nativeRequest) : undefined;
        if (!executionStarted) withDiagnosticContext({
          scope_fingerprint: diagnosticFingerprint(authority.threadId),
          turn_fingerprint: diagnosticFingerprint(authority.turnId),
          ...(failedRequestFingerprint ? { request_fingerprint: failedRequestFingerprint } : {}),
        }, () => {
          capturePrivateDiagnosticValue("web_preparation_failure", {
            phase: preparationPhase, plannerStage,
            error: error instanceof Error ? { name: error.name } : { name: "unknown" },
            projection: error instanceof Error ? (error as NativeProjectionError).projectionPrivateShape : undefined,
          });
          emitDiagnosticEvent("chatgpt_tela_work", "web_preparation_failed", {
            phase: preparationPhase, reason_class: classifyWebPreparationFailure(error),
            error_kind: classifyWebPreparationErrorKind(error),
            ...(error instanceof Error ? (error as NativeProjectionError).projectionEvidence : {}),
            web_send_count: 0, web_accept_count: 0, local_final_committed: false,
            browser_observed_for_request: false,
            ...(error instanceof WebContextFitFailed ? {
              ...(error.estimates.required === undefined ? {} : { required_estimate: error.estimates.required }),
              ...(error.estimates.budget === undefined ? {} : { fit_budget: error.estimates.budget }),
            } : {}),
            ...(preparationPhase === "context_plan" && plannerStage ? { planner_stage: plannerStage } : {}),
            ...(preparationPhase === "context_plan" && plannerStage === "checkpoint_lookup" && plannerSubstage
              ? { planner_substage: plannerSubstage } : {}),
            network_kind: classifyNetworkFailure(error),
            duration_ms: diagnosticDurationMs(preparationStartedAt),
            turn_phase: turn.channel.phase, tool_round_count: turn.channel.toolRoundCount,
          });
        });
        throw error;
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
    browserEpochs.dispose();
    abortController.abort(error);
    turns.cancelAll(error);
    await gateway.close();
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
        browserEpochs.dispose();
        await responses.stop();
        abortController.abort(reason);
        turns.cancelAll(reason);
        await gateway.close();
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
