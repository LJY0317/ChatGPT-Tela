import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  parseProductControlConfig,
  readProductControlConfig,
  resolveProductControlPaths,
  writeProductControlConfig,
} from "./config";

describe("product control config", () => {
  test("persists the built-in default Desktop target without a Multi-Profile launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-control-config-"));
    try {
      const paths = resolveProductControlPaths({ profileRoot: root });
      writeProductControlConfig({
        version: 1,
        publicMcpAbi: "stable",
        exposure: {
          kind: "existing-https",
          publicUrl: "https://example.test/chatgpt-tela",
          localPort: 18743,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
        },
      }, paths);
      expect(readProductControlConfig(paths)).toEqual({
        version: 1,
        publicMcpAbi: "stable",
        exposure: {
          kind: "existing-https",
          publicUrl: "https://example.test/chatgpt-tela",
          localPort: 18743,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
        },
      });
      expect(JSON.stringify(readProductControlConfig(paths))).not.toContain("token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed without explicit development opt-in for public no-auth exposure", () => {
    expect(() => parseProductControlConfig({
      version: 1,
      exposure: {
        kind: "existing-https",
        publicUrl: "https://example.test/mcp",
        localPort: 18743,
        authentication: "none",
        allowUnauthenticatedPublicEndpoint: false,
      },
    })).toThrow();
  });

  test("persists secret-free managed Tailscale Funnel metadata without inferring route ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-tailscale-config-"));
    try {
      const launcher = join(root, "codex-profile");
      writeFileSync(launcher, "fixture", { mode: 0o700 });
      const paths = resolveProductControlPaths({ profileRoot: root });
      writeProductControlConfig({
        version: 1,
        multiProfile: { launcherCli: launcher },
        publicMcpAbi: "unified-development",
        exposure: {
          kind: "tailscale-funnel",
          publicUrl: "https://machine.tail.example.ts.net/chatgpt-tela",
          localPort: 18743,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
          tailscaleCli: "tailscale",
        },
      }, paths);
      expect(readProductControlConfig(paths).exposure).toEqual({
        kind: "tailscale-funnel",
        publicUrl: "https://machine.tail.example.ts.net/chatgpt-tela",
        localPort: 18743,
        authentication: "none",
        allowUnauthenticatedPublicEndpoint: true,
        tailscaleCli: "tailscale",
      });
      expect(readProductControlConfig(paths).publicMcpAbi).toBe("unified-development");
      expect(readProductControlConfig(paths).multiProfile).toEqual({ launcherCli: launcher });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown public MCP ABI generations", () => {
    expect(() => parseProductControlConfig({
      version: 1,
      publicMcpAbi: "future-unproven-generation",
      exposure: {
        kind: "existing-https",
        publicUrl: "https://example.test/mcp",
        localPort: 18743,
        authentication: "none",
        allowUnauthenticatedPublicEndpoint: true,
      },
    })).toThrow("public MCP ABI");
  });

  test("older version-1 launcher config remains an explicit Multi-Profile compatibility path", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-legacy-config-"));
    try {
      const launcher = join(root, "codex-profile");
      writeFileSync(launcher, "fixture", { mode: 0o700 });
      const parsed = parseProductControlConfig({
        version: 1,
        launcherCli: launcher,
        exposure: {
          kind: "existing-https",
          publicUrl: "https://example.test/chatgpt-tela",
          localPort: 18743,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
        },
      });
      expect(parsed.publicMcpAbi).toBe("stable");
      expect(parsed.multiProfile).toEqual({ launcherCli: launcher });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("version-1 config with no optional profile adapter is single-profile by default", () => {
    const parsed = parseProductControlConfig({
      version: 1,
      exposure: {
        kind: "existing-https",
        publicUrl: "https://example.test/chatgpt-tela",
        localPort: 18743,
        authentication: "none",
        allowUnauthenticatedPublicEndpoint: true,
      },
    });
    expect(parsed.multiProfile).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("launcherCli");
  });

  test("short-lived version-1 nativeTarget selector migrates to optional Multi-Profile extension", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-native-target-compat-"));
    const launcher = join(root, "codex-profile");
    writeFileSync(launcher, "fixture", { mode: 0o700 });
    try {
      expect(parseProductControlConfig({
        version: 1,
        nativeTarget: { kind: "multi-profile", launcherCli: launcher },
        exposure: {
          kind: "existing-https",
          publicUrl: "https://example.test/chatgpt-tela",
          localPort: 18743,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
        },
      }).multiProfile).toEqual({ launcherCli: launcher });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
