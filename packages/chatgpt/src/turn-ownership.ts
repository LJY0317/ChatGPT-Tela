import { emitDiagnosticEvent, WebObservationUnproven } from "@chatgpt-tela/core";
import type { ChatGptSurfaceSnapshot, ChatGptTurnObservation } from "./surface";
import { isChatGptProvisionalConversationUrl } from "./session";

/** Exact expected text resolves alternatives only inside a unique logical user boundary.
 * Callers must still prove causal ownership, route and uniqueness; hashes alone grant none.
 */
export function authorFingerprint(turn: ChatGptTurnObservation | undefined, expected: string): string | undefined {
  if (!turn || turn.role !== "user") return undefined;
  if (turn.contentFingerprint !== undefined) return turn.contentFingerprint;
  const roots = turn.userPayloadStructure, candidates = turn.candidateFingerprints;
  return turn.lineageAnchor && turn.userPayloadReason === "ambiguous_author_root"
    && roots?.nestedRoots === true && roots.equivalentRoots === false
    && Number.isSafeInteger(roots.rootCount) && roots.rootCount >= 2 && roots.rootCount <= 64
    && candidates?.length === 2 && candidates[0] !== candidates[1]
    && candidates.filter(value => value === expected).length === 1 ? expected : undefined;
}

export interface TurnOwnership {
  userTurnKey: string;
  readonly acceptedUserFingerprint: string;
  readonly acceptedLineageAnchor?: string;
  /** A receipt made from an exact composer/send and a unique paired logical turn.
   * This is not authority to ignore later request edits after outside input. */
  readonly causalReceipt?: boolean;
  /** Input fencing proves the original send only through acceptance. Later input
   * requires renewed visible author proof; it does not cancel observation. */
  readonly inputUnchanged?: () => boolean;
  readonly observationInputState?: () => "unchanged" | "pending" | "changed";
  readonly acceptedUserCharacters?: number;
  conversationRoute: string;
  pendingConversationRoute?: string;
  /** Same-document navigation suspends delivery until the original request is re-proven. */
  navigationSuspended?: boolean;
  readonly baselineUserLineageKeys: ReadonlySet<string>;
  identityPending?: boolean;
  ownershipWitness?: string;
  ownershipWitnessCount?: number;
}

export function assistantFor(snapshot: ChatGptSurfaceSnapshot, userTurnKey: string): readonly ChatGptTurnObservation[] {
  return snapshot.turns.filter(turn => turn.role === "assistant" && turn.parentUserTurnKey === userTurnKey);
}

export interface AssistantLineageResolution {
  readonly assistants: readonly ChatGptTurnObservation[];
  readonly ambiguous: boolean;
  readonly identityPending?: boolean;
}

export function baselineUserLineageKeys(snapshot: ChatGptSurfaceSnapshot): ReadonlySet<string> {
  return new Set(snapshot.turns.flatMap(turn => turn.role === "user"
    ? [turn.key]
    : turn.parentUserTurnKey ? [turn.parentUserTurnKey] : []));
}

/**
 * ChatGPT may replace the provisional data-turn-key after server hydration. Keep the accepted
 * provider handle stable, but rebind its renderer key only when exactly one assistant lineage is
 * new relative to the pre-submit baseline. Multiple new lineages are never guessed between.
 */
function observationUnchanged(tracked: TurnOwnership): boolean {
  return tracked.observationInputState ? tracked.observationInputState() === "unchanged" : tracked.inputUnchanged?.() === true;
}
function ownedAuthorFingerprint(turn: ChatGptTurnObservation | undefined, tracked: TurnOwnership): string | undefined {
  // This receipt binds the submitted composer, not a display-text digest. A
  // separately proven viewing gesture does not mutate that request. Unknown
  // or editing input still requires renewed exact author proof and lineage.
  if (tracked.causalReceipt && observationUnchanged(tracked) && turn?.role === "user" && tracked.acceptedLineageAnchor
    && turn.lineageAnchor === tracked.acceptedLineageAnchor) return tracked.acceptedUserFingerprint;
  const payload = authorFingerprint(turn, tracked.acceptedUserFingerprint);
  return payload;
}

export function resolveAssistantLineage(
  snapshot: ChatGptSurfaceSnapshot,
  tracked: TurnOwnership,
): AssistantLineageResolution {
  // A host hit-test is in flight. No stale author/route evidence may authorize delivery.
  if (tracked.observationInputState?.() === "pending") {
    if (!tracked.identityPending) emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_pending", { reason_class: "inspection_input_pending" });
    tracked.identityPending = true;
    return { assistants: [], ambiguous: false, identityPending: true };
  }
  const routeProven = true;
  // Hydration can omit the accepted user bubble. Its exact accepted document/turn
  // anchor still proves the parent; an unanchored placeholder never does. Route
  // ownership above remains mandatory, including canonical-route hydration proof.
  const direct = routeProven ? assistantFor(snapshot, tracked.userTurnKey) : [];
  const anchored = tracked.acceptedLineageAnchor !== undefined
    && direct.length === 1 && direct[0]!.lineageAnchor === tracked.acceptedLineageAnchor;
  const acceptedUserPresent = snapshot.turns.some(item => item.role === "user" && item.key === tracked.userTurnKey);
  const newUsers = snapshot.turns.filter(item => item.role === "user"
    && item.key !== tracked.userTurnKey && !tracked.baselineUserLineageKeys.has(item.key));
  const rekeyCandidate = newUsers.length === 1
    && ownedAuthorFingerprint(newUsers[0], tracked) === tracked.acceptedUserFingerprint
    && (!tracked.acceptedLineageAnchor || newUsers[0]!.lineageAnchor === tracked.acceptedLineageAnchor);
  const identityPending = !routeProven || !acceptedUserPresent && !anchored && !rekeyCandidate;
  if (tracked.identityPending !== identityPending) {
    tracked.identityPending = identityPending;
    if (identityPending) emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_pending", {
      reason_class: routeProven ? "user_not_rendered" : "canonical_route_pending",
      assistant_count: snapshot.turns.filter(item => item.role === "assistant").length,
    });
    else emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_resumed", { contract_version: 1 });
  }
  if (!routeProven) return { assistants: [], ambiguous: false, identityPending: true };
  if (identityPending) {
    const candidates = snapshot.turns.filter(item => item.role === "assistant" && item.parentUserTurnKey
      && !tracked.baselineUserLineageKeys.has(item.parentUserTurnKey));
    if (new Set(candidates.map(item => item.parentUserTurnKey)).size > 1) {
      return { assistants: candidates, ambiguous: true };
    }
    return { assistants: [], ambiguous: false, identityPending: true };
  }
  if (direct.length > 0) {
    return { assistants: direct, ambiguous: false };
  }

  const byParent = new Map<string, ChatGptTurnObservation[]>();
  for (const turn of snapshot.turns) {
    if (turn.role !== "assistant" || !turn.parentUserTurnKey) continue;
    if (tracked.baselineUserLineageKeys.has(turn.parentUserTurnKey)) continue;
    const items = byParent.get(turn.parentUserTurnKey) ?? [];
    items.push(turn);
    byParent.set(turn.parentUserTurnKey, items);
  }
  if (byParent.size === 0) return { assistants: [], ambiguous: false };
  if (byParent.size > 1) {
    return { assistants: [...byParent.values()].flat(), ambiguous: true };
  }

  const [nextKey, assistants] = byParent.entries().next().value!;
  const user = snapshot.turns.find(item => item.role === "user" && item.key === nextKey);
  if (!user) return { assistants: [], ambiguous: false, identityPending: true };
  emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rebound", { reason_class: "same_request" });
  tracked.userTurnKey = nextKey;
  return { assistants, ambiguous: false };
}
