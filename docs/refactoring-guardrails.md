# Selective integration and refactoring guardrails

This tracked review contract applies to material Tela patches, refactors and branch consolidation. The goal is useful completed work without regressions in correctness, recovery, context reuse, cost, or maintenance complexity. It complements `AGENTS.md`, `architecture.md` and `token-efficiency.md`.

## Before integration

1. Compare candidate behavior with **current main** and its recent fixes. Patch-unique commits do not prove unique needed functionality; never wholesale-merge an old tree to restore obsolete assumptions.
2. Classify every candidate as already implemented, minimally useful, unproven, or harmful. Absorb only the smallest verified behavior into the current shared owner or adapter. Preserve unmerged dirty work and its exact provenance.
3. Identify the affected consumers and one authoritative invariant. Do not duplicate ownership state, coordinators, fallback/retry paths, or incident-specific exception rules merely to close a particular report.

## Nonregression contracts

- Keep one writer per physical checkout and exact account, profile and Native turn authority. Failure labels are diagnostics, not independent settlement authority.
- A checkpoint or uncertain operation can be settled only under matching owner and proven physical release. Never fabricate remote success, replay uncertain sends or allow retired owners to execute again.
- Reuse proven Web sessions, canonical suffixes, completed checkpoint receipts and unchanged source fragments. Presentation failure or deterministic preflight refusal must not cause an unnecessary new browser, cold reconstruction, model call or duplicate transfer.
- Keep archived lineage, bounded working context and resident Web occupancy distinct. Require the [long-history lifecycle gates](context-continuity-contract.md#implementation-sequence-and-acceptance): bounded fresh/maintenance input with growing archives, no ordinary whole-history reconstruction and no rotation solely for checkpoint maintenance. Reject stale/ambiguous context without weakening proof or adding category-specific retries.
- Retain independent Tela Chat, Tela Codex and Plura state/lifecycle, and avoid idle polling, hidden extra model work, and unnecessary persistent configuration.

## Evidence required for material changes

Before/after review must report: (a) reproducible behavior and affected workflows; (b) `git diff --stat` and `--numstat`, including any new state machine, dependency, retry or duplicate logic; (c) typecheck, focused tests and full regressions where cross-cutting; (d) ownership, physical release, durable journal, retired-owner and successor recovery where relevant; (e) counted cold, retained, repeat, append, edit and recovery model calls, reused receipts, transfer estimates and useful final delivery; and (f) latency, CPU or idle cost where the change affects these. Mark unmeasured values as unknown, not improved.

Favor **deletion-first, destructive refactoring** over additive hardening. Before adding any guard, fallback, state, adapter or test, remove superseded ones; retain a test only when it exercises a distinct, reachable behavior or regression not already covered. Keep owner/permission fences, actual effect verification and replay/recovery invariants, but do not treat presentation-format differences or optional diagnostic failures as task failures. Do not impose an arbitrary line ceiling: necessary fixes can grow code, while unexplained growth needs concrete justification. Passing tests alone does not establish Web-model task success or cost parity.

**Preserve actionable logs and diagnostics while simplifying execution.** Do not delete structural failure/approval events or optional local evidence capture solely to reduce code or latency. Remove a diagnostic path only when its producer is unreachable, its evidence is obsolete, or another retained signal proves the same fact; record the reason. Diagnostics must not override the original task outcome, grant approval, retry a send or interfere with another owner.

## Completion

Integrate only verified minimal changes to clean `main`; record deferred work and remaining uncertainty in the local `STATE.md`. Do not delete worktrees, branches, Agent Workspace data, conversations, checkpoints or signed rollback assets until exact ownership and safe retirement are proved. Once consolidation is complete, verify `main` and use the official signed installation and restore procedure. Distinguish source tests, installed readiness and actual model acceptance.

## Rolling-context integration gates (2026-10-17 source)

The working-set projection has one shared selector (`native-working-context.ts`),
one existing durable stage execution journal (extended only with published
derived pointers), one disposable cache and one per-physical-generation usage
estimate. Reject a second ledger, independent compaction retry path, implicit
Web capacity inferred from Native metadata or checkpoint-triggered Web reset.
Existing stage receipt identities and pending-send fencing must remain intact.

Require zero new model calls on compatible journal-published checkpoint reuse,
including after disposable cache loss. Edited ancestry or changed route/effort
must invalidate reuse by source/route scope. Test updates during a retained Web
page and multiple physical rollovers, without preload/ACK. Large exact active
work must fail before spending checkpoint model calls. Keep counted requests,
transfer estimates and source-only fixture results distinct from unmeasured
provider billing and partially failed/unowned OS windows. Successfully acquired
task, summary and account/probe/setup surfaces are counted at the same existing
Electron BrowserHost lifecycle without a second journal or retry mechanism.
