import type { NativeToolInvocation, NativeToolResult } from "@chatgpt-tela/core";
import type { TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  parseCodexToolInventoryResponse,
  parseCodexToolInvokeResponse,
  parseServiceStatus,
  type ServiceRuntimeDescriptor,
  type ServiceStatus,
} from "@chatgpt-tela/service-protocol";
import type { GatewayBackendClient } from "./backend-router";

export class CodexBackendClient implements GatewayBackendClient, TurnBridgeBackend {
  readonly service = "codex" as const;
  readonly #descriptor: ServiceRuntimeDescriptor & { readonly service: "codex" };

  constructor(descriptor: ServiceRuntimeDescriptor & { readonly service: "codex" }) {
    this.#descriptor = descriptor;
  }

  async #request(path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(new URL(path, this.#descriptor.endpoint), {
      method,
      headers: {
        authorization: `Bearer ${this.#descriptor.bearerToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const value = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const message = value && typeof value === "object" && !Array.isArray(value)
        && typeof (value as { error?: { message?: unknown } }).error?.message === "string"
        ? (value as { error: { message: string } }).error.message
        : `Tela Codex backend request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return value;
  }

  async status(signal?: AbortSignal): Promise<ServiceStatus> {
    return parseServiceStatus(await this.#request("v1/status", "GET", undefined, signal));
  }

  async inventory(capability: string, query = "") {
    return parseCodexToolInventoryResponse(await this.#request("v1/codex/tools/inventory", "POST", {
      turnCapability: capability,
      query,
    })).tools;
  }

  async invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
    return parseCodexToolInvokeResponse(await this.#request("v1/codex/tools/invoke", "POST", {
      turnCapability: capability,
      invocation,
    })).result;
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.#request("v1/shutdown", "POST", {}, signal);
  }

  async close(): Promise<void> {}
}
