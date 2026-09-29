import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  contextAttachmentReference,
  formatWebPhysicalContext,
  requireProven,
  type ChatGptContextAttachment,
  type ChatGptWebPhysicalLimits,
  type WebConversationProvider,
  type WebPhysicalContext,
  type WebToolBridgeContext,
  type WebTurnEvent,
  type WebTurnHandle,
} from "@chatgpt-tela/chatgpt";
import type { RuntimeTurnChannel } from "./turn-channel";

export interface BrowserTurnRunInput {
  readonly browserHost: BrowserHost;
  readonly provider: WebConversationProvider;
  readonly channel: RuntimeTurnChannel;
  readonly nativeTaskId: string;
  readonly webEpochId: string;
  readonly physicalContext: WebPhysicalContext;
  readonly contextAttachment?: ChatGptContextAttachment;
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

async function waitForBrowserTurnSignal(
  input: BrowserTurnSurfaceRunInput,
  surface: BrowserSurfaceLease,
  handle: WebTurnHandle,
): Promise<BrowserTurnSignal> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  else input.signal?.addEventListener("abort", forwardAbort, { once: true });
  const revision = input.channel.stateRevision;
  try {
    const provider = input.provider.waitForTurnEvent(surface, handle, controller.signal)
      .then(observation => ({
        kind: "provider" as const,
        event: requireProven(observation),
      }));
    const channel = input.channel.waitForStateChange(revision, controller.signal)
      .then(() => ({ kind: "channel" as const }));
    try {
      const result = await Promise.race([provider, channel]);
      controller.abort();
      return result;
    } catch (error) {
      if (input.signal?.aborted && input.signal.reason instanceof Error) {
        throw input.signal.reason;
      }
      throw error;
    }
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
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
  try {
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
    if (input.physicalLimits) {
      const messageChars = formatWebPhysicalContext(
        input.physicalContext,
        input.toolBridge,
        attachmentReference,
      ).length;
      if (messageChars > input.physicalLimits.composerCharLimit) {
        throw new Error(
          `Fresh ChatGPT Web message requires ${messageChars} characters, exceeding the ${input.physicalLimits.composerCharLimit}-character browser message limit; Native context was left unchanged`,
        );
      }
    }
    await input.prepareForSubmit?.(surface, input.signal);

    // From this point a submit may have side effects. Mark it before invoking the provider so a
    // thrown/ambiguous result can never be interpreted as permission to auto-resubmit.
    input.channel.markSubmitted();
    const handle = requireProven(await input.provider.submitTurn(surface, {
      nativeTaskId: input.nativeTaskId,
      nativeTurnId: input.channel.binding.authority.turnId,
      webEpochId: input.webEpochId,
      physicalContext: input.physicalContext,
      ...(attachmentReference ? { contextAttachment: attachmentReference } : {}),
      ...(input.toolBridge ? { toolBridge: input.toolBridge } : {}),
    }, input.signal));
    validateHandle(input, handle);
    input.channel.markAccepted();

    while (true) {
      const signal = await waitForBrowserTurnSignal(input, surface, handle);
      if (signal.kind === "channel") {
        const state = input.channel.state();
        if (state.phase === "tool-result-delivered"
          && state.nativeResultReady === true
          && state.outstandingToolCallId) {
          const boundary = requireProven(await input.provider.armToolContinuation(
            surface,
            handle,
            state.outstandingToolCallId,
            input.signal,
          ));
          if (boundary.providerTurnId !== handle.providerTurnId
            || boundary.callId !== state.outstandingToolCallId) {
            throw new Error("Web provider armed the wrong tool continuation boundary");
          }
          input.channel.releaseNativeToolResultToWeb(state.outstandingToolCallId);
        }
        continue;
      }

      const event = signal.event;
      validateEvent(handle, event);

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
        input.channel.complete(event.answer);
        return event.answer;
      }

      throw new Error(`Web turn failed: ${event.detail}`);
    }
  } catch (error) {
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
