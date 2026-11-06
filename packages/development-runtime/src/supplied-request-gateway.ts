import { createHash, randomUUID } from "node:crypto";
import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { parseNativeTurnReplayIdentity } from "@chatgpt-tela/codex";
import { diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { selectChatGptWebModel, type WebConversationProvider } from "@chatgpt-tela/chatgpt";
import type { ResponsesGateway } from "@chatgpt-tela/responses";
import {
  RetainedBrowserEpochRegistry, WEB_EPOCH_IDLE_RETENTION_MS, assertWebMessageFitsComposer,
  bindWebEpochDocument, runBrowserTurnOnSurface, type NativeGatewayOutcome,
} from "@chatgpt-tela/runtime";
import {
  createNativeRequestDevelopmentWebTurnPlanner, nativeRequestBrowserModelRoute,
  nativeRequestContentSource, type SuppliedRequestWebTurnPlanner,
} from "./native-request-planner";
import type { DevelopmentWebTurnPlan } from "./runtime";

interface Operation {
  readonly turnId: string;
  readonly fingerprint: string;
  readonly capability: string;
  readonly listeners: Set<(summary: string) => void | boolean>;
  readonly outcome: Promise<NativeGatewayOutcome>;
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
 * Input-only Web execution. The authenticated caller supplies request correlation, not Native
 * authority. Reuses the browser runner, context planner and ordinary Responses transport; it
 * cannot issue Native tool/Goal/history capabilities. HTTP disconnect never authorizes a replay
 * or cancellation. Stop/Goal/history integration requires a separately proven Native contract.
 */
export function createSuppliedRequestGateway(input: {
  readonly browserHost: BrowserHost;
  readonly provider: WebConversationProvider;
  readonly planner?: SuppliedRequestWebTurnPlanner;
  readonly profileSlot?: number;
  readonly browserSurfaceTarget?: number;
  readonly webTurnTimeoutMs?: number;
  readonly prepareForSubmit?: (surface: BrowserSurfaceLease,
    route: NonNullable<ReturnType<typeof nativeRequestBrowserModelRoute>>, signal?: AbortSignal) => Promise<void>;
}): ResponsesGateway & {
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

  return {
    browserRetention: surfaceId => epochs.retention(surfaceId),
    async handle(body, presentation) {
      controller.signal.throwIfAborted();
      presentation?.signal?.throwIfAborted();
      const route = nativeRequestBrowserModelRoute(body);
      if (!route) throw new Error("Input-only Web gateway requires an explicit Web model");
      // Metadata is correlation scoped by this local ingress, never canonical Native authority.
      const identity = parseNativeTurnReplayIdentity(body);
      const hash = fingerprint(body);
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
        if (operation.fingerprint !== hash) throw new Error("Web request changed within the same response operation");
      } else {
        if (operation && operation.finishedAt === undefined) throw new Error("This Web conversation still has an unfinished response");
        if (operation) superseded.set(`${identity.threadId}\u0000${operation.turnId}`, Date.now());
        const listeners = new Set<(summary: string) => void | boolean>();
        const capability = `provider-${randomUUID()}`;
        const publish = (summary: string) => {
          owned.progress = summary;
          for (const listener of listeners) { try { if (listener(summary) === false) listeners.delete(listener); } catch { listeners.delete(listener); } }
        };
        const owned: Operation = {
          turnId: identity.turnId, fingerprint: hash, capability, listeners, delivered: false,
          outcome: Promise.resolve().then(async () => {
            const signal = input.webTurnTimeoutMs === undefined ? controller.signal
              : AbortSignal.any([controller.signal, AbortSignal.timeout(input.webTurnTimeoutMs)]);
            let plan: DevelopmentWebTurnPlan | undefined;
            let acquired = false;
            try {
              plan = await planner.planSuppliedRequest(identity, body, { signal, onProgress: publish });
              const chatTools = input.profileSlot === undefined ? {} : { defaultProfileSlot: input.profileSlot };
              assertWebMessageFitsComposer({ ...plan, chatTools });
              if (plan.physicalContext.mode !== "retained-delta") await epochs.retire(identity.threadId);
              const page = await epochs.acquire(plan.nativeTaskId, plan.webEpochId);
              acquired = true;
              const bound = bindWebEpochDocument(plan, page, signal);
              const answer = await runBrowserTurnOnSurface({
                surface: page.surface, provider: input.provider, nativeTaskId: plan.nativeTaskId,
                nativeTurnId: identity.turnId, webEpochId: plan.webEpochId,
                physicalContext: plan.physicalContext, chatTools, signal: bound.signal, onProgress: publish,
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
              });
              return { type: "final", answer, delivery: { capability } } as const;
            } catch (error) {
              plan?.settle?.({ status: "failed" });
              // Preserve accepted/uncertain browser evidence; expiry remains owned by the existing registry.
              if (plan && acquired) await epochs.fail(plan.nativeTaskId, plan.webEpochId, true).catch(() => {});
              throw error;
            } finally { owned.finishedAt = Date.now(); }
          }),
        };
        operation = owned;
        operations.set(identity.threadId, owned);
        void owned.outcome.catch(() => {});
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
      for (const op of operations.values()) if (op.capability === outcome.delivery.capability) op.delivered = true;
    },
    async close() {
      controller.abort(new Error("Web provider runtime stopped"));
      epochs.dispose();
      await Promise.allSettled([...operations.values()].map(op => op.outcome));
      operations.clear();
      superseded.clear();
      await input.browserHost.close();
    },
  };
}
