import type {
  NativeToolInvocation,
  NativeToolResult,
} from "@chatgpt-tela/core";
import {
  parseChatCapabilityContract,
  parseCodexBridgePreviewContract,
  parseCodexModelSelectionCanaryContract,
  parseCodexContextAttachmentCanaryContract,
  parseCodexProfileStatusContract,
  parseCodexToolInventoryResponse,
  parseCodexToolInvokeResponse,
  parseServiceStatus,
  type CodexProfileStatusContract,
  type CodexBridgePreviewContract,
  type CodexModelSelectionCanaryContract,
  type CodexContextAttachmentCanaryContract,
  type ChatCapabilityContract,
  type ServiceRuntimeDescriptor,
  type ServiceStatus,
  type TelaServiceId,
} from "./index";

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export class LocalServiceClient {
  readonly descriptor: ServiceRuntimeDescriptor;

  constructor(descriptor: ServiceRuntimeDescriptor) {
    this.descriptor = descriptor;
  }

  protected async request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.descriptor.endpoint), {
      method,
      headers: {
        authorization: `Bearer ${this.descriptor.bearerToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const value = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      throw new Error(errorMessage(value, `${this.descriptor.service} service request failed with HTTP ${response.status}`));
    }
    return value;
  }

  async status(signal?: AbortSignal): Promise<ServiceStatus> {
    const status = parseServiceStatus(await this.request("v1/status", "GET", undefined, signal));
    if (status.service !== this.descriptor.service || status.instanceId !== this.descriptor.instanceId) {
      throw new Error("service status identity does not match its runtime descriptor");
    }
    return status;
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.request("v1/shutdown", "POST", {}, signal);
  }

  async close(): Promise<void> {}
}

export class CodexServiceClient extends LocalServiceClient {
  declare readonly descriptor: ServiceRuntimeDescriptor & { readonly service: "codex" };
  readonly service = "codex" as const;

  constructor(descriptor: ServiceRuntimeDescriptor & { readonly service: "codex" }) {
    super(descriptor);
    this.descriptor = descriptor;
  }

  async inventory(capability: string, query = "") {
    return parseCodexToolInventoryResponse(await this.request("v1/codex/tools/inventory", "POST", {
      turnCapability: capability,
      query,
    })).tools;
  }

  async invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
    return parseCodexToolInvokeResponse(await this.request("v1/codex/tools/invoke", "POST", {
      turnCapability: capability,
      invocation,
    })).result;
  }

  async profiles(signal?: AbortSignal): Promise<readonly CodexProfileStatusContract[]> {
    const value = await this.request("v1/codex/profiles", "GET", undefined, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Codex profiles response must be an object");
    }
    const profiles = (value as { profiles?: unknown }).profiles;
    if (!Array.isArray(profiles)) throw new Error("Codex profiles response is missing profiles");
    return Object.freeze(profiles.map(parseCodexProfileStatusContract));
  }

  async startProfile(slot: number, signal?: AbortSignal): Promise<CodexProfileStatusContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexProfileStatusContract(await this.request(`v1/codex/profiles/${slot}/start`, "POST", {}, signal));
  }

  async stopProfile(slot: number, signal?: AbortSignal): Promise<CodexProfileStatusContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexProfileStatusContract(await this.request(`v1/codex/profiles/${slot}/stop`, "POST", {}, signal));
  }

  async bridgePreview(slot: number, signal?: AbortSignal): Promise<CodexBridgePreviewContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexBridgePreviewContract(await this.request(
      `v1/codex/profiles/${slot}/bridge-preview`,
      "GET",
      undefined,
      signal,
    ));
  }

  async modelSelectionCanary(slot: number, signal?: AbortSignal): Promise<CodexModelSelectionCanaryContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexModelSelectionCanaryContract(await this.request(
      `v1/codex/profiles/${slot}/model-selection-canary`,
      "POST",
      {},
      signal,
    ));
  }

  async contextAttachmentCanary(slot: number, signal?: AbortSignal): Promise<CodexContextAttachmentCanaryContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexContextAttachmentCanaryContract(await this.request(
      `v1/codex/profiles/${slot}/context-attachment-canary`,
      "POST",
      {},
      signal,
    ));
  }
}

export class ChatServiceClient extends LocalServiceClient {
  declare readonly descriptor: ServiceRuntimeDescriptor & { readonly service: "chat" };
  readonly service = "chat" as const;

  constructor(descriptor: ServiceRuntimeDescriptor & { readonly service: "chat" }) {
    super(descriptor);
    this.descriptor = descriptor;
  }

  async capabilities(signal?: AbortSignal): Promise<readonly string[]> {
    const value = await this.request("v1/capabilities", "GET", undefined, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat capabilities response must be an object");
    const item = value as Record<string, unknown>;
    if (item.contractVersion !== 1 || item.service !== "chat" || !Array.isArray(item.capabilities)) {
      throw new Error("Chat capabilities response is invalid");
    }
    return Object.freeze(item.capabilities.map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim() || /[\u0000\r\n]/.test(entry)) {
        throw new Error(`Chat capability[${index}] is invalid`);
      }
      return entry;
    }));
  }

  async capabilityCatalog(signal?: AbortSignal): Promise<readonly ChatCapabilityContract[]> {
    const value = await this.request("v1/capabilities", "GET", undefined, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat capabilities response must be an object");
    const item = value as Record<string, unknown>;
    if (item.contractVersion !== 1 || item.service !== "chat" || !Array.isArray(item.catalog)) {
      throw new Error("Chat capability catalog response is invalid");
    }
    return Object.freeze(item.catalog.map((entry, index) => parseChatCapabilityContract(entry, `Chat capability[${index}]`)));
  }

  async call(capability: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    if (!capability.trim() || /[\u0000\r\n]/.test(capability)) throw new Error("Chat capability is invalid");
    const value = await this.request("v1/call", "POST", { capability, arguments: arguments_ }, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat capability response must be an object");
    const item = value as Record<string, unknown>;
    if (item.contractVersion !== 1 || item.service !== "chat" || item.capability !== capability || !("result" in item)) {
      throw new Error("Chat capability response identity is invalid");
    }
    return item.result;
  }
}

export function descriptorForService<S extends TelaServiceId>(
  descriptor: ServiceRuntimeDescriptor,
  service: S,
): ServiceRuntimeDescriptor & { readonly service: S } {
  if (descriptor.service !== service) {
    throw new Error(`runtime descriptor belongs to ${descriptor.service}, not ${service}`);
  }
  return descriptor as ServiceRuntimeDescriptor & { readonly service: S };
}
