# Native and Web continuity on the official Desktop

The current Desktop path keeps the built-in `openai` provider and uses the owned
Responses route described in [Desktop setup](official-desktop-provider.md).
The official engine owns Native history, compaction and tool execution. Tela's
supplied-request gateway receives the model input that engine sends; it does not
acquire Native history authority from request or conversation identifiers.

## Logical history and physical Web context

Native history is the canonical record. A Web page receives a bounded working
representation, not necessarily the complete archived conversation. The existing
planner reuses an accepted Web prefix and sends its canonical delta when possible.
A fresh page uses the current readable input and compatible checkpoints, retaining
current instructions, the active request and required tool causality. Existing Web
context budgets and projection rules apply; raising a token limit does not recover
missing history. See [context ownership](context-continuity-contract.md) and
[token efficiency](token-efficiency.md).

Long, otherwise supported conversations remain normal support targets. Their age
or archive size alone is not a reason to classify them as legacy. Distinguish:

- A readable request that fits after the supported working-context projection.
- Required current input that cannot fit even after reducible history is removed.
- Opaque Native compaction state for which this Web operation has no verified
  readable representation. An encrypted item is not a readable checkpoint.

The input-only path cannot silently discard an opaque item and claim that the
previous context was preserved. It cannot decrypt it, retrieve private rollout
files, or borrow a different Native task's history reader. A supported, owner-bound
readable export or checkpoint is necessary for that missing context. Do not
reintroduce an external Native engine, private provider identity, automatic paid
Native summary, model fallback or multi-stage compression chain to bypass it.

## Stored history versus live execution

A bounded local prototype verified that the official app-server can return readable
stored items through `thread/items/list`, without a model turn or private rollout
access. This is a possible data source, not a live Desktop control connection.
Its `notLoaded` status belongs to the inspection process and cannot establish
Desktop idleness, permission to operate a task, or automatic-archive eligibility.

The supplied-request runtime now has a profile-fixed stored reader. It uses the
configured Desktop home and the official installed CLI for a disposable read-only
stdio connection; it never starts or resumes a model turn, subscribes to live
execution, mutates history, or exposes Native work tools. Only scoped indexed
`thread/read`, `thread/turns/list` and `thread/items/list` requests are permitted.

For an opaque first request, the existing visible-prefix projection keeps recent
complete exchanges and marks older originals as unsupplied. The existing Tela Chat
`read_context_history` capability reads those originals through the current Web
operation, with the existing bounded UTF-8 range format. Current instructions and
pending tool exchanges stay exact. The history control expires with that operation;
a warm retained page reuses its admitted context without another stored-history
read. No second compression pipeline, permanent history copy or retired handoff
helper is added.

Both profiles passed stored-source/readback probes without model calls. The
HTTP/MCP fixture proves scoped readback, control retirement and warm reuse.
Installed macOS build `2026111201` also completed a disposable long-conversation
fork using Web 6/Extra High: one exact prior-turn read returned 7,625 bytes, the
answer matched that turn, and the Desktop received the final response. The source
conversation was preserved.

This is not acceptance of a Native-free transition. The same trial first emitted
a Native `compaction` request lasting approximately 104 seconds; the subsequent
Web operation completed in approximately 40 seconds. No ordinary Native answer
turn was observed for the trial. Do not confuse the planner's zero Web preparation
model calls with zero official-engine compaction calls. The engine's pre-turn
model-selection/compaction boundary remains to be resolved through its supported
contract, without inventing a summary, raising limits to hide the trigger, or
restoring an external Native engine. An isolated run of the installed official
CLI reproduced previous-model compaction before the selected Web request, using
only synthetic responses and no real model calls. The current public turn-start
schema exposes the requested model, but no separate pre-turn compaction-model
selector was found. Ingress must not reject every Native compaction request or
pretend to have produced a checkpoint: those requests also serve legitimate Native
work.

A separate post-final stored-read RPC failure was observed; its relationship to
the completed trial is not established. Stored-read failures now retain a numeric
RPC error code in structural diagnostics. Detailed RPC error data uses the
existing bounded, opt-in private context-failure capture; it is never included in
the public error or structural log.

## Failures and diagnostics

Known context-recovery failures retain their existing content-free public code and
recovery contract in HTTP and late SSE errors. Unknown exception details stay
private. A supplied request must not replace all known recovery failures with a
generic error. Failure diagnostics record the planner stage and known history
recovery reason; opt-in private capture retains the small cause independently of
the request body so an oversized body cannot suppress both. Capture remains
bounded by its existing byte and age policy and does not change execution results.

A refusal before Web submission commits no browser task answer. Preserve the
original conversation and diagnose the exact failure before another experiment;
do not repeatedly replay the failed turn. Consumer recovery must describe the
actual supported choices rather than promise an unavailable history export.

## Acceptance scope

Installed macOS build `2026111103` passed real Web/Tela Chat reads followed by
Native command execution in the same `openai` conversation on both profiles.
Those short trials do not establish first Web use in every long Native history.
The earlier October long-history/readback acceptance used the former owner-bound
runtime; it is historical evidence, not proof of the current input-only path.
Old instructions to activate a Native handoff helper or select a private Tela
provider are not the current setup or recovery procedure.

Use a disposable fork to validate a long supported conversation, preserving its
original history. Prove the actual Web model, response delivery, context coverage
and any preparation cost separately. Retired private-provider conversations are
a different compatibility issue: preserve useful results and continue unfinished
work in a supported conversation without rewriting the old provider record.
