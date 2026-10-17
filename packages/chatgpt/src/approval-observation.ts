import type { ChatGptSurfaceSnapshot } from "./surface";
import type { ChatGptApprovalReviewReason } from "./approval-policy";

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
  #observedCount = 0;
  #inputReceiptCount = 0;
  readonly #received = new Set<string>();
  #cardClearCount = 0;
  #nativeResultCount = 0;

  /** Local execution evidence is independent of card disappearance or generated prose. */
  recordNativeResult(): void { this.#nativeResultCount = Math.min(this.#nativeResultCount + 1, Number.MAX_SAFE_INTEGER); }
  get audit() {
    return Object.freeze({ approval_count: this.#observedCount, dispatch_count: this.#dispatched.size,
      input_receipt_count: this.#inputReceiptCount, card_clear_count: this.#cardClearCount,
      native_result_count: this.#nativeResultCount });
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
      this.#inputReceiptCount = Math.min(this.#inputReceiptCount + 1, Number.MAX_SAFE_INTEGER);
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
        this.#observedCount = Math.min(this.#observedCount + 1, Number.MAX_SAFE_INTEGER);
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

  dispatched(cardFingerprint: string, now: number): ApprovalObservationTransition {
    if (this.#current?.cardFingerprint !== cardFingerprint) throw new Error("Approval dispatch belongs to a different observed card");
    this.#dispatched.add(cardFingerprint);
    return this.#transition("dispatch_sent", now);
  }

  get phase(): ApprovalObservationPhase | undefined { return this.#current?.phase; }
  get cardFingerprint(): string | undefined { return this.#current?.cardFingerprint; }

  #transition(phase: ApprovalObservationPhase, now: number): ApprovalObservationTransition {
    if (phase === "input_received") this.#inputReceiptCount = Math.min(this.#inputReceiptCount + 1, Number.MAX_SAFE_INTEGER);
    if (phase === "card_cleared") this.#cardClearCount = Math.min(this.#cardClearCount + 1, Number.MAX_SAFE_INTEGER);
    this.#current!.phase = phase;
    return Object.freeze({ phase, ...(this.#current!.cardFingerprint ? { cardFingerprint: this.#current!.cardFingerprint } : {}),
      elapsedMs: Math.max(0, now - this.#current!.seenAt) });
  }
}

export function approvalObservationSummary(phase: ApprovalObservationPhase, reviewReason?: ChatGptApprovalReviewReason): string {
  switch (phase) {
    case "pending": return reviewReason === "tool_description_policy_directive"
      ? "Manual review needed: the Web approval card flags tool-description instructions about security or approval policy. Review it in the browser; Tela will not override or resend the request."
      : reviewReason ? "Manual security review needed in the Web browser. Tela will not override the warning."
      : "Approval needed in the Web browser.";
    case "dispatch_sent": return "Approval click sent; waiting for the Web browser to receive and process it.";
    case "input_received": return "The Web browser received the approval click; the card is still pending.";
    case "card_cleared": return "Approval card cleared; waiting for the task to resume.";
    case "task_progress": return "The Web task progressed after the approval card cleared.";
  }
}
