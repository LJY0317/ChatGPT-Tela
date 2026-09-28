import { diagnosticDurationMs, emitDiagnosticEvent } from "@chatgpt-tela/core";
import type { BackendServiceId } from "@chatgpt-tela/service-protocol";

const DISPLAY_NAME: Readonly<Record<BackendServiceId, string>> = Object.freeze({
  chat: "Chat",
  codex: "Codex",
});

/**
 * Observe one public-Gateway call that resolves its private backend descriptor on demand.
 *
 * The dynamic public routes deliberately avoid holding a long-lived backend client, but they should
 * still emit the same payload-free routing diagnostics as the private Gateway status router.
 */
export async function dynamicBackendCall<TClient, TResult>(input: {
  readonly service: BackendServiceId;
  readonly resolveClient: () => TClient | undefined | Promise<TClient | undefined>;
  readonly operation: (client: TClient) => Promise<TResult>;
}): Promise<TResult> {
  const startedAt = Date.now();
  let client: TClient | undefined;
  try {
    client = await input.resolveClient();
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_gateway", "backend_call_failed", {
      service: input.service,
      duration_ms: diagnosticDurationMs(startedAt),
    });
    throw error;
  }
  if (!client) {
    emitDiagnosticEvent("chatgpt_tela_gateway", "backend_call_unmounted", { service: input.service });
    throw new Error(`Tela ${DISPLAY_NAME[input.service]} backend is unavailable`);
  }
  emitDiagnosticEvent("chatgpt_tela_gateway", "backend_call_start", { service: input.service });
  try {
    const result = await input.operation(client);
    emitDiagnosticEvent("chatgpt_tela_gateway", "backend_call_complete", {
      service: input.service,
      duration_ms: diagnosticDurationMs(startedAt),
    });
    return result;
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_gateway", "backend_call_failed", {
      service: input.service,
      duration_ms: diagnosticDurationMs(startedAt),
    });
    throw error;
  }
}
