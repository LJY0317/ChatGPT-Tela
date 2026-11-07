import { diagnosticContext } from "./diagnostic-context";
import { configuredDiagnosticRoot, diagnosticFingerprint, emitDiagnosticEvent, registerPrivateDiagnosticArtifact } from "./diagnostic-events";
import { privateDiagnosticCaptureEnabled, privateDiagnosticCaptureStatus, writePrivateDiagnosticArtifact } from "./diagnostic-store";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** Bounded failure advice for existing result contracts. It never reads raw evidence or enables capture. */
export function privateDiagnosticFailureGuidance(root = configuredDiagnosticRoot()) {
  if (!root) return { capture: "unavailable", evidence: "unverified", reason: "diagnostic_root_unavailable" } as const;
  if (privateDiagnosticCaptureStatus(root).enabled) {
    return { capture: "enabled", evidence: "unverified", reason: "capture_enabled_status_only" } as const;
  }
  return { capture: "off", evidence: "unverified", reason: "current_capture_disabled",
    nextAction: "offer_optional_capture_on_recurrence",
    note: "현재 상세 진단이 꺼져 있습니다. 다음 재발에 대비해 Tela 설정에서 켤 수 있습니다. 이번 오류의 원문 보존 여부와 원인은 별도 확인이 필요합니다." } as const;
}
function redact(value: unknown, depth=0): unknown {
  if (depth>8) return "[DEPTH LIMIT]";
  if (typeof value==="string") return value.slice(0,16384).replace(/Bearer\s+[^\s"<>]+/gi,"Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{16,}/g,"[REDACTED]");
  if (value instanceof Error) return redact({ name: value.name, message: value.message,
    ...("code" in value ? { code: value.code } : {}),
    ...(value.cause === undefined ? {} : { cause: value.cause }) }, depth+1);
  if (Array.isArray(value)) return value.map(item=>redact(item,depth+1));
  if (value && typeof value==="object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/auth|token|secret|password|cookie|credential|api.?key|capability|goal_control/i.test(key)?"[REDACTED]":redact(item,depth+1)]));
  return typeof value==="number" || typeof value==="boolean" || value===null ? value : undefined;
}
/** Explicit private capture only. Redaction is best effort; these files remain sensitive. */
export function capturePrivateDiagnosticValue(phase: "tool_request" | "tool_result" | "tool_failure" | "web_context" | "web_preparation_failure" | "web_execution_failure" | "native_turn_failure" | "native_backend_failure" | "public_ingress_failure" | "context_preload_failure" | "retained_body_mismatch", value: unknown): void {
  const failure = /failure|mismatch/.test(phase);
  // Trace capture stays quiet when disabled. A failed operation needs to explain
  // why its private evidence is absent without exposing the evidence itself.
  const report = (reason: string, bytes?: number, ref?: string, verified = false) => {
    if (!failure) return;
    emitDiagnosticEvent("chatgpt_tela_diagnostics", ref ? "private_capture_recorded" : "private_capture_omitted", {
      phase, reason_class: reason,
      ...(bytes === undefined ? {} : { requested_bytes: bytes }),
      ...(ref ? { item_fingerprint: diagnosticFingerprint(ref) } : {}),
      artifact_created: ref !== undefined, local_receipt_verified: verified,
      model_receipt_observable: false,
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
    if (ref && failure) registerPrivateDiagnosticArtifact(operation, ref);
    // A writer return is a local retention claim, not model receipt. Verify only
    // private metadata and file size; never read the captured body into diagnostics.
    let verified = false;
    if (ref) try {
      const file = lstatSync(join(root, "private", `${ref}.json`));
      const metaPath = join(root, "private", `${ref}.meta.json`);
      const metaFile = lstatSync(metaPath);
      if (file.isFile() && !file.isSymbolicLink() && file.size === bytes.length
        && metaFile.isFile() && !metaFile.isSymbolicLink() && metaFile.size <= 4096) {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        verified = meta.owner === "chatgpt-tela-diagnostics-v1"
          && meta.operationFingerprint === operation && meta.kind === "json"
          && meta.bytes === bytes.length;
      }
    } catch { /* Local receipt proof is optional; the artifact is not a model receipt. */ }
    report(ref ? "captured" : "capture_not_retained", bytes.length, ref, verified);
  } catch { report("capture_error"); /* Diagnostics cannot affect primary execution. */ }
}
