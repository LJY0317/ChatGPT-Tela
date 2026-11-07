import { createHash } from "node:crypto";
import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { encodeNativeToolInvocation, extractNativeToolResults, parseNativeTurnClaim, parseNativeTurnReplayIdentity } from "@chatgpt-tela/codex";
import { NativeToolInventory, isNativeGoalTool, capturePrivateDiagnosticValue, diagnosticFailureFields, diagnosticFingerprint, emitDiagnosticEvent, type NativeToolCatalogEntry } from "@chatgpt-tela/core";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import { selectChatGptWebModel, type WebConversationProvider } from "@chatgpt-tela/chatgpt";
import type { ResponsesGateway } from "@chatgpt-tela/responses";
import {
  RetainedBrowserEpochRegistry, WEB_EPOCH_IDLE_RETENTION_MS, assertWebMessageFitsComposer,
  bindWebEpochDocument, runBrowserTurnOnSurface, ExactToolRound, createRoutedOperationCapability, type NativeGatewayOutcome,
} from "@chatgpt-tela/runtime";
import {
  createNativeRequestDevelopmentWebTurnPlanner, nativeRequestBrowserModelRoute,
  nativeRequestContentSource, type SuppliedRequestWebTurnPlanner,
} from "./native-request-planner";
import type { DevelopmentWebTurnPlan } from "./runtime";
import type { SuppliedCompletedResult } from "./native-visible-prefix-journal";

export interface SuppliedResultStore {
  readSuppliedResult(identity: Omit<SuppliedCompletedResult, "answer">): Promise<SuppliedCompletedResult | undefined>;
  preserveSuppliedResult(result: SuppliedCompletedResult): Promise<boolean>;
}

interface Operation {
  readonly turnId: string;
  fingerprint: string;
  readonly capability: string;
  readonly listeners: Set<(summary: string) => void | boolean>;
  outcome: Promise<NativeGatewayOutcome>;
  webRun?: Promise<NativeGatewayOutcome>;
  readonly round: ExactToolRound;
  readonly advertisedGoals: readonly NativeToolCatalogEntry[];
  offer: (outcome: NativeGatewayOutcome) => void;
  armContinuation?: (callId: string) => Promise<void>;
  failed?: true;
  preserved?: boolean;
  finishedAt?: number;
  delivered: boolean;
  progress?: string;
}

function fingerprint(body: unknown): string {
  const source = body as { model?: unknown; reasoning?: unknown };
  const canonical = JSON.stringify({ model: source.model, reasoning: source.reasoning,
    ...nativeRequestContentSource(body) }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Supplied Web execution. Local ingress owns a provider operation, never a Native binding.
 * An explicitly advertised Goal function may be returned for execution by the Responses host;
 * its exact result is handed back through the existing structured MCP call.
 */
export function createSuppliedRequestGateway(input: {
  readonly browserHost: BrowserHost;
  readonly provider: WebConversationProvider;
  readonly planner?: SuppliedRequestWebTurnPlanner;
  readonly profileSlot?: number;
  readonly routeId?: string;
  readonly completedResults?: { readonly profileSlot: number; readonly accountFingerprint: string; readonly store: SuppliedResultStore };
  readonly browserSurfaceTarget?: number;
  readonly webTurnTimeoutMs?: number;
  readonly prepareForSubmit?: (surface: BrowserSurfaceLease,
    route: NonNullable<ReturnType<typeof nativeRequestBrowserModelRoute>>, signal?: AbortSignal) => Promise<void>;
}): ResponsesGateway & {
  readonly toolBridge: TurnBridgeBackend;
  shutdownReadiness(): "ready" | "blocked";
  prepareShutdown(): void;
  ownsCapability(capability: string): boolean;
  browserRetention(surfaceId?: string): ReturnType<RetainedBrowserEpochRegistry["retention"]>;
  close(): Promise<void>;
} {
  const planner = input.planner ?? createNativeRequestDevelopmentWebTurnPlanner();
  const controller = new AbortController();
  const operations = new Map<string, Operation>();
  // Negative-only replay receipts. Keep no old answer/input copies; use the same idle retention period.
  const superseded = new Map<string, number>();
  const epochs = new RetainedBrowserEpochRegistry(input.browserHost, {
    ...(input.browserSurfaceTarget !== undefined ? { surfaceTarget: input.browserSurfaceTarget } : {}),
    isTaskActive: task => { const op = operations.get(task); return !!op && op.finishedAt === undefined; },
    onRetire(task, surface) {
      planner.retireSurface(task, surface);
      const op = operations.get(task);
      if (op?.finishedAt !== undefined && op.delivered) operations.delete(task);
    },
  });

  const toolBridge: TurnBridgeBackend = {
    inventory(capability, query = "") {
      const op = [...operations.values()].find(candidate => candidate.capability === capability);
      if (!op || op.finishedAt !== undefined) throw Error("unknown or retired supplied operation");
      return op.advertisedGoals.filter(tool => tool.wireName.toLowerCase().includes(query.toLowerCase()));
    },
    invoke(capability, invocation) {
      const op = [...operations.values()].find(candidate => candidate.capability === capability);
      if (!op || op.finishedAt !== undefined) throw Error("unknown or retired supplied operation");
      const tool = op.advertisedGoals.find(candidate => candidate.wireName === invocation.wireName);
      if (!tool || invocation.mode !== "structured") throw Error("supplied operation did not advertise this Goal function");
      const result = op.round.open(invocation);
      op.offer({ type: "tool-call", item: encodeNativeToolInvocation(tool, invocation),
        delivery: { capability, callId: invocation.callId } });
      return result;
    },
  };

  const shutdownReadiness = (): "ready" | "blocked" => [...operations.values()].some(op =>
    op.finishedAt === undefined || !op.failed && !op.delivered && !op.preserved) ? "blocked" : "ready";

  return {
    toolBridge,
    shutdownReadiness,
    prepareShutdown() {
      if (shutdownReadiness() !== "ready") throw Error("Finish active Web work or receive its answer before shutdown");
      controller.abort(new Error("Web provider admission closed"));
    },
    ownsCapability: capability => [...operations.values()].some(op => op.capability === capability && op.finishedAt === undefined),
    browserRetention: surfaceId => epochs.retention(surfaceId),
    async handle(body, presentation) {
      controller.signal.throwIfAborted();
      presentation?.signal?.throwIfAborted();
      const route = nativeRequestBrowserModelRoute(body);
      if (!route) throw new Error("Input-only Web gateway requires an explicit Web model");
      // Metadata is correlation scoped by this local ingress, never canonical Native authority.
      const identity = parseNativeTurnReplayIdentity(body);
      const hash = fingerprint(body);
      const resultIdentity = input.completedResults ? {
        profileSlot: input.completedResults.profileSlot, accountFingerprint: input.completedResults.accountFingerprint,
        threadId: identity.threadId, turnId: identity.turnId, requestFingerprint: hash,
      } : undefined;
      const key = `${identity.threadId}\u0000${identity.turnId}`;
      for (const [prior, retiredAt] of superseded) {
        if (Date.now() - retiredAt >= WEB_EPOCH_IDLE_RETENTION_MS) superseded.delete(prior);
      }
      if (superseded.has(key)) throw new Error("This provider response operation has already been superseded");
      for (const [task, op] of operations) {
        if (op.finishedAt !== undefined && Date.now() - op.finishedAt >= WEB_EPOCH_IDLE_RETENTION_MS) operations.delete(task);
      }
      let operation = operations.get(identity.threadId);
      if (operation?.turnId === identity.turnId) {
        if (operation.fingerprint !== hash) {
          const outstanding = operation.round.pending;
          if (!operation.delivered || !outstanding)
            throw new Error("Web request changed within the same response operation");
          const results = extractNativeToolResults(body).filter(result => result.callId === outstanding.invocation.callId);
          if (results.length !== 1 || results[0]!.callId !== outstanding.invocation.callId)
            throw new Error("supplied host result must match exactly one outstanding callId");
          // Arm the next event before releasing the result to the still-running Web MCP call.
          let offer!: (outcome: NativeGatewayOutcome) => void;
          const nextTool = new Promise<NativeGatewayOutcome>(resolve => { offer = resolve; });
          operation.offer = offer;
          operation.fingerprint = hash;
          operation.delivered = false;
          operation.outcome = Promise.race([operation.webRun!, nextTool]);
          operation.round.deliver(results[0]!);
          if (!operation.armContinuation) throw Error("Web tool continuation was not submitted");
          await operation.armContinuation(outstanding.invocation.callId);
          operation.round.release(outstanding.invocation.callId);
        }
      } else {
        if (operation && operation.finishedAt === undefined) throw new Error("This Web conversation still has an unfinished response");
        if (operation) superseded.set(`${identity.threadId}\u0000${operation.turnId}`, Date.now());
        const listeners = new Set<(summary: string) => void | boolean>();
        const capability = createRoutedOperationCapability(input.routeId);
        // Advertisements are data from this authenticated Responses ingress, not
        // filesystem/Native authority. Only the exact official Goal function subset is offered.
        const claim = parseNativeTurnClaim(body);
        const advertisedGoals = NativeToolInventory.fromObservations(identity.threadId, identity.turnId,
          claim.toolObservations).list().filter(isNativeGoalTool);
        let offer!: (outcome: NativeGatewayOutcome) => void;
        const nextTool = new Promise<NativeGatewayOutcome>(resolve => { offer = resolve; });
        const publish = (summary: string) => {
          owned.progress = summary;
          for (const listener of listeners) { try { if (listener(summary) === false) listeners.delete(listener); } catch { listeners.delete(listener); } }
        };
        const owned: Operation = {
          turnId: identity.turnId, fingerprint: hash, capability, listeners, delivered: false,
          round: new ExactToolRound(), advertisedGoals, offer,
          outcome: Promise.resolve().then(async () => {
            const signal = input.webTurnTimeoutMs === undefined ? controller.signal
              : AbortSignal.any([controller.signal, AbortSignal.timeout(input.webTurnTimeoutMs)]);
            let plan: DevelopmentWebTurnPlan | undefined;
            let acquired = false;
            try {
              // Register this operation before the durable lookup. Concurrent
              // requests join one outcome; a recovered final never resubmits.
              if (resultIdentity) {
                const saved = await input.completedResults!.store.readSuppliedResult(resultIdentity);
                if (saved) {
                  owned.preserved = true;
                  return { type: "final", answer: saved.answer, delivery: { capability } } as const;
                }
              }
              plan = await planner.planSuppliedRequest(identity, body, { signal, onProgress: publish });
              const chatTools = { ...(input.profileSlot === undefined ? {} : { defaultProfileSlot: input.profileSlot }),
                ...(owned.advertisedGoals.length ? { nativeGoalControl: capability } : {}) };
              assertWebMessageFitsComposer({ ...plan, chatTools });
              if (plan.physicalContext.mode !== "retained-delta") await epochs.retire(identity.threadId);
              const page = await epochs.acquire(plan.nativeTaskId, plan.webEpochId);
              acquired = true;
              const bound = bindWebEpochDocument(plan, page, signal);
              const answer = await runBrowserTurnOnSurface({
                surface: page.surface, provider: input.provider, nativeTaskId: plan.nativeTaskId,
                nativeTurnId: identity.turnId, webEpochId: plan.webEpochId,
                physicalContext: plan.physicalContext, chatTools, signal: bound.signal, onProgress: publish,
                isToolExecutionPending: () => owned.round.pending !== undefined,
                onSubmitted: (surface, handle) => {
                  owned.armContinuation = async callId => {
                    const proof = await input.provider.armToolContinuation(surface, handle, callId, bound.signal);
                    if (proof.state !== "proven" || proof.value.callId !== callId
                      || proof.value.providerTurnId !== handle.providerTurnId)
                      throw Error("Web provider armed the wrong tool continuation boundary");
                  };
                },
                ...(plan.contextAttachment ? { contextAttachment: plan.contextAttachment } : {}),
                ...(plan.media ? { media: plan.media } : {}),
                ...(plan.physicalLimits ? { physicalLimits: plan.physicalLimits } : {}),
                prepareForSubmit: (surface, signal) => (input.prepareForSubmit ?? selectChatGptWebModel)(surface, route, signal),
              });
              await epochs.complete(plan.nativeTaskId, plan.webEpochId, () => plan!.settle?.({
                status: "completed", answer, surfaceLeaseId: page.surface.leaseId,
                ...(bound.document ? { documentGeneration: bound.document.generation } : {}),
              }));
              emitDiagnosticEvent("chatgpt_tela_work", "provider_input_response_completed", {
                scope_fingerprint: diagnosticFingerprint(identity.threadId),
                turn_fingerprint: diagnosticFingerprint(identity.turnId), native_authority: false,
                context_mode: plan.physicalContext.mode, retained_surface: page.reused,
                logical_estimate: plan.physicalContext.logicalTokens, transfer_estimate: plan.physicalContext.transferTokens,
                effort: route.effort,
              });
              if (resultIdentity) {
                try {
                  owned.preserved = await input.completedResults!.store.preserveSuppliedResult({ ...resultIdentity, answer });
                } catch (error) {
                  emitDiagnosticEvent("chatgpt_tela_work", "provider_result_preservation_failed", {
                    scope_fingerprint: diagnosticFingerprint(identity.threadId), ...diagnosticFailureFields(error),
                  });
                }
              }
              return { type: "final", answer, delivery: { capability } } as const;
            } catch (error) {
              owned.failed = true;
              emitDiagnosticEvent("chatgpt_tela_work", "provider_input_response_failed", {
                scope_fingerprint: diagnosticFingerprint(identity.threadId),
                turn_fingerprint: diagnosticFingerprint(identity.turnId), native_authority: false,
                boundary: !plan ? "planning" : acquired ? "browser" : "acquisition",
                ...diagnosticFailureFields(error),
              });
              if (!plan) capturePrivateDiagnosticValue("web_preparation_failure", {
                phase: "provider_input", request: body,
                error: error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown" },
              });
              plan?.settle?.({ status: "failed" });
              // Preserve accepted/uncertain browser evidence; expiry remains owned by the existing registry.
              if (plan && acquired) await epochs.fail(plan.nativeTaskId, plan.webEpochId, true).catch(() => {});
              owned.round.fail(error instanceof Error ? error : new Error(String(error)));
              throw error;
            } finally { owned.finishedAt = Date.now(); }
          }),
        };
        owned.webRun = owned.outcome;
        owned.outcome = Promise.race([owned.webRun, nextTool]);
        operation = owned;
        operations.set(identity.threadId, owned);
        void owned.webRun.catch(() => {});
      }

      const signal = presentation?.signal;
      signal?.throwIfAborted();
      const observer = presentation?.onProgress;
      if (observer) {
        operation.listeners.add(observer);
        if (operation.progress) { try { if (observer(operation.progress) === false) operation.listeners.delete(observer); } catch { operation.listeners.delete(observer); } }
      }
      let aborted: (() => void) | undefined;
      try {
        return signal ? await Promise.race([operation.outcome, new Promise<never>((_resolve, reject) => {
          aborted = () => reject(signal.reason); signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        })]) : await operation.outcome;
      } finally {
        if (observer) operation.listeners.delete(observer);
        if (aborted) signal?.removeEventListener("abort", aborted);
      }
    },
    commit(outcome) {
      for (const op of operations.values()) if (op.capability === outcome.delivery.capability) {
        if (outcome.type === "tool-call") op.round.markDelivered(outcome.delivery.callId);
        op.delivered = true;
      }
    },
    async close() {
      controller.abort(new Error("Web provider runtime stopped"));
      for (const op of operations.values()) op.round.fail(new Error("supplied operation stopped"));
      epochs.dispose();
      await Promise.allSettled([...operations.values()].map(op => op.outcome));
      operations.clear();
      superseded.clear();
      await input.browserHost.close();
    },
  };
}

/** The existing profile MCP endpoint can serve Native and supplied operations together. */
export function createProfileTurnBridge(native: TurnBridgeBackend, supplied: {
  readonly toolBridge: TurnBridgeBackend;
  ownsCapability(capability: string): boolean;
}): TurnBridgeBackend {
  return {
    inventory(capability, query) {
      return (supplied.ownsCapability(capability) ? supplied.toolBridge : native).inventory(capability, query);
    },
    invoke(capability, invocation) {
      return (supplied.ownsCapability(capability) ? supplied.toolBridge : native).invoke(capability, invocation);
    },
  };
}
