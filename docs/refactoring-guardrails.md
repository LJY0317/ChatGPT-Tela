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

Do not impose an arbitrary added-line ceiling: necessary fixes can grow code. Unexplained growth or a duplicated ownership/retry mechanism requires simplification or specific measured justification. Passing tests alone does not establish Web-model task completion or resource parity. An intentional cost regression requires documented correctness benefit and bounded comparison.

## Completion

Integrate only verified minimal changes to clean `main`; record deferred work and remaining uncertainty in the local `STATE.md`. Do not delete worktrees, branches, Agent Workspace data, conversations, checkpoints or signed rollback assets until exact ownership and safe retirement are proved. Once consolidation is complete, verify `main` and use the official signed installation and restore procedure. Distinguish source tests, installed readiness and actual model acceptance.
