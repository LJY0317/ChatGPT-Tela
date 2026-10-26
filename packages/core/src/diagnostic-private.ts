import { diagnosticContext } from "./diagnostic-context";
import { configuredDiagnosticRoot, diagnosticFingerprint, emitDiagnosticEvent } from "./diagnostic-events";
import { privateDiagnosticCaptureEnabled, privateDiagnosticCaptureStatus, writePrivateDiagnosticArtifact } from "./diagnostic-store";
/** Bounded failure advice for existing result contracts. It never reads raw evidence or enables capture. */
export function privateDiagnosticFailureGuidance(root = configuredDiagnosticRoot()) {
  if (!root) return { capture: "unavailable", evidence: "unverified", reason: "diagnostic_root_unavailable" } as const;
  if (privateDiagnosticCaptureStatus(root).enabled) {
    return { capture: "enabled", evidence: "unverified", reason: "artifact_receipt_unverified" } as const;
  }
  return { capture: "off", evidence: "not_collected", reason: "capture_disabled",
    nextAction: "offer_optional_capture_on_recurrence",
    note: "상세 원문 진단이 꺼져 있어 이번 오류의 원문 증거는 수집되지 않았습니다. 원하면 Tela 설정에서 다음 재발에 대비해 잠시 켤 수 있습니다. 원인 확인이 보장되지는 않습니다." } as const;
}
function redact(value: unknown, depth=0): unknown {
  if (depth>8) return "[DEPTH LIMIT]";
  if (typeof value==="string") return value.slice(0,16384).replace(/Bearer\s+[^\s"<>]+/gi,"Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{16,}/g,"[REDACTED]");
  if (Array.isArray(value)) return value.map(item=>redact(item,depth+1));
  if (value && typeof value==="object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/auth|token|secret|password|cookie|credential|api.?key/i.test(key)?"[REDACTED]":redact(item,depth+1)]));
  return typeof value==="number" || typeof value==="boolean" || value===null ? value : undefined;
}
/** Explicit private capture only. Redaction is best effort; these files remain sensitive. */
export function capturePrivateDiagnosticValue(phase: "tool_request" | "tool_result" | "web_context" | "web_preparation_failure" | "web_execution_failure" | "native_turn_failure" | "native_backend_failure" | "context_preload_failure" | "retained_body_mismatch", value: unknown): void {
  const failure = /failure|mismatch/.test(phase);
  // Trace capture stays quiet when disabled. A failed operation needs to explain
  // why its private evidence is absent without exposing the evidence itself.
  const report = (reason: string, bytes?: number, ref?: string) => {
    if (!failure) return;
    emitDiagnosticEvent("chatgpt_tela_diagnostics", ref ? "private_capture_recorded" : "private_capture_omitted", {
      phase, reason_class: reason,
      ...(bytes === undefined ? {} : { requested_bytes: bytes }),
      ...(ref ? { item_fingerprint: diagnosticFingerprint(ref) } : {}),
    });
  };
  try {
    const root=configuredDiagnosticRoot(); if (!root) return;
    if (!privateDiagnosticCaptureEnabled(root)) { report("capture_disabled"); return; }
    const context=diagnosticContext(); const operation=context.operation_fingerprint ?? context.request_fingerprint;
    if (!operation) { report("correlation_missing"); return; }
    const bytes=Buffer.from(JSON.stringify({ phase, context, value:redact(value) }));
    if(bytes.length>256*1024) { emitDiagnosticEvent("chatgpt_tela_diagnostics", "private_capture_omitted", { phase, reason_class: "byte_budget", requested_bytes: bytes.length }); return; }
    const ref=writePrivateDiagnosticArtifact(root,{kind:"json",bytes,operationFingerprint:operation,
      evidenceClass: failure ? "failure" : "trace"});
    report(ref ? "captured" : "capture_not_retained", bytes.length, ref);
  } catch { report("capture_error"); /* Diagnostics cannot affect primary execution. */ }
}
