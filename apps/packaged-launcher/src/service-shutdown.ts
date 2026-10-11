import { join } from "node:path";
import type { ProductPaths, TelaServiceId } from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";

/** A running OS registration must have authenticated runtime authority before stopping it.
 * Missing/unreachable descriptors never authorize platform kill/stop fallback.
 */
export function ownedServiceShutdown(installId: string, paths: ProductPaths) {
  const supervisor = new LocalServiceSupervisor({ installId });
  return async (service: TelaServiceId): Promise<void> => {
    const stopped = await supervisor.shutdown({ service, descriptorPath: join(paths.serviceRuntime(service), "descriptor.json") });
    if (!stopped) throw new Error(`running ${service} service has no authenticated runtime; preserve it and inspect its state`);
  };
}
