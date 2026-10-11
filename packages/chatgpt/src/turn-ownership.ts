import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import type { ChatGptSurfaceSnapshot, ChatGptTurnObservation } from "./surface";
import { isChatGptProvisionalConversationUrl } from "./session";

export interface TurnOwnership {
  userTurnKey: string;
  readonly acceptedUserFingerprint: string;
  readonly acceptedLineageAnchor?: string;
  conversationRoute: string;
  pendingConversationRoute?: string;
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
function assertTurnOwnership(snapshot: ChatGptSurfaceSnapshot, tracked: TurnOwnership): boolean {
  const route = new URL(snapshot.url).origin + new URL(snapshot.url).pathname;
  const users = snapshot.turns.filter(item => item.role === "user" && item.key === tracked.userTurnKey);
  const current = users[0];
  const payloadState = !current ? "unmounted" : current.contentFingerprint === undefined ? "unavailable"
    : current.contentFingerprint === tracked.acceptedUserFingerprint ? "matching" : "changed";
  const anchorState = !current?.lineageAnchor || !tracked.acceptedLineageAnchor ? "unavailable"
    : current.lineageAnchor === tracked.acceptedLineageAnchor ? "matching" : "changed";
  const proofReason = current?.userPayloadReason;
  const reasonClass = proofReason && ["author_payload", "author_root_missing", "ambiguous_author_root", "author_payload_empty", "author_payload_budget"].includes(proofReason)
    ? proofReason : "unclassified";
  // One bounded witness per structural transition, never text, raw identifiers or polling.
  const witness = JSON.stringify([payloadState, anchorState, reasonClass, users.length, route === tracked.conversationRoute,
    snapshot.turns.filter(item => item.role === "assistant").length]);
  if (tracked.ownershipWitness !== witness) {
    tracked.ownershipWitness = witness;
    const count = tracked.ownershipWitnessCount = (tracked.ownershipWitnessCount ?? 0) + 1;
    if (count <= 64) emitDiagnosticEvent("chatgpt_tela_work", "web_turn_ownership_observed", {
      contract_version: 1, payload_state: payloadState, anchor_state: anchorState,
      accepted_key_count: users.length, route_matches: route === tracked.conversationRoute,
      reason_class: reasonClass,
      author_root_available: current?.contentFingerprint !== undefined, witness_count: count,
    });
    else if (count === 65) emitDiagnosticEvent("chatgpt_tela_work", "web_turn_ownership_budget_reached", { witness_count: 64 });
  }
  if (users.length > 1 || anchorState === "changed") {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", {
      reason_class: users.length > 1 ? "duplicate_accepted_key" : "accepted_anchor_changed",
    });
    throw new Error("ChatGPT accepted user identity changed during the active Web turn");
  }
  const accepted = snapshot.turns.filter(item => item.role === "user"
    && item.contentFingerprint === tracked.acceptedUserFingerprint);
  // Pin the first canonical candidate without committing it. A second navigation,
  // including back to the provisional route, cannot borrow this pending proof.
  if (tracked.pendingConversationRoute && route !== tracked.pendingConversationRoute) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", {
      reason_class: "pending_route_changed", matching_user_count: accepted.length,
    });
    throw new Error("ChatGPT conversation changed during the active Web turn");
  }
  if (route !== tracked.conversationRoute) {
    const previous = new URL(tracked.conversationRoute);
    const next = new URL(route);
    const acceptedUser = accepted.length === 1 ? accepted[0] : undefined;
    const newLineages = new Set(snapshot.turns.flatMap(item => item.role === "assistant"
      && item.parentUserTurnKey && !tracked.baselineUserLineageKeys.has(item.parentUserTurnKey)
      ? [item.parentUserTurnKey] : []));
    const sameKey = acceptedUser?.key === tracked.userTurnKey;
    const provenRekey = acceptedUser !== undefined
      && !tracked.baselineUserLineageKeys.has(acceptedUser.key)
      && newLineages.size === 1 && newLineages.has(acceptedUser.key);
    // Route hydration and request rendering are independent observations. Keep an
    // incomplete transition pending; no progress, result handoff or answer can use it.
    // The runtime's owned-document signal still cancels reload/replacement/loss.
    const previousProvisional = isChatGptProvisionalConversationUrl(previous.href);
    const canonicalTransition = previous.origin === next.origin
      && (previous.pathname === "/" || previousProvisional)
      && /^\/c\/[^/]+$/.test(next.pathname) && !isChatGptProvisionalConversationUrl(next.href);
    if (canonicalTransition && acceptedUser && (sameKey || provenRekey)) {
      tracked.conversationRoute = route;
      delete tracked.pendingConversationRoute;
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rebound", {
        reason_class: "canonical_route", renderer_key_changed: !sameKey,
      });
    } else if (canonicalTransition && (
      // An empty/unanchored renderer provides no contrary request identity. It
      // cannot authorize anything until the exact accepted request is rendered.
      accepted.length === 0 && !snapshot.turns.some(item => item.role === "user") && newLineages.size <= 1
      || current !== undefined && payloadState === "unavailable" && users.length === 1
        && snapshot.turns.filter(item => item.role === "user").every(item =>
          item.key === tracked.userTurnKey || tracked.baselineUserLineageKeys.has(item.key))
        && newLineages.size <= 1
      // A uniquely matching rekeyed request may precede its assistant lineage.
      || acceptedUser !== undefined && !tracked.baselineUserLineageKeys.has(acceptedUser.key) && newLineages.size === 0
    )) {
      tracked.pendingConversationRoute = route;
      return false;
    } else {
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", {
        reason_class: "conversation_changed", matching_user_count: accepted.length,
        previous_route_initial: previous.pathname === "/", same_origin: previous.origin === next.origin,
        previous_route_provisional: previousProvisional,
        route_kind: /^\/c\/[^/]+$/.test(next.pathname) ? "conversation" : next.pathname === "/" ? "initial" : "other",
        accepted_key_matches: sameKey, new_lineage_count: newLineages.size, rekey_proven: provenRekey,
      });
      throw new Error("ChatGPT conversation changed during the active Web turn");
    }
  }
  if (payloadState === "changed") {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", { reason_class: "accepted_user_changed" });
    throw new Error("ChatGPT accepted user identity changed during the active Web turn");
  }
  // Missing author content is inconclusive, not evidence of a foreign request.
  // Do not deliver progress/results or accept a completed answer until proof returns.
  if (current && payloadState === "unavailable") return false;
  return true;
}

export function resolveAssistantLineage(
  snapshot: ChatGptSurfaceSnapshot,
  tracked: TurnOwnership,
): AssistantLineageResolution {
  const routeProven = assertTurnOwnership(snapshot, tracked);
  // Hydration can omit the accepted user bubble. Its exact accepted document/turn
  // anchor still proves the parent; an unanchored placeholder never does. Route
  // ownership above remains mandatory, including canonical-route hydration proof.
  const direct = routeProven ? assistantFor(snapshot, tracked.userTurnKey) : [];
  const anchored = tracked.acceptedLineageAnchor !== undefined
    && direct.length === 1 && direct[0]!.lineageAnchor === tracked.acceptedLineageAnchor;
  const acceptedUserPresent = snapshot.turns.some(item => item.role === "user" && item.key === tracked.userTurnKey);
  if (acceptedUserPresent && tracked.acceptedLineageAnchor && direct.some(item => item.lineageAnchor && item.lineageAnchor !== tracked.acceptedLineageAnchor)) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", { reason_class: "assistant_anchor_changed" });
    throw new Error("ChatGPT assistant identity conflicts with the accepted document anchor");
  }
  const newUsers = snapshot.turns.filter(item => item.role === "user"
    && item.key !== tracked.userTurnKey && !tracked.baselineUserLineageKeys.has(item.key));
  if (acceptedUserPresent && newUsers.length) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", {
      reason_class: "competing_user", new_user_count: newUsers.length,
    });
    throw new Error("ChatGPT opened another user turn during the active Web turn");
  }
  if (!acceptedUserPresent && newUsers.some(item => item.contentFingerprint !== undefined
    && item.contentFingerprint !== tracked.acceptedUserFingerprint)) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", { reason_class: "foreign_request" });
    throw new Error("ChatGPT renderer request identity conflicts with the accepted request");
  }
  const rekeyCandidate = newUsers.length === 1 && newUsers[0]!.contentFingerprint === tracked.acceptedUserFingerprint;
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
    const users = snapshot.turns.filter(item => item.role === "user" && item.key === tracked.userTurnKey);
    if (users.length === 0 && anchored) return { assistants: direct, ambiguous: false };
    if (users.length !== 1 || users[0]!.contentFingerprint !== tracked.acceptedUserFingerprint) {
      emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", { reason_class: "unproven_parent" });
      throw new Error("ChatGPT assistant parent does not prove the accepted request identity");
    }
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
  const matchingUsers = snapshot.turns.filter(item => item.role === "user"
    && item.contentFingerprint === tracked.acceptedUserFingerprint);
  if (!user || user.contentFingerprint !== tracked.acceptedUserFingerprint || matchingUsers.length !== 1) {
    emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rejected", {
      reason_class: "unproven_rekey", parent_user_present: user !== undefined,
      parent_fingerprint_matches: user?.contentFingerprint === tracked.acceptedUserFingerprint,
      matching_user_count: matchingUsers.length,
      user_count: snapshot.turns.filter(item => item.role === "user").length,
      prior_user_present: snapshot.turns.some(item => item.role === "user" && item.key === tracked.userTurnKey),
      new_lineage_count: byParent.size,
    });
    throw new Error("ChatGPT renderer rekey does not prove the accepted request identity");
  }
  emitDiagnosticEvent("chatgpt_tela_work", "web_turn_identity_rebound", { reason_class: "same_request" });
  tracked.userTurnKey = nextKey;
  return { assistants, ambiguous: false };
}
