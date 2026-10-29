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
}

export function parseBrowserRetentionObservation(value: unknown): BrowserRetentionObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid browser retention observation");
  const row = value as Record<string, unknown>;
  const result = {} as Record<keyof BrowserRetentionObservation, number>;
  for (const key of ["total", "target", "active", "undelivered", "closing", "otherOwners", "reclaimable"] as const) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) throw Error("Invalid browser retention observation");
    result[key] = row[key] as number;
  }
  return Object.freeze(result);
}
