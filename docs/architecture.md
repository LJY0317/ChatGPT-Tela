# Architecture

ChatGPT Tela is designed around two premises:

1. Chat/workspace execution and Codex/Web execution are separate services and must remain separate failure
   domains even though the user connects one ChatGPT Tela Plugin to one public MCP endpoint.
2. Inside Tela Codex, a web application is an unversioned external dependency while the Native Codex task is
   the durable source of task authority.

The product therefore separates public ingress from both execution services, and separately keeps Codex
correctness independent from web representation, browser lifecycle, MCP transport, and launcher UI.

## Product service topology

```text
                           ChatGPT
                              |
                    ChatGPT Tela Plugin
                              |
                       Tailscale Funnel
                              |
                              v
                         Tela Gateway
                    auth / routing / health
                      /               \
                     /                 \
              Tela Chat             Tela Codex
             own process            own process tree
             own state/db           own profiles/state
             own lifecycle          own lifecycle
```

Tela Gateway is the only intentional shared runtime availability domain. It owns public MCP framing,
authentication, backend routing, bounded backend-availability state, and the product Tailscale route lease.
It owns no workspace, worktree, process session, agent, Native Codex task, Responses state, browser profile,
or ChatGPT conversation.

Tela Chat and Tela Codex are peers. Normal Chat execution must not initialize or traverse Codex/Responses/
browser code. Normal Codex execution must not initialize or traverse Chat workspace/process/agent code. A
backend may be absent, crashed, restarting, upgraded, or unhealthy while Gateway continues routing the other
backend. This is a product invariant.

The source implementation now enforces that topology with three standalone daemons and per-service
authenticated loopback descriptors. A common supervisor reuses only an exact live descriptor from the same
install instance, removes a stale descriptor only after its recorded PID is no longer alive, and refuses to
replace a process that is still alive but has an unavailable private endpoint. Normal shutdown uses each
service's private `/v1/shutdown` contract rather than signaling an ambiguous PID.

Gateway's stable public MCP surface is descriptor-dynamic: `tools/list` does not require either backend to
be running. The fixed **ChatGPT Tela** schema contains only four controls: Chat capability inventory/call and
Codex tool inventory/call. Chat capability names and input schemas come from the private Chat service at
runtime, while Native Codex tool names/schemas come from the exact active turn. Adding an
agent/artifact/workspace capability or observing a new Native tool therefore does not mutate the public
connector ABI. The frozen fingerprint is
`a353771847d4de9d87264758e5350eb33bea98540748a033c0744884d69916f9`.

The public connector's internal compatibility generation is `1`, but users see only **ChatGPT Tela**. An
unfrozen `unified-development` surface remains separately available under **ChatGPT Tela Development** for
experiments with direct `tela_chat_*` tools. Both surfaces resolve backend descriptors only at call time, so a
backend restart can make only that backend's calls unavailable without taking down Gateway or the other
backend.

The source Gateway can compose its configured MCP listener with a managed Tailscale Funnel exposure. The
exposure factory receives the already-bound loopback MCP endpoint, acquires only the configured public path,
and then verifies that exact configured public MCP contract/fingerprint. Tailscale ownership is install-scoped: normal Gateway shutdown keeps a
verified owned route, while a startup failure rolls back only a route created by that failed prepare. A
pre-existing matching path without an install-manifest record is usable but remains externally owned.

Tela Chat is a new implementation. The local DevSpace patches are a behavioral/reference specification for
workspace/worktree ownership, restart-safe processes, bounded reads, review, agents, artifacts, and
diagnostics; their implementation is not imported into the new service.

Tela Codex contains the existing proven Native/Web runtime. The user-facing **ChatGPT Tela** integration is
normally created by connecting the frozen Gateway endpoint through ChatGPT's built-in Plugins `+` / MCP-app
flow. The natural-language Plugin Creator path is a second long-term packaging surface over the same Gateway,
not a second runtime identity. ChatGPT owns the saved endpoint/authentication metadata; Tela keeps correctness
guidance at the MCP/runtime boundaries so direct-MCP setup remains complete. The two execution paths remain
separate services behind Gateway.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Tela Gateway | public MCP/auth/Tailscale ingress, backend routing, bounded backend availability state |
| Tela Chat | workspace/worktree/process/agent/review/artifact state and local execution authority |
| Tela Codex | Codex/Web composition, profile lifecycle, and private Codex gateway protocol |
| Native Codex | task/thread identity, current turn, cwd/workspace, sandbox policy, native tool inventory |
| Codex adapter | bind the current Native request to canonical Native evidence and project its runtime tool inventory |
| Core runtime | turn lifecycle, logical context, revision lineage, resume, compaction policy, tool binding |
| ChatGPT provider | semantic observations, capabilities, actions, and proofs for the current web product |
| Browser host | browser sessions, surfaces, navigation, visibility, and lifecycle |
| MCP layer | stable public tool ABI and exact invocation binding |
| Exposure provider | making the MCP endpoint reachable, not deciding tool semantics |
| Installed launcher | re-prove signed/owned payload state and dispatch the exact manifest-defined Gateway/Chat/Codex child |
| Product UI/launcher | setup/status/login/diagnostics/update UI and runtime control; macOS menu-bar UX only, never backend authority |

No projection may silently become authority for a responsibility owned above it. In particular, Tela Gateway
may route an authenticated request but may not manufacture either Chat workspace authority or Codex
task/tool authority.

The packaged runtime is intentionally multi-file. OS service registrations target one stable root-level Tela
launcher so their identities remain stable across payload upgrades. The launcher does not implement backend
logic; it verifies the installed ownership manifest/receipt, reads the signed package manifest, resolves one
exact child executable inside the binary root, derives only Tela-owned runtime environment such as install id,
Gateway exposure, and Codex packaged profile-runtime paths, then supervises that child's process lifetime.
Gateway, Chat, and Codex therefore remain separate executables/processes/failure domains even though they share
one signed product payload.

On macOS the dedicated hidden Electron profile runtime is an implementation detail and does not own a Dock
presence. A small AppKit menu-bar process is the intended local control surface. It refreshes status on demand,
calls only Tela's private authenticated loopback contracts, and may expose user preferences such as one-shot
approval automation. Signed installs own its Aqua LaunchAgent separately as a `product` resource; it is never
counted as a fourth backend service and cannot manufacture workspace, turn, sandbox, or tool authority.
The LaunchAgent is `RunAtLoad` and install explicitly kickstarts it after exact registration so successful
installation produces a visible menu-bar surface immediately rather than waiting for the next login.

The same accessory process owns a normal resizable **Control Center** window. Because the application remains
an AppKit accessory, opening the window does not create a permanent Dock presence; closing the last Control
Center window hides only that window and leaves the background product running. The menu bar is the quick
surface while the Control Center is the larger status/settings/recovery surface.

Bridge observation is deliberately weaker than bridge authority. An active Electron Work/Codex surface may
expose a bounded read-only capture capability to its owner. The product profile runtime serves that snapshot
over a per-profile authenticated loopback endpoint; Tela Codex proxies only the validated image/status through
its private service contract; and the Control Center renders it as a non-interactive image. Capturing does not
show or focus the BrowserWindow and does not inject page input. A snapshot is available only when exactly one
active task/epoch surface exists for that profile. This prevents the UI from selecting among concurrent work or
turning a debugging/view surface into a second source of browser authority.

This UI boundary is platform-native rather than macOS-shaped core logic. The corresponding Windows product UI
belongs in the notification area/system tray; Linux should use an available desktop status-item/tray protocol.
Those surfaces may differ in lifecycle and presentation while sharing only the private product-control
contracts. A missing/restarting UI surface must never take Gateway, Chat, or Codex down with it.

Performance diagnosis follows the same ownership boundary. Tela records only product-owned structural load:
timestamped Chat capability completions, Native tool invocation counts, bounded request/result byte sizes,
truncation/has-more state, and duration/error metadata. It never records prompts, commands, arguments, file
contents, or tool-result text for this purpose. OS-wide renderer/GPU/WindowServer CPU and RSS remain the job of
an independent system monitor. Correlating those two timestamped streams is preferred over hard-coding foreign
process names or continuous profilers into Tela.

### Native logical context and retained Web epochs

Native Codex history and a ChatGPT Web conversation deliberately have different lifetimes. Native
history is canonical; a Web conversation is a replaceable physical projection. A successful Web
turn may leave its hidden browser surface retained for the next Native turn in the same exact
task/model/effort Web epoch. That continuation sends only the canonical suffix after the previously
committed Web answer. The planner may advance that retained anchor only after a proven completed
Web answer is observed again in the later canonical Native lineage. A branch change, model/effort
change, missing/mismatched prior answer, ambiguous submission, timeout or provider failure forces a
fresh physical surface instead of guessing.

`logicalTokens` therefore always describes the complete canonical Native active lineage, while
`transferTokens` describes only the current physical Web transaction. A retained continuation can
have a large logical context and a very small transfer. This distinction is observable in privacy-
safe Work diagnostics and must remain intact when later projection, file transport or multipart
transport optimizations are added.

Web-epoch rollover is intentionally independent from Native compaction. Tela may eventually retire a
physical Web conversation because the observed browser/model transport is approaching a physical
limit without asking Native Codex to rewrite its logical history. Conversely Native compaction is a
Native authority event and can force a new Web epoch. Physical-pressure rollover remains fail-closed
and uses a single isolated calibration table inherited from the downstream Web harness. Those limits
govern disposable Web state only and never define Native history. Pressure is estimated as the fresh
epoch's physical transfer baseline plus non-negative Native logical growth since that boundary; this
therefore includes prior assistant output already resident in the retained ChatGPT conversation even
though later suffix transport does not resend it. If a fresh projection necessarily begins above the
soft rollover boundary, that epoch owns the remaining verified hard-window headroom rather than
immediately reconstructing an equally large conversation.

Every prepared browser message also emits only its character count alongside logical/transfer token
counts. No prompt text is recorded. A later hard-fit planner may use the same isolated calibration to
reduce only already-designated provider projection budgets before a fresh submit. The current planner
does exactly that: it binary-searches the provider-only assistant/tool aggregate budgets to preserve
the maximum settled evidence below the soft rollover boundary. If the irreducible view already starts
above soft pressure but below the hard context window, it uses only the remaining hard-window
headroom; if the irreducible view itself exceeds the hard window, the turn fails before browser
mutation and Native history remains unchanged. The exact final formatted composer message is also
checked against the effort-specific character limit before model selection or `markSubmitted()`.

The historical reasons and remaining parity work inherited from CodexGPTWeb experimentation are
tracked in `docs/codexgptweb-assimilation.md` so removal of the old installation/source checkout does
not erase the product requirements it uncovered.

Fresh Web epochs also apply a deterministic provider-only projection to settled model/tool evidence.
System, developer, user and steering authority, the active request, tool-call linkage and tool-search
registry evidence stay exact. Older assistant prose and settled tool-result payloads may be truncated
or replaced by explicit omission markers under bounded aggregate budgets. This projection never
changes Native history, never grants authority and is never applied a second time to an exact retained
suffix. Diagnostics report only structural counts and before/after byte sizes, not the omitted text.

## Dogfooding and self-maintenance

The product should be capable of developing itself through its public/user-facing execution surfaces:

- **Tela Chat** is the local-work surface and should converge on DevSpace-level ergonomics around workspace
  discovery, bounded file operations, process execution, review, worktree isolation, and agent delegation.
- **Tela Work/Codex** is the exact-turn Native/Web composition surface and should converge on the smooth
  CodexGPTWeb-style experience where Web reasoning transparently uses the current Native Codex authority and
  tools, consumes their results, and continues the same turn.

This does not merge their authority. Tela Chat still owns only its approved workspace/process/agent state,
while Native Codex remains canonical for Work/Codex task, turn, sandbox, and Native tool authority. The common
goal is orchestration quality: a normal user request should select and sequence the existing capabilities
without exposing internal routing mechanics.

Product self-maintenance follows the same rule. Natural-language requests to update, reinstall, repair, keep
data while removing Tela, or completely remove Tela are translated into typed lifecycle operations rather
than arbitrary shell authority. The intended boundary is:

```text
Chat / Work request
  -> lifecycle capability
  -> inspect + non-destructive plan
  -> explicit destructive scope when required
  -> signed external maintenance helper
  -> stop owned services
  -> install / repair / upgrade / uninstall
  -> verify
  -> restart or final cleanup
```

The external helper is intentional. The running Tela binary should not depend on deleting/replacing itself,
especially on Windows. Release builds should pin the trusted release-key set in the signed maintenance UX;
model-generated commands and package-provided keys are not trust roots.

## Capability names and unstable dependencies

OpenAI-owned or runtime-owned names are observations, not product constants. Model identifiers, Native Codex
tool names, configured external MCP/App tool names, app-server provider details, and ChatGPT DOM structure
must be runtime-discovered or isolated behind narrow adapters. They must not become global correctness keys.

Only contracts owned by Tela may be intentionally named and versioned: public MCP schema generations,
private Gateway-to-backend protocols, and stable Tela Chat capabilities. Breaking a frozen public schema
creates a new generation rather than changing one in place.

## Core runtime

### Native authority

Each accepted native turn must be tied to canonical Codex evidence for its exact current task and
turn. Request-side web metadata is a consistency claim, never a way to manufacture filesystem or
tool authority.

Bridge caches are disposable. Deleting them may make recovery slower, but must not change which
workspace, sandbox, or tools are authorized.

The Codex request itself supplies current-turn identity and runtime tool advertisements, but request
filesystem/sandbox fields do not create authority. The normal single-profile path binds against the
live Codex sessions state. When `task_started` precedes a new `turn_context`, the task boundary may
bind the new turn while the latest prior canonical context remains the conservative environment source
until the new context arrives.

Managed runtimes may intentionally hide `CODEX_HOME`. For those runtimes, ChatGPT Tela can bind through
Codex app-server's public v2 read contract instead: `thread/read` must prove the thread is active and
`thread/turns/list` must prove exactly one newest `inProgress` turn. Cwd and workspace roots come only
from app-server thread/environment state. App-server does not expose the complete per-turn sandbox
policy, so that authority is represented as `native-enforced`: ChatGPT Tela may route the exact tool
call back to Native Codex, but may not turn that opaque policy into direct filesystem/network authority
of its own. The app-server observer is demand-only and closes its connection after each proof.

The current Tela Codex product path consumes the launcher's public versioned control contract for both the
canonical `default` target and installed managed profiles. ChatGPT Tela never reconstructs managed
`CODEX_HOME`, browser-state paths, selectors, or profile-numbering rules. An explicitly configured
control CLI returns public targets, accepts a loopback Responses route at `launch-target`, and returns
the canonical loopback app-server endpoint plus a non-secret route fingerprint. The Responses bearer
value is inherited through a named environment variable and never placed on argv. The launcher's
fingerprint also binds a one-way hash of that high-entropy credential, so a live target cannot be
reused after token rotation merely because the URL and env-key name stayed the same. The returned
app-server endpoint then feeds the same `AppServerCurrentTurnSource` authority path above.

Development stock canaries retain a process-local route that does not depend on the launcher. That is a
diagnostic/proof path rather than a second product ownership model.

### Logical context and physical transport

ChatGPT Tela models the task history as a revision lineage. The active logical context is the path from the
current head to its root.

Physical transport is a projection:

```text
logical revision head
        |
        v
context planner
   |          |
   |          +-- accepted checkpoint + delta
   +------------- full active lineage
        |
        v
web transport representation
```

A checkpoint is an efficiency artifact anchored to a logical revision. It is never the authority for
which revision is current. Steering creates a new lineage head, so superseded descendants naturally
drop out of later physical plans.

The planner chooses the cheapest semantically complete representation that fits the transport budget.
If no representation fits, it requests a new checkpoint rather than silently dropping context.

Native task identity is independent of a ChatGPT conversation. One task may span multiple web
conversation epochs after compaction, product failures, or deliberate fresh-chat continuation.

Accepted web work is never automatically resubmitted merely because observation is uncertain.

The initial Native Responses request is also carried across the canonical binding boundary as data
for Web-turn planning. It never creates filesystem/tool authority. The first development planner
projects only `instructions` and supported `input` items into a logical revision chain, then runs that
chain through the normal physical-context planner. Revision ids are derived from Native task identity,
semantic parent, revision kind, and canonical content rather than the current turn id. Repeated Native
history therefore rebuilds the same prefix after restart or on a later turn, while canonical history
divergence naturally creates a new branch without consulting cached state or DOM edit heuristics.

Checkpoint persistence is deliberately narrower than logical persistence. ChatGPT Tela stores only
bounded, private derived checkpoint projections under a one-way task fingerprint; the complete active
lineage is rebuilt from the current Native request every time. Cached checkpoint ids bind the source
revision, projection content, and token estimate; corrupt/missing cache degrades to no cache, and a checkpoint whose
source revision is not on the rebuilt active path is ignored. Deleting the cache therefore restores
full-context transfer with the same logical head instead of changing correctness. An optional token
budget is transport policy only: if neither full history nor an active cached checkpoint fits, the
planner requests a checkpoint rather than silently dropping history.

Checkpoint production is a separate one-purpose semantic operation rather than an ordinary Web turn.
When an explicit producer is configured and a physical budget cannot fit the full active path, the
planner keeps the newest canonical revision exact and offers only the older canonical prefix through
a full source projection anchored to its exact source revision. The browser checkpoint runner owns no
`RuntimeTurnChannel`, and its request type has no MCP/tool-bridge capability. It accepts only a proven
dedicated checkpoint result bound to the same Native task, Web operation epoch, and source revision;
only then may the derived cache persist it. An ordinary assistant reply can therefore never populate
the checkpoint cache merely because it contains summary-like prose.

The development composition deliberately has no implicit ChatGPT checkpoint provider. A caller must
supply that provider separately from the ordinary conversation provider because the current ChatGPT
DOM adapter cannot yet prove that a summarization response used no ChatGPT-native tools. With no
explicit producer, budget overflow remains `checkpoint-required`. A produced checkpoint is attempted
once per canonical anchor; if it still does not fit, Tela fails closed instead of repeatedly asking
for shorter summaries or broadening authority.

Request metadata, cwd/sandbox claims, and tool schemas remain excluded; opaque Native reasoning is not
copied; attachments fail closed until they have their own browser upload/identity proof. Checkpoint
creation itself remains a separate producer boundary—ChatGPT Tela does not invent a lossy summary just
because a budget was exceeded.

### Causal turn runtime

After canonical Native binding succeeds, ChatGPT Tela gives the active turn one opaque process-local
capability. Human-readable thread/turn ids are identities, not bearer credentials, and one exact
Native turn may have only one active runtime owner.

Tool rounds are event-driven. A Web/MCP request can queue one exact advertised Native tool call; the
Native response side returns the matching result; and a tool-bearing turn cannot complete until the
Web provider proves post-tool continuation. Reused call ids, unknown tools, ambiguous ownership, and
completion without continuation fail closed. Submitted-but-ambiguous Web turns stay submitted for
recovery observation and are never converted into permission to resend.

The Native-result -> Web/MCP handoff has an explicit causal barrier. When a Native result arrives,
the runtime keeps the MCP call unresolved, emits an event-driven turn-state revision, and asks the Web
provider to capture the exact assistant state before that result is released. Only a proven arm opens
the barrier. The MCP result is then handed back to ChatGPT, and a semantic assistant-state change
after that baseline proves continuation. A subsequent exact MCP call also proves that ChatGPT resumed
from the prior result. This avoids inferring tool boundaries from generic thinking/status DOM and
closes the fast-renderer race between result delivery and observer registration.

The Native Responses transport is a separate projection over this state machine. Response and output
item ids are stable across a replay of the same delivery. In streaming mode, a tool call becomes
non-replayable as soon as the transport hands off the first frame exposing its exact call identity;
disconnects before that point can replay the same call id, while disconnects after it fail closed and
wait for the matching Native result. A final answer remains replayable until its completed response
snapshot is handed off. HTTP/SSE framing therefore cannot silently widen runtime execution authority.

The first local server is intentionally small: it binds loopback, requires an unguessable bearer
runtime capability, rejects browser-origin requests, bounds request bodies, and delegates `/responses`
directly to the transport/gateway stack. It does not maintain another copy of turn state and performs
no background health polling. The same lifecycle is exercised through a real loopback streamed tool
round in tests.

The development runtime is the first composition root. It owns one `ActiveTurnRegistry`, the local
Responses server, one development MCP connection, the browser host, and every Web turn launched from
that registry. The exact active-turn capability is injected only into the physical Web turn envelope;
it is not logical conversation state and becomes useless when that turn is retired. Startup is
transactional, shutdown is idempotent, and there is no parallel lifecycle/state machine in the CLI or
browser layer. The context/epoch planner remains an explicit dependency so composition does not
silently equate a Codex thread, task, revision, and ChatGPT conversation.

The desktop development composition is intentionally only a thin factory over that root. A stable
ChatGPT Tela profile id creates the Electron host/persistent partition, then the same development runtime owns
the Native endpoint, MCP transport, browser lifecycle, and Web turns. The desktop factory adds no
turn policy, no alternate authority, and no launcher-specific state machine.

Product profile UX follows a **single-profile-first / multi-profile-capable** rule. The common case is one
official ChatGPT Desktop account, represented internally by canonical slot 1 but not exposed as a choice in
ordinary setup/start/stop UX. Additional slots are created or selected only when a user explicitly opts into
multiple isolated accounts. The runtime core therefore supports N profiles from the beginning, while the
product surface progressively reveals profile controls only when N > 1 or the user invokes an advanced
profile command.

Multi-Profile is an adapter, not the product model. Tela Codex owns a neutral Native-target boundary; the
Multi-Profile adapter translates its public target/session contract into that boundary and contains all
slot-to-managed-target mapping. The built-in macOS default adapter owns the official-app/default-Codex
lifecycle without requiring the separate Multi-Profile project: Codex chooses its own ephemeral app-server
port, Tela places one route-preserving loopback WebSocket proxy in front of it, and only thread lifecycle
requests receive the Tela Responses provider overlay. Unrelated app-server JSON-RPC is forwarded unchanged,
the Responses credential remains environment-only, and model/Native tool names are not frozen into this
adapter. Windows/Linux share the same lifecycle contract: process identity is re-proven before shutdown,
Linux requests graceful `SIGTERM`, and Windows requests `CloseMainWindow()` on the exact executable/PID.
Packaged executable discovery is also fail-closed. Linux accepts the canonical package launcher only when it
resolves inside supported system package roots and resolves the bundled Codex runtime from the package
layout. Windows queries the current user's exact `OpenAI.Codex_2p2nqsd0c76g0` AppX registration, hashes the
package's bundled Codex executable, ignores `.staging-*`, and accepts exactly one relocated per-user runtime
with the same hash. Explicit executable overrides stay higher-authority. Real Windows/Linux product E2E
validation remains unfinished.

The product adapter is composite rather than mutually exclusive: slot 1 is always resolved by the built-in
default Desktop adapter, while an optional Multi-Profile adapter may contribute only slot 2+. This lets a
multi-account user keep the same ordinary default path as everyone else instead of switching the entire Tela
installation into a different runtime mode.

That isolation has a live macOS source proof: slot 1 was started and stopped through the built-in adapter while
an independently supervised Multi-Profile slot 2 remained `ready` with the same running target. Gateway/Codex
shutdown for the default slot did not close the Chat backend, and the later whole-product shutdown closed only
the remaining Tela Chat daemon. This is the intended failure/lifecycle boundary rather than merely a type-level
separation.

Product configuration is also independent from browser-profile ownership. The canonical version-1 config is
stored under the platform-native product `configRoot` as `product-v1.json` and is parsed by the standalone
`@chatgpt-tela/product-config` boundary. It contains only secret-free runtime selection/exposure metadata.
Source and packaged services read only this canonical product-native config. The retired Profile1-scoped
control-plane config is not a fallback, and malformed canonical state fails closed.

Development Electron runs also receive an explicit ChatGPT Tela-owned `userData` directory before Electron
readiness, so a generic `electron` binary cannot accidentally place ChatGPT Tela cookies/session data in the
shared default Electron profile. A canonical profile slot derives both the persistent Electron profile id
and its user-data directory (`Profile1-ChatGPT-Tela` + `Canary-Profile1`, `Profile2-ChatGPT-Tela` +
`Canary-Profile2`, ...); callers cannot pair one slot with another slot's browser directory. A setup-only Electron composition may open one visible control-plane
surface on the same persistent partition for account login, Developer Mode, and manual connector
preparation. It starts no Responses server, MCP listener/exposure, Native current-turn source, or Codex
route. That surface owns no Native turn/capability and is closed by the same profile-control lifecycle.
The development canary reuses exactly that profile-control contract rather than maintaining a second
setup/readiness implementation.
Profile setup intentionally uses one surface for both the initial readiness observation and any manual
repair. If readiness is not yet proven, that same surface is revealed rather than destroying a hidden
window and immediately creating another BrowserWindow on the same persistent Chromium partition.
After readiness, ChatGPT Tela reads only a page-local SHA-256 fingerprint derived from the current
ChatGPT user/account ids; the raw ids never leave the page. The fingerprint is bound to the profile slot,
and setup fails closed if another slot is already bound to the same account. Canary readiness verifies
the live session against that binding before any routed Native work begins.
The same composition can also run a non-consequential readiness probe on a temporary hidden surface:
one ChatGPT-owned composer plus its unique visible send control must be structurally proven. Every live
canary performs that proof and verifies the slot's account binding before either a stock smoke process is
started or a managed target is launched; failure therefore cannot strand Native Codex on an unusable
or wrong-account Web profile.

The first canary entrypoint is environment-only and refuses to guess a Codex home/profile. It requires
an explicit canonical Codex home and ChatGPT Tela profile slot (which derives browser identity/state),
loopback Responses/MCP ports, independent runtime/MCP bearer secrets, and a public HTTPS MCP URL.
Development secrets may be supplied either directly or through the corresponding `*_FILE` input. Secret
files must be bounded regular non-symlink files and, on POSIX hosts, must not grant group/world access;
the file path is the only value that needs to appear in launcher command/environment plumbing.
Startup proves the public endpoint by speaking
the actual unpublished MCP development contract through it before reporting readiness. Stock development
smoke tests never rewrite or temporarily replace `config.toml`: the canary returns process-local Codex
`--ignore-user-config` / `-c` overrides that bind only the one explicit smoke process to the loopback
Responses endpoint. The final Desktop integration instead uses the profile launcher's public `default`
target and launch-time Responses route so a running official ChatGPT app never hot-reads a temporary
development provider. ChatGPT
connector creation/rename remains outside the canary runtime. First-time login/Developer Mode/connector
preparation belongs only to the setup-only profile flow; the canary itself never reveals a repair surface.

The development connector identity remains unpublished, and each canary records the SHA-256 fingerprint
of the exact MCP `tools/list` name/description/input-schema contract it exposed. That development schema
is snapshot-tested, so changing it is an explicit canary/connector revalidation event rather than an
accidental in-place mutation. It remains separate from the frozen public `ChatGPT Tela` identity.
Canaries are development-only: they cannot select or serve the product's stable public ABI. This prevents
experiments from consuming the public connector namespace or accidentally presenting a second release
identity. Product connector validation belongs to Gateway and the product profile runtime. Connector
creation/connection remains an external manual setup boundary in pre-alpha: each isolated account must
connect the exact **ChatGPT Tela** App, while development canaries use **ChatGPT Tela Development**.

Tool-capable ChatGPT turns currently prefer one explicit **ChatGPT Tela** connector display identity. The
provider never guesses from catalog order or selects an arbitrary visible integration: it first attempts an
exact connector selection and proves the selected pill before attaching the physical prompt. Stable product
profiles may fall back to ChatGPT's own connected-app automatic routing only after exact catalog discovery is
proved unavailable and the dedicated Tela surface is reset to one fresh empty composer. Development/canary
profiles remain explicit. This fallback is also the migration seam for the long-term design where a stable
binding id is stored independently from a user-chosen display name; display-name freedom is not yet treated as
complete until that binding is empirically proven across supported surfaces.

Connector activation separates semantic targeting from physical input: page DOM code proves the exact
catalog row and returns only its viewport coordinates, the owned browser host emits one real primary-button
pointer click, and the provider then re-proves the exact connector pill. A synthetic DOM `.click()` is not
accepted as connector activation because it can reproduce visible markup without proving the product's
real app/tool activation path.

The current provider understands both historical `@mention` selection and the newer `+` integration picker.
Both paths are bounded and structural. If a catalog path changes or becomes ambiguous, Tela records only
privacy-safe counts/stages, clears or resets only its dedicated probe surface, and fails closed or defers to
automatic connected-app routing according to the configured product mode; it never clicks an arbitrary card.

Approval automation is a separate opt-in policy boundary. Default mode is `off`. The only automated mode is
`recognized_once`: one structurally recognized tool-approval card with one deny choice and one one-shot allow
choice may be activated. Persistent `Always allow`, unknown layouts, multiple cards, or ambiguous controls are
never auto-approved. Approval-card text, tool arguments, prompt content, or raw HTML are not exported from the
renderer for policy decisions or diagnostics.

An accepted provider turn identity is also distinct from ChatGPT's renderer-local `data-turn-key`.
ChatGPT may replace a provisional key when the server-hydrated turn arrives. Tela keeps its accepted
provider handle stable and may rebind only the renderer key when exactly one assistant parent lineage is
new relative to the pre-submit baseline; zero candidates remain pending and multiple candidates fail
closed as ambiguous. Displayed text or "last message" position is never used to guess across a rekey.

The sibling canary preflight is deliberately non-mutating and has a separate secret-free config loader;
it never requires the live Responses token, public MCP bearer, or Secure Tunnel runtime API key. It may briefly bind the configured loopback
ports to prove availability and may create one hidden profile surface for a non-submitting readiness
observation, but it starts no Responses/MCP listener, installs no Codex route, launches no managed target,
and acquires no external tunnel. Stock preflight proves that its route is process-local and leaves the live
Codex config byte-identical; managed-profile inspection consumes only `targets` and `target-session`.
If the selected profile slot has no verified account binding yet, preflight reports setup as blocked without
opening Electron or creating that slot's browser user-data directory.
The result is a structured `pass`/`warning`/`blocked` checklist rather than a partial canary lifecycle.

Canary Native selection now has two explicit modes. `stock` is the default and keeps the normal
single official ChatGPT Desktop / default Codex path independent of every multi-profile component.
`multi-profile` requires an explicit public control-CLI path plus target id and does not accept a
`CODEX_HOME` mutation lease. ChatGPT Tela starts its authenticated Responses endpoint first, then asks
the launcher to start that managed target with the loopback route. The launcher returns a ready public
session endpoint; a one-shot late-bound authority source switches immediately to the existing
app-server current-turn proof path. Until that bind occurs, any accidental Native request fails closed.

A managed target launched with ChatGPT Tela's Responses route must be quit normally before the canary
runtime can stop. Shutdown checks `target-session` and deliberately keeps Tela alive while the target
still owns the route; otherwise a running managed Codex process would be stranded on a dead model
endpoint. The canary signal handler reports that condition and can be retried after the user closes the
managed ChatGPT target.

### Tool inventory

The native tool registry is supplied by the current Codex runtime. ChatGPT Tela merges observed sources by
wire identity and exposes that catalog without maintaining a parallel list of expected tool names.

ChatGPT Tela may have a small fixed public MCP control ABI, but ordinary Codex tools and configured app/MCP
tools are discovered at runtime. Special transport semantics, when unavoidable, belong in narrow
capability adapters rather than in the catalog owner.

Deferred discovery follows the same rule. A Native `tool_search_output` is parsed as a new tool
observation only after the follow-up request is rebound to the same canonical current turn. The
active opaque capability stays the same while its request-scoped inventory projection is refreshed;
ChatGPT Tela does not carry a private remembered catalog forward as authority.

## ChatGPT provider

ChatGPT is treated as an unstable product surface, not an API contract.

Core code must not depend on selectors or visual layout. The provider converts browser observations
into semantic capabilities and surfaces:

```text
DOM/product state
      |
      v
observation adapter
      |
      v
semantic surface/capability
      |
      v
policy decision
      |
      v
action
      |
      v
proof of state transition
```

Consequential actions require `proven` evidence. `probable` evidence may support diagnostics but does
not authorize an action. Ambiguity fails closed.

Examples of proof:

- attachment: exact item observed, upload settled, composer can send;
- model/effort: selected state read back after the action;
- send: the submitted turn is accepted exactly once;
- approval: the intended request reaches a settled state;
- tool result: the result is bound to the same active native turn and continuation is observed.

Compatibility work should add sanitized structural fixtures and detector tests instead of accumulating
UI-version branches.

The first provider implementation follows that boundary directly. Browser surfaces expose an opaque,
product-specific capability only to the ChatGPT package; core/runtime never receives DOM selectors or
Playwright objects. The capability yields sanitized structural snapshots (composer ownership,
send-control relation, turn lineage/state, and content fingerprints) plus narrow actions. Submission
requires exact composer readback and exactly one matching new user turn. Tool-bearing completion
requires an explicitly armed MCP result boundary followed by an assistant-state change; it does not
need to guess a `tool-wait` state from ChatGPT's generic progress UI.

## Browser host and Codex launcher

Electron Chromium is the intended first browser host because it gives ChatGPT Tela a packaged, cross-platform,
owned browser session and a visible login/recovery surface. Electron remains an implementation detail:
core code talks only to the browser-host contract.

The browser host owns leases, not ChatGPT semantics. A generic controlled host enforces one live
surface per task/epoch and delegates product-specific automation through typed surface capabilities.
This keeps a future Electron/Playwright controller replaceable without teaching the runtime about DOM
details or creating a second ownership model.

The first concrete browser seam is a product-neutral page-automation capability: execute trusted ChatGPT Tela
page functions and await the next DOM mutation. The ChatGPT package layers its current-surface DOM
strategy on top of that seam. It recognizes only the current ChatGPT-owned composer form, performs
narrow composer/send actions, hashes composer/user text before returning semantic snapshots, and
waits on mutation events rather than polling. Supporting a changed ChatGPT surface means adding or
replacing a provider strategy, not teaching core/runtime about new selectors.

The Electron host implements that seam with `WebContents.executeJavaScript` and a renderer-local,
monotonic DOM mutation clock backed by one `MutationObserver`. The revision check and waiter
registration happen in one renderer task, preventing the lost-wakeup race that a simple
"observe, then attach an observer" loop would have. Abort removes the one pending renderer waiter;
there is no timer or background polling loop.

Each stable ChatGPT Tela profile id maps to one hashed `persist:` Electron partition. Task/epoch surfaces are
fresh BrowserWindows sharing only that profile partition, so login/cookies persist while per-turn
window ownership remains disposable. Remote pages run sandboxed with Node integration disabled and
context isolation enabled. The default main-process helper waits for Electron readiness, while tests
inject a structural runtime instead of booting a desktop process.

The Codex launcher is a **Tela Codex dependency**, not a dependency of Tela Chat or Tela Gateway. It may own
Codex-target login UI, setup, status, browser reveal, diagnostics, and updates, but it does not decide Native
authority, context lineage, tool policy, conversation continuity, or public Gateway routing.

Idle must be genuinely idle. Persistent ownership does not justify DOM polling, renderer wakeups, or
periodic health work when there is no active turn.

## MCP ABI and exposure

One connector identity represents one immutable public MCP schema generation. A breaking public schema
change gets a new identity; it is not silently refreshed in place.

The internal development MCP turn bridge still has no public connector identity. It remains available for
canary work without consuming the public connector namespace.

The first protocol surface uses the official MCP SDK but stays explicitly development-only. It
publishes two temporary control tools: one to inspect the exact active turn inventory and one to relay
an exact structured/freeform Native invocation. Both require the opaque active-turn capability, so
readable thread/turn ids never become bearer credentials. This development schema is not the public **ChatGPT Tela** connector and may continue to change independently.

`ChatGPT Tela` is the immutable public MCP identity with server name `chatgpt-tela`. It exposes four fixed
controls: `chatgpt_tela_chat_capability_inventory`, `chatgpt_tela_chat_capability_call`,
`chatgpt_tela_codex_tool_inventory`, and `chatgpt_tela_codex_tool_call`. The frozen `tools/list`
name/description/input-schema fingerprint is
`a353771847d4de9d87264758e5350eb33bea98540748a033c0744884d69916f9`. Any incompatible schema change
requires an explicit internal ABI generation migration while keeping the user-facing connector name stable.
The public schema preserves two ownership rules:

- Tela Chat capabilities are Tela-owned product APIs and may be explicitly versioned/frozen.
- Tela Codex capabilities originating in Native Codex or configured external MCP/App servers remain dynamic
  observations of the exact current Native turn, never a hardcoded Tela catalog.

Gateway initialization and `tools/list` must not depend on both backends being healthy. A call targeting an
unavailable backend returns a bounded backend-unavailable result without disabling the other backend or
terminating Gateway. Backend timeouts, circuit state, connections, and diagnostics remain isolated.

The intended unified product exposure is one user-created ChatGPT Plugin connection terminating at Tela Gateway.
Tailscale Funnel is the current managed public-HTTPS provider:

```text
ChatGPT / Work / Codex
   |
   v
ChatGPT Tela Plugin
   |
   v
Tailscale Funnel
   |
   v
Tela Gateway
   |-- private local protocol --> Tela Chat
   +-- private local protocol --> Tela Codex
```

The standard setup is created directly in ChatGPT's Plugin connection dialog, so Tela ships no imported
`mcp.json`/`.mcp.json` package for that path. ChatGPT owns endpoint/authentication availability while Gateway
owns only Tela routing. One Plugin ingress does not merge backend failure domains: Chat and Codex descriptors
are resolved per call, and an unavailable backend returns an error without disabling the peer service.

The current local machine already demonstrates one Funnel host routing independent DevSpace and Tela
listeners. The final product exposes only Gateway; backend services become loopback/local-IPC only.

`OpenAI Secure MCP Tunnel` remains a tested Codex-era exposure adapter rather than the target unified product
ingress. The adapter attaches an existing tunnel id through the official `tunnel-client runtimes connect`
lifecycle, then
requires structured `runtimes status --json` evidence that the managed process is running, healthy,
ready, and not reporting failed control-plane polling. The runtime API key is supplied only through a
child environment variable referenced as `env:...`; it is never placed on argv or in ChatGPT Tela
state. Shutdown calls `runtimes stop` and leaves the remote tunnel object intact.

The tunnel-client-managed local MCP hop is loopback-only and intentionally uses no second HTTP bearer:
OpenAI Tunnel owns remote ingress authentication, while every consequential ChatGPT Tela tool call
still requires the opaque exact-turn capability. This avoids a duplicated credential lifecycle while
preserving both network and causal authorization boundaries.

Tailscale Serve alone is not a public ChatGPT endpoint; Funnel is the product public ingress. Gateway owns
only its exact configured route lease, not the Tailnet, Tailscale installation, device login, hostname, or
unrelated routes. Install/uninstall must preserve any route whose current ownership no longer matches Tela.

Public ingress health is intentionally separate from private Gateway health. The private Gateway may remain
ready while the ChatGPT connector is unreachable. For managed Funnel, support/status checks diagnose the chain
in causal order: Tailscale CLI/local backend and login/online state, exact Funnel lease mapping, the local
Gateway MCP listener, then the public MCP endpoint. A stopped/unreachable Tailscale backend is therefore
reported explicitly rather than collapsing into a generic `UNAVAILABLE` result. The Gateway daemon registers
its private descriptor before public exposure succeeds and retries public exposure in the background, so a
temporarily stopped Tailscale app does not remove the diagnostic/control plane and can recover after Tailscale
returns without treating Chat/Codex backend processes as failed.

For HTTPS-based exposure, ChatGPT Tela now has a loopback Streamable HTTP MCP server with bounded stateful MCP
sessions. Each remote MCP session owns one SDK transport/server pair but shares the single
`ActiveTurnRegistry`, so HTTP session state never becomes tool or filesystem authority. The local
listener uses a generated bearer token by default, rejects browser-origin requests, and has bounded
request/session resources. An explicit `none` mode exists only for an exposure layer that terminates
authentication itself.

The existing Codex development runtime accepts either a direct MCP transport or an HTTP-exposure configuration. The
latter starts the local MCP listener, asks a replaceable exposure provider for either a verified HTTPS
endpoint or an OpenAI Secure Tunnel target, verifies that target, and only then marks the runtime
ready. Public unauthenticated HTTPS endpoints fail closed by default. An already-managed
DevSpace/Tailscale Funnel therefore remains useful for v1/canary proof, but the final product moves all
public exposure ownership into Tela Gateway.

## Installation, upgrade, repair, and removal

Product lifecycle is an ownership protocol. See [product-lifecycle.md](product-lifecycle.md) for the full
rules. Install and uninstall are symmetric `inspect -> plan -> apply -> verify` operations backed by a
versioned install ownership manifest.

User repositories/workspaces are never Tela-owned. Managed worktrees are removable only when ownership and
safety are proven. Browser profiles, service data, logs, and caches live under explicit product roots and can
be removed by the supported uninstaller or preserved by user choice. Tailscale cleanup removes only the
exact route fragment still owned by Tela rather than resetting unrelated Serve/Funnel configuration.

Gateway, Chat, and Codex service registrations are independent manifest resources. Failure to stop/remove one
backend is reported independently and does not prevent safe cleanup of the other backend. Binaries/helpers
are removed last, after owned services/integrations are detached and verified.

## Setup

Setup follows one lifecycle shared by CLI and launcher:

```text
inspect -> plan -> apply -> verify
```

Inspection has no side effects. Planning returns a reviewable action list. Apply executes only that
plan. Verify proves the resulting runtime state. There is no second launcher-only setup state machine.

Migration code does not live in the runtime core. If a future public release needs a migration, prefer
an explicit bounded migration tool over teaching current runtime code every retired state shape.

## Platforms

macOS, Windows, and Linux are default targets. Core semantics are platform-independent. Filesystem,
IPC, process, browser packaging, and service differences belong behind explicit platform boundaries.

CI begins with all three operating systems. Real-device-only behavior remains explicitly unverified
until exercised on that device class. Each CI OS also builds the real multi-file package payload with an
ephemeral Ed25519 key, verifies the signed tree/manifest, and executes the compiled stable launcher boundary;
this catches platform-specific standalone compilation and Electron staging regressions in addition to tests.

## Diagnostics and performance

Normal operation records small structured state. Cross-service diagnostics use one bounded JSON event format
for service supervision, ingress ownership, Gateway routing, Chat capability calls, Codex profile/tool calls,
profile startup, connector selection, readiness, and approval-policy decisions. The diagnostic writer rejects
field names commonly carrying prompts, paths/URLs, commands/output, request arguments/content, credentials,
cookies, session/turn capabilities, workspace ids, account ids, or user ids. Optional local JSONL sinks are
private files with bounded rotation. Diagnostics are best-effort: failure to write them can never replace the
real operation result.

Deeper failure evidence must follow the same privacy boundary. Stable structural counts, fixed enums,
durations, and bounded pseudonymous fingerprints are preferred over payload logging. Raw prompt/card text,
filesystem contents, tool arguments/results, credentials, and browser-profile identifiers are not diagnostic
material.

Public Gateway Chat/Codex routes resolve the current private backend descriptor only when each call arrives.
Those dynamic routes emit the same payload-free `backend_call_*` lifecycle diagnostics as the private Gateway
router, so successful public tool traffic is observable without persisting capabilities, arguments, or results.

The CLI `diagnostics` summary is an even narrower support boundary: it reads only file metadata for the known
Tela service/diagnostic files and exposes presence/size/rotation state without opening the files or returning
their paths. Raw diagnostic JSONL remains local and is inspected only by an explicit user/support workflow.

Long-running components prefer events, demand-start, single-flight work, and coalescing over polling.
CPU, wakeups, I/O, and battery cost are correctness-adjacent design constraints for the desktop
runtime.

### Native and explicit Web model routing

The built-in default Desktop target owns the app-server proxy, so it can preserve Codex's live Native
`model/list` rows exactly and append current ChatGPT browser families as explicit `(Web)` choices. The Web
identity uses an opaque stable key derived from normalized observed family semantics rather than a GPT-version
allowlist. The authenticated hidden browser is the authority for which families and effort positions are
currently selectable.

One Codex provider owns both routes because current Codex threads can change model without changing
`model_provider`. First-party ChatGPT authorization therefore remains on the provider request while Tela's
loopback authorization travels in a separate environment-backed header. Native model ids are forwarded to
the first-party Codex backend; only the `chatgpt-tela-web/family/*` namespace enters the ChatGPT Web bridge.
When a mixed thread returns to Native, only visibly Tela-owned response/item ids are removed before forwarding;
opaque first-party ids and semantic history are never guessed or rewritten.

For a Web model, family and effort are independent browser controls. Tela selects them on the owned surface
immediately before the submit boundary and accepts the selection only after exact semantic readback. The
current Power picker may require a bounded non-submit convergence because an offscreen synthetic tick event
can move the effort while temporarily changing the selected family; Tela re-proves both controls together and
fails closed if they do not converge. `cli model-canary --slot 1` exercises this selection/readback/restoration
path on a disposable surface without sending a ChatGPT message. The default Profile 1 path is live-proven;
Profile 2+ still requires the equivalent app-server catalog projection at the Plura-owned target boundary.

## Vertical slices

The proven Tela Codex slice is:

```text
current native turn
  -> canonical authority
  -> logical context plan
  -> ChatGPT semantic provider
  -> one MCP tool discovery/invocation
  -> native tool result
  -> same-turn continuation
  -> final response
  -> clean completion
```

The first Tela Chat slice is now implemented and intentionally smaller than the legacy DevSpace implementation:

```text
ChatGPT unified gateway
  -> Tela Chat private backend
  -> open one locally approved user-owned workspace
  -> bounded read/read-many
  -> apply one patch
  -> start one resumable process operation
  -> retrieve process status/output
  -> show reviewable changes
  -> clean completion
```

Workspace roots must be approved locally before the model can open them. An opened workspace records the
canonical directory identity but never transfers filesystem ownership to Tela. Reads are bounded and binary
content fails closed. Patch actions are fully planned before mutation, reject lexical/symlink escapes, and use
rollback-aware replacement. Process operations reserve an explicit operation id before spawn so response-loss
retry cannot duplicate execution; the durable registry intentionally stores no command, output, environment,
or filesystem path payload. A restart reports unresolved prior operations as `unknown` with no recovered I/O
rather than attaching to an unproven PID.

`show_changes` is Git-backed, disables external diff/textconv execution, and returns tracked diff plus
untracked paths for only the selected workspace. It also writes a bounded self-contained historical review
artifact under Tela Chat state. `show_review` reads only that retained artifact, so later working-tree edits
or a service restart cannot silently change what an old review reference means.

Review checkpoints intentionally do **not** create permanent refs or deliberate review objects in the user's
Git object database. A checkpoint stores the tracked binary-capable diff plus bounded snapshots of untracked
regular files and symlink targets. Intermediate symlink escapes are re-proven against the workspace root
before content capture. Artifacts are private product state (`0600` files under a product-owned `0700`
directory), capped at 2 MiB per untracked file / 8 MiB aggregate / 10 MiB serialized, 50 untracked files,
16 reviews per workspace, 64 total, and 30 days. Oversized/ambiguous capture fails the checkpoint only; the
current live review remains available.

Managed worktrees are a separate ownership mode from user workspaces. Creation requires an already-opened
user-owned workspace whose approved root is the exact Git repository root. The worktree target is allocated
under Tela Chat's product state root; before Git mutates the filesystem, Tela records a provisioning record
and install-manifest intent. After `git worktree add`, Tela writes an ownership marker into that worktree's
Git administrative directory and registers the worktree as a managed workspace. Startup reconciliation can
finish an interrupted manifest registration without guessing ownership.

Managed-worktree deletion is not equivalent to `git worktree remove --force` on an arbitrary path. Tela
re-proves all of these conditions immediately before removal:

- the recorded path is still a real directory inside the Tela-managed worktree root;
- the source repository still exists and has the same canonical Git-common-directory identity;
- Git still registers the exact worktree path against that source repository;
- the Git-admin ownership marker and install manifest both match the same install/worktree/resource identity;
- the worktree has no tracked or non-ignored untracked changes; and
- detached `HEAD` is still the exact base commit used when Tela created the worktree.

Failure of any condition preserves the worktree. In particular, a clean detached commit is treated as
user-significant state rather than disposable cleanliness. Symlink replacement, source-repository loss, or
ownership-marker drift also fail closed.

Tela Chat failure diagnostics are failure-triggered rather than continuous payload logging. When a
workspace-scoped capability throws, the Chat runtime best-effort persists only a random incident reference,
timestamp, Tela-owned capability name, fixed `failed`/`aborted` category, and a 24-hex SHA-256 fingerprint of
the opaque workspace id. Raw workspace ids, filesystem paths, commands, patches, prompts, output, and error
messages are deliberately absent. Model-visible incident lookup requires the original workspace id and
returns no fingerprint. Storage is private product state, limited to 32 records per workspace / 128 total / 30
days, and diagnostics failure can never replace or mask the primary operation result.

The Chat subagent core is deliberately provider-neutral. An injected `ChatAgentDriver` receives one
authorized workspace id/root, a bounded prompt, an explicit write mode, an optional previously proven provider
session id, and an abort signal. The manager owns durable agent/turn state and workspace scoping; the driver
owns provider translation and must honor the requested write mode. Prompts are never written to the core
agent store. Final responses and opaque provider continuation ids are private bounded product state because
they are required for inspection and later continuation.

The first concrete driver uses OpenAI Responses plus Conversations without creating a Chat -> Codex runtime
dependency. A new agent creates one durable provider Conversation and persists only its opaque id as the
provider continuation identity; later Tela turns reuse that same id. The API key is availability-gated through
an environment-variable reference in private Chat config and its value is never serialized into product state.

Provider workspace access is not raw filesystem access. The driver receives an adapter over Tela's existing
workspace-scoped tools. `read_only` exposes bounded `read`, `read_many`, and Git-backed `show_changes`;
`workspace_write` adds transactional `apply_patch`. It does not receive `exec_command` yet: fixing cwd does
not constrain shell filesystem writes, so that would widen workspace-write authority without a separately
proven sandbox. Function-call payloads and provider HTTP responses are bounded and unknown tool names fail
closed.

In-flight agent turns are not process-recovery authority. On Chat restart, persisted `running` agent/turn
records become `unknown`; Tela does not reconnect to a provider merely because an opaque session id exists.
Continuation is rejected from that state. Live stop is event-driven through one `AbortSignal`, and shutdown
has a bounded wait before any still-unsettled turn is marked `unknown`. The private agent capability family is
mounted only when at least one driver is actually available; an enabled OpenAI provider with a missing API-key
environment value leaves Chat healthy but advertises no agent lifecycle capabilities.

Parity then grows from behavioral requirements rather than copied source: richer review summaries/baselines,
additional provider adapters, sandboxed process authority for agents, and explicit artifacts. The existing DevSpace local patches remain a reference
oracle until the new service proves those behaviors.
