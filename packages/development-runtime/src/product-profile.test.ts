import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProductProfileRuntimeConfig,
  productPublicMcpIdentity,
} from "./product-profile";

function common(root: string): Record<string, string> {
  return {
    CHATGPT_TELA_PROFILE_ROOT: join(root, "profiles"),
    CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "1",
    CHATGPT_TELA_PRODUCT_ROUTE_ID: "route1234",
    CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: "r".repeat(48),
    CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48),
  };
}

describe("product profile native-target selection", () => {
  test("ordinary profile 1 defaults to the built-in Desktop target without a launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-default-"));
    try {
      const config = loadProductProfileRuntimeConfig(common(root));
      expect(config.nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
      expect(config.publicMcpAbi).toBe("stable");
      expect(config.approvalAutomationMode).toBe("off");
      expect(JSON.stringify(config)).not.toContain("launcherCli");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approval automation is explicit and limited to recognized one-shot cards", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-approval-"));
    try {
      expect(loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "recognized_once",
      }).approvalAutomationMode).toBe("recognized_once");
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "full_access",
      })).toThrow("APPROVAL_AUTOMATION_MODE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("public connector identity is ChatGPT Tela for the stable product ABI", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-public-abi-"));
    try {
      const stable = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI: "stable",
      });
      expect(stable.publicMcpAbi).toBe("stable");
      expect(productPublicMcpIdentity(stable.publicMcpAbi)).toEqual({
        connectorName: "ChatGPT Tela",
        webContract: "stable",
      });
      expect(productPublicMcpIdentity("stable")).toEqual({
        connectorName: "ChatGPT Tela",
        webContract: "stable",
      });
      expect(productPublicMcpIdentity("unified-development")).toEqual({
        connectorName: "ChatGPT Tela Development",
        webContract: "development",
      });
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI: "future-v3",
      })).toThrow("PUBLIC_MCP_ABI");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("extra profiles require the explicit Multi-Profile adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-multi-"));
    const launcher = join(root, "codex-profile");
    writeFileSync(launcher, "fixture", { mode: 0o700 });
    chmodSync(launcher, 0o700);
    try {
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2",
      })).toThrow("slot 1");
      const config = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2",
        CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
        CHATGPT_TELA_PRODUCT_TARGET_ID: "local.profile2",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      });
      expect(config.nativeTarget).toEqual({
        kind: "multi-profile",
        targetId: "local.profile2",
        launcherCli: launcher,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy launcher-bearing child env remains an explicit Multi-Profile compatibility path", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-legacy-multi-"));
    const launcher = join(root, "codex-profile");
    writeFileSync(launcher, "fixture", { mode: 0o700 });
    try {
      const config = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_TARGET_ID: "default",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      });
      expect(config.nativeTarget.kind).toBe("multi-profile");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
