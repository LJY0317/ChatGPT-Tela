import { diagnosticFingerprint, withDiagnosticContext } from "@chatgpt-tela/core";
import {
  loadProductProfileRuntimeConfig,
  startAppOwnedProductResponsesRuntime,
} from "@chatgpt-tela/development-runtime";
import { readProductConfigIfPresent } from "@chatgpt-tela/product-config";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { app } from "electron";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { startAppOwnedProfileBridge, type ProfileBridgePreviewServer } from "./bridge-preview-server";
import { selectAppOwnedProfileIngress } from "./profile-selection";
import { bindBeforeQuitToStop } from "./quit";
import { createProfileSupervisorLifecycle } from "./supervision";

function writeStderr(value: unknown): void {
  try {
    const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
    writeSync(2, `${text}\n`);
  } catch {
    // The supervisor may already be gone; stderr is not lifecycle authority.
  }
}

/** A separately owned Responses profile. Optional Plura launch remains owned by
 * Plura, never by this process; the distinct ready stage cannot claim a Native
 * Desktop lease or first-party terminal authority. */
async function mainAppOwned(
  config: ReturnType<typeof loadProductProfileRuntimeConfig>,
  ingress: { readonly port: number; readonly capability: string },
): Promise<void> {
  app.setPath("userData", config.browserProfile.userDataDir);
  if (process.platform === "darwin") app.dock?.hide();
  const lifecycle = await createProfileSupervisorLifecycle();
  const keepAliveWithoutWindows = () => {};
  app.on("window-all-closed", keepAliveWithoutWindows);
  let runtime: Awaited<ReturnType<typeof startAppOwnedProductResponsesRuntime>> | undefined;
  let preview: ProfileBridgePreviewServer | undefined;
  let allowQuit = () => {};
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    await runtime?.stop();
    await preview?.close();
    app.removeListener("window-all-closed", keepAliveWithoutWindows);
    lifecycle.dispose();
    allowQuit();
    app.quit();
  })().catch(error => { stopping = undefined; throw error; });
  try {
    const installId = process.env.CHATGPT_TELA_INSTALL_ID;
    runtime = await startAppOwnedProductResponsesRuntime({
      config, ingress, signal: lifecycle.signal,
      ...(installId
        ? { catalogPreparation: { paths: resolveProductPaths(), installId } } : {}),
    });
    const owned = runtime;
    preview = await startAppOwnedProfileBridge(config, owned, lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    await lifecycle.publishReady({
      stage: "app-owned-profile-ready",
      runtimeProcessId: process.pid,
      slot: config.slot,
      routeId: config.routeId,
      profileId: config.browserProfile.profileId,
      bridgePreviewUrl: preview.endpoint.href,
      responsesUrl: owned.responses.baseUrl.href,
      responsesRouteFingerprint: createHash("sha256").update(owned.responses.baseUrl.href).digest("hex"),
      targetId: config.nativeTarget.targetId,
      nativeTargetKind: config.nativeTarget.kind,
      internalMcpUrl: owned.internalMcp.endpointUrl.href,
      nativeReady: false,
      webState: "ready",
    });
  } catch (error) {
    await runtime?.stop().catch(() => {});
    await preview?.close().catch(() => {});
    lifecycle.dispose();
    app.removeListener("window-all-closed", keepAliveWithoutWindows);
    throw error;
  }
  allowQuit = bindBeforeQuitToStop(app, stop, writeStderr);
  await lifecycle.shutdownRequested;
  await stop();
}

function start(): Promise<void> {
  const config = loadProductProfileRuntimeConfig();
  const ingress = selectAppOwnedProfileIngress(config, readProductConfigIfPresent());
  return withDiagnosticContext({
    profile_fingerprint: diagnosticFingerprint(config.browserProfile.profileId),
    storage_fingerprint: diagnosticFingerprint(config.browserProfile.userDataDir),
  }, () => mainAppOwned(config, ingress));
}

void start().catch(error => {
  writeStderr(error);
  app.exit(1);
});
