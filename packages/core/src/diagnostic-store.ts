import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DIAGNOSTIC_LIMITS = Object.freeze({ tailBytes: 2 * 1024 * 1024, sources: 12, events: 4096, timeline: 128,
  incidents: 64, incidentBytes: 4 * 1024 * 1024, incidentAgeMs: 30 * 86400000,
  privateFiles: 24, privateBytes: 64 * 1024 * 1024, privateFileBytes: 8 * 1024 * 1024, privateAgeMs: 7 * 86400000 });
export interface StructuralDiagnosticEvent { readonly ts: string; readonly event: string; readonly stage: string; readonly [key: string]: string | number | boolean; }
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN = /(prompt|path|url|uri|secret|email|content|command|output|argument|authorization|cookie|raw_|token|workspace_id|account_id|user_id|session_id|turn_id|thread_id)/i;
const FINGERPRINT = /^[a-f0-9]{24}$/;
const SAFE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SAFE_PROOF_STAGES = new Set(["account", "model-discovery", "connector", "readiness"]);
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
const STRINGS = new Set(["service", "capability", "turn_phase", "assistant_phase", "context_mode", "approval_mode", "outcome", "network_kind", "method_class", "resource_class", "reason_class", "delivery", "trigger", "state", "phase", "mode", "kind", "target_kind", "provider_kind", "platform", "policy", "route_kind", "action", "status", "environment", "native_signin", "web_signin", "comparison", "payload_state", "anchor_state"]);
/** Never copies unclassified text, identifiers or payloads from a raw diagnostic file. */
export function structuralDiagnosticEvent(value: unknown): StructuralDiagnosticEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts)) || typeof row.event !== "string" || !row.event.startsWith("chatgpt_tela_") || !SAFE_NAME.test(row.event)
    || typeof row.stage !== "string" || !SAFE_NAME.test(row.stage)) return;
  const safe: Record<string, string | number | boolean> = { ts: new Date(row.ts).toISOString(), event: row.event, stage: row.stage };
  for (const [key, field] of Object.entries(row).slice(0, 64)) {
    if (["ts", "event", "stage"].includes(key) || !SAFE_NAME.test(key) || FORBIDDEN.test(key)) continue;
    if (key === "proof_stage") {
      if (typeof field === "string" && SAFE_PROOF_STAGES.has(field)) safe[key] = field;
      continue;
    }
    if (key === "source_kind") {
      if (field === "native-visible-prefix" || field === "native-request-prefix") safe[key] = field;
      continue;
    }
    if (key === "planner_stage") {
      if (isWebContextPlannerStage(field)) safe[key] = field;
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
      events: events.slice(-DIAGNOSTIC_LIMITS.events), eventLimitReached: events.length > DIAGNOSTIC_LIMITS.events };
  } catch { return { state: "unavailable" as const, invalidTimestampRows: 0, malformedRows: 0, oversizedRows: 0,
    outsideWindowRows: 0, windowSelected: Boolean(window), bytesRead: 0, fileBytes: 0, truncated: false, events: [] as StructuralDiagnosticEvent[], eventLimitReached: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readDiagnosticSources(paths: readonly string[], window?: DiagnosticWindow) {
  const selected = [...new Set(paths)].slice(0, DIAGNOSTIC_LIMITS.sources);
  const sources = selected.map((path, index) => { const { events, ...coverage } = readDiagnosticTail(path, DIAGNOSTIC_LIMITS.tailBytes, window); return { index, coverage, events }; });
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
  return { events, excludedTestEvents, coverage: sources.map(({ index, coverage }) => ({ source: index, ...coverage })), sourceLimitReached: new Set(paths).size > selected.length };
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
        nativeResults: before.filter(row => ["native_tool_result_received", "native_tool_result_error", "native_tool_result_signal_anomaly"].includes(row.stage)).length,
        reportedErrors: before.filter(row => ["native_tool_result_error", "tool_error", "tool_failed"].includes(row.stage)).length,
        refusalSignals: before.filter(row => row.message_signal_observed === true).length,
        incompleteInspections: before.filter(row => row.inspection_complete === false).length,
        originProven: false, executionProven: false,
        preDispatchCoverage: "external-host-unobservable",
      },
      activeToolsAtReport: activeTools.size, activeProcessesAtReport: activeProcesses.size,
      processEvidence: latestProcess ? { stage: latestProcess.stage, at: latestProcess.ts } : null,
      lastLocalBeforeReport: lastBefore?.ts ?? null, firstLocalAfterReport: firstAfter?.ts ?? null,
      quietBeforeReportMs: quietMs ?? null, otherScopeCount: otherScopes.size,
      localSilenceWhileOthersProgress: observedOtherProgress, instanceCount: instances.length,
      hostContinuation: input.outputStartedAtMs !== undefined ? "host-reported" : "unverified" },
    timeline: target.slice(-DIAGNOSTIC_LIMITS.timeline), nearbyAnomalies: failures.slice(-16),
    gaps: ["Local response delivery is not proof of host display or model continuation.", "Scope/profile fingerprints are correlation signals, not authenticated account identities.", "Missing, rotated or unreadable evidence is not evidence of success.", "External host rejection before Tela ingress has no local tool receipt; a host report does not prove its internal cause.", "Approval acceptance does not grant or prove downstream safety review acceptance.", "Server-side reasoning and exact Web quota/token accounting are not observable."],
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
  if (!readdirSync(root).includes("START-HERE.md")) writeFileSync(guide, "# Tela diagnostics\n\nFirst run `chatgpt-tela diagnostics list`. Canonical incidents live in incidents/; INDEX.json is a rebuildable discovery index. Use `diagnostics inspect --ref <incident>` before raw events. `diagnostics record --at <ISO-time> --symptom <kind>` captures a bounded cross-service timeline. Private HTML/screenshots require explicit `diagnostics capture --minutes 15` or `--mode until-disabled`; stop with `--minutes 0`. Private capture stays local, retains at most 7 days/64 MiB/24 files, and must never be uploaded, returned through model tools or committed. Absence of evidence is not success. No background sampler runs.\n", { flag: "wx", mode: 0o600 });
}
function files(root: string, type: "incidents" | "private") {
  const path = join(root, type); if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("unsafe diagnostics directory");
  const pattern = type === "incidents" ? INCIDENT_NAME : ARTIFACT_NAME;
  return readdirSync(path).filter(name => pattern.test(name)).slice(0, 256).flatMap(name => {
    try {
      const stat = lstatSync(join(path,name)); if (!stat.isFile() || stat.isSymbolicLink()) return [];
      const proofName = type === "incidents" ? name : name.replace(/\.(?:html|jpg|json|meta\.json)$/, ".meta.json");
      const proofPath = join(path, proofName); const proofStat = lstatSync(proofPath);
      if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.size > (type === "incidents" ? 128*1024 : 4096)) return [];
      if (JSON.parse(readFileSync(proofPath,"utf8")).owner !== OWNER) return [];
      return [{ name, bytes: stat.size, time: stat.mtimeMs }];
    } catch { return []; }
  }).sort((a,b) => b.time - a.time);
}
function prune(root: string, type: "incidents" | "private", now = Date.now()) {
  let bytes = 0; let count = 0;
  const maxCount = type === "incidents" ? DIAGNOSTIC_LIMITS.incidents : DIAGNOSTIC_LIMITS.privateFiles;
  const maxBytes = type === "incidents" ? DIAGNOSTIC_LIMITS.incidentBytes : DIAGNOSTIC_LIMITS.privateBytes;
  const age = type === "incidents" ? DIAGNOSTIC_LIMITS.incidentAgeMs : DIAGNOSTIC_LIMITS.privateAgeMs;
  const groups = new Map<string, ReturnType<typeof files>>();
  for (const item of files(root,type)) {
    const key = type === "private" ? item.name.slice(0,45) : item.name;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key,group);
  }
  for (const group of groups.values()) {
    const groupBytes = group.reduce((sum,item) => sum+item.bytes,0);
    if (now-Math.max(...group.map(item=>item.time)) > age || count+group.length > maxCount || bytes+groupBytes > maxBytes) {
      for (const item of group) rmSync(join(root,type,item.name), { force: true });
    } else { bytes += groupBytes; count+=group.length; }
  }
}
export function listDiagnosticIncidents(root: string) {
  ownedRoot(resolve(root));
  prune(root,"incidents"); prune(root,"private");
  const records = files(root,"incidents").flatMap(item => {
    if (item.bytes > 128 * 1024) return [];
    try { const record = JSON.parse(readFileSync(join(root,"incidents",item.name),"utf8"));
      return record.owner === OWNER && record.schemaVersion === 1 ? [{ ref: item.name.replace(/\.json$/,""), recordedAt: record.recordedAt, observedAt: record.observedAt, stage: record.stage, symptom: record.hostReported?.symptom ?? "unknown", privateArtifactCount: record.privateArtifactCount ?? 0 }] : [];
    } catch { return []; }
  });
  atomic(join(root,"INDEX.json"), { owner: OWNER, schemaVersion: 1, generatedAt: new Date().toISOString(), entryPoint: "START-HERE.md", incidents: records });
  return records;
}
export function writeDiagnosticIncident(root: string, data: ReturnType<typeof analyzeDiagnosticEvents> | { readonly stage: string; readonly observedAt: string; readonly timeline: readonly StructuralDiagnosticEvent[] }) {
  ownedRoot(root);
  const ref = `incident_${randomUUID()}`;
  const last = data.timeline.at(-1); const fingerprint = last?.operation_fingerprint ?? last?.request_fingerprint;
  const artifacts = files(root,"private").filter(item => item.name.endsWith(".meta.json")).flatMap(item => {
    try {
      const metadata=JSON.parse(readFileSync(join(root,"private",item.name),"utf8"));
      return fingerprint && metadata.operationFingerprint === fingerprint && ["html","jpg","json"].includes(metadata.kind)
        ? [{ ref: item.name.replace(/\.meta\.json$/,""), kind: metadata.kind, bytes: metadata.bytes, privacy: "private" }] : [];
    } catch { return []; }
  });
  const record = { ...data, timeline: data.timeline.slice(-DIAGNOSTIC_LIMITS.timeline), owner: OWNER, schemaVersion: 1, ref, recordedAt: new Date().toISOString(), privateArtifactCount: artifacts.length, privateArtifacts: artifacts };
  while (Buffer.byteLength(JSON.stringify(record)) > 120 * 1024 && record.timeline.length) record.timeline.shift();
  if (Buffer.byteLength(JSON.stringify(record)) > 128 * 1024) throw new Error("incident exceeds budget");
  atomic(join(root,"incidents",`${ref}.json`), record); prune(root,"incidents"); listDiagnosticIncidents(root); return ref;
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
    retention: { days: DIAGNOSTIC_LIMITS.privateAgeMs / 86400000, bytes: DIAGNOSTIC_LIMITS.privateBytes, files: DIAGNOSTIC_LIMITS.privateFiles },
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
export function writePrivateDiagnosticArtifact(root: string, input: { kind: "html" | "jpg" | "json"; bytes: Uint8Array; operationFingerprint: string }) {
  if (!privateDiagnosticCaptureEnabled(root) || !FINGERPRINT.test(input.operationFingerprint)) return;
  if (!["html","jpg","json"].includes(input.kind)) throw new Error("invalid artifact kind");
  if (input.bytes.byteLength > DIAGNOSTIC_LIMITS.privateFileBytes) throw new Error("private artifact exceeds budget");
  ownedRoot(root); const ref=`artifact_${randomUUID()}`;
  writeFileSync(join(root,"private",`${ref}.${input.kind}`),input.bytes,{flag:"wx",mode:0o600});
  atomic(join(root,"private",`${ref}.meta.json`), { owner:OWNER, privacy:"private", operationFingerprint:input.operationFingerprint, kind:input.kind, bytes:input.bytes.byteLength });
  prune(root,"private"); return ref;
}
