import { randomBytes } from "node:crypto";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { RuntimeTurnChannel } from "./turn-channel";

export interface TurnCapabilityResolver {
  resolve(token: string): RuntimeTurnChannel;
}

export interface RegisteredTurn {
  readonly capability: string;
  readonly channel: RuntimeTurnChannel;
}

function turnKey(binding: NativeTurnBinding): string {
  return `${binding.authority.threadId}\u0000${binding.authority.turnId}`;
}

function routeId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9]{8,32}$/.test(normalized)) {
    throw new Error("turn capability route id must contain 8-32 ASCII alphanumeric characters");
  }
  return normalized;
}

function capability(route: string | undefined): string {
  const secret = randomBytes(32).toString("base64url");
  return route ? `turnr_${route}_${secret}` : `turn_${secret}`;
}

export function turnCapabilityRoute(token: string): string | undefined {
  const match = /^turnr_([A-Za-z0-9]{8,32})_[A-Za-z0-9_-]{40,}$/.exec(token);
  return match?.[1];
}

/**
 * Owns opaque, process-local capabilities for active turns. Human-readable thread/turn ids are not
 * bearer credentials, and an active Native turn may have only one runtime owner.
 */
export class ActiveTurnRegistry {
  readonly #byCapability = new Map<string, RuntimeTurnChannel>();
  readonly #capabilityByTurn = new Map<string, string>();
  readonly #retiredTurns = new Map<string, true>();
  static readonly MAX_RETIRED_TURNS = 256;
  readonly #routeId: string | undefined;

  constructor(options: { readonly routeId?: string } = {}) {
    this.#routeId = options.routeId === undefined ? undefined : routeId(options.routeId);
  }

  register(binding: NativeTurnBinding): RegisteredTurn {
    const key = turnKey(binding);
    if (this.#retiredTurns.has(key)) {
      throw new Error("native turn was already retired by this runtime");
    }
    if (this.#capabilityByTurn.has(key)) {
      throw new Error("native turn already has an active runtime owner");
    }
    const token = capability(this.#routeId);
    const channel = new RuntimeTurnChannel(binding);
    this.#byCapability.set(token, channel);
    this.#capabilityByTurn.set(key, token);
    return Object.freeze({ capability: token, channel });
  }

  active(threadId: string, turnId: string): RegisteredTurn | undefined {
    const token = this.#capabilityByTurn.get(`${threadId}\u0000${turnId}`);
    if (!token) return undefined;
    return Object.freeze({ capability: token, channel: this.resolve(token) });
  }

  resolve(token: string): RuntimeTurnChannel {
    const channel = this.#byCapability.get(token);
    if (!channel) throw new Error("unknown or retired turn capability");
    return channel;
  }

  refresh(binding: NativeTurnBinding): RegisteredTurn {
    const token = this.#capabilityByTurn.get(turnKey(binding));
    if (!token) throw new Error("native turn has no active runtime owner to refresh");
    const channel = this.resolve(token);
    channel.refreshBinding(binding);
    return Object.freeze({ capability: token, channel });
  }

  retire(token: string): void {
    const channel = this.resolve(token);
    const key = turnKey(channel.binding);
    this.#byCapability.delete(token);
    this.#capabilityByTurn.delete(key);
    this.#retiredTurns.delete(key);
    this.#retiredTurns.set(key, true);
    while (this.#retiredTurns.size > ActiveTurnRegistry.MAX_RETIRED_TURNS) {
      const oldest = this.#retiredTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#retiredTurns.delete(oldest);
    }
  }

  cancelAll(reason: unknown = new Error("runtime stopped")): void {
    const active = [...this.#byCapability.entries()];
    this.#byCapability.clear();
    this.#capabilityByTurn.clear();
    for (const [token, channel] of active) {
      const key = turnKey(channel.binding);
      try {
        channel.cancel(reason);
      } catch {
        // A concurrently settled channel is already terminal; registry ownership is still retired.
      }
      this.#retiredTurns.delete(key);
      this.#retiredTurns.set(key, true);
      while (this.#retiredTurns.size > ActiveTurnRegistry.MAX_RETIRED_TURNS) {
        const oldest = this.#retiredTurns.keys().next().value as string | undefined;
        if (!oldest) break;
        this.#retiredTurns.delete(oldest);
      }
      void token;
    }
  }

  get size(): number {
    return this.#byCapability.size;
  }
}
