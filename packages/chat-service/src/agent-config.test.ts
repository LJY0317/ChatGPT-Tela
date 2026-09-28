import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseChatAgentProvidersConfig,
  readChatAgentProvidersConfig,
  writeChatAgentProvidersConfig,
} from "./config";
import { createConfiguredChatAgentDriverFactories } from "./openai-agent";

describe("Tela Chat agent provider config", () => {
  test("persists provider model and secret reference without persisting the secret value", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-chat-agent-config-"));
    const path = join(root, "agent-providers-v1.json");
    try {
      writeChatAgentProvidersConfig(path, {
        version: 1,
        providers: [{
          id: "openai-responses",
          enabled: true,
          model: "gpt-test-agent",
          apiKeyEnv: "OPENAI_API_KEY",
          credentialId: "agent.openai-responses.api-key",
        }],
      });
      expect(readChatAgentProvidersConfig(path)).toEqual({
        version: 1,
        providers: [{
          id: "openai-responses",
          enabled: true,
          model: "gpt-test-agent",
          apiKeyEnv: "OPENAI_API_KEY",
          credentialId: "agent.openai-responses.api-key",
        }],
      });
      expect(readFileSync(path, "utf8")).not.toContain("sk-");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("missing config means no provider and parser rejects unsafe or unknown fields", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-chat-agent-config-empty-"));
    try {
      expect(readChatAgentProvidersConfig(join(root, "missing.json"))).toEqual({ version: 1, providers: [] });
      expect(() => parseChatAgentProvidersConfig({
        version: 1,
        providers: [{
          id: "openai-responses",
          enabled: true,
          model: "gpt-test-agent",
          apiKeyEnv: "bad-key",
        }],
      })).toThrow("apiKeyEnv");
      expect(() => parseChatAgentProvidersConfig({
        version: 1,
        providers: [{
          id: "openai-responses",
          enabled: true,
          model: "gpt-test-agent",
          apiKeyEnv: "OPENAI_API_KEY",
          secret: "must-not-be-accepted",
        }],
      })).toThrow("unknown fields");
      expect(() => parseChatAgentProvidersConfig({
        version: 1,
        providers: [{ id: "openai-responses", enabled: true, model: "gpt-test-agent" }],
      })).toThrow("requires apiKeyEnv or credentialId");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("enabled provider is availability-gated by its referenced environment secret", () => {
    const config = parseChatAgentProvidersConfig({
      version: 1,
      providers: [{
        id: "openai-responses",
        enabled: true,
        model: "gpt-test-agent",
        apiKeyEnv: "OPENAI_API_KEY",
      }],
    });
    expect(createConfiguredChatAgentDriverFactories(config, {})).toHaveLength(0);
    const factories = createConfiguredChatAgentDriverFactories(config, {
      OPENAI_API_KEY: "sk-fixture-secret-value-long-enough",
    });
    expect(factories).toHaveLength(1);
    const driver = factories[0]!({
      read() { return {}; },
      readMany() { return []; },
      applyPatch() { return {}; },
      async showChanges() { return {}; },
    });
    expect(driver.id).toBe("openai-responses");
  });

  test("credential store is a fallback after the environment and store failures keep Chat healthy", async () => {
    const { createResolvedChatAgentDriverFactories } = await import("./openai-agent");
    const config = parseChatAgentProvidersConfig({
      version: 1,
      providers: [{
        id: "openai-responses",
        enabled: true,
        model: "gpt-test-agent",
        apiKeyEnv: "OPENAI_API_KEY",
        credentialId: "agent.openai-responses.api-key",
      }],
    });
    let lookups = 0;
    expect(await createResolvedChatAgentDriverFactories(config, {
      environment: { OPENAI_API_KEY: "sk-env-fixture-value-long-enough" },
      credentials: { async get() { lookups += 1; return "sk-store-fixture-value-long-enough"; } },
    })).toHaveLength(1);
    expect(lookups).toBe(0);
    expect(await createResolvedChatAgentDriverFactories(config, {
      environment: {},
      credentials: { async get() { lookups += 1; return "sk-store-fixture-value-long-enough"; } },
    })).toHaveLength(1);
    expect(lookups).toBe(1);
    expect(await createResolvedChatAgentDriverFactories(config, {
      environment: {},
      credentials: { async get() { throw new Error("locked fixture store"); } },
    })).toHaveLength(0);
  });
});
