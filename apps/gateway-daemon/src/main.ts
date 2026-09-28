import { join } from "node:path";
import {
  DynamicChatBackend,
  DynamicCodexTurnBridge,
  probePublicMcp,
  probeUnifiedDevelopmentMcp,
  startPublicGateway,
  startGatewayService,
  startUnifiedDevelopmentGateway,
} from "@chatgpt-tela/gateway";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import {
  readServiceRuntimeDescriptor,
  removeServiceRuntimeDescriptor,
  writeServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";
import {
  SystemTailscaleCommandRunner,
  TailscaleFunnelExposure,
  TailscaleFunnelLeaseManager,
} from "@chatgpt-tela/tailscale-ingress";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Tela Gateway daemon requires ${key}`);
  return value;
}

function optionalPublicConfig(): {
  readonly abi: "stable" | "unified-development";
  readonly publicUrl: string;
  readonly localPort: number;
  readonly allowUnauthenticatedPublicEndpoint: boolean;
} | undefined {
  const publicUrl = process.env.CHATGPT_TELA_GATEWAY_PUBLIC_MCP_URL?.trim();
  const localPortRaw = process.env.CHATGPT_TELA_GATEWAY_LOCAL_MCP_PORT?.trim();
  const allowRaw = process.env.CHATGPT_TELA_GATEWAY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP?.trim();
  const abiRaw = process.env.CHATGPT_TELA_GATEWAY_PUBLIC_MCP_ABI?.trim() || "stable";
  if (!publicUrl && !localPortRaw && !allowRaw && !process.env.CHATGPT_TELA_GATEWAY_PUBLIC_MCP_ABI) return undefined;
  if (!publicUrl || !localPortRaw || allowRaw !== "1") {
    throw new Error("Tela Gateway public MCP exposure requires public URL, local port, and explicit unauthenticated opt-in");
  }
  if (abiRaw !== "stable" && abiRaw !== "unified-development") {
    throw new Error("Tela Gateway public MCP ABI is invalid");
  }
  const localPort = Number(localPortRaw);
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error("Tela Gateway public MCP local port is invalid");
  }
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Tela Gateway public URL must be credential-free HTTPS");
  }
  return Object.freeze({
    abi: abiRaw,
    publicUrl: url.href,
    localPort,
    allowUnauthenticatedPublicEndpoint: true,
  });
}

async function main(): Promise<void> {
  const installId = required("CHATGPT_TELA_INSTALL_ID");
  const productVersion = process.env.CHATGPT_TELA_PRODUCT_VERSION?.trim() || "0.0.0";
  const paths = resolveProductPaths();
  const descriptorPath = join(paths.serviceRuntime("gateway"), "descriptor.json");
  const resolveBackend = (service: "chat" | "codex") => {
    const path = join(paths.serviceRuntime(service), "descriptor.json");
    const descriptor = readServiceRuntimeDescriptor(path);
    if (!descriptor) return undefined;
    if (descriptor.installId !== installId) throw new Error(`${service} belongs to a different Tela install instance`);
    return descriptor;
  };
  const gateway = await startGatewayService({
    resolveBackend,
  });
  let publicMcp: { close(): Promise<void> } | undefined;
  try {
    const publicConfig = optionalPublicConfig();
    if (publicConfig) {
      const managedTailscale = process.env.CHATGPT_TELA_GATEWAY_MANAGE_TAILSCALE_FUNNEL === "1";
      const tailscaleManager = managedTailscale
        ? new TailscaleFunnelLeaseManager({
            runner: new SystemTailscaleCommandRunner(process.env.CHATGPT_TELA_TAILSCALE_CLI?.trim() || "tailscale"),
            manifestPath: paths.installManifest,
            installId,
            productVersion,
          })
        : undefined;
      const codex = new DynamicCodexTurnBridge(() => resolveBackend("codex"));
      const exposure = tailscaleManager
        ? (probe: typeof probePublicMcp) => (local: { readonly endpointUrl: URL }) => new TailscaleFunnelExposure({
            publicUrl: publicConfig.publicUrl,
            localTarget: local.endpointUrl,
            authentication: { kind: "none" },
            manager: tailscaleManager,
            probe: (endpoint, signal) => probe(endpoint.url, signal),
          })
        : undefined;
      publicMcp = publicConfig.abi === "stable"
        ? await startPublicGateway({
            chat: new DynamicChatBackend(() => resolveBackend("chat")),
            codex,
            config: publicConfig,
            ...(exposure ? { exposure: exposure(probePublicMcp) } : {}),
          })
        : await startUnifiedDevelopmentGateway({
            chat: new DynamicChatBackend(() => resolveBackend("chat")),
            codex,
            config: publicConfig,
            ...(exposure ? { exposure: exposure(probeUnifiedDevelopmentMcp) } : {}),
          });
    }
  } catch (error) {
    await gateway.close();
    throw error;
  }
  writeServiceRuntimeDescriptor(descriptorPath, {
    version: 1,
    service: "gateway",
    instanceId: gateway.instanceId,
    installId,
    pid: process.pid,
    endpoint: gateway.endpoint.href,
    bearerToken: gateway.bearerToken,
    startedAt: new Date().toISOString(),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        const results = await Promise.allSettled([
          ...(publicMcp ? [publicMcp.close()] : []),
          gateway.close(),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "Tela Gateway daemon shutdown was incomplete");
        removeServiceRuntimeDescriptor(descriptorPath);
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
    }
    return stopping;
  };
  let resolveSignal!: () => void;
  const signaled = new Promise<void>(resolvePromise => { resolveSignal = resolvePromise; });
  const signal = () => resolveSignal();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  await Promise.race([gateway.shutdownRequested, signaled]);
  await stop();
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
