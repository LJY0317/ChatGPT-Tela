import { ownedServiceShutdown } from "./service-shutdown";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  PackagedPlatformServiceController, ServiceRegistrationManager, resolveProductPaths, withPackagedTransitionOwner,
  type ProductPathOptions, type ServiceRegistrationCommandRunner, type PackagedServiceControlIdentity, type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { verifyInstalledPackage } from "./runtime";

/** UI and CLI service controls share receipt, registration and platform lifecycle proof. */
async function runPackagedServicesOwned(args: readonly string[], input: {
  readonly payloadRoot: string;
  readonly launcherExecutablePath?: string;
  readonly pathOptions?: ProductPathOptions;
  readonly runner?: ServiceRegistrationCommandRunner;
  readonly waitUntilReady?: (service: TelaServiceId, timeoutMs: number) => Promise<void>;
  readonly shutdownService?: (service: TelaServiceId) => Promise<void>;
}) {
  const action = args[1];
  const chatRestart = args.length === 3 && action === "restart" && args[2] === "chat";
  if (args[0] !== "services" || (!chatRestart && (args.length !== 2 || (action !== "start" && action !== "stop")))) {
    throw new Error("usage: services <start|stop> | services restart chat");
  }
  const { ownership } = verifyInstalledPackage(input);
  const platform = input.pathOptions?.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error("installed service control is unavailable on this platform");
  }
  const blueprint: PackagedServiceControlIdentity = {
    platform,
    services: (chatRestart ? ["chat"] as const : ["gateway", "chat", "codex"] as const).map(service => {
      const resource = ownership.resources.find(resource => resource.id === `${service}-service`);
      if (resource?.kind !== "service-registration" || resource.owner !== service) {
        throw new Error(`installed ${service} registration is missing; services preserved`);
      }
      return { service, resource };
    }),
  };
  const manager = new ServiceRegistrationManager({
    ...(input.runner ? { runner: input.runner } : {}), platform: blueprint.platform,
  });
  // Prove all registrations before the first mutation; a foreign registration
  // must not turn a three-service request into a partially applied operation.
  for (const entry of blueprint.services) {
    if (await manager.observe(entry.resource, ownership) !== "owned") {
      throw new Error(`installed ${entry.service} registration ownership could not be verified; services preserved`);
    }
  }
  const shutdown = ownedServiceShutdown(ownership.installId, resolveProductPaths(input.pathOptions));
  const controller = new PackagedPlatformServiceController({
    blueprint, shutdownService: input.shutdownService ?? shutdown,
    prepareShutdownService: input.shutdownService ? undefined : shutdown.prepare,
    waitUntilReady: input.waitUntilReady ?? (input.shutdownService ? undefined : shutdown.ready),
    ...(input.runner ? { runner: input.runner } : {}),
  });
  const services: Array<{ service: "gateway" | "chat" | "codex"; state: "running" | "stopped" | "failed" }> = [];
  const stopped: TelaServiceId[] = [], restoredServices: TelaServiceId[] = [], restoreFailures: TelaServiceId[] = [];
  const order = chatRestart ? ["chat"] as const : action === "start" ? ["chat", "codex", "gateway"] as const : ["gateway", "codex", "chat"] as const;
  if (action !== "start") await controller.prepare(order);
  for (const service of order) {
    try {
      // Re-prove at each mutation as well as during preflight.
      const resource = blueprint.services.find(entry => entry.service === service)!.resource;
      if (await manager.observe(resource, ownership) !== "owned") throw new Error("registration changed");
      const wasRunning = action === "stop" && await controller.inspect(service) === "running";
      if (chatRestart) { await controller.quiesce(service); await controller.resume(service); }
      else if (action === "start") await controller.resume(service);
      else await controller.quiesce(service);
      if (wasRunning) stopped.push(service);
      services.push({ service, state: action === "start" || chatRestart ? "running" : "stopped" });
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_service", "service_control_failed", {
        service, phase: action, ...diagnosticFailureFields(error),
      });
      services.push({ service, state: "failed" });
      if (action === "stop") {
        // A refused/uncertain owner stays untouched. Restore only peers this
        // request successfully stopped; never close later independent peers.
        for (const peer of stopped.reverse()) {
          try {
            await controller.resume(peer); restoredServices.push(peer);
            services.find(row => row.service === peer)!.state = "running";
          }
          catch (failure) {
            restoreFailures.push(peer);
            services.find(row => row.service === peer)!.state = "failed";
            emitDiagnosticEvent("chatgpt_tela_service", "service_restore_failed", {
              service: peer, phase: "restore", ...diagnosticFailureFields(failure),
            });
          }
        }
        break;
      }
    }
  }
  return { action, success: services.every(service => service.state !== "failed"), services,
    ...(action === "stop" ? { restoredServices, restoreFailures } : {}) };
}

export async function runPackagedServicesCommand(args: Parameters<typeof runPackagedServicesOwned>[0], input: Parameters<typeof runPackagedServicesOwned>[1]): ReturnType<typeof runPackagedServicesOwned> {
  const { ownership } = verifyInstalledPackage(input);
  const paths = resolveProductPaths(input.pathOptions);
  return withPackagedTransitionOwner({ paths, installId: ownership.installId }, () => runPackagedServicesOwned(args, input));
}
