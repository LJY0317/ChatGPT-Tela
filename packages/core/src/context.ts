export type RevisionKind =
  | "system"
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "steering";

export interface LogicalRevision {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: RevisionKind;
  readonly estimatedTokens: number;
  /** Opaque reference to canonical content owned outside the transport planner. */
  readonly contentRef: string;
}

export interface ContextCheckpoint {
  readonly id: string;
  readonly revisionId: string;
  readonly estimatedTokens: number;
  /** Opaque reference to a replaceable compacted projection. */
  readonly projectionRef: string;
}

export type PhysicalContextPlan =
  | {
      readonly status: "ready";
      readonly mode: "full" | "checkpoint-delta";
      readonly headId: string;
      readonly logicalRevisionIds: readonly string[];
      readonly physicalRevisionIds: readonly string[];
      readonly checkpointId?: string;
      readonly logicalTokens: number;
      readonly transferTokens: number;
    }
  | {
      readonly status: "checkpoint-required";
      readonly headId: string;
      readonly logicalRevisionIds: readonly string[];
      readonly logicalTokens: number;
      readonly budgetTokens: number;
    };

function validCost(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export class RevisionLineage {
  readonly #revisions = new Map<string, LogicalRevision>();

  constructor(revisions: readonly LogicalRevision[]) {
    for (const revision of revisions) {
      if (!revision.id.trim()) throw new Error("revision id must be non-empty");
      if (this.#revisions.has(revision.id)) throw new Error(`duplicate revision id: ${revision.id}`);
      validCost(revision.estimatedTokens, `revision ${revision.id} estimatedTokens`);
      this.#revisions.set(revision.id, Object.freeze({ ...revision }));
    }
    for (const revision of this.#revisions.values()) {
      if (revision.parentId !== null && !this.#revisions.has(revision.parentId)) {
        throw new Error(`revision ${revision.id} has unknown parent ${revision.parentId}`);
      }
    }
  }

  activePath(headId: string): readonly LogicalRevision[] {
    const path: LogicalRevision[] = [];
    const visited = new Set<string>();
    let current = this.#revisions.get(headId);
    if (!current) throw new Error(`unknown context head: ${headId}`);

    while (current) {
      if (visited.has(current.id)) throw new Error(`revision cycle detected at ${current.id}`);
      visited.add(current.id);
      path.push(current);
      current = current.parentId === null ? undefined : this.#revisions.get(current.parentId);
    }
    return Object.freeze(path.reverse());
  }
}

/**
 * Select the cheapest semantically complete physical representation of the active logical lineage.
 * A checkpoint is a disposable projection: a stale branch checkpoint is ignored, never promoted to
 * logical authority.
 */
export function planPhysicalContext(input: {
  readonly lineage: RevisionLineage;
  readonly headId: string;
  readonly budgetTokens?: number;
  readonly checkpoint?: ContextCheckpoint;
}): PhysicalContextPlan {
  const active = input.lineage.activePath(input.headId);
  const logicalRevisionIds = active.map(revision => revision.id);
  const logicalTokens = active.reduce((sum, revision) => sum + revision.estimatedTokens, 0);
  const budgetTokens = input.budgetTokens ?? Number.MAX_SAFE_INTEGER;
  validCost(budgetTokens, "budgetTokens");

  const candidates: Array<{
    mode: "full" | "checkpoint-delta";
    transferTokens: number;
    physicalRevisionIds: readonly string[];
    checkpointId?: string;
  }> = [{
    mode: "full",
    transferTokens: logicalTokens,
    physicalRevisionIds: logicalRevisionIds,
  }];

  if (input.checkpoint) {
    validCost(input.checkpoint.estimatedTokens, `checkpoint ${input.checkpoint.id} estimatedTokens`);
    const checkpointIndex = logicalRevisionIds.indexOf(input.checkpoint.revisionId);
    if (checkpointIndex >= 0) {
      const physical = active.slice(checkpointIndex + 1);
      candidates.push({
        mode: "checkpoint-delta",
        checkpointId: input.checkpoint.id,
        physicalRevisionIds: physical.map(revision => revision.id),
        transferTokens: input.checkpoint.estimatedTokens
          + physical.reduce((sum, revision) => sum + revision.estimatedTokens, 0),
      });
    }
  }

  const best = candidates
    .filter(candidate => candidate.transferTokens <= budgetTokens)
    .sort((left, right) => left.transferTokens - right.transferTokens)[0];

  if (!best) {
    return Object.freeze({
      status: "checkpoint-required" as const,
      headId: input.headId,
      logicalRevisionIds: Object.freeze([...logicalRevisionIds]),
      logicalTokens,
      budgetTokens,
    });
  }

  return Object.freeze({
    status: "ready" as const,
    mode: best.mode,
    headId: input.headId,
    logicalRevisionIds: Object.freeze([...logicalRevisionIds]),
    physicalRevisionIds: Object.freeze([...best.physicalRevisionIds]),
    ...(best.checkpointId ? { checkpointId: best.checkpointId } : {}),
    logicalTokens,
    transferTokens: best.transferTokens,
  });
}
