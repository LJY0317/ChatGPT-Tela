import { BROWSER_INPUT_OWNERSHIP, captureBrowserDiagnosticEvidence, type BrowserHost, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  requireProven,
  WebCheckpointOperationClosed,
  WebCheckpointResponseRejected,
  type WebContextCheckpointProvider,
  type WebContextCheckpointRequest,
  type WebContextCheckpointResult,
} from "@chatgpt-tela/chatgpt";

export interface BrowserContextCheckpointRunInput {
  readonly browserHost: BrowserHost;
  readonly provider: WebContextCheckpointProvider;
  readonly request: WebContextCheckpointRequest;
  readonly signal?: AbortSignal;
  readonly onProgress?: (summary: string) => void;
  /** Persist a validated derived result before releasing its last physical observation owner. */
  readonly persistResult?: (result: WebContextCheckpointResult) => Promise<void>;
  readonly prepareForSubmit?: (surface: BrowserSurfaceLease, signal?: AbortSignal) => Promise<void>;
}

function validateRequest(request: WebContextCheckpointRequest): void {
  if (!request.nativeTaskId.trim()) throw new Error("checkpoint native task id must be non-empty");
  if (!request.webEpochId.trim()) throw new Error("checkpoint Web epoch id must be non-empty");
  if (!request.sourceRevisionId.trim()) throw new Error("checkpoint source revision id must be non-empty");
  if (request.physicalContext.mode !== "full") {
    throw new Error("checkpoint production requires the full canonical source projection");
  }
  if (request.physicalContext.headRevisionId !== request.sourceRevisionId) {
    throw new Error("checkpoint source revision must equal the physical context head");
  }
  const tail = request.physicalContext.segments.at(-1);
  if (!tail || tail.type !== "revision" || tail.revisionId !== request.sourceRevisionId) {
    throw new Error("checkpoint source projection must end at the exact source revision");
  }
}

function validateResult(
  request: WebContextCheckpointRequest,
  result: WebContextCheckpointResult,
): WebContextCheckpointResult {
  if (result.nativeTaskId !== request.nativeTaskId
    || result.webEpochId !== request.webEpochId
    || result.sourceRevisionId !== request.sourceRevisionId) {
    throw new Error("checkpoint provider returned a result for a different causal source");
  }
  if (!result.providerOperationId.trim()) {
    throw new Error("checkpoint provider operation id must be non-empty");
  }
  const content = result.content.trim();
  if (!content) throw new Error("checkpoint provider returned empty content");
  return Object.freeze({ ...result, content });
}

/**
 * Run one isolated checkpoint operation.
 *
 * This runner owns no RuntimeTurnChannel and receives no MCP/tool capability. The only accepted
 * result is a proven response from the dedicated checkpoint provider with the exact source identity.
 */
export async function runBrowserContextCheckpoint(
  input: BrowserContextCheckpointRunInput,
): Promise<WebContextCheckpointResult> {
  validateRequest(input.request);
  let surface: BrowserSurfaceLease | undefined;
  let invoked = false;
  let failure: unknown;
  let failed = false;
  let inputBoundary: { readonly available: boolean; readonly signal: AbortSignal } | undefined;
  let resultPersisted = false;
  try {
    input.signal?.throwIfAborted();
    input.onProgress?.("Preparing prior conversation context before starting the task.");
    surface = await input.browserHost.acquire({
      taskId: input.request.nativeTaskId,
      epochId: input.request.webEpochId,
    });
    requireProven(await input.provider.observeCapabilities(surface, input.signal));
    await input.prepareForSubmit?.(surface, input.signal);
    input.signal?.throwIfAborted();
    // One operation cancellation scope covers both the Native owner and the
    // host's input owner. Local closure is distinct from remote completion.
    inputBoundary = surface.capability(BROWSER_INPUT_OWNERSHIP)?.current();
    const operationSignal = inputBoundary?.available ? input.signal
      ? AbortSignal.any([input.signal, inputBoundary.signal]) : inputBoundary.signal : input.signal;
    operationSignal?.throwIfAborted();
    invoked = true;
    emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_provider_invoked");
    const result = requireProven(await input.provider.createContextCheckpoint(
      surface,
      input.request,
      operationSignal,
      input.onProgress,
    ));
    // A proven result that races cancellation is useful only as a durable derived
    // checkpoint. The caller persists it before checking its Native owner again.
    const verified = validateResult(input.request, result);
    await input.persistResult?.(verified);
    resultPersisted = input.persistResult !== undefined;
    return verified;
  } catch (error) {
    failed = true; failure = error;
    emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_failed", {
      reason_class: input.signal?.aborted ? "owner_cancelled"
        : inputBoundary?.available && inputBoundary.signal.aborted ? "input_revoked" : "provider_error",
      surface_acquired: surface !== undefined,
      provider_invoked: invoked,
    });
    // Use an independent bounded diagnostic read while this surface is still owned.
    // The cancelled operation signal must not prevent failure evidence collection.
    if (surface) await captureBrowserDiagnosticEvidence(surface, "turn_failure");
  } finally {
    // A failed close must override cancellation: no receipt may authorize a new
    // attempt while the old isolated operation's physical ownership is uncertain.
    if (surface) {
      try { await input.browserHost.release(surface.leaseId); }
      catch (error) {
        emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_release_failed", {
          provider_invoked: invoked, first_failure_observed: failed, result_persisted: resultPersisted,
          surface_released: false,
        });
        throw error;
      }
      emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_released", {
        provider_invoked: invoked, failure_observed: failed, result_persisted: resultPersisted,
        surface_released: true, input_aborted: inputBoundary?.available === true && inputBoundary.signal.aborted,
        owner_cancelled: input.signal?.aborted === true,
      });
    }
  }
  const completedUnusable = failure instanceof WebCheckpointResponseRejected
    && failure.receipt.nativeTaskId === input.request.nativeTaskId
    && failure.receipt.sourceRevisionId === input.request.sourceRevisionId
    && failure.receipt.webEpochId === input.request.webEpochId
    && !!failure.receipt.providerOperationId.trim();
  // Reaching this boundary means any acquired physical lease was successfully
  // released. Settlement follows that lifecycle fact, not the exception category.
  // The journal retains unknown remote outcome and fences the retired Native owner.
  const disposition = !invoked ? "not_invoked" : completedUnusable ? "completed_unusable" : "released_locally";
  emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_closed", {
    phase: disposition, surface_released: surface !== undefined, provider_invoked: invoked, remote_terminal_proven: false,
  });
  throw new WebCheckpointOperationClosed({ nativeTaskId: input.request.nativeTaskId,
    sourceRevisionId: input.request.sourceRevisionId, webEpochId: input.request.webEpochId, disposition }, { cause: failure });
}
