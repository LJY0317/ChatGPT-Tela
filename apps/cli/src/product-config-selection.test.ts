import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProductConfig } from "@chatgpt-tela/product-config";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { hasEffectiveProductConfig, nativeProductConfigPath, readEffectiveProductConfig } from "./product-config-selection";

const exposure = (port: number) => ({
  kind: "existing-https" as const,
  publicUrl: `https://example.invalid/mcp-${port}`,
  localPort: port,
  authentication: "none" as const,
  allowUnauthenticatedPublicEndpoint: true as const,
});

describe("CLI product config selection", () => {
  test("uses only canonical product-native storage", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-config-selection-"));
    try {
      const productPaths = resolveProductPaths({ platform: "linux", home: root, environment: {} });
      expect(hasEffectiveProductConfig(productPaths)).toBe(false);
      writeProductConfig({ version: 1, publicMcpAbi: "stable", exposure: exposure(18743) }, nativeProductConfigPath(productPaths));
      expect(hasEffectiveProductConfig(productPaths)).toBe(true);
      expect(readEffectiveProductConfig(productPaths).exposure.localPort).toBe(18743);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("reads the canonical config directly", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-config-selection-native-"));
    try {
      const productPaths = resolveProductPaths({ platform: "linux", home: root, environment: {} });
      writeProductConfig({ version: 1, publicMcpAbi: "unified-development", exposure: exposure(18744) }, nativeProductConfigPath(productPaths));
      const selected = readEffectiveProductConfig(productPaths);
      expect(selected.publicMcpAbi).toBe("unified-development");
      expect(selected.exposure.localPort).toBe(18744);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a corrupt canonical file fails closed instead of silently reviving legacy config", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-config-selection-corrupt-"));
    try {
      const productPaths = resolveProductPaths({ platform: "linux", home: root, environment: {} });
      const canonical = nativeProductConfigPath(productPaths);
      writeProductConfig({ version: 1, publicMcpAbi: "stable", exposure: exposure(18744) }, canonical);
      writeFileSync(canonical, "{not-json\n");
      expect(() => readEffectiveProductConfig(productPaths)).toThrow("unreadable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
