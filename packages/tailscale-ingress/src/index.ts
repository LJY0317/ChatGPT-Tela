import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diagnosticDurationMs, emitDiagnosticEvent } from "@chatgpt-tela/core";
import type {
  HttpsMcpEndpoint,
  HttpsMcpEndpointAuthentication,
  McpEndpoint,
  McpExposureHealth,
  McpExposureProvider,
} from "@chatgpt-tela/mcp";
import {
  readOwnershipManifest,
  registerOwnedResource,
  unregisterOwnedResource,
  type OwnedResource,
  type OwnershipManifest,
  type OwnershipObservation,
  type UninstallObserver,
} from "@chatgpt-tela/product-lifecycle";

const execFileAsync = promisify(execFile);
const MAX_TAILSCALE_OUTPUT = 2 * 1024 * 1024;

export interface TailscaleFunnelLease {
  readonly version: 1;
  readonly host: string;
  readonly httpsPort: number;
  readonly publicPath: string;
  readonly localTarget: string;
  readonly fingerprint: string;
}

export type TailscaleFunnelLeaseState =
  | { readonly state: "absent" }
  | { readonly state: "owned"; readonly currentTarget: string }
  | { readonly state: "drift"; readonly currentTarget?: string; readonly reason: string };

export type TailscaleFunnelPlan =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "apply"; readonly arguments: readonly string[]; readonly reason: string }
  | { readonly action: "preserve"; readonly reason: string };

export interface TailscaleCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface TailscaleCommandRunner {
  run(arguments_: readonly string[], signal?: AbortSignal): Promise<TailscaleCommandResult>;
}

export type TailscaleBackendHealth =
  | { readonly state: "ready"; readonly backendState: "Running" }
  | { readonly state: "needs-login"; readonly backendState: string }
  | { readonly state: "offline"; readonly backendState: string }
  | { readonly state: "stopped"; readonly backendState: string }
  | { readonly state: "backend-unreachable" }
  | { readonly state: "cli-unavailable" }
  | { readonly state: "unavailable"; readonly backendState?: string };

export type TailscaleFunnelDiagnosisCause =
  | "ready"
  | "tailscale-cli-unavailable"
  | "tailscale-backend-unreachable"
  | "tailscale-needs-login"
  | "tailscale-offline"
  | "tailscale-stopped"
  | "tailscale-status-unavailable"
  | "funnel-route-absent"
  | "funnel-route-drift";

export interface TailscaleFunnelDiagnosis {
  readonly availability: "ready" | "unavailable";
  readonly cause: TailscaleFunnelDiagnosisCause;
  readonly backend: TailscaleBackendHealth;
  readonly route?: TailscaleFunnelLeaseState;
  readonly ownership: "unowned" | "owned" | "drift";
}

export class SystemTailscaleCommandRunner implements TailscaleCommandRunner {
  readonly #command: string;

  constructor(command = "tailscale") {
    if (typeof command !== "string" || !command.trim() || /[\u0000\r\n]/.test(command)) {
      throw new Error("Tailscale command is invalid");
    }
    this.#command = command;
  }

  async run(arguments_: readonly string[], signal?: AbortSignal): Promise<TailscaleCommandResult> {
    for (const argument of arguments_) {
      if (typeof argument !== "string" || argument.includes("\u0000")) throw new Error("Tailscale argument is invalid");
    }
    const result = await execFileAsync(this.#command, [...arguments_], {
      encoding: "utf8",
      maxBuffer: MAX_TAILSCALE_OUTPUT,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
  }
}

function path(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("\u0000")) {
    throw new Error("Tailscale Funnel path must be an absolute URL pathname");
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function loopbackTarget(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Tailscale Funnel local target must use loopback http://");
  }
  return url.href;
}

function fingerprint(input: {
  readonly host: string;
  readonly httpsPort: number;
  readonly publicPath: string;
  readonly localTarget: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    host: input.host,
    httpsPort: input.httpsPort,
    publicPath: input.publicPath,
    localTarget: input.localTarget,
  })).digest("hex");
}

export function createTailscaleFunnelLease(input: {
  readonly publicUrl: URL | string;
  readonly localTarget: URL | string;
}): TailscaleFunnelLease {
  const publicUrl = input.publicUrl instanceof URL ? new URL(input.publicUrl.href) : new URL(input.publicUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error("Tailscale Funnel public URL must be credential-free https://");
  }
  const httpsPort = publicUrl.port ? Number(publicUrl.port) : 443;
  if (![443, 8443, 10000].includes(httpsPort)) throw new Error("Tailscale Funnel HTTPS port is not supported");
  const publicPath = path(publicUrl.pathname || "/");
  const localTarget = loopbackTarget(input.localTarget instanceof URL ? input.localTarget.href : input.localTarget);
  const base = { host: publicUrl.hostname, httpsPort, publicPath, localTarget };
  return Object.freeze({ version: 1, ...base, fingerprint: fingerprint(base) });
}

function routeIdentityFingerprint(lease: TailscaleFunnelLease): string {
  return createHash("sha256").update(JSON.stringify({
    host: lease.host,
    httpsPort: lease.httpsPort,
    publicPath: lease.publicPath,
  })).digest("hex");
}

export function tailscaleFunnelOwnedResource(lease: TailscaleFunnelLease): OwnedResource {
  return Object.freeze({
    kind: "tailscale-route" as const,
    id: `tailscale-funnel:${routeIdentityFingerprint(lease)}`,
    owner: "gateway" as const,
    host: lease.host,
    httpsPort: lease.httpsPort,
    publicPath: lease.publicPath,
    localTarget: lease.localTarget,
    leaseFingerprint: lease.fingerprint,
  });
}

export function tailscaleFunnelLeaseFromResource(resource: Extract<OwnedResource, { readonly kind: "tailscale-route" }>): TailscaleFunnelLease {
  const publicUrl = new URL(`https://${resource.host}${resource.httpsPort === 443 ? "" : `:${resource.httpsPort}`}${resource.publicPath}`);
  const lease = createTailscaleFunnelLease({ publicUrl, localTarget: resource.localTarget });
  if (lease.fingerprint !== resource.leaseFingerprint) {
    throw new Error("Tailscale route manifest fingerprint does not match its recorded identity");
  }
  return lease;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedBackendState(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
    ? value
    : undefined;
}

export function inspectTailscaleBackendHealth(status: unknown): TailscaleBackendHealth {
  const root = object(status);
  if (!root) return Object.freeze({ state: "unavailable" as const });
  const backendState = boundedBackendState(root.BackendState);
  const self = object(root.Self);
  const online = self?.Online;
  if (backendState === "Running" && online === true) {
    return Object.freeze({ state: "ready" as const, backendState: "Running" as const });
  }
  if (backendState === "NeedsLogin") {
    return Object.freeze({ state: "needs-login" as const, backendState });
  }
  if (backendState === "Stopped" || backendState === "NoState") {
    return Object.freeze({ state: "stopped" as const, backendState });
  }
  if (backendState === "Running" && online === false) {
    return Object.freeze({ state: "offline" as const, backendState });
  }
  return Object.freeze({
    state: "unavailable" as const,
    ...(backendState ? { backendState } : {}),
  });
}

function commandFailureCode(error: unknown): "cli-unavailable" | "backend-unreachable" | "unavailable" {
  if (error && typeof error === "object") {
    const item = error as { code?: unknown; message?: unknown; stderr?: unknown };
    if (item.code === "ENOENT") return "cli-unavailable";
    const text = [item.message, item.stderr]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (text.includes("tailscaled")
      || text.includes("local tailscale")
      || text.includes("tailscale service")
      || text.includes("tailscale is not running")
      || text.includes("failed to connect")
      || text.includes("connect to local")) {
      return "backend-unreachable";
    }
  }
  return "unavailable";
}

function diagnosisCause(backend: TailscaleBackendHealth): TailscaleFunnelDiagnosisCause {
  switch (backend.state) {
    case "cli-unavailable": return "tailscale-cli-unavailable";
    case "backend-unreachable": return "tailscale-backend-unreachable";
    case "needs-login": return "tailscale-needs-login";
    case "offline": return "tailscale-offline";
    case "stopped": return "tailscale-stopped";
    case "unavailable": return "tailscale-status-unavailable";
    case "ready": return "ready";
  }
}

export function tailscaleDiagnosisDetail(cause: TailscaleFunnelDiagnosisCause): string {
  switch (cause) {
    case "ready": return "Tailscale Funnel and the exact Tela route are ready";
    case "tailscale-cli-unavailable": return "Tailscale CLI is unavailable; install Tailscale or fix the configured CLI path";
    case "tailscale-backend-unreachable": return "Tailscale is not running or its local backend cannot be reached; open Tailscale and wait until it is connected";
    case "tailscale-needs-login": return "Tailscale requires sign-in before ChatGPT Tela public ingress can work";
    case "tailscale-offline": return "Tailscale is running but this device is offline from the tailnet";
    case "tailscale-stopped": return "Tailscale backend is stopped; start Tailscale before using the ChatGPT Tela connector";
    case "tailscale-status-unavailable": return "Tailscale status could not be determined";
    case "funnel-route-absent": return "Tailscale is online, but the configured ChatGPT Tela Funnel route is absent";
    case "funnel-route-drift": return "Tailscale is online, but the configured ChatGPT Tela Funnel route no longer matches its expected target";
  }
}

export function inspectTailscaleFunnelLease(
  lease: TailscaleFunnelLease,
  status: unknown,
): TailscaleFunnelLeaseState {
  const root = object(status);
  if (!root) return { state: "drift", reason: "Tailscale status is not an object" };
  const web = object(root.Web);
  const allowFunnel = object(root.AllowFunnel);
  const hostKey = `${lease.host}:${lease.httpsPort}`;
  const host = object(web?.[hostKey]);
  const handlers = object(host?.Handlers);
  const handler = object(handlers?.[lease.publicPath]);
  const funnelAllowed = allowFunnel?.[hostKey] === true;
  if (!handler) {
    if (host && !funnelAllowed) {
      return { state: "drift", reason: "HTTPS host exists but Funnel is not enabled for it" };
    }
    return { state: "absent" };
  }
  const currentTarget = typeof handler.Proxy === "string" ? handler.Proxy : undefined;
  if (!currentTarget) return { state: "drift", reason: "Tela path is occupied by a non-proxy handler" };
  let normalizedCurrent: string;
  try { normalizedCurrent = new URL(currentTarget).href; }
  catch { return { state: "drift", currentTarget, reason: "current proxy target is not a valid URL" }; }
  if (!funnelAllowed) {
    return { state: "drift", currentTarget: normalizedCurrent, reason: "path exists but Funnel is not enabled" };
  }
  if (normalizedCurrent !== lease.localTarget) {
    return { state: "drift", currentTarget: normalizedCurrent, reason: "path now points to a different target" };
  }
  return { state: "owned", currentTarget: normalizedCurrent };
}

export function planAcquireTailscaleFunnelLease(
  lease: TailscaleFunnelLease,
  state: TailscaleFunnelLeaseState,
): TailscaleFunnelPlan {
  if (state.state === "owned") return { action: "none", reason: "Tela Funnel path is already configured" };
  if (state.state === "drift") return { action: "preserve", reason: state.reason };
  return Object.freeze({
    action: "apply" as const,
    arguments: Object.freeze([
      "funnel",
      "--bg",
      `--https=${lease.httpsPort}`,
      `--set-path=${lease.publicPath}`,
      lease.localTarget,
    ]),
    reason: "Tela Funnel path is absent",
  });
}

export function planReleaseTailscaleFunnelLease(
  lease: TailscaleFunnelLease,
  state: TailscaleFunnelLeaseState,
): TailscaleFunnelPlan {
  if (state.state === "absent") return { action: "none", reason: "Tela Funnel path is already absent" };
  if (state.state === "drift") return { action: "preserve", reason: state.reason };
  return Object.freeze({
    action: "apply" as const,
    arguments: Object.freeze([
      "funnel",
      `--https=${lease.httpsPort}`,
      `--set-path=${lease.publicPath}`,
      "off",
    ]),
    reason: "current Funnel path still matches Tela ownership",
  });
}

function exactManifestResource(
  manifest: OwnershipManifest | undefined,
  installId: string,
  lease: TailscaleFunnelLease,
): "missing" | "exact" | "drift" {
  if (!manifest) return "missing";
  if (manifest.installId !== installId) throw new Error("Tailscale lease manifest belongs to a different Tela install instance");
  const expected = tailscaleFunnelOwnedResource(lease);
  const current = manifest.resources.find(resource => resource.id === expected.id);
  if (!current) return "missing";
  return JSON.stringify(current) === JSON.stringify(expected) ? "exact" : "drift";
}

export interface TailscaleFunnelLeaseApplyResult {
  readonly state: "acquired" | "already-owned" | "external-match" | "released" | "already-absent" | "preserved";
  readonly lease: TailscaleFunnelLease;
  readonly detail: string;
  readonly mutated: boolean;
}

export class TailscaleFunnelLeaseManager {
  readonly #runner: TailscaleCommandRunner;
  readonly #manifestPath: string;
  readonly #installId: string;
  readonly #productVersion: string;

  constructor(input: {
    readonly runner?: TailscaleCommandRunner;
    readonly manifestPath: string;
    readonly installId: string;
    readonly productVersion: string;
  }) {
    this.#runner = input.runner ?? new SystemTailscaleCommandRunner();
    this.#manifestPath = input.manifestPath;
    this.#installId = input.installId;
    this.#productVersion = input.productVersion;
  }

  get installId(): string {
    return this.#installId;
  }

  ownership(lease: TailscaleFunnelLease): "unowned" | "owned" | "drift" {
    const state = exactManifestResource(readOwnershipManifest(this.#manifestPath), this.#installId, lease);
    return state === "missing" ? "unowned" : state === "exact" ? "owned" : "drift";
  }

  async status(signal?: AbortSignal): Promise<unknown> {
    const result = await this.#runner.run(["serve", "status", "--json"], signal);
    try { return JSON.parse(result.stdout) as unknown; }
    catch (error) { throw new Error("Tailscale serve status returned invalid JSON", { cause: error }); }
  }

  async backendHealth(signal?: AbortSignal): Promise<TailscaleBackendHealth> {
    const startedAt = Date.now();
    let health: TailscaleBackendHealth;
    try {
      const result = await this.#runner.run(["status", "--json"], signal);
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout) as unknown; }
      catch { parsed = undefined; }
      health = inspectTailscaleBackendHealth(parsed);
    } catch (error) {
      const code = commandFailureCode(error);
      health = Object.freeze({ state: code } as TailscaleBackendHealth);
    }
    emitDiagnosticEvent("chatgpt_tela_ingress", "tailscale_backend_check", {
      state: health.state,
      duration_ms: diagnosticDurationMs(startedAt),
    });
    return health;
  }

  async diagnose(lease: TailscaleFunnelLease, signal?: AbortSignal): Promise<TailscaleFunnelDiagnosis> {
    const backend = await this.backendHealth(signal);
    const ownership = this.ownership(lease);
    if (backend.state !== "ready") {
      return Object.freeze({
        availability: "unavailable" as const,
        cause: diagnosisCause(backend),
        backend,
        ownership,
      });
    }
    let route: TailscaleFunnelLeaseState;
    try {
      route = await this.inspect(lease, signal);
    } catch {
      return Object.freeze({
        availability: "unavailable" as const,
        cause: "tailscale-status-unavailable" as const,
        backend,
        ownership,
      });
    }
    if (route.state === "owned") {
      return Object.freeze({
        availability: "ready" as const,
        cause: "ready" as const,
        backend,
        route,
        ownership,
      });
    }
    return Object.freeze({
      availability: "unavailable" as const,
      cause: route.state === "absent" ? "funnel-route-absent" as const : "funnel-route-drift" as const,
      backend,
      route,
      ownership,
    });
  }

  async inspect(lease: TailscaleFunnelLease, signal?: AbortSignal): Promise<TailscaleFunnelLeaseState> {
    const startedAt = Date.now();
    try {
      const state = inspectTailscaleFunnelLease(lease, await this.status(signal));
      emitDiagnosticEvent("chatgpt_tela_ingress", "inspect_complete", {
        state: state.state,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return state;
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_ingress", "inspect_failed", {
        duration_ms: diagnosticDurationMs(startedAt),
      });
      throw error;
    }
  }

  async acquire(
    lease: TailscaleFunnelLease,
    input: { readonly adoptExisting?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<TailscaleFunnelLeaseApplyResult> {
    const startedAt = Date.now();
    emitDiagnosticEvent("chatgpt_tela_ingress", "acquire_start");
    const manifest = readOwnershipManifest(this.#manifestPath);
    const manifestState = exactManifestResource(manifest, this.#installId, lease);
    if (manifestState === "drift") throw new Error("Tailscale route manifest identity drifted; refusing to overwrite it");
    const observed = await this.inspect(lease, input.signal);
    if (observed.state === "drift") {
      emitDiagnosticEvent("chatgpt_tela_ingress", "acquire_preserved_drift", {
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: "preserved", lease, detail: observed.reason, mutated: false });
    }
    if (observed.state === "owned") {
      if (manifestState === "exact") {
        emitDiagnosticEvent("chatgpt_tela_ingress", "acquire_already_owned", {
          duration_ms: diagnosticDurationMs(startedAt),
        });
        return Object.freeze({ state: "already-owned", lease, detail: "existing Funnel route is already owned by this Tela install", mutated: false });
      }
      if (input.adoptExisting !== true) {
        emitDiagnosticEvent("chatgpt_tela_ingress", "acquire_external_match", {
          duration_ms: diagnosticDurationMs(startedAt),
        });
        return Object.freeze({ state: "external-match", lease,
          detail: "matching Funnel route predates Tela ownership and was not adopted", mutated: false });
      }
      await registerOwnedResource({ path: this.#manifestPath, installId: this.#installId,
        productVersion: this.#productVersion, resource: tailscaleFunnelOwnedResource(lease) });
      return Object.freeze({ state: "already-owned", lease, detail: "matching Funnel route explicitly adopted by this Tela install", mutated: true });
    }

    if (manifestState !== "exact") {
      await registerOwnedResource({ path: this.#manifestPath, installId: this.#installId,
        productVersion: this.#productVersion, resource: tailscaleFunnelOwnedResource(lease) });
    }
    const plan = planAcquireTailscaleFunnelLease(lease, observed);
    if (plan.action !== "apply") throw new Error("internal Tailscale acquire plan was not actionable");
    let commandError: unknown;
    try { await this.#runner.run(plan.arguments, input.signal); }
    catch (error) { commandError = error; }
    let verified: TailscaleFunnelLeaseState;
    try { verified = await this.inspect(lease, input.signal); }
    catch (error) {
      throw new Error("Tailscale Funnel apply could not be verified; ownership intent was preserved", { cause: commandError ?? error });
    }
    if (verified.state === "owned") {
      emitDiagnosticEvent("chatgpt_tela_ingress", "acquire_verified", {
        command_reported_failure: commandError !== undefined,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: "acquired", lease,
        detail: commandError ? "Funnel command reported failure but exact post-state is owned" : "Funnel route acquired and verified",
        mutated: true });
    }
    if (verified.state === "absent") {
      await unregisterOwnedResource({ path: this.#manifestPath, installId: this.#installId,
        productVersion: this.#productVersion, resourceId: tailscaleFunnelOwnedResource(lease).id });
      throw new Error("Tailscale Funnel apply did not create the requested route", commandError ? { cause: commandError } : undefined);
    }
    throw new Error(`Tailscale Funnel apply ended in ownership drift: ${verified.reason}; ownership intent was preserved`,
      commandError ? { cause: commandError } : undefined);
  }

  async release(
    lease: TailscaleFunnelLease,
    signal?: AbortSignal,
  ): Promise<TailscaleFunnelLeaseApplyResult> {
    const startedAt = Date.now();
    emitDiagnosticEvent("chatgpt_tela_ingress", "release_start");
    const manifest = readOwnershipManifest(this.#manifestPath);
    const manifestState = exactManifestResource(manifest, this.#installId, lease);
    if (manifestState === "drift") {
      emitDiagnosticEvent("chatgpt_tela_ingress", "release_preserved_manifest_drift", {
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: "preserved", lease, detail: "manifest identity drifted; route was preserved", mutated: false });
    }
    const observed = await this.inspect(lease, signal);
    if (manifestState === "missing") {
      emitDiagnosticEvent("chatgpt_tela_ingress", "release_unowned", {
        observed_state: observed.state,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: observed.state === "absent" ? "already-absent" : "preserved", lease,
        detail: observed.state === "absent"
          ? "route is absent and was never owned by this Tela install"
          : "route is not recorded as Tela-owned and was preserved",
        mutated: false });
    }
    if (observed.state === "drift") {
      emitDiagnosticEvent("chatgpt_tela_ingress", "release_preserved_route_drift", {
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: "preserved", lease, detail: observed.reason, mutated: false });
    }
    if (observed.state === "absent") {
      await unregisterOwnedResource({ path: this.#manifestPath, installId: this.#installId,
        productVersion: this.#productVersion, resourceId: tailscaleFunnelOwnedResource(lease).id });
      emitDiagnosticEvent("chatgpt_tela_ingress", "release_already_absent", {
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: "already-absent", lease, detail: "owned route is already absent; stale ownership record removed", mutated: true });
    }
    const plan = planReleaseTailscaleFunnelLease(lease, observed);
    if (plan.action !== "apply") throw new Error("internal Tailscale release plan was not actionable");
    let commandError: unknown;
    try { await this.#runner.run(plan.arguments, signal); }
    catch (error) { commandError = error; }
    let verified: TailscaleFunnelLeaseState;
    try { verified = await this.inspect(lease, signal); }
    catch (error) {
      throw new Error("Tailscale Funnel release could not be verified; ownership record was preserved", { cause: commandError ?? error });
    }
    if (verified.state === "absent") {
      await unregisterOwnedResource({ path: this.#manifestPath, installId: this.#installId,
        productVersion: this.#productVersion, resourceId: tailscaleFunnelOwnedResource(lease).id });
      emitDiagnosticEvent("chatgpt_tela_ingress", "release_verified", {
        command_reported_failure: commandError !== undefined,
        duration_ms: diagnosticDurationMs(startedAt),
      });
      return Object.freeze({ state: "released", lease,
        detail: commandError ? "Funnel command reported failure but exact post-state is absent" : "Funnel route released and verified",
        mutated: true });
    }
    if (verified.state === "owned") {
      throw new Error("Tailscale Funnel release did not remove the exact owned route; ownership record was preserved",
        commandError ? { cause: commandError } : undefined);
    }
    throw new Error(`Tailscale Funnel release ended in ownership drift: ${verified.reason}; ownership record was preserved`,
      commandError ? { cause: commandError } : undefined);
  }
}

export class TailscaleFunnelOwnershipObserver implements UninstallObserver {
  readonly #manager: TailscaleFunnelLeaseManager;

  constructor(manager: TailscaleFunnelLeaseManager) {
    this.#manager = manager;
  }

  async observe(resource: OwnedResource, manifest: OwnershipManifest): Promise<OwnershipObservation> {
    if (resource.kind !== "tailscale-route") return "unknown";
    if (manifest.installId !== this.#manager.installId) return "ownership-drift";
    let lease: TailscaleFunnelLease;
    try { lease = tailscaleFunnelLeaseFromResource(resource); }
    catch { return "unsafe"; }
    let state: TailscaleFunnelLeaseState;
    try { state = await this.#manager.inspect(lease); }
    catch { return "unknown"; }
    if (state.state === "owned") return "owned";
    if (state.state === "absent") return "missing";
    return "ownership-drift";
  }
}

export class TailscaleFunnelExposure implements McpExposureProvider {
  readonly kind = "tailscale-funnel";
  readonly #endpoint: HttpsMcpEndpoint;
  readonly #lease: TailscaleFunnelLease;
  readonly #manager: TailscaleFunnelLeaseManager;
  readonly #probe: (endpoint: HttpsMcpEndpoint, signal?: AbortSignal) => Promise<McpExposureHealth>;
  #acquiredThisPrepare = false;
  #verified = false;

  constructor(input: {
    readonly publicUrl: URL | string;
    readonly localTarget: URL | string;
    readonly authentication: HttpsMcpEndpointAuthentication;
    readonly manager: TailscaleFunnelLeaseManager;
    readonly probe: (endpoint: HttpsMcpEndpoint, signal?: AbortSignal) => Promise<McpExposureHealth>;
  }) {
    this.#lease = createTailscaleFunnelLease({ publicUrl: input.publicUrl, localTarget: input.localTarget });
    this.#manager = input.manager;
    this.#probe = input.probe;
    const canonicalPublicUrl = new URL(
      `https://${this.#lease.host}${this.#lease.httpsPort === 443 ? "" : `:${this.#lease.httpsPort}`}${this.#lease.publicPath}`,
    );
    this.#endpoint = Object.freeze({ kind: "https" as const, url: canonicalPublicUrl, authentication: input.authentication });
  }

  async prepare(signal?: AbortSignal): Promise<HttpsMcpEndpoint> {
    const backend = await this.#manager.backendHealth(signal);
    if (backend.state !== "ready") {
      throw new Error(tailscaleDiagnosisDetail(diagnosisCause(backend)));
    }
    const result = await this.#manager.acquire(this.#lease, signal ? { signal } : {});
    if (result.state === "preserved") throw new Error(`Tailscale Funnel route cannot be acquired: ${result.detail}`);
    this.#acquiredThisPrepare = result.state === "acquired";
    return this.#endpoint;
  }

  async verify(endpoint: McpEndpoint, signal?: AbortSignal): Promise<McpExposureHealth> {
    if (endpoint.kind !== "https" || endpoint.url.href !== this.#endpoint.url.href) {
      throw new Error("cannot verify an endpoint not owned by this Tailscale exposure");
    }
    const route = await this.#manager.inspect(this.#lease, signal);
    if (route.state !== "owned") return { ready: false, detail: route.state === "drift" ? route.reason : "Tailscale Funnel route is absent" };
    const health = await this.#probe(endpoint, signal);
    if (health.ready) this.#verified = true;
    return health;
  }

  async stop(): Promise<void> {
    if (this.#acquiredThisPrepare && !this.#verified) {
      await this.#manager.release(this.#lease);
    }
  }
}
