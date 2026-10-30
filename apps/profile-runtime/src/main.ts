import {
  loadProductProfileRuntimeConfig,
  startNativeFirstProductProfileRuntime,
  readChatGptTelaAccountBinding,
} from "@chatgpt-tela/development-runtime";
import { app } from "electron";
import { writeSync } from "node:fs";
import { startProfileBridgePreviewServer, type ProfileBridgePreviewServer } from "./bridge-preview-server";
import { createProfileSupervisorLifecycle } from "./supervision";
import { connectCodexAppServerWebSocket } from "@chatgpt-tela/codex";
import { createAccountCheck } from "./account-check";
import { createAccountDisplay } from "./account-display";
import { startNativeAccountLifecycle } from "./native-account-lifecycle";
import { diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { bindBeforeQuitToStop } from "./quit";

function writeStderr(value: unknown): void {
  try {
    const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
    writeSync(2, `${text}\n`);
  } catch {
    // The supervisor may already be gone; stderr is not lifecycle authority.
  }
}

async function main(config: ReturnType<typeof loadProductProfileRuntimeConfig>): Promise<void> {
  // Electron's persistent profile root must be fixed before *any* async work.
  // Waiting for the supervisor handshake first can let Electron reach app-ready
  // with its default userData path, causing the hidden ChatGPT surface to start
  // from the wrong profile even though the later setPath call itself succeeds.
  app.setPath("userData", config.browserProfile.userDataDir);
  if (process.platform === "darwin") app.dock?.hide();
  const lifecycle = await createProfileSupervisorLifecycle();
  const keepAliveWithoutWindows = () => {};
  app.on("window-all-closed", keepAliveWithoutWindows);
  const runtime = await startNativeFirstProductProfileRuntime(config, {
    signal: lifecycle.signal,
  });
  let preview: ProfileBridgePreviewServer;
  let accountRevision = 0;
  let drain: (() => Promise<void>) | undefined;
  const readNativeAccount = async (signal: AbortSignal) => {
    const rpc = await connectCodexAppServerWebSocket(runtime.routedTarget.session.endpoint, { signal });
    try { return await rpc.request("account/read", { refreshToken: false }, signal); }
    finally { await rpc.close(); }
  };
  try {
    lifecycle.signal.throwIfAborted();
    preview = await startProfileBridgePreviewServer({
      slot: config.slot,
      bearerToken: config.uiToken,
      accountCheck: createAccountCheck({
        signal: lifecycle.signal,
        native: readNativeAccount,
        web(signal) {
          const web = runtime.webRuntime;
          if (!web) throw new Error("Web account observation unavailable");
          return web.probeChatGptAccount(signal);
        },
        binding: () => readChatGptTelaAccountBinding(config.browserProfile)?.accountFingerprint,
      }),
      accountDisplay: createAccountDisplay({
        native: readNativeAccount, signal: lifecycle.signal, revision: () => accountRevision,
        web(signal) {
          const web = runtime.webRuntime;
          if (!web) throw new Error("Web account observation unavailable");
          return web.probeChatGptAccountDisplay(signal);
        },
      }),
      webState: () => ({ contractVersion: 1, slot: config.slot, webState: runtime.webState, webModelIds: runtime.webModelIds,
        ...(runtime.accountManagementActive ? { accountManagementActive: true } : {}) }),
      waitForWeb: () => runtime.waitForWeb(),
      reconnectWeb: () => runtime.reconnectWeb(),
      shutdownProfile: async () => {
        if (!drain) throw new Error("Profile lifecycle is not ready for shutdown");
        await drain();
        return { responsesRouteFingerprint: runtime.routedTarget.session.responsesRouteFingerprint };
      },
      shutdownReadiness: () => runtime.shutdownReadiness(),
      inspectCheckpointCandidates: threadId => runtime.inspectCheckpointCandidates(threadId),
      openAccountBrowser: () => runtime.openWebAccountBrowser(),
      closeAccountBrowser: () => runtime.closeWebAccountBrowser(),
      inspectHistoryUi: () => runtime.inspectWebHistoryUi(),
      runSavedDeleteAcceptance: () => runtime.runSavedChatDeleteAcceptance(),
      recoverSyntheticSavedChat: () => runtime.recoverSyntheticSavedChat(),
      surfaces: () => runtime.bridgeSurfaces(),
      onSurfacesChanged: listener => runtime.onBridgeSurfacesChanged(listener),
      observe: (id, threadId) => runtime.webRuntime?.observeBridgePreview(id, threadId) ?? Promise.resolve({ activeSurfaceCount: 0 }),
      reveal: async (id, interactive) => {
        if (!runtime.webRuntime) throw new Error("Web connection is not ready");
        await runtime.webRuntime.revealBridgeSurface(id, interactive);
      },
      probeModelSelection: () => {
        if (!runtime.webRuntime) throw new Error("Web connection is not ready");
        return runtime.webRuntime.probeChatGptWebModelSelection();
      },
      probeContextAttachment: signal => {
        if (!runtime.webRuntime) throw new Error("Web connection is not ready");
        return runtime.webRuntime.probeChatGptContextAttachment(signal);
      },
    });
  } catch (error) {
    await runtime.stop().catch(() => {});
    throw error;
  }
  try {
    await lifecycle.publishReady({
      stage: "product-profile-ready",
      runtimeProcessId: process.pid,
      slot: config.slot,
      routeId: config.routeId,
      targetId: config.nativeTarget.targetId,
      nativeTargetKind: config.nativeTarget.kind,
      profileId: config.browserProfile.profileId,
      internalMcpUrl: runtime.internalMcp.endpointUrl.href,
      bridgePreviewUrl: preview.endpoint.href,
      terminalEndpoint: runtime.routedTarget.session.endpoint,
      responsesUrl: runtime.responses.baseUrl.href,
      responsesRouteFingerprint: runtime.routedTarget.session.responsesRouteFingerprint,
      ...(runtime.routedTarget.session.desktopProcessId
        ? { targetProcessId: runtime.routedTarget.session.desktopProcessId }
        : {}),
      nativeReady: true,
      webState: runtime.webState,
    });
  } catch (error) {
    await preview.close().catch(() => {});
    await runtime.stop().catch(() => {});
    lifecycle.dispose();
    throw new Error("profile supervisor connection closed before readiness", { cause: error });
  }

  const accountLifecycle = startNativeAccountLifecycle({
    signal: lifecycle.signal,
    connect: signal => connectCodexAppServerWebSocket(runtime.routedTarget.session.endpoint, { ...(signal ? { signal } : {}) }),
    async invalidate(reason) {
      accountRevision++;
      emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_account_invalidated", { reason_class: reason });
      await runtime.invalidateWebAccount();
    },
  });
  void accountLifecycle.ready.catch(() => {
    emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_account_cleanup_failed", {});
  });

  let stopping: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let allowQuit = () => {};
  drain = () => {
    draining ??= (async () => {
      // A refusal to quit must leave account observation and private control
      // alive. Only successful target cleanup permits their teardown.
      await runtime.stop();
      await accountLifecycle.stop();
    })().catch(error => { draining = undefined; throw error; });
    return draining;
  };
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        await drain!();
        await preview.close();
        app.removeListener("window-all-closed", keepAliveWithoutWindows);
        lifecycle.dispose();
        allowQuit();
        app.quit();
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
    }
    return stopping;
  };
  allowQuit = bindBeforeQuitToStop(app, stop, writeStderr);

  await lifecycle.shutdownRequested;
  await stop();
}

function start(): Promise<void> {
  const config = loadProductProfileRuntimeConfig();
  return withDiagnosticContext({
    profile_fingerprint: diagnosticFingerprint(config.browserProfile.profileId),
    storage_fingerprint: diagnosticFingerprint(config.browserProfile.userDataDir),
  }, () => main(config));
}

void start().catch(error => {
  writeStderr(error);
  app.exit(1);
});
