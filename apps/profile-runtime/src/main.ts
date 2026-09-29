import {
  loadProductProfileRuntimeConfig,
  startProductProfileRuntime,
} from "@chatgpt-tela/development-runtime";
import { app } from "electron";
import { startProfileBridgePreviewServer, type ProfileBridgePreviewServer } from "./bridge-preview-server";

async function main(): Promise<void> {
  const config = loadProductProfileRuntimeConfig();
  if (process.platform === "darwin") app.dock?.hide();
  app.setPath("userData", config.browserProfile.userDataDir);
  const keepAliveWithoutWindows = () => {};
  app.on("window-all-closed", keepAliveWithoutWindows);
  const runtime = await startProductProfileRuntime(config);
  let preview: ProfileBridgePreviewServer;
  try {
    preview = await startProfileBridgePreviewServer({
      slot: config.slot,
      bearerToken: config.uiToken,
      observe: () => runtime.runtime.observeBridgePreview(),
      probeModelSelection: () => runtime.runtime.probeChatGptWebModelSelection(),
      probeContextAttachment: signal => runtime.runtime.probeChatGptContextAttachment(signal),
    });
  } catch (error) {
    await runtime.stop().catch(() => {});
    throw error;
  }
  process.stdout.write(`${JSON.stringify({
    stage: "product-profile-ready",
    slot: config.slot,
    routeId: config.routeId,
    targetId: config.nativeTarget.targetId,
    nativeTargetKind: config.nativeTarget.kind,
    profileId: config.browserProfile.profileId,
    internalMcpUrl: runtime.internalMcp.endpointUrl.href,
    bridgePreviewUrl: preview.endpoint.href,
    responsesUrl: runtime.runtime.responses.baseUrl.href,
    responsesRouteFingerprint: runtime.routedTarget.session.responsesRouteFingerprint,
    ...(runtime.routedTarget.session.desktopProcessId
      ? { targetProcessId: runtime.routedTarget.session.desktopProcessId }
      : {}),
    accountBinding: "verified",
  })}\n`);

  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = preview.close().then(() => runtime.stop()).then(() => {
        app.removeListener("window-all-closed", keepAliveWithoutWindows);
        app.quit();
      }).catch(error => {
        stopping = undefined;
        throw error;
      });
    }
    return stopping;
  };

  await new Promise<void>(resolve => {
    const arm = () => {
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    };
    const shutdown = () => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      void stop().then(resolve, error => {
        console.error(error);
        arm();
      });
    };
    arm();
  });
}

void main().catch(error => {
  console.error(error);
  app.exit(1);
});
