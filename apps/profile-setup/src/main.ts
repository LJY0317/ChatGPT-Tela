import {
  bindChatGptTelaAccount, loadElectronProfileSetupConfig,
  resolveChatGptTelaBrowserProfile, startElectronProfileSetupRuntime,
} from "@chatgpt-tela/development-runtime";
import { app, BrowserWindow, dialog, Menu } from "electron";
import { createSetupCompletion } from "./completion";

async function main(): Promise<void> {
  const config = loadElectronProfileSetupConfig();
  app.setPath("userData", config.browserUserDataDir);
  const profile = resolveChatGptTelaBrowserProfile({ slot: config.slot, profileRoot: config.profileRoot });
  const runtime = await startElectronProfileSetupRuntime(config);
  try {
    if (config.runContextCanary) {
      const canary = await runtime.probeChatGptContextAttachment(AbortSignal.timeout(150_000));
      bindChatGptTelaAccount(profile, canary.account.accountFingerprint);
      process.stdout.write(`${JSON.stringify({ stage: "profile-setup-context-canary", slot: config.slot,
        profileId: config.profileId, accountBinding: "verified", readiness: "proven",
        attachmentBytes: canary.attachmentBytes, receiptVerified: canary.receiptVerified })}\n`);
      await runtime.stop();
      app.quit();
      return;
    }
    const surface = await runtime.openProfileSetupSurface({ reveal: config.revealWhenReady });
    const verify = async () => {
      const observed = await surface.probeChatGptProfile(AbortSignal.timeout(30_000));
      bindChatGptTelaAccount(profile, observed.account.accountFingerprint);
    };
    if (!config.revealWhenReady) {
      await verify();
      process.stdout.write(`${JSON.stringify({ stage: "profile-setup", slot: config.slot,
        profileId: config.profileId, readiness: "proven", accountBinding: "verified", setupBrowser: "not-needed" })}\n`);
      await runtime.stop();
      app.quit();
      return;
    }
    // Show login immediately. A human chooses when to prove readiness; no background polling.
    let exiting = false;
    const completion = createSetupCompletion({ verify, close: () => runtime.stop(),
      exit: code => {
        exiting = true;
        process.stdout.write(`${JSON.stringify({ stage: "profile-setup-complete", slot: config.slot,
          profileId: config.profileId, readiness: code === 0 ? "proven" : "cancelled",
          ...(code === 0 ? { accountBinding: "verified" } : {}) })}\n`);
        if (code === 0) app.quit();
        else app.exit(code);
      },
      needsLogin: async () => {
        await dialog.showMessageBox({ type: "info", title: "Finish ChatGPT setup",
          message: "ChatGPT login couldn't be verified yet",
          detail: "Complete login in this window, then choose Finish setup again. Your login window will stay open.",
          buttons: ["Continue setup"] });
      },
    });
    const perform = (action: () => Promise<void>) => {
      void action().catch(() => {
        // Cleanup failure is not a successful setup. Exit releases the launcher activity lease.
        exiting = true;
        app.exit(1);
      });
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "ChatGPT Tela Setup", submenu: [
        { label: "Finish setup", accelerator: "CmdOrCtrl+Return", click: () => perform(completion.finish) },
        { label: "Cancel setup", click: () => perform(completion.cancel) },
        { type: "separator" }, { role: "quit" },
      ] },
      { role: "editMenu" },
    ]));
    // Closing this owned browser verifies while its surface still exists. Never intercept other apps.
    for (const window of BrowserWindow.getAllWindows()) {
      window.on("close", event => { if (!exiting) { event.preventDefault(); perform(completion.finish); } });
    }
    app.on("before-quit", event => { if (!exiting) { event.preventDefault(); perform(completion.cancel); } });
    process.once("SIGINT", () => perform(completion.finish));
    process.once("SIGTERM", () => perform(completion.cancel));
    process.stdout.write(`${JSON.stringify({ stage: "profile-setup", slot: config.slot, setupBrowser: "visible",
      next: "Sign in, create the ChatGPT Tela Plugin, then choose Finish setup or close this window." })}\n`);
  } catch (error) {
    await runtime.stop();
    throw error;
  }
}

void main().catch(() => { app.exit(1); });
