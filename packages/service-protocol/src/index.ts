import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseChatCapabilitySemantics, type ChatCapabilitySemantics } from "./chat-capability-semantics";
export { parseChatCapabilitySemantics, type ChatCapabilitySemantics } from "./chat-capability-semantics";
export { parseCodexWorkInspectionContract } from "./work-inspection";
export { parseCodexAgentApprovalReview, parseCodexApprovalWait, type CodexApprovalWaitContract, type CodexAgentApprovalReviewContract } from "./approval-review";
import { parseCodexAgentApprovalReview, parseCodexApprovalWait, type CodexApprovalWaitContract, type CodexAgentApprovalReviewContract } from "./approval-review";
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
  /** Advisory only: actual shutdown admission remains atomic at the service. */
  readonly shutdownReadiness?: "ready" | "blocked";
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

export type CodexWebState = "preparing" | "ready" | "login-required" | "failed" | "closed";

export interface CodexAccountCheckContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly nativeSignIn: "signed-in" | "signed-out" | "unavailable";
  readonly webBinding: "matching" | "different" | "unbound" | "unavailable";
  readonly nativeWebContainer: "matching" | "different" | "unavailable";
  readonly userIdentity: "unverified";
}

/** Sensitive, ephemeral local UI data. Never include this in inventory, logs or caches. */
export interface CodexAccountDisplayContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly native: { readonly state: "signed-in" | "signed-out" | "unavailable"; readonly email?: string };
  readonly web: { readonly state: "signed-in" | "signed-out" | "unavailable"; readonly email?: string };
  /** Email comparison only, not proof of Desktop UI identity or workspace equality. */
  readonly comparison: "matching" | "different" | "unavailable";
}

export function accountDisplayEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(value)) return undefined;
  return value;
}

export function compareAccountDisplayEmails(native: string | undefined, web: string | undefined): CodexAccountDisplayContract["comparison"] {
  if (!native || !web) return "unavailable";
  // Domains are case-insensitive; do not assume the same for local parts.
  const normalized = (email: string) => email.slice(0, email.lastIndexOf("@") + 1) + email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return normalized(native) === normalized(web) ? "matching" : "different";
}

export function parseCodexAccountDisplayContract(value: unknown): CodexAccountDisplayContract {
  const item = object(value, "Codex account display");
  if (item.contractVersion !== 1 || !Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99) throw new Error("Invalid Codex account display");
  const read = (value: unknown): CodexAccountDisplayContract["native"] => {
    const row = object(value, "Codex account display state");
    if (!["signed-in", "signed-out", "unavailable"].includes(row.state as string)
      || (row.email !== undefined && (row.state !== "signed-in" || accountDisplayEmail(row.email) === undefined))) throw new Error("Invalid Codex account display state");
    return Object.freeze({ state: row.state as CodexAccountDisplayContract["native"]["state"], ...(row.email !== undefined ? { email: row.email as string } : {}) });
  };
  const native = read(item.native), web = read(item.web);
  const comparison = compareAccountDisplayEmails(native.email, web.email);
  if (item.comparison !== comparison) throw new Error("Invalid Codex account display comparison");
  return Object.freeze({ contractVersion: 1, slot: item.slot as number, native, web, comparison });
}

export function parseCodexAccountCheckContract(value: unknown): CodexAccountCheckContract {
  const item = object(value, "Codex account observation");
  if (item.contractVersion !== 1 || !Number.isSafeInteger(item.slot)
    || (item.slot as number) < 1 || (item.slot as number) > 99
    || !["signed-in", "signed-out", "unavailable"].includes(item.nativeSignIn as string)
    || !["matching", "different", "unbound", "unavailable"].includes(item.webBinding as string)
    || !["matching", "different", "unavailable"].includes(item.nativeWebContainer as string)
    || item.userIdentity !== "unverified") throw new Error("Invalid Codex account observation");
  return Object.freeze({ contractVersion: 1, slot: item.slot as number,
    nativeSignIn: item.nativeSignIn as CodexAccountCheckContract["nativeSignIn"],
    webBinding: item.webBinding as CodexAccountCheckContract["webBinding"],
    nativeWebContainer: item.nativeWebContainer as CodexAccountCheckContract["nativeWebContainer"],
    userIdentity: "unverified" });
}

export interface CodexProfileStatusContract {
  readonly slot: number;
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly targetState: string;
  readonly targetSessionState: string;
  readonly controlState: "stopped" | "running" | "restart-required" | "orphaned";
  readonly childProcessId?: number;
  readonly desktopProcessId?: number;
  readonly connectionInProgress?: boolean;
  readonly webModelsReady?: boolean;
  readonly webState?: CodexWebState;
  /** UI-only hint: this exact owner's account browser has suspended Web admission. */
  readonly accountManagementActive?: boolean;
  readonly responsesRouteFingerprint?: string;
}

export interface CodexBridgePreviewContract {
  readonly surfaces?: readonly { readonly id: string; readonly label: string }[];
  readonly selectedSurfaceId?: string;
  readonly contractVersion: 1;
  readonly slot: number;
  readonly activeSurfaceCount: number;
  readonly previewAvailable: boolean;
  readonly imageMimeType?: "image/jpeg";
  readonly imageBase64?: string;
  readonly approvalState?: "pending" | "none" | "unavailable";
  readonly approvalObservationReason?: "automation_unavailable" | "dom_observation_failed";
  readonly approvalReview?: CodexAgentApprovalReviewContract;
  readonly approvalWait?: CodexApprovalWaitContract;
}

export interface CodexModelSelectionCanaryContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly familyCount: number;
  readonly exercised: boolean;
  readonly testedEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly restoredEffort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface CodexContextAttachmentCanaryContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly attachmentBytes: number;
  readonly receiptVerified: true;
}

export interface ChatCapabilityContract {
  readonly capability: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly semantics?: ChatCapabilitySemantics;
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
  if (item.desktopProcessId !== undefined && (!Number.isSafeInteger(item.desktopProcessId) || (item.desktopProcessId as number) < 1)) {
    throw new Error("Codex profile Desktop process id is invalid");
  }
  if (item.webState !== undefined && !["preparing", "ready", "login-required", "failed", "closed"].includes(item.webState as string)) throw new Error("invalid Web connection state");
  if (item.webModelsReady !== undefined && typeof item.webModelsReady !== "boolean") throw new Error("invalid Web model readiness");
  if (item.accountManagementActive !== undefined && typeof item.accountManagementActive !== "boolean") {
    throw new Error("invalid account management state");
  }
  if (item.accountManagementActive === true && item.webState !== "preparing") throw new Error("account management must suspend Web admission");
  if (item.connectionInProgress !== undefined && typeof item.connectionInProgress !== "boolean") {
    throw new Error("Codex profile connection progress is invalid");
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
    ...(item.desktopProcessId === undefined ? {} : { desktopProcessId: item.desktopProcessId as number }),
    ...(item.webState === undefined ? {} : { webState: item.webState as CodexWebState }),
    ...(item.webModelsReady === undefined ? {} : { webModelsReady: item.webModelsReady as boolean }),
    ...(item.accountManagementActive === undefined ? {} : { accountManagementActive: item.accountManagementActive as boolean }),
    ...(item.connectionInProgress === undefined ? {} : { connectionInProgress: item.connectionInProgress as boolean }),
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
  const surfaces = item.surfaces;
  if (surfaces !== undefined && (!Array.isArray(surfaces) || surfaces.length !== item.activeSurfaceCount
    || surfaces.some(row => !row || typeof row.id !== "string" || !/^surface_[A-Za-z0-9_-]{32}$/.test(row.id)
      || typeof row.label !== "string" || row.label.length > 200)
    || new Set(surfaces.map(row => row.id)).size !== surfaces.length)) throw new Error("invalid browser surface inventory");
  const selected = item.selectedSurfaceId;
  if (selected !== undefined && (typeof selected !== "string" || !Array.isArray(surfaces)
    || !surfaces.some(row => row.id === selected))) throw new Error("invalid selected browser surface");
  const approvalState = item.approvalState;
  const approvalObservationReason = item.approvalObservationReason;
  if (approvalState !== undefined && (!["pending", "none", "unavailable"].includes(String(approvalState))
    || selected === undefined)) throw new Error("invalid selected approval state");
  if (approvalObservationReason !== undefined
    && (approvalState !== "unavailable"
      || !["automation_unavailable", "dom_observation_failed"].includes(String(approvalObservationReason)))) {
    throw new Error("invalid approval observation reason");
  }
  const rawReview = item.approvalReview;
  let approvalReview: CodexAgentApprovalReviewContract | undefined;
  if (rawReview !== undefined) {
    if (selected === undefined || approvalState !== "pending") throw new Error("invalid approval review ownership");
    approvalReview = parseCodexAgentApprovalReview(rawReview);
  }
  const approvalWait = item.approvalWait === undefined ? undefined : parseCodexApprovalWait(item.approvalWait);
  if (approvalWait && selected === undefined) throw new Error("invalid approval wait ownership");
  const imageMimeType = item.imageMimeType;
  const imageBase64 = item.imageBase64;
  if (item.previewAvailable) {
    if ((item.activeSurfaceCount !== 1 && selected === undefined) || imageMimeType !== "image/jpeg" || typeof imageBase64 !== "string"
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
    ...(surfaces ? { surfaces: Object.freeze(surfaces.map(row => Object.freeze({ id: row.id, label: row.label }))) } : {}),
    ...(selected ? { selectedSurfaceId: selected as string } : {}),
    ...(approvalState ? { approvalState: approvalState as NonNullable<CodexBridgePreviewContract["approvalState"]> } : {}),
    ...(approvalObservationReason ? { approvalObservationReason: approvalObservationReason as NonNullable<CodexBridgePreviewContract["approvalObservationReason"]> } : {}),
    ...(approvalReview ? { approvalReview } : {}),
    ...(approvalWait ? { approvalWait } : {}),
    ...(item.previewAvailable ? { imageMimeType: "image/jpeg" as const, imageBase64: imageBase64 as string } : {}),
  });
}

export function parseCodexModelSelectionCanaryContract(value: unknown): CodexModelSelectionCanaryContract {
  const item = object(value, "Codex model selection canary");
  if (item.contractVersion !== 1) throw new Error("unsupported Codex model selection canary version");
  if (!Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99) {
    throw new Error("Codex model selection canary slot is invalid");
  }
  if (!Number.isSafeInteger(item.familyCount) || (item.familyCount as number) < 0 || (item.familyCount as number) > 64) {
    throw new Error("Codex model selection canary family count is invalid");
  }
  if (typeof item.exercised !== "boolean") throw new Error("Codex model selection canary exercised flag is invalid");
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  const restoredEffort = item.restoredEffort;
  if (!efforts.includes(restoredEffort as never)) throw new Error("Codex model selection canary restored effort is invalid");
  const testedEffort = item.testedEffort;
  if (testedEffort !== undefined && !efforts.includes(testedEffort as never)) {
    throw new Error("Codex model selection canary tested effort is invalid");
  }
  if (item.exercised && testedEffort === undefined) {
    throw new Error("exercised Codex model selection canary is missing its tested effort");
  }
  if (!item.exercised && testedEffort !== undefined) {
    throw new Error("non-exercised Codex model selection canary must not report a tested effort");
  }
  const base = {
    contractVersion: 1 as const,
    slot: item.slot as number,
    familyCount: item.familyCount as number,
    exercised: item.exercised,
    restoredEffort: restoredEffort as CodexModelSelectionCanaryContract["restoredEffort"],
  };
  return testedEffort === undefined
    ? Object.freeze(base)
    : Object.freeze({
        ...base,
        testedEffort: testedEffort as CodexModelSelectionCanaryContract["restoredEffort"],
      });
}

export function parseCodexContextAttachmentCanaryContract(value: unknown): CodexContextAttachmentCanaryContract {
  const item = object(value, "Codex context attachment canary");
  if (item.contractVersion !== 1) throw new Error("unsupported Codex context attachment canary version");
  if (!Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99) {
    throw new Error("Codex context attachment canary slot is invalid");
  }
  if (!Number.isSafeInteger(item.attachmentBytes)
    || (item.attachmentBytes as number) < 1
    || (item.attachmentBytes as number) > 20_000_000) {
    throw new Error("Codex context attachment canary byte count is invalid");
  }
  if (item.receiptVerified !== true) {
    throw new Error("Codex context attachment canary receipt is not proven");
  }
  return Object.freeze({
    contractVersion: 1 as const,
    slot: item.slot as number,
    attachmentBytes: item.attachmentBytes as number,
    receiptVerified: true as const,
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
  if (item.shutdownReadiness !== undefined && item.shutdownReadiness !== "ready" && item.shutdownReadiness !== "blocked") {
    throw new Error("service shutdown readiness is invalid");
  }
  return Object.freeze({ contractVersion: 1, service: item.service as TelaServiceId,
    instanceId: text(item.instanceId, "service status instance id"), state: item.state as ServiceStatus["state"],
    ...(item.detail === undefined ? {} : { detail: text(item.detail, "service status detail") }),
    ...(item.shutdownReadiness === undefined ? {} : { shutdownReadiness: item.shutdownReadiness as "ready" | "blocked" }) });
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
    ...(item.semantics === undefined ? {} : { semantics: parseChatCapabilitySemantics(item.semantics) }),
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

/** Private, on-demand access to the already owned Native app-server; never public Gateway data. */
export interface CodexTerminalSessionContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly endpoint: string;
}

/** Private, exact-slot, content-free inspection. No chat id/title/URL or mutation authority. */
export interface CodexHistoryUiContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly route: "home" | "conversation" | "other";
  readonly historyLinkCount: number;
  readonly visibleHistoryLinkCount: number;
  readonly nearbyActionRowCount: number;
  readonly nearbyMenuRowCount: number;
  readonly visibleMenuCount: number;
  readonly visibleDialogCount: number;
}

export function parseCodexHistoryUiContract(value: unknown): CodexHistoryUiContract {
  const item = object(value, "Codex history UI preflight");
  const fields = ["contractVersion", "slot", "route", "historyLinkCount", "visibleHistoryLinkCount",
    "nearbyActionRowCount", "nearbyMenuRowCount", "visibleMenuCount", "visibleDialogCount"];
  if (Object.keys(item).some(key => !fields.includes(key)) || item.contractVersion !== 1
    || !Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99
    || !["home", "conversation", "other"].includes(item.route as string)) {
    throw new Error("Codex history UI observation identity or fields are invalid");
  }
  for (const field of fields.slice(3)) {
    if (!Number.isSafeInteger(item[field]) || (item[field] as number) < 0 || (item[field] as number) > 500) {
      throw new Error("Codex history UI bounded count is invalid");
    }
  }
  if ((item.visibleHistoryLinkCount as number) > (item.historyLinkCount as number)
    || (item.nearbyActionRowCount as number) > (item.historyLinkCount as number)
    || (item.nearbyMenuRowCount as number) > (item.nearbyActionRowCount as number)) {
    throw new Error("Codex history UI observation counts are inconsistent");
  }
  return Object.freeze({ contractVersion: 1, slot: item.slot as number,
    route: item.route as CodexHistoryUiContract["route"],
    historyLinkCount: item.historyLinkCount as number,
    visibleHistoryLinkCount: item.visibleHistoryLinkCount as number,
    nearbyActionRowCount: item.nearbyActionRowCount as number,
    nearbyMenuRowCount: item.nearbyMenuRowCount as number,
    visibleMenuCount: item.visibleMenuCount as number,
    visibleDialogCount: item.visibleDialogCount as number });
}

/** Owner-private receipt; never includes test markers, raw conversation paths or user content. */
export interface CodexSavedDeleteAcceptanceContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly newlyAccepted: true;
  readonly modelReplyCompleted: boolean;
  readonly officialDelete: {
    readonly contractVersion: 1;
    readonly menuOpened: true;
    readonly officialDeleteSelected: true;
    readonly officialConfirmationDispatched: true;
    readonly historyAbsentAfterReload: true;
  };
}

export function parseCodexSavedDeleteAcceptanceContract(value: unknown): CodexSavedDeleteAcceptanceContract {
  const row = object(value, "saved chat cleanup receipt");
  if (row.contractVersion !== 1 || !Number.isSafeInteger(row.slot)
    || (row.slot as number) < 1 || (row.slot as number) > 99
    || row.newlyAccepted !== true || typeof row.modelReplyCompleted !== "boolean"
    || Object.keys(row).sort().join("|") !== ["contractVersion", "slot", "newlyAccepted", "modelReplyCompleted", "officialDelete"].sort().join("|")) {
    throw new Error("invalid owner-bound saved chat acceptance receipt");
  }
  const deleted = object(row.officialDelete, "saved chat official deletion");
  if (Object.keys(deleted).sort().join("|")
      !== ["contractVersion", "menuOpened", "officialDeleteSelected",
        "officialConfirmationDispatched", "historyAbsentAfterReload"].sort().join("|")
    || deleted.contractVersion !== 1 || deleted.menuOpened !== true
    || deleted.officialDeleteSelected !== true
    || deleted.officialConfirmationDispatched !== true
    || deleted.historyAbsentAfterReload !== true) {
    throw new Error("official saved-chat deletion was not proven");
  }
  return Object.freeze({
    contractVersion: 1,
    slot: row.slot as number,
    newlyAccepted: true,
    modelReplyCompleted: row.modelReplyCompleted as boolean,
    officialDelete: Object.freeze({
      contractVersion: 1, menuOpened: true, officialDeleteSelected: true,
      officialConfirmationDispatched: true, historyAbsentAfterReload: true,
    }),
  });
}

/** Cleanup-only receipt for a uniquely marked saved test chat. Never sends a message. */
export interface CodexSyntheticRecoveryContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly syntheticConversationProven: true;
  readonly officialDelete: CodexSavedDeleteAcceptanceContract["officialDelete"];
}

export function parseCodexSyntheticRecoveryContract(value: unknown): CodexSyntheticRecoveryContract {
  const row = object(value, "synthetic ChatGPT history cleanup");
  if (Object.keys(row).sort().join("|")
      !== ["contractVersion", "slot", "syntheticConversationProven", "officialDelete"].sort().join("|")
    || row.contractVersion !== 1 || row.syntheticConversationProven !== true) {
    throw new Error("Invalid synthetic cleanup proof fields");
  }
  const validated = parseCodexSavedDeleteAcceptanceContract({
    contractVersion: 1, slot: row.slot, newlyAccepted: true,
    modelReplyCompleted: false, officialDelete: row.officialDelete,
  });
  return Object.freeze({
    contractVersion: 1, slot: validated.slot, syntheticConversationProven: true,
    officialDelete: validated.officialDelete,
  });
}

export function parseCodexTerminalSessionContract(value: unknown): CodexTerminalSessionContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid terminal session");
  const item = value as Record<string, unknown>;
  if (item.contractVersion !== 1 || !Number.isSafeInteger(item.slot)
    || (item.slot as number) < 1 || (item.slot as number) > 99 || typeof item.endpoint !== "string") {
    throw new Error("invalid terminal session contract");
  }
  const url = new URL(item.endpoint);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("terminal session requires a plain loopback WebSocket endpoint");
  }
  return Object.freeze({ contractVersion: 1, slot: item.slot as number, endpoint: url.href });
}

/** Private profile control response. Browser admission is distinct from app-server visibility. */
export interface CodexWebStateContract {
  readonly contractVersion: 1;
  readonly slot: number;
  readonly webState: CodexWebState;
  readonly webModelIds: readonly string[];
  readonly accountManagementActive?: boolean;
}
export function parseCodexWebStateContract(value: unknown): CodexWebStateContract {
  const item = object(value, "Codex Web state");
  if (item.contractVersion !== 1 || !Number.isSafeInteger(item.slot) || (item.slot as number) < 1 || (item.slot as number) > 99
    || !["preparing", "ready", "login-required", "failed", "closed"].includes(item.webState as string)
    || !Array.isArray(item.webModelIds) || item.webModelIds.length > 128
    || item.webModelIds.some(id => typeof id !== "string" || id.length > 256 || !id.startsWith("chatgpt-tela-web/"))
    || new Set(item.webModelIds).size !== item.webModelIds.length
    || (item.webState === "ready" ? item.webModelIds.length === 0 : item.webModelIds.length !== 0)
    || (item.accountManagementActive !== undefined && typeof item.accountManagementActive !== "boolean")
    || (item.accountManagementActive === true && item.webState !== "preparing")) throw new Error("invalid Codex Web state");
  return Object.freeze({ contractVersion: 1, slot: item.slot as number, webState: item.webState as CodexWebState,
    webModelIds: Object.freeze([...item.webModelIds]) as readonly string[],
    ...(item.accountManagementActive === undefined ? {} : { accountManagementActive: item.accountManagementActive as boolean }) });
}
