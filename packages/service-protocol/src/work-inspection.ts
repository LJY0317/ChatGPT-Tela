const CHECKPOINT_REASON = ["owner_unavailable", "storage_unavailable", "no_local_candidates", "projection_unavailable"] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid work inspection contract");
  return value as Record<string, unknown>;
}

export function parseCodexCheckpointInspectionContract(value: unknown, slot: number, threadId: string) {
  const row = object(value);
  if (row.contractVersion !== 1 || row.slot !== slot || row.threadId !== threadId
    || !["available", "unavailable", "unknown"].includes(String(row.readiness))
    || !CHECKPOINT_REASON.includes(row.reason as typeof CHECKPOINT_REASON[number])) {
    throw Error("invalid checkpoint inspection owner or state");
  }
  const readiness = row.readiness as "available" | "unavailable" | "unknown";
  const reason = row.reason as typeof CHECKPOINT_REASON[number];
  if (readiness !== "available") {
    if (reason !== "owner_unavailable" && reason !== "storage_unavailable") {
      throw Error("invalid unavailable checkpoint reason");
    }
    return Object.freeze({ readiness, reason });
  }
  const bounded = (key: string, max: number): number => {
    const n = row[key];
    if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > max) {
      throw Error("invalid bounded checkpoint candidate count");
    }
    return n as number;
  };
  const cachedForThread = bounded("cachedForThread", 64);
  const completedReceipts = bounded("completedReceipts", 64);
  const publishedForAccount = bounded("publishedForAccount", 32);
  const matchingReuseScope = bounded("matchingReuseScope", publishedForAccount);
  if ((reason !== "no_local_candidates" && reason !== "projection_unavailable")
    || (reason === "no_local_candidates" && (cachedForThread || publishedForAccount))
    || row.exactScope !== "unknown" || row.prefix !== "unknown" || row.anchor !== "unknown") {
    throw Error("unverified checkpoint selection claim");
  }
  return Object.freeze({ readiness, reason, cachedForThread, completedReceipts,
    publishedForAccount, matchingReuseScope,
    exactScope: "unknown" as const, prefix: "unknown" as const, anchor: "unknown" as const });
}
