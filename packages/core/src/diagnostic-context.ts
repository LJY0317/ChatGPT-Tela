import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export interface DiagnosticContext {
  readonly request_fingerprint?: string;
  readonly operation_fingerprint?: string;
  readonly scope_fingerprint?: string;
  readonly profile_fingerprint?: string;
  readonly surface_fingerprint?: string;
  readonly rpc_fingerprint?: string;
  readonly parent_fingerprint?: string;
  readonly turn_fingerprint?: string;
}
const context = new AsyncLocalStorage<DiagnosticContext>();
export const DIAGNOSTIC_INSTANCE = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24);
export function diagnosticContext(): DiagnosticContext { return context.getStore() ?? {}; }
export function withDiagnosticContext<T>(fields: DiagnosticContext, action: () => T): T {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (["request_fingerprint", "operation_fingerprint", "scope_fingerprint", "profile_fingerprint", "rpc_fingerprint", "parent_fingerprint", "turn_fingerprint", "surface_fingerprint"].includes(key)
      && typeof value === "string" && /^[a-f0-9]{24}$/.test(value)) safe[key] = value;
  }
  return context.run({ ...diagnosticContext(), ...safe }, action);
}
/** Counts bytes only; content is never returned to a diagnostic sink. */
export function diagnosticSerializedBytes(value: unknown): number | undefined {
  try { const text = JSON.stringify(value); return text === undefined ? undefined : Buffer.byteLength(text); }
  catch { return undefined; }
}
