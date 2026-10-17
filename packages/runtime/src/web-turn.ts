import { NativeWebHandoffUnproven } from "@chatgpt-tela/core";
import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { capturePrivateDiagnosticValue, emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  contextAttachmentReference,
  formatWebPhysicalContext,
  requireProven,
  type ChatGptContextAttachment,
  type ChatGptWebPhysicalLimits,
  type WebConversationProvider,
  type WebPhysicalContext,
  type WebTurnMedia,
  type WebToolBridgeContext,
  type WebTurnEvent,
  type WebTurnHandle,
} from "@chatgpt-tela/chatgpt";
import type { RuntimeTurnChannel } from "./turn-channel";
import { webExecutionFailureFields } from "./web-failure-diagnostics";

export interface BrowserTurnRunInput {
  readonly browserHost: BrowserHost;
  readonly provider: WebConversationProvider;
  readonly channel: RuntimeTurnChannel;
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly physicalContext: WebPhysicalContext;
  readonly contextAttachment?: ChatGptContextAttachment;
  readonly media?: readonly WebTurnMedia[];
  readonly physicalLimits?: ChatGptWebPhysicalLimits;
  readonly toolBridge?: WebToolBridgeContext;
  /** Non-submit surface preparation that must finish immediately before provider submission. */
  readonly prepareForSubmit?: (
    surface: BrowserSurfaceLease,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface BrowserTurnSurfaceRunInput extends Omit<BrowserTurnRunInput, "browserHost"> {
  readonly surface: BrowserSurfaceLease;
  /** Fresh surfaces require a non-consequential readiness proof; retained surfaces prove state in submitTurn. */
  readonly proveCapabilities?: boolean;
}

/** Exact composer-size admission belongs before browser creation and any context
 * preload/model request. It never changes the canonical Native context. */
export function assertWebMessageFitsComposer(input: Pick<BrowserTurnRunInput,
  "physicalContext" | "physicalLimits" | "contextAttachment" | "media" | "toolBridge">): void {
  if (!input.physicalLimits) return;
  const messageChars = formatWebPhysicalContext(
    input.physicalContext,
    input.toolBridge,
    input.contextAttachment ? contextAttachmentReference(input.contextAttachment) : undefined,
    input.media,
  ).length;
  if (messageChars > input.physicalLimits.composerCharLimit) {
    throw new Error(
      `Fresh ChatGPT Web message requires ${messageChars} characters, exceeding the ${input.physicalLimits.composerCharLimit}-character browser message limit; Native context was left unchanged`,
    );
  }
}

function validateHandle(input: BrowserTurnSurfaceRunInput, handle: WebTurnHandle): void {
  const authority = input.channel.binding.authority;
  if (handle.nativeTaskId !== input.nativeTaskId
    || handle.nativeTurnId !== authority.turnId
    || handle.webEpochId !== input.webEpochId) {
    throw new Error("Web provider accepted a turn with the wrong causal identity");
  }
}

function validateEvent(handle: WebTurnHandle, event: WebTurnEvent): void {
  if (event.providerTurnId !== handle.providerTurnId) {
    throw new Error("Web provider event belongs to a different turn");
  }
}

function acceptedPhase(phase: string): boolean {
  return phase === "accepted"
    || phase === "tool-wait"
    || phase === "tool-result-delivered"
    || phase === "continuing";
}

type BrowserTurnSignal =
  | { readonly kind: "provider"; readonly event: WebTurnEvent }
  | { readonly kind: "channel" };

interface BrowserTurnWaitState {
  /** One causal provider observation must survive independent Native state wakes. */
  readonly signal: AbortSignal;
  pendingProvider: Promise<Extract<BrowserTurnSignal, { readonly kind: "provider" }>> | undefined;
}

async function waitForBrowserTurnSignal(
  input: BrowserTurnSurfaceRunInput,
  surface: BrowserSurfaceLease,
  handle: WebTurnHandle,
  state: BrowserTurnWaitState,
): Promise<BrowserTurnSignal> {
  state.signal.throwIfAborted();
  const channelAbort = new AbortController();
  const revision = input.channel.stateRevision;
  try {
    if (!state.pendingProvider) {
      const provider = input.provider.waitForTurnEvent(surface, handle, state.signal)
        .then(observation => ({
          kind: "provider" as const,
          event: requireProven(observation),
        }));
      // The Native channel may win while a provider event is being consumed.
      // Keep the SAME waiter/one-shot result for the next loop, never issue a
      // second concurrent observation or abort the first as a side effect.
      // The owning run may settle before the pending provider promise does.
      void provider.catch(() => {});
      state.pendingProvider = provider;
    }
    const channel = input.channel.waitForStateChange(
      revision, AbortSignal.any([state.signal, channelAbort.signal]),
    )
      .then(() => ({ kind: "channel" as const }));
    try {
      const result = await Promise.race([state.pendingProvider, channel]);
      // If the original Native owner revoked during a fulfilled Web event,
      // the event is observation, not permission to commit an old answer.
      state.signal.throwIfAborted();
      if (result.kind === "provider") state.pendingProvider = undefined;
      return result;
    } catch (error) {
      if (input.signal?.aborted && input.signal.reason instanceof Error) {
        throw input.signal.reason;
      }
      throw error;
    }
  } finally {
    channelAbort.abort();
  }
}

/**
 * Drive one browser/Web lifetime for an already-bound Native turn.
 *
 * Tool calls travel through the RuntimeTurnChannel/MCP boundary independently. This runner only
 * owns browser surface lifetime and semantic Web lifecycle proof. It never retries a submitted
 * turn: an ambiguous submit leaves the channel in `submitted` for recovery observation.
 */
export async function runBrowserTurnOnSurface(input: BrowserTurnSurfaceRunInput): Promise<string> {
  const surface = input.surface;
  let acceptedHandle: WebTurnHandle | undefined;
  let boundary = "preparation";
  try {
    assertWebMessageFitsComposer(input);
    if (input.proveCapabilities !== false) {
      requireProven(await input.provider.observeCapabilities(surface, input.signal));
    }
    const attachmentReference = input.contextAttachment
      ? contextAttachmentReference(input.contextAttachment)
      : undefined;
    if (input.contextAttachment) {
      if (input.proveCapabilities === false) {
        throw new Error("fresh ChatGPT context attachment cannot preload on a retained Web surface");
      }
      const preload = input.provider.preloadContextAttachment;
      if (!preload) throw new Error("Web provider does not support context attachment preload");
      const startedAt = Date.now();
      const result = requireProven(await preload.call(input.provider, surface, {
        nativeTaskId: input.nativeTaskId,
        webEpochId: input.webEpochId,
        attachment: input.contextAttachment,
      }, input.signal));
      if (result.nativeTaskId !== input.nativeTaskId
        || result.webEpochId !== input.webEpochId
        || result.attachmentName !== input.contextAttachment.name
        || result.attachmentSha256 !== input.contextAttachment.sha256) {
        throw new Error("context attachment preload receipt belongs to a different physical Web transaction");
      }
      emitDiagnosticEvent("chatgpt_tela_work", "context_attachment_verified", {
        context_chars: input.contextAttachment.contextJson.length,
        context_bytes: Buffer.byteLength(input.contextAttachment.contextJson, "utf8"),
        preload_ms: Math.max(0, Date.now() - startedAt),
        receipt_verified: true,
      });
    }
    await input.prepareForSubmit?.(surface, input.signal);
    input.signal?.throwIfAborted();

    // From this point a submit may have side effects. Mark it before invoking the provider so a
    // thrown/ambiguous result can never be interpreted as permission to auto-resubmit.
    input.channel.markSubmitted();
    boundary = "submission";
    const handle = requireProven(await input.provider.submitTurn(surface, {
      nativeTaskId: input.nativeTaskId,
      nativeTurnId: input.channel.binding.authority.turnId,
      webEpochId: input.webEpochId,
      physicalContext: input.physicalContext,
      ...(attachmentReference ? { contextAttachment: attachmentReference } : {}),
      ...(input.media ? { media: input.media } : {}),
      ...(input.toolBridge ? { toolBridge: input.toolBridge } : {}),
    }, input.signal));
    validateHandle(input, handle);
    acceptedHandle = handle;
    input.channel.markAccepted();

    const eventAbort = new AbortController();
    const eventWait: BrowserTurnWaitState = {
      signal: input.signal ? AbortSignal.any([input.signal, eventAbort.signal]) : eventAbort.signal,
      pendingProvider: undefined,
    };
    try {
      while (true) {
      boundary = "event_wait";
      const signal = await waitForBrowserTurnSignal(input, surface, handle, eventWait);
      if (signal.kind === "channel") {
        const state = input.channel.state();
        if (state.phase === "tool-result-delivered"
          && state.nativeResultReady === true
          && state.outstandingToolCallId) {
          boundary = "tool_handoff";
          const observation = await input.provider.armToolContinuation(
            surface,
            handle,
            state.outstandingToolCallId,
            input.signal,
          );
          if (observation.state !== "proven") throw new NativeWebHandoffUnproven(observation.state);
          const continuation = observation.value;
          if (continuation.providerTurnId !== handle.providerTurnId
            || continuation.callId !== state.outstandingToolCallId) {
            throw new Error("Web provider armed the wrong tool continuation boundary");
          }
          eventWait.signal.throwIfAborted();
          input.channel.releaseNativeToolResultToWeb(state.outstandingToolCallId);
        }
        continue;
      }

      const event = signal.event;
      boundary = "event_dispatch";
      validateEvent(handle, event);
      eventWait.signal.throwIfAborted();

      if (event.kind === "progress") {
        input.channel.publishProgress(event.summary);
        continue;
      }

      if (event.kind === "continuing") {
        if (input.channel.phase === "tool-wait") {
          // A subsequent exact MCP call is itself causal proof that ChatGPT resumed after the prior
          // released result. The channel has already advanced into the next tool boundary.
          continue;
        }
        if (input.channel.phase !== "tool-result-delivered") {
          throw new Error(`unexpected Web continuation from turn phase ${input.channel.phase}`);
        }
        input.channel.markWebContinuation();
        continue;
      }

      if (event.kind === "completed") {
        eventWait.signal.throwIfAborted();
        input.channel.complete(event.answer);
        return event.answer;
      }

      throw new Error(`Web turn failed: ${event.detail}`);
      }
    } finally {
      // Cancels only this turn's outstanding provider observation, not the
      // runtime, Native tool owner, or unrelated browser surface.
      eventAbort.abort();
    }
  } catch (error) {
    // Preserve the primary boundary before diagnostic observation or surface retirement can race.
    emitDiagnosticEvent("chatgpt_tela_work", "web_execution_exception", {
      ...webExecutionFailureFields(error, input.signal), turn_phase: input.channel.phase,
      tool_round_count: input.channel.toolRoundCount, accepted: acceptedHandle !== undefined,
      boundary,
    });
    // Sensitive exception text stays in explicit opt-in local capture, before secondary reads.
    capturePrivateDiagnosticValue("web_execution_failure", { boundary,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "non_error" },
      ownerAborted: input.signal?.aborted === true,
      abortReason: input.signal?.aborted && input.signal.reason instanceof Error
        ? { name: input.signal.reason.name, message: input.signal.reason.message } : undefined,
    });
    if (acceptedHandle) {
      // One read before surface retirement, including after a deadline abort. Never submit, retry
      // or wait indefinitely for a faulty provider; this evidence cannot change the original error.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("diagnostic observation deadline")); }, 1500);
        });
        const observation = await Promise.race([
          input.provider.observeTurn(surface, acceptedHandle, controller.signal), deadline,
        ]);
        emitDiagnosticEvent("chatgpt_tela_work", "web_failure_state_observed", {
          state: observation.state, ...(observation.state === "proven" ? { phase: observation.value.phase } : {}),
        });
      } catch {
        emitDiagnosticEvent("chatgpt_tela_work", "web_failure_state_unavailable", { reason_class: "observation_unavailable" });
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    }
    if (acceptedPhase(input.channel.phase)) {
      try {
        input.channel.markIndeterminate(error);
      } catch {
        // Preserve the original provider/runtime error if terminalization itself races with another
        // terminal event. The channel still fails closed.
      }
    }
    throw error;
  }
}

/** One-shot compatibility wrapper. Development/Product runtimes use retained epoch ownership. */
export async function runBrowserTurn(input: BrowserTurnRunInput): Promise<string> {
  assertWebMessageFitsComposer(input);
  const surface = await input.browserHost.acquire({
    taskId: input.nativeTaskId,
    epochId: input.webEpochId,
  });
  try {
    return await runBrowserTurnOnSurface({ ...input, surface });
  } finally {
    await input.browserHost.release(surface.leaseId);
  }
}
