import {
  loadDevelopmentCanaryConfig,
  startDevelopmentCanary,
} from "@chatgpt-tela/development-runtime";
import { app } from "electron";

async function main(): Promise<void> {
  const config = loadDevelopmentCanaryConfig();
  app.setPath("userData", config.browserUserDataDir);
  const keepAliveWithoutWindows = () => {};
  app.on("window-all-closed", keepAliveWithoutWindows);
  const canary = await startDevelopmentCanary(config);
  const mcp = canary.runtime.mcp;
  if (mcp.kind !== "http-exposure") {
    throw new Error("development canary expected HTTP exposure mode");
  }
  const publicMcp = mcp.exposure.publicEndpoint.kind === "https"
    ? {
        kind: "https",
        url: mcp.exposure.publicEndpoint.url.href,
        authentication: mcp.exposure.publicEndpoint.authentication.kind,
      }
    : {
        kind: "openai-secure-tunnel",
        tunnelId: mcp.exposure.publicEndpoint.tunnelId,
        authentication: mcp.exposure.publicEndpoint.authentication.kind,
      };

  process.stdout.write(`${JSON.stringify({
    stage: "development-canary",
    profileId: config.chatGptTelaProfileId,
    profileSlot: config.browserProfile.slot,
    nativeProfile: canary.nativeProfile.kind === "stock"
      ? {
          kind: "stock",
          routeMode: "process-local",
          routeEnvKey: canary.nativeProfile.processRoute.envKey,
          codexArguments: canary.nativeProfile.processRoute.arguments,
        }
      : {
          kind: "multi-profile",
          targetId: canary.nativeProfile.targetId,
          endpoint: canary.nativeProfile.endpoint,
          responsesRouteFingerprint: canary.nativeProfile.responsesRouteFingerprint,
        },
    responsesUrl: canary.runtime.responses.baseUrl.href,
    responsesAuth: "Bearer CHATGPT_TELA_CANARY_RESPONSES_TOKEN",
    publicMcp,
    servedMcpAbi: canary.mcpAbi,
    servedMcpSchemaFingerprint: canary.mcpSchemaFingerprint,
    connectorIdentity: "ChatGPT Tela Development",
    connectorName: config.connectorName,
    webTurnTimeoutMs: config.webTurnTimeoutMs,
    chatGptReadiness: "proven",
    accountBinding: "verified",
    codexRoute: { mode: "process-local-no-config-mutation" },
  }, null, 2)}\n`);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopping) {
      stopping = canary.stop().catch(error => {
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
      void stop().then(() => {
        app.removeListener("window-all-closed", keepAliveWithoutWindows);
        app.quit();
        resolve();
      }, error => {
        console.error(error);
        arm();
      });
    };
    arm();
  });
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
