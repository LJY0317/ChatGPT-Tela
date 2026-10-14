import { createHmac, randomBytes } from "node:crypto";
const toolKey=randomBytes(32);
import { capturePrivateDiagnosticValue } from "./diagnostic-private";
import { diagnosticContext, diagnosticSerializedBytes, withDiagnosticContext } from "./diagnostic-context";
import { diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent } from "./diagnostic-events";
import { diagnosticToolFailureEvidence, diagnosticToolResultEvidence } from "./diagnostic-tool-evidence";
import { diagnosticFailureClass } from "./diagnostic-failure";
import { classifyNetworkFailure } from "./network-failure";

/** Observes public MCP calls without changing cancellation, approval or invocation authority. */
export async function traceDiagnosticToolCall<T>(tool: string, arguments_: unknown, extra: unknown, invoke: () => Promise<T>): Promise<T> {
  const metadata = extra && typeof extra === "object" ? extra as { requestId?: string | number; _meta?: Record<string,unknown>; sessionId?: string; signal?: AbortSignal } : {};
  const scope = metadata._meta?.["openai/session"];
  const fingerprint = (value: unknown) => { try { return diagnosticFingerprint(String(value)); } catch { return undefined; } };
  const rpc = metadata.requestId === undefined ? undefined : fingerprint(metadata.requestId);
  const toolFingerprint = typeof tool === "string" && tool.length<=16384 ? createHmac("sha256",toolKey).update(tool).digest("hex").slice(0,24) : undefined;
  const scopeFingerprint = typeof scope === "string" ? fingerprint(scope) : undefined;
  return withDiagnosticContext({
    ...(rpc ? { rpc_fingerprint: rpc } : {}),
    ...(scopeFingerprint ? { scope_fingerprint: scopeFingerprint } : {}),
  }, async () => {
    const origin = diagnosticContext(); const startedAt = Date.now();
    let aborted = metadata.signal?.aborted === true; let outcome = "completed"; let resultBytes: number | undefined;
    let errorResult = false;
    const emit = (stage: string, fields: Record<string,string|number|boolean> = {}) => withDiagnosticContext(origin, () => emitDiagnosticEvent("chatgpt_tela_mcp", stage, { ...(toolFingerprint ? { tool_fingerprint: toolFingerprint } : {}), ...fields }));
    const onAbort = () => { aborted = true; emit("tool_abort_signalled"); };
    const requestBytes = diagnosticSerializedBytes(arguments_);
    capturePrivateDiagnosticValue("tool_request",arguments_);
    emit("tool_started", { ...(requestBytes === undefined ? {} : { request_bytes: requestBytes }), abort_observed: aborted });
    metadata.signal?.addEventListener("abort",onAbort,{once:true});
    try {
      const result=await invoke(); capturePrivateDiagnosticValue("tool_result",result); resultBytes=diagnosticSerializedBytes(result);
      errorResult=Boolean(result && typeof result === "object" && (result as {isError?:unknown}).isError === true);
      const evidence = diagnosticToolResultEvidence(result, errorResult);
      if (errorResult) emit("tool_error",{error_result:true, delivery:"mcp_callback_returned", ...evidence});
      else if (evidence.message_signal_observed === true) emit("tool_result_signal_anomaly", {
        error_result: false, delivery: "mcp_callback_returned", ...evidence });
      return result;
    } catch (error) {
      outcome="failed"; emit("tool_failed",{ network_kind:classifyNetworkFailure(error), delivery:"mcp_callback_thrown", status:diagnosticFailureClass(error), ...diagnosticToolFailureEvidence(error) }); throw error;
    } finally {
      metadata.signal?.removeEventListener("abort",onAbort);
      emit("tool_settled", { outcome, duration_ms:diagnosticDurationMs(startedAt), abort_observed:aborted, error_result:errorResult,
        ...(resultBytes === undefined ? {} : { result_bytes:resultBytes }) });
    }
  });
}
