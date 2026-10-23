import {
  NativeToolInventory,
  defineNativeTurnAuthority,
  type NativeTurnAuthority,
} from "@chatgpt-tela/core";
import { parseNativeTurnClaim, parseNativeCompactionClaim, type NativeTurnClaim } from "./request";
import {
  readCanonicalCurrentTurn,
  type CanonicalCurrentTurnEvidence,
} from "./rollout";

export interface NativeTurnTerminationWatch {
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

export interface CanonicalCurrentTurnSource {
  currentTurn(threadId: string): Promise<CanonicalCurrentTurnEvidence | undefined>;
  /** Active-turn scoped public Native lifecycle; transport reconnects are not cancellation. */
  watchTurn?(threadId: string, turnId: string, signal?: AbortSignal): Promise<NativeTurnTerminationWatch | undefined>;
}

export interface NativeTurnBinding {
  readonly claim: NativeTurnClaim;
  readonly authority: NativeTurnAuthority;
  readonly tools: NativeToolInventory;
  readonly canonicalEvidence: CanonicalCurrentTurnEvidence;
}

export class RolloutFileCurrentTurnSource implements CanonicalCurrentTurnSource {
  readonly #locateRollout: (threadId: string) => Promise<string | undefined> | string | undefined;

  constructor(
    locateRollout: (threadId: string) => Promise<string | undefined> | string | undefined,
  ) {
    this.#locateRollout = locateRollout;
  }

  async currentTurn(threadId: string): Promise<CanonicalCurrentTurnEvidence | undefined> {
    const rolloutPath = await this.#locateRollout(threadId);
    return rolloutPath ? readCanonicalCurrentTurn(rolloutPath, threadId) : undefined;
  }
}

export type NativeBindingReason = "claim_invalid" | "owner_unavailable" | "owner_changed" | "lineage_changed" | "agent_changed" | "owner_read_failed";
export class NativeBindingError extends Error {
  readonly code = "tela_native_binding_unproven";
  constructor(readonly reason: NativeBindingReason, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "NativeBindingError";
  }
}

function validateOwner(claim: Omit<NativeTurnClaim, "requestKind">, evidence: CanonicalCurrentTurnEvidence): void {
  if (claim.parentThreadId !== evidence.parentThreadId) {
    throw new NativeBindingError("lineage_changed", "native request thread lineage does not match canonical Codex state");
  }
  const rootSentinelMatchesCanonicalRoot = claim.parentThreadId === undefined
    && evidence.parentThreadId === undefined
    && claim.agentName === "/root"
    && evidence.agentName === undefined;
  if (claim.agentName !== undefined
    && !rootSentinelMatchesCanonicalRoot
    && claim.agentName !== evidence.agentName) {
    throw new NativeBindingError("agent_changed", "native request agent identity does not match canonical Codex state");
  }
}

/**
 * Bind an inbound Native Codex request only after canonical storage proves that it names the exact
 * current task. Current-turn tool advertisements become usable only after this binding succeeds.
 */
export async function bindNativeTurnRequest(
  body: unknown,
  source: CanonicalCurrentTurnSource,
): Promise<NativeTurnBinding> {
  const claim = parseNativeTurnClaim(body);
  const evidence = await source.currentTurn(claim.threadId);
  if (!evidence) {
    throw new Error("no canonical current-turn authority for the requested native thread");
  }
  if (evidence.threadId !== claim.threadId || evidence.turnId !== claim.turnId) {
    throw new Error("native request does not name the canonical current turn");
  }
  validateOwner(claim, evidence);

  const authority = defineNativeTurnAuthority({
    threadId: evidence.threadId,
    turnId: evidence.turnId,
    cwd: evidence.cwd,
    workspaceRoots: evidence.workspaceRoots,
    sandbox: evidence.sandbox,
  });
  const tools = NativeToolInventory.fromObservations(
    claim.threadId,
    claim.turnId,
    claim.toolObservations,
  );

  return Object.freeze({
    claim,
    authority,
    tools,
    canonicalEvidence: evidence,
  });
}

/** Verify an inert summary request against the same canonical current-turn owner. */
export async function bindNativeCompactionRequest(body: unknown, source: CanonicalCurrentTurnSource) {
  let claim: ReturnType<typeof parseNativeCompactionClaim>;
  try { claim = parseNativeCompactionClaim(body); }
  catch (cause) { throw new NativeBindingError("claim_invalid", "Native compaction claim is invalid", { cause }); }
  let evidence: CanonicalCurrentTurnEvidence | undefined;
  try { evidence = await source.currentTurn(claim.threadId); }
  catch (cause) { throw new NativeBindingError("owner_read_failed", "Native compaction owner could not be read", { cause }); }
  if (!evidence) throw new NativeBindingError("owner_unavailable", "Native compaction current owner is unavailable");
  if (evidence.threadId !== claim.threadId || evidence.turnId !== claim.turnId) {
    throw new NativeBindingError("owner_changed", "Native compaction request does not name the canonical current turn");
  }
  validateOwner(claim, evidence);
  return Object.freeze({ claim, evidence });
}
