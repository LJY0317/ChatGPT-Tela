import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProductPaths } from "./layout";
import { assertChatProcessStoreCompatible, CHAT_PROCESS_STORE_FILENAME, CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY,
  parseChatProcessStoreCompatibility } from "./chat-process-storage";

test("compatibility metadata rejects ambiguous claims and freezes the declared contract", () => {
  for (const value of [null, [], {}, { readVersions: [], writeVersion: 1 },
    { readVersions: [1, 1], writeVersion: 1 }, { readVersions: [1], writeVersion: 2 },
    { readVersions: [1.5], writeVersion: 1.5 }, { readVersions: [0], writeVersion: 0 },
    { readVersions: [65536], writeVersion: 65536 }, { readVersions: [1], writeVersion: 1, surprise: true }]) {
    expect(() => parseChatProcessStoreCompatibility(value)).toThrow("compatibility");
  }
  const versions = [1, 2], parsed = parseChatProcessStoreCompatibility({ readVersions: versions, writeVersion: 2 });
  versions.push(3);
  expect(parsed.readVersions).toEqual([1, 2]); expect(Object.isFrozen(parsed.readVersions)).toBe(true);
});

test("canonical state inspection checks compatibility without rewriting bytes across platform layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-storage-compatibility-"));
  try {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const paths = resolveProductPaths({ platform, home: join(root, platform), environment: {} });
      expect(() => assertChatProcessStoreCompatible(paths)).not.toThrow();
      mkdirSync(paths.serviceState("chat"), { recursive: true });
      const file = join(paths.serviceState("chat"), CHAT_PROCESS_STORE_FILENAME);
      for (const version of [1, 2, 3]) {
        const bytes = JSON.stringify({ version, nextSessionId: 1024, requestKey: "synthetic", operations: [] });
        writeFileSync(file, bytes);
        if (version === 1) expect(() => assertChatProcessStoreCompatible(paths)).not.toThrow();
        else expect(() => assertChatProcessStoreCompatible(paths)).toThrow("cannot read");
        if (version <= 2) expect(() => assertChatProcessStoreCompatible(paths, CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY)).not.toThrow();
        else expect(() => assertChatProcessStoreCompatible(paths, CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY)).toThrow("cannot read");
        if (version === 2) expect(() => assertChatProcessStoreCompatible(paths, { readVersions: [1, 2], writeVersion: 1 })).toThrow("downgrade");
        expect(readFileSync(file, "utf8")).toBe(bytes);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt, oversized, symlink file or directory never implies an empty compatible store", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-storage-unsafe-"));
  try {
    const paths = resolveProductPaths({ platform: "linux", home: root, environment: {} });
    mkdirSync(paths.serviceState("chat"), { recursive: true });
    const file = join(paths.serviceState("chat"), CHAT_PROCESS_STORE_FILENAME);
    for (const bytes of ["{", "[]", "{}", JSON.stringify({ version: "1" }), " ".repeat(1024 * 1024 + 1)]) {
      writeFileSync(file, bytes); expect(() => assertChatProcessStoreCompatible(paths)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
    writeFileSync(file, '{"requestKey":"synthetic-private-marker",invalid}');
    try { assertChatProcessStoreCompatible(paths); throw new Error("fixture must refuse"); }
    catch (error) { expect(String(error)).toContain("JSON is invalid"); expect(String(error)).not.toContain("synthetic-private-marker"); }
    rmSync(file); const foreign = join(root, "foreign"); writeFileSync(foreign, '{"version":1}');
    symlinkSync(foreign, file); expect(() => assertChatProcessStoreCompatible(paths)).toThrow("unsafe");
    rmSync(file); rmSync(paths.serviceState("chat"), { recursive: true });
    const directory = join(root, "foreign-directory"); mkdirSync(directory);
    symlinkSync(directory, paths.serviceState("chat"));
    expect(() => assertChatProcessStoreCompatible(paths)).toThrow("unsafe");
    expect(readFileSync(foreign, "utf8")).toBe('{"version":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
