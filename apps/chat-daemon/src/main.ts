import { diagnosticSourcePaths, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { waitForChatShutdown } from "./shutdown";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  createResolvedChatAgentDriverFactories,
  chatApprovedRootsFingerprint,
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
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";

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
        ...(ownership?.installId === installId
          ? { historicalDiagnosticPaths: diagnosticSourcePaths(paths.logsRoot) } : {}),
        agentDriverFactories,
        ...(ownership?.installId === installId ? {
          inspectNativeWork: async (request: { slot: number; threadId: string; minutes: number }) => {
            // This is an optional peer read. A missing Codex service must not
            // prevent Tela Chat from serving its own workspace capabilities.
            const current = await new LocalServiceSupervisor({ installId }).current({
              service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
            });
            if (!current) throw Error("the owned Codex service is not available for inspection");
            return new CodexServiceClient(descriptorForService(current.descriptor, "codex"))
              .inspectWork(request.slot, request.threadId, request.minutes, AbortSignal.timeout(20_000));
          },
        } : {}),
        ...(process.env.CHATGPT_TELA_WORKSPACE_FILES_EXECUTABLE
          ? { filePublisherExecutable: process.env.CHATGPT_TELA_WORKSPACE_FILES_EXECUTABLE } : {}),
        ownership: {
          installId,
          productVersion,
          manifestPath: paths.installManifest,
        },
      })
    : undefined;
  await tools?.initialize();
  const service = await startChatService({ workspacePolicyFingerprint:chatApprovedRootsFingerprint(roots), bearerToken: randomBytes(36).toString("base64url"),
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
  await waitForChatShutdown({
    shutdownRequested: service.shutdownRequested,
    signals: process,
    close: stop,
    refused() { emitDiagnosticEvent("chatgpt_tela_chat", "shutdown_incomplete", { reason_class: "local_shutdown_refused" }); },
  });
}

const running = process.argv.includes("--tela-operation-owner-v1")
  ? import("../../../packages/chat-service/src/process-owner-worker").then(module => module.runProcessOwnerWorker())
  : main();
void running.catch(error => {
  if (process.argv.includes("--tela-operation-owner-v1")) {
    console.error("Tela operation owner failed; inspect its private execution evidence.");
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
