# ChatGPT Tela

**One ChatGPT integration, two independent local runtimes: Chat and Codex.**

ChatGPT Tela is being refactored into one installable product with one **ChatGPT Tela Plugin** created by
connecting one MCP endpoint in ChatGPT, while keeping its two execution paths independent:

- **Tela Chat** — a new workspace/process/agent service built from first principles, using the local DevSpace
  patches as a behavioral reference rather than copied implementation;
- **Tela Codex** — the existing Native Codex/Web runtime, preserving exact Native authority, runtime tool
  discovery, context continuity, resumability, and same-turn tool continuation.

The two services share only a small **Tela Gateway** and the public ingress. A failure in Tela Chat must not
disable Tela Codex, and a failure in Tela Codex must not disable Tela Chat.

> **Status:** public pre-alpha source preview. ChatGPT Tela is under active construction and is not ready to
> replace an existing Codex workflow or be treated as a supported end-user release yet.

## Public source preview

This repository is intended to be safe to clone and inspect publicly even while the product remains
pre-alpha. A contributor can verify the source tree without any private project files:

```sh
git clone https://github.com/LJY0317/ChatGPT-Tela.git
cd ChatGPT-Tela
bun install --frozen-lockfile
bun run verify
```

Local maintainer working files such as `AGENTS.md`, `STATE.md`, and `MILESTONES.md` are intentionally
ignored. Credentials, browser profiles, Tailscale state, MCP secrets, and machine-specific runtime state must
stay outside Git. Running the live source runtime still requires the explicit development setup documented
below and should not be confused with an installer-supported release.

## Separate managed Web delegations

The source checkout supports `bun run cli web-delegate start --cwd /path/to/project --prompt-file /path/to/task.txt` against an already running, signed-in Tela Work profile. Use `bun run cli web-delegate capacity --slot 1` to inspect managed-job occupancy, `result --job UUID` to retrieve a proven answer. Control Center Work displays this managed-only count; Settings selects independent per-profile concurrency limits from 1 to 5 (default 3). Direct Native conversations are outside this journal. See [Web delegation details](docs/web-delegation.md) for prerequisites, capacity and result retention. Managed conversations archive 24 hours after result retrieval, or after seven idle days when uncollected; Tela deletes its own automatic archives 30 days later. Active/queued work and observed manual restores are protected; local result receipts remain.

Continue a finished job in the same conversation with `web-delegate continue --job UUID --prompt-file /path/to/followup.txt`; `status` and `reconcile` inspect an existing job without resending it. Native queue, steering and Goal controls are separate. Web workers cannot complete Native Goals themselves, and external Goal completion does not yet guarantee that no automatic follow-up starts. See the delegation details for current limits.

## Product goals

The product treats the following as explicit design principles:

- **Mainstream-first** — the most common supported environment is the default path. Multi-profile, special browser/runtime, and development-only modes stay optional and must not contaminate core correctness.
- **Change-resilient** — OpenAI-owned model/tool names, ChatGPT DOM/UI details, executable locations, and incidental protocol fields are discovered at runtime or isolated behind adapters rather than spread as product-wide constants.
- **Flexible execution routes** — if one tool or backend cannot complete a task, use another available route to finish the same work. Check prior effects before repeating a write.
- **Easy in, easy out** — install/update/repair/uninstall are symmetric ownership lifecycles with explicit provenance and complete removal of Tela-owned resources.
- **Consistent naming** — `Tela` is the product brand; ChatGPT/Codex describe integrations. Public repo, CLI, process, protocol, and data namespaces converge on Tela-owned names rather than inheriting external project identities.
- **Multi-OS and efficient by default** — macOS, Windows, and Linux remain architectural targets; long-running work is event-driven/on-demand, with idle CPU, wakeups, battery, I/O, and log volume treated as design constraints.
- **Evidence-first diagnostics** — failure-triggered, structured, privacy-safe, bounded evidence is preferred over always-on telemetry or ad-hoc raw logs.

Tela Chat includes `~/.codex/AGENTS.md` and project-root instructions when you open a workspace.
Reuse its workspace ID during continued work; instruction bodies are not added to every tool call.
Reopen or explicitly rediscover workspace instructions after editing them. Nested instruction files
are listed for the agent to read before working in their directories. Native-backed Web conversations
also retain the Native app's existing instruction and checkpoint handling.

For development operators diagnosing one existing Native conversation, a
read-only source CLI command now joins its exact thread status, recent bounded
turn statuses, matching structural diagnostic events and last observed approval
wait without searching the user's private messages:
`bun run cli thread inspect --thread <UUID> --slot 2 --minutes 30`.
See [diagnostics](docs/diagnostics.md) for limits.
Tela Chat additionally exposes an optional authenticated `inspect_native_work`
read-only capability (opened workspace ID, exact Native thread UUID and
optional profile/window), without an arbitrary shell command. It reports
current profile Web approval separately from the Native thread because
profile-only browser evidence is not proof of one conversation's ownership.
The host's own ChatGPT tool approval prompts are outside Tela ingress.
For selected owned Web sessions, agents can inspect a bounded one-shot or
conversation-scoped eligibility classification; the actual automatic click
remains exclusive to the opt-in owner-bound provider path. A previously
activated card cannot be clicked again, but its pending clearance or
assistant-progress evidence does **not** block a distinct newly identified
owned card. Each card must independently satisfy the current owner, target,
trusted-input, cancellation and one-shot dispatch checks.

- Make installation, repair, upgrade, and **complete removal** first-class product lifecycles. Tela records
  what it owns and never relies on an undocumented cleanup checklist.
- Present one **ChatGPT Tela** integration. The mainstream setup is ChatGPT's built-in
  **Plugins -> + -> MCP app** flow, while the natural-language **Create plugin** path remains a supported
  long-term packaging surface for richer skills/references without creating a second Tela runtime identity.
  The user supplies one endpoint/tunnel and its authentication once; ChatGPT owns that connection metadata.
- Keep `ChatGPT Tela` as the current exact connector display identity until stable end-to-end validation is
  complete, then decouple the stored binding identity from the display name so users may rename the app/plugin
  without weakening exact connector proof.
- Keep Tela Gateway, Tela Chat, and Tela Codex as separate processes with separate mutable state/lifecycle.
- Never require the Chat path to initialize or traverse Codex/Responses/browser code, or the Codex path to
  initialize or traverse Chat workspace/process/agent code.
- Keep Native Codex as the canonical authority for Codex task, workspace, sandbox, and tool state.
- Do not hardcode OpenAI-owned model names, Native Codex tool names, configured external MCP tool names, or
  unstable ChatGPT DOM details as product-wide assumptions; discover them at runtime or isolate them behind
  narrow adapters.
- Separate logical task context from the physical representation sent to a web model.
- Preserve steering, compaction, resume, tool rounds, and fresh-chat continuation without replaying
  accepted work.
- Treat web products such as ChatGPT as unstable external dependencies discovered through semantic
  capabilities, observations, actions, and proofs rather than fixed DOM layouts.
- Discover the current Codex tool inventory at runtime instead of maintaining a parallel hardcoded
  tool catalog.
- Use Tailscale Funnel as the intended unified public ingress while keeping ingress details outside backend
  correctness logic.
- Keep the desktop launcher and embedded Chromium browser host outside core correctness logic.
- On macOS, keep the hidden Codex/Web bridge out of the Dock and expose product status/control through one
  lightweight on-demand menu-bar surface rather than another always-visible launcher app.
- Approval automation is explicit and defaults off. Full access prefers **Allow for this conversation**, then
  **Allow once** or **Allow**. Approval text and connector names do not affect the choice.
- Support macOS, Windows, and Linux by default and verify all three in CI.
- Stay quiet when idle and collect deeper diagnostics only at a bounded failure boundary.

## Product interaction goals

Tela should be useful enough to develop **Tela itself** through the same user-facing paths that other projects
use. This dogfooding target is stricter than merely exposing low-level tools:

- **Tela Chat** should feel as smooth and self-directed as DevSpace for local software work: open/reuse a
  workspace, inspect files, edit transactionally, run and resume commands, review changes, create isolated
  worktrees, and delegate longer work without making the user manually orchestrate each primitive.
- **Tela Work/Codex** should provide reliable direct Native/Web integration: Native Codex remains the authority
  for the exact task/turn/workspace/sandbox/tool state, while ChatGPT Web reasoning can discover and invoke the
  current Native tools and continue the **same turn** after tool results without manual transport plumbing.
- Developing Tela through Tela Chat and Tela Work/Codex is an explicit product-quality gate. When normal Tela
  development cannot be completed comfortably through those surfaces, that friction is treated as product
  work rather than as an acceptable permanent dependency on a separate developer-only control path.

The long-term integration gate is stronger than feature sampling. The maintainer's DevSpace reference,
Permity workflow, and LJY's Menu Bar workflow remain available as reference/fallback
systems while Tela is pre-release, but Tela is only considered complete when the user could remove those
reference installations without losing the workflows they still rely on. Reaching that gate does **not** mean
Tela will delete or uninstall those projects automatically; retirement is a human decision after parity and
dogfood evidence. See [docs/legacy-workflow-assimilation.md](docs/legacy-workflow-assimilation.md).

The current pre-alpha already proves substantial pieces of both paths, including live Tela Chat capability
calls and a real Work/Codex Web -> public connector -> Native tool -> same-turn continuation proof. The target,
however, is everyday usability comparable to the mature reference workflows rather than a collection of
individually working primitives.

Self-maintenance is part of the same natural-language product goal. A user should eventually be able to ask
Tela Chat or Tela Work/Codex things such as:

```text
"Update Tela to the latest version."
"Reinstall Tela."
"Remove Tela but keep my work/data."
"Remove Tela completely, including settings."
"The installation looks broken; repair it."
```

Those requests must not become ad-hoc shell scripts generated by the model. Tela should translate them into
explicit product lifecycle capabilities (`install`, `repair`, `upgrade`, `uninstall`) with an inspect/plan
boundary, then hand destructive replacement/removal to a **signed external maintenance helper** that can stop
Tela, apply the verified transition, verify the result, restart when appropriate, and finally clean up the
helper. The final release UX should pin the trusted release keys and hide operator-only PEM/CLI plumbing from
ordinary users.

## Target architecture

The initial ownership boundaries are documented in [docs/architecture.md](docs/architecture.md).
The short version:

```text
                           ChatGPT
                              |
                    ChatGPT Tela Plugin
                              |
                   one user-owned ingress
                              |
                              v
                        Tela Gateway
                    auth / routing / health
                     /                 \
                    /                   \
             Tela Chat               Tela Codex
          separate process          separate process tree
          own state/db              own profiles/state
          workspace/process         Native Codex authority
          agents/review             Responses + browser
```

The gateway stays intentionally small and owns no workspace, process session, Native Codex task, browser
profile, or agent state. Each backend may be missing/restarting/unhealthy while the other remains usable.
See [docs/product-lifecycle.md](docs/product-lifecycle.md) for installation/uninstall ownership rules.

The first package boundaries are intentionally small:

```text
packages/core          native authority, context, turn state, dynamic tools, diagnostics
packages/codex         Native Codex request binding and canonical current-turn evidence
packages/runtime       causal turn ownership, tool rounds, and browser/Web orchestration
packages/chatgpt       semantic web-provider contracts and proof states
packages/browser-host  browser surface ownership contract
packages/electron-host Electron/WebContents implementation and persistent profile partitions
packages/mcp           connector ABI and replaceable MCP exposure
packages/responses     Native Responses JSON/SSE protocol boundary
packages/local-server  authenticated loopback Native Responses lifecycle
packages/development-runtime  pre-alpha composition of Native/Web/MCP lifecycles
packages/setup         inspect-plan-apply-verify setup lifecycle
packages/product-lifecycle install ownership, product paths, and safe uninstall planning
packages/service-protocol private authenticated Gateway/backend contracts
packages/tailscale-ingress exact-path Funnel lease inspection/planning
packages/gateway       public-ingress/backend routing
packages/chat-service  new independent Chat workspace/process service
packages/codex-service independent Codex profile/Responses/browser service
apps/cli               development entry point
apps/packaged-launcher stable installed service launcher that verifies and dispatches the signed payload
apps/package-build      source release-payload builder/signing entry point
apps/gateway-daemon    standalone Tela Gateway process
apps/chat-daemon       standalone Tela Chat process
apps/codex-daemon      standalone Tela Codex process
apps/profile-runtime   one isolated Electron/Responses runtime per product profile slot
apps/profile-setup     setup-only Electron profile preparation helper
apps/canary-preflight  non-mutating live-canary prerequisite checker
apps/menu-bar-macos    lightweight on-demand macOS status/control surface
```

The source runtime uses independent Tela Gateway, Tela Chat, and Tela Codex services. Tela Codex owns
profile/controller logic while Tela Chat remains a sibling service, not a library inside Codex.

The first Tela Chat source slice is executable behind its private service boundary. A **locally approved**
workspace root can be opened and used for bounded `read`/`read_many`, transactional `apply_patch`, resumable
`exec_command`/`write_stdin`/`process_status`, and Git-backed `show_changes`. `show_changes` also attempts to
create a bounded `reviewRef`; `show_review` and `list_reviews` reopen those exact historical snapshots even
after later edits or a Chat daemon restart. In the source review card, current comparisons have a searchable
file list; saved reviews show captured Git status, tracked changes, and expandable new-file contents. Binary
new files show their size. Missing comparisons and partial counts are labeled explicitly. The card is read-only
and makes no network requests. Actual ChatGPT-host rendering remains unverified. Approving a root grants runtime access; it does **not** make the
repository product-owned or eligible for uninstall deletion.

The source `list_processes` capability discovers saved command reservations in an approved workspace
without rerunning commands or consuming output. It returns at most 50 records per page; continue with
`after_session_id` from `nextAfterSessionId`. By default it lists unresolved records; `include_completed`
also lists terminal command records. This is a registry observation, not proof of live processes or
complete descendant termination. Use `process_status` for a current authenticated owner observation.
An uncertain direct execution cannot yet be restored from a saved PID; keep its evidence and do not
clear it or rerun the command as recovery. The process registry and authenticated completion
archive were also observed in the signed local macOS installation on 2026-10-18.

In the macOS control center, open **Settings → Chat · Local folders → Choose folder…**.
Select the folder you want ChatGPT to read and edit, then choose **Apply Chat settings…**. This restarts only
Tela Chat. Finish running Chat commands before applying; Work/Codex profiles stay open. Saved access is shown as
pending until the running Chat service proves that it loaded the same folder settings.

To remove access, use **Remove access…**, then apply Chat settings again. This keeps the files. An approved
parent folder continues to grant access to its subfolders. No folder is approved automatically.

In a regular Chat conversation, select the **ChatGPT Tela** connector and ask, for example:
“Use Tela Chat to open `/absolute/path/to/my-folder`, read `notes.txt`, and make these changes: …”.
The model discovers Chat capabilities, opens the folder, reuses its workspace id, reads and patches the
files, and reads back the result. Basic local file work requires no Native Codex turn or delegated agent API key.
Git-backed review is available for repositories; ordinary folders can use file readback to confirm changes.
The macOS folder controls require the `chat-folder-preview.1` preview or a later package; install it
before expecting these controls in the installed UI.

Development root approval is also explicit:

```sh
bun run cli chat allow-root --path /absolute/path/to/project
bun run cli chat roots
```

The standalone `chat-daemon` reads those approved roots at startup. Path traversal and symlink escapes fail
closed. Durable process-operation metadata stores no command/output/environment/filesystem-path payload, and
a service restart never reattaches stdin/stdout to an old PID merely because that numeric PID still exists.

### Downloading workspace files

The source `export_file` capability prepares one existing file from an opened, locally approved workspace
for a download card. Give it the `workspace_id` and a relative `path`. It supports text and binary files up
to 2 MiB, rejects symlinks and directories, and leaves the workspace unchanged. The capability is advertised
only when the native helper proves export support.

The model receives the filename, size and digest. File bytes travel in widget-only result metadata rather
than the model transcript; no public download server or persistent export cache is created. The user clicks
**Download file** to save the captured bytes through the host's browser download mechanism. Later edits to
the source file do not alter an already prepared download. Request a new export for updated contents.

The export helper is included in the signed local macOS preview and the capability is discoverable,
but an end-to-end ChatGPT-host download-card acceptance has not been verified. Some hosts may block downloads
from embedded cards; Windows/Linux export behavior remains unverified.
The feature currently belongs to Tela Chat, not the Native Work/Codex tool inventory.

### Reusable skills in Tela Chat

Put a workflow in `.agents/skills/<folder>/SKILL.md` inside your approved project, or in
`~/.agents/skills/<folder>/SKILL.md` for all projects. Use `list_skills` to find it and `read_skill` to
read the instructions or a supporting file relative to that skill's folder. Reads are paginated;
`hasMore` tells you whether to request the next page.

```yaml
---
name: review-changes
description: >-
  Review the current changes and explain what needs attention.
---
```

Project skills take precedence over global skills with the same name. Setting
`disable-model-invocation: true` in a project's skill also hides the matching global skill.
Duplicate names within one root are rejected; malformed YAML and non-text/oversized documents are
excluded. Supporting files must stay inside the chosen skill directory. Loading a skill grants no
additional file, command, or agent permissions. Tela reads skills on demand and does not copy DevSpace's
private skill folders automatically. These improvements are source-tested; the installed preview has
not yet been updated.

Historical reviews are stored as private product state, not as Git refs in the user's repository. Tracked
changes are retained as a binary-capable patch and untracked files/symlinks are snapshotted losslessly within
strict per-file/aggregate limits. Tela does not create permanent review refs or deliberate review objects in
the user's `.git` directory. Review artifacts are mode `0600`, limited to 16 per workspace / 64 total, and
age out after 30 days. If a change is too large to checkpoint, the live `show_changes` response still works
and reports that historical capture was unavailable.

Tela Chat can also create **managed worktrees** from an approved Git repository. These worktrees live only
under Tela's Chat state root, carry a Git-admin ownership marker, and are recorded in the install ownership
manifest before creation begins. `create_worktree`, `inspect_worktree`, `list_worktrees`, and
`remove_worktree` are exposed only when install ownership is available. Removal is deliberately conservative:
only the exact recorded repository/worktree identity with a matching marker, matching manifest, clean working
tree, and unchanged creation-base `HEAD` is removable. Uncommitted files, detached commits, a missing source
repository, marker drift, or a replaced/symlinked path are preserved for manual recovery.

Workspace-scoped Chat failures also create a bounded **privacy-safe incident reference**. Incident records
persist only the capability name, timestamp, fixed failure category, and a truncated SHA-256 fingerprint of
the opaque workspace id. They do not persist raw workspace ids, paths, commands, patches, prompts, process
output, or error messages. `list_incidents` and `show_incident` require the original workspace id and expose
only the non-fingerprint summary. Retention is capped at 32 incidents per workspace / 128 total and 30 days;
diagnostic-write failure never changes the underlying tool result.

Tela Chat also has a provider-neutral **durable subagent lifecycle seam**. A configured driver gets explicit
workspace scope, a bounded prompt, `read_only` or `workspace_write` mode, an abort signal, and an optional
opaque provider continuation id. The Chat core persists agent/turn status, bounded final responses, and the
continuation id in private mode-0600 state, but it does not persist submitted prompts. A daemon restart never
reattaches an in-flight turn: any unproven running agent/turn becomes `unknown`, and continuation from that
state is refused until a provider-specific recovery design can prove it safe.

Agent capabilities are **availability-gated**. `list_agent_targets`, `start_agent`, `continue_agent`,
`get_agent`, `list_agents`, `wait_agents`, and `stop_agent` appear in the private Chat capability inventory
only when at least one driver is actually available. Tela Chat now has an optional **OpenAI Responses** driver
that stays independent from Tela Codex/browser state. Provider config stores only the model id plus secret
references; the API key value is never written to Tela config or a service definition. Source/dev runs may
still use an environment-variable reference, while installed/background runs can resolve an exact opaque
credential id from the per-user platform store: macOS Keychain, Windows CurrentUser DPAPI, or Linux Secret
Service. If neither source resolves, Chat still starts normally and the agent capability family is omitted.

The first provider tool boundary is intentionally narrower than the normal human-facing Chat tool set. A
`read_only` agent gets bounded `read`, `read_many`, and `show_changes`; `workspace_write` additionally gets
Tela's transactional `apply_patch`. Shell/process execution is not exposed to the provider yet because a cwd
is not a write sandbox and therefore cannot prove workspace-only authority. Provider continuation uses an
opaque durable OpenAI Conversation id; provider-side conversation state contains the prompts/tool traffic sent
to the API, while Tela still does not persist submitted prompts in its own agent store.

The source pre-alpha CLI and packaged launcher now share the same reviewable uninstall runtime:

```sh
bun run cli uninstall --dry-run --remove-data
bun run cli uninstall --apply --remove-data
```

Apply stops Gateway first and then attempts Chat/Codex shutdown independently. It re-observes every resource
immediately before destruction. Exact owned Funnel paths, exact evidenced OS service registrations, and
clean/base managed worktrees can be removed. Marker-owned browser/account state is preserved by default and
is removable only with explicit `--remove-data` after profile setup/runtime activity has stopped; dirty,
committed, drifted, ambiguous, or service-blocked resources are preserved. User repositories are
never uninstall targets. Legacy name-only service registrations stay preserved. The signed multi-file
application/binary layout and packaged uninstall entrypoint now exist, but Developer ID/notarization plus the
final signed end-user installer/updater UX remain release work.

The product-lifecycle package also has a concrete packaged-install operator. It plans without touching disk,
fingerprints the exact staged payload, creates only a marker-owned binary root, and registers the three
platform-native service registrations from exact generated definitions. Apply records create intents before
mutation and verification catches interrupted copies/registration; registrations are installed dormant rather
than starting before product setup.

The source tree now also builds a **signed multi-file runtime payload**. `bun run package:build` compiles one
stable `chatgpt-tela` launcher plus separate Gateway/Chat/Codex executables, bundles the Electron profile
runtime and its CJS entrypoint, writes the versioned package manifest, applies platform-native signing before
the package fingerprint is frozen. OS
service registrations point only at the stable launcher; the launcher re-proves the install manifest and
payload receipt, reads the package manifest, and dispatches the exact service child. Codex receives the
packaged Electron/profile-runtime paths from that manifest rather than a hardcoded install layout.

Tela Chat has an optional **Save a file to your workspace** card. Open an approved workspace,
then ask Tela to open its file import card (`open_file_import`). In hosts that expose ChatGPT's file
library, **Choose from ChatGPT** lets you select an available file. Choose a relative destination in
an existing folder and confirm **Save file**. Files are retrieved only through a fresh host-authorized
reference; their bytes and temporary download URLs stay out of model context. The card also supports
local files. Each file may be up to 2 MiB, and existing files are never replaced.

The ChatGPT library path is a source preview, not a live-host-verified feature. It currently permits only
`https://files.oaiusercontent.com`; other storage locations, including regional generated-file hosts,
are refused rather than guessed. Hosts without the official file helpers cannot use this path. Direct
conversation attachments are not automatically delivered through Tela's frozen generic tool contract.
The installed local preview contains the local-file path; library selection requires a later package.

To include the file publisher in a development package, install a Rust toolchain, run
`bun run workspace-files:build`, and pass `--workspace-files build/workspace-files-target/release/tela-workspace-files`
to `bun run package:build` alongside its platform signing arguments (append `.exe` on Windows). The helper is included
in the signed payload and removed with owned application binaries; imported files remain user workspace
content. It runs on demand when opening the import card or saving. Packages without the helper omit the import capabilities. Windows/Linux
execution awaits CI or device proof. Interrupted staging is recovered on the next import-card open or save,
using private records and directory identities. Already saved files stay unchanged. Ambiguous or replaced
staging folders are preserved and further imports in that workspace stop until recovery is resolved. Do not
delete folders based only on the `.tela-import-*` filename prefix. Uninstall with saved-data removal preserves
pending recovery records and ownership state until recovery is resolved.

On macOS, the package builder requires an explicit codesign identity. `-` is supported only for local
ad-hoc development proof; a public release still needs a Developer ID identity and notarization. The payload
retains only **relative internal symlinks whose lexical and resolved targets remain inside the payload root**,
because Electron frameworks require those links for a valid bundle. Absolute, broken/cyclic, or escaping
links fail closed; the link path and target text are covered by the payload fingerprint and reproduced exactly
at install.

On Windows, those registrations are current-user interactive Scheduled Tasks with no trigger, not
`LocalSystem` services. That keeps Gateway/Chat/Codex in the same user profile and Desktop session as Tela's
config, ChatGPT state, and built-in Desktop adapter while still providing explicit normal start/stop control.

The payload is self-describing through `chatgpt-tela-package-v1.json`: it declares the product version,
stable launcher, exact Gateway/Chat/Codex executables, packaged Electron/profile-runtime entrypoints, and
lifecycle support. Install/upgrade use the common ownership and payload-fingerprint path; apply verifies
that the package bytes still match the reviewed plan and installed receipt.

A live macOS packaging proof compiled all four Bun executables, bundled the 1.40 MB profile runtime plus the
Electron distribution, re-signed the Mach-O/Electron bundle, verified strict/deep codesign, then verified the
payload fingerprint. The signed payload was installed into a temporary HOME using fixture-only LaunchAgent
registration, after which the installed compiled `chatgpt-tela service chat` launcher started the installed
compiled Chat daemon, returned authenticated `ready`, accepted `/v1/shutdown`, exited normally, and removed
its runtime descriptor. No real user launchd registration, Tailscale route, or ChatGPT profile was modified.

Cross-version packaged upgrade also has an interruption-safe state machine. It requires stable service
registration identities, durably records which services were running, quiesces all three before binary
replacement, commits the target product version only after exact payload verification, and restores only the
services that were previously running. A failed restart leaves the journal at the committed target version so
a retry resumes only the outstanding restart. Restart completion requires authenticated runtime readiness
after normal OS start, including services whose OS registration is already running. Ordinary `start` and destructive uninstall apply refuse to run
while that journal exists. The source service controller uses authenticated owned-service shutdown and normal status/start for
launchd, systemd user units, and Windows per-user Scheduled Tasks; a signed updater UI and real-OS packaged
E2E validation still need to drive/prove this lifecycle for end users.

Install, update, repair, removal and installed service controls share one mutation owner. Interrupted
removal blocks new mutations; proven final metadata cleanup can resume without repeating shutdown.

The launcher automatically retains a verified source recovery package before stopping
services. Recoverable failures restore the previous services; uncertain shutdown remains paused with
its checkpoint. Restoration is reported as an unsuccessful update. See [upgrade recovery](docs/upgrade-recovery.md).

The source launcher also provides `cancel-upgrade` with explicit `--dry-run` or `--apply`,
`--payload` pointing to the retained **source** package. Cancellation
is allowed only before binary replacement starts and after proving that the source files, installation
and data format remain compatible. It preserves running services and restores only prior running
services that stopped. If restoration fails, repeat that cancellation to finish its checkpoint before
starting another upgrade. This is source-preview functionality; older installed launchers may not
support it. Cancellation checks the source package’s lifecycle support declaration and refuses before
changing its checkpoint when support is absent. Use a verified updater from the new package for
version transitions; do not remove pending update records to work around an older launcher. Actual
OS restoration and consumer updater UI acceptance remain open.

Same-version packaged **repair** is a separate interruption-safe transition rather than a reinstall
shortcut. Normal install still preserves completed payload byte drift. Repair may restore payload bytes only
when the exact install manifest, binary-directory ownership marker, and original payload receipt still prove
the same install/version/payload fingerprint. Missing exact service registrations can be recreated; foreign or
replaced service definitions remain preserved. Binary repair writes its own durable journal before quiescing
exact-owned services, verifies payload and registrations after repair, and resumes only services that were
running before the repair. A restart failure leaves the journal for idempotent retry of only outstanding work.
Repair and upgrade journals are mutually exclusive, and packaged service launch/install, ordinary source
start, and destructive uninstall apply refuse to cross an incomplete transition.

Install, repair and upgrade use one lifecycle path. Choose a package from a trusted source; there is no
separate Tela public-key file to select. Platform code signing remains part of distribution, while payload
fingerprints bind planning, apply and installed ownership to the exact package bytes.

```sh
./chatgpt-tela install --dry-run
./chatgpt-tela install --apply

# Run from a known-good same-version package for repair:
./chatgpt-tela repair --dry-run
./chatgpt-tela repair --apply

# Run from the target package for an upgrade:
./chatgpt-tela upgrade --dry-run
./chatgpt-tela upgrade --apply

# Run uninstall apply from a separately extracted package:
./chatgpt-tela uninstall --dry-run
./chatgpt-tela uninstall --apply
./chatgpt-tela uninstall --apply --remove-data
```

The package directory defaults to the directory containing the launcher; `--payload <directory>` selects
another package. `--dry-run` and `--apply` are mutually exclusive. Upgrade automatically retains an owned
source snapshot for recovery, without the original download or a separately supplied key.

Packaged uninstall uses the same ownership-aware engine as the source CLI. It re-proves exact resource
ownership immediately before every destructive step, preserves drifted/dirty/foreign resources, and keeps
config/state/browser data unless `--remove-data` is explicit. `uninstall --apply` fails before mutation when
the currently executing launcher is inside the installed Tela binary root; run it from a separately extracted
package copy so Windows and other platforms are not asked to delete the executable that is still running.

### First connection from a packaged preview

The macOS control center guides first use from the **installed** package; it needs no source checkout
or separate Electron build. A fresh installation opens **Set up ChatGPT Tela** automatically.

1. Install the signed preview with the plan/apply commands above. The menu bar opens on macOS.
2. In the setup screen, enter your reachable HTTPS connection address and local port. Choose an existing
   HTTPS route or your Tailscale Funnel. The existing route must forward to that port; Tailscale must already
   be installed and signed in. This preview requires explicit consent to **development-only unauthenticated
   exposure**: anyone with the endpoint address can reach its exposed tools. It is not consumer-safe yet.
3. Save and continue, then choose **Start Tela** from the menu bar or Home. Select **Open ChatGPT login** or the profile's
   **Sign in / manage connection…** button. Connected profiles must first be disconnected.
4. Sign in yourself in the visible login window. Copy the connection address from Work and create the
   **ChatGPT Tela** Plugin using the connection instructions below. Close the login window or choose
   **Finish setup** in its menu to verify. Failed login verification keeps the window open; **Cancel setup**
   closes setup without connecting. Setup starts no Native route or model turn.
5. Turn on the profile connection in Work, then select a Web model in ChatGPT. The runtime checks the
   connector and Web connection; a successful login alone does not prove that they are ready.

Existing configurations are preserved and skip the first-use form. An invalid or unverified configuration
shows a repair instruction rather than being replaced. Extra profiles appear only when an optional
multi-profile adapter is already configured and detected.

### Everyday use and restarting your computer

The Tela menu bar opens when you sign in to macOS. Choose **Start Tela** from its menu if Tela is off;
the spinning indicator shows startup and connection progress. **Chat: Ready** means the ChatGPT Tela
connector can reach your local Chat tools. Chat needs no Work profile switch.

For Web models in Work, turn on **Web models** for your ChatGPT app, then choose **Open ChatGPT**.
Saved connections are restored when their apps are fully stopped; an already-open app may need the
confirmed reconnect action. Use Work **On your computer**. Sign-in and connector setup are needed on
first use or when the connection needs repair, rather than after every reboot. Settings holds approval
automation, connection details, and maintenance.

CLI users and other platforms can use `chatgpt-tela configure --file ./product-config.json`, followed by
`chatgpt-tela services start` and `chatgpt-tela setup [--slot N]`. The minimal configuration remains:

```json
{
  "version": 1,
  "publicMcpAbi": "stable",
  "exposure": {
    "kind": "existing-https",
    "publicUrl": "https://your-server.example/mcp",
    "localPort": 18743,
    "authentication": "none",
    "allowUnauthenticatedPublicEndpoint": true
  }
}
```

Windows/Linux share the packaged setup boundary but do not yet have this macOS control-center UI or verified
release binaries. Trusted consumer installers, authenticated exposure, and automatic release downloads remain
release work.

Background service buttons use the same verified installed launcher as `chatgpt-tela services start` and
`chatgpt-tela services stop`. They validate the installed payload and service ownership before changes;
replaced registrations are preserved. Stopping services can close connected ChatGPT profiles.

Updates use the **new extracted package's** upgrade plan/apply commands. Saved connections, configuration and
browser login state retain the same install identity. The update restores background services and relaunches
the installed menu bar with the new UI. Stopped saved profiles can reconnect at service startup;
already-running ordinary ChatGPT apps remain under user control.

Removal uses a separately extracted launcher's uninstall dry-run/apply. The default keeps saved data and its
ownership manifest for reinstall. `--remove-data` removes only proven Tela-owned data. Dirty worktrees,
unmarked data and replaced resources are preserved and reported. Original ChatGPT configuration,
conversations and user projects remain outside this ownership boundary. Consumer signing/notarization and
the guided installer/updater are still release work.

## Developer preview

ChatGPT Tela is not yet packaged as an end-user product. The Tela Codex bridge has passed live
end-to-end canaries on both the stock/default Native profile and an isolated managed second profile. The
source CLI now supervises **Gateway, Chat, and Codex as separate daemons** for `start`, `stop`, `profiles`,
`status`, and `shutdown`; the retired one-process control daemon is no longer part of the runtime. ChatGPT MCP
App creation/connection remains manual and the current public exposure modes are development-only. Tela Chat has its first
workspace/file/process/review slice, ownership-safe managed worktrees, and bounded privacy-safe failure
incidents, plus an optional OpenAI Responses agent over bounded workspace read/patch authority. Installed
service credential provisioning now exists through a per-user platform credential store; a real external
provider call still requires a user credential. General artifact transfer, the frozen one-plugin public generation, Developer ID/notarized release packaging,
and the final signed installer/updater UX remain active pre-alpha work.

The stable **ChatGPT Tela** connector also has a live product exact-turn proof on the isolated Profile 2 path:
one persistent Native Codex turn was routed to ChatGPT Web, the Web turn discovered the exact current Native
inventory through the public connector, invoked Native `exec_command`, received its result, and completed the
same Native turn with the requested final response. The test Native thread was then deleted through the public
app-server lifecycle rather than left in the user's Codex history.

ChatGPT Tela currently requires Bun 1.4.0:

```sh
bun install --frozen-lockfile
bun run verify
bun run cli doctor
bun run package:smoke
bun run cli status
```

CI runs the same `package:smoke` on macOS, Windows, and Linux. It compiles
the stable launcher plus separate Gateway/Chat/Codex executables, stages the real Electron/profile runtime,
verifies the payload fingerprint, and executes the packaged launcher's lifecycle/help CLI boundary. macOS additionally uses
ad-hoc codesign for this CI proof; public releases still require Developer ID signing and notarization.

`doctor` is a non-mutating default-profile preflight. It resolves the platform's official ChatGPT/Codex
installation, runs only `codex --version`, and observes the exact Desktop process set. It never starts,
stops, reroutes, or configures ChatGPT. The JSON result distinguishes `ready-to-start`, a normal
`restart-required` state, duplicate Desktop processes, package/discovery repair, and Codex-runtime repair.
This is also the canonical first check for Windows/Linux release validation.

To opt into the OpenAI Chat agent without storing an API key in Tela config, configure the provider first:

```sh
bun run cli chat configure-openai-agent --model <model-id>
bun run cli chat agent-providers
```

For a source/dev process, the existing environment fallback still works:

```sh
export OPENAI_API_KEY=...
bun run cli shutdown
bun run cli start
```

For an installed/background service, store the key in the per-user OS credential store without placing the
secret on the command line. Either pipe it on stdin or import it from a temporary environment variable:

```sh
printf '%s\n' "$OPENAI_API_KEY" | bun run cli chat store-openai-api-key --stdin
# or: bun run cli chat store-openai-api-key --from-env OPENAI_API_KEY
bun run cli chat agent-providers
bun run cli shutdown   # restart services after changing provider config
bun run cli start
```

`--api-key-env <NAME>` can reference a different source/dev environment variable. The logical provider
credential id maps through the ownership manifest to a random Tela-only physical store key, so an unrelated
Keychain/Secret-Service item with the same human-facing name is never adopted or overwritten. The manifest
stores that opaque store identity but never the credential value or a credential hash. It is preserved
by a normal uninstall and removed only with explicit `uninstall --apply --remove-data`; a matching
pre-existing credential that is not in the current install manifest is never adopted, overwritten, or deleted.
`bun run cli chat delete-openai-api-key` likewise deletes only the exact credential owned by this install.

Delegated Tela Chat agents default to **read-only** on every turn. Request `workspace_write` explicitly
when the agent should edit files; it permits bounded patches inside the selected workspace. Delegated agents
do not receive shell/process tools, arbitrary downloads, or Native Codex authority. Provider session history
does not grant permissions to the next turn.

`continue_agent` resumes only an agent whose previous turn completed successfully, including after a service
restart. Failed, stopped, or unproven interrupted turns cannot be resumed: inspect the workspace and its
changes before starting another agent. Stopping a run prevents further tool calls; edits already committed
before the stop remain in your workspace. Tela does not automatically resend a failed task or roll back those
edits. These boundaries have local fixture tests; live provider behavior and sandboxed command execution
remain separate verification/implementation work.

The public MCP control ABI is frozen in source as **ChatGPT Tela**. Users see one connector identity and one
public endpoint. Its internal compatibility generation is `1`; that generation number is implementation metadata,
not part of the plugin name. The fixed public surface has exactly four controls:

- `chatgpt_tela_chat_capability_inventory`
- `chatgpt_tela_chat_capability_call`
- `chatgpt_tela_codex_tool_inventory`
- `chatgpt_tela_codex_tool_call`

The Chat controls discover the current independent Tela Chat capability catalog (name, description, input schema)
and invoke one selected capability. The Codex controls discover the exact active Native Codex turn's dynamic tool
inventory and invoke one tool from that inventory. Workspace, worktree, review, agent, artifact, and Native tool
names therefore remain runtime-discovered instead of expanding the fixed connector schema. The frozen
`tools/list` fingerprint is
`a353771847d4de9d87264758e5350eb33bea98540748a033c0744884d69916f9`.

The source Gateway also keeps an **unfrozen `unified-development` surface** for experiments with direct
per-capability Chat tools. It uses the separate connector identity **ChatGPT Tela Development** and is not a
second release plugin. Production/source-preview use only **ChatGPT Tela**.

### Source split-service runtime (pre-alpha)

The product UX is **single-profile first**. One normal ChatGPT account and one official Desktop app is the
default case, so ordinary commands do not require a profile number:

```sh
bun run cli setup
bun run cli start
bun run cli stop
```

Internally that default remains canonical slot 1 so browser/account isolation does not need a second
implementation. `--slot 2`, `--slot 3`, ... are advanced opt-ins for people who actually run multiple
isolated ChatGPT accounts. Single-profile is therefore the one-entry case of the same profile registry, with
progressive disclosure at the CLI/UI boundary.

The Codex service core depends on a neutral Native-target adapter rather than owning Multi-Profile slot
mapping itself. On macOS, the built-in default adapter now resolves the official ChatGPT app and bundled
Codex, starts a Tela-owned ephemeral app-server plus route-preserving loopback proxy, launches the ordinary
Desktop app against that proxy, and shuts down only the exact process it started. No Multi-Profile install is
needed for that default path, and no user Codex config file is rewritten. Windows/Linux use the same adapter
contract. Their exact-process inspection and normal-close boundary are implemented too (Linux uses a
re-verified graceful `SIGTERM`; Windows uses a re-verified `CloseMainWindow()` request), and packaged
executable discovery is now bounded rather than guessed. Linux resolves the official `/usr/bin/chatgpt`
package launcher and bundled Codex runtime from supported system package roots. Windows resolves the exact
registered `OpenAI.Codex_2p2nqsd0c76g0` AppX package and accepts only one non-staging per-user Codex runtime
whose SHA-256 equals the current package's bundled `app/resources/codex.exe`. Explicit
`CHATGPT_EXECUTABLE` / `CODEX_EXECUTABLE` overrides remain available for nonstandard installs. Real-OS
product validation is still required before public Windows/Linux release.

**Plura Desktop** is therefore an optional advanced lifecycle provider, not a required dependency. Canonical
slot 1 always uses Tela's built-in official Desktop adapter, even when Plura is configured. The composite
production route uses Plura's public target/session contract only for additional managed slots (2+).
Plura owns those targets' Desktop lifecycle; Tela owns its own Responses/browser/task runtime and never
asks Plura to supervise canonical slot 1. Ordinary single-account users do not traverse the provider path.

**Independent installation and removal:** The original ChatGPT Desktop/Native Codex app must keep working
without either Tela or Plura. Tela alone uses the original app through its built-in adapter; Plura alone
manages only its own Desktop targets. Installing, updating, or uninstalling Tela never grants ownership of
Plura's executable, services, profiles, credentials, or Native history, and vice versa. Removing both products
must leave the original app and user-owned data intact.

If Plura supplies additional Tela slots, finish/close those *owned target sessions* before removing Plura.
Tela's built-in default continues independently; provider loss does not silently transfer an in-progress
Native turn to another Desktop owner. Additional Plura-managed slots become unavailable. To remove the stale
optional adapter reference, the source `configure` command may be run without `--multi-profile-launcher`
(supplying the normal public MCP exposure settings again). Conversely, Tela removal needs no Plura
operation: use Tela's own `uninstall --dry-run` and its owner-verified apply/keep-data choice.
Never remove the original ChatGPT app, native config, or Plura resources as part of that plan. See
[independent product lifecycle acceptance](docs/product-lifecycle.md#independence-from-original-apps-and-optional-providers).

The source runtime supports two explicit public exposure ownership modes. `existing-https` verifies and reuses a
route owned elsewhere. `tailscale-funnel` lets Tela create and verify one exact Funnel path and record that
path in the install ownership manifest. Neither mode resets Tailscale Serve/Funnel globally.

`configure` defaults to the frozen `stable` ABI and the single **ChatGPT Tela** connector:

```sh
bun run cli configure \
  --public-mcp-url "https://example.invalid/chatgpt-tela" \
  --local-mcp-port 18744 \
  --mcp-abi stable \
  --allow-unauthenticated-public-mcp \
  --manage-tailscale-funnel
```

The unfrozen direct-tool experiment remains separately selectable:

```sh
bun run cli configure \
  --public-mcp-url "https://example.invalid/chatgpt-tela" \
  --local-mcp-port 18744 \
  --mcp-abi unified-development \
  --allow-unauthenticated-public-mcp \
  --manage-tailscale-funnel
```

In `stable` and `unified-development`, Gateway publishes the configured schema even if a backend is temporarily
absent. A Chat inventory/call resolves the current Chat private descriptor only when invoked; a Codex
inventory/call does the same for Codex. One backend can therefore fail or restart without changing the
other's authority or taking down the Gateway process.

For the intended Tailscale-managed development path, configure it once, for example:

```sh
bun run cli configure \
  --public-mcp-url "https://example.invalid/chatgpt-tela" \
  --local-mcp-port 18743 \
  --allow-unauthenticated-public-mcp \
  --manage-tailscale-funnel
```

An advanced multi-account installation adds only the optional adapter selector:

```sh
bun run cli configure \
  --public-mcp-url "https://example.invalid/chatgpt-tela" \
  --allow-unauthenticated-public-mcp \
  --manage-tailscale-funnel \
  --multi-profile-launcher "$HOME/Library/Application Support/PluraDesktop/plura-desktop"
```

Gateway starts its configured loopback public MCP listener first, then asks the Tailscale lease manager to
make only that public path point at the exact local `/mcp` endpoint, and verifies both the Tailscale post-state
and the configured frozen/development MCP contract. If startup verification fails, only a route newly created by that prepare
attempt is rolled back. After successful startup, the route belongs to the **install lifecycle**, not the
daemon lifecycle, so an ordinary Gateway stop leaves it in place for restart/uninstall handling.

A matching Funnel path that existed before the install manifest is **not silently adopted**. It may be used
as an external matching route, but uninstall will not delete it. An
explicit ownership-transfer operation is required before a legacy/user-created route can become removable
Tela state. After configuring managed Funnel mode, inspect first and adopt only when intended:

```sh
bun run cli ingress status
bun run cli ingress adopt-existing
```

`adopt-existing` refuses unless the exact configured host/port/path currently points to the exact configured
loopback MCP target. It changes only Tela's ownership manifest; it does not rewrite the matching Tailscale
route.

Prepare the normal ChatGPT account interactively. The setup window never receives Native turn authority or a
Responses bearer:

```sh
bun run cli setup
```

Only multi-account users add explicit extra profiles, for example `bun run cli setup --slot 2`.

For a fresh install, setup records ownership only for the exact Tela browser user-data directory and shared
account-binding metadata that Tela creates. Existing unmarked profile/cookie state from an earlier pre-alpha
install is **not** silently adopted; it remains usable but uninstall preserves it. While a setup surface is
open, an install-scoped activity lease also blocks removal of Codex-owned profile state, including when
`uninstall --apply --remove-data` is run concurrently.

After the MCP App matching the configured ABI is connected in each account, start whichever slots should be
active. `stable` uses the exact **ChatGPT Tela** App. `unified-development` uses the separate development-only
identity **ChatGPT Tela Development**. The first start
ensures a persistent install identity, starts Tela Chat independently when possible, starts Tela Codex for
Native/profile ownership, and starts Tela Gateway for the configured public endpoint.
Every active Codex slot still gets its own Electron child, persistent ChatGPT browser profile, loopback
Responses server, Native app-server route, and turn registry. All slots share Gateway's single configured
public MCP endpoint. Gateway resolves current Chat/Codex private descriptors per backend call instead of
holding either implementation's state itself.

```sh
bun run cli start
bun run cli status
```

Advanced multi-account users start extra profiles explicitly (for example `bun run cli start --slot 2`) and
use `bun run cli profiles` when the profile list itself is relevant.
For an explicit, remote PID-bound reopen, first inspect `bun run cli profiles` and confirm
the affected profile has no active Native or managed work. Then run
`bun run cli start --slot 2 --expected-desktop-process-id <desktopProcessId>` using the observed
`desktopProcessId`. This reuses the running Codex service, checks the exact Desktop owner
again before reopening, and preserves a changed Desktop process. It does not require a
terminal session in `restart-required` state.

Startup makes Native available first. The owned engine uses its official Native model discovery,
cache and refresh path. Web preparation runs independently and adds only browser-discovered families after
account binding, exact connector selection and a second fresh ChatGPT surface have been verified without
sending a message. Work and the menu show Native readiness while Web prepares. A Web preparation failure
keeps Native available. Work shows **Web models** and **Account** separately. **Sign in…** opens a
signed-out profile's browser; **Verify…** opens it when authentication cannot be verified.
Sign in and close the browser, or choose **Done**, to check and restore Web models. **Try again**
is offered for a failed connection only after Web sign-in has been verified. Failed submissions are
never automatically resent. Verified accounts offer **Manage…** in Work. The menu shows account actions only when attention is needed. Duplicate account rows and technical diagnostics are omitted.

Existing non-empty ChatGPT drafts are preserved. Clear or finish the draft with `bun run cli setup` for the
default account, or `bun run cli setup --slot <n>` for an extra account. Connector-probe cleanup uses a bounded
pending marker to recover only its own exact interrupted selection. Connecting an already-running ordinary
app requires its normal quit and an explicit reopen confirmation. Another owner's Responses route is never
taken over. Web admission and engine model-list visibility are checked separately; an available Native route
alone does not establish Web readiness.

Stop also preserves ownership boundaries. ChatGPT Tela requests a normal desktop quit only while the
launcher's current Responses route fingerprint still matches the child it owns. If another process has
replaced that route, Tela treats its child as orphaned and cleans only its own browser/Responses/MCP state;
the unrelated Native target is preserved.

```sh
bun run cli stop
bun run cli shutdown
```

An advanced profile is stopped explicitly with `bun run cli stop --slot <n>`.

The persistent product config contains no runtime bearer secrets. Per-profile Responses/internal-MCP
credentials are generated for each start, while each Gateway/Chat/Codex daemon writes its own mode-600
loopback runtime descriptor with an ephemeral bearer. `status` probes each service independently. `shutdown`
quiesces Gateway first, then asks Chat and Codex to stop independently; one backend shutdown failure does not
skip the other backend's normal shutdown attempt.

`configure` writes the canonical `product-v1.json` under Tela's platform-native product config root. Source
and packaged runtimes read only this product-native boundary; a malformed canonical file fails closed rather
than reviving retired profile-scoped configuration. Product configuration therefore has no dependency on a
ChatGPT browser profile.

### Manual ChatGPT Tela plugin setup (pre-alpha)

The intended product surface is **one ChatGPT Tela plugin** created directly from ChatGPT's MCP connection
dialog. Its single MCP endpoint exposes both Tela Chat and Tela Codex controls. ChatGPT owns the saved
connection/authentication metadata; Gateway still routes Chat and Codex to independent local services, so
failure of one backend does not make the other unavailable.

For the current stable pre-alpha source path, the user supplies their own reachable HTTPS MCP connection once.
Tela can manage one exact Tailscale Funnel route or verify an HTTPS route owned elsewhere. The connection is
intentionally user-specific and is never committed to this repository. The existing OpenAI Secure MCP Tunnel
adapter remains a development/canary exposure until it is promoted into the stable product configuration.

1. Start/configure Tela so its stable Gateway MCP endpoint is reachable.
2. Enable ChatGPT **Developer Mode**.
3. Go to **ChatGPT Plugins**, select **+**, name the connection exactly **ChatGPT Tela**, and enter the stable
   Tela endpoint (or select the configured Secure MCP Tunnel when that exposure is in use).
4. Choose authentication that matches the exposure and create the connection. ChatGPT scans the MCP server and
   creates the personal/workspace Plugin directly; no separate App id, archive build, or Plugin Creator chat is
   required for the standard Tela setup.
5. Install/enable **ChatGPT Tela** and use that same Plugin for ordinary ChatGPT workspace requests and for the
   Tela Codex/Web path. Do not create separate Chat and Codex plugins.

The current exact display name is intentionally **ChatGPT Tela** while connector selection is still being
validated across ChatGPT UI variants. The long-term binding model will store a stable connection identity
separately from the user-visible name so users can rename the app/plugin without losing exact routing.

The newer natural-language **Create plugin** flow is a second supported long-term distribution surface, not a
different backend architecture. It may wrap the same Tela MCP connection with richer skills/reference files;
the direct **Create MCP app** path remains the simplest default setup.

See [Plugin setup](docs/chatgpt-plugin.md) for the exact flow, failure-domain model, and surface-availability
caveats.

Model guidance required by the standard direct-MCP Plugin lives in MCP server instructions, tool/capability
metadata, the Tela Chat agent harness, and the Codex/Web transport contract. If a route cannot complete a
requested workspace or Git operation, use another available capability to complete the same task.

Optional isolated ChatGPT accounts need their own Plugin connection because ChatGPT account/session state is
isolated. They still use the same Gateway endpoint; ordinary single-account users do not traverse the
multi-profile setup.

### Full access approval

Approval automation is off by default. When enabled, Tela considers one visible approval card in the owned
Codex/Web surface, without matching a connector name or analyzing the card text. It prefers **Allow for this
conversation**; otherwise it chooses **Allow once**, then generic **Allow**. A unique visible **Deny** control
and one unambiguous eligible card-local target are required. If the conversation choice is inside the card's
**Approval options** menu, Tela opens that menu once and verifies the same card and linked choice before clicking.
The existing owner, cancellation, target visibility, trusted input and card-clearance checks still govern dispatch
and its outcome. ChatGPT host approvals before Tela receives a tool call remain outside this browser feature.
An independently observed, newly owned second card can be activated without waiting for the previous card's
assistant-progress receipt. The same card remains single-dispatch. This fix is in the signed local macOS
preview, but a real multi-card Web turn has not yet been reproduced.

```sh
bun run cli approval status
bun run cli approval enable
bun run cli approval disable
bun run cli approval delay 500ms
```

Changing this preference applies to newly started/restarted Tela Codex profiles. It controls Tela-owned
browser approval cards; ChatGPT host approvals before Tela receives a tool call are outside this setting.
The optional delay is a bounded preset (`instant`, `250ms`, `500ms`, `1s`, `2s`, `5s`, `10s`, or `15s`).
The delay applies only after an eligible card is observed. Tela rechecks that same unchanged card after
waiting and uses its current button position. An absent card does not delay normal responses; a changed,
disabled, or previously activated card is never clicked automatically.

Remaining desktop and delegation requirements are tracked in [the product roadmap](docs/roadmap.md).

### macOS menu bar

The macOS source tree includes a lightweight AppKit menu-bar control surface:

```sh
bun run menu-bar:start   # build and launch it detached for ordinary development/dogfooding
bun run menu-bar
```

New source builds share an OS-managed instance lock so concurrent launches create only one menu icon.
On macOS, the installed package owns **~/Applications/ChatGPT Tela.app**. Open **ChatGPT Tela**
from Applications or Spotlight to restore the menu after **Quit Tela Menu**; reopening an
already-running copy shows its control center without starting another menu or restarting
Tela services. The packaged uninstaller removes this owned app and its LaunchAgent.
The development starter also avoids launching beside an existing installed menu bar. The lock releases
on exit or crash without polling. These source changes require a later package to update the installed
binary. Package upgrades and repairs refresh the installed menu bar through its owned macOS registration.
**Quit Tela Menu** closes only the UI; background services, browser sessions and delegated work continue.

The menu exposes a Tela connection switch for each detected ChatGPT profile; single-profile
installs show one switch. The switch preserves the user's connection choice; a short status reports
actual readiness and offers Try Again or Reopen with Tela when needed. Turning off an unattached
profile cancels that choice without closing the ordinary ChatGPT app.
Connecting an already-running ordinary app requires an explicit restart confirmation. Profile discovery
errors retain the last known list with disabled controls and a refresh message rather than claiming no
profiles exist. Background activity controls are under Settings → Tela in the Control Center. Stopping services requires interruption confirmation. Connection and approval switches use the native small control size.

Connecting opens Work immediately and reports the actual checking, closing, preparing, and connecting
stages. Controls remain disabled until a verified result arrives. A failed connection stays visible with
guidance for the failed stage and a logs shortcut; it does not automatically retry or force the app to quit.

Successful connections remember the selected target identity in Tela's own preferences. A later Codex
service startup attempts restoration once, only for fully stopped targets. Existing apps and foreign routes
are preserved and show that reconnection is needed. Explicit disconnect clears the choice; service shutdown
preserves it. Original ChatGPT configuration files remain unchanged.

It refreshes at launch and when opened (no idle polling). The menu shows Chat availability and Web profile
connections, starts Tela when needed, and opens ChatGPT or the Control Center. Approval automation lives in Settings.
The Control Center groups status in Home, profile controls and on-demand browser snapshots in Work, and
approval settings, connection details, logs, and update status in Settings. Profile stop/restart requires
confirmation before interruption; approval delay is set in Settings. The hidden Electron Codex/Web bridge calls
`app.dock.hide()` on macOS so it does not create a second Dock-centric launcher UX. Signed macOS payloads include the same menu-bar
binary and register `com.openai.chatgpt-tela.menu-bar` as a **product-owned** Aqua LaunchAgent with exact
manifest/marker ownership. Install uses `RunAtLoad=true` and explicitly kickstarts that LaunchAgent after
registration, so the menu-bar surface appears immediately after a successful install and again on normal
login. Install/uninstall therefore never relies on a name-only login-item guess.
On macOS the signed package also installs the owned **ChatGPT Tela.app** in the user's
Applications folder. It can be reopened from Finder or Spotlight after **Quit Tela Menu**;
this only reopens the menu and leaves the three services and ChatGPT browser running.
The existing installer, update, and uninstaller own the bundle and its LaunchAgent.

The menu contains **Open Tela…**, which opens a Dock-less AppKit Control Center window. Closing that
window hides only the UI; the menu-bar process and Gateway/Chat/Codex services continue running. The three
scrollable Control Center pages use the existing authenticated loopback contracts.

Each ChatGPT entry has an **Open** button and a Web connection switch. Open starts Tela when needed
and opens a closed app with Web models ready. It brings a connected app to the front; for an app
opened without Tela, it offers **Reopen with Tela** before closing or restarting anything.

You can keep using the official ChatGPT icon. If you have chosen to use Web models but open ChatGPT
without Tela, the macOS menu shows **Reopen to use Web models** and offers a reminder once per app
launch: **Later** keeps ChatGPT open, while **Reopen with Tela** reconnects it. Tela never silently
restarts the app. Keep the Tela menu running to receive this reminder. Managed profile icons can also
open without Tela; the same reminder applies. These controls do not modify the original ChatGPT app
or its default configuration. The reminder also checks apps already open when Tela starts and
rechecks after connection work finishes. Other-OS UI remains unverified.

Tela's Web model connection applies to Work running **On your computer**. In the Work composer,
open the computer/cloud menu and check the selected execution location. **In the cloud** uses the
official cloud model service, which Tela does not extend, even when that chat can access local files.
A ready Tela connection does not establish Web model availability in cloud chats. Existing cloud
chats and their history remain under the official service's ownership.

Work shows an expanded Web session list, grouped by profile only when multiple profiles are detected. Session creation, closure and title changes update this list while Work is visible; metadata updates never capture the page. Select a session for an on-demand snapshot. Hiding Work cancels the list subscriptions.

The Work browser snapshot is intentionally **observation-only**. It never reveals/focuses the hidden Electron window
or sends page actions. An explicit session selection captures that rendered surface and the private Codex service
relays a bounded JPEG to Control Center. An ended selection is cleared without choosing another session.
Snapshots are on-demand rather than idle polling; Open browser reveals the selected view and Interact enables input.

Settings reports **ChatGPT connector** health separately from Tela connection/Chat/Work process
health. For managed Tailscale Funnel, Tela distinguishes a stopped/unreachable Tailscale backend, sign-in or
offline state, missing/drifted Funnel mapping, unavailable local Gateway MCP listener, and an end-to-end public
MCP failure. `bun run cli status`, `bun run cli doctor`, and `bun run cli ingress status` expose the same causal
breakdown. In particular, quitting the Tailscale app no longer looks like an unexplained generic connector
failure: the private Gateway remains available for diagnostics while public exposure retries in the background.

### Native and Web model choices in Work/Codex

For the built-in default Desktop profile, Tela preserves Codex's Native model choices and appends live
ChatGPT-backed choices with a `(Web)` suffix. Native rows remain first-party Native requests; selecting a Web
row explicitly opts that turn into the Tela browser bridge. The Web rows are discovered from the currently
authenticated ChatGPT browser session rather than a hardcoded GPT-version/account-plan table, and the selected
family/effort is re-proved immediately before the Web message is sent.

The official Desktop composer has separate Work access, execution-location, and account usage
checks. It can disable submission in both new and existing conversations, including when a Web
model is selected. Model-list registration and direct thread execution do not prove Desktop
submission. A live routed Web turn completed with Native quota exhausted; submission through
the official Desktop composer under that condition remains unresolved.

Long-chat preparation reuses saved summaries before starting new model work. The source runtime
limits new preparation work separately from the model's context capacity; reaching that budget
preserves completed preparation and original history. It does not stop an ordinary task after a
fixed response time. Advanced runtime callers may supply `checkpointPreparationPolicy`; product
profile processes accept `CHATGPT_TELA_CHECKPOINT_PREPARATION_POLICY` as a JSON object with all three
nonnegative integer fields: `maxModelCalls`, `maxInputTokens` (estimated) and `maxElapsedMs` (new-call
admission only). For example: `{"maxModelCalls":4,"maxInputTokens":300000,"maxElapsedMs":300000}`.
These settings control Tela preparation costs and do not enlarge a model's context window. Defaults
and exact behavior are documented in [the efficiency contract](docs/token-efficiency.md#capacity-ownership-and-preparation-policy).

#### Terminal Work preview

After connecting a profile in Tela, the installed `chatgpt-tela work` command opens the official
Codex terminal UI. Profile selection is optional (`--slot 1` by default). For source development,
`bun run cli work --slot 1` uses the same terminal adapter
on that profile's existing Tela-routed app-server. Use `--thread <id>` to resume a specific
conversation and `/model` in the terminal to choose a live Web or Native model. Optional
`--model <id>` and `--cwd <path>` apply only to this invocation. No second task engine,
background service, custom provider, or configuration file is installed by this command.
The official CLI handles folder trust, approvals, model selection and active-turn controls;
trust decisions explicitly accepted there follow the official CLI's normal persistence rules.

This is a preview, not full Work parity. Native usage limits still apply to Native turns.
Web compaction requires the optional verified Tela engine preview described below; terminal
attachment alone does not enable it. Same-thread Web → Native → Web switching with exact recall
has passed a controlled terminal test after Native usage reset. The installed terminal also
completed an explicitly selected Web turn on a disposable read-only thread without Native
generation. These checks do not prove terminal submission while Native usage is fully exhausted,
write-denial enforcement after resume, or attachment to an already active turn.
Explicit read-only and full-access selections are normalized to
Native named permission profiles for clients that opt into that public API. Cold read-only
resume is verified; existing legacy selections and custom workspace-write policies are not
silently migrated. The preview is not ready for unattended task execution. A running
service/profile from an earlier build must be updated
through normal stop/start before the private terminal-session API becomes available. The official
CLI can choose its configured default model when resuming; use `/model` or explicit `--model`
to select Web before sending when Native usage is exhausted. The wrapper never changes your
saved default model or grants new permissions.

Oversized readable Web context can now use a separate tool-free Temporary Chat to summarize
its historical prefix. The latest request stays exact, and Native history is unchanged. Derived
summaries are replaceable caches; they do not decode Native encrypted compaction records.
After Native compaction, Tela can reconstruct historical visible conversation and tool evidence
through the public task API for the next Web turn. Hidden reasoning and encrypted model state
are not reconstructed. Unknown or incomplete evidence is rejected. A disposable Native tool
read → Native compaction → Web recall → Native recall test passed; Native state stayed unchanged.
This does not implement Web-initiated remote compaction.

#### Optional Web compaction engine preview

An experimental package can include a separately built official Codex engine with a narrow
model-level compaction patch. When its signed package, ownership receipt and executable bytes
are verified, Web models use the existing plaintext local-compaction path. Native models keep
their normal compaction behavior. No original application or default provider configuration is
modified. Packages without this engine reject unsupported Web compaction explicitly.

A macOS arm64 release build passed actual Web summarization, two consecutive canonical
compactions and exact identifier recall after each in a live profile. The unmodified official
engine also cold-resumed the resulting plaintext history in an isolated fixture; its Native
responses were mocked. This is a local ad-hoc signed preview, not a notarized consumer release.
Automatic Web compaction also passed with a reduced budget on a disposable thread, followed
by exact recall and an unmodified official-engine resume. The engine uses its existing local
history estimate to judge Web context pressure without inventing backend usage or changing
Native quota. Long-running default-budget operation, exhausted-quota Desktop submission,
and Windows/Linux release binaries remain unverified. Build metadata and the portable patch are in [patches/codex](patches/codex/README.md).

The optional engine is owned inside the product payload and follows the normal signed
install/update/remove lifecycle. Removing Tela removes that engine, while canonical plaintext
summaries stay in the original Codex conversation history.

Work opens each browser task in ChatGPT Temporary Chat. Before the first browser send, Tela checks
that the leased surface still has the Temporary Chat URL; it refuses to send if ChatGPT returned to
ordinary saved chat. A Temporary Chat may acquire a `/c/...` URL after its first message while the
same leased task continues. Profile setup remains on ordinary ChatGPT so login and connector setup
are available. This does not remove conversations created by older builds or manual smoke tests.

The local non-submit model-picker canary exercises that UI boundary and restores the original mode:

```sh
bun run cli model-canary --slot 1
```

The same browser-semantic canary can be run for an explicitly configured extra account, for example
`bun run cli model-canary --slot 2`. That proves the authenticated Profile 2 browser can discover,
select, read back, and restore its own current family/effort choices without sending a message. With
a Plura Desktop version that advertises the model-list overlay contract, Tela also projects those
Profile 2 `(Web)` rows into its Plura-owned Native model picker.

Retained Web-context reuse has a separate **passive** live canary. It never opens a browser or sends
an extra prompt. Use Tela Work normally for at least two turns in the same task, then inspect the
recent structural diagnostics:

```bash
bun run cli retention-canary --minutes 15
```

`status: "pass"` means a real product turn was observed with both `retained-delta` context and the
same retained browser surface. `status: "not-observed"` is not a failure; it means the selected time
window did not contain that proof (for example only a first turn was run, or a physical-pressure
rollover intentionally opened a fresh Web epoch). The command reads no prompt, tool argument/result,
file content, workspace path, or browser transcript.
Two sequential Profile 2 Web turns in one disposable Native task completed, and this canary returned
`pass` with two retained-delta/retained-surface plans. The test Native thread was deleted.

It does not send a ChatGPT message or create Native task authority. The single-profile/default Desktop path is
live-proven. A source-build Plura Profile 2 canary also proved the app-server catalog projection: 3 Web rows
appeared beside Native rows in a 10-row `model/list` result. The installed Plura version still needs this
contract before normal Profile 2 sessions expose those rows. The browser selection boundary itself
is live-proven on both Profile 1 and Profile 2; the latter currently exposes a different live family catalog,
which is why Tela treats account/browser discovery as authority rather than assuming one global model list.
A source-build Profile 2 canary also completed a Native passthrough turn through the runtime-header
route. A separate Profile 2 Web turn completed with the Temporary Chat send guard active, and its
disposable Native test thread was deleted. Direct inspection of the ChatGPT history list after that
turn is still pending.

The current status icon uses an SF Symbol as a placeholder. Its image and future per-menu-item icons are UI
assets, not protocol/authority identifiers, so they can be replaced later with custom artwork without changing
Gateway/Chat/Codex correctness. Platform UI remains native by design: macOS uses the menu bar; Windows should
use the notification area/system tray and Linux should use the desktop's supported tray/status-item mechanism
when that product UI slice is implemented. None of those UI processes may become a backend authority.

### Privacy-safe diagnostics

For canonical incident discovery, explicit private approval/DOM evidence and retention limits, see
[Diagnostic evidence](docs/diagnostics.md). Begin with `bun run cli diagnostics list`.

Gateway/backend routing, service supervision, ingress ownership, profile startup, connector selection,
approval policy, Tela Chat capability calls, and Tela Codex profile/tool boundaries emit bounded structural
events. Diagnostic field names that could carry prompts, paths/URLs, commands/output, credentials, cookies,
session/turn capabilities, workspace/account/user ids, or request contents are rejected. Optional JSONL sinks
are private mode-0600 files with bounded rotation; diagnostic failure never changes the product operation.

`bun run cli diagnostics` is deliberately metadata-only: it reports whether the standard service/diagnostic
files exist, their byte sizes, and whether the single rotated predecessor exists. It never opens those files,
prints their filesystem paths, or returns event payloads. This makes it safe to use as the first support/health
check before a user explicitly chooses to inspect a local log.

For UI/performance investigations, `bun run cli diagnostics workload --minutes 15` reads only Tela's already
emitted, privacy-bounded Chat/Codex diagnostic JSONL and returns structural counts plus request/result byte totals. It
does not return prompts, tool arguments, commands, file contents, tool output, paths, or raw event payloads.
Each diagnostic event now carries an ISO timestamp so this workload view can be aligned with an independent OS
sampler such as MacLagMonitor. Chat completion events record result byte size and bounded/truncated indicators;
Codex Native-tool completion events record request/result byte sizes and error state. This is the product-owned
evidence needed to distinguish "many tool calls" from "a few very large results".

For an on-demand macOS scroll investigation, run `bun run cli diagnostics desktop --seconds 20`
and reproduce the slow scroll during that interval. This source diagnostic uses OS process CPU-time deltas
and memory sizes, grouped into Desktop, renderer, GPU, Desktop service, Tela, and compositor roles. External
executable conventions are isolated in the diagnostic adapter; unmatched processes are omitted. It emits
no process IDs, paths, arguments, account information, or screen/chat content, and saves nothing automatically.
It stops after the requested 5–60 samples and does not restart apps or install background monitoring.
CPU percentages refer to one core; summed RSS may count shared memory twice. These measurements show
activity, not frame latency or proof of a cause. Windows/Linux observation is not yet supported.

`bun run cli diagnostics incident --minutes 15` shows a bounded timeline around the latest Work/Codex failure.
`bun run cli diagnostics trace --minutes 15` shows recent structural events on demand. Both views omit prompts,
tool arguments, paths, and arbitrary diagnostic fields.

For the dedicated source profile used by Tela Codex, run the setup-only profile helper with
`CHATGPT_TELA_PROFILE_SETUP_REVEAL=1` for the target slot when login, Developer Mode, or the Plugin connection
still needs manual preparation.

For the live canary's dedicated ChatGPT browser profile, developers can prepare login/Developer Mode
without starting Responses, MCP exposure, or changing a Codex route:

```sh
CHATGPT_TELA_PROFILE_SETUP_SLOT=1 bun run profile:setup
```

The helper exits immediately if readiness is already proven. Otherwise it opens the dedicated ChatGPT
profile; after manual preparation, `Ctrl+C` performs one final non-submitting readiness proof and closes
the owned Electron surfaces. Profile slots are account-isolated: slot 1 uses `Profile1-ChatGPT-Tela` /
`Canary-Profile1`, slot 2 uses `Profile2-ChatGPT-Tela` / `Canary-Profile2`, and so on. Set up another
account with `CHATGPT_TELA_PROFILE_SETUP_SLOT=2 bun run profile:setup`. Setup stores only a SHA-256
fingerprint of the verified ChatGPT account for each slot. Separate slots may intentionally use the
same account. Changing accounts requires completing setup for the affected slot; it does not change
another slot's binding or share its browser session.
`CHATGPT_TELA_PROFILE_ROOT` may override the platform-native root directory when explicitly needed.
Set `CHATGPT_TELA_PROFILE_SETUP_REVEAL=1` to keep an already-ready profile's setup-only browser visible
for later Developer Mode or connector management; it still starts no Responses, MCP, or Native route.

Before a live canary, `bun run canary:preflight` uses the same explicit non-secret profile/port/exposure
settings but does not require the Responses runtime token, MCP bearer token, or Secure Tunnel runtime key.
It starts no Responses/MCP services, mutates no Codex config, launches no Multi-Profile target, and acquires
no external tunnel. It briefly checks the configured loopback ports, reads the relevant Native profile
contract, and performs one hidden non-submitting ChatGPT readiness observation. Its JSON output separates
`pass`, `warning`, and `blocked` checks so account login/restart boundaries are visible before routing.

Canaries are intentionally development-only and use **ChatGPT Tela Development**. The product's stable
**ChatGPT Tela** connector is served only by Gateway, so canary experiments cannot consume or mutate the
public connector namespace.

The public release gate is stricter than a green source build: before ChatGPT Tela is published for general
use, this README must contain the complete supported installation, setup, verification, and basic-use
path so a new user does not need private project instructions. Cross-platform verification targets
macOS, Windows, and Linux.

## Project policy

ChatGPT Tela starts without compatibility code for earlier bridges. Existing projects can be used as
behavioral references, but compatibility and migration paths are added only when a concrete public
contract requires them.

ChatGPT Tela is an independent, unofficial project and is not affiliated with OpenAI.

## License

[MIT](LICENSE)


### macOS maintenance preview

Open the control center → Settings → **Updates & maintenance → Open…** to update, repair, or remove Tela.
For an update or repair, select an extracted package from a trusted source. Repair needs the installed
version. This preview does not yet download updates automatically.

Choose **Review changes** to see the version change and the resources to replace, remove, or preserve.
Reviewing or dismissing the confirmation applies no changes. Applying can close connected ChatGPT profiles; finish active
work first. Removal keeps Tela settings and saved logins by default; removing them requires the explicit
checkbox. Projects and original ChatGPT data are preserved.

When an update is unfinished, **Cancel unfinished update** offers a separate review. It requires the
retained package for the installed version and a launcher with
cancellation support. Cancellation is available only before file replacement starts; it keeps the
installed files and restores previously running services that stopped. Once replacement has begun,
resume with the original update package instead. A changed recovery checkpoint requires a new review.

The separate maintenance window stays open after the installed menu bar stops. If installed files are
damaged, choose a signed same-version repair package when prompted. If the launcher itself is missing,
use a separately extracted trusted installer. CLI lifecycle commands remain available on other platforms.
