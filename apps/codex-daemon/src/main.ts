import { readFileSync, realpathSync } from "node:fs";
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

import { connectDelegatedTitleRpc, connectDormantThreadRpc, connectStoredHistoryRpc, submitOfficialWebDelegation, submitOfficialWebFollowUp } from "@chatgpt-tela/codex";
import { FileNativeVisiblePrefixStageJournal, readChatGptTelaAccountBinding, resolveChatGptTelaBrowserProfile } from "@chatgpt-tela/development-runtime";
import { resolveDefaultDesktopInstallation } from "@chatgpt-tela/default-desktop-target";
import { createHash } from "node:crypto";

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
  let delegatedRetention: ReturnType<typeof createDelegatedRetention> | undefined;
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
    onProfileConnectionChanged: (targetId, enabled) => {
      setWorkProfileConnection(targetId, enabled);
      void delegatedRetention?.reconcile().catch(error => emitDiagnosticEvent("chatgpt_tela_codex",
        "delegation_retention_reconcile_failed", { failure_class: diagnosticFailureClass(error) }));
    },
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
        const profileRoot = process.env.CHATGPT_TELA_PROFILE_ROOT?.trim();
        const browserProfile = resolveChatGptTelaBrowserProfile({ slot, ...(profileRoot ? { profileRoot } : {}) });
        const account = () => readChatGptTelaAccountBinding(browserProfile)?.accountFingerprint;
        return {
          webAccountFingerprint: account,
          async readSavedWebAnswer(accountFingerprint, threadId, turnId) {
            if (account() !== accountFingerprint) return undefined;
            const text = await FileNativeVisiblePrefixStageJournal.forProfile(browserProfile, accountFingerprint)
              .readSavedDispatchAnswer({ profileSlot: slot, accountFingerprint, threadId, turnId });
            return account() === accountFingerprint ? text : undefined;
          },
          scope: JSON.stringify([installId, slot, realpathSync(home)]),
          connect: (threadId, lifecycleAccess, delegatedTitle) => (lifecycleAccess
            ? connectDormantThreadRpc : delegatedTitle ? connectDelegatedTitleRpc : connectStoredHistoryRpc)({
            executable: installation.codexExecutable, codexHome: home, threadId, signal: lifecycle.signal,
          }),
        };
      },
    });
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_codex", "delegation_retention_start_failed", { failure_class: diagnosticFailureClass(error) });
  }
  const activeDispatches = new Set<Promise<unknown>>();
  const activeWebTurns = new Map<Promise<unknown>, { slot: number; interrupt: () => Promise<unknown> | undefined }>();
  const officialWebProfile = (slot: number) => {
    const route = readProductConfigIfPresent()?.appOwnedResponses?.find(row => row.slot === slot);
    if (!route) throw Error("The destination has no registered Tela Web route");
    const installation = resolveDefaultDesktopInstallation();
    const configPath = route.desktopConfigPath ?? (slot === 1
      ? join(installation.codexHome, "config.toml") : undefined);
    if (!configPath) throw Error("The destination has no configured Desktop history location");
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if ((config.model_provider ?? "openai") !== "openai"
      || config.openai_base_url !== `http://127.0.0.1:${route.port}/${route.capability}/v1`) {
      throw Error("The destination profile is not using its registered OpenAI Web route");
    }
    return { executable: installation.codexExecutable, codexHome: dirname(configPath) };
  };
  const submitWebDelegation = async (request: {
    slot: number; title: string; prompt: string; cwd: string;
    model?: string; coordinatorThreadId?: string; wait?: boolean;
  }) => {
    const task = submitOfficialWebDelegation({
      ...officialWebProfile(request.slot),
      cwd: request.cwd, ...(request.model ? { model: request.model } : {}),
      title: `[Tela Agent] ${request.title}`, prompt: request.prompt,
      // The first dispatch is already registered before turn/start. The
      // accept-turn contract is for later turns of an enrolled conversation.
      ...(request.coordinatorThreadId ? { beforeSubmit: async threadId => {
        if (!delegatedRetention) throw Error("Delegation retention is unavailable");
        await delegatedRetention.registerDispatch(request.slot, request.coordinatorThreadId!, threadId,
          createHash("sha256").update(request.prompt).digest("hex"));
      } } : {}),
    });
    activeDispatches.add(task.finished);
    activeWebTurns.set(task.finished, { slot: request.slot, interrupt: task.interrupt });
    void task.finished.catch(error => emitDiagnosticEvent("chatgpt_tela_codex", "web_delegation_finished_with_error", {
      failure_class: diagnosticFailureClass(error),
    })).finally(() => { activeDispatches.delete(task.finished); activeWebTurns.delete(task.finished); });
    const receipt = await task.accepted;
    return { slot: request.slot, ...(request.wait ? await task.finished : receipt) };
  };

  const activeFollowUps = new Map<string, Promise<unknown>>();
  const submitWebFollowUp = (request: {
    slot: number; coordinatorThreadId: string; threadId: string; prompt: string; wait?: boolean;
  }) => {
    const key = JSON.stringify([request.slot, request.threadId]);
    if (activeFollowUps.has(key)) throw Error("A follow-up is already running for this Web chat");
    const accepted = Promise.withResolvers<unknown>();
    const completed = (async () => {
      try {
        if (!delegatedRetention) throw Error("Delegation retention is unavailable");
        const registration = await delegatedRetention.resolveFollowUp(
          request.slot, request.coordinatorThreadId, request.threadId);
        const task = submitOfficialWebFollowUp({
          threadId: request.threadId, resolveRegistration: async () => registration,
          profileScope: registration.profileScope, accountFingerprint: registration.accountFingerprint,
          ...officialWebProfile(request.slot), prompt: request.prompt,
          onAccepted: async (receipt, started) => {
            await delegatedRetention.acceptTurn(
              request.slot, request.coordinatorThreadId, request.threadId, receipt.turnId, started);
          },
        });
        activeWebTurns.set(task.finished, { slot: request.slot, interrupt: task.interrupt });
        void task.finished.then(() => activeWebTurns.delete(task.finished),
          () => activeWebTurns.delete(task.finished));
        void task.accepted.then(receipt => accepted.resolve({ slot: request.slot, ...receipt }), accepted.reject);
        return await task.finished;
      } catch (error) {
        accepted.reject(error);
        throw error;
      }
    })();
    activeFollowUps.set(key, completed);
    activeDispatches.add(completed);
    void completed.catch(error => emitDiagnosticEvent("chatgpt_tela_codex", "web_follow_up_finished_with_error", {
      failure_class: diagnosticFailureClass(error),
    })).finally(() => { activeFollowUps.delete(key); activeDispatches.delete(completed); });
    return request.wait ? Promise.all([accepted.promise, completed]).then(([, result]) => ({
      slot: request.slot, ...(result as object),
    })) : accepted.promise;
  };
  let restoring = true;
  const http = await startCodexServiceHttpServer({
    service,
    startupComplete: () => !restoring,
    ...(delegatedRetention ? { delegatedRetention } : {}),
    submitWebDelegation,
    interruptWebDelegations: async slot => {
      let count = 0;
      for (const turn of activeWebTurns.values()) {
        if (turn.slot !== slot) continue;
        if (await turn.interrupt()) count++;
      }
      return count;
    },
    activeWebDelegations: () => activeDispatches.size > 0,
    waitForWebDelegations: async signal => {
      if (signal?.aborted) throw signal.reason;
      const completed = Promise.allSettled([...activeDispatches]);
      if (!signal) { await completed; return; }
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try { await Promise.race([completed, aborted]); }
      finally { signal.removeEventListener("abort", onAbort); }
    },
    submitWebFollowUp,
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
        await http.close();
        await Promise.allSettled([...activeDispatches]);
        const results = await Promise.allSettled([restoration.then(() => service.close()),
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
  // A process signal does not choose the update policy for an accepted turn.
  // Keep the owning service alive until explicit maintenance can settle it.
  const signal = () => {
    if (activeDispatches.size > 0) return;
    lifecycle.abort(); resolveSignal();
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  await Promise.race([http.shutdownRequested, signaled]);
  process.off("SIGINT", signal);
  process.off("SIGTERM", signal);
  await stop();
}

observeDaemonUncaughtFailures("codex");
void main().catch(error => {
  reportDaemonFailure("codex", error);
  console.error(error);
  process.exitCode = 1;
});
