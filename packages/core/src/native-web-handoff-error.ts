/** Only fixed proof state survives retirement; no upstream evidence or payload is retained. */
export class NativeWebHandoffUnproven extends Error {
  readonly code = "native_web_handoff_unproven";
  constructor(readonly proofState: "probable" | "ambiguous") {
    super("The Native tool result could not be safely handed back to Web. Reconcile the existing result before continuing; do not repeat the tool action.");
    this.name = "NativeWebHandoffUnproven";
  }
}
