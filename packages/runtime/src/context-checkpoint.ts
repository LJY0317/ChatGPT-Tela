import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import {
  requireProven,
  type WebContextCheckpointProvider,
  type WebContextCheckpointRequest,
  type WebContextCheckpointResult,
} from "@chatgpt-tela/chatgpt";

export interface BrowserContextCheckpointRunInput {
  readonly browserHost: BrowserHost;
  readonly provider: WebContextCheckpointProvider;
  readonly request: WebContextCheckpointRequest;
  readonly signal?: AbortSignal;
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
  try {
    surface = await input.browserHost.acquire({
      taskId: input.request.nativeTaskId,
      epochId: input.request.webEpochId,
    });
    requireProven(await input.provider.observeCapabilities(surface, input.signal));
    const result = requireProven(await input.provider.createContextCheckpoint(
      surface,
      input.request,
      input.signal,
    ));
    return validateResult(input.request, result);
  } finally {
    if (surface) await input.browserHost.release(surface.leaseId);
  }
}
