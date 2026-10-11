import { join } from "node:path";
import {
  DynamicChatBackend,
  DynamicCodexTurnBridge,
  probePublicMcp,
  probeUnifiedDevelopmentMcp,
  startPublicGateway,
  startGatewayService,
  startUnifiedDevelopmentGateway,
  type GatewayIngressStatus,
} from "@chatgpt-tela/gateway";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import {
  readServiceRuntimeDescriptor,
  removeServiceRuntimeDescriptor,
  writeServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";
import {
  createTailscaleFunnelLease,
  SystemTailscaleCommandRunner,
  tailscaleDiagnosisDetail,
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
  const publicConfig = optionalPublicConfig();
  const managedTailscale = Boolean(publicConfig)
    && process.env.CHATGPT_TELA_GATEWAY_MANAGE_TAILSCALE_FUNNEL === "1";
  const tailscaleManager = managedTailscale
    ? new TailscaleFunnelLeaseManager({
        runner: new SystemTailscaleCommandRunner(process.env.CHATGPT_TELA_TAILSCALE_CLI?.trim() || "tailscale"),
        manifestPath: paths.installManifest,
        installId,
        productVersion,
      })
    : undefined;
  const tailscaleLease = publicConfig && tailscaleManager
    ? createTailscaleFunnelLease({
        publicUrl: publicConfig.publicUrl,
        localTarget: `http://127.0.0.1:${publicConfig.localPort}/mcp`,
      })
    : undefined;
  const publicProbe = publicConfig?.abi === "unified-development"
    ? probeUnifiedDevelopmentMcp
    : probePublicMcp;
  const resolveIngressStatus = publicConfig
    ? async (signal?: AbortSignal): Promise<GatewayIngressStatus> => {
        if (tailscaleManager && tailscaleLease) {
          const diagnosis = await tailscaleManager.diagnose(tailscaleLease, signal);
          if (diagnosis.availability !== "ready") {
            return Object.freeze({
              contractVersion: 1 as const,
              availability: "unavailable" as const,
              cause: diagnosis.cause,
              detail: tailscaleDiagnosisDetail(diagnosis.cause),
              exposureKind: "tailscale-funnel",
            });
          }
        }

        const local = await publicProbe(
          new URL(`http://127.0.0.1:${publicConfig.localPort}/mcp`),
          signal,
        );
        if (!local.ready) {
          return Object.freeze({
            contractVersion: 1 as const,
            availability: "unavailable" as const,
            cause: "local-mcp-unreachable",
            detail: "The local Tela Gateway MCP listener is not reachable",
            exposureKind: tailscaleManager ? "tailscale-funnel" : "existing-https",
          });
        }
        const publicHealth = await publicProbe(new URL(publicConfig.publicUrl), signal);
        return publicHealth.ready
          ? Object.freeze({
              contractVersion: 1 as const,
              availability: "ready" as const,
              cause: "ready",
              detail: "The public ChatGPT Tela MCP endpoint is reachable",
              exposureKind: tailscaleManager ? "tailscale-funnel" : "existing-https",
            })
          : Object.freeze({
              contractVersion: 1 as const,
              availability: "unavailable" as const,
              cause: "public-mcp-unreachable",
              detail: "Local MCP is ready, but the configured public MCP endpoint is not reachable",
              exposureKind: tailscaleManager ? "tailscale-funnel" : "existing-https",
            });
      }
    : undefined;
  const resolveBackend = (service: "chat" | "codex") => {
    const path = join(paths.serviceRuntime(service), "descriptor.json");
    const descriptor = readServiceRuntimeDescriptor(path);
    if (!descriptor) return undefined;
    if (descriptor.installId !== installId) throw new Error(`${service} belongs to a different Tela install instance`);
    return descriptor;
  };
  const gateway = await startGatewayService({
    resolveBackend,
    ...(resolveIngressStatus ? { resolveIngressStatus } : {}),
  });
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

  let publicMcp: { close(): Promise<void> } | undefined;
  const ingressAbort = new AbortController();
  const waitForRetry = (milliseconds: number): Promise<void> => new Promise(resolvePromise => {
    if (ingressAbort.signal.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    ingressAbort.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
  const startPublicMcp = async (): Promise<{ close(): Promise<void> } | undefined> => {
    if (!publicConfig) return undefined;
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
    return publicConfig.abi === "stable"
      ? startPublicGateway({
          chat: new DynamicChatBackend(() => resolveBackend("chat")),
          codex,
          config: publicConfig,
          ...(exposure ? { exposure: exposure(probePublicMcp) } : {}),
          signal: ingressAbort.signal,
        })
      : startUnifiedDevelopmentGateway({
          chat: new DynamicChatBackend(() => resolveBackend("chat")),
          codex,
          config: publicConfig,
          ...(exposure ? { exposure: exposure(probeUnifiedDevelopmentMcp) } : {}),
          signal: ingressAbort.signal,
        });
  };
  const ingressLoop = (async () => {
    while (publicConfig && !ingressAbort.signal.aborted && !publicMcp) {
      try {
        publicMcp = await startPublicMcp();
      } catch {
        if (ingressAbort.signal.aborted) break;
        await waitForRetry(5_000);
      }
    }
  })();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        ingressAbort.abort();
        await ingressLoop.catch(() => {});
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
