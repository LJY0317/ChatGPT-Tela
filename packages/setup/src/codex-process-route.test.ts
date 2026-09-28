import { expect, test } from "bun:test";
import {
  CHATGPT_TELA_DEVELOPMENT_PROVIDER_ID,
  codexProcessRouteArguments,
} from "./codex-process-route";

test("development Codex route is process-local and never references a config file", () => {
  const args = codexProcessRouteArguments({
    baseUrl: "http://127.0.0.1:18741/",
    envKey: "CHATGPT_TELA_CANARY_RESPONSES_TOKEN",
  });
  expect(args[0]).toBe("--ignore-user-config");
  expect(args.join(" ")).toContain(`model_provider=\"${CHATGPT_TELA_DEVELOPMENT_PROVIDER_ID}\"`);
  expect(args.join(" ")).toContain('base_url="http://127.0.0.1:18741/v1"');
  expect(args.join(" ")).not.toContain("config.toml");
});

test("development Codex route rejects non-loopback endpoints and invalid env keys", () => {
  expect(() => codexProcessRouteArguments({
    baseUrl: "https://example.com/v1",
    envKey: "CHATGPT_TELA_CANARY_RESPONSES_TOKEN",
  })).toThrow("loopback http://");
  expect(() => codexProcessRouteArguments({
    baseUrl: "http://127.0.0.1:18741/v1",
    envKey: "bad-key",
  })).toThrow("uppercase environment variable");
});
