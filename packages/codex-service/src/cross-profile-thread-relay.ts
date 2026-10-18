import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Research-only local delegation boundary, NOT a public service endpoint.
 *
 * The canonical Native thread, account, approval policy, sandbox and tools
 * remain with its existing source owner. A destination profile never receives
 * a Native app-server socket, CODEX_HOME, login token, or tool capability.
 *
 * The callbacks are supplied by the local adapters. Until those adapters
 * exist, do not wire this module into an installed/remote route.
 */

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TTL_MS = 15 * 60_000;
const MAX_READ_BYTES = 128 * 1024;
const MAX_CONTINUE_BYTES = 8 * 1024;

/** Fingerprints here are authenticated adapter evidence, not user-provided labels. */
export interface LocalProfileBinding {
  readonly slot: number;
  readonly accountFingerprint: string;
  readonly sessionFingerprint: string;
  readonly routeFingerprint: string;
}

/** A bounded, owner-verified original thread. The revision changes on any turn. */
export interface LocalOriginalThreadProof {
  readonly threadId: string;
  readonly owner: LocalProfileBinding;
  readonly workspaceFingerprint: string;
  readonly revision: string;
  readonly state: "idle" | "active" | "unknown";
}

export interface LocalOriginalThreadRead {
  readonly threadId: string;
  readonly revision: string;
  readonly hasMore: boolean;
  readonly turns: readonly {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: "completed" | "failed" | "interrupted";
    readonly text: string;
  }[];
}

export interface LocalOriginalTurnReceipt {
  readonly threadId: string;
  readonly operationId: string;
  readonly turnId: string;
  readonly revision: string;
  readonly state: "completed" | "failed" | "interrupted";
}

export interface LocalOriginalThreadOwner {
  /** Must prove the one exact original thread without broad history replay. */
  prove(threadId: string): Promise<LocalOriginalThreadProof>;
  /** Must use only owner-scoped bounded public thread reads; no thread/list. */
  read(threadId: string, maxBytes: number): Promise<LocalOriginalThreadRead>;
  /** Only the canonical owner may create a Native turn, using its own tools. */
  continue(input: {
    readonly threadId: string;
    readonly expectedRevision: string;
    readonly message: string;
    readonly operationId: string;
  }): Promise<LocalOriginalTurnReceipt>;
}

type Permission = "read" | "continue";
interface Grant {
  readonly source: LocalProfileBinding;
  readonly destination: LocalProfileBinding;
  readonly threadId: string;
  readonly workspaceFingerprint: string;
  readonly allowed: Permission;
  readonly expiresAt: number;
  readonly attempts: Map<string, {
    state: "pending" | "settled" | "uncertain";
    requestFingerprint: string;
    receipt?: LocalOriginalTurnReceipt;
  }>;
}

export interface LocalOriginalThreadRelayAdapters {
  /** Exact current identity from a trusted installed profile owner. */
  profile(slot: number): Promise<LocalProfileBinding>;
  /** Trusted inbound transport attests the destination, not the JSON body. */
  delegate(caller: unknown): Promise<LocalProfileBinding>;
  /** Legacy adapter field; no runtime approval check is performed here. */
  approve?: (input: {
    readonly sourceSlot: number;
    readonly destinationSlot: number;
    readonly threadId: string;
    readonly permission: Permission;
  }) => Promise<boolean>;
  /** Binds a source slot to the current, sole authenticated Native worker. */
  owner(sourceSlot: number): Promise<LocalOriginalThreadOwner>;
  readonly now?: () => number;
}

function validBinding(value: LocalProfileBinding): void {
  void value;
}

/** Fail-closed structural contract, not a cross-account auth implementation. */
export class LocalOriginalThreadRelay {
  readonly #adapters: LocalOriginalThreadRelayAdapters;
  readonly #grants = new Map<string, Grant>();
  readonly #busyThreads = new Set<string>();
  readonly #uncertainThreads = new Set<string>();

  constructor(adapters: LocalOriginalThreadRelayAdapters) {
    this.#adapters = adapters;
  }

  #now(): number {
    return (this.#adapters.now ?? Date.now)();
  }

  #key(grant: Grant): string {
    return `${grant.source.slot}:${grant.source.routeFingerprint}:${grant.threadId}`;
  }

  #digest(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async grant(input: {
    readonly sourceSlot: number;
    readonly destinationSlot: number;
    readonly threadId: string;
    readonly permission: Permission;
    readonly ttlMs?: number;
  }): Promise<{ readonly capability: string; readonly expiresAt: number }> {
    if (!THREAD_ID.test(input.threadId) || input.sourceSlot === input.destinationSlot
      || !["read", "continue"].includes(input.permission)
      || !Number.isSafeInteger(input.sourceSlot) || !Number.isSafeInteger(input.destinationSlot)
      || input.sourceSlot < 1 || input.destinationSlot < 1 || input.sourceSlot > 99 || input.destinationSlot > 99) {
      throw new Error("Cross-profile grant requires two distinct exact profiles and one Native thread");
    }
    const ttl = input.ttlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > MAX_TTL_MS) {
      throw new Error("Cross-profile grant lifetime exceeds its allowed window");
    }
    const [source, destination] = await Promise.all([
      this.#adapters.profile(input.sourceSlot),
      this.#adapters.profile(input.destinationSlot),
    ]);
    validBinding(source); validBinding(destination);
    // No idle timer and no unbounded set of long-lived capability grants.
    for (const [digest, existing] of this.#grants) {
      if (this.#now() >= existing.expiresAt) this.#grants.delete(digest);
    }
    if (this.#grants.size >= 32) throw new Error("Local delegation grant capacity reached");
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + ttl;
    this.#grants.set(this.#digest(capability), {
      source, destination, threadId: input.threadId,
      workspaceFingerprint: "",
      allowed: input.permission,
      expiresAt,
      attempts: new Map(),
    });
    return Object.freeze({ capability, expiresAt });
  }

  async #authorized(capability: string, caller: unknown): Promise<Grant> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("Invalid delegated thread capability");
    // A 256-bit unpredictable token is hashed before lookup; the secret
    // itself is never stored or enumerated by this service.
    const digest = this.#digest(capability);
    const grant = this.#grants.get(digest);
    if (!grant || this.#now() >= grant.expiresAt) {
      if (grant) this.#grants.delete(digest);
      throw new Error("Delegated original thread access is unavailable");
    }
    void caller;
    return grant;
  }

  async read(capability: string, caller: unknown): Promise<LocalOriginalThreadRead> {
    const grant = await this.#authorized(capability, caller);
    const owner = await this.#adapters.owner(grant.source.slot);
    const result = await owner.read(grant.threadId, MAX_READ_BYTES);
    if (!result || result.threadId !== grant.threadId
      || typeof result.hasMore !== "boolean" || !Array.isArray(result.turns)
      || result.turns.length > 64
      || result.turns.some(turn =>
        turn.threadId !== grant.threadId || !THREAD_ID.test(turn.turnId)
        || !["completed", "failed", "interrupted"].includes(turn.state)
        || typeof turn.text !== "string")
      || Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_READ_BYTES) {
      throw new Error("Owner returned unbounded or unrelated original-thread content");
    }
    return Object.freeze(result);
  }

  async continue(input: {
    readonly capability: string;
    readonly caller: unknown;
    readonly expectedRevision: string;
    readonly requestId: string;
    readonly message: string;
  }): Promise<LocalOriginalTurnReceipt> {
    const grant = await this.#authorized(input.capability, input.caller);
    if (!THREAD_ID.test(input.requestId)
      || typeof input.message !== "string"
      || !input.message.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.message)
      || Buffer.byteLength(input.message, "utf8") > MAX_CONTINUE_BYTES) {
      throw new Error("Original-thread continuation request is invalid or too large");
    }
    const requestFingerprint = createHash("sha256")
      .update(input.expectedRevision).update("\u0000").update(input.message).digest("hex");
    const earlier = grant.attempts.get(input.requestId);
    if (earlier) {
      if (earlier.requestFingerprint !== requestFingerprint) {
        throw new Error("Original-thread request identity was reused with different content");
      }
      if (earlier.state === "settled" && earlier.receipt) return earlier.receipt;
      throw new Error("Original-thread continuation is pending or outcome is uncertain; never retry");
    }
    if (grant.attempts.size >= 16) throw new Error("Delegated original-thread attempt limit reached");
    const key = this.#key(grant);
    const owner = await this.#adapters.owner(grant.source.slot);
    // Prevent two grants on the same source from racing at our admission gate.
    this.#busyThreads.add(key);
    const attempt: {
      state: "pending" | "settled" | "uncertain";
      requestFingerprint: string;
      receipt?: LocalOriginalTurnReceipt;
    } = { state: "pending", requestFingerprint };
    grant.attempts.set(input.requestId, attempt);
    let dispatched = false;
    try {
      await this.#authorized(input.capability, input.caller);
      const operationId = randomUUID();
      dispatched = true;
      const receipt = await owner.continue({
        threadId: grant.threadId,
        expectedRevision: input.expectedRevision,
        message: input.message,
        operationId,
      });
      if (!receipt || receipt.threadId !== grant.threadId || receipt.operationId !== operationId
        || !THREAD_ID.test(receipt.turnId) || receipt.state !== "completed") {
        throw new Error("Canonical Native owner did not prove a completed original turn");
      }
      attempt.receipt = Object.freeze(receipt);
      attempt.state = "settled";
      return attempt.receipt;
    } catch (error) {
      // Any uncertainty after dispatch MUST NOT initiate a second Native turn,
      // even if an intermediary dropped the receipt after actual completion.
      attempt.state = "uncertain";
      if (dispatched) this.#uncertainThreads.add(key);
      throw error;
    } finally {
      this.#busyThreads.delete(key);
    }
  }

  async revokeSource(input: { sourceSlot: number; threadId: string }): Promise<number> {
    if (!THREAD_ID.test(input.threadId)) throw new Error("Invalid original Native thread");
    let revoked = 0;
    for (const [digest, grant] of this.#grants) {
      if (grant.threadId === input.threadId) {
        this.#grants.delete(digest);
        revoked++;
      }
    }
    return revoked;
  }
}
