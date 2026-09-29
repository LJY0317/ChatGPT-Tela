import {
  bindChatGptTelaAccount,
  loadElectronProfileSetupConfig,
  resolveChatGptTelaBrowserProfile,
  startElectronProfileSetupRuntime,
  type ElectronProfileSetupSurface,
} from "@chatgpt-tela/development-runtime";
import { app } from "electron";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadElectronProfileSetupConfig();
  app.setPath("userData", config.browserUserDataDir);
  const profile = resolveChatGptTelaBrowserProfile({
    slot: config.slot,
    profileRoot: config.profileRoot,
  });
  const runtime = await startElectronProfileSetupRuntime(config);
  let setupSurface: ElectronProfileSetupSurface | undefined;

  try {
    if (config.runContextCanary) {
      await runtime.recoverChatGptStartupArtifact();
      const observed = await runtime.probeChatGptProfile();
      bindChatGptTelaAccount(profile, observed.account.accountFingerprint);
      const canary = await runtime.probeChatGptContextAttachment(AbortSignal.timeout(150_000));
      process.stdout.write(`${JSON.stringify({
        stage: "profile-setup-context-canary",
        slot: config.slot,
        profileId: config.profileId,
        accountBinding: "verified",
        ...canary,
      }, null, 2)}\n`);
      await runtime.stop();
      app.quit();
      return;
    }
    setupSurface = await runtime.openProfileSetupSurface({ reveal: false });
    const observed = await setupSurface.probeChatGptProfile();
    bindChatGptTelaAccount(profile, observed.account.accountFingerprint);
    if (config.revealWhenReady) {
      await setupSurface.reveal();
      process.stdout.write(`${JSON.stringify({
        stage: "profile-setup",
        slot: config.slot,
        profileId: config.profileId,
        readiness: "proven",
        accountBinding: "verified",
        setupBrowser: "visible",
        next: "Manage ChatGPT Developer Mode/connectors in the visible window, then press Ctrl+C here to verify and close.",
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({
        stage: "profile-setup",
        slot: config.slot,
        profileId: config.profileId,
        readiness: "proven",
        accountBinding: "verified",
        setupBrowser: "not-needed",
      }, null, 2)}\n`);
      await runtime.stop();
      app.quit();
      return;
    }
  } catch (error) {
    try {
      if (!setupSurface) setupSurface = await runtime.openProfileSetupSurface({ reveal: false });
      await setupSurface.reveal();
    } catch (setupError) {
      await runtime.stop().catch(stopError => {
        throw new AggregateError(
          [setupError, stopError],
          "profile setup surface failed and runtime cleanup was incomplete",
        );
      });
      app.quit();
      throw setupError;
    }
    process.stdout.write(`${JSON.stringify({
      stage: "profile-setup",
      slot: config.slot,
      profileId: config.profileId,
      readiness: "needs-setup",
      detail: message(error),
      setupBrowser: "visible",
      next: "Complete ChatGPT login, Developer Mode, and connector preparation in the visible window, then press Ctrl+C here to verify and close.",
    }, null, 2)}\n`);
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      let readiness: "proven" | "not-proven" = "not-proven";
      let detail: string | undefined;
      try {
        if (!setupSurface) throw new Error("profile setup surface is unavailable");
        const observed = await setupSurface.probeChatGptProfile();
        bindChatGptTelaAccount(profile, observed.account.accountFingerprint);
        readiness = "proven";
      } catch (error) {
        detail = message(error);
      }
      process.stdout.write(`${JSON.stringify({
        stage: "profile-setup-complete",
        slot: config.slot,
        profileId: config.profileId,
        readiness,
        ...(readiness === "proven" ? { accountBinding: "verified" } : {}),
        ...(detail ? { detail } : {}),
      }, null, 2)}\n`);
      await runtime.stop();
      if (readiness === "proven") app.quit();
      else app.exit(2);
    })().catch(error => {
      stopping = undefined;
      throw error;
    });
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
