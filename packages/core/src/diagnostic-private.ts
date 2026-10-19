import { diagnosticContext } from "./diagnostic-context";
import { configuredDiagnosticRoot } from "./diagnostic-events";
import { privateDiagnosticCaptureEnabled, writePrivateDiagnosticArtifact } from "./diagnostic-store";
function redact(value: unknown, depth=0): unknown {
  if (depth>8) return "[DEPTH LIMIT]";
  if (typeof value==="string") return value.slice(0,16384).replace(/Bearer\s+[^\s"<>]+/gi,"Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{16,}/g,"[REDACTED]");
  if (Array.isArray(value)) return value.slice(0,64).map(item=>redact(item,depth+1));
  if (value && typeof value==="object") return Object.fromEntries(Object.entries(value).slice(0,64).map(([key,item])=>[key,/auth|token|secret|password|cookie|credential|api.?key/i.test(key)?"[REDACTED]":redact(item,depth+1)]));
  return typeof value==="number" || typeof value==="boolean" || value===null ? value : undefined;
}
/** Explicit private capture only. Redaction is best effort; these files remain sensitive. */
export function capturePrivateDiagnosticValue(phase: "tool_request" | "tool_result" | "web_context" | "web_preparation_failure" | "web_execution_failure" | "native_turn_failure" | "context_preload_failure" | "retained_body_mismatch", value: unknown): void {
  try {
    const root=configuredDiagnosticRoot(); if (!root || !privateDiagnosticCaptureEnabled(root)) return;
    const context=diagnosticContext(); const operation=context.operation_fingerprint ?? context.request_fingerprint;
    if (!operation) return;
    const bytes=Buffer.from(JSON.stringify({ phase, context, value:redact(value) }));
    if(bytes.length>256*1024) return;
    writePrivateDiagnosticArtifact(root,{kind:"json",bytes,operationFingerprint:operation,
      evidenceClass: /failure|mismatch/.test(phase) ? "failure" : "trace"});
  } catch { /* Private diagnostics cannot affect primary execution. */ }
}
