import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessExecutionJournal } from "./process-execution-journal";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-execution-journal-"));
  const key = randomBytes(32).toString("hex");
  const journal = new ProcessExecutionJournal({ root, key });
  const request = { operationId: randomUUID(), workspaceId: `chatws_${randomUUID()}`, launchingServerId: randomUUID(), requestFingerprint: "1".repeat(64) };
  return { root, key, journal, request };
}

test("immutable claim and matching live/completion receipts survive reader restart", () => {
  const f = fixture();
  try {
    const claim = f.journal.reserve(f.request);
    const descriptor = { version: 1 as const, ownerId: claim.ownerId, operationId: claim.operationId, workspaceId: claim.workspaceId,
      endpoint: "http://127.0.0.1:12345/v1/operation", secret: randomBytes(32).toString("hex") };
    f.journal.publishLive(claim, descriptor);
    const restarted = new ProcessExecutionJournal({ root: f.root, key: f.key });
    expect(restarted.readClaim(claim.operationId)).toEqual(claim);
    expect(restarted.readLive(claim)).toEqual(descriptor);
    const completion = { state: "exited" as const, exitCode: 0, endedAt: new Date().toISOString(), resultFingerprint: "2".repeat(64), resultTruncated: false };
    f.journal.publishCompletion(claim, completion);
    expect(restarted.readCompletion(claim)).toEqual(completion);
    expect(restarted.readClaim(claim.operationId).launchingServerId).toBe(f.request.launchingServerId);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("workspace identity is opaque but bounded; operation paths still require UUIDs", () => {
  const f = fixture();
  try {
    const reserved = f.journal.reserve({ ...f.request, workspaceId: "registry-owned-workspace" });
    expect(f.journal.readClaim(reserved.operationId).workspaceId).toBe("registry-owned-workspace");
    for (const workspaceId of ["", " ", "a\nother", "x".repeat(257)]) {
      expect(() => f.journal.reserve({ ...f.request, operationId: randomUUID(), workspaceId })).toThrow("workspace identity");
    }
    expect(() => f.journal.reserve({ ...f.request, operationId: "../operation" })).toThrow("execution identity");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("duplicate launch cannot replace an existing claim, including an incomplete claim", () => {
  const f = fixture();
  try {
    const claim = f.journal.reserve(f.request);
    const path = join(f.root, `${claim.operationId}.claim.json`);
    const original = readFileSync(path, "utf8");
    expect(() => f.journal.reserve(f.request)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    writeFileSync(path, "{");
    expect(() => f.journal.readClaim(claim.operationId)).toThrow();
    expect(() => f.journal.reserve(f.request)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("other scope/owner or changed request cannot publish or acquire live authority", () => {
  const f = fixture();
  try {
    const claim = f.journal.reserve(f.request);
    const descriptor = { version: 1 as const, ownerId: claim.ownerId, operationId: claim.operationId, workspaceId: claim.workspaceId,
      endpoint: "http://127.0.0.1:12345/v1/operation", secret: randomBytes(32).toString("hex") };
    expect(() => f.journal.publishLive(claim, { ...descriptor, ownerId: randomUUID() })).toThrow("binding mismatch");
    expect(() => f.journal.publishLive({ ...claim, requestFingerprint: "3".repeat(64) }, descriptor)).toThrow("reservation");
    f.journal.publishLive(claim, descriptor);
    expect(() => f.journal.readLive({ ...claim, workspaceId: randomUUID() })).toThrow("reservation");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("corrupted or cross-phase evidence never becomes execution authority", () => {
  const f = fixture();
  try {
    const claim = f.journal.reserve(f.request);
    const path = join(f.root, `${claim.operationId}.claim.json`);
    const original = readFileSync(path, "utf8");
    const envelope = JSON.parse(original);
    envelope.body = envelope.body.replace(claim.ownerId, randomUUID());
    writeFileSync(path, JSON.stringify(envelope));
    expect(() => f.journal.readClaim(claim.operationId)).toThrow("authentication failed");
    writeFileSync(path, original);
    writeFileSync(join(f.root, `${claim.operationId}.live.json`), original);
    expect(() => f.journal.readLive(claim)).toThrow("authentication failed");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
