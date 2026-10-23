import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LOG_FILE_BYTES = 4 * 1024 * 1024;
const LOG_TOTAL_BYTES = 32 * 1024 * 1024;
export const DIAGNOSTIC_LIMITS = Object.freeze({ tailBytes: 4 * 1024 * 1024, scanBytes: 96 * 1024 * 1024, timeline: 128,
  logFileBytes: LOG_FILE_BYTES, logBytes: LOG_TOTAL_BYTES, logSegments: Math.ceil(LOG_TOTAL_BYTES / LOG_FILE_BYTES),
  incidentBytes: 16 * 1024 * 1024, incidentAgeMs: 30 * 86400000,
  privateBytes: 64 * 1024 * 1024, privateFileBytes: 8 * 1024 * 1024, privateAgeMs: 7 * 86400000 });
export interface StructuralDiagnosticEvent { readonly ts: string; readonly event: string; readonly stage: string; readonly [key: string]: string | number | boolean; }
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN = /(prompt|path|url|uri|secret|email|content|command|output|argument|authorization|cookie|raw_|token|workspace_id|account_id|user_id|session_id|turn_id|thread_id)/i;
const FINGERPRINT = /^[a-f0-9]{24}$/;
const SAFE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SAFE_PROOF_STAGES = new Set(["account", "model-discovery", "connector", "readiness"]);
const RETAINED_KINDS = new Set(["system", "developer", "user", "assistant", "tool-call", "tool-result", "steering", "end"]);
/** Closed, payload-free substage vocabulary for a failed Native-to-Web context plan. */
export const WEB_CONTEXT_PLANNER_STAGES = [
  "request_parse", "model_route", "retained_context", "native_continuity",
  "logical_projection", "checkpoint_lookup", "checkpoint_production",
  "physical_context_fit", "media_binding", "settlement",
] as const;
export type WebContextPlannerStage = typeof WEB_CONTEXT_PLANNER_STAGES[number];
const SAFE_WEB_CONTEXT_PLANNER_STAGES = new Set<string>(WEB_CONTEXT_PLANNER_STAGES);
export function isWebContextPlannerStage(value: unknown): value is WebContextPlannerStage {
  return typeof value === "string" && SAFE_WEB_CONTEXT_PLANNER_STAGES.has(value);
}
const STRINGS = new Set(["observation_failure", "failure_class", "failure_stage", "service", "capability", "turn_phase", "assistant_phase", "context_mode", "approval_mode", "outcome", "network_kind", "method_class", "resource_class", "reason_class", "first_reason_class", "delivery", "trigger", "state", "phase", "mode", "kind", "target_kind", "provider_kind", "platform", "policy", "route_kind", "route_class", "action", "status", "environment", "native_signin", "web_signin", "comparison", "payload_state", "anchor_state", "remote_outcome", "request_ownership", "request_role", "browser_response", "next_action", "probe_kind", "auth_state", "entry_class", "removal_cause", "expiry_class", "domain_class", "storage_state"]);
const PROJECTION_ENUMS: Readonly<Record<string, readonly string[]>> = {
  input_container_kind: ["array", "string", "absent", "null", "record", "scalar"],
  input_item_kind: ["none", "array", "string", "absent", "null", "record", "scalar"],
  input_type_class: ["absent", "invalid", "unknown", "message", "agent_message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_call", "tool_search_output", "mcp_tool_call_output", "context_compaction", "compaction", "compaction_summary", "reasoning", "additional_tools"],
  input_role_kind: ["system", "developer", "user", "assistant", "absent", "other"],
  input_body_kind: ["absent", "null", "array", "record", "string", "scalar"],
  input_part_kind: ["absent", "null", "array", "record", "string", "scalar"],
  input_part_type_class: ["absent", "invalid", "unknown", "input_text", "output_text", "text", "input_image", "input_file", "image", "file", "resource", "resource_link", "audio", "input_audio", "encrypted_content"],
  question_relation: ["absent", "call_only", "matched", "item_only"],
};
/** Never copies unclassified text, identifiers or payloads from a raw diagnostic file. */
export function structuralDiagnosticEvent(value: unknown): StructuralDiagnosticEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts)) || typeof row.event !== "string" || !row.event.startsWith("chatgpt_tela_") || !SAFE_NAME.test(row.event)
    || typeof row.stage !== "string" || !SAFE_NAME.test(row.stage)) return;
  const safe: Record<string, string | number | boolean> = { ts: new Date(row.ts).toISOString(), event: row.event, stage: row.stage };
  for (const [key, field] of Object.entries(row)) {
    if (["ts", "event", "stage"].includes(key) || !SAFE_NAME.test(key) || FORBIDDEN.test(key)) continue;
    if (key === "estimate_kind") {
      if (field === "conservative_upper_bound") safe[key] = field;
      continue;
    }
    if (key === "retained_stop_kind" || key === "retained_last_kind" || key === "retained_active_kind") {
      if (typeof field === "string" && RETAINED_KINDS.has(field)) safe[key] = field;
      continue;
    }
    if (key === "proof_stage") {
      if (typeof field === "string" && SAFE_PROOF_STAGES.has(field)) safe[key] = field;
      continue;
    }
    if (key === "rendered_payload_state") {
      if (field === "unmounted" || field === "unavailable" || field === "matching" || field === "changed") safe[key] = field;
      continue;
    }
    if (key === "observation_input_state") {
      if (["unchanged", "pending", "changed", "unknown"].includes(String(field))) safe[key] = field as string;
      continue;
    }
    if (key === "source_kind") {
      if (field === "native-visible-prefix" || field === "native-request-prefix") safe[key] = field;
      continue;
    }
    if (key === "close_source") {
      if (field === "request_aborted" || field === "response_closed") safe[key] = field;
      continue;
    }
    if (key === "planner_stage") {
      if (isWebContextPlannerStage(field)) safe[key] = field;
      continue;
    }
    if (Object.hasOwn(PROJECTION_ENUMS, key)) {
      if (typeof field === "string" && PROJECTION_ENUMS[key]!.includes(field)) safe[key] = field;
      continue;
    }
    if (typeof field === "number" && Number.isSafeInteger(field) && Math.abs(field) <= Number.MAX_SAFE_INTEGER) safe[key] = field;
    else if (typeof field === "boolean") safe[key] = field;
    else if (typeof field === "string" && ((key.endsWith("_fingerprint") && FINGERPRINT.test(field))
      || (key === "effort" && SAFE_EFFORTS.has(field))
      || (STRINGS.has(key) && /^[a-z][a-z0-9_-]{0,63}$/.test(field)))) safe[key] = field;
  }
  return safe as StructuralDiagnosticEvent;
}

export interface DiagnosticWindow { readonly fromMs: number; readonly toMs: number; }
export function readDiagnosticTail(path: string, maxBytes = DIAGNOSTIC_LIMITS.tailBytes, window?: DiagnosticWindow) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error("invalid diagnostic read budget");
  if (window && (!Number.isFinite(window.fromMs) || !Number.isFinite(window.toMs) || window.fromMs > window.toMs)) throw new Error("invalid diagnostic window");
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("unsafe source");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd); if (!stat.isFile()) throw new Error("unsafe source");
    const bytes = Math.min(stat.size, maxBytes); const buffer = Buffer.alloc(bytes);
    let used = 0; while (used < bytes) { const count = readSync(fd, buffer, used, bytes - used, stat.size - bytes + used); if (!count) break; used += count; }
    let text = buffer.subarray(0, used).toString("utf8");
    if (stat.size > bytes) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
    const events: StructuralDiagnosticEvent[] = [];
    let invalidTimestampRows = 0, malformedRows = 0, oversizedRows = 0, outsideWindowRows = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (line.length > 8192) { oversizedRows++; continue; }
      try { const raw = JSON.parse(line); if (raw && typeof raw === "object" && (!raw.ts || !Number.isFinite(Date.parse(raw.ts)))) invalidTimestampRows++;
        const event = structuralDiagnosticEvent(raw);
        if (event) {
          const at = Date.parse(event.ts);
          if (window && (at < window.fromMs || at > window.toMs)) outsideWindowRows++;
          else events.push(event);
        }
      } catch { malformedRows++; }
    }
    return { state: "read" as const, invalidTimestampRows, malformedRows, oversizedRows, outsideWindowRows,
      windowSelected: Boolean(window), bytesRead: used, fileBytes: stat.size, truncated: stat.size > bytes,
      events, eventLimitReached: false };
  } catch { return { state: "unavailable" as const, invalidTimestampRows: 0, malformedRows: 0, oversizedRows: 0,
    outsideWindowRows: 0, windowSelected: Boolean(window), bytesRead: 0, fileBytes: 0, truncated: false, events: [] as StructuralDiagnosticEvent[], eventLimitReached: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readDiagnosticSources(paths: readonly string[], window?: DiagnosticWindow) {
  const selected = [...new Set(paths)];
  let remaining = DIAGNOSTIC_LIMITS.scanBytes;
  const sources = selected.flatMap((path, index) => {
    if (!remaining) return [];
    const { events, ...coverage } = readDiagnosticTail(path, Math.min(remaining, DIAGNOSTIC_LIMITS.tailBytes), window);
    remaining -= coverage.bytesRead;
    return [{ index, coverage, events }];
  });
  const excluded = new Set<string>();
  for (const parent of new Set(selected.map(path=>dirname(path)))) {
    try {
      const path=join(parent,"diagnostics","test-origins.json");const stat=lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size>8192) continue;
      const annotation=JSON.parse(readFileSync(path,"utf8"));
      if(annotation.owner!=="chatgpt-tela-diagnostics-v1" || !Array.isArray(annotation.instances) || (!Number.isFinite(annotation.expiresAt) || annotation.expiresAt<Date.now() || annotation.expiresAt>Date.now()+30*86400000))continue;
      for(const instance of annotation.instances.slice(0,32))if(typeof instance==="string" && FINGERPRINT.test(instance))excluded.add(instance);
    } catch { /* Missing annotation is not an origin claim. */ }
  }
  const seen = new Set<string>();
  let excludedTestEvents=0;
  const events = sources.flatMap(source => source.events).sort((a,b) => a.ts.localeCompare(b.ts)).filter(event => {
    if(event.environment==="test" || excluded.has(String(event.instance_fingerprint))) { excludedTestEvents++;return false; }
    const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true;
  });
  return { events, excludedTestEvents, coverage: sources.map(({ index, coverage }) => ({ source: index, ...coverage })), sourceLimitReached: false, byteLimitReached: sources.length < selected.length };
}

export const HOST_SYMPTOMS = ["stream-failure", "connection-interrupted", "response-stalled", "additional-review", "response-recovered", "approval-stalled", "tool-review-blocked", "missing-models", "startup-stalled", "ui-anomaly", "unknown"] as const;
export const HOST_REPORT_ORIGINS = ["user-observation", "worker-report", "host-error"] as const;
export type HostReportOrigin = typeof HOST_REPORT_ORIGINS[number];
export type HostSymptom = typeof HOST_SYMPTOMS[number];
export function analyzeDiagnosticEvents(input: { events: readonly StructuralDiagnosticEvent[]; atMs: number; minutes?: number; operationFingerprint?: string; symptom?: HostSymptom; reportOrigin?: HostReportOrigin; recoveredAtMs?: number; outputStartedAtMs?: number }) {
  const minutes = input.minutes ?? 5;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120 || !Number.isFinite(input.atMs)) throw new Error("invalid incident window");
  if (input.operationFingerprint !== undefined && !FINGERPRINT.test(input.operationFingerprint)) throw new Error("invalid operation fingerprint");
  if (input.symptom !== undefined && !(HOST_SYMPTOMS as readonly string[]).includes(input.symptom)) throw new Error("invalid host symptom");
  if (input.reportOrigin !== undefined && !(HOST_REPORT_ORIGINS as readonly string[]).includes(input.reportOrigin)) throw new Error("invalid host report origin");
  for (const time of [input.recoveredAtMs, input.outputStartedAtMs]) if (time !== undefined && (!Number.isFinite(time) || time < input.atMs)) throw new Error("invalid reported recovery/output time");
  const nearby = input.events.filter(event => Math.abs(Date.parse(event.ts) - input.atMs) <= minutes * 60000);
  const keys = ["operation_fingerprint", "request_fingerprint", "parent_fingerprint", "turn_fingerprint"] as const;
  const correlated = new Set(input.operationFingerprint ? [input.operationFingerprint] : []);
  // Expand transport parent/child links without merging every request in one conversation.
  for (let pass = 0; pass < 4 && input.operationFingerprint; pass++) {
    for (const row of nearby) if (keys.some(key => correlated.has(String(row[key])))) {
      for (const key of keys) if (typeof row[key] === "string") correlated.add(row[key]);
    }
  }
  const target = input.operationFingerprint ? nearby.filter(event => keys.some(key => correlated.has(String(event[key])))
    || event.scope_fingerprint === input.operationFingerprint) : nearby;
  const before = target.filter(event => Date.parse(event.ts) <= input.atMs);
  const after = target.filter(event => Date.parse(event.ts) > input.atMs);
  const stages: Record<string, number> = {}; for (const event of target) stages[event.stage] = (stages[event.stage] ?? 0) + 1;
  const transport = target.filter(event => /http_|transport_|cancel|abort/.test(event.stage));
  const process = target.filter(event => /process_/.test(event.stage));
  const latestProcess = process.filter(event => Date.parse(event.ts) <= input.atMs).at(-1);
  const targetScopes = new Set(target.map(event => event.scope_fingerprint).filter(Boolean));
  const otherScopes = new Set(nearby.filter(event => input.operationFingerprint && event.scope_fingerprint && !targetScopes.has(event.scope_fingerprint)).map(event => event.scope_fingerprint));
  const lastBefore = before.at(-1); const firstAfter = after[0];
  const quietMs = lastBefore ? Math.max(0, input.atMs - Date.parse(lastBefore.ts)) : undefined;
  const failures = target.filter(event => /(?:failed|error|timeout|crashed|unresponsive|rejected|anomaly)$/.test(event.stage));
  const completed = target.filter(event => /(?:complete|completed|settled|finished)$/.test(event.stage));
  const observedOtherProgress = Boolean(input.operationFingerprint && quietMs !== undefined && quietMs >= 60000 && nearby.some(event => event.scope_fingerprint && !targetScopes.has(event.scope_fingerprint) && Date.parse(event.ts) >= Date.parse(lastBefore!.ts) && /(?:complete|completed|finished)$/.test(event.stage)));
  const instances = [...new Set(nearby.map(event => event.instance_fingerprint).filter(Boolean))];
  const categories: Record<string,number> = {};
  for (const row of target) {
    const category = /approval/.test(row.stage) ? "approval" : /compact|checkpoint|context_|projection|epoch/.test(row.stage) ? "context"
      : /model|catalog|inventory/.test(row.stage) ? "catalog" : /process_/.test(row.stage) ? "process"
      : /http_|transport|abort|cancel/.test(row.stage) ? "transport" : /renderer|navigation|browser_/.test(row.stage) ? "browser"
      : /startup|launch|ready|connect|profile|supervis/.test(row.stage) ? "lifecycle" : "turn";
    categories[category]=(categories[category]??0)+1;
  }
  const activeTools = new Set<string>(); const activeProcesses = new Set<string>();
  for (const row of before) {
    const toolKey=[row.request_fingerprint,row.rpc_fingerprint,row.tool_fingerprint].join(":");
    if(row.stage==="tool_started")activeTools.add(toolKey);if(row.stage==="tool_settled")activeTools.delete(toolKey);
    const processKey=String(row.operation_fingerprint??"");
    if(row.stage==="process_started")activeProcesses.add(processKey);
    if(["process_settled","process_spawn_failed"].includes(row.stage))activeProcesses.delete(processKey);
  }
  return {
    schemaVersion: 1, privacy: "structural-only", mutating: false, observedAt: new Date(input.atMs).toISOString(),
    hostReported: { symptom: input.symptom ?? "unknown", origin: input.reportOrigin ?? "unspecified", originProven: false,
      ...(input.recoveredAtMs !== undefined ? { recoveredAt: new Date(input.recoveredAtMs).toISOString() } : {}), ...(input.outputStartedAtMs !== undefined ? { outputStartedAt: new Date(input.outputStartedAtMs).toISOString() } : {}) },
    windowMinutes: minutes, selectedOperation: input.operationFingerprint ?? null,
    status: target.length ? "observed" : "not-observed", eventCounts: stages, categories,
    boundaries: { failures: failures.length, localCompletions: completed.length, transportEvents: transport.length,
      toolEvidence: {
        correlationSelected: input.operationFingerprint !== undefined,
        approvalDispatches: before.filter(row => row.stage === "approval_wait_transition" && row.phase === "dispatch_sent").length,
        approvalInputReceipts: before.filter(row => row.stage === "approval_wait_transition" && row.phase === "input_received").length,
        approvalCardsCleared: before.filter(row => row.stage === "approval_wait_transition" && row.phase === "card_cleared").length,
        nativeQueued: before.filter(row => row.stage === "native_tool_queued").length,
        nativeDelivered: before.filter(row => row.stage === "native_tool_delivery_committed").length,
        nativeResults: before.filter(row => ["native_tool_result_received", "native_tool_result_error"].includes(row.stage)).length,
        reportedErrors: before.filter(row => ["native_tool_result_error", "tool_error", "tool_failed"].includes(row.stage)).length,
        incompleteInspections: before.filter(row => row.inspection_complete === false).length,
        preDispatchCoverage: "external-host-unobservable",
        originProven: false, executionProven: false,
      },
      activeToolsAtReport: activeTools.size, activeProcessesAtReport: activeProcesses.size,
      processEvidence: latestProcess ? { stage: latestProcess.stage, at: latestProcess.ts } : null,
      lastLocalBeforeReport: lastBefore?.ts ?? null, firstLocalAfterReport: firstAfter?.ts ?? null,
      quietBeforeReportMs: quietMs ?? null, otherScopeCount: otherScopes.size,
      localSilenceWhileOthersProgress: observedOtherProgress, instanceCount: instances.length,
      hostContinuation: input.outputStartedAtMs !== undefined ? "host-reported" : "unverified" },
    timeline: target.slice(-DIAGNOSTIC_LIMITS.timeline), nearbyAnomalies: failures.slice(-16),
    gaps: ["Local response delivery is not proof of host display or model continuation.", "Scope/profile fingerprints are correlation signals, not authenticated account identities.", "Missing, rotated or unreadable evidence is not evidence of success.", "External host rejection before Tela ingress has no local tool receipt; a host report does not prove its internal cause.", "Server-side reasoning and exact Web quota/token accounting are not observable."],
  };
}

const OWNER = "chatgpt-tela-diagnostics-v1";
const INCIDENT_NAME = /^incident_[0-9a-f-]{36}\.json$/;
const ARTIFACT_NAME = /^artifact_[0-9a-f-]{36}\.(?:html|jpg|json|meta\.json)$/;
function directory(path: string) {
  try { if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("unsafe diagnostics directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(path, { recursive: true, mode: 0o700 }); }
}
function atomic(path: string, value: unknown) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try { writeFileSync(temporary, JSON.stringify(value, null, 2)+"\n", { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { try { rmSync(temporary, { force: true }); } catch { /* Best effort owned temporary only. */ } }
}
function ownedRoot(root: string) {
  directory(root);
  const marker = join(root, "ownership.json");
  try { if (lstatSync(marker).isSymbolicLink() || JSON.parse(readFileSync(marker, "utf8")).owner !== OWNER) throw new Error("diagnostics ownership mismatch"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; writeFileSync(marker, JSON.stringify({ owner: OWNER, schemaVersion: 1 })+"\n", { flag: "wx", mode: 0o600 }); }
  directory(join(root, "incidents")); directory(join(root, "private"));
  const guide = join(root, "START-HERE.md");
  const guideText = `# Tela diagnostics\n\nFirst run \`chatgpt-tela diagnostics list\`. Canonical incidents live in incidents/; INDEX.json is a rebuildable discovery index. Use \`diagnostics inspect --ref <incident>\` before raw events. \`diagnostics record --at <ISO-time> --symptom <kind>\` captures a bounded cross-service timeline. Private HTML/screenshots require explicit \`diagnostics capture --minutes 15\` or \`--mode until-disabled\`; stop with \`--minutes 0\`. Private capture stays local, retains at most 7 days/64 MiB with no file-count limit, and must never be uploaded, returned through model tools or committed. Absence of evidence is not success. No background sampler runs.\n`;
  if (!readdirSync(root).includes("START-HERE.md")) writeFileSync(guide, guideText, { flag: "wx", mode: 0o600 });
  else if (lstatSync(guide).isFile() && !lstatSync(guide).isSymbolicLink()) {
    const previous = readFileSync(guide, "utf8");
    const updated = previous.replace("7 days/64 MiB/256 files", "7 days/64 MiB with no file-count limit");
    if (updated !== previous) writeFileSync(guide, updated, { mode: 0o600 });
  }
}
function files(root: string, type: "incidents" | "private") {
  const path = join(root, type); if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("unsafe diagnostics directory");
  const pattern = type === "incidents" ? INCIDENT_NAME : ARTIFACT_NAME;
  const proofs = new Map<string, Record<string, any> | null>();
  return readdirSync(path).filter(name => pattern.test(name)).flatMap(name => {
    try {
      const stat = lstatSync(join(path,name)); if (!stat.isFile() || stat.isSymbolicLink()) return [];
      const proofName = type === "incidents" ? name : name.replace(/\.(?:meta\.json|html|jpg|json)$/, ".meta.json");
      let proof: Record<string, any> | null = proofs.get(proofName) ?? null;
      if (!proofs.has(proofName)) {
        const proofPath = join(path, proofName); const proofStat = lstatSync(proofPath);
        if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.size > (type === "incidents" ? 128*1024 : 4096)) {
          proofs.set(proofName, null); return [];
        }
        const parsed = JSON.parse(readFileSync(proofPath,"utf8"));
        proof = parsed.owner === OWNER ? parsed : null;
        proofs.set(proofName, proof);
      }
      if (!proof) return [];
      return [{ name, bytes: stat.size, time: stat.mtimeMs, proof,
        operation: type === "private" && FINGERPRINT.test(proof.operationFingerprint)
          && (proof.kind === "html" || proof.kind === "jpg" || proof.evidenceClass === "failure") ? proof.operationFingerprint as string : undefined }];
    } catch { return []; }
  }).sort((a,b) => b.time - a.time);
}
function prune(root: string, type: "incidents" | "private", now = Date.now(), entries = files(root, type)) {
  let bytes = 0;
  const kept = new Set<string>();
  const maxBytes = type === "incidents" ? DIAGNOSTIC_LIMITS.incidentBytes : DIAGNOSTIC_LIMITS.privateBytes;
  const age = type === "incidents" ? DIAGNOSTIC_LIMITS.incidentAgeMs : DIAGNOSTIC_LIMITS.privateAgeMs;
  const groups = new Map<string, ReturnType<typeof files>>();
  for (const item of entries) {
    // One operation's HTML, screenshots, error details and their metadata expire together.
    // Older metadata without an operation fingerprint retains artifact-pair ownership.
    const key = type === "private" ? item.operation ?? item.name.slice(0,45) : item.name;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key,group);
  }
  // Tool request/result JSON can churn many times during one browser turn. Keep
  // scarce renderer evidence ahead of that traffic, within the same age/size cap.
  const retained = [...groups.values()].sort((a, b) => {
    const priority = (group: typeof a) => group.some(item => item.proof.evidenceClass === "failure") ? 2
      : group.some(item => /\.(?:html|jpg)$/.test(item.name)) ? 1 : 0;
    return priority(b) - priority(a);
  });
  for (const group of retained) {
    const groupBytes = group.reduce((sum,item) => sum+item.bytes,0);
    if (now-Math.min(...group.map(item=>item.time)) > age || bytes+groupBytes > maxBytes) {
      for (const item of group) rmSync(join(root,type,item.name), { force: true });
    } else { bytes += groupBytes; for (const item of group) kept.add(item.name); }
  }
  return kept;
}
export function listDiagnosticIncidents(root: string) {
  ownedRoot(resolve(root));
  const incidents = files(root,"incidents");
  const kept = prune(root,"incidents", Date.now(), incidents);
  prune(root,"private");
  const records = incidents.filter(item => kept.has(item.name)).flatMap(item => {
    if (item.bytes > 128 * 1024) return [];
    try { const record = item.proof;
      return record.owner === OWNER && record.schemaVersion === 1 ? [{ ref: item.name.replace(/\.json$/,""), recordedAt: record.recordedAt, observedAt: record.observedAt, stage: record.stage, symptom: record.hostReported?.symptom ?? "unknown", privateArtifactCount: record.privateArtifactCount ?? 0, occurrences: record.occurrences ?? 1, firstObservedAt: record.firstObservedAt ?? record.observedAt }] : [];
    } catch { return []; }
  });
  atomic(join(root,"INDEX.json"), { owner: OWNER, schemaVersion: 1, generatedAt: new Date().toISOString(), entryPoint: "START-HERE.md", retention: DIAGNOSTIC_LIMITS, incidents: records });
  return records;
}
interface AutomaticDiagnosticIncident {
  readonly stage: string;
  readonly observedAt: string;
  readonly timeline: readonly StructuralDiagnosticEvent[];
  readonly occurrences?: number;
  readonly firstObservedAt?: string;
  readonly failure?: StructuralDiagnosticEvent;
}

/** Repeated automatic failures share a structural signature, never a raw message or request ID.
 * Scope/operation ownership keeps distinct tasks separate. Manual reports remain immutable snapshots.
 */
export function diagnosticFailureIncidentRef(failure: StructuralDiagnosticEvent): string {
  const keys = ["event", "stage", "reason_class", "failure_class", "failure_stage", "phase", "proof_stage", "service", "route_kind", "kind", "status"];
  const owner = failure.scope_fingerprint ?? failure.operation_fingerprint ?? failure.profile_fingerprint ?? failure.instance_fingerprint;
  const signature = JSON.stringify([owner, ...keys.map(key => failure[key] ?? null)]);
  const hex = createHash("sha256").update(signature).digest("hex").slice(0,32);
  return `incident_${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function writeDiagnosticIncident(root: string, data: ReturnType<typeof analyzeDiagnosticEvents> | AutomaticDiagnosticIncident) {
  ownedRoot(root);
  const failure = "failure" in data ? data.failure : undefined;
  const ref = failure ? diagnosticFailureIncidentRef(failure) : `incident_${randomUUID()}`;
  const path = join(root,"incidents",`${ref}.json`);
  const previous = failure && (() => {
    try { return readDiagnosticIncident(root, ref) as Record<string, any>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  })();
  const last = failure ?? data.timeline.at(-1);
  const fingerprint = last?.operation_fingerprint ?? last?.request_fingerprint;
  const retainedRefs = new Set<string>((previous?.privateArtifacts ?? []).flatMap((artifact: { ref?: unknown }) =>
    typeof artifact?.ref === "string" && /^artifact_[a-f0-9-]{36}$/.test(artifact.ref) ? [artifact.ref] : []));
  const artifacts = files(root,"private").filter(item => item.name.endsWith(".meta.json")).flatMap(item => {
    try {
      const metadata = item.proof;
      const artifactRef = item.name.replace(/\.meta\.json$/,"");
      return ((fingerprint && metadata.operationFingerprint === fingerprint) || retainedRefs.has(artifactRef))
        && ["html","jpg","json"].includes(metadata.kind)
        ? [{ ref: item.name.replace(/\.meta\.json$/,""), kind: metadata.kind, bytes: metadata.bytes, privacy: "private" }] : [];
    } catch { return []; }
  });
  const firstObservedAt = previous?.firstObservedAt ?? previous?.observedAt ?? ("firstObservedAt" in data ? data.firstObservedAt : undefined) ?? data.observedAt;
  const occurrences = Math.min(Number.MAX_SAFE_INTEGER, Number(previous?.occurrences ?? 0) + ("occurrences" in data ? data.occurrences ?? 1 : 1));
  const firstTimeline: StructuralDiagnosticEvent[] = failure
    ? (previous?.firstTimeline ?? previous?.timeline ?? data.timeline).slice(0,32) : [];
  const record = { ...data, timeline: data.timeline.slice(-DIAGNOSTIC_LIMITS.timeline),
    ...(failure ? { firstTimeline, firstObservedAt, occurrences } : {}),
    owner: OWNER, schemaVersion: 1, ref, recordedAt: new Date().toISOString(),
    privateArtifactCount: artifacts.length, privateArtifacts: artifacts };
  while (Buffer.byteLength(JSON.stringify(record)) > 120 * 1024 && record.timeline.length) record.timeline.shift();
  if (Buffer.byteLength(JSON.stringify(record)) > 128 * 1024) throw new Error("incident exceeds budget");
  atomic(path, record);
  // One retention/index pass per write, rather than pruning and scanning the same bucket twice.
  listDiagnosticIncidents(root);
  return ref;
}
export function readDiagnosticIncident(root: string, ref: string): unknown {
  if (!INCIDENT_NAME.test(`${ref}.json`)) throw new Error("invalid incident reference");
  ownedRoot(root); const path = join(root,"incidents",`${ref}.json`);
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128*1024) throw new Error("unsafe incident");
  const record = JSON.parse(readFileSync(path,"utf8")); if (record.owner !== OWNER) throw new Error("incident ownership mismatch"); return record;
}
export function setPrivateDiagnosticCapture(root: string, duration: number | "until-disabled") {
  if (duration !== "until-disabled" && (!Number.isInteger(duration) || duration < 0 || duration > 60)) throw new Error("capture minutes must be 0..60");
  const mode = duration === "until-disabled" ? duration : duration > 0 ? "timed" : "off";
  ownedRoot(root); atomic(join(root,"capture-policy.json"), { owner: OWNER, mode,
    enabledUntil: typeof duration === "number" && duration > 0 ? Date.now()+duration*60000 : 0 });
  return { enabled: mode !== "off", mode, minutes: typeof duration === "number" ? duration : null,
    privacy: "private-local-only", stop: "diagnostics capture --minutes 0",
    retention: { days: DIAGNOSTIC_LIMITS.privateAgeMs / 86400000, bytes: DIAGNOSTIC_LIMITS.privateBytes },
    next: mode === "until-disabled" ? "Capture remains enabled until explicitly disabled; retention stays bounded. No background sampler runs."
      : "Capture expires without a timer or restart. No background sampler runs." };
}
export function privateDiagnosticCaptureEnabled(root: string): boolean {
  try { const path = join(root,"capture-policy.json"); const stat=lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size>1024) return false;
    const record=JSON.parse(readFileSync(path,"utf8"));
    if (record.owner !== OWNER) return false;
    if (record.mode === "until-disabled") return record.enabledUntil === 0;
    if (record.mode !== undefined && record.mode !== "timed") return false;
    return Number.isFinite(record.enabledUntil) && record.enabledUntil>Date.now() && record.enabledUntil<=Date.now()+60*60000; } catch { return false; }
}
export function writePrivateDiagnosticArtifact(root: string, input: { kind: "html" | "jpg" | "json"; bytes: Uint8Array; operationFingerprint: string; captureScope?: "document" | "latest_turn_shell"; evidenceClass?: "failure" | "trace" }) {
  if (!privateDiagnosticCaptureEnabled(root) || !FINGERPRINT.test(input.operationFingerprint)) return;
  if (!["html","jpg","json"].includes(input.kind)) throw new Error("invalid artifact kind");
  if (input.bytes.byteLength > DIAGNOSTIC_LIMITS.privateFileBytes) throw new Error("private artifact exceeds budget");
  ownedRoot(root); const ref=`artifact_${randomUUID()}`;
  writeFileSync(join(root,"private",`${ref}.${input.kind}`),input.bytes,{flag:"wx",mode:0o600});
  atomic(join(root,"private",`${ref}.meta.json`), { owner:OWNER, privacy:"private", operationFingerprint:input.operationFingerprint, kind:input.kind, bytes:input.bytes.byteLength, ...(input.captureScope ? { captureScope: input.captureScope } : {}), ...(input.evidenceClass ? { evidenceClass: input.evidenceClass } : {}) });
  return prune(root,"private").has(`${ref}.${input.kind}`) ? ref : undefined;
}
