# ChatGPT Tela

**One ChatGPT integration, two independent local runtimes: Chat and Codex.**

ChatGPT Tela is being refactored into one installable product with one **ChatGPT Tela Plugin**, one
user-registered ChatGPT App, and one public Gateway ingress, while keeping its two execution paths independent:

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

## Product goals

The product treats the following as explicit design principles:

- **Mainstream-first** — the most common supported environment is the default path. Multi-profile, special browser/runtime, and development-only modes stay optional and must not contaminate core correctness.
- **Change-resilient** — OpenAI-owned model/tool names, ChatGPT DOM/UI details, executable locations, and incidental protocol fields are discovered at runtime or isolated behind adapters rather than spread as product-wide constants.
- **Fail closed** — ambiguous external structure, ownership, or destructive state stops with a diagnostic/proof requirement rather than a guessed mutation.
- **Easy in, easy out** — install/update/repair/uninstall are symmetric ownership lifecycles with explicit provenance and complete removal of Tela-owned resources.
- **Consistent naming** — `Tela` is the product brand; ChatGPT/Codex describe integrations. Public repo, CLI, process, protocol, and data namespaces converge on Tela-owned names rather than inheriting external project identities.
- **Multi-OS and efficient by default** — macOS, Windows, and Linux remain architectural targets; long-running work is event-driven/on-demand, with idle CPU, wakeups, battery, I/O, and log volume treated as design constraints.
- **Evidence-first diagnostics** — failure-triggered, structured, privacy-safe, bounded evidence is preferred over always-on telemetry or ad-hoc raw logs.

- Make installation, repair, upgrade, and **complete removal** first-class product lifecycles. Tela records
  what it owns and never relies on an undocumented cleanup checklist.
- Present one **ChatGPT Tela** plugin backed by one registered ChatGPT Tela MCP App and one public ingress.
  The plugin references the registered App through `.app.json`; it does not bundle the user's machine URL in
  `mcp.json`.
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
- Support macOS, Windows, and Linux by default and verify all three in CI.
- Stay quiet when idle and collect deeper diagnostics only at a bounded failure boundary.

## Target architecture

The initial ownership boundaries are documented in [docs/architecture.md](docs/architecture.md).
The short version:

```text
                           ChatGPT
                              |
                    ChatGPT Tela Plugin
                              |
                    one ChatGPT Tela App
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
packages/gateway       public-ingress/backend routing and legacy v1 gateway compatibility
packages/chat-service  new independent Chat workspace/process service
packages/codex-service independent Codex profile/Responses/browser service
packages/control-plane compatibility composition root while service daemons replace the old monolith
apps/cli               development entry point
apps/packaged-launcher stable installed service launcher that verifies and dispatches the signed payload
apps/package-build      source release-payload builder/signing entry point
apps/control-daemon    source control-plane daemon
apps/gateway-daemon    standalone Tela Gateway process
apps/chat-daemon       standalone Tela Chat process
apps/codex-daemon      standalone Tela Codex process
apps/profile-runtime   one isolated Electron/Responses runtime per product profile slot
apps/profile-setup     setup-only Electron profile preparation helper
apps/canary-preflight  non-mutating live-canary prerequisite checker
```

The current source control plane already separates one public MCP listener from profile-specific
Electron/Responses children. The refactor moves public ingress into Tela Gateway and turns the current
profile/controller logic into Tela Codex. Tela Chat is a new sibling service, not a library inside Codex.

The first Tela Chat source slice is executable behind its private service boundary. A **locally approved**
workspace root can be opened and used for bounded `read`/`read_many`, transactional `apply_patch`, resumable
`exec_command`/`write_stdin`/`process_status`, and Git-backed `show_changes`. `show_changes` also attempts to
create a bounded `reviewRef`; `show_review` and `list_reviews` reopen those exact historical snapshots even
after later edits or a Chat daemon restart. Approving a root grants runtime access; it does **not** make the
repository product-owned or eligible for uninstall deletion.

Development root approval is explicit:

```sh
bun run cli chat allow-root --path /absolute/path/to/project
bun run cli chat roots
```

The standalone `chat-daemon` reads those approved roots at startup. Path traversal and symlink escapes fail
closed. Durable process-operation metadata stores no command/output/environment/filesystem-path payload, and
a service restart never reattaches stdin/stdout to an old PID merely because that numeric PID still exists.

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

The source pre-alpha uninstaller supports both a reviewable dry-run and explicit apply for resources already
covered by exact ownership adapters:

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
application/binary layout now exists, but Developer ID/notarization plus the final end-user installer/updater
surface remain release work, so this source uninstaller is not yet the complete end-user product uninstaller.

The product-lifecycle package also has a concrete packaged-install operator. It plans without touching disk,
fingerprints the exact staged payload, creates only a marker-owned binary root, and registers the three
platform-native service registrations from exact generated definitions. Apply records create intents before
mutation and verification catches interrupted copies/registration; registrations are installed dormant rather
than starting before product setup.

The source tree now also builds a **signed multi-file runtime payload**. `bun run package:build` compiles one
stable `chatgpt-tela` launcher plus separate Gateway/Chat/Codex executables, bundles the Electron profile
runtime and its CJS entrypoint, writes the versioned package manifest, applies platform-native signing before
the package fingerprint is frozen, and finally signs the tree fingerprint with an Ed25519 release key. OS
service registrations point only at the stable launcher; the launcher re-proves the install manifest and
payload receipt, reads the package manifest, and dispatches the exact service child. Codex receives the
packaged Electron/profile-runtime paths from that manifest rather than a hardcoded install layout.

On macOS, the package builder requires an explicit codesign identity. `-` is supported only for local
ad-hoc development proof; a public release still needs a Developer ID identity and notarization. The payload
retains only **relative internal symlinks whose lexical and resolved targets remain inside the payload root**,
because Electron frameworks require those links for a valid bundle. Absolute, broken/cyclic, or escaping
links fail closed; the link path and target text are covered by the payload fingerprint and reproduced exactly
at install.

On Windows, those registrations are current-user interactive Scheduled Tasks with no trigger, not
`LocalSystem` services. That keeps Gateway/Chat/Codex in the same user profile and Desktop session as Tela's
config, ChatGPT state, and built-in Desktop adapter while still providing explicit normal start/stop control.

The signed payload is self-describing through `chatgpt-tela-package-v1.json`: it declares the product version,
stable launcher, exact Gateway/Chat/Codex executables, packaged Electron/profile-runtime entrypoints, and the
release signing key id. Signed install/upgrade entrypoints verify the Ed25519 signature before planning/apply,
and apply re-verifies payload bytes independently through the existing ownership receipt.

A live macOS packaging proof compiled all four Bun executables, bundled the 1.40 MB profile runtime plus the
Electron distribution, re-signed the Mach-O/Electron bundle, verified strict/deep codesign, then verified the
Ed25519 tree signature. The signed payload was installed into a temporary HOME using fixture-only LaunchAgent
registration, after which the installed compiled `chatgpt-tela service chat` launcher started the installed
compiled Chat daemon, returned authenticated `ready`, accepted `/v1/shutdown`, exited normally, and removed
its runtime descriptor. No real user launchd registration, Tailscale route, or ChatGPT profile was modified.

Cross-version packaged upgrade also has an interruption-safe state machine. It requires stable service
registration identities, durably records which services were running, quiesces all three before binary
replacement, commits the target product version only after exact payload verification, and restores only the
services that were previously running. A failed restart leaves the journal at the committed target version so
a retry resumes only the outstanding restart. Ordinary `start` and destructive uninstall apply refuse to run
while that journal exists. The packaged service controller now implements normal status/stop/start for
launchd, systemd user units, and Windows per-user Scheduled Tasks; a signed updater UI and real-OS packaged
E2E validation still need to drive/prove this lifecycle for end users.

Same-version packaged **repair** is a separate signed, interruption-safe transition rather than a reinstall
shortcut. Normal install still preserves completed payload byte drift. Repair may restore payload bytes only
when the exact install manifest, binary-directory ownership marker, and original payload receipt still prove
the same install/version/payload fingerprint. Missing exact service registrations can be recreated; foreign or
replaced service definitions remain preserved. Binary repair writes its own durable journal before quiescing
exact-owned services, verifies payload and registrations after repair, and resumes only services that were
running before the repair. A restart failure leaves the journal for idempotent retry of only outstanding work.
Repair and upgrade journals are mutually exclusive, and packaged service launch/install, ordinary source
start, and destructive uninstall apply refuse to cross an incomplete transition.

Signed repair plan/apply entrypoints use the same Ed25519 package trust boundary as signed install/upgrade.
Tela intentionally does not expose a development repair command that accepts an arbitrary public key or an
unsigned payload; the final updater/installer UI must provide the trusted release-key set.

## Developer preview

ChatGPT Tela is not yet packaged as an end-user product. The Tela Codex bridge has passed live
end-to-end canaries on both the stock/default Native profile and an isolated managed second profile. The
source CLI now supervises **Gateway, Chat, and Codex as separate daemons** for `start`, `stop`, `profiles`,
`status`, and `shutdown`; the old one-process control daemon is retained only as a migration/normal-shutdown
compatibility path while existing development sessions are phased out. ChatGPT MCP App creation/connection
remains manual and the current public exposure modes are development-only. Tela Chat has its first
workspace/file/process/review slice, ownership-safe managed worktrees, and bounded privacy-safe failure
incidents, plus an optional OpenAI Responses agent over bounded workspace read/patch authority. Installed
service credential provisioning now exists through a per-user platform credential store; a real external
provider call still requires a user credential. General artifact transfer, the frozen one-plugin public generation, Developer ID/notarized release packaging,
and the final end-user installer/updater surface remain active pre-alpha work.

ChatGPT Tela currently requires Bun 1.4.0:

```sh
bun install --frozen-lockfile
bun run verify
bun run cli doctor
bun run package:smoke
bun run cli status
```

CI runs the same `package:smoke` on macOS, Windows, and Linux. It generates an ephemeral Ed25519 key, compiles
the stable launcher plus separate Gateway/Chat/Codex executables, stages the real Electron/profile runtime,
verifies the signed package tree, and executes the packaged launcher's CLI boundary. macOS additionally uses
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

**Plura Desktop** is therefore an optional advanced adapter for additional isolated accounts, not a required
dependency. Even when configured, canonical slot 1 always uses Tela's built-in official Desktop adapter;
Plura contributes only slot 2 and above through its public target/session contract. Ordinary single-account
users do not install or traverse that adapter path.

The macOS source path has also passed a live product-lifecycle smoke with an already-running managed Profile 2:
plain `bun run cli start` brought up slot 1 through the built-in official Desktop adapter, the public frozen
ChatGPT Tela endpoint stayed reachable, `bun run cli stop` removed only slot 1/Gateway/Codex, and Profile 2 stayed
ready throughout. A final `shutdown` removed the independent Chat daemon without touching Profile 2.

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
as an external matching route, but uninstall will not delete it. This is deliberate migration safety: an
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

Startup is fail-closed. It verifies account binding, proves that the exact connector identity for the
configured ABI can be selected without sending a message, removes the temporary connector selection, and proves a second fresh
ChatGPT surface is still ready before changing the Native route. Existing non-empty ChatGPT drafts are
preserved rather than overwritten; clear or finish the draft with `bun run cli setup` for the default account,
or `bun run cli setup --slot <n>` for an extra account, before starting it. Connector-probe cleanup uses trusted browser keyboard input and a bounded persistence
window; a secret-free local pending marker allows an interrupted probe to recover only its own exact stale
mention on the next start instead of guessing that an arbitrary draft belongs to Tela. An already-running
unrouted launcher target is normally quit once before routed launch,
but a target carrying another Responses route fingerprint is never taken over.

Stop also preserves ownership boundaries. ChatGPT Tela requests a normal desktop quit only while the
launcher's current Responses route fingerprint still matches the child it owns. If another process has
replaced that route, Tela treats its child as orphaned and cleans only its own browser/Responses/MCP state;
the unrelated Native target is preserved.

```sh
bun run cli stop
bun run cli shutdown
```

An advanced profile is stopped explicitly with `bun run cli stop --slot <n>`.

The persistent control config contains no runtime bearer secrets. Per-profile Responses/internal-MCP
credentials are generated for each start, while each Gateway/Chat/Codex daemon writes its own mode-600
loopback runtime descriptor with an ephemeral bearer. `status` probes each service independently. `shutdown`
quiesces Gateway first, then asks Chat and Codex to stop independently; one backend shutdown failure does not
skip the other backend's normal shutdown attempt. A live legacy control-daemon state is detected rather than
silently starting a second owner on the same public route.

Configuration storage is now migrating away from the old Profile1-scoped control-plane path. `configure`
writes canonical `product-v1.json` under Tela's platform-native product config root and also writes a legacy
compatibility copy for current source tooling. Reads prefer the canonical file; a malformed canonical file is
an error rather than a reason to fall back. The future packaged runtime therefore has no configuration
dependency on a ChatGPT browser profile.

### Manual ChatGPT Tela App + plugin setup (pre-alpha)

The intended product surface is **one ChatGPT Tela plugin**. That plugin references **one ChatGPT Tela App**
whose single MCP endpoint exposes both Tela Chat and Tela Codex controls. The App owns only the ChatGPT-side
connection metadata; Gateway still routes Chat and Codex to independent local services, so failure of one
backend does not make the other unavailable.

For the current stable pre-alpha source path, the user supplies their own reachable HTTPS MCP connection once.
Tela can manage one exact Tailscale Funnel route or verify an HTTPS route owned elsewhere. The connection is
intentionally user-specific and is never committed to this repository. The existing OpenAI Secure MCP Tunnel
adapter remains a development/canary exposure until it is promoted into the stable product configuration.

1. Start/configure Tela so its stable Gateway MCP endpoint is reachable.
2. Enable ChatGPT **Developer Mode**.
3. In ChatGPT Plugins, create one MCP App named exactly **ChatGPT Tela** and point it at the stable Tela
   endpoint. Configure authentication/permissions to match that exposure.
4. After ChatGPT creates the App, copy its technical id from the browser URL. Current Developer Mode App ids
   begin with `plugin_asdk_app_`.
5. Build the user-specific plugin package that references that already-registered App:

```sh
bun run plugin:package \
  --app-id plugin_asdk_app_REPLACE_WITH_YOUR_APP_ID \
  --output build/chatgpt-tela-plugin.tar.gz
```

6. Create/install one private **ChatGPT Tela** plugin from that archive using Plugin Creator. The generated
   package contains `.app.json` plus the Tela routing skill and contains **no** `mcp.json` or `.mcp.json`,
   so the user's MCP URL remains owned by the registered App rather than being bundled into a Desktop-only
   plugin.
7. Use the same installed plugin for ordinary ChatGPT workspace requests and for the Tela Codex/Web path.
   Do not create separate Chat and Codex plugins.

See [Plugin and App setup](docs/chatgpt-plugin.md) for the package layout, failure-domain model, and
surface-availability caveats.

The bundled routing skill is deliberately guidance rather than authority. In ordinary ChatGPT it directs
local project requests to Tela Chat and avoids invoking Tela for unrelated conversation. In the Codex/Web
path it requires the exact active Native turn capability and runtime-discovered Native tool inventory.
Runtime ownership, approved roots, exact-turn authority, sandboxing, and destructive-action safety continue
to be enforced in code even if a model ignores natural-language guidance.

Optional isolated ChatGPT accounts need their own App connection because ChatGPT account/session state is
isolated. They still use the same Tela plugin design and the same Gateway endpoint; ordinary single-account
users do not traverse the multi-profile setup.

For the dedicated source profile used by Tela Codex, run the setup-only profile helper with
`CHATGPT_TELA_PROFILE_SETUP_REVEAL=1` for the target slot when login, Developer Mode, or the App connection
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
fingerprint of the verified ChatGPT account and rejects binding the same account to two different slots.
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
