import type { TelaServiceId } from "./layout";

/** One budget for owned process teardown and replacement startup. */
export const PACKAGED_TRANSITION_TIMEOUT_MS = 60_000;

/** An authenticated owner acknowledged that this attempt admitted no shutdown. */
export class PackagedServiceShutdownNotStartedError extends Error {
  constructor(readonly service: TelaServiceId, options?: ErrorOptions) {
    super(`${service}: not ready to stop. Finish active work or check the service status before maintenance.`, options);
    this.name = "PackagedServiceShutdownNotStartedError";
  }
}
