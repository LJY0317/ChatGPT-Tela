# Remaining product work

Current implementation and installed acceptance are separate. Reuse native platform contracts before adding
new runtimes, schedulers or queues. This list records product requirements, not completed guarantees.

## Delegation efficiency and capabilities

- **Zero coordinator tokens while waiting.** Waiting for a delegated result should issue no additional
  coordinator model requests. Use existing event subscriptions or blocking wait tools; progress display
  should not wake the model. Resume reasoning on completion, failure, required input or user steering.
  Measure coordinator requests/usage during the waiting interval separately from worker execution and
  result review. If the host cannot park and resume a turn under its public contract, document that limit;
  do not emulate waiting with repeated prompts or another Goal scheduler.
- **Carry relevant attachments.** The delegator should pass task-relevant user images/files through existing
  supported inputs or workspace references, reuse previously delivered material, and distinguish actual
  receipt from an attempted send. Add a short shipped delegation instruction; personal AGENTS files must
  not be required. Managed `web-delegate` start/continue supports text and explicit inline images.
  Arbitrary file upload is not supported by the current Native input contract; an authorized workspace
  reference requires actual read evidence. Reuse supported inputs instead of another upload engine. Receiving
  workers should discover the available tools without repeated instructions to use a specific image tool.
- **Use available native features when appropriate.** Discover Queue, steering, Goal, attachments,
  skills/plugins and other supported capabilities from current schemas and concise bundled guidance.
  Preserve profile ownership, existing chats and canonical context deltas. Availability is not evidence of
  reliable end-to-end delivery. Keep Native controls with the Native coordinator and Web work with Tela
  Chat. Do not duplicate a platform feature merely to advertise it.
- **Native Goal completion.** Route only original Native Goal tools through the existing Tela Chat
  control path when those tools are advertised by the current harness. A separate, cycle-scoped control
  capability cannot invoke Native work tools. Native retains Goal state, execution and scheduling.
  Verify live tool availability, same-turn completion and quiescence before claiming end-to-end support.
  Do not substitute per-task shell/RPC completion scripts or a second Goal engine; retire isolated test
  adapters after acceptance and retain only bounded result evidence.
- **Automatic failure follow-through.** A delegation failure should wake its owning coordinator with the
  exact job/turn, failure boundary and existing local incident reference. Reconcile uncertain effects first,
  then analyze and repair verified causes within the authorized task, or report the specific missing evidence.
  Reuse Native events and Queue instead of a second recovery scheduler, repeated model polling or blind
  resubmission. Coalesce the same failure; preserve existing chats and keep private evidence local. Verify
  coordinator wake-up through the supported host contract before promising unattended recovery.
  When missing evidence prevents root-cause confirmation, implement and verify the needed diagnostics
  across recording, notification, investigation and settlement before closing the follow-up. Explicitly
  record host-contract limits where observation cannot be added; do not fabricate receipt evidence.
  Expand scan coverage or byte/time retention budgets when evidence is lost; keep raw evidence local and
  opt-in, coalesce repeats, and retain bounded cleanup rather than introducing another log engine.
- **Recognizable delegation names.** First verified result collection prefixes a new Tela-created
  conversation once with `[Tela Agent]`, using its Native title or preview first line. Reuse the
  collection receipt; no title observer or timer. Preserve later user renames and stable thread IDs.
  Naming does not gate execution or affect provider-side chats. Live sidebar acceptance remains pending.

## Context preservation and failure recovery

- Compare cold Web seeds after edit/restart with the same active Native request and its actual compaction
  state. Audit whether summaries preserve unresolved goals, decisions, constraints, exceptions and evidence
  references; distinguish missing source history from omissions introduced by Tela. Report instructions,
  summary and recent-history shares separately. Byte-based token estimates are not provider billing, and
  neither a small seed nor a large token count proves sufficient context. Prefer removing redundant
  transport/instruction restoration over arbitrary minimum sizes, extra model calls or another summary engine.
- Review current checkpoint/stream failures using exact request and turn evidence. Separate supported
  paginated history from unindexed legacy history, installed behavior from newer source, and preparation
  rejection from a failure after submission. Repair current shared defects; document unsupported legacy
  recovery instead of rebuilding obsolete paths or retrying failed turns blindly. Add diagnostics only at
  boundaries where existing evidence cannot distinguish the cause.

## Remaining requirements from retired implementation candidates

Old candidate branches are retired; these requirements are not implementation or acceptance claims.
Reuse the current contracts instead of restoring their parallel registries, manifests or admission gates.

- **Unanswered requests.** Source now preserves new prompts/images in private journal sidecars before
  submission; local retrieval survives Native deletion and explicit review can settle a question using
  another verified job answer. Collection is not settlement. Existing retention reclaims reviewed history;
  unresolved originals are protected. Installed acceptance passed one new Web question through collection,
  explicit review, archive and deletion; old hash-only questions and external reference contents cannot
  be reconstructed from these sidecars. No replay scheduler.
- **Advisory capacity.** Source policies now target 32 unarchived managed conversations and ten browser
  surfaces per profile through the existing archival/retirement lifecycles. Pressure archives the oldest
  idle collected conversations; ordinary chats, uncollected answers, queued/active work and manual
  restores are protected. Browser retirement protects preparing/active work and undelivered answers.
  Structural diagnostics report occupancy/remaining excess, and Work help explains automatic cleanup.
  The existing managed-job capacity response now carries the last completed cleanup observation and
  aggregate protected reasons; Control Center shows a short pending notice with help when above target.
  Interrupted observations are not published, and uncertain archive outcomes are identified separately.
  Browser preview and work inspection also expose on-demand ownership counts and a pressure notice.
  Closing surfaces remain owned/listed until physical close succeeds; duplicate release/shutdown calls
  share the same close operation. Creating surfaces count toward the soft target. Opt-in capacity
  details now report protected conversation IDs, reasons, recommended next actions and eligibility times
  from the existing completed pass; `web-delegate capacity --cleanup` retrieves them without another scan.
  Selecting a retained browser in the existing preview now returns its exact lease/task protection state,
  recommended action and known idle expiry from runtime ownership, without another page scan or index.
  Keep cleanup automatic, with existing preview guidance rather than new per-item mutation buttons.
  Selected non-retained windows now report their existing lease owner and unconfirmed close state;
  they remain outside task cleanup. This does not identify an operation subtype or prove a protected
  result has been collected. Installed UI acceptance remains open.
  These are soft targets: no numeric rejection, forced close of protected work or indefinite admission
  wait. Installed acceptance remains separate from source verification.
- **Instruction reuse.** Source `open_workspace` accepts the caller's retained `instructionRevision` as
  `known_instruction_revision`, omitting unchanged global/root instruction bodies only on a match scoped
  to that workspace. Default/new-context calls and changed sources return full bodies; no delivery cache
  or Native revision inference. Source tests and installed API round-trips pass; autonomous model use
  and provider-billed token savings remain unmeasured.
- **Workspace continuity.** macOS source now records the system volume UUID with the directory inode,
  while Native file helpers receive the current mount's device/inode. Explicit open upgrades an old
  record only while its original identity still matches; an old record already missing that proof must
  be reopened. Non-disk filesystems and other platforms retain device/inode identity. Simulated remount
  and actual Native file read pass; installed reboot acceptance and other-platform identity work remain.
  Report a missing old checkout without recreating it or retrying its historical operation.
- **Shared execution ownership.** Reconcile independent Native Web/Goal activity through existing owners
  and cancellation paths. A stale observation must not disable unrelated Web startup. Avoid a second
  permit engine or stricter admission merely to implement a soft target.
- **Observation attribution.** Browser inspection must distinguish exact task/epoch ownership from the
  selected profile's unrelated preview. Correlate existing request/operation/RPC evidence through result
  projection and client receipt; missing evidence is unknown, not failure or proof of model understanding.

## Desktop lifecycle and presentation

- Complete the update/repair lifecycle through the running menu-bar UI as well as backend services and
  their owned children. macOS uses Sparkle; retain the supported CLI lifecycle on other systems. Success
  must reflect new running code and preserve normal recovery after failure, including actionable recovery
  when completed work leaves an idle tool process that blocks shutdown readiness. Never close ChatGPT
  for an update that preflight cannot start.
- **Owned-process cancellation.** The installed macOS operation-owner worker accepts explicit owner
  cancellation, then publishes terminal evidence after the command and its ordinary process-group
  descendants stop. Isolated acceptance verifies maintenance blocks beforehand, allows shutdown after
  settlement and preserves an independent process. A cancellation reply may still report running;
  it is not completion. Source maintenance UI now preserves failed observations instead of hiding them
  or treating an unavailable list as successful cancellation. Actual GUI cancellation and Windows/Linux
  execution remain unverified. Update readiness never cancels active work automatically.
- **Consumer update acceptance.** Use one menu-bar flow: Check for Updates, download/readiness progress,
  then Sparkle’s standard Install and Relaunch on macOS. Development dependency preparation and package assembly stay outside this flow.
  Ship the complete supported payload, including required helpers and runtimes; an update must not silently
  remove existing capabilities. Confirm the new menu UI, services and enabled profiles are running before
  reporting success; preserve an actionable recovery result when any participant fails.
- **Apply after current work.** Reuse host lifecycle events to apply an authorized update after the current
  Native turn and other active work finish. Preserve the authorization across UI/service replacement,
  show why an update is deferred, and avoid manual process cleanup, repeated model calls or a new Goal engine.
- **Runtime ownership acceptance.** Installed daemon entry points reject help and unsupported arguments
  before service startup or descriptor publication; isolated packaged checks pass for all three services.
  Shutdown cleanup is publisher-owned and preserves a successor observed before cleanup. A synchronous
  ownership comparison is not an atomic cross-process compare-and-delete; distinguish that limit from
  accepted ordinary shutdown and do not add stricter startup gates to mask it.
- **macOS application acceptance.** Packaged app discovery, accessibility and Control Center interaction
  pass. Normal OS termination and LaunchServices relaunch preserve service/profile process identities,
  Native routes and an active Native turn, with one menu instance after relaunch. Spotlight, the actual
  Quit menu interaction and preservation of actively generating Web windows remain unverified; keep
  installation/removal ownership separate from closing the UI.
- Improve Control Center profile rows, compact contextual help and the Web-session sidebar/preview.
  Keep previews on demand and retain existing session selection and browser interaction boundaries.
- Assess preserving compatible temporary Web conversations across update/restart without a resident
  bridge or a second ownership engine. If the platform cannot restore a temporary chat, state that limit;
  retain checkpoints and minimize cold-resume context. Keep the existing bounded idle lifecycle.

## Tool coverage

- Compare task tools in projects such as Chat on Steroids and DevSpace against Tela's current inventory.
  Adopt useful missing capabilities, including on-demand computer use, through existing platform contracts
  where possible. Avoid duplicate tools and idle browser bridges; expose capabilities through concise,
  discoverable schemas rather than personal instructions.

## Consumer installation and removal

- Implement the standard host install/connect/remove flow described in
  [consumer-installation.md](consumer-installation.md). Reuse existing lifecycle ownership and
  maintenance; distinguish computer removal, account plugin removal and saved-data removal.
  Verify official private transport/authentication and public-plugin-to-local-machine binding
  before committing to an implementation. Assess the approved desktop-only local MCP route separately:
  organization eligibility and temporary Web-worker compatibility are unproven. Avoid mandatory browser automation, duplicate
  connection engines or a new hosted relay without a confirmed requirement. Consumer completion
  must include actual connection verification and explicit reporting of any remaining host step.

## Remaining acceptance

- **Consumer disk footprint.** Before final release, measure download size, installed program size excluding
  user data, and Tela-generated growth during normal use and repeated updates. Check bundled runtime
  duplication, obsolete versions, caches, logs and temporary files; verify bounded retention and removal
  of owned leftovers on uninstall. Recheck when packaging, dependencies or storage lifecycles materially
  change, rather than on every edit. Reuse existing build and lifecycle tools; do not add a resident monitor.

Validate model selection on background Web surfaces without toggling an already-open menu again.

Use isolated owned tasks for archive/delete/manual-restore acceptance, current failure evidence for
checkpoint/stream recovery, and actual effects for media delivery. Preserve active work and uncertain
results. Track unsupported contracts explicitly instead of endlessly repeating historical failures.
