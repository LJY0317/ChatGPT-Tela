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
- **Goal completion boundary.** External Native Goal completion can race automatic successor startup.
  Same-turn completion or a supported scheduler fence is still required for a strict no-successor promise;
  prose completion and a successful external completion RPC are insufficient.

## Desktop lifecycle and presentation

- Complete the update/repair lifecycle through the running menu-bar UI as well as backend services and
  their owned children. Success must reflect new running code; retain normal recovery after a failed
  final participant. Review both command-line and UI-initiated updates.
- Provide a normal macOS application entry point discoverable in Applications/Spotlight. Reopening should
  reveal the existing menu UI or start it once, without restarting browser sessions or background work.
  Keep menu-only quit distinct from stopping services and manage installation/removal ownership.
- Improve Control Center profile rows, compact contextual help and the Web-session sidebar/preview.
  Keep previews on demand and retain existing session selection and browser interaction boundaries.
- Assess preserving compatible temporary Web conversations across update/restart without a resident
  bridge or a second ownership engine. If the platform cannot restore a temporary chat, state that limit;
  retain checkpoints and minimize cold-resume context. Keep the existing bounded idle lifecycle.

## Remaining acceptance

Use isolated owned tasks for archive/delete/manual-restore acceptance, current failure evidence for
checkpoint/stream recovery, and actual effects for media delivery. Preserve active work and uncertain
results. Track unsupported contracts explicitly instead of endlessly repeating historical failures.
