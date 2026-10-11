import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ProcessRetirement } from "./process-retirement";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-retirement-")), storePath = join(base, "operations.json"), operationId = randomUUID();
  mkdirSync(`${storePath}.results`); mkdirSync(`${storePath}.executions`);
  const result = join(`${storePath}.results`, `${operationId}.bin`), claim = join(`${storePath}.executions`, `${operationId}.claim.json`);
  writeFileSync(result, "signed-elsewhere-output"); writeFileSync(claim, "signed-elsewhere-claim");
  const open = () => new ProcessRetirement({ storePath, key: "1".repeat(64) });
  const operation = { operationId, state: "exited" };
  const prepare = (kinds: ("result" | "claim")[]) => open().prepare(operation, kinds.map(kind => ({ kind,
    digest: createHash("sha256").update(readFileSync(kind === "result" ? result : claim)).digest("hex") })));
  return { base, storePath, operation, result, claim, plan: `${storePath}.retirement.json`, open, prepare };
}
describe("authenticated process retirement", () => {
  test("replacement between authentication and preparation cannot acquire deletion authority", () => {
    const f = fixture();
    try {
      const digest = createHash("sha256").update(readFileSync(f.result)).digest("hex");
      writeFileSync(f.result, "unapproved-replacement");
      expect(() => f.open().prepare(f.operation, [{ kind: "result", digest }])).toThrow("changed since authentication");
      expect(existsSync(f.plan)).toBe(false); expect(readFileSync(f.result, "utf8")).toBe("unapproved-replacement");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
  test("failed registry commit preserves all artifacts; new instance resumes before removal", () => {
    const f = fixture();
    try {
      f.prepare(["result", "claim"]);
      expect(() => f.open().resume(() => { throw new Error("registry write failed"); })).toThrow("registry write failed");
      expect(readFileSync(f.result, "utf8")).toBe("signed-elsewhere-output");
      expect(existsSync(f.claim)).toBe(true); expect(existsSync(f.plan)).toBe(true);
      expect(f.open().resume(value => {
        expect(value).toEqual(f.operation); expect(existsSync(f.result)).toBe(true);
        writeFileSync(f.storePath, "committed removal");
      })).toBe(true);
      expect(existsSync(f.result)).toBe(false); expect(existsSync(f.claim)).toBe(false);
      expect(existsSync(f.plan)).toBe(false); expect(f.open().resume(() => { throw new Error("should not commit"); })).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
  test("interruption after one removal resumes only the authenticated remainder", () => {
    const f = fixture();
    try {
      f.prepare(["result", "claim"]); writeFileSync(f.storePath, "committed removal"); unlinkSync(f.result);
      expect(f.open().resume(() => expect(readFileSync(f.storePath, "utf8")).toBe("committed removal"))).toBe(true);
      expect(existsSync(f.claim)).toBe(false); expect(existsSync(f.plan)).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
  test("one changed remaining artifact blocks registry commit and every deletion", () => {
    const f = fixture();
    try {
      f.prepare(["result", "claim"]); writeFileSync(f.claim, "replaced"); let committed = false;
      expect(() => f.open().resume(() => { committed = true; })).toThrow("artifact changed");
      expect(committed).toBe(false); expect(existsSync(f.result)).toBe(true); expect(existsSync(f.plan)).toBe(true);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
  test("directory replacement with identical bytes cannot borrow previous ownership", () => {
    const f = fixture();
    try {
      f.prepare(["result"]); renameSync(`${f.storePath}.results`, `${f.storePath}.original`); mkdirSync(`${f.storePath}.results`);
      writeFileSync(f.result, "signed-elsewhere-output");
      expect(() => f.open().resume(() => { throw new Error("must not commit"); })).toThrow("directory identity changed");
      expect(existsSync(f.result)).toBe(true); expect(existsSync(f.plan)).toBe(true);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
  test("tampered or incomplete plan fails before deletion and cannot be replaced", () => {
    const f = fixture();
    try {
      f.prepare(["result"]); const envelope = JSON.parse(readFileSync(f.plan, "utf8"));
      envelope.body = envelope.body.replace("exited", "unknown"); writeFileSync(f.plan, JSON.stringify(envelope));
      expect(() => f.open().resume(() => { throw new Error("must not commit"); })).toThrow("authentication failed");
      expect(existsSync(f.result)).toBe(true); writeFileSync(f.plan, "{");
      expect(() => f.open().resume(() => {})).toThrow();
      expect(() => f.prepare(["result"])).toThrow(); expect(readFileSync(f.plan, "utf8")).toBe("{");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
  test("symlink artifact and oversized plan are refused without registry mutation", () => {
    const f = fixture();
    try {
      if (process.platform !== "win32") {
        unlinkSync(f.result); symlinkSync(f.claim, f.result);
        expect(() => f.prepare(["result"])).toThrow(); expect(existsSync(f.plan)).toBe(false);
      }
      writeFileSync(f.plan, "x".repeat(16 * 1024 + 1));
      expect(() => f.open().resume(() => { throw new Error("must not commit"); })).toThrow(); expect(existsSync(f.claim)).toBe(true);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
});
