import { readDiagnosticSources } from "@chatgpt-tela/core";

const MAX_TIMELINE_EVENTS = 128;
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const STRUCTURAL_FIELDS = new Set([
  "web_model_count", "native_model_count", "hidden_web_model_count", "pending_count", "include_hidden", "queued",
  "slot", "count", "duration_ms", "request_bytes", "result_bytes", "message_chars",
  "logical_estimate", "transfer_estimate", "epoch_input_estimate", "epoch_rollover_limit",
  "previous_epoch_input_estimate", "previous_epoch_rollover_limit", "physical_rollover",
  "retained_surface", "retained_delta", "provider_projection", "context_attachment",
  "context_attachment_chars", "context_attachment_bytes", "receipt_verified",
  "projection_original_bytes", "projection_projected_bytes", "projection_truncated_assistant",
  "projection_omitted_assistant", "projection_truncated_tool_results",
  "projection_omitted_tool_results", "projection_retention_step", "projection_fit_target",
  "deadline_ms", "tool_round_count", "tool_pending", "native_result_ready",
]);
const TURN_PHASES = new Set([
  "prepared", "submitted", "accepted", "tool-wait", "tool-result-delivered", "continuing",
  "completed", "failed-before-acceptance", "indeterminate-after-acceptance", "cancelled",
]);

interface StructuralEvent {
  readonly at: string;
  readonly event: string;
  readonly stage: string;
  readonly fields: Readonly<Record<string, number | boolean | string>>;
}

function structuralEvent(raw: unknown, fromMs: number, toMs: number): StructuralEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.ts !== "string" || value.ts.length > 64) return undefined;
  const timestamp = Date.parse(value.ts);
  if (!Number.isFinite(timestamp) || timestamp < fromMs || timestamp > toMs) return undefined;
  if (value.event !== "chatgpt_tela_work" && value.event !== "chatgpt_tela_codex") return undefined;
  if (typeof value.stage !== "string" || !SAFE_NAME.test(value.stage)) return undefined;
  const fields: Record<string, number | boolean | string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && (
      (["operation_fingerprint", "connection_fingerprint"].includes(key) && /^[a-f0-9]{24}$/.test(field))
      || (key === "turn_phase" && TURN_PHASES.has(field))
      || (key === "kind" && ["uninitialized_client", "tela_client", "external_client"].includes(field))
      || (key === "status" && ["closed", "rpc_error", "valid", "invalid", "client_closed"].includes(field))
      || (key === "phase" && ["checking", "catalog", "backend", "handshake", "proxy", "admission", "launching", "connecting", "identity", "ready", "ownership", "normal_quit", "transport_cleanup", "closed"].includes(field))
    )) {
      fields[key] = field;
      continue;
    }
    if (!STRUCTURAL_FIELDS.has(key)) continue;
    if (typeof field === "boolean" || (typeof field === "number" && Number.isSafeInteger(field) && field >= 0)) {
      fields[key] = field;
    }
  }
  return Object.freeze({
    at: new Date(timestamp).toISOString(),
    event: value.event,
    stage: value.stage,
    fields: Object.freeze(fields),
  });
}


/** On-demand, bounded Work timeline built only from allowlisted structural diagnostics. */
export function summarizeWorkIncident(input: {
  readonly paths: readonly string[];
  readonly mode: "incident" | "trace";
  readonly minutes?: number;
  readonly nowMs?: number;
}): Readonly<Record<string, unknown>> {
  const minutes = input.minutes ?? 15;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error("diagnostics trace/incident --minutes must be an integer from 1 to 120");
  }
  const nowMs = input.nowMs ?? Date.now();
  const fromMs = nowMs - minutes * 60_000;
  const source = readDiagnosticSources(input.paths);
  const events = source.events.flatMap(row => { const item=structuralEvent(row,fromMs,nowMs+60000);return item?[item]:[]; })
    .sort((left, right) => left.at.localeCompare(right.at));
  let failureIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (/(?:_failed|_error|_timeout)$/.test(events[index]!.stage)) {
      failureIndex = index;
      break;
    }
  }
  const timeline = input.mode === "incident"
    ? failureIndex < 0 ? [] : events.slice(Math.max(0, failureIndex - 63), Math.min(events.length, failureIndex + 17))
    : events.slice(-MAX_TIMELINE_EVENTS);
  return Object.freeze({
    status: input.mode === "incident" && failureIndex < 0 ? "not-observed" : "ready",
    mode: input.mode,
    privacy: "allowlisted-structural-events-only",
    contentRead: false,
    pathsEmitted: false,
    mutating: false,
    window: Object.freeze({ minutes, from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() }),
    observedEvents: events.length,
    sourceCoverage: source.coverage,
    timeline: Object.freeze(timeline),
  });
}
