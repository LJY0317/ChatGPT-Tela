import {
  bindNativeTurnRequest,
  extractNativeToolResults,
  type CanonicalCurrentTurnSource,
  type NativeResponsesToolCallItem,
} from "@chatgpt-tela/codex";
import { ActiveTurnRegistry, type RegisteredTurn } from "./registry";
import {
  acceptBoundNativeRoundRequest,
  nextNativeResponsesToolCall,
} from "./native-round";

export type NativeGatewayOutcome =
  | {
      readonly type: "tool-call";
      readonly item: NativeResponsesToolCallItem;
      readonly delivery: {
        readonly capability: string;
        readonly callId: string;
      };
    }
  | {
      readonly type: "final";
      readonly answer: string;
      readonly delivery: {
        readonly capability: string;
      };
    };

export type StartWebTurn = (turn: RegisteredTurn, nativeRequest: unknown) => Promise<unknown>;

function never(): Promise<never> {
  return new Promise(() => {});
}

function terminalPhase(phase: string): boolean {
  return phase === "completed"
    || phase === "failed-before-acceptance"
    || phase === "indeterminate-after-acceptance"
    || phase === "cancelled";
}

/**
 * Semantic Native Responses gateway. HTTP/SSE framing is deliberately outside this class.
 *
 * A request is canonically bound before ownership lookup. The first request starts one Web turn;
 * later requests either return a pending tool result, refresh current-turn projections, or replay a
 * not-yet-committed outcome. Delivery is two-phase so a socket/write failure cannot silently turn an
 * undelivered Native tool call into an executed one.
 */
export class NativeResponsesGateway {
  readonly #launches = new Map<string, Promise<unknown>>();

  constructor(
    readonly source: CanonicalCurrentTurnSource,
    readonly turns: ActiveTurnRegistry,
    readonly startWebTurn: StartWebTurn,
  ) {}

  async handle(body: unknown): Promise<NativeGatewayOutcome> {
    const binding = await bindNativeTurnRequest(body, this.source);
    let registered = this.turns.active(binding.authority.threadId, binding.authority.turnId);

    if (!registered) {
      registered = this.turns.register(binding);
      const launch = Promise.resolve().then(() => this.startWebTurn(registered!, body));
      // The launch is observed both here and by the outcome race; this prevents process-level
      // unhandled rejections if the Native client disconnects before awaiting the gateway result.
      void launch.catch(() => {});
      this.#launches.set(registered.capability, launch);
    } else if (!terminalPhase(registered.channel.phase)) {
      const outstanding = registered.channel.outstandingToolCallId;
      if (outstanding) {
        const hasMatchingResult = extractNativeToolResults(body)
          .some(result => result.callId === outstanding);
        if (hasMatchingResult) {
          acceptBoundNativeRoundRequest(registered.channel, binding, body);
        } else if (registered.channel.outstandingNativeDelivery === "delivered") {
          throw new Error("Native tool call was already delivered; the follow-up request must contain its result");
        }
        // An uncommitted queued call is intentionally left on the old binding so the exact same
        // output can be replayed after a transport failure. It is not a new Native round yet.
      } else {
        registered = this.turns.refresh(binding);
      }
    }

    return this.#nextOutcome(registered);
  }

  commit(outcome: NativeGatewayOutcome): void {
    if (outcome.type === "tool-call") {
      this.turns.resolve(outcome.delivery.capability)
        .markNativeToolDelivered(outcome.delivery.callId);
      return;
    }
    this.turns.retire(outcome.delivery.capability);
    this.#launches.delete(outcome.delivery.capability);
  }

  async #nextOutcome(registered: RegisteredTurn): Promise<NativeGatewayOutcome> {
    const channel = registered.channel;
    const final = channel.waitForFinal().then(answer => Object.freeze({
      type: "final" as const,
      answer,
      delivery: Object.freeze({ capability: registered.capability }),
    }));
    if (terminalPhase(channel.phase)) return final;

    const tool = nextNativeResponsesToolCall(channel)
      .then(item => Object.freeze({
        type: "tool-call" as const,
        item,
        delivery: Object.freeze({
          capability: registered.capability,
          callId: item.call_id,
        }),
      }))
      .catch(error => {
        if (error instanceof Error && error.message === "turn completed without another tool call") {
          return never();
        }
        return Promise.reject(error);
      });

    const launch = this.#launches.get(registered.capability);
    const launchFailure = launch
      ? launch.then(() => never(), error => Promise.reject(error))
      : never();

    return Promise.race([tool, final, launchFailure]);
  }
}
