import type { TelaServiceId } from "./layout";

/** One budget for owned process teardown and replacement startup. */
export const PACKAGED_TRANSITION_TIMEOUT_MS = 60_000;

/** An authenticated owner acknowledged that this attempt admitted no shutdown. */
export class PackagedServiceShutdownNotStartedError extends Error {
  constructor(readonly service: TelaServiceId, options?: ErrorOptions) {
    super(`${service} shutdown was not started; finish its active work before maintenance`, options);
    this.name = "PackagedServiceShutdownNotStartedError";
  }
}
