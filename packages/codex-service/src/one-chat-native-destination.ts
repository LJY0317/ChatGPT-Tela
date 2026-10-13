import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";
import type { NewOwnedNativeThreadTarget } from "./one-chat-checkpoint-handoff";

/**
 * Native-only target for a NEW conversation on a separately owned profile.
 * Public experimental Codex App Server thread/start + turn/start contracts.
 *
 * This target is deliberately NOT mounted on the installed service: callers
 * must implement authenticated exact-profile resolution and user selection.
 * The original source App Server/rollout/cookies are never copied.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_BYTES = 24 * 1024;
type Rpc = Pick<CodexAppServerRpc, "request" | "close">;

/**
 * A successful exact-id official thread/delete is not enough by itself:
 * post-delete read must independently fail as an exact missing thread.
 * Transport loss, an empty rollout or a different RPC error are NOT absence.
 */
export function isExactDeletedNativeThreadAbsent(error: unknown, threadId: string): boolean {
  if (!(error instanceof Error) || !UUID.test(threadId)) return false;
  return error.message.trim() === `thread not loaded: ${threadId}`
    || error.message.trim() === `thread not found: ${threadId}`;
}

export interface TrustedOwnedNewThreadTarget {
  readonly profile: (slot: number) => Promise<LocalProfileBinding>;
  readonly session: (slot: number) => Promise<TrustedNativeProfileSession>;
  readonly connect?: (endpoint: string, signal: AbortSignal) => Promise<Rpc>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validate(
  slot: number, binding: LocalProfileBinding, session: TrustedNativeProfileSession,
): void {
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99 || binding.slot !== slot
    || session.slot !== slot || binding.routeFingerprint !== session.responsesRouteFingerprint
    || !HASH.test(binding.accountFingerprint) || !HASH.test(binding.sessionFingerprint)
    || !HASH.test(binding.routeFingerprint)
    || !Number.isSafeInteger(session.runtimeProcessId) || session.runtimeProcessId < 1) {
    throw new Error("Destination new Native conversation is not bound to its actual profile owner");
  }
  let endpoint: URL;
  try { endpoint = new URL(session.terminalEndpoint); }
  catch { throw new Error("Destination Native owner endpoint is invalid"); }
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || !endpoint.port || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Destination Native owner endpoint is not an exact loopback session");
  }
}

function identical(a: { binding: LocalProfileBinding; session: TrustedNativeProfileSession },
  b: { binding: LocalProfileBinding; session: TrustedNativeProfileSession }): boolean {
  return a.binding.slot === b.binding.slot
    && a.binding.accountFingerprint === b.binding.accountFingerprint
    && a.binding.sessionFingerprint === b.binding.sessionFingerprint
    && a.binding.routeFingerprint === b.binding.routeFingerprint
    && a.session.runtimeProcessId === b.session.runtimeProcessId
    && a.session.terminalEndpoint === b.session.terminalEndpoint
    && a.session.responsesRouteFingerprint === b.session.responsesRouteFingerprint;
}

function ownedCwd(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 2048
    || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Destination native workspace is not an exact absolute local path");
  }
  const normalized = realpathSync(path);
  if (!lstatSync(normalized).isDirectory()) throw new Error("Destination native workspace is not a directory");
  return normalized;
}

export function createOwnedNewNativeThreadTarget(
  adapters: TrustedOwnedNewThreadTarget,
): NewOwnedNativeThreadTarget {
  const outstanding = new Map<string, {
    readonly slot: number;
    readonly cwd: string;
    readonly owner: { binding: LocalProfileBinding; session: TrustedNativeProfileSession };
  }>();
  const connect = adapters.connect
    ?? ((endpoint: string, signal: AbortSignal) =>
      connectCodexAppServerWebSocket(endpoint, { signal }));

  async function owner(slot: number) {
    const [binding, session] = await Promise.all([
      adapters.profile(slot), adapters.session(slot),
    ]);
    validate(slot, binding, session);
    return { binding, session };
  }

  return Object.freeze({
    async start(input: { destinationSlot: number; cwd: string }): Promise<{ threadId: string }> {
      if (outstanding.size >= 4) {
        throw new Error("Another destination new-thread handoff is still unresolved");
      }
      const cwd = ownedCwd(input.cwd);
      const before = await owner(input.destinationSlot);
      const rpc = await connect(before.session.terminalEndpoint, AbortSignal.timeout(8000));
      try {
        // sandbox read-only + no approvals prevents autonomous bootstrap
        // worktree writes. The first receipt is only to review the handoff.
        const result = object(await rpc.request("thread/start", {
          cwd, ephemeral: false, sandbox: "read-only", approvalPolicy: "never",
        }, AbortSignal.timeout(20_000)));
        const thread = object(result?.thread);
        if (!thread || typeof thread.id !== "string" || !UUID.test(thread.id)
          || thread.cwd !== cwd || thread.ephemeral === true) {
          throw new Error("Destination did not prove a fresh owned Native conversation");
        }
        const current = await owner(input.destinationSlot);
        if (!identical(before, current)) {
          throw new Error("Destination account/runtime changed after thread reservation");
        }
        outstanding.set(thread.id, { slot: input.destinationSlot, cwd, owner: before });
        return Object.freeze({ threadId: thread.id });
      } finally {
        await rpc.close();
      }
    },
    async seed(input: { destinationSlot: number; threadId: string; message: string }): Promise<{ turnId: string }> {
      if (!UUID.test(input.threadId) || typeof input.message !== "string"
        || !input.message.trim() || Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_BYTES) {
        throw new Error("Destination initial handoff request is malformed or oversized");
      }
      const pending = outstanding.get(input.threadId);
      if (!pending || pending.slot !== input.destinationSlot) {
        throw new Error("Destination bootstrap is not from this exact newly reserved Native thread");
      }
      // Idempotence is owned by durable OneChatHandoffJournal. This
      // in-memory guard additionally prevents reuse within one process.
      outstanding.delete(input.threadId);
      const before = await owner(pending.slot);
      if (!identical(before, pending.owner)) {
        throw new Error("Destination login/runtime changed before the first Native turn");
      }
      const rpc = await connect(before.session.terminalEndpoint, AbortSignal.timeout(8000));
      try {
        // A newly reserved Codex thread's empty rollout cannot be read yet:
        // official thread/read may throw "rollout ... is empty" until the
        // first turn. Rely on this adapter's one-time, unexposed
        // thread/start receipt and owner/session re-proof; never resume an
        // arbitrary old thread or re-send a possibly acknowledged first turn.
        const result = object(await rpc.request("turn/start", {
          threadId: input.threadId,
          input: [{ type: "text", text: input.message }],
          approvalPolicy: "never",
        }, AbortSignal.timeout(20_000)));
        const turn = object(result?.turn);
        if (!turn || typeof turn.id !== "string" || !UUID.test(turn.id)) {
          throw new Error("Destination Native turn/start acknowledgement was ambiguous");
        }
        const current = await owner(pending.slot);
        if (!identical(before, current)) {
          throw new Error("Destination account/runtime changed after first Native turn submission");
        }
        return Object.freeze({ turnId: turn.id });
      } finally {
        await rpc.close();
      }
    },
  });
}
