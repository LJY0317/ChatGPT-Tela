import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createDelegatedRetention,
  restoreWorkProfiles,
  startCodexService,
  startCodexServiceHttpServer,
} from "@chatgpt-tela/codex-service";
import { approvalDelayMilliseconds, consumeSavedChatAcceptance, readProductConfigIfPresent, readProductPreferences, setWorkProfileConnection } from "@chatgpt-tela/product-config";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { prepareInstalledProfileOwnership } from "../../cli/src/profile-ownership";
import { diagnosticFailureClass, emitDiagnosticEvent, observeDaemonUncaughtFailures, reportDaemonFailure } from "@chatgpt-tela/core";
import {
  removeServiceRuntimeDescriptor,
  writeServiceRuntimeDescriptor,
} from "@chatgpt-tela/service-protocol";

import { connectDormantThreadRpc, connectStoredHistoryRpc } from "@chatgpt-tela/codex";
import { resolveDefaultDesktopInstallation } from "@chatgpt-tela/default-desktop-target";

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
  const lifecycle = new AbortController();
  const service = await startCodexService({
    signal: lifecycle.signal,
    config: {
      ...(multiProfileLauncher ? { multiProfile: { launcherCli: multiProfileLauncher } } : {}),
      ...(readProductConfigIfPresent()?.appOwnedResponses ? {
        appOwnedResponses: readProductConfigIfPresent()!.appOwnedResponses,
      } : {}),
    },
    profileRuntimeCommand: [runtimeExecutable, runtimeEntrypoint],
    environment: process.env,
    prepareProfileRuntime: async slot => {
      await prepareInstalledProfileOwnership({ slot, productPaths: paths, installId, environment: process.env });
    },
    onProfileConnectionChanged: setWorkProfileConnection,
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
  let delegatedRetention: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    delegatedRetention = createDelegatedRetention({
      directory: join(paths.serviceState("codex"), "delegated-retention"),
      acknowledgementDirectory: join(paths.serviceState("codex"), "result-acknowledgements"),
      profile(slot) {
        const route = readProductConfigIfPresent()?.appOwnedResponses?.find(row => row.slot === slot);
        if (!route) throw Error("The selected profile has no owned Desktop route");
        const installation = resolveDefaultDesktopInstallation();
        const home = route.desktopConfigPath ? dirname(route.desktopConfigPath)
          : slot === 1 ? installation.codexHome : undefined;
        if (!home) throw Error("The selected profile has no configured Desktop history location");
        return {
          scope: JSON.stringify([installId, slot, realpathSync(home)]),
          connect: (threadId, lifecycleAccess) => (lifecycleAccess ? connectDormantThreadRpc : connectStoredHistoryRpc)({
            executable: installation.codexExecutable, codexHome: home, threadId, signal: lifecycle.signal,
          }),
        };
      },
    });
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_start_failed", { failure_class: diagnosticFailureClass(error) });
  }
  let restoring = true;
  const http = await startCodexServiceHttpServer({
    service,
    startupComplete: () => !restoring,
    ...(delegatedRetention ? { delegatedRetention } : {}),
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
    .finally(() => { restoring = false; });
  const retentionStartup = restoration.then(() => delegatedRetention?.reconcile())
    .catch(error => emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_reconcile_failed", { failure_class: diagnosticFailureClass(error) }));

  let stopping: Promise<void> | undefined;
  const stop = () => {
    lifecycle.abort();
    if (!stopping) {
      stopping = (async () => {
        const results = await Promise.allSettled([http.close(), restoration.then(() => service.close()),
          retentionStartup.then(() => delegatedRetention?.close())]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "Tela Codex daemon shutdown was incomplete");
        removeServiceRuntimeDescriptor(descriptorPath, { instanceId: service.instanceId, pid: process.pid, installId });
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

observeDaemonUncaughtFailures("codex");
void main().catch(error => {
  reportDaemonFailure("codex", error);
  console.error(error);
  process.exitCode = 1;
});
