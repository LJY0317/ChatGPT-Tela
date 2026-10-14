import { createHash } from "node:crypto";
/**
 * One process-local, per-connection receipt for an ORIGINAL Native app-server
 * turn/start RPC that the engine actually acknowledged as inProgress.
 *
 * This only proves the live turn's identity while its proxy connection stays
 * owned. It does NOT expose old history, a compaction, a model certificate or
 * any tool/execution authority. Close/retirement/account invalidation revoke
 * the receipt; nothing is persisted or recovered by guessing a turn id.
 */
export interface NativeLiveTurnReceipt {
  readonly threadId: string;
  readonly turnId: string;
}

export interface NativeInputReceipt {
  readonly id: string;
  readonly textHash: string;
}

export interface NativeLiveTurnProof {
  current(threadId: string): NativeLiveTurnReceipt | undefined;
  inputs?(receipt: NativeLiveTurnReceipt): readonly NativeInputReceipt[];
  isCurrent(receipt: NativeLiveTurnReceipt): boolean;
  /** Undefined means the exact receipt was already lost; callers fail closed. */
  subscribe(receipt: NativeLiveTurnReceipt, revoked: () => void): (() => void) | undefined;
}

interface ActiveReceipt {
  readonly receipt: NativeLiveTurnReceipt;
  readonly owner: object;
  readonly subscribers: Set<() => void>;
  readonly inputs: Map<string, NativeInputReceipt>;
}

const MAX_ACTIVE_LIVE_TURNS = 64;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export class NativeLiveTurnRegistry implements NativeLiveTurnProof {
  readonly #turns = new Map<string, ActiveReceipt>();
  #generation = 0;

  get generation(): number { return this.#generation; }

  current(threadId: string): NativeLiveTurnReceipt | undefined {
    return this.#turns.get(threadId)?.receipt;
  }

  isCurrent(receipt: NativeLiveTurnReceipt): boolean {
    return this.#turns.get(receipt.threadId)?.receipt === receipt;
  }

  subscribe(receipt: NativeLiveTurnReceipt, revoked: () => void): (() => void) | undefined {
    const active = this.#turns.get(receipt.threadId);
    if (!active || active.receipt !== receipt) return undefined;
    active.subscribers.add(revoked);
    return () => { active.subscribers.delete(revoked); };
  }

  accept(threadId: unknown, turnId: unknown, owner: object,
    expectedGeneration = this.#generation): boolean {
    if (!identifier(threadId) || !identifier(turnId)
      || expectedGeneration !== this.#generation) return false;
    const previous = this.#turns.get(threadId);
    if (previous?.receipt.turnId === turnId) {
      // An independent second socket acknowledging the same id cannot inherit
      // the first socket's ownership lease. This is also ambiguous for the
      // original owner: revoke both instead of retaining stale authority.
      if (previous.owner !== owner) {
        this.#revoke(threadId);
        return false;
      }
      return true;
    }
    if (!previous && this.#turns.size >= MAX_ACTIVE_LIVE_TURNS) return false;
    if (previous) this.#revoke(threadId);
    this.#turns.set(threadId, {
      receipt: Object.freeze({ threadId, turnId }),
      owner,
      subscribers: new Set(),
      inputs: new Map(),
    });
    return true;
  }

  inputs(receipt: NativeLiveTurnReceipt): readonly NativeInputReceipt[] {
    const active = this.#turns.get(receipt.threadId);
    return active?.receipt === receipt ? [...active.inputs.values()] : [];
  }

  observeInput(threadId: string, turnId: string, owner: object, item: unknown): void {
    const active = this.#turns.get(threadId);
    if (!active || active.owner !== owner || active.receipt.turnId !== turnId) return;
    const receipt = nativeInputReceipt(item);
    if (!receipt) return;
    const previous = active.inputs.get(receipt.id);
    if (previous && previous.textHash !== receipt.textHash || !previous && active.inputs.size >= 256) {
      this.#revoke(threadId);
      return;
    }
    active.inputs.set(receipt.id, receipt);
  }

  #revoke(threadId: string): void {
    const current = this.#turns.get(threadId);
    if (!current) return;
    this.#turns.delete(threadId);
    for (const observer of current.subscribers) {
      try { observer(); } catch { /* Observer failures never break the upstream Native connection. */ }
    }
    current.subscribers.clear();
  }

  retire(threadId: string, turnId: string): void {
    if (this.#turns.get(threadId)?.receipt.turnId === turnId) this.#revoke(threadId);
  }

  retireThread(threadId: string): void { this.#revoke(threadId); }

  retireOwner(owner: object): void {
    for (const [threadId, receipt] of this.#turns) {
      if (receipt.owner === owner) this.#revoke(threadId);
    }
  }

  clear(): void {
    this.#generation++;
    for (const threadId of [...this.#turns.keys()]) this.#revoke(threadId);
  }
}

/** Exact, bounded text-only input witnesses. Unknown/multimodal inputs do not grant continuation. */
export function nativeTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function nativeInputReceipt(raw: unknown): NativeInputReceipt | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (item.type !== "userMessage" || !identifier(item.id) || !Array.isArray(item.content)
    || item.content.length === 0 || item.content.length > 256) return undefined;
  const texts: string[] = [];
  for (const rawPart of item.content) {
    if (!rawPart || typeof rawPart !== "object") return undefined;
    const part = rawPart as Record<string, unknown>;
    if (part.type !== "text" || typeof part.text !== "string") return undefined;
    texts.push(part.text);
  }
  const text = texts.join("\n");
  if (!text.trim() || Buffer.byteLength(text) > 1024 * 1024) return undefined;
  return Object.freeze({ id: item.id, textHash: nativeTextHash(text) });
}
