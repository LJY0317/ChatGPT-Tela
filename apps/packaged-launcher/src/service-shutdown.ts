import { join } from "node:path";
import { PACKAGED_TRANSITION_TIMEOUT_MS, PackagedServiceShutdownNotStartedError, type ProductPaths, type TelaServiceId } from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { ChatServiceClient, CodexServiceClient, descriptorForService, ServiceShutdownNotStartedError } from "@chatgpt-tela/service-protocol/client";
import { interruptLoadedAppServerTurns } from "@chatgpt-tela/codex";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";

/** Explicit user consent only. Reuse task cancellation; never kill a service or delete its work. */
export async function interruptOwnedWork(installId: string, paths: ProductPaths, running: readonly TelaServiceId[]) {
  const supervisor = new LocalServiceSupervisor({ installId });
  for (const service of running.filter(id => id === "codex" || id === "chat")) {
    const current = await supervisor.current({ service, descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
    if (!current || current.status.state !== "ready") throw Error(`${service} is unavailable for task cancellation`);
    let count = 0;
    if (service === "codex") {
      const client = new CodexServiceClient(descriptorForService(current.descriptor, "codex"));
      for (const profile of await client.profiles()) {
        if (profile.controlState !== "running") continue;
        const session = await client.terminalSession(profile.slot);
        count += await interruptLoadedAppServerTurns(session.endpoint, { signal: AbortSignal.timeout(PACKAGED_TRANSITION_TIMEOUT_MS) });
      }
    } else {
      const client = new ChatServiceClient(descriptorForService(current.descriptor, "chat"));
      for (const process of await client.maintenanceProcesses()) {
        await client.call("cancel_process", { workspace_id: process.workspaceId, operation_id: process.operationId });
        count++;
      }
    }
    emitDiagnosticEvent("chatgpt_tela_update", "work_interruption_requested", { service, count });
  }
}

/** A running OS registration must have authenticated runtime authority before stopping it.
 * Missing/unreachable descriptors never authorize platform kill/stop fallback.
 */
export function ownedServiceShutdown(installId: string, paths: ProductPaths) {
  const supervisor = new LocalServiceSupervisor({ installId });
  const shutdown = async (service: TelaServiceId): Promise<void> => {
    try {
      const stopped = await supervisor.shutdown({ service, descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
      if (!stopped) throw new Error(`running ${service} service has no authenticated runtime; preserve it and inspect its state`);
    } catch (error) {
      if (error instanceof ServiceShutdownNotStartedError) throw new PackagedServiceShutdownNotStartedError(service, { cause: error });
      throw error;
    }
  };
  const prepare = async (service: TelaServiceId): Promise<void> => {
    const current = await supervisor.current({ service, descriptorPath: join(paths.serviceRuntime(service), "descriptor.json"),
      shutdownReadiness: true, requestTimeoutMs: PACKAGED_TRANSITION_TIMEOUT_MS });
    if (!current || current.status.state !== "ready") throw new Error(`${service} runtime is not ready for maintenance`);
    if (current.status.shutdownReadiness === "blocked") throw new PackagedServiceShutdownNotStartedError(service);
    // The owner repeats admission on actual shutdown; work can begin after preflight.
  };
  return Object.assign(shutdown, {
    async ready(service: TelaServiceId, timeoutMs: number): Promise<void> {
      await supervisor.waitUntilReady({ service, timeoutMs,
        descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
    },
    async wait(service: TelaServiceId): Promise<void> {
      const current = await supervisor.current({ service, descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
      if (!current || current.status.state !== "ready") throw new Error(`${service} runtime is not ready for maintenance`);
      if (service === "codex") await new CodexServiceClient(descriptorForService(current.descriptor, "codex")).waitForShutdownReadiness();
      else if (service === "chat") await new ChatServiceClient(descriptorForService(current.descriptor, "chat")).waitForShutdownReadiness();
      else await prepare(service);
    },
    prepare,
  });
}
