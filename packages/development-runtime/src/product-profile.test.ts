import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProductProfileRuntimeConfig,
  prepareProductWebDiscovery,
  productPublicMcpIdentity,
  startProductProfileRuntime,
} from "./product-profile";

function common(root: string): Record<string, string> {
  return {
    CHATGPT_TELA_PROFILE_ROOT: join(root, "profiles"),
    CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "1",
    CHATGPT_TELA_PRODUCT_ROUTE_ID: "route1234",
    CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: "r".repeat(48),
    CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48),
    CHATGPT_TELA_PRODUCT_UI_TOKEN: "u".repeat(48),
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
      expect(config.approvalAutomationDelayMs).toBe(0);
      expect(config.acceptanceSavedChat).toBe(false);
      expect(config).not.toHaveProperty("webTurnTimeoutMs");
      expect(JSON.stringify(config)).not.toContain("launcherCli");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ordinary Work remains Temporary Chat unless the exact profile is explicitly selected for acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-saved-acceptance-"));
    try {
      expect(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "1",
      }).acceptanceSavedChat).toBe(true);
      expect(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "2",
      }).acceptanceSavedChat).toBe(false);
      await expect(startProductProfileRuntime(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "1",
      }))).rejects.toThrow("Native-first runtime");
      for (const value of ["0", "-1", "100", "1,2", "01", "all", "true"]) {
        expect(() => loadProductProfileRuntimeConfig({
          ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: value,
        })).toThrow("ACCEPTANCE_SAVED_CHAT_SLOT");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("approval automation is explicit and limited to recognized one-shot cards", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-approval-"));
    try {
      const enabled = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "recognized_once",
        CHATGPT_TELA_APPROVAL_DELAY_MS: "2000",
      });
      expect(enabled.approvalAutomationMode).toBe("recognized_once");
      expect(enabled.approvalAutomationDelayMs).toBe(2_000);
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "recognized_once",
        CHATGPT_TELA_APPROVAL_DELAY_MS: "15001",
      })).toThrow("APPROVAL_DELAY_MS");
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "full_access",
      })).toThrow("APPROVAL_AUTOMATION_MODE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only an explicit diagnostic deadline limits the entire product Web task", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-deadline-"));
    try {
      expect(loadProductProfileRuntimeConfig({ ...common(root),
        CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS: "1500" }).webTurnTimeoutMs).toBe(1500);
      for (const value of ["0", "-1", "NaN", "1.5"]) {
        expect(() => loadProductProfileRuntimeConfig({ ...common(root),
          CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS: value })).toThrow("positive integer");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
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
    const launcher = join(root, "plura-desktop");
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
      rmSync(launcher);
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2",
        CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
        CHATGPT_TELA_PRODUCT_TARGET_ID: "local.profile2",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      })).toThrow("does not exist");
      // A removed optional provider must not change the standalone default:
      // no silent failover from an explicitly selected foreign owner.
      expect(loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      }).nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launcher path alone does not implicitly select the optional adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-legacy-multi-"));
    const launcher = join(root, "plura-desktop");
    writeFileSync(launcher, "fixture", { mode: 0o700 });
    try {
      const config = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_TARGET_ID: "default",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      });
      expect(config.nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


import { bindChatGptTelaAccount } from "./browser-profile";
import { ConnectorProbeState } from "./connector-probe-state";
import type { ElectronDevelopmentRuntime } from "./electron";
import type { ChatGptWebPreparationOptions } from "./profile-control";

for (const outcome of ["complete", "account-mismatch", "cleanup-failed"] as const) {
  test(`single product preparation journal: ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preparation-journal-"));
    try {
      const config = loadProductProfileRuntimeConfig(common(root));
      mkdirSync(config.browserProfile.userDataDir, { recursive: true });
      bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
      const marker = new ConnectorProbeState({ directory: config.browserProfile.userDataDir, connectorName: "Fixture" });
      const stages: string[] = [];
      const family = { key: "a".repeat(20), label: "Fixture", availableEfforts: ["medium"] as const };
      const runtime = {
        async prepareChatGptWebSession(options: ChatGptWebPreparationOptions) {
          options.onProfile({ capabilities: { observed: new Set(["composer", "send"]) }, account: {
            accountFingerprint: outcome === "account-mismatch" ? "b".repeat(64) : "a".repeat(64),
            accountStructure: "personal", containerFingerprint: "container",
          } });
          options.onFamilies?.([family]); options.onConnectorStarting?.();
          expect(marker.pending()).toBe(true);
          if (outcome === "cleanup-failed") throw new Error("cleanup failed");
          options.onConnectorProven?.();
          return { families: [family] };
        },
      } as unknown as ElectronDevelopmentRuntime;
      const operation = prepareProductWebDiscovery({ runtime, browserProfile: config.browserProfile,
        connectorName: "Fixture", signal: new AbortController().signal, stage: stage => stages.push(stage) });
      if (outcome === "complete") {
        expect((await operation).families).toEqual([family]); expect(marker.pending()).toBe(false);
        expect(stages.at(-1)).toBe("fresh_readiness_proof_complete");
      } else {
        await expect(operation).rejects.toThrow();
        expect(marker.pending()).toBe(outcome === "cleanup-failed");
        expect(stages).not.toContain("fresh_readiness_proof_complete");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
