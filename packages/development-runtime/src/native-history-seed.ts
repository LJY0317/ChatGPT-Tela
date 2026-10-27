import type { WebPhysicalContext } from "@chatgpt-tela/chatgpt";
import type { NativeRequestContextProjection, ProjectedNativeRevision } from "./native-request-planner";
import type { PreparedWebContext } from "@chatgpt-tela/runtime";
import type { WebWorkingContextPolicy } from "./web-working-context-policy";

/** Keep Native lineage intact; defer only complete, indexed original turns with a live reader. */
export function prepareDeferredNativeHistory(projection: NativeRequestContextProjection,
  policy: WebWorkingContextPolicy, budgetTokens = Number.MAX_SAFE_INTEGER): Extract<PreparedWebContext, { status: "ready" }> | undefined {
  const all = projection.revisions;
  const logicalTokens = all.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  if (!projection.deferredHistory && logicalTokens + policy.outputReserveTokens < policy.hard.contextWindowTokenLimit) return undefined;
  const media = new Set(projection.media.map(item => item.revisionId));
  const protectedIds = new Set(projection.protectedRevisionIds);
  const turns = new Map<string, ProjectedNativeRevision[]>();
  for (const item of all) if (item.historicalTurnId) {
    const group = turns.get(item.historicalTurnId) ?? [];
    group.push(item); turns.set(item.historicalTurnId, group);
  }
  // Never defer Native input, current authority, pending work or bytes that the text reader
  // cannot actually deliver. A turn is an indivisible exchange, including its tool results.
  const eligible = [...turns.entries()].filter(([, items]) => items.every(item =>
    !media.has(item.revision.id) && !protectedIds.has(item.revision.id)
    && item.revision.kind !== "system" && item.revision.kind !== "developer"));
  if (!eligible.length && !projection.deferredHistory) return undefined;
  const deferred = new Set<string>();
  const deferredHistory = Object.freeze({ scope: "prior-native-history" as const });
  const manifestTokens = Math.ceil(Buffer.byteLength(JSON.stringify(deferredHistory)) / 4);
  let keptTokens = logicalTokens;
  // Oldest complete turns leave first; the newest working successor stays exact.
  for (const [, items] of eligible) {
    if ((projection.deferredHistory || deferred.size) && keptTokens + manifestTokens
      <= Math.min(policy.firstMessageTargetTokens, budgetTokens)) break;
    for (const item of items) deferred.add(item.revision.id);
    keptTokens -= items.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  }
  const transferTokens = keptTokens + manifestTokens;
  if (transferTokens > budgetTokens || transferTokens + policy.outputReserveTokens >= policy.hard.contextWindowTokenLimit) return undefined;
  const kept = all.filter(item => !deferred.has(item.revision.id));
  const segments: WebPhysicalContext["segments"] = kept.map(item => ({ type: "revision",
    revisionId: item.revision.id, kind: item.revision.kind, content: item.content }));
  const physicalContext: WebPhysicalContext = Object.freeze({
    mode: "full", headRevisionId: projection.headId,
    activeRequestRevisionId: [...all].reverse().find(item => item.revision.kind === "user" || item.revision.kind === "steering"
      || item.revision.kind === "developer" && projection.currentGoalStatus === "active")?.revision.id ?? projection.headId,
    logicalTokens, transferTokens, segments: Object.freeze(segments), deferredHistory,
  });
  return Object.freeze({ status: "ready", physicalContext, plan: {
    status: "ready" as const, mode: "full" as const, headId: projection.headId,
    logicalRevisionIds: all.map(item => item.revision.id), physicalRevisionIds: kept.map(item => item.revision.id),
    logicalTokens, transferTokens,
  } });
}
