import type {
  BackendServiceId,
  ServiceRuntimeDescriptor,
  ServiceStatus,
} from "@chatgpt-tela/service-protocol";
import { parseServiceStatus } from "@chatgpt-tela/service-protocol";
import type { GatewayBackendClient } from "./backend-router";

export class LoopbackBackendClient implements GatewayBackendClient {
  readonly service: BackendServiceId;
  readonly #descriptor: ServiceRuntimeDescriptor;

  constructor(descriptor: ServiceRuntimeDescriptor & { readonly service: BackendServiceId }) {
    this.#descriptor = descriptor;
    this.service = descriptor.service;
  }

  async status(signal?: AbortSignal): Promise<ServiceStatus> {
    const response = await fetch(new URL("v1/status", this.#descriptor.endpoint), {
      headers: { authorization: `Bearer ${this.#descriptor.bearerToken}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`backend status failed with HTTP ${response.status}`);
    return parseServiceStatus(await response.json() as unknown);
  }

  async close(): Promise<void> {}
}
