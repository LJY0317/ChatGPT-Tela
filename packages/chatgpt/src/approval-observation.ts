import type { ChatGptSurfaceSnapshot } from "./surface";

export type ApprovalObservationPhase = "pending" | "dispatch_sent" | "input_received" | "card_cleared" | "task_progress";
export interface ApprovalObservationTransition {
  readonly phase: ApprovalObservationPhase;
  readonly cardFingerprint?: string;
  readonly elapsedMs: number;
}

/** Presentation/evidence only. Card disappearance and input receipt never grant tool authority. */
export class ChatGptApprovalObservation {
  #current?: { cardFingerprint?: string; revision: string; phase: ApprovalObservationPhase; seenAt: number; assistantVersion: string };
  // Lifetime is one owned Native turn on its surface; no global card registry or idle timer.
  readonly #dispatched = new Set<string>();
  readonly #received = new Set<string>();
  /** Diagnostic for the current card only; older cards never block a distinct approval. */
  get unverifiedDispatchCount(): number {
    const card = this.#current?.cardFingerprint;
    return card && this.#dispatched.has(card) && this.#current?.phase !== "task_progress" ? 1 : 0;
  }
  /** Read-only age of the unresolved current card; never a grant or timeout. */
  pendingElapsedMs(now: number): number | undefined {
    return this.#current && ["pending", "dispatch_sent", "input_received", "card_cleared"].includes(this.#current.phase)
      ? Math.max(0, now - this.#current.seenAt) : undefined;
  }
  recordInputReceipt(receipt: ChatGptSurfaceSnapshot["approvalInputReceipt"], now: number): ApprovalObservationTransition | undefined {
    if (!receipt || !this.#current || receipt.cardFingerprint !== this.#current.cardFingerprint
      || receipt.revisionFingerprint !== this.#current.revision || !this.wasDispatched(receipt.cardFingerprint)) return;
    return this.#receive(now);
  }

  #receive(now: number): ApprovalObservationTransition | undefined {
    const key = this.#current!.revision;
    if (this.#received.has(key)) return;
    this.#received.add(key);
    if (this.#current!.phase === "card_cleared" || this.#current!.phase === "task_progress") {
      // A delayed receipt enriches evidence; it must not rewind the observed card lifecycle.
      return Object.freeze({ phase: "input_received",
        ...(this.#current!.cardFingerprint ? { cardFingerprint: this.#current!.cardFingerprint } : {}),
        elapsedMs: Math.max(0, now - this.#current!.seenAt) });
    }
    return this.#transition("input_received", now);
  }

  observe(approval: ChatGptSurfaceSnapshot["approval"], assistantVersion: string, canProgress: boolean, now: number): ApprovalObservationTransition | undefined {
    if (approval?.cardCount) {
      const same = this.#current && (approval.cardFingerprint
        ? this.#current.cardFingerprint === approval.cardFingerprint
        : this.#current.revision === approval.revisionFingerprint);
      if (!same) {
        const phase = this.wasDispatched(approval.cardFingerprint) ? "dispatch_sent" : "pending";
        this.#current = { ...(approval.cardFingerprint ? { cardFingerprint: approval.cardFingerprint } : {}), revision: approval.revisionFingerprint,
          phase, seenAt: now, assistantVersion };
        return this.#transition(phase, now);
      }
      this.#current!.assistantVersion = assistantVersion;
      if (approval.inputReceived && !this.#received.has(this.#current!.revision)) return this.#receive(now);
      // A hidden card that returns is still pending, even after a previous click or progress.
      if (this.#current!.phase === "card_cleared" || this.#current!.phase === "task_progress") {
        return this.#transition(this.wasDispatched(approval.cardFingerprint) ? "dispatch_sent" : "pending", now);
      }
      return;
    }
    if (!this.#current) return;
    if (!["card_cleared", "task_progress"].includes(this.#current.phase)) return this.#transition("card_cleared", now);
    if (this.#current.phase === "card_cleared" && canProgress && assistantVersion !== this.#current.assistantVersion) {
      return this.#transition("task_progress", now);
    }
  }

  wasDispatched(cardFingerprint: string | undefined): boolean {
    return cardFingerprint !== undefined && this.#dispatched.has(cardFingerprint);
  }

  dispatched(cardFingerprint: string, now: number, approvedRevisionFingerprint?: string): ApprovalObservationTransition {
    if (this.#current?.cardFingerprint !== cardFingerprint) throw new Error("Approval dispatch belongs to a different observed card");
    // Opening a linked menu can reveal the final scoped choice and rotate the
    // renderer proof. The owned driver binds that newly prepared revision to
    // the physical click; a stale pre-menu receipt must never count.
    if (approvedRevisionFingerprint !== undefined) {
      if (typeof approvedRevisionFingerprint !== "string" || approvedRevisionFingerprint.length < 1
        || approvedRevisionFingerprint.length > 128) throw new Error("invalid approval dispatch revision");
      this.#current.revision = approvedRevisionFingerprint;
    }
    this.#dispatched.add(cardFingerprint);
    return this.#transition("dispatch_sent", now);
  }

  get phase(): ApprovalObservationPhase | undefined { return this.#current?.phase; }
  get cardFingerprint(): string | undefined { return this.#current?.cardFingerprint; }

  #transition(phase: ApprovalObservationPhase, now: number): ApprovalObservationTransition {
    this.#current!.phase = phase;
    return Object.freeze({ phase, ...(this.#current!.cardFingerprint ? { cardFingerprint: this.#current!.cardFingerprint } : {}),
      elapsedMs: Math.max(0, now - this.#current!.seenAt) });
  }
}

export function approvalObservationSummary(phase: ApprovalObservationPhase): string {
  switch (phase) {
    case "pending": return "Approval needed in the Web browser.";
    case "dispatch_sent": return "Approval click sent; waiting for the Web browser to receive and process it.";
    case "input_received": return "The Web browser received the approval click; the card is still pending.";
    case "card_cleared": return "Approval card cleared; waiting for the task to resume.";
    case "task_progress": return "The Web task progressed after the approval card cleared.";
  }
}

/** Fixed public explanations only; an adapter's raw reason is never displayed. */
export function approvalPreparationFailureSummary(reason: string): string {
  const detail = reason === "card_changed" ? "The approval card changed before the click."
    : reason === "occluded" || reason === "outside_viewport" ? "The approval button could not be reached."
    : reason === "options_unverified" || reason === "options_already_attempted" ? "The approval menu could not be verified."
    : reason === "target_missing" || reason === "changed" ? "The current approval button could not be verified."
    : "Automatic approval could not be verified.";
  return `${detail} Review the current card in the owned browser; the accepted request will not be resent.`;
}
