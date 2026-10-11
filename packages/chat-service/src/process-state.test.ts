import { expect, test } from "bun:test";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceProcessState, writeExclusiveProcessState } from "./process-state";

test("flush failure preserves exclusive uncertainty and releases its file descriptor", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-state-flush-"));
  try {
    const path = join(root, "claim.json");
    let descriptor = -1;
    expect(() => writeExclusiveProcessState(path, "reserved", fd => {
      descriptor = fd;
      throw new Error("injected disk synchronization failure");
    })).toThrow("disk synchronization failure");
    expect(readFileSync(path, "utf8")).toBe("reserved");
    expect(() => fstatSync(descriptor)).toThrow();
    expect(() => writeExclusiveProcessState(path, "replacement")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("reserved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("immutable publication refuses symlinks without changing their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-state-link-"));
  try {
    const target = join(root, "original");
    writeExclusiveProcessState(target, "original");
    const link = join(root, "claim.json");
    symlinkSync(target, link);
    expect(() => writeExclusiveProcessState(link, "replacement")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed atomic publication preserves the destination and does not accumulate temporary payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-state-replace-"));
  try {
    const destination = join(root, "registry");
    mkdirSync(destination);
    writeFileSync(join(destination, "preserved"), "original");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => replaceProcessState(destination, "candidate")).toThrow();
      expect(existsSync(`${destination}.pending-v1`)).toBe(false);
      expect(readFileSync(join(destination, "preserved"), "utf8")).toBe("original");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a preexisting incomplete pending record never authorizes replacement or cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-state-pending-"));
  try {
    const path = join(root, "registry");
    writeExclusiveProcessState(path, "original");
    writeFileSync(`${path}.pending-v1`, "{");
    expect(() => replaceProcessState(path, "candidate")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(readFileSync(`${path}.pending-v1`, "utf8")).toBe("{");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
