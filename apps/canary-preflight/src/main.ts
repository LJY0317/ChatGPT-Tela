import {
  loadDevelopmentCanaryPreflightConfig,
  preflightDevelopmentCanary,
} from "@chatgpt-tela/development-runtime";
import { app } from "electron";

async function main(): Promise<void> {
  const config = loadDevelopmentCanaryPreflightConfig();
  app.setPath("userData", config.browserUserDataDir);
  const result = await preflightDevelopmentCanary(config);
  process.stdout.write(`${JSON.stringify({
    stage: "development-canary-preflight",
    profileSlot: config.browserProfile.slot,
    profileId: config.chatGptTelaProfileId,
    mcpAbi: config.mcpAbi,
    ...result,
  }, null, 2)}\n`);
  if (result.ready) app.quit();
  else app.exit(2);
}

void main().catch(error => {
  console.error(error);
  app.exit(1);
});
