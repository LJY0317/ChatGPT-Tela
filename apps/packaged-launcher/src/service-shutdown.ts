import { join } from "node:path";
import { PackagedServiceShutdownNotStartedError, type ProductPaths, type TelaServiceId } from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { LocalServiceClient, ServiceShutdownNotStartedError } from "@chatgpt-tela/service-protocol/client";

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
  return Object.assign(shutdown, {
    async ready(service: TelaServiceId, timeoutMs: number): Promise<void> {
      await supervisor.waitUntilReady({ service, timeoutMs,
        descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
    },
    async prepare(service: TelaServiceId): Promise<void> {
      const current = await supervisor.current({ service, descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
      if (!current || current.status.state !== "ready") throw new Error(`${service} runtime is not ready for maintenance`);
      // This potentially scans durable work; request it only for maintenance, never routine health polls.
      const status = await new LocalServiceClient(current.descriptor).status(AbortSignal.timeout(1_500), { shutdownReadiness: true });
      if (status.state !== "ready" || status.shutdownReadiness === "blocked") throw new PackagedServiceShutdownNotStartedError(service);
    },
  });
}
