/** Local managed-job admission snapshot, not a claim about the Web provider's quota. */
export type WebDelegationMode = "read" | "write";
export type WebDelegationBlockCode = "CAPACITY_READER_PROFILE" | "CAPACITY_WRITER_PROFILE"
  | "CAPACITY_WRITER_CHECKOUT" | "CAPACITY_TOTAL_PROFILE" | "CAPACITY_STORAGE_RECORDS" | "UNCERTAIN_RESERVATION";
export interface CodexWebDelegationCapacityContract {
  readonly contractVersion: 1;
  readonly source: "managed_delegation_journal";
  readonly observedAt: string;
  readonly profileSlot: number;
  readonly policy: "temporary_1_writer_2_readers_v1";
  readonly coverage: "managed_jobs_only";
  readonly requestedMode: WebDelegationMode;
  readonly writers: { readonly used: number; readonly limit: 1; readonly uncertain: number };
  readonly readers: { readonly used: number; readonly limit: 2; readonly uncertain: number };
  readonly total: { readonly used: number; readonly limit: 3 };
  readonly records: { readonly retained: number; readonly limit: 64 };
  readonly available: boolean;
  readonly blockCode?: WebDelegationBlockCode;
  readonly messageKo: string;
  readonly messageEn: string;
  readonly nextAction: "start_if_profile_ready" | "wait_for_active_job"
    | "inspect_and_reconcile_exact_job" | "review_owned_finished_records";
}

/** Shared by CLI, authenticated service consumers and the product UI. */
export function parseCodexWebDelegationCapacityContract(value: unknown): CodexWebDelegationCapacityContract {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const readers = row?.readers && typeof row.readers === "object" && !Array.isArray(row.readers)
    ? row.readers as Record<string, unknown> : undefined;
  const writers = row?.writers && typeof row.writers === "object" && !Array.isArray(row.writers)
    ? row.writers as Record<string, unknown> : undefined;
  const total = row?.total && typeof row.total === "object" && !Array.isArray(row.total)
    ? row.total as Record<string, unknown> : undefined;
  const records = row?.records && typeof row.records === "object" && !Array.isArray(row.records)
    ? row.records as Record<string, unknown> : undefined;
  const whole = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const reasons: readonly string[] = ["CAPACITY_READER_PROFILE", "CAPACITY_WRITER_PROFILE",
    "CAPACITY_WRITER_CHECKOUT", "CAPACITY_TOTAL_PROFILE", "CAPACITY_STORAGE_RECORDS", "UNCERTAIN_RESERVATION"];
  const actions: readonly string[] = ["start_if_profile_ready", "wait_for_active_job",
    "inspect_and_reconcile_exact_job", "review_owned_finished_records"];
  if (row?.contractVersion !== 1 || row.source !== "managed_delegation_journal"
    || row.coverage !== "managed_jobs_only" || row.policy !== "temporary_1_writer_2_readers_v1"
    || !["read", "write"].includes(row.requestedMode as string)
    || !Number.isSafeInteger(row.profileSlot) || (row.profileSlot as number) < 1 || (row.profileSlot as number) > 99
    || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))
    || !readers || !whole(readers.used) || readers.limit !== 2 || !whole(readers.uncertain)
    || (readers.used as number) > 2 || (readers.uncertain as number) > 64
    || !writers || !whole(writers.used) || writers.limit !== 1 || !whole(writers.uncertain)
    || (writers.used as number) > 1 || (writers.uncertain as number) > 64
    || !total || !whole(total.used) || total.limit !== 3
    || total.used !== (readers.used as number) + (writers.used as number)
    || !records || !whole(records.retained) || records.limit !== 64
    || typeof row.available !== "boolean"
    || row.blockCode !== undefined && !reasons.includes(row.blockCode as string)
    || row.available !== (row.blockCode === undefined)
    || typeof row.messageKo !== "string" || row.messageKo.length > 1000
    || typeof row.messageEn !== "string" || row.messageEn.length > 1000
    || !actions.includes(row.nextAction as string)) {
    throw Error("Invalid Web delegation capacity response");
  }
  return row as unknown as CodexWebDelegationCapacityContract;
}
