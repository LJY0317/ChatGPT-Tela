import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  NativeToolCatalogEntry,
  NativeToolInvocation,
  NativeToolKind,
  NativeToolResult,
} from "@chatgpt-tela/core";

export type BackendServiceId = "chat" | "codex";
export type TelaServiceId = "gateway" | BackendServiceId;

export interface ServiceRuntimeDescriptor {
  readonly version: 1;
  readonly service: TelaServiceId;
  readonly instanceId: string;
  readonly installId: string;
  readonly pid: number;
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly startedAt: string;
}

export interface ServiceStatus {
  readonly contractVersion: 1;
  readonly service: TelaServiceId;
  readonly instanceId: string;
  readonly state: "ready" | "degraded" | "stopping";
  readonly detail?: string;
}

export interface CodexToolInventoryRequest {
  readonly turnCapability: string;
  readonly query: string;
}

export interface CodexToolInventoryResponse {
  readonly tools: readonly NativeToolCatalogEntry[];
}

export interface CodexToolInvokeRequest {
  readonly turnCapability: string;
  readonly invocation: NativeToolInvocation;
}

export interface CodexToolInvokeResponse {
  readonly result: NativeToolResult;
}

export interface CodexProfileStatusContract {
  readonly slot: number;
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly targetState: string;
  readonly targetSessionState: string;
  readonly controlState: "stopped" | "running" | "restart-required" | "orphaned";
  readonly childProcessId?: number;
  readonly responsesRouteFingerprint?: string;
}

export interface CodexBridgePreviewContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly activeSurfaceCount: number;
  readonly previewAvailable: boolean;
  readonly imageMimeType?: "image/jpeg";
  readonly imageBase64?: string;
}

export interface ChatCapabilityContract {
  readonly capability: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export function parseCodexProfileStatusContract(value: unknown): CodexProfileStatusContract {
  const item = object(value, "Codex profile status");
  if (!Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99) {
    throw new Error("Codex profile slot is invalid");
  }
  const controlState = item.controlState;
  if (!(controlState === "stopped" || controlState === "running" || controlState === "restart-required" || controlState === "orphaned")) {
    throw new Error("Codex profile control state is invalid");
  }
  if (item.childProcessId !== undefined && (!Number.isSafeInteger(item.childProcessId) || (item.childProcessId as number) < 1)) {
    throw new Error("Codex profile child process id is invalid");
  }
  const fingerprint = item.responsesRouteFingerprint;
  if (fingerprint !== undefined && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) {
    throw new Error("Codex profile route fingerprint is invalid");
  }
  return Object.freeze({
    slot: item.slot as number,
    targetId: text(item.targetId, "Codex target id"),
    targetDisplayName: text(item.targetDisplayName, "Codex target display name"),
    targetState: text(item.targetState, "Codex target state"),
    targetSessionState: text(item.targetSessionState, "Codex target session state"),
    controlState,
    ...(item.childProcessId === undefined ? {} : { childProcessId: item.childProcessId as number }),
    ...(fingerprint === undefined ? {} : { responsesRouteFingerprint: fingerprint }),
  });
}

export function parseCodexBridgePreviewContract(value: unknown): CodexBridgePreviewContract {
  const item = object(value, "Codex bridge preview");
  if (item.contractVersion !== 1) throw new Error("unsupported Codex bridge preview version");
  if (!Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99) {
    throw new Error("Codex bridge preview slot is invalid");
  }
  if (!Number.isSafeInteger(item.activeSurfaceCount)
    || (item.activeSurfaceCount as number) < 0
    || (item.activeSurfaceCount as number) > 128) {
    throw new Error("Codex bridge preview active surface count is invalid");
  }
  if (typeof item.previewAvailable !== "boolean") throw new Error("Codex bridge preview availability is invalid");
  const imageMimeType = item.imageMimeType;
  const imageBase64 = item.imageBase64;
  if (item.previewAvailable) {
    if (item.activeSurfaceCount !== 1 || imageMimeType !== "image/jpeg" || typeof imageBase64 !== "string"
      || imageBase64.length < 4 || imageBase64.length > 6 * 1024 * 1024
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
      throw new Error("Codex bridge preview image is invalid");
    }
  } else if (imageMimeType !== undefined || imageBase64 !== undefined) {
    throw new Error("unavailable Codex bridge preview must not include image data");
  }
  return Object.freeze({
    contractVersion: 1,
    slot: item.slot as number,
    activeSurfaceCount: item.activeSurfaceCount as number,
    previewAvailable: item.previewAvailable,
    ...(item.previewAvailable ? { imageMimeType: "image/jpeg" as const, imageBase64: imageBase64 as string } : {}),
  });
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

export function parseServiceRuntimeDescriptor(value: unknown): ServiceRuntimeDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service descriptor must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("unsupported service descriptor version");
  if (!(["gateway", "chat", "codex"] as const).includes(item.service as never)) throw new Error("service id is invalid");
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) < 1) throw new Error("service pid is invalid");
  const endpoint = new URL(text(item.endpoint, "service endpoint"));
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("service endpoint must be credential-free loopback http://");
  }
  const bearerToken = text(item.bearerToken, "service bearer token");
  if (bearerToken.length < 32) throw new Error("service bearer token is too short");
  return Object.freeze({
    version: 1,
    service: item.service as TelaServiceId,
    instanceId: text(item.instanceId, "service instance id"),
    installId: text(item.installId, "service install id"),
    pid: item.pid as number,
    endpoint: endpoint.href,
    bearerToken,
    startedAt: text(item.startedAt, "service startedAt"),
  });
}

export function readServiceRuntimeDescriptor(path: string): ServiceRuntimeDescriptor | undefined {
  if (!existsSync(path)) return undefined;
  return parseServiceRuntimeDescriptor(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeServiceRuntimeDescriptor(path: string, descriptor: ServiceRuntimeDescriptor): void {
  const normalized = parseServiceRuntimeDescriptor(descriptor);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

export function removeServiceRuntimeDescriptor(path: string): void {
  rmSync(path, { force: true });
}

export function parseServiceStatus(value: unknown): ServiceStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service status must be an object");
  const item = value as Record<string, unknown>;
  if (item.contractVersion !== 1) throw new Error("unsupported service status version");
  if (!(["gateway", "chat", "codex"] as const).includes(item.service as never)) throw new Error("service status id is invalid");
  if (!(["ready", "degraded", "stopping"] as const).includes(item.state as never)) throw new Error("service status state is invalid");
  return Object.freeze({ contractVersion: 1, service: item.service as TelaServiceId,
    instanceId: text(item.instanceId, "service status instance id"), state: item.state as ServiceStatus["state"],
    ...(item.detail === undefined ? {} : { detail: text(item.detail, "service status detail") }) });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

export function parseChatCapabilityContract(value: unknown, field = "Chat capability"): ChatCapabilityContract {
  const item = object(value, field);
  const inputSchema = Object.freeze({ ...object(item.inputSchema, `${field} input schema`) });
  return Object.freeze({
    capability: text(item.capability, `${field} name`),
    description: typeof item.description === "string" ? item.description : "",
    inputSchema,
  });
}

export function parseCodexToolInventoryRequest(value: unknown): CodexToolInventoryRequest {
  const item = object(value, "Codex tool inventory request");
  return Object.freeze({
    turnCapability: text(item.turnCapability, "turn capability"),
    query: typeof item.query === "string" ? item.query : "",
  });
}

export function parseCodexToolInvokeRequest(value: unknown): CodexToolInvokeRequest {
  const item = object(value, "Codex tool invoke request");
  const invocation = object(item.invocation, "Native tool invocation");
  const mode = invocation.mode;
  if (mode !== "structured" && mode !== "freeform") throw new Error("Native tool invocation mode is invalid");
  const callId = text(invocation.callId, "Native tool call id");
  const wireName = text(invocation.wireName, "Native tool wire name");
  const parsed: NativeToolInvocation = mode === "structured"
    ? Object.freeze({
        callId,
        wireName,
        mode,
        arguments: object(invocation.arguments, "Native tool arguments"),
      })
    : Object.freeze({
        callId,
        wireName,
        mode,
        input: text(invocation.input, "Native tool freeform input"),
      });
  return Object.freeze({ turnCapability: text(item.turnCapability, "turn capability"), invocation: parsed });
}

const NATIVE_TOOL_KINDS = new Set<NativeToolKind>(["function", "freeform", "discovery", "gateway", "other"]);

function parseNativeToolCatalogEntry(value: unknown): NativeToolCatalogEntry {
  const item = object(value, "Native tool inventory entry");
  const kind = item.kind;
  if (typeof kind !== "string" || !NATIVE_TOOL_KINDS.has(kind as NativeToolKind)) {
    throw new Error("Native tool inventory kind is invalid");
  }
  const inputSchema = item.inputSchema;
  return Object.freeze({
    wireName: text(item.wireName, "Native tool wire name"),
    name: text(item.name, "Native tool name"),
    ...(item.namespace === undefined ? {} : { namespace: text(item.namespace, "Native tool namespace") }),
    kind: kind as NativeToolKind,
    description: typeof item.description === "string" ? item.description : "",
    ...(inputSchema === undefined ? {} : { inputSchema: Object.freeze({ ...object(inputSchema, "Native tool input schema") }) }),
    observedFrom: Array.isArray(item.observedFrom)
      ? Object.freeze(item.observedFrom.map((source, index) => text(source, `Native tool observedFrom[${index}]`)))
      : Object.freeze(["tela-codex-private-protocol"]),
  });
}

export function parseCodexToolInventoryResponse(value: unknown): CodexToolInventoryResponse {
  const item = object(value, "Codex tool inventory response");
  if (!Array.isArray(item.tools)) throw new Error("Codex tool inventory response tools must be an array");
  return Object.freeze({ tools: Object.freeze(item.tools.map(parseNativeToolCatalogEntry)) });
}

export function parseCodexToolInvokeResponse(value: unknown): CodexToolInvokeResponse {
  const item = object(value, "Codex tool invoke response");
  const result = object(item.result, "Native tool result");
  if (typeof result.content !== "string" || typeof result.isError !== "boolean") {
    throw new Error("Native tool result is invalid");
  }
  return Object.freeze({
    result: Object.freeze({
      callId: text(result.callId, "Native tool result call id"),
      content: result.content,
      isError: result.isError,
    }),
  });
}
