import { join } from "node:path";
import {
  restoreWorkProfiles,
  startCodexService,
  startCodexServiceHttpServer,
  createCodexWorkInspector,
} from "@chatgpt-tela/codex-service";
import { connectCodexAppServerWebSocket } from "@chatgpt-tela/codex";
import { createLocalNativeAccountProof, type TrustedNativeProfileSession } from "../../../packages/codex-service/src/cross-profile-account-proof";
import { startWebDelegationRetention } from "../../../packages/codex-service/src/web-delegation-retention";
import { WebDelegationStore } from "../../../packages/codex-service/src/web-delegation";
import { approvalDelayMilliseconds, consumeSavedChatAcceptance, readProductPreferences, setWorkProfileConnection, webDelegationLimit } from "@chatgpt-tela/product-config";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { diagnosticFailureClass, emitDiagnosticEvent } from "@chatgpt-tela/core";
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
  if (process.argv.length > 2) throw new Error("Tela Codex daemon accepts no command-line arguments");
  const multiProfileLauncher = process.env.CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI?.trim();
  const runtimeExecutable = required("CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE");
  const runtimeEntrypoint = required("CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT");
  const installId = required("CHATGPT_TELA_INSTALL_ID");
  const paths = resolveProductPaths();
  const descriptorPath = join(paths.serviceRuntime("codex"), "descriptor.json");
  const delegationStore = new WebDelegationStore(join(paths.serviceState("codex"), "web-delegations"),
    slot => webDelegationLimit(readProductPreferences(), slot));
  const lifecycle = new AbortController();
  let retention: ReturnType<typeof startWebDelegationRetention> | undefined;
  const service = await startCodexService({
    signal: lifecycle.signal,
    config: multiProfileLauncher
      ? { multiProfile: { launcherCli: multiProfileLauncher } }
      : {},
    profileRuntimeCommand: [runtimeExecutable, runtimeEntrypoint],
    environment: process.env,
    webDelegationCapacity: slot => delegationStore.capacity(slot),
    onProfileConnectionChanged: (...args) => { setWorkProfileConnection(...args); retention?.wake(); },
    profileRuntimeEnvironment: slot => {
      const preferences = readProductPreferences();
      return {
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: preferences.approvalAutomation,
        CHATGPT_TELA_APPROVAL_DELAY_MS: String(approvalDelayMilliseconds(preferences.approvalDelay)),
        // Override an ambient setting. Only the exact local 15-minute owner
        // acceptance lease can enable saved Chat for the next profile start.
        CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: consumeSavedChatAcceptance(slot)
          ? String(slot) : undefined,
      };
    },
  });
  let restoring = true;
  const http = await startCodexServiceHttpServer({
    service,
    startupComplete: () => !restoring,
    inspectWork: createCodexWorkInspector({ service, logsRoot: paths.logsRoot }),
    delegationCapacity: slot => delegationStore.capacity(slot),
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
  const restoration = restoreWorkProfiles(service, readProductPreferences().workProfileConnections ?? [], lifecycle.signal)
    .catch(error => emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_failed", { failure_class: diagnosticFailureClass(error) }))
    .finally(() => { restoring = false; retention?.wake(); });

  const ownedSession = async (slot: number): Promise<TrustedNativeProfileSession> => {
    const profile = (await service.profiles()).find(row => row.slot === slot);
    if (!profile || profile.controlState !== "running" || profile.targetSessionState !== "ready"
      || !profile.childProcessId || !profile.responsesRouteFingerprint) throw Error("Web cleanup profile unavailable");
    const terminal = await service.terminalSession(slot);
    return { slot, runtimeProcessId: profile.childProcessId,
      responsesRouteFingerprint: profile.responsesRouteFingerprint, terminalEndpoint: terminal.endpoint };
  };
  const proof = createLocalNativeAccountProof({ resolveOwnedSession: ownedSession, fingerprintKey: delegationStore.fingerprintKey });
  retention = startWebDelegationRetention({
    store: delegationStore,
    owner: async slot => ({ binding: await proof(slot), session: await ownedSession(slot) }),
    connect: endpoint => connectCodexAppServerWebSocket(endpoint, { signal: lifecycle.signal }),
  }, lifecycle.signal);

  let stopping: Promise<void> | undefined;
  const stop = () => {
    lifecycle.abort();
    if (!stopping) {
      stopping = (async () => {
        await retention?.close();
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
