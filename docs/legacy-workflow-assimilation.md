# Legacy workflow assimilation and retirement-readiness

ChatGPT Tela is intended to become self-sufficient enough that the maintainer could stop using the older
local workflow projects without losing required behavior. This is a **retirement-readiness** target, not an
automatic removal plan: Tela must never uninstall, delete, or mutate those projects merely because parity has
been reached.

The reference systems remain useful until their relevant behavior has been independently implemented,
tested, and dogfooded through Tela's own authority boundaries:

| Reference workflow | Tela owner | Retirement-ready gate | Current state |
| --- | --- | --- | --- |
| DevSpace local patches | Tela Chat | routine local development can be completed through Tela Chat with equivalent workspace/instruction, bounded file, transactional edit, process, worktree, review, artifact, skills, and delegated-agent ergonomics | **partial** — workspace/instructions/exploration/standard skills/read/patch/process/review/incidents/worktrees/agents exist; native file ingress, review baselines/UI, legacy DevSpace-only skill migration, and sandboxed agent process authority remain |
| CodexGPTWeb local patches | Tela Codex | the final downstream parity audit passes against the retained snapshot/current upstream and normal Work can use Native + explicit `(Web)` models without the old bridge | **advanced partial** — tracked in `codexgptweb-assimilation.md`; most ledger items are absorbed and Profile 1 exact-turn/tool/retention/context proofs are live-proven, while remaining partial/pending items still block retirement-readiness |
| Permity | product UI + ChatGPT semantic approval policy | Tela covers every Permity behavior the maintainer still relies on, with explicit policy/UX decisions for any deliberately rejected behavior | **partial** — opt-in fail-closed recognized one-shot approval and product preference/diagnostics are absorbed; general allowlist/full-access policy, bounded delays, unknown-approval evidence/review, browser/AX adapters, and Work-handoff policy are not yet assimilated |
| LJY's Menu Bar | product UI / lifecycle | Tela's own menu bar/Control Center covers the surviving daily controls after DevSpace/CodexGPTWeb retirement-readiness, without importing backend authority into the UI | **partial** — split-service/profile control, approval preference, diagnostics, bridge preview, updates/settings surfaces and signed lifecycle ownership exist; legacy DevSpace/CodexWeb aggregate controls remain useful until those systems themselves become unnecessary |

## Completion rule

For each reference workflow, `retirement-ready` means all of the following are true:

1. **Behavior inventory** — the functions the maintainer actually uses are listed. Historical implementation
   details that are no longer desirable are not copied merely for numerical parity.
2. **Authority-preserving implementation** — Tela implements the requirement inside the correct Gateway,
   Chat, Codex, UI, or lifecycle owner rather than reproducing a convenient legacy coupling.
3. **Regression proof** — the incident or workflow that justified the legacy behavior has an equivalent Tela
   test or bounded live proof.
4. **Dogfood proof** — normal Tela development/operation can use Tela itself without reaching for the reference
   project as a hidden permanent dependency.
5. **Removal simulation** — documentation and diagnostics contain no correctness dependency on the reference
   installation. The reference may remain installed, but disabling it would not break the validated Tela path.

Only a human decides whether to actually retire/remove a reference project after these gates pass.

## DevSpace assimilation ledger

The initial Tela Chat parity backlog is behavioral, not source-copy based:

| DevSpace behavior | Tela state |
| --- | --- |
| Approved workspace identity and reuse | **absorbed** |
| Root project instructions + explicit nested instruction discovery | **absorbed** |
| Bounded file read/read-many | **absorbed** |
| Transactional patch with containment checks | **absorbed** |
| Resumable/idempotent process operations | **absorbed** |
| Git-backed current + historical review | **absorbed** — self-contained historical checkpoints, compact summaries, persistent private `last_shown` deltas, and explicit `workspace_open` comparison are implemented without writing review refs/objects into the user repository; richer host review UI is tracked separately |
| Ownership-safe isolated Git worktrees | **absorbed** |
| Privacy-safe incident records | **absorbed** |
| Durable bounded delegated agents | **partial** — provider-neutral lifecycle exists; provider breadth and safe process authority remain |
| Code/directory search and efficient repository exploration | **absorbed** — bounded `list_directory` + recursive `search_text`, with dependency/build and symlink traversal excluded by contract |
| Standard/project skills discovery and loading | **absorbed** — project `.agents/skills` + standard global `~/.agents/skills`, bounded `read_skill`, project-over-global precedence; legacy DevSpace-only skill migration remains separate |
| Native ChatGPT file import into a workspace | **pending contract decision** — ChatGPT's file-parameter metadata names top-level tool input fields, while Tela's frozen generic Chat capability nests dynamic arguments. Do not break the frozen four-tool ABI or paste raw download URLs as a shortcut; a future ABI generation or dedicated proven file-ingress surface is required. |
| Host-facing review/artifact UX comparable to the mature workflow | **pending** |

## CodexGPTWeb assimilation ledger

The detailed, testable source of truth remains [`codexgptweb-assimilation.md`](codexgptweb-assimilation.md).
That ledger, not the existence of a few successful `(Web)` turns, decides when the old bridge is
retirement-ready.

## Permity assimilation backlog

Tela intentionally does **not** broaden approval authority just to mimic Permity. The current safe default is
approval automation off; when enabled, Tela recognizes only one structurally unambiguous one-shot approval.
Before Permity can be considered retirement-ready, the maintainer's still-used Permity behaviors must be
audited and each one either implemented with an explicit Tela policy or deliberately rejected with a documented
replacement workflow. The audit includes allowlist/full-access modes, delays, evidence/history, desktop/browser
adapters, and Chat-to-Work handoff behavior.

## LJY's Menu Bar assimilation backlog

The Tela menu bar is product UI rather than a general controller for unrelated services. It should absorb the
daily controls that remain necessary **after** Tela Chat and Tela Codex become self-sufficient. Therefore its
retirement-readiness gate depends partly on the DevSpace and CodexGPTWeb gates: once those old runtimes are no
longer required, Tela should not recreate menu toggles whose only purpose was to operate them.
