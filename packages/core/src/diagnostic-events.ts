import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { diagnosticContext, DIAGNOSTIC_INSTANCE } from "./diagnostic-context";
import { structuralDiagnosticEvent, writeDiagnosticIncident, readDiagnosticIncident, diagnosticFailureIncidentRef, DIAGNOSTIC_LIMITS, type StructuralDiagnosticEvent } from "./diagnostic-store";

export type DiagnosticScalar = string | number | boolean;
export interface DiagnosticEventOptions { readonly scheduleIncident?: boolean; }

const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN_FIELD = /(prompt|path|url|uri|token|secret|email|content|command|output|argument|authorization|cookie|session|turn_capability|workspace_id|account_id|user_id)/i;
const DEFAULT_MAX_FILE_BYTES = DIAGNOSTIC_LIMITS.logFileBytes;
let emittedSinceRotationCheck = 0;
const recent: StructuralDiagnosticEvent[] = [];
const observers = new Set<(event: StructuralDiagnosticEvent) => void>();
/** Local, sanitized observation only; bounded subscribers and isolated callback failures. */
export function observeDiagnosticEvents(observer: (event: StructuralDiagnosticEvent) => void): (() => void) | undefined {
  if (observers.size >= 32) return undefined;
  observers.add(observer);
  return () => { observers.delete(observer); };
}
const pendingIncidents = new Map<string, { root: string; stage: string; observedAt: string; firstObservedAt: string; timeline: StructuralDiagnosticEvent[]; occurrences: number; failure: StructuralDiagnosticEvent; bytes: number }>();
let pendingIncidentBytes = 0;
function scheduleIncident(root: string, event: StructuralDiagnosticEvent) {
  const key = `${root}\n${diagnosticFailureIncidentRef(event)}`;
  const previous = pendingIncidents.get(key);
  const record = { root, stage: event.stage, observedAt: event.ts,
    firstObservedAt: previous?.firstObservedAt ?? event.ts, timeline: recent.slice(-64),
    occurrences: (previous?.occurrences ?? 0) + 1, failure: event };
  const bytes = Buffer.byteLength(JSON.stringify(record));
  if (pendingIncidentBytes - (previous?.bytes ?? 0) + bytes > DIAGNOSTIC_LIMITS.incidentBytes) {
    emitDiagnosticEvent("chatgpt_tela_diagnostics", "incident_capture_omitted", { reason_class: "byte_budget", requested_bytes: bytes });
    return;
  }
  pendingIncidentBytes += bytes - (previous?.bytes ?? 0);
  pendingIncidents.set(key, { ...record, bytes });
  if (previous) return;
  // One deferred write per failure identity, bounded by bytes rather than count.
  setImmediate(() => {
    const incident = pendingIncidents.get(key); pendingIncidents.delete(key);
    if (incident) {
      pendingIncidentBytes -= incident.bytes;
      try { const { root: target, bytes: _bytes, ...record } = incident; writeDiagnosticIncident(target, record); } catch { /* Best effort. */ }
    }
  });
}

function safeName(value: string, field: string): string {
  if (!SAFE_NAME.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function safeFieldValue(value: DiagnosticScalar, field: string): DiagnosticScalar {
  if (typeof value === "string") {
    if (value.length > 160 || /[\u0000\r\n]/.test(value)) throw new Error(`diagnostic ${field} is unsafe`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`diagnostic ${field} is invalid`);
    }
    return value;
  }
  return value;
}

/**
 * Emit one bounded, payload-free structural diagnostic event to stderr.
 *
 * Field names that commonly carry user data, credentials, local paths, request bodies, tool arguments,
 * or turn capability material are rejected up front. Callers should log only stage/status/count/duration/
 * fixed enum information and pseudonymous fingerprints when correlation is materially useful.
 */
function emitDiagnosticEventResult(
  event: string,
  stage: string,
  fields: Readonly<Record<string, DiagnosticScalar>> = {},
  options: DiagnosticEventOptions = {},
): StructuralDiagnosticEvent | undefined {
  try {
    const normalized: Record<string, DiagnosticScalar> = {};
    for (const [key, value] of Object.entries(fields)) {
      safeName(key, "diagnostic field name");
      if (FORBIDDEN_FIELD.test(key)) throw new Error(`diagnostic field is forbidden: ${key}`);
      normalized[key] = safeFieldValue(value, key);
    }
    const record = {
      ts: new Date().toISOString(),
      schema_version: 1,
      environment: process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT === "test" ? "test" : "runtime",
      instance_fingerprint: DIAGNOSTIC_INSTANCE,
      ...diagnosticContext(),
      event: safeName(event, "diagnostic event"),
      stage: safeName(stage, "diagnostic stage"),
      ...normalized,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > 8192) return;
    // stderr can be a pipe owned by the supervising Codex service. If that
    // supervisor disappears unexpectedly, stream-backed writes may surface an
    // asynchronous EPIPE outside this try/catch and crash Electron's main
    // process. Diagnostics are never correctness authority, so write the
    // underlying fd synchronously and ignore a closed/broken sink.
    try { writeSync(2, line); } catch { /* Best-effort stderr only. */ }
    appendConfiguredDiagnosticFile(line);
    const safe = structuralDiagnosticEvent(record);
    if (safe) {
      Object.freeze(safe);
      for (const observer of [...observers]) { try { observer(safe); } catch { /* Diagnostic-only subscriber. */ } }
      recent.push(safe);
      if (recent.length > 128) recent.shift();
      const root = configuredDiagnosticRoot();
      const authenticationBoundary = event === "chatgpt_tela_web_auth"
        && (stage === "auth_session_signed_out"
          || (stage === "auth_entry_removed" && normalized.removal_cause !== "overwrite"));
      if (options.scheduleIncident !== false && root
        && (authenticationBoundary || /(?:failed|error|timeout|crashed|unresponsive|rejected|anomaly)$/.test(stage))) {
        // Failure-triggered only. Never scan raw files, poll, capture payloads or block recovery.
        scheduleIncident(root, safe);
      }
      return safe;
    }
  } catch {
    // Diagnostics are best-effort and can never replace or alter the primary product result.
  }
  return undefined;
}

/** Emit and synchronously verify one canonical incident when local diagnostics are configured.
 * A stable reference alone is not a receipt: the returned ref exists only after file readback. */
export function emitDiagnosticEvent(
  event: string,
  stage: string,
  fields: Readonly<Record<string, DiagnosticScalar>> = {},
): void {
  emitDiagnosticEventResult(event, stage, fields);
}

export function emitDiagnosticIncident(
  event: string,
  stage: string,
  fields: Readonly<Record<string, DiagnosticScalar>> = {},
): { readonly event?: StructuralDiagnosticEvent; readonly state: "recorded" | "unavailable"; readonly ref?: string } {
  const emitted = emitDiagnosticEventResult(event, stage, fields, { scheduleIncident: false });
  if (!emitted) return { state: "unavailable" };
  const root = configuredDiagnosticRoot();
  if (!root) return { event: emitted, state: "unavailable" };
  try {
    const ref = writeDiagnosticIncident(root, { stage: emitted.stage, observedAt: emitted.ts,
      firstObservedAt: emitted.ts, occurrences: 1, timeline: recent.slice(-64), failure: emitted });
    const stored = readDiagnosticIncident(root, ref) as { readonly ref?: unknown };
    if (stored.ref !== ref) return { event: emitted, state: "unavailable" };
    return { event: emitted, state: "recorded", ref };
  } catch {
    return { event: emitted, state: "unavailable" };
  }
}

function diagnosticFilePath(): string | undefined {
  const value = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE?.trim();
  if (!value || !isAbsolute(value) || /[\u0000\r\n]/.test(value)) return undefined;
  return value;
}

export function configuredDiagnosticRoot(): string | undefined {
  const path = diagnosticFilePath();
  return path ? join(dirname(path), "diagnostics") : undefined;
}

function diagnosticMaxFileBytes(): number {
  const parsed = Number(process.env.CHATGPT_TELA_DIAGNOSTIC_MAX_BYTES ?? "");
  if (!Number.isSafeInteger(parsed) || parsed < 64 * 1024) return DEFAULT_MAX_FILE_BYTES;
  return Math.min(parsed, DIAGNOSTIC_LIMITS.logBytes / DIAGNOSTIC_LIMITS.logSegments);
}

function appendConfiguredDiagnosticFile(line: string): void {
  const path = diagnosticFilePath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    emittedSinceRotationCheck += 1;
    if (emittedSinceRotationCheck >= 64) {
      emittedSinceRotationCheck = 0;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) return;
        if (stat.size > diagnosticMaxFileBytes()) {
          // Rotate a fixed chain, newest first on read, with no background housekeeping.
          rmSync(`${path}.${DIAGNOSTIC_LIMITS.logSegments - 1}`, { force: true });
          for (let index = DIAGNOSTIC_LIMITS.logSegments - 2; index >= 0; index--) {
            const source = index === 0 ? path : `${path}.${index}`;
            const destination = `${path}.${index + 1}`;
            try {
              const stat = lstatSync(source);
              if (!stat.isFile() || stat.isSymbolicLink()) return;
              renameSync(source, destination);
              try { chmodSync(destination, 0o600); } catch { /* Windows ACLs own permissions there. */ }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
    }
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  } catch {
    // File diagnostics are optional and never affect the product operation.
  }
}

/** Return a bounded pseudonymous fingerprint suitable for local diagnostic correlation. */
export function diagnosticFingerprint(value: string): string {
  if (typeof value !== "string" || !value || value.length > 16_384 || value.includes("\u0000")) {
    throw new Error("diagnostic fingerprint input is invalid");
  }
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function diagnosticDurationMs(startedAtMs: number, endedAtMs = Date.now()): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(endedAtMs - startedAtMs));
}
