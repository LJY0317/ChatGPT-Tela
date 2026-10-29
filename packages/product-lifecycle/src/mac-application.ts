import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packagedPayloadFingerprint } from "./packaged-payload";
import { PACKAGED_PRODUCT_MANIFEST, parsePackagedProductManifest, readPackagedProductManifest } from "./packaged-manifest";

/** Convert a newly built, disposable flat payload in place. Never accepts an installed tree. */
export function assembleMacApplication(input: {
  payloadPath: string;
  buildVersion: string;
  feedURL: string;
  publicKey: string;
  finalizeBundle: (appPath: string) => void;
}) {
  if (!/^\d+(\.\d+){0,2}$/.test(input.buildVersion)) throw Error("macOS build version must be numeric");
  const feed = new URL(input.feedURL);
  if (feed.protocol !== "https:" && !(feed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(feed.hostname))) {
    throw Error("update feed must use HTTPS or loopback HTTP");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey) || Buffer.from(input.publicKey, "base64").length !== 32) throw Error("update public key must be Ed25519");
  const root = resolve(input.payloadPath);
  if (existsSync(join(root, ".chatgpt-tela-owner.json")) || existsSync(join(root, ".chatgpt-tela-payload-v1.json"))) {
    throw Error("cannot assemble an installed payload");
  }
  const previous = readPackagedProductManifest(root);
  if (!previous.menuBar || !previous.launcher || !previous.profileRuntime?.executable.startsWith("electron/Electron.app/")) {
    throw Error("macOS application requires a launcher, menu and Electron.app runtime");
  }
  const contents = join(root, "Contents");
  if (existsSync(contents)) throw Error("application assembly already started");
  const move = (from: string, to: string) => {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(join(root, from), join(root, to));
  };
  move(previous.launcher.executable, "Contents/MacOS/chatgpt-tela");
  move(previous.menuBar.executable, "Contents/MacOS/chatgpt-tela-menu-bar");
  if (existsSync(join(root, "services"))) move("services", "Contents/Helpers/services");
  move("electron/Electron.app", "Contents/Frameworks/Electron.app");
  if (existsSync(join(root, "ui/ChatGPT Tela.app/Contents/Frameworks/Sparkle.framework"))) {
    move("ui/ChatGPT Tela.app/Contents/Frameworks/Sparkle.framework", "Contents/Frameworks/Sparkle.framework");
  }
  move("runtime", "Contents/Resources/runtime");
  if (existsSync(join(root, "third-party-notices"))) {
    move("third-party-notices", "Contents/Resources/ThirdPartyNotices");
  }
  if (previous.menuBar.maintenanceExecutable) move("ui/Tela Maintenance.app", "Contents/Helpers/Tela Maintenance.app");
  if (previous.nativeEngine) move("native-engine", "Contents/Helpers/native-engine");
  if (previous.workspaceFiles) move("helpers", "Contents/Helpers/helpers");
  // The product executable is now part of this app; remove its duplicate menu bundle.
  rmSync(join(root, "ui"), { recursive: true });
  rmSync(join(root, "electron"), { recursive: true });
  const manifest = parsePackagedProductManifest({
    ...previous,
    launcher: { executable: "Contents/MacOS/chatgpt-tela" },
    menuBar: { executable: "Contents/MacOS/chatgpt-tela-menu-bar",
      ...(previous.menuBar.maintenanceExecutable ? { maintenanceExecutable: "Contents/Helpers/Tela Maintenance.app/Contents/MacOS/chatgpt-tela-maintenance" } : {}) },
    services: Object.fromEntries(Object.entries(previous.services).map(([id, service]) => [id, { ...service,
      executable: service.executable === previous.launcher!.executable ? "Contents/MacOS/chatgpt-tela" : `Contents/Helpers/${service.executable}` }])),
    profileRuntime: {
      executable: previous.profileRuntime.executable.replace("electron/", "Contents/Frameworks/"),
      entrypoint: `Contents/Resources/${previous.profileRuntime.entrypoint}`,
      ...(previous.profileRuntime.setupEntrypoint ? { setupEntrypoint: `Contents/Resources/${previous.profileRuntime.setupEntrypoint}` } : {}),
    },
    ...(previous.nativeEngine ? { nativeEngine: { ...previous.nativeEngine, executable: `Contents/Helpers/${previous.nativeEngine.executable}` } } : {}),
    ...(previous.workspaceFiles ? { workspaceFiles: { ...previous.workspaceFiles, executable: `Contents/Helpers/${previous.workspaceFiles.executable}` } } : {}),
  });
  writeFileSync(join(contents, "Resources", PACKAGED_PRODUCT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  rmSync(join(root, PACKAGED_PRODUCT_MANIFEST));
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const strings = {
    CFBundleExecutable: "chatgpt-tela-menu-bar", CFBundleIdentifier: "com.openai.chatgpt-tela.menu-bar",
    CFBundleName: "ChatGPT Tela", CFBundlePackageType: "APPL", CFBundleVersion: input.buildVersion,
    CFBundleShortVersionString: manifest.productVersion, LSMinimumSystemVersion: "13.0", SUFeedURL: input.feedURL, SUPublicEDKey: input.publicKey,
  };
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(strings).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}<key>LSUIElement</key><true/><key>SUEnableAutomaticChecks</key><true/><key>SUAllowsAutomaticUpdates</key><false/><key>SUVerifyUpdateBeforeExtraction</key><true/></dict></plist>\n`);
  input.finalizeBundle(root);
  // No mutable owner marker or installed receipt is written into the signed app.
  return { outputPath: root, manifest, payloadFingerprint: packagedPayloadFingerprint(root) };
}
