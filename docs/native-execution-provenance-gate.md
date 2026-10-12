# Native execution provenance and tool-free fork gate (engine request)

**Status: required upstream public Codex capability, not an implemented
endpoint, executable permission, available model certificate or production
rollout.** The previously inspected Native Codex 0.159.0 public contract did
not provide the two engine-owned proofs below, and the newer locally callable
0.162.1 schema inspection below did not establish them either. Tela must not reconstruct the
user's old Legacy transcript, guess a historical model, call a new Native
model or reuse an automatic derived checkpoint to compensate.

## 2026-10-12 follow-up: locally callable Codex CLI 0.162.1

The user-local executable `~/.local/bin/codex --version` reports
`codex-cli 0.162.1` (rather than the `0.159.0` recorded at the preceding
checkpoint). This establishes the callable executable version **only**: it
does not establish the version of the Native engine to which the running
Tela Codex service is connected, nor any installation/update acceptance.

Generated the **experimental public protocol schema** with
`codex app-server generate-json-schema --experimental --out <temporary-dir>`;
the generated schema was inspected without connecting to a Native thread,
reading rollout history, forking, or starting a model turn. In this schema:

- `v2/ThreadForkParams` has `threadId`, `lastTurnId`, `ephemeral`,
  `excludeTurns`, `deferGoalContinuation`, `model`, `modelProvider`,
  `sandbox`, and `approvalPolicy`. These are fork/request settings, **not**
  attestations of the original turn's actually executed model/provider or
  of a no-tools capability boundary.
- `v2/ThreadForkResponse` includes `model` and `modelProvider`, but they
  describe the fork response, not a durable segment-by-segment record of
  historical effective execution.
- `v2/TurnStartParams` provides `model`, `sandboxPolicy` and
  `approvalPolicy`; no public pre-execution engine-enforced no-tools fork
  policy is exposed by these request parameters.
- `v2/ThreadReadParams` exposes `includeTurns`; the public description
  continues to recommend metadata-only reads and paginated turns/items.
  This is not evidence that old Legacy rollout paging has become bounded.

Neither required engine-authenticated historical effective execution record
nor the owner-bound, pre-execution all-tools-disabled fork certificate was
identified in these public request/response shapes. A generic occurrence
of the words *provenance* or *attestation* elsewhere in the protocol does
not satisfy this exact contract. **Production automatic handoff remains
default-deny.** Recheck the runtime's actual service/engine version and any
future documented exact RPC contract before changing this conclusion.

### Repeatable public-contract inspection (schema-only)

Tela now includes an on-demand probe that invokes only the official Codex
`--version` and `app-server generate-json-schema --experimental` commands
with a disposable, empty `HOME` / `CODEX_HOME` and without inherited
credentials. Run it with the exact CLI executable being evaluated:

```sh
bun run codex:continuity-probe --codex /absolute/path/to/codex
```

The structured output reports public method inventory, whether thread status
contains an exact current-turn identifier, which fields are exposed on the
`contextCompaction` item, and whether fork parameters advertise any tool
control options. It also lists *candidate* future method names for review.
On Codex CLI `0.162.1`: 170 methods, `contextCompaction` exposes only
`id`/`type`, active status exposes only `type`/`activeFlags`,
the thread model explicitly is **not** per-turn execution telemetry, and
`thread/compact/start` is a **mutating trigger**, not a readable context
certificate. All four required evidence gates remain `not_proven`.

**Crucially:** inspection success is not feature readiness. Neither naming
matches nor optional request fields can prove server-side Legacy resource
bounds, historical effective execution, atomic source revision, or a
pre-execution no-tools engine policy. The probe unconditionally reports
`productionAutomaticHandoff:default_deny`; the product does not use its
report as an execution permission. Real owner-authorized upstream and
installed-product acceptance remain separate.

## Preferred upstream path: bounded original compaction context, no extra model

For the 73 MiB Legacy use case, the first choice should be an **engine-owned,
owner-authorized, bounded export of the current Native model-visible task
context**, when such a durable source exists. This avoids both reconstructing
the complete historical rollout and starting a second Native model turn.
Current Codex 0.162.1 has **not** advertised this as a callable public RPC.

The required *new* engine contract, not a Tela-inferred compatibility alias:

- Bind one read-only query to the exact authenticated current thread/turn,
  account, compaction lineage and source revision **atomically inside Native**.
  The response represents only context that the Native engine itself can
  attest as the currently active, original source; a UI title, Goal, model
  selection, partial item page or Tela cache is not a substitute.
- Return a separately indexed, strictly size-limited **readable compaction
  checkpoint or complete bounded model-visible task summary** with canonical
  source anchor and content digest, or typed `unavailable`. It must state
  explicitly whether original pre-compaction evidence is omitted. Opaque
  encrypted state alone is not transferable to the Web model.
- Enforce the bound **server-side before** parsing/replaying a 73 MiB Legacy
  rollout. If a historical Legacy checkpoint was never stored in such an
  index, reply `unavailable` instead of promising recovery. The public
  `thread/timeline/list` experimental schema and `thread/turns/list` page
  limits do not prove this property for Legacy.
- Carry no command, file, network, MCP, approval or model execution authority.
  Import only lower-priority Web task guidance; original tool/file evidence
  remains unavailable until independently verified through authorized Native
  tools. Do not modify, fork, compact, cancel or replay the original thread.
- Expose an exact owner/revision invalidation result for races, not only
  separate before/after metadata samples. Never reuse derived Web summaries
  as substitutes for the Native source proof.

**Acceptance:** an isolated 73 MiB-equivalent Legacy metadata fixture must
obtain either one bounded canonical source or `unavailable` with zero
unindexed pagination, full-history hydration, fork, `turn/start`, tool call
or original-thread mutation. Source-digest/owner/revision changes must
invalidate reuse. These are specifications for upstream implementation and
later installed acceptance, **not** claims about current Codex. If unavailable,
keep the existing 422 `continue_on_native` outcome.

Only when this read-only path proves unavailable should the more permissive
model-backed fork proposal below even be considered, and that separately
requires both engine certificates and user consent.

## 1. Historical executed-model/provider provenance

Tela needs one **bounded, read-only, authenticated** engine query for the
exact *completed* source turn and its compaction lineage. Proposed upstream
shape (illustration only; this RPC does not currently exist):

```ts
// Proposed, not callable in the currently installed app-server.
type NativeExecutionProvenance =
  | { status: "unavailable"; reason:
      "not_recorded" | "legacy_unindexed" | "not_completed" |
      "not_authorized" | "lineage_unavailable" }
  | {
      status: "engine_attested";
      threadId: string;
      turnId: string;
      completed: true;
      source: "canonical_native_execution_record";
      evidenceRevision: string;
      segments: readonly {
        sequence: number;
        effectiveExecutedModel: string;
        effectiveProvider: string;
        // Also distinguish a reroute from the initial requested model.
        requestedModel?: string;
      }[];
      compaction: {
        state: "none" | "opaque_compacted";
        sourceTurnId?: string;
        formatVersion?: string;
        sourceBoundStateDigest?: string; // digest only, never encrypted content
      };
    };
```

The Native owner must enforce the thread/turn capability **inside the
engine**; knowing an ID, observing a UI model picker or holding a cached
Tela projection is not sufficient. The query must use an engine-indexed
record and a strict server-side resource bound without reconstructing a
73 MiB Legacy rollout. Include every effective execution segment if
routing changed. The evidence revision must be bound to the completed
source turn and cannot be rewritten by a newly made fork.

None of the current public values below is equivalent to this proof:
`thread/read.thread.model`, `thread/fork.model`, a model catalog
default, `turn/start.model`, a request's model string echoed in a Tela
Responses envelope, or an isolated `model/rerouted` notification without
a complete durable execution record.

If historical data was never recorded, the honest result is
`unavailable`, not an invented provider or a newly selected model.

## 2. Engine-enforced no-tools source fork

Even a proven historical executed model is **not permission** to run an
extra Native turn. The engine must separately attest, *before any model
work begins*, that an owner-bound ephemeral fork:

- Inherits only a proven, compatible, exact completed source turn and
  compaction state; it cannot copy the current in-progress Web turn.
- Does not grant or expose command, file, network, external MCP, built-in
  tool or delegated agent execution capabilities. `sandbox=readOnly`,
  `approvalPolicy=never`, a prompt saying “no tools”, and rejection of
  later tool notifications are **not** equivalent to this guarantee.
- Has no inherited active Goal, task continuation, background child,
  pending approval or unaccounted execution work. Cancellation applies
  only to the fork; the original Native turn remains untouched.
- Supplies proof of an exact source owner and consent for this additional
  model invocation. No account ID, credential or raw content is returned
  through a Chat-visible log.

Both proofs must be verified together by the official Native service
owner before the *first* extra `turn/start`. Partial or unknown support
must fail closed. A cached derived summary can never replace the proof.

## Deterministic acceptance required before enabling product callbacks

1. An old Legacy thread without a durable engine index returns
   `unavailable` **before any** `thread/turns/list`,
   `thread/read(includeTurns:true)`, fork or model request.
2. A completed Paginated turn returns engine-origin model/provider
   evidence; a configured model, model reroute, changed owner, revoked
   permission, wrong turn, incomplete segment list or changed
   compaction lineage is distinguishable and rejected.
3. A missing or unsupported pre-execution no-tools policy refuses the
   request *before* the engine can create a model/tool/Goal operation;
   cancellation and diagnostics do not expose original source details.
4. A supported owner-approved read-only fixture creates at most one
   forked model turn, never on the original, with durable source
   re-verification and a full failure/rollback path. This synthetic
   result is not by itself evidence of support on a signed installed app.
5. Only after separate signed-install and real owner-authorized
   acceptance can Tela add production callbacks. Until then the normal
   product omits them; the resolver requires the explicitly named
   `unsafePermitModelToolsInIsolatedSyntheticFixture` for its internal
   tests, and the standalone fork adapter defaults to deny before RPC.

Current fallback: preserve the original Native conversation, continue
there, or use a separately verified *indexed* user-requested manual
handoff. An unindexed Legacy public page cannot safely bootstrap Web.
Do not infer that installing a new Tela version or adding synthetic
fixture fields repairs old historical model provenance.
