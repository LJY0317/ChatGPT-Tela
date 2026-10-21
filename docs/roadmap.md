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
  not be required. The managed `web-delegate` start/continue path currently accepts text only: expose the
  existing media/file contracts where needed instead of building another attachment engine. Receiving
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

## Desktop lifecycle and presentation

- Notify users when a newer release is available and offer installation from the menu-bar UI through
  the shared update lifecycle. Defer this feature until the existing update path is reliable.
- Complete the update/repair lifecycle through the running menu-bar UI as well as backend services and
  their owned children. Success must reflect new running code; retain normal recovery after a failed
  final participant. Review both command-line and UI-initiated updates.
- Provide a normal macOS application entry point discoverable in Applications/Spotlight. Reopening should
  reveal the existing menu UI or start it once, without restarting browser sessions or background work.
  Keep menu-only quit distinct from stopping services and manage installation/removal ownership.
  Verify standard computer-use discovery, accessibility and interaction with the packaged app; the
  current standalone executable could not be selected by the available app-control adapter.
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

## Remaining acceptance

Validate model selection on background Web surfaces without toggling an already-open menu again.

Use isolated owned tasks for archive/delete/manual-restore acceptance, current failure evidence for
checkpoint/stream recovery, and actual effects for media delivery. Preserve active work and uncertain
results. Track unsupported contracts explicitly instead of endlessly repeating historical failures.
