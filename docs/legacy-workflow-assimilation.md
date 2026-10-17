# Legacy workflow assimilation and retirement-readiness

ChatGPT Tela is intended to become self-sufficient enough that the maintainer could stop using the older
local workflow projects without losing required behavior. This is a **retirement-readiness** target, not an
automatic removal plan: Tela must never uninstall, delete, or mutate those projects merely because parity has
been reached.

The reference systems remain useful until their relevant behavior has been independently implemented,
tested, and dogfooded through Tela's own authority boundaries:

| Reference workflow | Tela owner | Retirement-ready gate | Current state |
| --- | --- | --- | --- |
| DevSpace local patches | Tela Chat | the maintainer can read/edit local files directly from ordinary Chat, with approved folders, instructions, bounded transactional edits and reliable command execution | **advanced partial** — installed connector read/edit/create/command/replay/current and historical Git-review proof passes; installed folder controls exist. Ordinary-Chat onboarding/daily use remains. Delegated providers and richer cards are optional scope |
| Permity | product UI + ChatGPT semantic approval policy | Tela covers every Permity behavior the maintainer still relies on, with explicit policy/UX decisions for any deliberately rejected behavior | **partial** — opt-in fail-closed recognized one-shot approval and product preference/diagnostics are absorbed; general allowlist/full-access policy, bounded delays, unknown-approval evidence/review, browser/AX adapters, and Work-handoff policy are not yet assimilated |
| LJY's Menu Bar | product UI / lifecycle | Tela's own menu bar/Control Center covers the surviving daily controls without importing backend authority into the UI | **partial** — split-service/profile control, approval preference, diagnostics, bridge preview, updates/settings surfaces and signed lifecycle ownership exist; legacy DevSpace controls remain useful until no longer necessary |

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
| Durable bounded delegated agents | **partial** — bounded read/patch authority, cancellation checks before further tools, success-only durable continuation and per-turn read-only default are tested, including real workspace mutation/escape probes. Failed/interrupted tasks are never automatically replayed. Live provider proof, provider breadth and sandboxed process authority remain; delegated shell tools are not exposed. |
| Code/directory search and efficient repository exploration | **absorbed** — bounded `list_directory` + recursive `search_text`, with dependency/build and symlink traversal excluded by contract |
| Standard/project skills discovery and loading | **absorbed** — project `.agents/skills` + standard global `~/.agents/skills`, YAML multiline metadata, bounded UTF-8 supporting reads, project-over-global disable precedence and same-root collision rejection.10 focused tests + compiled Chat daemon pass; live host/provider skills proof and legacy DevSpace-only migration remain separate |
| Native ChatGPT file import into a workspace | **partial** — installed local-file publisher proven; source card now feature-detects the official ChatGPT library picker, retrieves bounded bytes using host-authorized file references, and reuses the publisher. Ten focused tests cover transfer/card Save, context initialization, cancellation/receipt mismatch, macOS compiled card execution, memory/size bounds, URL/error privacy and unchanged four-tool ABI. Only files.oaiusercontent.com is permitted. Live host/CSP/CORS, regional generated-file hosts, automatic conversation-file delivery and Windows/Linux remain unproven. |
| Workspace file download | **partial** — source export_file uses pinned native directory/file handles and bounded 2 MiB binary reads; snapshot receipt verified in Chat and the download card. Bytes are widget-only metadata, not model content; no public URL/cache/workspace writes. Rust8 + source10 + import regression5 tests and Chat/Gateway compile pass. Live host download acceptance and crossOS remain unverified. |
| Host-facing review/artifact UX comparable to the mature workflow | **partial** — `show_changes` and `show_review` select the read-only MCP Apps card without changing the frozen four-tool schema; source supports file filtering, captured historical status/new-file contents, and explicit partial/comparison failure states. Scripted card + real MCP routing tests pass; live ChatGPT host rendering remains unverified. File import source/installed publisher proofs are recorded separately. |

## Maintainer's required Chat workflow

The maintainer clarified that DevSpace is used directly from ChatGPT to read and edit local files;
external delegated agents are not a required replacement gate. Keep the broader inventory above as
optional product scope, rather than treating every delegated provider as a prerequisite for this use case.

For this replacement, the required gates are:

1. Connect the ChatGPT Tela connector in ordinary Chat and discover its Chat capabilities.
2. Explicitly approve a local folder and activate that policy without restarting Work/Codex.
3. Open/reuse the folder, read files, edit/create files transactionally, and read back the exact result.
4. Reject file path escapes; keep original files when removing folder access.
5. Verify the installed onboarding flow and normal daily Chat usage without DevSpace tools or lifecycle dependencies.

The existing installed connector has passed direct read/update/create/readback and local verification
command execution against a disposable acceptance folder, including denied read/write escapes. A later
installed Git-workspace proof also completed exact readback, resumable command collection, idempotent
replay, current change review and immutable historical review. It used
Tela Chat capabilities and no Native turn authority or DevSpace tools. The macOS approval/revocation UI
and Chat-only restart are implemented in a signed local preview; fake-manager tests prove peer services
are not restarted, and native view fixtures prove selection/pending/apply/cancel states. The preview is
installed, with preserved approved folders and a verified active-policy match. Ordinary-Chat onboarding
and daily-use confirmation remain before calling this scoped replacement retirement-ready.
The follow-up found that command dispatch rejected multiline scripts as single-line identifiers.
The command boundary is fixed and a signed candidate daemon passed multiline execution, exact readback,
idempotent replay and process-status checks in isolation. Deployment is pending profile coordination.
The Bun test spawn failure was traced to un-rooted test filters scanning ignored build directories.
Explicit rooted test paths pass all eight command/core-workflow tests (38 assertions); the default test
command now targets only product source roots. File-library/download/review cards remain separate live-host gates when needed.

### 2026-10-11 process-capacity and safe handoff source integration

Ordinary Tela Chat tool execution intermittently reported
`process operation registry is at capacity; no process was started`.
The retained process-operation reservations are **global across opened workspaces**;
a `list_processes` page for one workspace is not a measurement of the full
registry. The exact installed-instance pressure for the observed failure has
not been proven. The **source** limit was raised from 256 to 1,024, retaining
the 24-hour minimum terminal reservation window, the independent 1 MiB state
budget, authenticated retirement, monotonic session identities, and all
unresolved-execution reservations. Only a proven, expired terminal result may
be retired at capacity. Existing/current-high-water and recent-completion
tests were updated. The standalone process suite passed **27/27**; after
reconciling the `list_processes` / `process_status` inventory ordering, the
rooted Codex, runtime, and Chat service suite passed **285/285** and repository
TypeScript `--noEmit` passed. This resolves the **source-level headroom and
catalog-order regressions**; it does NOT establish a deployed binary fix or
license deleting/replaying process reservations in the currently running
service. No services were restarted.

In the same dirty `main` working tree, Codex public current-turn proof now
stops before `thread/turns/list` for Legacy, missing or unknown
`historyMode`, and rejects pagination mode changes. The optional automatic
Native handoff source is default-deny **before connecting**, including its
verification paths; only synthetic test fixtures explicitly opt in to the
unreleased fork behavior. Source-level tests pass, but these edits are
**not an authorized real 73 MiB Legacy acceptance**. Actual prior-turn model
provenance and encrypted compaction continuity remain unproven. The other
Plura Desktop repository's cross-account Work/Codex conversation research is
independent, must not be merged into Tela, and remains blocked on upstream
per-thread authenticated owner routing/Remote support. Do not delete those
active/recent foreign worktrees as a consequence of Tela parity progress.

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
retirement-readiness gate depends partly on the remaining DevSpace parity gate: once that older runtime is no
longer required, Tela should not recreate menu toggles whose only purpose was to operate them.
