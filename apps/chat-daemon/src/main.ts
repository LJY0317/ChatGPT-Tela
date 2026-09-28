import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  createResolvedChatAgentDriverFactories,
  createChatToolRuntime,
  readChatAgentProvidersConfig,
  readChatApprovedRootsConfig,
  startChatService,
} from "@chatgpt-tela/chat-service";
import {
  CredentialOwnershipManager,
  createPlatformCredentialStore,
} from "@chatgpt-tela/credential-store";
import {
  readOwnershipManifest,
  resolveProductPaths,
} from "@chatgpt-tela/product-lifecycle";
import {
  removeServiceRuntimeDescriptor,
  writeServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Tela Chat daemon requires ${key}`);
  return value;
}

async function main(): Promise<void> {
  const installId = required("CHATGPT_TELA_INSTALL_ID");
  const productVersion = process.env.CHATGPT_TELA_PRODUCT_VERSION?.trim() || "0.0.0";
  const paths = resolveProductPaths();
  const descriptorPath = join(paths.serviceRuntime("chat"), "descriptor.json");
  const roots = readChatApprovedRootsConfig(join(paths.configRoot, "chat", "approved-roots-v1.json"));
  const agentProviders = readChatAgentProvidersConfig(join(paths.configRoot, "chat", "agent-providers-v1.json"));
  const ownership = readOwnershipManifest(paths.installManifest);
  const credentialStore = createPlatformCredentialStore({ stateRoot: paths.stateRoot });
  const credentialResolver = ownership?.installId === installId
    ? new CredentialOwnershipManager({
        store: credentialStore,
        manifestPath: paths.installManifest,
        installId,
        productVersion: ownership.productVersion,
      })
    : undefined;
  const agentDriverFactories = await createResolvedChatAgentDriverFactories(agentProviders, {
    environment: process.env,
    ...(credentialResolver ? { credentials: credentialResolver } : {}),
  });
  const tools = roots.roots.length > 0
    ? createChatToolRuntime({
        allowedRoots: roots.roots,
        stateRoot: paths.serviceState("chat"),
        agentDriverFactories,
        ownership: {
          installId,
          productVersion,
          manifestPath: paths.installManifest,
        },
      })
    : undefined;
  await tools?.initialize();
  const service = await startChatService({ bearerToken: randomBytes(36).toString("base64url"),
    ...(tools ? { tools } : {}) });
  writeServiceRuntimeDescriptor(descriptorPath, {
    version: 1,
    service: "chat",
    instanceId: service.instanceId,
    installId,
    pid: process.pid,
    endpoint: service.endpoint.href,
    bearerToken: service.bearerToken,
    startedAt: new Date().toISOString(),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        await service.close();
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
  await Promise.race([service.shutdownRequested, signaled]);
  await stop();
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
