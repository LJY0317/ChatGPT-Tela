import { chatGptCheckpointInputTokens, type WebPhysicalContext } from "@chatgpt-tela/chatgpt";
import type { NativeRequestContextProjection, ProjectedNativeRevision } from "./native-request-planner";
import type { PreparedWebContext } from "@chatgpt-tela/runtime";
import type { WebWorkingContextPolicy } from "./web-working-context-policy";

/** Keep Native lineage intact; defer only complete, indexed original turns with a live reader. */
export function prepareDeferredNativeHistory(projection: NativeRequestContextProjection,
  policy: WebWorkingContextPolicy, budgetTokens = Number.MAX_SAFE_INTEGER): Extract<PreparedWebContext, { status: "ready" }> | undefined {
  const all = projection.revisions;
  const logicalTokens = all.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  const contextFor = (deferred: ReadonlySet<string>): WebPhysicalContext => ({
    mode: "full", headRevisionId: projection.headId,
    activeRequestRevisionId: [...all].reverse().find(item => item.revision.kind === "user" || item.revision.kind === "steering"
      || item.revision.kind === "developer" && projection.currentGoalStatus === "active")?.revision.id ?? projection.headId,
    logicalTokens, transferTokens: 0,
    segments: all.filter(item => !deferred.has(item.revision.id)).map(item => ({ type: "revision" as const,
      revisionId: item.revision.id, kind: item.revision.kind, content: item.content })),
    ...(deferred.size || projection.deferredHistory ? { deferredHistory: { scope: "prior-native-history" as const } } : {}),
  });
  const wireTokens = (deferred: ReadonlySet<string>) => chatGptCheckpointInputTokens(contextFor(deferred), projection.media);
  const fullWireTokens = wireTokens(new Set());
  if (!projection.deferredHistory && fullWireTokens <= budgetTokens
    && fullWireTokens + policy.outputReserveTokens < policy.hard.contextWindowTokenLimit) return undefined;
  const media = new Set(projection.media.map(item => item.revisionId));
  const protectedIds = new Set(projection.protectedRevisionIds);
  const turns = new Map<string, ProjectedNativeRevision[]>();
  for (const item of all) if (item.historicalTurnId) {
    const group = turns.get(item.historicalTurnId) ?? [];
    group.push(item); turns.set(item.historicalTurnId, group);
  }
  // Only attributed, readable prior turns may leave the working input. Current authority has
  // no historical turn attribution; old developer messages belong to their completed turn.
  // Unattributed input, pending work and media remain exact. Tool exchanges stay indivisible.
  const eligible = [...turns.entries()].filter(([, items]) => items.every(item =>
    !media.has(item.revision.id) && !protectedIds.has(item.revision.id)));
  // The latest complete exchange is current working state, even when a large
  // tool result makes it exceed the soft recent-history target.
  eligible.pop();
  if (!eligible.length && !projection.deferredHistory) return undefined;
  const deferred = new Set<string>();
  const deferredHistory = Object.freeze({ scope: "prior-native-history" as const });
  const eligibleIds = new Set(eligible.flatMap(([, items]) => items.map(item => item.revision.id)));
  const requiredTokens = all.filter(item => !eligibleIds.has(item.revision.id))
    .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  // Large exact authority must not drive the desired recent-history runway to zero.
  const targetTokens = Math.min(budgetTokens,
    Math.max(policy.firstMessageTargetTokens, requiredTokens + policy.suffixTargetTokens));
  let transferTokens = fullWireTokens;
  // Oldest complete turns leave first; the newest working successor stays exact.
  for (const [, items] of eligible) {
    if ((projection.deferredHistory || deferred.size) && transferTokens
      <= targetTokens) break;
    for (const item of items) deferred.add(item.revision.id);
    transferTokens = wireTokens(deferred);
  }
  if (!deferred.size && !projection.deferredHistory) return undefined;
  if (transferTokens > budgetTokens || transferTokens + policy.outputReserveTokens >= policy.hard.contextWindowTokenLimit) return undefined;
  const kept = all.filter(item => !deferred.has(item.revision.id));
  const physicalContext: WebPhysicalContext = Object.freeze({ ...contextFor(deferred), transferTokens, deferredHistory });
  return Object.freeze({ status: "ready", physicalContext, plan: {
    status: "ready" as const, mode: "full" as const, headId: projection.headId,
    logicalRevisionIds: all.map(item => item.revision.id), physicalRevisionIds: kept.map(item => item.revision.id),
    logicalTokens, transferTokens,
  } });
}
