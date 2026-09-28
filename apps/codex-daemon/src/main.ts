import { join } from "node:path";
import {
  startCodexService,
  startCodexServiceHttpServer,
} from "@chatgpt-tela/codex-service";
import { readProductPreferences } from "@chatgpt-tela/product-config";
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
  const legacyKind = process.env.CHATGPT_TELA_CODEX_NATIVE_TARGET_KIND?.trim();
  if (legacyKind && legacyKind !== "default-desktop" && legacyKind !== "multi-profile") {
    throw new Error("legacy Tela Codex native target kind is invalid");
  }
  const multiProfileLauncher = process.env.CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI?.trim()
    || (legacyKind === "multi-profile" ? required("CHATGPT_TELA_CODEX_LAUNCHER_CLI") : undefined)
    || process.env.CHATGPT_TELA_CODEX_LAUNCHER_CLI?.trim();
  const runtimeExecutable = required("CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE");
  const runtimeEntrypoint = required("CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT");
  const installId = required("CHATGPT_TELA_INSTALL_ID");
  const paths = resolveProductPaths();
  const descriptorPath = join(paths.serviceRuntime("codex"), "descriptor.json");
  const service = await startCodexService({
    config: multiProfileLauncher
      ? { multiProfile: { launcherCli: multiProfileLauncher } }
      : {},
    profileRuntimeCommand: [runtimeExecutable, runtimeEntrypoint],
    environment: process.env,
    profileRuntimeEnvironment: () => ({
      CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: readProductPreferences().approvalAutomation,
    }),
  });
  const http = await startCodexServiceHttpServer({ service });
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

  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        const results = await Promise.allSettled([http.close(), service.close()]);
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
  const signal = () => resolveSignal();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  await Promise.race([http.shutdownRequested, signaled]);
  await stop();
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
