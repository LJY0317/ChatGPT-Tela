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
import { emitDiagnosticEvent } from "@chatgpt-tela/core";

function writeStderr(value: unknown): void {
  try {
    const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
    writeSync(2, `${text}\n`);
  } catch {
    // The supervisor may already be gone; stderr is not lifecycle authority.
  }
}

async function main(): Promise<void> {
  const config = loadProductProfileRuntimeConfig();
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
      webState: () => ({ contractVersion: 1, slot: config.slot, webState: runtime.webState, webModelIds: runtime.webModelIds }),
      waitForWeb: () => runtime.waitForWeb(),
      reconnectWeb: () => runtime.reconnectWeb(),
      openAccountBrowser: () => runtime.openWebAccountBrowser(),
      closeAccountBrowser: () => runtime.closeWebAccountBrowser(),
      inspectHistoryUi: () => runtime.inspectWebHistoryUi(),
      observe: id => runtime.webRuntime?.observeBridgePreview(id) ?? Promise.resolve({ activeSurfaceCount: 0 }),
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
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        // A broken account-observer connection must not prevent normal owned runtime cleanup.
        const failures: unknown[] = [];
        for (const close of [() => accountLifecycle.stop(), () => preview.close(), () => runtime.stop()]) {
          try { await close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Profile cleanup incomplete");
        app.removeListener("window-all-closed", keepAliveWithoutWindows);
        lifecycle.dispose();
        app.quit();
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
    }
    return stopping;
  };

  await lifecycle.shutdownRequested;
  await stop();
}

void main().catch(error => {
  writeStderr(error);
  app.exit(1);
});
