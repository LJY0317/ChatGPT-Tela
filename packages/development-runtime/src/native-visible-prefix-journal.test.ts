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
  const recovery = { ...id, claimId: claim.claimId, terminalOwnerFingerprint: hash("terminal Native turn"),
    reconciliationFingerprint: hash("owned profile quiescence receipt"), assertQuiescent: async () => { checks++; } };
  await expect(journal.reconcileQuiescentLegacy({ ...recovery, assertQuiescent: async () => { throw Error("profile owner still alive"); } })).rejects.toThrow("still alive");
  expect(await journal.claim(id, hash("new turn"))).toEqual({ status: "unknown" });
  await expect(journal.reconcileQuiescentLegacy({ ...recovery, claimId: "foreign" })).rejects.toThrow("selection changed");
  await journal.reconcileQuiescentLegacy(recovery);
  expect(checks).toBe(3);
  await journal.reconcileQuiescentLegacy(recovery); // Same receipt is an idempotent inspection, no resend.
  expect(await journal.claim(id, recovery.terminalOwnerFingerprint)).toEqual({ status: "unknown" });
  const next = await journal.claim(id, hash("new turn")); expect(next.status).toBe("claimed");
  await expect(journal.complete({ ...id, claimId: claim.claimId, status: "completed", summary: "late old summary" })).rejects.toThrow("owned claim");
}));
test("reconciliation refuses modern owners and a changed quiescence observation without mutation", () => fixture(async options => {
  const journal = new FileNativeVisiblePrefixStageJournal(options), id = identity();
  const claim = await journal.claim(id); if (claim.status !== "claimed") throw Error("fixture");
  const recovery = { ...id, claimId: claim.claimId, terminalOwnerFingerprint: hash("terminal"),
    reconciliationFingerprint: hash("receipt") };
  let checks = 0;
  await expect(journal.reconcileQuiescentLegacy({ ...recovery, assertQuiescent: async () => { if (++checks === 2) throw Error("owner changed"); } })).rejects.toThrow("owner changed");
  expect(await journal.claim(id)).toEqual({ status: "unknown" });
  const modern = identity(1), owner = hash("modern");
  const modernClaim = await journal.claim(modern, owner); if (modernClaim.status !== "claimed") throw Error("fixture");
  await expect(journal.reconcileQuiescentLegacy({ ...recovery, ...modern, claimId: modernClaim.claimId,
    assertQuiescent: async () => {} })).rejects.toThrow("legacy pending");
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
