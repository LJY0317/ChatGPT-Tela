import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function identity(index = 0) {
  return { key: `native-visible-stage-${hash(String(index))}`, sourceDigest: hash("source"), inputDigest: hash(String(index)) };
}
async function fixture(run: (options: { directory: string; initializationPath: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tela-checkpoint-journal-"));
  try { await run({ directory: join(root, "browser", "journal"), initializationPath: join(root, "owner", "receipt") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("pending survives a new instance and only exact claim nonce can complete it", () => fixture(async options => {
  const one = new FileNativeVisiblePrefixStageJournal(options);
  const id = identity(); const claim = await one.claim(id);
  expect(claim.status).toBe("claimed"); if (claim.status !== "claimed") throw Error("fixture");
  const two = new FileNativeVisiblePrefixStageJournal(options);
  expect(await two.claim(id)).toEqual({ status: "unknown" });
  expect(await two.claim(id, hash("new explicit Native turn"))).toEqual({ status: "unknown" });
  await expect(two.complete({ ...id, status: "completed", claimId: "foreign", summary: "summary" })).rejects.toThrow("owned claim");
  expect(await two.claim(id)).toEqual({ status: "unknown" });
  await one.complete({ ...id, status: "completed", claimId: claim.claimId, summary: "verified summary" });
  expect(await two.claim(id)).toEqual({ ...id, status: "completed", summary: "verified summary" });
  await expect(two.claim({ ...id, sourceDigest: hash("foreign") })).rejects.toThrow("source changed");
}));
test("same-process concurrent journal instances grant exactly one claim", () => fixture(async options => {
  const claims = await Promise.all(Array.from({ length: 6 }, () => new FileNativeVisiblePrefixStageJournal(options).claim(identity())));
  expect(claims.filter(value => value.status === "claimed")).toHaveLength(1);
  expect(claims.filter(value => value.status === "unknown")).toHaveLength(5);
}));
test("locally closed operations need new Native authority and reject stale completions", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options), id = identity();
  const owner = hash("first Native turn"), nextOwner = hash("next Native turn");
  const first = await journal.claim(id, owner); if (first.status !== "claimed") throw Error("fixture");
  await expect(journal.settleClosed({ ...id, claimId: first.claimId, ownerFingerprint: nextOwner })).rejects.toThrow("owned claim");
  expect(await journal.claim(id, nextOwner)).toEqual({ status: "unknown" });
  await journal.settleClosed({ ...id, claimId: first.claimId, ownerFingerprint: owner });
  expect(await journal.claim(id, owner)).toEqual({ status: "unknown" });
  const next = await new FileNativeVisiblePrefixStageJournal(options).claim(id, nextOwner);
  expect(next.status).toBe("claimed");
  await expect(journal.complete({ ...id, claimId: first.claimId, status: "completed", summary: "old late answer" })).rejects.toThrow("owned claim");
  if (next.status !== "claimed") throw Error("fixture");
  await journal.complete({ ...id, claimId: next.claimId, status: "completed", summary: "new proven summary" });
  expect(await journal.claim(id, owner)).toMatchObject({ status: "completed", summary: "new proven summary" });
}));
test("legacy recovery requires repeated owner quiescence, exact selection and a new Native authority", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options), id = identity();
  const claim = await journal.claim(id); if (claim.status !== "claimed") throw Error("fixture");
  let checks = 0;
  const recovery = { ...id, claimId: claim.claimId, expectedOwnerFingerprint: null, retiredOwnerFingerprint: hash("terminal Native turn"),
    reconciliationFingerprint: hash("owned profile quiescence receipt"), assertReleased: async () => { checks++; } };
  await expect(journal.reconcileReleasedOperation({ ...recovery, assertReleased: async () => { throw Error("profile owner still alive"); } })).rejects.toThrow("still alive");
  expect(await journal.claim(id, hash("new turn"))).toEqual({ status: "unknown" });
  await expect(journal.reconcileReleasedOperation({ ...recovery, claimId: "foreign" })).rejects.toThrow("selection changed");
  await journal.reconcileReleasedOperation(recovery);
  expect(checks).toBe(3);
  await journal.reconcileReleasedOperation(recovery); // Same receipt is an idempotent inspection, no resend.
  expect(await journal.claim(id, recovery.retiredOwnerFingerprint)).toEqual({ status: "unknown" });
  const next = await journal.claim(id, hash("new turn")); expect(next.status).toBe("claimed");
  await expect(journal.complete({ ...id, claimId: claim.claimId, status: "completed", summary: "late old summary" })).rejects.toThrow("owned claim");
}));
test("reconciliation refuses a mismatched original owner and changed release proof without mutation", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options), id = identity();
  const claim = await journal.claim(id); if (claim.status !== "claimed") throw Error("fixture");
  const recovery = { ...id, claimId: claim.claimId, expectedOwnerFingerprint: null, retiredOwnerFingerprint: hash("terminal"),
    reconciliationFingerprint: hash("receipt") };
  let checks = 0;
  await expect(journal.reconcileReleasedOperation({ ...recovery, assertReleased: async () => { if (++checks === 2) throw Error("owner changed"); } })).rejects.toThrow("owner changed");
  expect(await journal.claim(id)).toEqual({ status: "unknown" });
  const modern = identity(1), owner = hash("modern");
  const modernClaim = await journal.claim(modern, owner); if (modernClaim.status !== "claimed") throw Error("fixture");
  await expect(journal.reconcileReleasedOperation({ ...recovery, ...modern, claimId: modernClaim.claimId,
    assertReleased: async () => {} })).rejects.toThrow("original owner changed");
}));
test("missing whole storage, missing state and interrupted writes never reinitialize execution", async () => {
  for (const failure of ["directory", "file", "incomplete", "corrupt", "lock"] as const) await fixture(async options => {
    const journal = new FileNativeVisiblePrefixStageJournal(options);
    await journal.claim(identity());
    const file = join(options.directory, "state.json");
    if (failure === "directory") await rm(options.directory, { recursive: true });
    if (failure === "file") await unlink(file);
    if (failure === "incomplete") await writeFile(file, "!" + (await readFile(file, "utf8")).slice(1));
    if (failure === "corrupt") await writeFile(file, "=not-json");
    if (failure === "lock") await writeFile(join(options.directory, "writer.lock"), "abandoned");
    await expect(new FileNativeVisiblePrefixStageJournal(options).claim(identity())).rejects.toThrow();
  });
});
test("pending admission is bounded and no pending identity is evicted", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options);
  for (let i = 0; i < 64; i++) expect((await journal.claim(identity(i))).status).toBe("claimed");
  await expect(journal.claim(identity(64))).rejects.toThrow("reconciliation");
  expect(await journal.claim(identity(0))).toEqual({ status: "unknown" });
  expect((await readFile(join(options.directory, "state.json"))).length).toBeLessThan(16 * 1024 * 1024);
}));
test("worst escaped completion fits reserved capacity and only completed entries can expire", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options);
  const summary = "\u0001".repeat(32 * 1024);
  for (let i = 0; i < 65; i++) {
    const id = identity(i), claim = await journal.claim(id);
    if (claim.status !== "claimed") throw Error("fixture");
    await journal.complete({ ...id, status: "completed", claimId: claim.claimId, summary });
  }
  expect((await journal.claim(identity(64))).status).toBe("completed");
  expect((await readFile(join(options.directory, "state.json"))).length).toBeLessThan(16 * 1024 * 1024);
}), 30_000);

test("released modern operation retains original claim and unknown outcome without authorizing its retired owner", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options);
  const id = { ...identity(77), key: `native-visible-stage-v2-${hash("owned modern stage")}` };
  const owner = hash("original Native turn"), scope = hash("account/thread"), root = hash("canonical source");
  const claim = await journal.claim(id, owner, root, scope);
  if (claim.status !== "claimed") throw Error("fixture");
  const recovery = { ...id, claimId: claim.claimId, expectedOwnerFingerprint: owner, retiredOwnerFingerprint: owner,
    reconciliationFingerprint: hash("verified owned generation release"), assertReleased: async () => {} };
  await expect(journal.reconcileReleasedOperation({ ...recovery, retiredOwnerFingerprint: hash("foreign") })).rejects.toThrow("owner identity");
  let checks = 0;
  await expect(journal.reconcileReleasedOperation({ ...recovery, assertReleased: async () => { if (++checks === 2) throw Error("generation changed"); } })).rejects.toThrow("generation changed");
  expect(await journal.pendingOperations()).toHaveLength(1);
  await journal.reconcileReleasedOperation(recovery);
  await journal.reconcileReleasedOperation(recovery);
  const state = JSON.parse((await readFile(join(options.directory, "state.json"), "utf8")).slice(1));
  expect(state.entries[0]).toMatchObject({ ...id, status: "closed", claimId: claim.claimId, ownerFingerprint: owner, remoteOutcome: "unknown" });
  expect(state.entries[0]).not.toHaveProperty("summary");
  expect((await journal.claim(id, owner, root, scope)).status).toBe("unknown");
  const changed = { ...id, key: `native-visible-stage-v2-${hash("changed model or source stage")}`, inputDigest: hash("changed input") };
  expect((await journal.claim(changed, owner, hash("grown source"), scope)).status).toBe("unknown");
  expect((await journal.claim(changed, hash("new Native turn"), hash("grown source"), scope)).status).toBe("claimed");
  await expect(journal.complete({ ...id, status: "completed", claimId: claim.claimId, summary: "late old result" })).rejects.toThrow("owned claim");
}));

test("completed receipt snapshots are immutable reads and never admit a pending send", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options), id = identity();
  expect(await journal.completedReceipts()).toEqual([]);
  const claim = await journal.claim(id);
  if (claim.status !== "claimed") throw Error("fixture");
  expect(await journal.completedReceipts()).toEqual([]);
  expect(await journal.pendingOperations()).toHaveLength(1);
  await journal.complete({ ...id, status: "completed", claimId: claim.claimId, summary: "verified" });
  const receipts = await new FileNativeVisiblePrefixStageJournal(options).completedReceipts();
  expect(receipts).toEqual([{ ...id, status: "completed", summary: "verified" }]);
  expect(Object.isFrozen(receipts[0])).toBe(true);
  expect(await journal.pendingOperations()).toHaveLength(0);
}));

test("published checkpoint rotation retains unique recovery heads beyond 32 scopes", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options);
  const publish = async (scope: number, revision: number) => {
    const sourceRootDigest = hash(`root-${scope}-${revision}`);
    const id = { key: `native-visible-stage-v2-${hash(`stage-${scope}-${revision}`)}`,
      sourceDigest: hash(`input-${scope}-${revision}`),
      inputDigest: hash(`wire-${scope}-${revision}`) };
    const claim = await journal.claim(id, hash(`owner-${scope}-${revision}`), sourceRootDigest, hash(`scope-owner-${scope}`));
    if (claim.status !== "claimed") throw Error("fixture claim rejected");
    const summary = `summary ${scope}-${revision}`;
    await journal.complete({ ...id, status: "completed", claimId: claim.claimId, summary });
    const content = JSON.stringify({ type: "tela_native_request_prefix_checkpoint_v1",
      sourceDigest: sourceRootDigest, completedStageKey: id.key, summary });
    await journal.publishCheckpoint({ scopeFingerprint: hash(`published-${scope}`),
      revisionId: `native_${hash(`revision-${scope}-${revision}`).slice(0, 20)}`,
      sourceRootDigest, stageKey: id.key, content,
      estimatedTokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4) });
  };
  for (let scope = 0; scope < 32; scope++) await publish(scope, 0);
  await publish(0, 1); // Old alternative in the same scope is disposable.
  expect(await journal.publishedCheckpoints(hash("published-0"))).toHaveLength(1);
  expect((await journal.publishedCheckpoints(hash("published-0")))[0]?.content).toContain("summary 0-1");
  expect(await journal.publishedCheckpoints(hash("published-31"))).toHaveLength(1);
  await publish(32, 0);
  expect(await journal.publishedCheckpoints(hash("published-0"))).toHaveLength(1);
  expect(await journal.publishedCheckpoints(hash("published-31"))).toHaveLength(1);
  expect(await journal.publishedCheckpoints(hash("published-32"))).toHaveLength(1);
}), 30_000);
