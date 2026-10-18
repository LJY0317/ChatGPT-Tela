# Web and Native compatibility gates

The canonical Native task, current turn, tool inventory, sandbox, history,
compaction and final-result provenance must remain independent of the
replaceable Web provider session. This document tracks requirements without
depending on downstream local patch sets or copying an external runtime.

## Accepted, owned operation

- An exact user/send receipt and unique user-to-assistant lineage bind every
  accepted Web operation. DOM rearrangement, navigation or a delayed approval
  must not silently change its accepted identity. Uncertain acceptance must
  never cause blind replay or automatic transfer to another conversation.
- An unchanged owned Web session is reused across compatible turns; an exact
  retained suffix is preferred over repeating the whole logical history.
  Fresh epochs are permitted for changed model/effort, invalidated authority,
  explicit provider rollover and hard context limits, never merely because a
  Native task compacted or a diagnostic poll elapsed.
- Large fresh context may use an exact, bounded in-memory attachment with a
  proven receipt; private files, unknown user drafts and existing attachments
  must not be silently mutated. Checkpoints are bound to the canonical source,
  and ambiguous tool results do not advance retained context.
- Web/native switches keep canonical `openai` provider identity and verify
  currently selected Web family and effort before consequential Send.

## Approvals, cancellation and recovery

- Automatic Web approvals are explicit opt-in. Full access prefers the current
  conversation choice, then a one-shot choice, without matching connector names
  or analyzing card text. A unique card-local target and visible Deny control,
  current owner, cancellation, trusted input and independently observed outcome
  remain part of the dispatch lifecycle.
- A human approval wait is a distinct state, not model progress. An overdue
  review must be surfaced with elapsed time and a supported manual decision
  path; a stale or unowned card cannot be clicked or denied automatically.
- Native turn termination must interrupt the exact active Web operation.
  Mere HTTP disconnect is not evidence that the accepted operation stopped;
  in-flight effects must be reconciled before another authorized turn.
- Cross-account/profiles do not share user credentials, Native turn
  capabilities, physical Web state or arbitrary worktree write authority.
- Public progress and displayed output must be independently verified;
  renderer-visible progress is not proof of a Native application UI receipt.

## Verification gates

Release checks include (1) real model/effort selection and restoration,
(2) owned Native tool/result continuation within a Web turn,
(3) retained Web surface plus suffix-only context with measured transfers,
(4) manual and ordinary opt-in approvals without replay,
(5) real Native Stop-to-Web termination, and (6) secure recovery from a
renderer hang, changed card, or uncertain accepted request.

Source/test pass, installed service health, and the completion of an actual
user workflow are separate pieces of evidence. Consumer signing,
cross-platform packaging, and published release verification remain separate
from local development installation.
