import {
  NativeToolInventory,
  defineNativeTurnAuthority,
  type NativeTurnAuthority,
} from "@chatgpt-tela/core";
import { parseNativeTurnClaim, type NativeTurnClaim } from "./request";
import {
  readCanonicalCurrentTurn,
  type CanonicalCurrentTurnEvidence,
} from "./rollout";

export interface CanonicalCurrentTurnSource {
  currentTurn(threadId: string): Promise<CanonicalCurrentTurnEvidence | undefined>;
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

function validateOwner(claim: NativeTurnClaim, evidence: CanonicalCurrentTurnEvidence): void {
  if (claim.parentThreadId !== evidence.parentThreadId) {
    throw new Error("native request thread lineage does not match canonical Codex state");
  }
  const rootSentinelMatchesCanonicalRoot = claim.parentThreadId === undefined
    && evidence.parentThreadId === undefined
    && claim.agentName === "/root"
    && evidence.agentName === undefined;
  if (claim.agentName !== undefined
    && !rootSentinelMatchesCanonicalRoot
    && claim.agentName !== evidence.agentName) {
    throw new Error("native request agent identity does not match canonical Codex state");
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
