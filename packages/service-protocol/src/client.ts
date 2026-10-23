import type {
  NativeToolInvocation,
  NativeToolResult,
} from "@chatgpt-tela/core";
import { diagnosticContext, diagnosticDurationMs, diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  parseChatCapabilityContract,
  parseCodexTerminalSessionContract,
  parseCodexAccountCheckContract,
  parseCodexWebDelegationCapacityContract,
  type CodexAccountCheckContract,
  parseCodexAccountDisplayContract,
  parseCodexHistoryUiContract,
  type CodexHistoryUiContract,
  parseCodexSavedDeleteAcceptanceContract,
  type CodexSavedDeleteAcceptanceContract,
  parseCodexSyntheticRecoveryContract,
  type CodexSyntheticRecoveryContract,
  type CodexAccountDisplayContract,
  parseCodexBridgePreviewContract,
  parseCodexWorkInspectionContract,
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

/** Keeps observed HTTP status through forwarding without exposing response payloads to diagnostics. */
export class ServiceHttpError extends Error {
  readonly code = "tela_service_http_error";
  constructor(readonly httpStatus: number, message: string) { super(message); this.name = "ServiceHttpError"; }
}

/** Exact authenticated response from the shutdown admission boundary, not an HTTP error guess. */
export class ServiceShutdownNotStartedError extends ServiceHttpError {
  constructor() { super(409, "The service acknowledged that shutdown was not started"); this.name = "ServiceShutdownNotStartedError"; }
}

/** A responding endpoint must prove the expected status contract and exact instance. */
export class ServiceStatusValidationError extends Error {}

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
    const started = Date.now(); let phase: "transport" | "decode" | "http" = "transport";
    try {
      const response = await fetch(new URL(path, this.descriptor.endpoint), {
        method,
        headers: {
          authorization: `Bearer ${this.descriptor.bearerToken}`,
          ...(diagnosticContext().request_fingerprint ? { "x-tela-diagnostic-parent": diagnosticContext().request_fingerprint! } : {}),
          ...(diagnosticContext().scope_fingerprint ? { "x-tela-diagnostic-scope": diagnosticContext().scope_fingerprint! } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      phase = "decode";
      const value = await response.json().catch(error => {
        emitDiagnosticEvent("chatgpt_tela_service", "service_response_decode_failed", {
          service: this.descriptor.service, phase: "decode", http_status: response.status,
          ...diagnosticFailureFields(error), abort_observed: signal?.aborted === true,
        });
        return undefined;
      }) as unknown;
      phase = "http";
      if (!response.ok) {
        const receipt = value as Record<string, unknown> | undefined;
        if (path === "v1/shutdown" && method === "POST" && response.status === 409
          && receipt?.contractVersion === 1 && receipt.service === this.descriptor.service
          && receipt.instanceId === this.descriptor.instanceId && receipt.shutdown === "not-started") {
          throw new ServiceShutdownNotStartedError();
        }
        throw new ServiceHttpError(response.status, errorMessage(value, `${this.descriptor.service} service request failed with HTTP ${response.status}`));
      }
      return value;
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_service", "service_request_failed", {
        service: this.descriptor.service, phase, ...diagnosticFailureFields(error),
        duration_ms: diagnosticDurationMs(started), abort_observed: signal?.aborted === true,
      });
      throw error;
    }
  }

  async status(signal?: AbortSignal, options?: { readonly shutdownReadiness?: boolean }): Promise<ServiceStatus> {
    const path = options?.shutdownReadiness ? "v1/status?shutdown-readiness=1" : "v1/status";
    const value = await this.request(path, "GET", undefined, signal);
    let status: ServiceStatus;
    try { status = parseServiceStatus(value); }
    catch (error) { throw new ServiceStatusValidationError("service status contract is invalid", { cause: error }); }
    if (status.service !== this.descriptor.service || status.instanceId !== this.descriptor.instanceId) {
      throw new ServiceStatusValidationError("service status identity does not match its runtime descriptor");
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

  async webDelegationCapacity(slot: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw Error("invalid profile slot");
    const value = parseCodexWebDelegationCapacityContract(await this.request(
      `v1/codex/profiles/${slot}/web-delegation-capacity`, "GET", undefined, signal));
    if (value.profileSlot !== slot) throw Error("Web delegation capacity profile mismatch");
    return value;
  }

  async reconnectWeb(slot: number, signal?: AbortSignal): Promise<CodexProfileStatusContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    return parseCodexProfileStatusContract(await this.request(`v1/codex/profiles/${slot}/web-reconnect`, "POST", {}, signal));
  }
  /** Explicit owner-bound account-browser close; not a chat deletion API. */
  async closeAccountBrowser(slot: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    await this.request(`v1/codex/profiles/${slot}/account-browser-close`, "POST", {}, signal);
  }

  /** Owner-bound, content-free official saved chat history observation. No Delete action. */
  async inspectAccountBrowserHistoryUi(slot: number, signal?: AbortSignal): Promise<CodexHistoryUiContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    const response = parseCodexHistoryUiContract(await this.request(
      `v1/codex/profiles/${slot}/account-browser-history-ui`, "GET", undefined, signal));
    if (response.slot !== slot) throw new Error("history UI observation slot does not match request");
    return response;
  }
  /** One-shot test-only operation. Never repeat automatically after an uncertain Send. */
  async runSavedDeleteAcceptance(slot: number, signal?: AbortSignal): Promise<CodexSavedDeleteAcceptanceContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    const result = parseCodexSavedDeleteAcceptanceContract(await this.request(
      `v1/codex/profiles/${slot}/saved-delete-acceptance`, "POST", {}, signal));
    if (result.slot !== slot) throw new Error("Saved Chat deletion receipt slot does not match request");
    return result;
  }
  /** Delete-only owner-bound recovery of one saved test chat. No Send and no automatic retry. */
  async recoverSyntheticSavedChat(slot: number, signal?: AbortSignal): Promise<CodexSyntheticRecoveryContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw Error("invalid profile slot");
    const result = parseCodexSyntheticRecoveryContract(await this.request(
      `v1/codex/profiles/${slot}/synthetic-cleanup`, "POST", {}, signal));
    if (result.slot !== slot) throw Error("synthetic cleanup receipt slot mismatch");
    return result;
  }

  async accountCheck(slot: number, signal?: AbortSignal): Promise<CodexAccountCheckContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    const value = parseCodexAccountCheckContract(await this.request(`v1/codex/profiles/${slot}/account-check`, "GET", undefined, signal));
    if (value.slot !== slot) throw new Error("account observation slot does not match request");
    return value;
  }

  async accountDisplay(slot: number, signal?: AbortSignal): Promise<CodexAccountDisplayContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    const value = parseCodexAccountDisplayContract(await this.request(`v1/codex/profiles/${slot}/account-display`, "GET", undefined, signal));
    if (value.slot !== slot) throw new Error("account display slot does not match request");
    return value;
  }

  async startProfile(slot: number, signal?: AbortSignal): Promise<CodexProfileStatusContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexProfileStatusContract(await this.request(`v1/codex/profiles/${slot}/start`, "POST", {}, signal));
  }

  async stopProfile(slot: number, signal?: AbortSignal): Promise<CodexProfileStatusContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexProfileStatusContract(await this.request(`v1/codex/profiles/${slot}/stop`, "POST", {}, signal));
  }

  async terminalSession(slot: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
    const session = parseCodexTerminalSessionContract(await this.request(
      `v1/codex/profiles/${slot}/terminal-session`, "GET", undefined, signal,
    ));
    if (session.slot !== slot) throw new Error("terminal session does not match requested profile");
    return session;
  }
  async inspectWork(slot: number, threadId: string, minutes = 30, signal?: AbortSignal) {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)
      || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
      throw new Error("invalid Native work inspection arguments");
    }
    const response = await this.request(`v1/codex/profiles/${slot}/work-inspection`, "POST",
      { threadId, minutes }, signal);
    return parseCodexWorkInspectionContract(response, slot, threadId);
  }

  async bridgePreview(slot: number, signal?: AbortSignal, surfaceId?: string): Promise<CodexBridgePreviewContract> {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("Codex profile slot must be an integer from 1 to 99");
    return parseCodexBridgePreviewContract(await this.request(
      `v1/codex/profiles/${slot}/bridge-preview${surfaceId ? "?surfaceId=" + encodeURIComponent(surfaceId) : ""}`,
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
  async maintenanceProcesses(): Promise<readonly { workspaceId: string; workspaceName: string; operationId: string; sessionId: number; startedAt: string; state: string; liveness: string }[]> {
    const value = await this.request("v1/maintenance/processes", "GET") as Record<string, unknown>;
    if (value.contractVersion !== 1 || value.instanceId !== this.descriptor.instanceId || !Array.isArray(value.processes)) throw Error("invalid maintenance process inventory");
    return value.processes as { workspaceId: string; workspaceName: string; operationId: string; sessionId: number; startedAt: string; state: string; liveness: string }[];
  }
  async workspacePolicyFingerprint(signal?: AbortSignal): Promise<string | undefined> {
    const value = await this.request("v1/chat/workspace-policy", "GET", undefined, signal) as Record<string, unknown>;
    if (value.contractVersion !== 1 || value.service !== "chat") throw new Error("invalid Chat workspace policy");
    if (value.fingerprint === null) return undefined;
    if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error("invalid Chat workspace policy fingerprint");
    return value.fingerprint;
  }

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
