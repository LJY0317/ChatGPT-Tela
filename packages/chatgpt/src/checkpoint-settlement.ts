/** A local cancellation receipt, never a claim that remote generation was stopped. */
export class WebCheckpointOperationClosed extends Error {
  constructor(readonly receipt: {
    readonly nativeTaskId: string;
    readonly sourceRevisionId: string;
    readonly webEpochId: string;
    readonly disposition: "not_invoked" | "cancelled_locally";
  }, options?: ErrorOptions) {
    super("Isolated checkpoint operation closed without a result", options);
    this.name = "WebCheckpointOperationClosed";
  }
}
