import type { BackendServiceId, ServiceStatus } from "@chatgpt-tela/service-protocol";

export interface GatewayBackendClient {
  readonly service: BackendServiceId;
  status(signal?: AbortSignal): Promise<ServiceStatus>;
  close(): Promise<void>;
}

export interface GatewayBackendStatus {
  readonly service: BackendServiceId;
  readonly availability: "ready" | "degraded" | "unavailable";
  readonly instanceId?: string;
  readonly detail?: string;
}

export class BackendUnavailableError extends Error {
  readonly service: BackendServiceId;

  constructor(service: BackendServiceId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendUnavailableError";
    this.service = service;
  }
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { readonly signal: AbortSignal; close(): void } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("backend timeout must be a positive integer");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("backend request timed out")), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export class IndependentBackendRouter {
  readonly #clients = new Map<BackendServiceId, GatewayBackendClient>();
  readonly #timeoutMs: number;

  constructor(options: { readonly timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 3_000;
  }

  mount(client: GatewayBackendClient): () => void {
    if (this.#clients.has(client.service)) throw new Error(`backend is already mounted: ${client.service}`);
    this.#clients.set(client.service, client);
    let mounted = true;
    return () => {
      if (!mounted) return;
      mounted = false;
      if (this.#clients.get(client.service) === client) this.#clients.delete(client.service);
    };
  }

  async status(service: BackendServiceId, signal?: AbortSignal): Promise<GatewayBackendStatus> {
    const client = this.#clients.get(service);
    if (!client) return Object.freeze({ service, availability: "unavailable", detail: "backend is not mounted" });
    const deadline = timeoutSignal(this.#timeoutMs, signal);
    try {
      const status = await client.status(deadline.signal);
      if (status.service !== service) throw new Error("backend returned a different service identity");
      return Object.freeze({
        service,
        availability: status.state === "ready" ? "ready" : "degraded",
        instanceId: status.instanceId,
        ...(status.detail ? { detail: status.detail } : {}),
      });
    } catch (error) {
      return Object.freeze({
        service,
        availability: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      deadline.close();
    }
  }

  async statuses(signal?: AbortSignal): Promise<readonly GatewayBackendStatus[]> {
    return Object.freeze(await Promise.all([
      this.status("chat", signal),
      this.status("codex", signal),
    ]));
  }

  async withBackend<T>(
    service: BackendServiceId,
    operation: (client: GatewayBackendClient, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = this.#clients.get(service);
    if (!client) throw new BackendUnavailableError(service, `${service} backend is not mounted`);
    const deadline = timeoutSignal(this.#timeoutMs, signal);
    try {
      return await operation(client, deadline.signal);
    } catch (error) {
      throw new BackendUnavailableError(service, `${service} backend request failed`, { cause: error });
    } finally {
      deadline.close();
    }
  }

  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    const results = await Promise.allSettled(clients.map(client => client.close()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "one or more gateway backends failed to close");
  }
}
