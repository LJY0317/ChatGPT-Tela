import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export type DiagnosticScalar = string | number | boolean;

const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN_FIELD = /(prompt|path|url|uri|token|secret|email|content|command|output|argument|authorization|cookie|session|turn_capability|workspace_id|account_id|user_id)/i;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
let emittedSinceRotationCheck = 0;

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
export function emitDiagnosticEvent(
  event: string,
  stage: string,
  fields: Readonly<Record<string, DiagnosticScalar>> = {},
): void {
  try {
    const normalized: Record<string, DiagnosticScalar> = {};
    for (const [key, value] of Object.entries(fields)) {
      safeName(key, "diagnostic field name");
      if (FORBIDDEN_FIELD.test(key)) throw new Error(`diagnostic field is forbidden: ${key}`);
      normalized[key] = safeFieldValue(value, key);
    }
    const line = `${JSON.stringify({
      event: safeName(event, "diagnostic event"),
      stage: safeName(stage, "diagnostic stage"),
      ...normalized,
    })}\n`;
    process.stderr.write(line);
    appendConfiguredDiagnosticFile(line);
  } catch {
    // Diagnostics are best-effort and can never replace or alter the primary product result.
  }
}

function diagnosticFilePath(): string | undefined {
  const value = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE?.trim();
  if (!value || !isAbsolute(value) || /[\u0000\r\n]/.test(value)) return undefined;
  return value;
}

function diagnosticMaxFileBytes(): number {
  const parsed = Number(process.env.CHATGPT_TELA_DIAGNOSTIC_MAX_BYTES ?? "");
  if (!Number.isSafeInteger(parsed) || parsed < 64 * 1024 || parsed > 64 * 1024 * 1024) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  return parsed;
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
          const previous = `${path}.1`;
          rmSync(previous, { force: true });
          renameSync(path, previous);
          try { chmodSync(previous, 0o600); } catch { /* Windows ACLs own permissions there. */ }
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
