import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProductProfileRuntimeConfig } from "@chatgpt-tela/development-runtime";
import { parseProductConfig, readProductConfig, writeProductConfig } from "@chatgpt-tela/product-config";
import { selectAppOwnedProfileIngress } from "./profile-selection";

test("install-owned configuration opts into a stable app-owned endpoint without changing managed defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "tela-app-owned-config-"));
  const path = join(home, "product-v1.json");
  try {
    const environment = {
      CHATGPT_TELA_PROFILE_ROOT: join(home, "profiles"),
      CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "1",
      CHATGPT_TELA_PRODUCT_ROUTE_ID: "route1234",
      CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48),
      CHATGPT_TELA_PRODUCT_UI_TOKEN: "u".repeat(48),
    };
    const profile = loadProductProfileRuntimeConfig(environment);
    const base = {
      version: 1,
      publicMcpAbi: "stable",
      exposure: { kind: "existing-https", publicUrl: "https://example.invalid/mcp", localPort: 18743,
        authentication: "none", allowUnauthenticatedPublicEndpoint: true },
    } as const;
    expect(selectAppOwnedProfileIngress(profile, parseProductConfig(base))).toBeUndefined();
    expect(profile.nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
    const input = { ...base, appOwnedResponses: [{ slot: 1, port: 18744, capability: "a".repeat(48) }] };
    writeProductConfig(parseProductConfig(input), path);
    const first = selectAppOwnedProfileIngress(profile, readProductConfig(path));
    const afterRestart = selectAppOwnedProfileIngress(profile, readProductConfig(path));
    expect(first).toEqual({ port: 18744, capability: "a".repeat(48) });
    expect(afterRestart).toEqual(first);
    expect(() => selectAppOwnedProfileIngress({ ...profile, nativeTarget: {
      kind: "multi-profile", targetId: "external", launcherCli: "/fixture",
    } }, readProductConfig(path))).toThrow("does not match its Desktop profile slot");
    const launcher = join(home, "plura.fixture");
    writeFileSync(launcher, "fixture");
    const additional = loadProductProfileRuntimeConfig({ ...environment,
      CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2", CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
      CHATGPT_TELA_PRODUCT_TARGET_ID: "managed.fixture.2", CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
    });
    expect(selectAppOwnedProfileIngress(additional, { ...parseProductConfig(base),
      appOwnedResponses: [{ slot: 2, port: 18745, capability: "b".repeat(48) }],
    })).toEqual({ port: 18745, capability: "b".repeat(48) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("app-owned configuration refuses public MCP port reuse, duplicate slots, and unsupported owners", () => {
  const base = {
    version: 1,
    exposure: { kind: "existing-https", publicUrl: "https://example.invalid/mcp", localPort: 18743,
      authentication: "none", allowUnauthenticatedPublicEndpoint: true },
  } as const;
  const entry = { slot: 1, port: 18744, capability: "a".repeat(48) };
  expect(() => parseProductConfig({ ...base, appOwnedResponses: [{ ...entry, port: 18743 }] })).toThrow("distinct");
  expect(() => parseProductConfig({ ...base, appOwnedResponses: [entry, entry] })).toThrow("distinct");
  expect(() => parseProductConfig({ ...base, appOwnedResponses: [{ ...entry, slot: 2 }] }))
    .toThrow("optional Multi-Profile adapter");
  expect(() => parseProductConfig({ ...base, appOwnedResponses: [{ ...entry, capability: "short" }] })).toThrow("secret");
});
