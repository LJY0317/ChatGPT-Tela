import { packagedPayloadFingerprint } from "./packaged-payload";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleMacApplication } from "./mac-application";
import { buildPackagedPayload } from "./packaged-build";
import { createPackagedInstallBlueprint } from "./packaged-install";
import { packagedInstallSpecFromPayload, readPackagedProductManifest } from "./packaged-manifest";

function fixture(root: string) {
  const input = join(root, "input");
  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "menu-bar"), "menu-bar\n", { mode: 0o755 });
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });
  return input;
}

describe("packaged payload builder", () => {
  test("stages a multi-file launcher/services/profile-runtime layout and fingerprints its final tree", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-build-"));
    const input = fixture(root);
    const output = join(root, "output");


    try {
      const built = buildPackagedPayload({
        outputPath: output,
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
        menuBarSourcePath: join(input, "menu-bar"),
        workspaceFilesSourcePath: join(input, "chat"),
        chatProcessStore: { readVersions: [1, 2], writeVersion: 2 },
        lifecycle: { transitionLaunch: 1, sourceCancellation: 1 },
      });
      expect(built.manifest.workspaceFiles).toEqual({ executable: `helpers/tela-workspace-files${process.platform === "win32" ? ".exe" : ""}`, protocolVersion: 2 });
      expect(built.manifest.lifecycle).toEqual({ transitionLaunch: 1, sourceCancellation: 1 });
      expect(built.manifest.launcher?.executable).toBe("chatgpt-tela");
      expect(built.manifest.services.gateway.executable).toBe("services/gateway");
      expect(built.manifest.profileRuntime).toEqual({
        executable: "electron/bin/electron",
        entrypoint: "runtime/profile-runtime.cjs",
      });
      expect(built.manifest.menuBar).toEqual({ executable: "ui/ChatGPT Tela.app/Contents/MacOS/chatgpt-tela-menu-bar" });
      expect(existsSync(join(output, "services", "gateway"))).toBe(true);
      expect(existsSync(join(output, "runtime", "profile-runtime.cjs"))).toBe(true);
      expect(existsSync(join(output, "ui", "ChatGPT Tela.app", "Contents", "MacOS", "chatgpt-tela-menu-bar"))).toBe(true);
      const info = readFileSync(join(output, "ui", "ChatGPT Tela.app", "Contents", "Info.plist"), "utf8");
      expect(info).toContain("<key>CFBundlePackageType</key><string>APPL</string>");
      expect(info).toContain("<key>LSUIElement</key><true/>");
      expect(info).toContain("<key>CFBundleIdentifier</key><string>com.openai.chatgpt-tela.menu-bar</string>");
      expect(packagedPayloadFingerprint(output)).toBe(built.payloadFingerprint);
      const spec = packagedInstallSpecFromPayload(output);
      expect(spec.menuBarApp).toEqual({ sourceRelativePath: "ui/ChatGPT Tela.app" });
      expect(spec.services).toEqual([
        { service: "gateway", executableRelativePath: "chatgpt-tela", arguments: ["service", "gateway"] },
        { service: "chat", executableRelativePath: "chatgpt-tela", arguments: ["service", "chat"] },
        { service: "codex", executableRelativePath: "chatgpt-tela", arguments: ["service", "codex"] },
      ]);
      expect(built.manifest.chatProcessStore).toEqual({ readVersions: [1, 2], writeVersion: 2 });
      const manifestPath = join(output, "chatgpt-tela-package-v1.json"), manifestBytes = readFileSync(manifestPath);
      writeFileSync(manifestPath, JSON.stringify({ ...built.manifest, chatProcessStore: { readVersions: [1], writeVersion: 1 } }));
      expect(packagedPayloadFingerprint(output)).not.toBe(built.payloadFingerprint);
      writeFileSync(manifestPath, manifestBytes);
      const { lifecycle, ...withoutLifecycle } = built.manifest;
      writeFileSync(manifestPath, JSON.stringify(withoutLifecycle));
      expect(packagedPayloadFingerprint(output)).not.toBe(built.payloadFingerprint);
      writeFileSync(manifestPath, manifestBytes);
      writeFileSync(join(output, built.manifest.workspaceFiles!.executable), "tampered-helper");
      expect(packagedPayloadFingerprint(output)).not.toBe(built.payloadFingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("assembles one complete macOS app with resolvable manifest paths and no duplicate menu", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-mac-app-"));
    try {
      const input = fixture(root), output = join(root, "Tela.app");
      mkdirSync(join(input, "electron/Electron.app/Contents/MacOS"), { recursive: true });
      writeFileSync(join(input, "electron/Electron.app/Contents/MacOS/Electron"), "electron", { mode: 0o755 });
      buildPackagedPayload({ outputPath: output, productVersion: "1.2.3", launcherSourcePath: join(input, "launcher"),
        services: { gateway: { executableSourcePath: join(input, "gateway") }, chat: { executableSourcePath: join(input, "chat") }, codex: { executableSourcePath: join(input, "codex") } },
        profileRuntime: { electronBundleSourcePath: join(input, "electron"), electronExecutableRelativePath: "Electron.app/Contents/MacOS/Electron", entrypointSourcePath: join(input, "profile-runtime.cjs") },
        menuBarSourcePath: join(input, "menu-bar"), workspaceFilesSourcePath: join(input, "chat") });
      const options = { payloadPath: output, buildVersion: "123", feedURL: "https://example.com/updates.xml", publicKey: Buffer.alloc(32).toString("base64"), finalizeBundle: () => {} };
      writeFileSync(join(output, ".chatgpt-tela-owner.json"), "owned");
      expect(() => assembleMacApplication(options)).toThrow("installed payload");
      expect(existsSync(join(output, "services/gateway"))).toBe(true);
      rmSync(join(output, ".chatgpt-tela-owner.json"));
      const result = assembleMacApplication({ ...options, finalizeBundle(app) {
        const spec = packagedInstallSpecFromPayload(app);
        expect(spec.menuBarApp).toBeUndefined();
        expect(spec.services[0]?.executableRelativePath).toBe("Contents/MacOS/chatgpt-tela");
        const blueprint = createPackagedInstallBlueprint({ spec, platform: "darwin", home: root, environment: {} });
        expect(blueprint.payload.resource.path).toBe(join(root, "Applications", "ChatGPT Tela.app"));
        expect(blueprint.payload.resource.metadataRoot).toBe(join(root, "Library/Application Support/ChatGPT Tela/state/install/application"));
        expect(blueprint.services[0]?.definition).toEqual(expect.objectContaining({ content: expect.stringContaining("Contents/MacOS/chatgpt-tela") }));
      } });
      expect(readPackagedProductManifest(output)).toEqual(result.manifest);
      expect(existsSync(join(output, "ui"))).toBe(false);
      expect(existsSync(join(output, "electron"))).toBe(false);
      expect(readFileSync(join(output, "Contents/Helpers/services/chat"), "utf8")).toBe("chat\n");
      expect(readFileSync(join(output, "Contents/Info.plist"), "utf8")).toContain("<key>CFBundleVersion</key><string>123</string>");
      expect(packagedPayloadFingerprint(output)).toBe(result.payloadFingerprint);
      expect(readdirSync(output)).toEqual(["Contents"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the receipt fingerprint changes when payload bytes change", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-fingerprint-drift-"));
    const input = fixture(root);
    const output = join(root, "output");

    try {
      const built = buildPackagedPayload({
        outputPath: output,
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
      });
      writeFileSync(join(output, "services", "chat"), "tampered\n");
      expect(packagedPayloadFingerprint(output)).not.toBe(built.payloadFingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("internal Electron symlinks are preserved while cyclic/escaping links are rejected", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-symlink-"));
    const input = fixture(root);

    try {
      symlinkSync("loop", join(input, "electron", "bin", "loop"));
      expect(() => buildPackagedPayload({
        outputPath: join(root, "bad-cycle"),
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
      })).toThrow();
      rmSync(join(input, "electron", "bin", "loop"));
      symlinkSync("bin", join(input, "electron", "electron-copy"));
      const output = join(root, "good");
      buildPackagedPayload({
        outputPath: output,
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
      });
      expect(lstatSync(join(output, "electron", "electron-copy")).isSymbolicLink()).toBe(true);
      rmSync(join(input, "electron", "electron-copy"), { force: true });
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "x"), "x");
      symlinkSync(outside, join(input, "electron", "escape"));
      expect(() => buildPackagedPayload({
        outputPath: join(root, "escape-output"),
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
      })).toThrow("symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
