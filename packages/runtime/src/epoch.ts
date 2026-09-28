import { randomBytes } from "node:crypto";

export type WebEpochReason = "initial" | "compaction" | "fresh-chat" | "recovery";

export interface WebContextEpoch {
  readonly id: string;
  readonly nativeTaskId: string;
  readonly baseRevisionId: string;
  readonly generation: number;
  readonly reason: WebEpochReason;
}

function epochId(): string {
  return `epoch_${randomBytes(24).toString("base64url")}`;
}

/**
 * Tracks disposable Web-conversation epochs independently from durable Native task identity.
 * Losing this projection never changes which Native task/revision is authoritative.
 */
export class WebEpochRegistry {
  readonly #current = new Map<string, WebContextEpoch>();

  start(nativeTaskId: string, baseRevisionId: string): WebContextEpoch {
    if (this.#current.has(nativeTaskId)) {
      throw new Error("native task already has an active Web epoch");
    }
    const epoch = this.#create(nativeTaskId, baseRevisionId, 1, "initial");
    this.#current.set(nativeTaskId, epoch);
    return epoch;
  }

  rollover(nativeTaskId: string, baseRevisionId: string, reason: Exclude<WebEpochReason, "initial">): WebContextEpoch {
    const previous = this.#current.get(nativeTaskId);
    if (!previous) throw new Error("native task has no active Web epoch to roll over");
    const epoch = this.#create(nativeTaskId, baseRevisionId, previous.generation + 1, reason);
    this.#current.set(nativeTaskId, epoch);
    return epoch;
  }

  current(nativeTaskId: string): WebContextEpoch | undefined {
    return this.#current.get(nativeTaskId);
  }

  retire(nativeTaskId: string): void {
    this.#current.delete(nativeTaskId);
  }

  #create(
    nativeTaskId: string,
    baseRevisionId: string,
    generation: number,
    reason: WebEpochReason,
  ): WebContextEpoch {
    if (!nativeTaskId.trim() || !baseRevisionId.trim()) {
      throw new Error("Web epoch task and base revision ids must be non-empty");
    }
    return Object.freeze({
      id: epochId(),
      nativeTaskId,
      baseRevisionId,
      generation,
      reason,
    });
  }
}
