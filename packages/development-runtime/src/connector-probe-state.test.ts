import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ConnectorProbeState } from "./connector-probe-state";

describe("connector probe persistence marker", () => {
  test("records and clears only the exact connector probe ownership marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatgpt-tela-connector-probe-"));
    try {
      const state = new ConnectorProbeState({ directory, connectorName: "ChatGPT Tela" });
      expect(state.pending()).toBe(false);
      state.begin();
      expect(state.pending()).toBe(true);
      state.clear();
      expect(state.pending()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on replaced, malformed, or broadly-readable marker state", () => {
    const directory = mkdtempSync(join(tmpdir(), "chatgpt-tela-connector-probe-"));
    try {
      const state = new ConnectorProbeState({ directory, connectorName: "ChatGPT Tela" });
      writeFileSync(state.path, "{}\n", { mode: 0o600 });
      expect(() => state.pending()).toThrow("does not match");
      rmSync(state.path);

      writeFileSync(state.path, "fixture", { mode: 0o600 });
      rmSync(state.path);
      symlinkSync(join(directory, "missing"), state.path);
      expect(() => state.pending()).toThrow();
      rmSync(state.path);

      if (process.platform !== "win32") {
        writeFileSync(state.path, `${JSON.stringify({
          version: 1,
          connectorFingerprint: "x".repeat(64),
        })}\n`, { mode: 0o600 });
        chmodSync(state.path, 0o644);
        expect(() => state.pending()).toThrow("permissions are too broad");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
