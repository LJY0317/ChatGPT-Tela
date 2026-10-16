import { captureBrowserDiagnosticEvidence, type BrowserHost, type BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  requireProven,
  WebCheckpointOperationClosed,
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
    invoked = true;
    emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_provider_invoked");
    const result = requireProven(await input.provider.createContextCheckpoint(
      surface,
      input.request,
      input.signal,
      input.onProgress,
    ));
    // A proven result that races cancellation is useful only as a durable derived
    // checkpoint. The caller persists it before checking its Native owner again.
    return validateResult(input.request, result);
  } catch (error) {
    failed = true; failure = error;
    emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_failed", {
      reason_class: input.signal?.aborted ? "aborted" : "provider_error",
      surface_acquired: surface !== undefined,
      provider_invoked: invoked,
    });
    // Use an independent bounded diagnostic read while this surface is still owned.
    // The cancelled operation signal must not prevent failure evidence collection.
    if (surface) await captureBrowserDiagnosticEvidence(surface, "turn_failure");
  } finally {
    // A failed close must override cancellation: no receipt may authorize a new
    // attempt while the old isolated operation's physical ownership is uncertain.
    if (surface) await input.browserHost.release(surface.leaseId);
  }
  if (failed && (!invoked || input.signal?.aborted)) {
    const disposition = invoked ? "cancelled_locally" : "not_invoked";
    emitDiagnosticEvent("chatgpt_tela_work", "context_checkpoint_closed", {
      phase: disposition, surface_released: true, remote_terminal_proven: false,
    });
    throw new WebCheckpointOperationClosed({ nativeTaskId: input.request.nativeTaskId,
      sourceRevisionId: input.request.sourceRevisionId, webEpochId: input.request.webEpochId, disposition }, { cause: failure });
  }
  throw failure;
}
