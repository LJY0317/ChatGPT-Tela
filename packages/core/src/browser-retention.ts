/** On-demand state of the existing browser lifecycle owner; never an admission gate. */
export interface BrowserRetentionObservation {
  readonly total: number;
  readonly target: number;
  readonly active: number;
  readonly undelivered: number;
  /** Closing is not confirmed, including an already failed close. */
  readonly closing: number;
  /** Setup, non-task surfaces and pending acquisition outside the retained-task registry. */
  readonly otherOwners: number;
  readonly reclaimable: number;
  /** Only the explicitly selected owned surface; no page read or cleanup authority. */
  readonly surface?: {
    readonly id: string;
    readonly taskId: string;
    readonly state: "active" | "undelivered" | "closing" | "reclaimable" | "other_owner";
    readonly nextAction: "wait_for_work" | "inspect_result" | "inspect_close" | "allow_idle_cleanup" | "wait_for_owner";
    readonly idleExpiresAt?: string;
  };
}

export function parseBrowserRetentionObservation(value: unknown): BrowserRetentionObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid browser retention observation");
  const row = value as Record<string, unknown>;
  const result = {} as Record<Exclude<keyof BrowserRetentionObservation, "surface">, number>;
  for (const key of ["total", "target", "active", "undelivered", "closing", "otherOwners", "reclaimable"] as const) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) throw Error("Invalid browser retention observation");
    result[key] = row[key] as number;
  }
  const surface = row.surface as BrowserRetentionObservation["surface"];
  if (surface !== undefined && (!surface || typeof surface !== "object" || Array.isArray(surface)
    || typeof surface.id !== "string" || !surface.id || typeof surface.taskId !== "string" || !surface.taskId
    || !["active", "undelivered", "closing", "reclaimable", "other_owner"].includes(surface.state)
    || !["wait_for_work", "inspect_result", "inspect_close", "allow_idle_cleanup", "wait_for_owner"].includes(surface.nextAction)
    || surface.idleExpiresAt !== undefined && (typeof surface.idleExpiresAt !== "string"
      || !Number.isFinite(Date.parse(surface.idleExpiresAt))))) {
    throw Error("Invalid selected browser retention observation");
  }
  return Object.freeze({ ...result, ...(surface ? { surface: Object.freeze({ id: surface.id,
    taskId: surface.taskId, state: surface.state, nextAction: surface.nextAction,
    ...(surface.idleExpiresAt === undefined ? {} : { idleExpiresAt: surface.idleExpiresAt }) }) } : {}) });
}
