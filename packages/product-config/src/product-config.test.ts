import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProductConfig, readProductConfig, resolveProductConfigPath, writeProductConfig } from "./product-config";

describe("product-native config", () => {
  test("stores canonical config under the product config root with no browser-profile dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-config-"));
    const launcher = join(root, "plura");
    writeFileSync(launcher, "fixture");
    try {
      const path = resolveProductConfigPath({ platform: "linux", home: root, environment: {} });
      expect(path).toBe(join(root, ".config", "chatgpt-tela", "product-v1.json"));
      writeProductConfig({
        version: 1,
        multiProfile: { launcherCli: launcher },
        publicMcpAbi: "stable",
        exposure: { kind: "tailscale-funnel", publicUrl: "https://example.invalid/chatgpt-tela", localPort: 18743,
          authentication: "none", allowUnauthenticatedPublicEndpoint: true, tailscaleCli: "tailscale" },
      }, path);
      expect(readProductConfig(path)).toEqual({
        version: 1,
        multiProfile: { launcherCli: launcher },
        publicMcpAbi: "stable",
        exposure: { kind: "tailscale-funnel", publicUrl: "https://example.invalid/chatgpt-tela", localPort: 18743,
          authentication: "none", allowUnauthenticatedPublicEndpoint: true, tailscaleCli: "tailscale" },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("uses one stable public ABI and rejects unknown selectors", () => {
    const base = {
      version: 1,
      exposure: { kind: "existing-https", publicUrl: "https://example.invalid/mcp", localPort: 18743,
        authentication: "none", allowUnauthenticatedPublicEndpoint: true },
    } as const;
    expect(parseProductConfig(base)).toMatchObject({ publicMcpAbi: "stable" });
    expect(parseProductConfig({ ...base, publicMcpAbi: "stable" })).toMatchObject({ publicMcpAbi: "stable" });
    expect(() => parseProductConfig({ ...base, publicMcpAbi: "tools-v3-unproven" })).toThrow("public MCP ABI");
  });

  test("canonical parser rejects legacy and unknown fields instead of silently carrying compatibility forever", () => {
    const base = {
      version: 1,
      publicMcpAbi: "stable",
      exposure: { kind: "existing-https", publicUrl: "https://example.invalid/mcp", localPort: 18743,
        authentication: "none", allowUnauthenticatedPublicEndpoint: true },
    };
    expect(() => parseProductConfig({ ...base, launcherCli: "/legacy" })).toThrow("unknown fields");
    expect(() => parseProductConfig({ ...base, nativeTarget: { kind: "default-desktop" } })).toThrow("unknown fields");
    expect(() => parseProductConfig({ ...base, surprise: true })).toThrow("unknown fields");
  });

  test("rejects URL query/credentials and symlink launcher paths", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-config-unsafe-"));
    const target = join(root, "launcher-target");
    const link = join(root, "launcher-link");
    writeFileSync(target, "fixture");
    symlinkSync(target, link);
    try {
      expect(() => parseProductConfig({
        version: 1,
        multiProfile: { launcherCli: link },
        publicMcpAbi: "stable",
        exposure: { kind: "existing-https", publicUrl: "https://example.invalid/mcp?secret=x", localPort: 18743,
          authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a missing optional multi-profile launcher does not invalidate the single-profile product config", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-config-optional-missing-"));
    try {
      const missing = join(root, "plura-not-installed");
      expect(parseProductConfig({
        version: 1,
        multiProfile: { launcherCli: missing },
        publicMcpAbi: "stable",
        exposure: { kind: "existing-https", publicUrl: "https://example.invalid/mcp", localPort: 18743,
          authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      })).toMatchObject({
        multiProfile: { launcherCli: missing },
        publicMcpAbi: "stable",
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("config file itself must be a regular non-symlink file", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-config-file-"));
    const path = join(root, "product-v1.json");
    mkdirSync(path);
    try { expect(() => readProductConfig(path)).toThrow("unsafe"); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
