/** Issued by the isolated operation owner only after physical release succeeds (or
 * before provider invocation). Settles local ownership, never remote completion or replay.
 */
export class WebCheckpointOperationClosed extends Error {
  constructor(readonly receipt: {
    readonly nativeTaskId: string;
    readonly sourceRevisionId: string;
    readonly webEpochId: string;
    readonly disposition: "not_invoked" | "released_locally" | "completed_unusable";
  }, options?: ErrorOptions) {
    super("Isolated checkpoint operation closed without a result", options);
    this.name = "WebCheckpointOperationClosed";
  }
}

export type CheckpointResponseRejection = "plain_body_unavailable" | "json_invalid" | "envelope_invalid"
  | "operation_mismatch" | "source_mismatch" | "receipt_mismatch" | "summary_empty" | "summary_budget";
/** Only created after an exact owned provider operation reached a proven completion. */
export class WebCheckpointResponseRejected extends Error {
  constructor(readonly receipt: {
    readonly nativeTaskId: string;
    readonly sourceRevisionId: string;
    readonly webEpochId: string;
    readonly providerOperationId: string;
    readonly reason: CheckpointResponseRejection;
  }, message: string) {
    super(message);
    this.name = "WebCheckpointResponseRejected";
  }
}
