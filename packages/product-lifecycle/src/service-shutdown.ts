import type { TelaServiceId } from "./layout";

/** An authenticated owner acknowledged that this attempt admitted no shutdown. */
export class PackagedServiceShutdownNotStartedError extends Error {
  constructor(readonly service: TelaServiceId, options?: ErrorOptions) {
    super(`${service} shutdown was not started; finish its active work before maintenance`, options);
    this.name = "PackagedServiceShutdownNotStartedError";
  }
}
