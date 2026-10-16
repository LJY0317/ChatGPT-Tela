# Architecture

## Tela Chat-first dogfooding and work-runtime parity (2026-10-16)

For ordinary Tela repository development, use Tela Chat from the outset instead of requiring a failed Native-tool attempt; DevSpace is an independently authorized technical fallback. Exact-turn Native tools remain required for Native-authority tasks, and reliable Web-model Native-tool execution remains a long-term product goal. This changes local operator workflow, not the consumer Work/Codex default or backend authority. Platform safety/permission refusals are not retried through another model, service or command shape. Separate a refusal from a technical tool failure and a post-acceptance observation failure.

The target is measured Chat work quality at least comparable to Work/Codex, not equality of tool names. See [the semantic capability and parity contract](chat-work-capability-parity.md): durable logical work record, independently proven physical session/workspace/turn bindings, runtime-discovered semantic capability descriptors with effect/authority/proof/replay semantics, bounded typed result artifacts, event-driven orchestration and matched outcome/resource benchmarks. This is an unimplemented design/acceptance roadmap unless subsequent source/test/installed evidence proves a specific gate. Keep Tela Chat and Tela Codex peer failure/authority domains and the frozen public Gateway schema.

Model calls and repeated context transfer are explicit resource costs. All execution, context,
delegation and monitoring changes follow the [token-efficiency contract](token-efficiency.md):
reuse proven state first, perform mechanical checks locally, and guard model-call budgets with
regressions while preserving context fidelity and authority.

ChatGPT Tela is designed around two premises:

1. Chat/workspace execution and Codex/Web execution are separate services and must remain separate failure
   domains even though the user connects one ChatGPT Tela Plugin to one public MCP endpoint.
2. Inside Tela Codex, a web application is an unversioned external dependency while the Native Codex task is
   the durable source of task authority.

The product therefore separates public ingress from both execution services, and separately keeps Codex
correctness independent from web representation, browser lifecycle, MCP transport, and launcher UI.

## Agreed implementation priorities

This plan adopts the revised startup recommendation: complete Work/Codex first-use readiness before
expanding into the separate Web retention and Tela Chat recovery projects. It specifies acceptance goals;
it does not assert that the installed product or all platforms already meet them. Release evidence must distinguish candidate
verification from installed-product acceptance.

### 1. Complete Work/Codex startup and first Web use

An explicit Tela Work/Codex launch starts independent Native and Web preparation together. Return the
window and Native capability without waiting for Web. Do not defer Web preparation until the first model
selection, start it before the user's launch request, or retain an empty task page to hide first-use cost.
Ordinary Native launch without Tela Web connection intent remains outside this preparation path.

One isolated preparation session owns account/binding verification, observed model discovery and menu
restoration, exact connector proof, cleanup, fresh readiness and final account/document consistency.
Sequence mutations of the same page; overlap only independent Native work. Preparation grants no Native
task execution authority. Release its page on success, failure and cancellation; bounded owned recovery
may require a fresh session. Web failure preserves Native; retry is explicit and does not replay uncertain
submission or silently select a different model.

#### Work connection UX: calm, concise, and easy to recover

Use Tailscale-like **restraint and directness** as a UX quality reference, not
as a copied interface or dependency. The normal Work view should offer a
single plain-language state (`Connected`, `Connecting…`, `Sign in`, or
`Connection needs attention`) and one useful next action where needed.
Avoid duplicate controls, technical proof/timeout labels, repeated dialogs,
and multiple setup steps. Keep detailed errors, logs, per-model diagnostics,
extra-profile controls and developer settings under intentional disclosure.
Make success unobtrusive; do not turn routine transient recovery into a
notification or another permanent configuration setting.

**Fix recoverable failure at the boundary, not with more instructions.**
For the observed case where a ChatGPT composer exists but the model-picker
control is not yet observable, an account/login error is not proven.
Readiness may be re-observed once in the **same owned Web preparation**
after a bounded UI stabilization opportunity; never accept composer
visibility or model-catalog API rows as picker proof. Never continually
poll, blindly lengthen timeouts, reload a live draft, restart Native, switch
accounts, or replay an uncertain model submission. A fresh disposable
preparation session is allowed only if the prior one is provably released
and no active/draft work can be disturbed. If the bounded safe attempt still
fails, keep Native available. Proven signed-out sessions expose `login-required` in the
authenticated profile contract, `login_required` in bounded structural diagnostics, and a
`Sign in to Web…` action. Other failures show a contextual `Reconnect Web`
action. Log the precise non-sensitive failure class and proven profile
scope; a nearby Native model-list timeout is separate evidence, not an
assumed cause.

**Browser access is not login setup.** Keep a discoverable
`Manage account / Open browser` entry available even when connected.
For running Work, reveal the exact existing owner-bound Web browser for
viewing or deliberate interaction; do not start a second login browser or
silently disconnect Native. The separate setup process may still require
Native control to be stopped. If an active Web turn, draft, or uncertain
submission makes account mutation unsafe, permit non-destructive viewing
and explain the minimum necessary action before enabling changes. An
explicit sign-out/account switch must invalidate old Web model/connector,
account and physical-context authority before new Web preparation.
When a verified owner-bound account-management browser intentionally
suspends Web admission, show `Finish account management` instead of an
indefinitely busy `Connecting` label. User-close or authenticated owner-close
must independently re-prove Web readiness without stopping Native.
Never touch Plura's or the original app's separately owned sessions.

Installed acceptance must demonstrate: one-step normal connect, bounded
safe recovery without repeated user intervention, honest one-action
failure state, an accessible existing-browser/account entry while
connected, and safe sign-out/return without task or account drift.
Verify the default profile first, then isolated extra profiles; source
tests and a working `Reconnect Web` button do not prove these end-to-end.

**Saved-chat acceptance versus normal Temporary Chat.** Ordinary Tela-mediated
Web Work/Codex retains the Temporary Chat default in both consumer builds and
normal use. A bounded, clearly identified *new* saved conversation may be used
for owner-authorized real-profile acceptance testing where account-side history
provides a useful observable receipt. The test must preserve the original
Native turn authority and the exact profile/account binding. Cleanup can use
ChatGPT's official per-conversation **Delete** UI in the existing profile-bound
Electron account browser, followed by an absence check in that same profile;
it need not wait for a new automatic-delete API. The existing account-browser
control opens a separate visible page within the same persistent Electron
partition, and it temporarily suspends Web execution while account state is
revalidated on close. Use it after, not during, a Web task. A deletion failure
or ambiguous target must be reported rather than guessed or blindly retried.
Local Desktop catalog reconciliation is not server-side chat deletion, and
removal from the visible list is not proof of immediate server erasure.

Acceptance separates window appearance, Native availability, actual picker visibility, Web request
admission and first useful Web execution. Catalog API rows or a ready badge alone do not prove picker or
submission success. Verify first tool use through the normal mounted service/public connector boundary.
Preserve existing model-switch, canonical compaction, tools and permission guarantees; repeat only tests
whose ownership boundaries changed. First-time login/consent and ordinary cold/warm startup are distinct.

Compare matched source-bound candidates and successful workloads, with controlled order and cold/warm
conditions. Measure startup and subsequent idle together: CPU time, wakeups, memory, I/O and energy where
available, including related browser processes. Stop measurement after the experiment. Failed baselines,
sampled CPU lower bounds and human reaction time cannot establish battery savings or first paint.
Reject speed improvements that increase CPU/battery cost; no prewarming, additional residency, periodic
readiness polling or disabled background throttling. Hidden windows and snapshots are not energy proof.

#### Inspecting concurrent Work Web sessions

The control center lists currently owned Web surfaces on demand, using a disposable lease selection
and the current browser title (or a numbered session label). A title is a viewing aid, not Native task
identity or evidence that work completed. Multiple surfaces require explicit selection; a released lease
never resolves to another surface or a replacement generation. Snapshots are read-only and captured only
on user request or explicit selection. There is no screenshot timer or idle inventory poller.

An explicit **Open browser** action reveals that same existing page; it does not create a second session,
change the execution model, or bypass Native tool permissions. This view permits browser interaction.
Closing its window hides the view; Native-owned retirement remains the only page-destruction authority.
Showing a browser can increase visible rendering cost, so it is optional and carries no energy-saving claim.
Titles and images remain local, excluded from routine diagnostics and release artifacts.

Web admission describes proven profile/account/connector/model readiness. A single request's timeout,
cancellation or reset is not proof that the entire profile lost that readiness. Do not automatically replay
uncertain submissions. An explicitly closed owned ingress or a proven unavailable model may invalidate admission.
Native-first Web dispatch calls the same authenticated Responses ingress in process, retaining origin,
capability, decoding, model and exact-current-turn checks. It does not open a second HTTP connection
whose response-header deadline would become a task deadline. Public HTTP stays at the external boundary.
Transport observation must distinguish per-request failure from profile-wide readiness loss.
Approval activation is not a receipt: a still-visible card remains unresolved. Withheld duplicate decisions
carry disposable card/proof fingerprints, and expiring private capture may record the blocked surface;
never approve it again merely because presentation changed.

#### Work response integrity and observation plan

Prioritize these evidenced usability/correctness blockers before claiming replacement readiness:

1. Bind every observation, tool-result handoff and final delivery to the submitted user content and
   logical conversation route, in addition to the physical lease/generation. SPA navigation is not a
   renderer hydration proof. Rekeying requires one matching user and one unambiguous assistant lineage;
   identity loss fails the request without replay, foreign-answer delivery or history edits.
2. Prepare recognized one-shot approval targets with exact card proof, viewport positioning and hit
   testing before trusted input. Track dispatch separately from receipt: pending approval, click sent,
   card still present and resumed tool execution are different observations. Never repeat an uncertain
   click or treat a security warning as approval. Surface unresolved manual action in the session UI.
3. Carry only browser-public progress titles/descriptions through an owned incremental response channel.
   Preserve Native response commit/cancellation semantics; progress cannot commit a final answer or grant
   tool authority. Do not collect hidden reasoning or add a separate polling loop.
4. Serialize the proven assistant body as Markdown, preserving semantic styles, lists, links, tables and
   code. Exclude controls/hidden UI and executable link destinations. Native renders its own presentation;
   user identity fingerprints remain plain text and independent from answer formatting.
5. Make observation the default browser UX, with explicit interaction for login/manual approval. Keep
   scrolling, text selection and copy useful; retain response-identity enforcement even in interaction mode.
   Changes to viewer input must not disable trusted automation or require continuous capture.
6. Explain routing/authentication fields and actual command purpose/targets/effects accurately in tool
   presentation. Preserve Native permissions and approval checks; no obfuscation, misleading low-risk
   claims or promise of platform approval. Review versioned public MCP ABI before changing descriptions.
7. Correlate tool call/result, approval receipt, continuation and finalization by exact owned identifiers.
   Distinguish explicit tool failure from transport failure and model interpretation. Add missing structural
   evidence only where an incident lacks it; private payload capture remains explicit, expiring and bounded.

Candidate acceptance must include foreign-conversation navigation at tool handoff and buffered final
delivery, legitimate renderer hydration, concurrent-session isolation, approval occlusion/unreceived input,
formatted answers and visible progress. Installed acceptance is separate. Image input remains outside this
repair scope. These goals introduce no prewarming, idle sampler or automatic uncertain-request replay.

### 2. Unify Web page and context lifetime before changing retention

This is a separate correctness project, not a prerequisite for preparation-only optimization. One owned
transition must bind task/Native lineage, account/model/effort, physical page generation, committed anchor,
lease/busy state and submission certainty. Delta is valid only on the proven surviving generation.
Destruction, replacement or failure invalidates its anchor; a fresh page reconstructs from canonical Native
history or a verified checkpoint. Uncertain submission must not be automatically resent.

Before changing task-page reuse or eviction, test failure/reacquisition, compaction, model changes,
cancellation and lost responses. Then apply bounded retention and restoration together: no stale delta on
a fresh page, no busy-page eviction, no unbounded completed pages. Choose retention from measured total
work-plus-idle cost, rather than assuming zero retained pages is always best.

### 3. Complete Tela Chat execution recovery independently

Use DevSpace as a behavioral acceptance reference, not an imported runtime dependency. Complete request
identity/argument consistency, durable operation and process-start identity, restart reconciliation,
result recovery, cancellation versus wait cancellation, owned process-tree termination, and bounded
completed sessions/output. Preserve unresolved provenance until nonexecution/termination is proved or
explicitly resolved; capacity exhaustion rejects before spawning. File writes must retain permission,
conflict and partial-write guarantees. Keep DevSpace available until replacement acceptance passes.

### 4. Complete product lifecycle and reduce integration debt

**Required: reconcile Native backend ownership across parent loss.** Normal shutdown alone does not
cover a crashed or replaced owner. Retain bounded durable process-start and Native-home ownership proof
until the exact backend has exited; reconcile it before admitting a replacement for the same home.
Use the official managed lifecycle and preserve active work. If ownership or termination is uncertain,
stop with an actionable checkpoint rather than spawn another owner, clear a lock or send arbitrary signals.
Acceptance must include parent disappearance, interrupted upgrade, PID reuse, concurrent starts and
remote enrollment exclusivity. Remote registration and chat writer ownership are separate checks.
Service-to-profile supervision requests normal teardown on lease loss. The built-in Desktop now
records backend admission in an install-owned SQLite ledger keyed by canonical Native home. A live
owner/backend or uncertain spawn blocks another start; an exact child-exit receipt releases authority.
After owner loss, only proven absence permits reclamation. Transactions serialize admission without
heartbeats or age-based lock stealing. Historical backends predating this ledger are not silently
adopted, and optional providers retain their independent lifecycle authority. A complete recovery UX
for a surviving backend remains a separate follow-up; passive Remote diagnostics alone are insufficient.

**Planned: automatic menu-bar replacement during maintenance.** The independently owned updater must
request normal termination from the exact old menu-bar instance, wait for its exit and singleton-lock
release, then launch and verify the menu bar from the newly verified installed payload. Include this
surface in upgrade, repair and source-restoration checkpoints without turning it into a backend service.
Preserve active work, connection choices and accounts; an uncertain quit or ownership change must leave
a resumable checkpoint. Acceptance must cover an open Control Center, interrupted replacement/rollback,
and restored UI/version freshness with no manual Quit/Open step, forced signal, stale process or duplicate
menu icon. Use on-demand lifecycle events, not an idle polling daemon. This remains unimplemented.

Verify installation, login, interrupted update/recovery and removal for Tela alone, Plura alone and their
optional versioned integration. Preserve original apps, default config, Native history and other-product
ownership. Prefer stable public API and discovered capabilities; retain only necessary versioned patches
and remove them after equivalent official behavior is proved. Do not copy competitor defaults or declare
cross-product speed/energy superiority without matching version and execution evidence.

Consumer trust, signing/notarization and OS-specific installation/removal acceptance are separate gates.
Finish macOS acceptance first while preserving Windows/Linux boundaries and marking their unverified
behavior. Replace obsolete implementations after verified transition, rather than accumulating permanent
fallbacks. Expand into another UI/browser engine only when an evidenced bottleneck or contract gap requires
it; optional UI polish and new providers are outside these major completion criteria.

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

The Codex service uses its existing authenticated supervision socket for bounded readiness and lifetime.
Standard output is diagnostic output, not readiness authority. On macOS, the exact receipt-selected Electron
bundle launches through LaunchServices (`open -W -n -a`). Its authenticated runtime PID is validated against
that executable separately from the OS launch waiter. Normal stop closes the lease and waits for app exit;
parent loss closes the same socket and initiates normal teardown. CLI fixtures and other operating systems
retain direct execution and exact child-PID binding. This source boundary adds no idle polling or prewarming;
signed and installed acceptance remains required.

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

The following describes the retained-context design. The unified physical-generation/anchor ownership
contract above remains an acceptance target. The source runtime now binds a committed prefix to the
successful surface lease and document generation, rejects retained-delta on a fresh/mismatched or lost
document before submission, and invalidates the planner anchor when a turn fails. Electron supplies
an event-driven lifetime/abort boundary for main-frame reload, load failure, renderer loss and destruction;
subframes and same-document SPA history do not count as document replacement. Turn cancellation is
rechecked before submit and before committing a response. Unknown document lifetime cannot commit a
reusable prefix. Source tests and an isolated local Electron proof cover this boundary; installed
ChatGPT acceptance remains pending. The semantic adapter additionally checks the exact committed
assistant key, parent lineage and answer content before retained compose/send and during continuation;
URL and current-page activity labels are not conversation authority. Coordinated retirement invalidates
only the matching planner surface anchor before close. A source-only optional idle limit retires the least
recently completed idle pages, excluding/rechecking busy or acquiring pages; commit precedes idle publication.
Runtime requires retirement-capable planning before admitting that policy. Tests cover loss of semantic
prefix and Native reconstruction after capacity retirement. No default limit is enabled until real
mounted Web acceptance and equivalent work-plus-idle cost measurements choose the product policy.
Document generation alone is not conversation identity or authorization for eviction.

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

Large **fresh** physical contexts may use a receipt-verified memory-backed text attachment instead of
placing the whole projection in one composer message. This is representation-only: Native history,
`logicalTokens`, revision identity and compaction authority do not change. Tela builds one deterministic
`tela-context-v1--<digest>.txt` payload entirely in memory, submits an inert tool-free preload with no
connector selected, and authorizes the real Work execution message only after ChatGPT returns the exact
random receipt stored solely at the end of that file. The receipt proves that the uploaded bytes were
accessed with the expected identity; it is deliberately not treated as proof that every byte was
semantically understood. The execution message re-presents the exact active Native request while referring
to the acknowledged context attachment. Retained-delta continuations remain inline because their prior
physical context is already resident in the retained Web conversation.

Attachment recovery is ownership-bounded. Tela may clear an exact recognized preload draft and may attempt
to retire a sole exact Tela context-file artifact, but it preserves any unknown pre-existing attachment or
user draft rather than guessing ownership. A product-path `context-canary` exercises the same hidden browser,
memory-file, upload, receipt and cleanup boundary without granting Native task authority.

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

Readable canonical request prefixes and public visible-history prefixes share the same bounded,
account-scoped checkpoint stage engine. Each UTF-8 fragment has complete ordered byte coverage;
ordered merges reduce the source within the real serialized Web input budget. The immutable request
prefix ends at the exact checkpoint anchor, so the newest user request stays verbatim. Completed
stage receipts survive disposable-cache loss; an uncertain submitted stage requires reconciliation
and is never replayed. Prefixes with inline media retain the bounded media-capable single-call path;
oversized media sources require an explicit compatible checkpoint rather than losing the media.
HTTP recovery uses terminal invalid-request status400, including after retirement; retryable:false
on status422 alone does not prevent the Native client from reconnecting. Started SSE streams retain
the same typed invalid-request recovery inside response.failed.

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

### Account observation and sign-in ownership

Web readiness is not proof that Desktop and Web use the same human account. The source-only
authenticated loopback `GET /v1/account-check` observes Native `account/read` with
`refreshToken:false` and the owned Web session on demand. Parallel checks coalesce; the temporary
Web observation lease is released, and no composer input, submission, authentication mutation,
credential copying, background timer or repeated polling is introduced. The response contains only
Native sign-in state, Web-to-saved-binding comparison, Native-to-Web container comparison and
`userIdentity:unverified`. It returns no account identifiers, email, hashes or authentication material.
Missing Native workspace-routing metadata or unavailable Web state remains unavailable. Equal
containers may contain different users; Native engine authentication is not independently verified
Desktop UI authentication. This observation is diagnostic, not a new admission or account-change policy.
Runtime shutdown cancels outstanding checks. The observation deadline also settles the HTTP response
if a reader ignores cancellation; readers remain responsible for releasing their owned resources.
The source-only private Codex service forwards this observation through its authenticated per-slot
`account-check` route, validates the coarse schema and verifies the owned runtime/Native session before
and after observation. This is an internal diagnostic boundary; manual account-check controls are not
part of the intended user flow.

The account lifecycle goal is automatic alignment with Desktop: observe sign-out/account changes,
retire the old Web task authority, and establish the newly selected account before admitting Web work.
Users should not need to open the control center to detect mismatches. Native remains independently
usable. Implement this as one per-profile lifecycle with an account revision: an old revision cannot
submit tools or deliver answers into a newly authenticated revision. Ordinary account changes should
be event-driven, with bounded checks at connection/request boundaries where event coverage is incomplete;
no periodic account polling or background prewarming.

An isolated signed installed-engine fixture with an empty file-backed credential store observed
`account/updated` after `account/logout`; it changed no Desktop profile. This proves engine notification
support, not Desktop account-change propagation. A second isolated two-client WebSocket fixture also
observed the actor's logout notification on a separately initialized observer connection (one event each);
both stayed signed out, no model request ran, and the fixture process/data were cleaned. This establishes
cross-client notification delivery in the owned engine, not real Desktop event delivery or website SSO.
Actual Desktop-to-app-server event propagation must
be proven before using it as correctness authority. No automatic login/logout is implemented yet. Source now exposes `invalidateWebAccount()` for a proven
account change: it synchronously revokes admission/display rows and active Web turn capabilities,
cancels preparation, and joins one owned browser cleanup without stopping Native. Explicit reconnect
waits for cleanup; whole-profile stop joins it. Synthetic gateway tests prove a held old answer is not
returned, Native remains available, late preparation is disposed, and concurrent cleanup is single-owner.
The source profile runtime now connects an event-driven observer to the owned Native app-server after
publishing Native readiness. It subscribes before reading `account/read` with `refreshToken:false`,
coalesces event bursts into at most two reads, excludes superseded results, and invokes this method for
signed-out state, a proven difference in available account comparison fields, or lost observation.
Initial/repeated same-account notifications do not revoke admission; repeated signed-out state does not
repeat cleanup. Comparison hashes stay in memory; equal email/container fields do not prove human-user
identity. No periodic polling or authentication-changing RPC is introduced. Shutdown detaches/closes
the observer and still attempts profile cleanup if observer cleanup fails.

An isolated real-engine two-client fixture exercised this observer: the second client received logout,
performed its event-triggered second account read, and avoided duplicate signed-out invalidation.
A further isolated fixture placed both clients behind the actual default-Desktop proxy: the notification
and follow-up account read still arrived, and all fixture processes/temporary data were cleaned.
The profile-runtime entry point also bundles with the observer/invalidation code included; the bundle
was not executed or installed. Actual Desktop event propagation and installed observer operation are unverified. This does not log the
website out or sign it in; it is a lifecycle prerequisite, not completion of automatic synchronization.

A short isolated idle comparison recorded no extra account reads during two 15-second observer windows.
Measured live engine-tree CPU was 0.01s/0.00s with observation versus 0.01s in the stable baseline window.
The first baseline was excluded because transient startup children exited during measurement. This
coarse, short single-engine comparison cannot establish battery parity or whole-Desktop cost; host
CPU/noise and exited-child accounting limit inference. Evidence is `idle-comparison-result.json` under
the local account-event fixture directory. No sampler/polling was added to the product.

The retained CodexGPTWeb local-patches reference (15285cd) shares one Electron partition across its
login and task views, verifies sessions on cookie-change hints, and rejects stale authentication probes.
It provides explicit owned-browser logout and a dedicated-Chrome passkey transfer, but the reviewed
source contains no official Desktop login/logout synchronization. These are behavioral references,
not an implementation to copy. Upstream Codex ab021e9 returns a browser-login auth URL with automatic
browser opening disabled in app-server; the calling host owns where that URL opens. A potential unified
login must prove both Native authorization and a usable website session in the same owned browser.
That does not establish a handoff from the existing Desktop login UI. Also, `account/updated` can be an
initial workspace-routing snapshot, not just a change event. Observe before reading account state and
use revision ordering; never interpret every notification as sign-out or grant Web identity from its
coarse auth-mode/plan fields. Reference evidence is local under `build/account-event-isolation`.

An isolated installed-engine browser-login kickoff now confirms that `account/login/start` returns an
HTTPS authorization URL with PKCE/state and a loopback callback. The attempt was canceled before any
browser opened or authentication occurred; the engine remained signed out and fixture data/processes
were removed. This proves URL provision/cancellation only, not website SSO or a Desktop login handoff.
The installed engine's isolated generated public schema also exposes `useHostedLoginSuccessPage`
and `appBrand`. Official app-server documentation supports these options. Reviewed upstream source
persists Native credentials and redirects to a local success page by default; hosted success redirects
to ChatGPT's open-app page without raw tokens in that hosted URL. The local callback does not establish
a ChatGPT website cookie. Authorization-host and hosted-page SSO behavior still requires actual sign-in
in the same owned browser; neither schema presence nor a success redirect proves account alignment.

First investigate a supported shared authentication/session boundary that lets Desktop sign-in also
establish the owned Web session and lets Desktop sign-out retire that session. Automatic routing
invalidation is not equivalent to signing out the website, and OAuth credentials for API usage are not
proof of a ChatGPT website session. Current official authentication documentation describes browser-based
Desktop sign-in and browser-local ChatGPT web sessions; it does not establish cross-profile website SSO.
The official Sign in with ChatGPT contract targets API authorization, and returning account hints identify
an account rather than grant a website session. Do not copy Desktop credentials/cookies or assume
same-container observations prove the same user. If user authentication is unavoidable, present the
necessary action in the current Work flow, with automatic detection and recovery; this is an exception
requiring an established technical limitation, not a replacement for the automatic-lifecycle goal.

Bindings belong to individual browser partitions: explicit setup may reuse or swap accounts without
reading or changing another slot's binding. See [authentication](https://learn.chatgpt.com/docs/auth),
[registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and
[accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Desktop lifecycle ownership is mutually exclusive. With no Multi-Profile provider configured, slot 1 is resolved
by the built-in default Desktop adapter and remains independent of every optional provider. When a Multi-Profile
provider is explicitly configured, the composite product route still resolves **slot 1 through the built-in
default** and delegates only optional managed slots (2+) to the public target/session contract. Tela does not
invoke both Desktop adapters for one slot. Provider removal makes those optional slots unavailable without
retargeting the default Native owner. Tela's Responses/browser/task authority remains in the same product
runtime.

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
and only explicit verified setup replaces that slot's binding. Other slots may use the same account;
their browser partitions, bindings and Native turn authorities remain independent. Canary readiness verifies
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
profiles and development canaries both fail closed when the configured connector cannot be selected. A live
stable-product proof showed that submitting an unbound prompt and relying on ChatGPT's automatic connected-app
routing can complete a Web answer without invoking the required exact-turn Native tool, so that behavior is
not accepted as connector proof. The long-term design may bind by a stable technical identity independently
from a user-chosen display name, but display-name freedom remains incomplete until that binding is empirically
proven across supported surfaces.

Connector activation separates semantic targeting from physical input: page DOM code proves the exact
catalog row and returns only its viewport coordinates, the owned browser host emits one real primary-button
pointer click, and the provider then re-proves the exact connector pill. A synthetic DOM `.click()` is not
accepted as connector activation because it can reproduce visible markup without proving the product's
real app/tool activation path.

The current provider understands both historical `@mention` selection and the newer `+` integration picker.
Both paths are bounded and structural. If a catalog path changes or becomes ambiguous, Tela records only
privacy-safe counts/stages, clears only its dedicated probe surface, and fails closed; it never clicks an
arbitrary card or treats an unbound submission as equivalent to selecting **ChatGPT Tela**.

Approval automation is a separate opt-in policy boundary. Default mode is `off`. The only automated mode is
`recognized_once`: one structurally recognized tool-approval card with one deny choice and one one-shot allow
choice may be activated. Persistent `Always allow`, unknown layouts, multiple cards, or ambiguous controls are
never auto-approved. Approval-card text, tool arguments, prompt content, or raw HTML are not exported from the
renderer for policy decisions or diagnostics. The user may choose one bounded delay preset from instant
through 15 seconds. Tela waits first and only then inspects the **current** card from scratch, so a stale card
target is never retained across the delay.
Approval-card appearance, replacement, mutation and removal contribute an opaque revision to the
semantic surface snapshot, so card-only changes wake the observer. Approval processing can run before
an assistant message exists, after turn-lineage ambiguity checks. Diagnostic transitions contain only
assistant phase, card count and policy mode; they never include card text or tool arguments.

An accepted provider turn identity is also distinct from ChatGPT's renderer-local `data-turn-key`.
ChatGPT may replace a provisional key when the server-hydrated turn arrives. Tela keeps its accepted
provider handle stable and may rebind only the renderer key when exactly one assistant parent lineage is
new relative to the pre-submit baseline; zero candidates remain pending and multiple candidates fail
closed as ambiguous. Displayed text or "last message" position is never used to guess across a rekey.
A same-route renderer frame without user messages is pending identity, not a proved foreign request.
It cannot authorize an approval, progress projection, tool-result handoff or final answer. Waits use DOM
mutation events and the Native turn cancellation signal; they do not resubmit or add polling. The next
frame must prove the exact accepted user fingerprint and parent before work resumes. A route change,
contradictory user identity or multiple new parent lineages still fails closed. Buffered completions and
retained-prefix checks follow the same boundary; a loading frame cannot become a committed answer.

The sibling canary preflight is deliberately non-mutating and has a separate secret-free config loader;
it never requires the live Responses token, public MCP bearer, or Secure Tunnel runtime API key. It may briefly bind the configured loopback
ports to prove availability and may create one hidden profile surface for a non-submitting readiness
observation, but it starts no Responses/MCP listener, installs no Codex route, launches no managed target,
and acquires no external tunnel. Stock preflight proves that its route is process-local and leaves the live
Codex config byte-identical; managed-profile inspection consumes only `targets` and `target-session`.
If the selected profile slot has no verified account binding yet, preflight reports setup as blocked without
opening Electron or creating that slot's browser user-data directory.
The result is a structured `pass`/`warning`/`blocked` checklist rather than a partial canary lifecycle.

Canary Native selection now has two explicit modes. `stock` is the default and keeps the isolated canary's normal
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

## Change-resilient Web identity and recovery design

Design target: absorb presentation changes inside the provider adapter without changing canonical
history, execution ownership or reusable checkpoint identity. No DOM integration can promise immunity
to every upstream update. An unsupported structure must cause a bounded, diagnosable capability
failure; it must not silently misdeliver an answer or initiate another expensive preparation.

Keep three independent boundaries:

| Boundary | Owns | Must not depend on |
| --- | --- | --- |
| Native logical context | Active revision ancestry, edits, tool authority, checkpoint coverage | DOM keys, layout, adapter release number |
| Owned Web operation | One send attempt, account/model/epoch, causal user/assistant identity, settlement | Display position, latest visible answer, retry count |
| Replaceable observation adapter | Capability detection, renderer-key mapping, exact payload extraction, narrow actions | Authority to replay, truncate history or invalidate summaries |

Prefer documented public contracts when available. Otherwise detect supported structural capabilities
locally inside the existing adapter; selectors and renderer conventions remain replaceable implementation
details. Do not create per-version, per-profile or per-error fallback chains. Readiness reports the
capabilities actually observed, separately from login and model availability. An idle/readiness probe
must not send a model message or claim that a task response has succeeded.

The operation receipt retains pre-send composer proof, baseline logical anchors, one activation
boundary and subsequent identity observations. Logical identity and body extraction are separate
evidence: an anchor alone cannot authorize a tool or final delivery, and a text match alone cannot
adopt a foreign message. Rekeying/hydration may replace renderer keys only through a unique causal
mapping on the same owned surface. Missing frames remain pending within the observation deadline;
route/document changes require renewed ownership proof, never an implicit resend.

Payload extraction must distinguish author content from wrapper decoration through an evidenced
structural contract. The adapter supports one root or one equal-text containment chain. Unequal
endpoints of one chain expose bounded alternative fingerprints without selecting an author root.
The shared identity resolver accepts an alternative only with a logical anchor and exactly one
full expected-payload match, inside the caller's proven causal message boundary. A primary
conflicting payload takes precedence; siblings, branches, missing anchors and unmatched alternatives
remain unproven. This is independent of which endpoint contains the expected author text. Do not
strip arbitrary text, use a substring or guess an intermediate candidate. Extend structural support
only with bounded evidence and sanitized fixtures, never per-UI-version fallback branches.

The live failure with a 26,327-character composer and unequal 10,126/52-character candidates proves
that displayed candidate text is not a complete transport receipt. It does not prove server-side
truncation. The shared provider can now bind a causal submission receipt without interpreting that
display text: exact full composer readback and one send activation, one consumed composer, a unique
new logical user anchor absent from the baseline, exactly one paired assistant with the same anchor,
no competing new assistant parent, and an unchanged host input boundary. Only same-route or the
owned initial/provisional-to-conversation transition is admissible. An observed user witness may
survive virtualization until that same logical parent appears; it grants no authority by itself.

`BROWSER_INPUT_OWNERSHIP` is a product-neutral host capability with a monotonic unowned-input
revision and an abort signal. The Electron adapter fences unowned keyboard/pointer activation and
disposal while allowing owned automation and read-only inspection. Missing host support cannot
authorize causal acceptance. Input invalidation aborts active observation/approval waits; delivery
and commit boundaries recheck ownership after asynchronous work. Native cancellation/edited ancestry,
document lifetime, lease/account and assistant-body completion contracts remain mandatory. Causal
receipts bind intended local sends, not provider-billed usage or a server proof of every received byte.

Establish and retain this receipt independently of initial author-body readability. A readable or
normalized preview must not select a weaker lifetime rule or discard the host input fence. When
causality is proven, pin the exact submitted composer fingerprint; keep rendered-body comparisons
as separate structural evidence. Without the full causal proof, the existing payload proof path
still applies. Do not turn a failed observation into an invented receipt or a new model request.

Once causally bound, displayed author hashes are advisory; the same logical document/parent and
unchanged input/Native owner retain identity through preview changes. A different anchor, foreign
route, competing user/parent or revoked owner cannot borrow the receipt. Primary payload comparison
remains the independent existing proof path when no causal receipt is established. Synthetic saved-chat
deletion still requires its exact marker/content proof; causal task identity grants no delete authority.

Cancellation revokes further commit/tool authority; it does not assert remote termination or undo
completed effects. An edited resend starts from the new canonical ancestry after the old owner's
local execution/cleanup settles. Late observations remain attached to the old operation. Reuse compatible
completed prefix summaries; exclude abandoned descendants. Steering follows the same ownership rules
at its supported cycle boundary, rather than injecting arbitrary input into an active Web generation.

Recover observation before reconstructing context: reconcile the exact existing operation through
read-only owned observations, then resume delivery only if its identity and completion are proven.
A timeout, adapter update or cache miss alone proves neither remote failure nor safe replay. If proof
cannot be recovered, preserve the unresolved receipt and completed checkpoints and report one actionable
blocked state. A new authorized operation still needs the established release/ownership rules.

The isolated checkpoint runner owns one cancellation scope spanning its Native owner and the
host input boundary. Either owner can cancel local observation. Successful physical release then
permits the existing local-cancellation settlement, never a claim that remote generation stopped.
A release failure or generic observation error without cancellation remains unresolved. Completed
validated results persist before release, including cancellation races. No path resends automatically;
future execution still requires the existing authorized Native lifecycle and compatible source proof.

Implementation sequence and acceptance gates:

1. Preserve first failure and last observation separately; add bounded structural identity transitions
   and candidate comparisons without payloads (see `docs/diagnostics.md`).
2. Reproduce the unequal-root incident and renderer replacement locally; extend the shared adapter
   only for an evidenced author-content boundary. Keep unsupported structures explicitly unproven.
3. Verify equivalent wrappers, unrelated decoration, missing/replaced keys, transient empty frames,
   siblings, contradictory identity and duplicate candidates. Exercise ordinary send, cancel,
   cancel/new input, edited resend, steering and late completion through the same operation contract.
4. Count sends, tool effects, final commits and preparation work. Require no duplicate send/effect,
   no old-owner commit, no mechanical verification model call and unchanged compatible receipt reuse.
   Verify useful final delivery in the affected installed profile separately from fixture success.

These are design/acceptance requirements, not a claim that reconciliation or every extraction shape
is implemented. Exact anchored endpoint resolution, guarded causal receipts and bounded acceptance transitions are implemented;
unknown endpoints still fail closed. The earlier incident did not record endpoint matches, so its
successful live recovery remains unverified. No read-only durable post-timeout reconciliation was added.
Token-cost gates live in
`docs/token-efficiency.md`; adapter changes must preserve those independent gates.

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

The private service-to-profile turn bridge opens one authenticated MCP session per operation and
explicitly terminates it afterward. Server idle reclamation cannot invalidate a stored client lease;
there is no keepalive or automatic replay of a possibly accepted Native tool call. Startup cancellation
also remains separate from normal cleanup of already-owned profile resources.

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

The product profile starts an independent authenticated Responses transport and private turn bridge,
then launches its owned Native target. Native model discovery retains the official engine's cache and refresh
path. A composite provider router augments official model responses with admitted browser-discovered Web
families. The Web identity uses an opaque key derived from observed family semantics. Browser preparation
runs independently of Native readiness; account binding, connector and fresh-surface proofs grant Web
execution admission. The authenticated profile control endpoint exposes preparation state separately from
the engine's dynamic `model/list` visibility.

The menu and control center receive Native readiness before waiting for Web preparation on the same bounded
connection stream. Inventory reads are on demand and coalesced. Explicit Web reconnection checks active
request/turn ownership, revokes admission, disposes only the old owned browser and runs the same preparation
proof. Native stays available throughout. A transport failure revokes Web admission without resending an
uncertain turn. Snapshot capture remains on demand and unavailable while there is no admitted browser.

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
Plura-owned extra profiles use the optional versioned public launch/quit contract with the same composite
Responses route. The launched route fingerprint and Desktop PID establish ownership. Dynamic models use
the engine's official catalog path for both target types. Native-ready, Web-admitted and visible-model states
have separate proofs; actual Desktop picker behavior and first-window latency require product acceptance.

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
  -> load bounded root project instructions and advertise nested instruction files
  -> bounded directory listing / recursive text search
  -> discover project/standard Agent Skills and read them on demand
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
Unresolved reservations are never age-pruned to make capacity: only proven terminal records can be
reclaimed, and operation replay is restricted to its original workspace. A private per-store HMAC binds
the reserved workspace, resolved working directory and exact command; wait duration is observational and
does not change execution identity. Replays with changed arguments fail before spawn. Preexisting records
without identity proof remain queryable but cannot authorize execution replay. No command/path payload or
request digest is exposed through status or diagnostics. Completed output is retained separately under private
Chat state, up to 512 KiB per operation and 256 reserved operations (128 MiB raw output). One signed output
file is written on completion, without periodic flushing or rewriting all prior output. An identical request
after restart verifies the result and returns `outputRecovered`; it never restarts the command. Corrupt or
missing output fails recovery. Storage failure preserves an unresolved reservation. Capacity reclamation
verifies and removes expired terminal results; unresolved records are preserved. Outputs may be sensitive:
they are not diagnostic logs or package/Git inputs and follow Chat state preservation/removal policy.
Mid-execution restart reconciliation, owned process identity/termination and power-loss durability remain
unproven; this completed-result boundary does not authorize attaching to prior PIDs.
Restart observation preserves the original launching server identity, PID and start timestamp when marking
an unfinished operation unknown. It does not claim the new server owns the old process. Duplicate operation
or session identities, more than 256 records, and a registry exceeding 1 MiB are rejected before rewriting
prior evidence; private state reads are bounded and reject symlink/file replacement.

Active-owner control is a source candidate; ordinary new executions do not yet launch it. One operation-scoped
loopback endpoint binds owner, workspace and operation; directional HMAC authenticates requests/responses
without sending the key to a potentially reused port. Observation disconnect cancels only that wait.
Stdin reserves request identity before writing and rejects ambiguous retransmission; explicit execution
cancellation is a distinct, single-attempt adapter callback, unavailable without proven owned-tree support.
Requests, responses, concurrency and accepted input identities are bounded; no polling or new permanent
service is introduced. A real isolated worker survived manager death and accepted authenticated input once;
installed lifecycle reconciliation, OS-owned-tree implementation and resource admission remain incomplete.
The source execution journal claims each admitted operation exclusively before command spawn, recording
original launching server, owner, workspace and request proof. Live descriptors and terminal receipts are
signed, phase-separated, immutable and limited to 4 KiB each. Conflicting, corrupted or incomplete claims
remain uncertainty and never authorize replacement execution. Only matching claims can publish or recover
live/terminal authority. The registry remains capacity authority; the journal has no independent expiry,
automatic retry, PID adoption or permanent service. Manager recovery now recognizes explicitly reserved
owner-worker executions: same-request replay observes the signed live owner, input requires matching scope
and fresh worker approval, and signed completion reconciles the registry before authenticated output recovery.
Source publication now synchronizes reservation, immutable journal and result bytes before granting the
next transition. POSIX parent entries are synchronized after publication/removal; registry replacement uses
one exclusive pending slot. Failed retirement commits retain in-memory replay authority, and incomplete
pending evidence is not overwritten. This does not prove ancestor-directory or hardware power-loss
durability, Windows directory synchronization, complete-tree lifetime, or resource admission. It is uninstalled.
Public `process_status` now requests an authenticated owner snapshot on demand for unfinished worker
executions. It reports current liveness/I/O without consuming output or changing execution, preserves the
original launch identity, and rejects mismatched snapshots. Saved PID metadata alone still proves no liveness;
the synchronous local status reader remains conservative. No periodic status polling is introduced.
Public `list_processes` is bounded workspace-scoped registry discovery (25 by default, maximum50),
with a monotonic session cursor and explicit completed-record inclusion. It never probes owners,
consumes output, exposes command/auth/result contents or replays execution. Saved unknown records
remain unknown; current owner observation uses `process_status`. Command terminal state still proves
neither full descendant termination nor OS execution-scope release. This source capability is uninstalled.

Direct executions retain their existing path. An internal candidate admission can now start a worker from
a caller-verified executable after registry reservation; readiness is bounded and uncertain startup never
falls back to direct execution or replay. Normal shutdown refuses unresolved worker reservations, preserving
the work and evidence. Candidate admission currently covers user workspaces only; managed workspaces,
owned cleanup, package admission and cancellation remain before enabling it in the normal daemon.
The existing compiled Chat executable now has a private operation-owner role, verified in an isolated
copied-executable fixture without source-checkout dependencies. It reads the private reservation and fresh
folder approval, claims before spawning, retains bounded signed output and exits with the command. Workspace
identity remains opaque rather than being mistaken for an operation UUID. Terminal observations drain before
the owner's transport closes. This role is not launched for normal new execution or installed; recovery is
verified with an isolated copied executable and reopened manager, not installed service lifecycle. It does not establish
service-update/removal safety, owned-tree cancellation or CPU/battery equivalence.
Resource admission for the per-operation Bun role is withheld. An isolated closed-cohort comparison
measured 0.11–0.14 CPU seconds and about 68 MiB peak RSS for a fixed short command; a 24-module
minimal entry retained the same recovery contract but still measured 0.09–0.13 CPU seconds/about
64 MiB. Direct command CPU was below the timer's precision with about 2.3 MiB peak RSS. These are
scoped helper/command costs, not full product or battery measurements. A native execution/output floor
matched direct RSS, but lacks authentication/recovery and is not an equivalent candidate. Next implement
and verify a lean native owner against the existing signed journal/IPC/request/output contract before
product admission. Retain the Bun role as a behavioral oracle while that replacement is unverified;
do not add a production fallback, permanent executor, prewarming or status poller to hide the cost.
The native owner foundation now implements bounded no-follow state reads, fresh approved directory identity,
exact request HMAC and exclusive private phase-signed claims. Node/Rust synthetic crypto vectors and a
copied standalone executable verify the same request/claim contract and refusal on duplicate/incomplete
claim, changed command, revoked approval, replaced directory, symlink state and ambiguous registry.
Its POSIX execution foundation now pins the approved working directory for child exec, owns both output
pipes, retains an exact bounded 512 KiB tail and publishes signed terminal results without overwriting
uncertain evidence. An isolated copied completion harness survived its requesting launcher's SIGKILL;
the real Chat manager recovered its exact completed output with original ownership and one execution.
Large-output, signal and conflicting-result cases passed. This is completion recovery, not live reconnection.
The source native worker now also implements the same operation-scoped signed loopback HTTP contract,
using one event loop with bounded active peers and nonblocking serialized stdin. Fresh folder approval is
checked after queued writes obtain authority. Request identities are reserved before input; disconnected
partial input is never replayed. Disconnecting a wait abandons observation, preserving execution and
unread output; admitted terminal responses drain before the endpoint closes. Real manager launch and
SIGKILL/reopen, signed live status/input, queued approval revocation, pipe saturation and completed-output
recovery passed with a copied signed executable. This is source-only: the normal daemon does not select
this binary and it is not packaged. Owned-tree cancellation remains explicitly unavailable. Cleanup/package
lifecycle, Windows support and full resource comparisons remain before admission. No native resource or
replacement acceptance is inferred from the earlier execution-only floor. Pipe readers block on OS I/O;
no polling, prewarming or permanent executor was added. Active peer deadlines bound only the IPC request,
never command lifetime.
The private Chat service checks shutdown admissibility before tearing down any transport or peer
subsystem. A synchronous process-owner gate refuses unresolved workers; admitted capability calls remain
counted until both execution and response delivery/disconnection finish. Disconnecting a caller alone
never releases a still-running capability. Shutdown refusal leaves the private endpoint and daemon signal
handling available; admission blocks new calls. Teardown failure remains stopping rather than advertising
a partially closed runtime as ready. Explicit requests coalesce, and refusal waits for another explicit
request without timer/retry/escalation. The internal runtime accepts a caller-verified candidate owner
configuration for isolation proofs, but the normal daemon does not set it. A real native operation
survived HTTP/signal shutdown refusal, accepted signed input and exact terminal output, then allowed
normal supervisor shutdown/descriptor removal. This is a service-boundary proof, not installed
updater/remover or full process-tree cancellation acceptance.

Update, repair and service controls use authenticated runtime shutdown authority before platform
quiescence. The controller requires an explicit shutdown contract; production binds the install-scoped
supervisor and refuses missing/unreachable/foreign identity. No systemctl stop, launchctl kill or
Stop-ScheduledTask fallback remains. Platform start and bounded state verification remain. A signed
synthetic package fixture with a real Chat/native operation proved refusal preserved old payload,
manifest, registry and quiescing journal; signed input completed once, then the same explicit upgrade
resumed. OS registrations/service package executables were synthetic, not actual OS-service or packaged
native-owner admission.

Uninstall treats product-owned resources as shared dependencies: if any service refuses normal shutdown,
preserve its own resources and all product-owned binaries/configuration/recovery UI. Other cleanly
stopped service resources remain independently removable. A real-native fixture exercised the actual
source remover with an injected fake OS runner: remove-data refusal preserved exact Chat registry,
approval and binary bytes and its descriptor. Existing signed input then completed the command once;
a later explicit uninstall removed owned product resources while preserving the user workspace. No OS
registration changed. This does not establish packaged updater, launchd termination or managed workspace
execution admission.

Terminal capacity reclamation now uses one bounded authenticated retirement intent (16 KiB maximum,
at most four exact result/journal artifacts). The manager authenticates terminal evidence and binds the
intent to the SHA256 of those same bytes and artifact-directory identity. Registry removal is persisted
before artifact unlink; restart resumes only that signed intent, accepting already-removed planned files
but refusing changed bytes, roots or records. Unknown/inflight reservations are never reclaimed. The
registry persists a monotonic session high-water mark so removing the newest terminal row cannot cause
session identity reuse after restart. The source candidate now writes explicit store version 2, requiring
the key and counter; it transitions existing version-1 records without changing the store pathname.
A real already-live prior Native owner continued through its original signed endpoint after transition.
Prior Native readers reject version 2 before a claim. This preserves evidence, but an incompatible
rollback would leave its old service unavailable. The signed source package now declares read/write
format compatibility, checked at install/upgrade/repair planning and application, after shutdown drains,
and at Chat launch. A reader must also avoid writing a lower format. Unknown/corrupt state refuses;
Gateway/Codex launch stays independent. A real owner survived incompatible signed targets and stale
plans; compatible explicit upgrade succeeded after exact completion (`build/chat-store-package-compatibility`).
A late format change keeps the old payload and quiesced checkpoint; source cancellation now has a signed pre-replacement fixture gate;
Packaged CLI/dry-run and actual live-owner preservation now pass (`build/upgrade-source-cancel-live`);
UI and actual OS restart gates remain. The signed lifecycle protocol now gates source cancellation;
undeclared old launchers refuse before mutation and preserve the active owner, while declared sources
restore through the normal resolver (`build/upgrade-launcher-contract`). This is explicit capability
admission, not a retrofit or old-launcher restoration promise. Production-built compiled launcher/Chat
and a compiled fixture coordinator now pass source restoration, authenticated shutdown and removal
with fake OS registration (`build/compiled-transition-boundary`); no Native engine rebuild or owner
activation. Heavy reproducible test payloads were cleaned. Actual OS/consumer UI acceptance remains. Final target restoration admits only the recorded resume service
at `manifest-updated` or `repaired`, after physical receipt/ownership proof and matching install,
version, fingerprint and quiescence records. Source cancellation permits recorded services at `restoring-source` with the exact source version
and fingerprint; no duplicate running service is started. Other phases and general actions stay blocked. The signed
fixture coordinator invokes the actual resolver at both checkpoints (`build/transition-launch-admission`);
fake OS registrations and service payloads do not prove platform restoration or old-launcher compatibility.
Evidence: `build/chat-owner-store-version`; the normal daemon owner remains disabled. This runs at bounded admission/capacity checks, without scans or
idle timers. A real manager/native completion fixture with an isolated filesystem gate was killed after
registry commit and before unlink; reopening finished four-artifact cleanup and preserved 255 unknown
reservations plus the next session identity. Partial deletion and authenticated-byte replacement tests
also passed. This is process-interruption recovery, not power-loss/fsync durability, concurrent namespace
replacement safety, old-version rollback compatibility or installed update/removal admission.

The first same-contract native/Bun resource gate now passed its scoped comparison: eight synthetic ABBA
live-input/terminal-result runs measured native owner+waited-shell CPU 0–0.01 seconds/about 3 MiB max RSS,
versus the fresh 24-module Bun reference at 0.12–0.18 seconds/about 70 MiB. A separate waited controller
cohort also used less CPU. A two-second blocked-input dwell showed no measured native CPU growth; timer
rounding is not zero CPU, wakeup or battery evidence. This supports continuing the native implementation,
not enabling it by default. Whole-product/current-direct-path energy equivalence, large/concurrent work,
cancellation and lifecycle ownership still require their own gates. Reuse `build/native-owner-resource`
rather than repeat the unchanged short comparison or cite an execution-only floor as equivalent behavior.

The macOS tree-cancellation gate remains unaccepted: owned synthetic process-group termination
left a setsid descendant running until explicit pipe release (`build/chat-owner-cancel-boundary`).
The current SDK declares NOTE_TRACK/NOTE_CHILD unsupported. Group signaling and PID snapshots
do not prove complete arbitrary-shell containment. Keep cancel unavailable and owner activation off
until a platform lifetime boundary or explicitly constrained execution capability is proved. Do not
substitute idle scans or repeated signals. This does not rule out every macOS cancellation design. Normal
root exit and output EOF likewise do not prove that descendants stopped: both direct and signed Native
completion admitted shutdown/workspace removal reservation with an independently blocked setsid child
(`build/completed-command-descendant-boundary`). Command result and OS execution-scope lifetime must
remain separate authority. No existing terminal flag may be reinterpreted as complete-tree proof;
scope release for removal/shutdown needs a supported platform boundary covering normal exit and cancel.


Normal Chat shutdown is not execution cancellation. Both direct and owned unresolved operations
refuse shutdown before any peer transport or recovery subsystem closes. Do not replace that gate with
root-process TERM/KILL: a direct-path fixture left a setsid descendant alive after close returned
(`build/direct-shutdown-boundary`). Completion permits normal closure; saved unknown direct operations
retain the refusal because no valid restart reconciliation exists yet. This source fix is not installed
and does not prove arbitrary-shell cancellation or complete direct-process recovery.

Process state becomes committed only after registry persistence succeeds. A failed update restores the
prior in-memory record; direct child callbacks contain storage errors and retain uncertainty instead of
publishing completion or crashing the service. Known child output waiting is separate from stdin
availability. Signed completion reconciliation also requires a successful registry commit before
shutdown admission. The private completion-storage fixture and restart tests cover this boundary
(`build/process-completion-storage-boundary`); they do not resolve unknown direct records or prove
power-loss durability or descendant containment. This change remains source-only.

Workspace open also returns bounded root-level `AGENTS.md` / `CLAUDE.md` instruction content plus a bounded
list of nested instruction files. Nested files are never silently injected later: the caller must read the
applicable file before working under that subtree. Instruction discovery skips dependency/build trees,
rejects instruction-shaped paths that cannot be proven inside the workspace, and reports an incomplete scan
instead of pretending an enumeration bound or unreadable subtree contains no instructions.

`show_changes` is Git-backed, disables external diff/textconv execution, and returns tracked diff plus
untracked paths for only the selected workspace. It also writes a bounded self-contained historical review
artifact under Tela Chat state. `show_review` reads only that retained artifact, so later working-tree edits
or a service restart cannot silently change what an old review reference means.

Current and historical review results also expose a compact file/addition/removal summary. When a historical
checkpoint has captured text/symlink untracked content, that summary includes it; binary untracked content or
a live checkpoint-capture failure marks the summary incomplete rather than inventing line counts. Turn-oriented
`last_shown` review is implemented through a private persisted checkpoint pointer. To compare two self-contained
checkpoints, Tela reconstructs each snapshot into a short-lived product-owned Git object/index directory that
uses the user's repository objects only as read-only alternates, diffs the two private commits, then deletes the
temporary object store. The user's Git object database and refs remain byte/object-count neutral. A successful
comparison advances the private baseline; an unavailable comparison preserves the old baseline instead of
silently skipping unreviewed work. `show_changes` can also compare against the pinned workspace-open checkpoint
without advancing `last_shown`, or can explicitly mark that comparison reviewed. Open and last-shown checkpoints
are protected from ordinary count-based review pruning while still remaining subject to the global 30-day
retention horizon. Richer host review UI remains separate product work.

The public frozen Chat capability call can attach UI **per result** without adding a fifth model-visible MCP
tool. `show_changes` responses carry `_meta.ui.resourceUri` pointing to a registered, self-contained MCP Apps
review resource; other dynamic Chat capabilities do not. The widget renders only the already-returned review
envelope, performs no network requests, and inserts paths/patches with `textContent`. The four public tool names,
descriptions, and input schemas therefore keep the same frozen fingerprint. This is covered by MCP client
resource/result tests, while a real ChatGPT rendering canary remains required before the UI is called live-proven.

The same selective-result mechanism now serves an optional local file-import card. `open_file_import` returns
only the workspace id and size budget; user-selected local bytes go through the existing generic capability
call to `import_file`. The card has no remote network permission. A dedicated on-demand Rust helper pins the
registry-proven directory identity, opens each existing parent without following symlinks, writes/syncs a
private destination-filesystem staging file, and atomically hard-links it to a new final name. Existing files
are never replaced; helper errors expose only error kinds. A single import at a time and 2 MiB budget bound
process/memory work; runtime shutdown waits for the bounded active operation. No Codex engine change is
involved. The helper is optional signed-payload metadata and only the receipt-proven launcher supplies Chat's
executable path. Without it, the import capabilities are absent.

macOS binary and authenticated HTTP tests, parent symlink-swap races, package signature tamper tests and
frozen MCP fingerprint tests are proven. Windows/Linux execution, actual ChatGPT card rendering/library
selection remain release gates. Normal completion removes the staging directory;
post-publication cleanup failure is explicitly reported as a successful publication requiring cleanup.
Timeout/invalid-response outcomes are uncertain, never automatically retried. Protocol 2 records a private
per-workspace intent before allocating scratch, checkpoints its parent/stage directory identity, then waits
for the caller's release before creating content. Opening the import card or saving triggers recovery through
those records, never through a workspace prefix scan. Recovery clears only the proven private stage cache;
unexpected entries, replaced directories or incomplete identity proof are preserved and block new allocation.
Journal reads are bounded (16 records, 8 KiB each), and no recurring cleanup task is added. Actual helper
SIGKILL at the durable checkpoint plus empty/partial/published recovery fixtures and replaced-stage refusal
are proven on macOS. Power-loss recovery is not claimed.
Imported final files are user workspace content and never uninstall targets. The uninstall planner and its
pre-removal observation preserve Chat recovery state and ownership/configuration when journals are pending
or unsafe; the result includes a consumer recovery notice. This prevents saved-data removal from destroying
the proof needed to clean scratch later.

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

Managed-worktree deletion is not equivalent to `git worktree remove --force` on an arbitrary path.
The workspace registry reserves removal before asynchronous inspection and retains exclusion until
cleanup returns or fails. Overlapping workspace access cannot start during that reservation. Durable
process and agent managers refuse removal for running or unresolved work; missing agent drivers and
terminal-retention limits must not discard unresolved authority. Async file import/export and review
operations hold bounded, on-demand use leases across awaits. There is no idle watcher or PID adoption.
Transient leases do not constitute crash-recovery authority for external processes.

With admission held, Tela re-proves all of these conditions immediately before removal:

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

## Independent profile products

Tela works with the ordinary official ChatGPT profile without a multi-profile provider.
Plura Desktop manages isolated ChatGPT profiles without Tela. When both are present, Tela
uses the public optional provider contract **only when explicitly configured**.
Without that configuration, the default profile remains on Tela's built-in
adapter and must not import, start, or depend on Plura. With the provider
explicitly configured, Plura is the **sole Desktop lifecycle owner** of the
additional managed targets (slots 2+), while Tela's built-in adapter remains
the canonical slot 1 owner. Tela never starts both owners for one slot and
continues to own its own Web browser/task/Responses state. Provider loss
invalidates only the optional managed slots; it must not rewrite original
Native history, stop Tela's default profile, or destroy independent Tela Chat
or the original ChatGPT app. Changing an extra slot's owner is an explicit
disconnected transition, never an in-flight automatic fallback.
Neither product may claim the other's installation, registration, profile,
credentials, or user data for removal. For the standalone/coexistence/removal
acceptance matrix, see [product lifecycle](product-lifecycle.md#independence-from-original-apps-and-optional-providers).

Cross-profile **original local Work/Codex thread sharing** is an explicit
separate long-term research goal, not equivalent to single-profile Native/Web
model switching or copying a task summary. With the owner's updated acceptance
that a NEW destination conversation is acceptable, the **near-term product
priority is one-click, exactly-one-conversation checkpoint handoff** from its
verified source profile to a new Native Codex thread in a separate target
profile. Its actual two-account Native proof, bounded source limitations and
remaining end-user UI gates are documented in
[one-chat checkpoint handoff](one-chat-checkpoint-handoff.md). The older
original-thread shared-writer authorization research is preserved separately
in [cross-profile local thread continuity](cross-profile-local-thread-continuity.md).
No profile-to-profile authorization or original-thread continuity is inferred
from parallel logins, local storage access, approval UI, or a matching thread ID.

Desktop process ownership and Web model readiness are separate states. Readiness requires
an effective startup catalog and visible Web model rows. Inventory checks verify these
on demand and coalesce overlapping checks; they do not run an idle polling service.
The menu and Control Center share one inventory and profile presentation, excluding
superseded reads so older results cannot overwrite an in-progress connection.
