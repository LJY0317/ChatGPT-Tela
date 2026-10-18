import { join } from "node:path";
import {
  restorableWorkProfiles,
  startCodexService,
  startCodexServiceHttpServer,
  createCodexWorkInspector,
} from "@chatgpt-tela/codex-service";
import { WebDelegationStore } from "../../../packages/codex-service/src/web-delegation";
import { consumeSavedChatAcceptance, readProductPreferences, setWorkProfileConnection } from "@chatgpt-tela/product-config";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import {
  removeServiceRuntimeDescriptor,
  writeServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Tela Codex daemon requires ${key}`);
  return value;
}

async function main(): Promise<void> {
  const multiProfileLauncher = process.env.CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI?.trim();
  const runtimeExecutable = required("CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE");
  const runtimeEntrypoint = required("CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT");
  const installId = required("CHATGPT_TELA_INSTALL_ID");
  const paths = resolveProductPaths();
  const descriptorPath = join(paths.serviceRuntime("codex"), "descriptor.json");
  const lifecycle = new AbortController();
  const service = await startCodexService({
    signal: lifecycle.signal,
    config: multiProfileLauncher
      ? { multiProfile: { launcherCli: multiProfileLauncher } }
      : {},
    profileRuntimeCommand: [runtimeExecutable, runtimeEntrypoint],
    environment: process.env,
    onProfileConnectionChanged: setWorkProfileConnection,
    profileRuntimeEnvironment: slot => {
      const preferences = readProductPreferences();
      return {
        // Override an ambient setting. Only the exact local 15-minute owner
        // acceptance lease can enable saved Chat for the next profile start.
        CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: consumeSavedChatAcceptance(slot)
          ? String(slot) : undefined,
      };
    },
  });
  const delegationStore = new WebDelegationStore(join(paths.serviceState("codex"), "web-delegations"));
  const http = await startCodexServiceHttpServer({
    service,
    inspectWork: createCodexWorkInspector({ service, logsRoot: paths.logsRoot }),
    delegationCapacity: (slot, mode) => delegationStore.capacity(slot, mode),
  });
  writeServiceRuntimeDescriptor(descriptorPath, {
    version: 1,
    service: "codex",
    instanceId: service.instanceId,
    installId,
    pid: process.pid,
    endpoint: http.endpoint.href,
    bearerToken: http.bearerToken,
    startedAt: new Date().toISOString(),
  });

  // One startup attempt, no polling and no interruption of already-running apps.
  const restoration = (async () => {
    const identities = readProductPreferences().workProfileConnections ?? [];
    if (identities.length === 0) return;
    for (const slot of restorableWorkProfiles(await service.profiles(), identities)) {
      if (lifecycle.signal.aborted) return;
      // Recheck immediately before starting; the app may have opened during discovery.
      if (!restorableWorkProfiles(await service.profiles(), identities).includes(slot)) continue;
      try { await service.startProfile(slot, { requireStopped: true }); }
      catch { console.error("Tela Work saved connection needs attention."); }
    }
  })().catch(() => console.error("Tela Work connection restoration needs attention."));

  let stopping: Promise<void> | undefined;
  const stop = () => {
    lifecycle.abort();
    if (!stopping) {
      stopping = (async () => {
        const results = await Promise.allSettled([http.close(), restoration.then(() => service.close())]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "Tela Codex daemon shutdown was incomplete");
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
  const signal = () => { lifecycle.abort(); resolveSignal(); };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  await Promise.race([http.shutdownRequested, signaled]);
  await stop();
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
