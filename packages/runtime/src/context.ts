import type { WebPhysicalContext, WebPhysicalContextSegment } from "@chatgpt-tela/chatgpt";
import {
  planPhysicalContext,
  type ContextCheckpoint,
  type LogicalRevision,
  type PhysicalContextPlan,
  type RevisionLineage,
} from "@chatgpt-tela/core";

export interface ContextProjectionSource {
  revisionContent(revision: LogicalRevision): Promise<string>;
  checkpointContent(checkpoint: ContextCheckpoint): Promise<string>;
}

export type PreparedWebContext =
  | {
      readonly status: "ready";
      readonly plan: Extract<PhysicalContextPlan, { status: "ready" }>;
      readonly physicalContext: WebPhysicalContext;
    }
  | Extract<PhysicalContextPlan, { status: "checkpoint-required" }>;

/**
 * Materialize only the segments selected by the token planner.
 *
 * Old logical revisions remain in Native history and are not loaded merely to construct a compacted
 * Web transaction. A checkpoint projection lowers transfer cost but never replaces the logical head.
 */
export async function prepareWebContext(input: {
  readonly lineage: RevisionLineage;
  readonly headId: string;
  readonly source: ContextProjectionSource;
  readonly budgetTokens?: number;
  readonly checkpoint?: ContextCheckpoint;
}): Promise<PreparedWebContext> {
  const plan = planPhysicalContext({
    lineage: input.lineage,
    headId: input.headId,
    ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
  });
  if (plan.status === "checkpoint-required") return plan;

  const active = input.lineage.activePath(input.headId);
  const byId = new Map(active.map(revision => [revision.id, revision]));
  const segments: WebPhysicalContextSegment[] = [];

  if (plan.mode === "checkpoint-delta") {
    const checkpoint = input.checkpoint;
    if (!checkpoint || plan.checkpointId !== checkpoint.id) {
      throw new Error("physical context plan lost its selected checkpoint");
    }
    segments.push(Object.freeze({
      type: "checkpoint" as const,
      checkpointId: checkpoint.id,
      sourceRevisionId: checkpoint.revisionId,
      content: await input.source.checkpointContent(checkpoint),
    }));
  }

  for (const revisionId of plan.physicalRevisionIds) {
    const revision = byId.get(revisionId);
    if (!revision) throw new Error(`physical context plan references an inactive revision: ${revisionId}`);
    segments.push(Object.freeze({
      type: "revision" as const,
      revisionId: revision.id,
      kind: revision.kind,
      content: await input.source.revisionContent(revision),
    }));
  }

  return Object.freeze({
    status: "ready" as const,
    plan,
    physicalContext: Object.freeze({
      headRevisionId: input.headId,
      mode: plan.mode,
      logicalTokens: plan.logicalTokens,
      transferTokens: plan.transferTokens,
      segments: Object.freeze(segments),
    }),
  });
}
