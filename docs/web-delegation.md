# Separate Web tasks

The initial source CLI can run a bounded, read-only task on a connected Tela Work profile without
changing the model of an existing conversation or exporting its history. The Native engine creates
a new durable, paginated thread and supplies its own tool/sandbox authority; the existing Web
provider performs inference. This is not an independent Tela Chat worker or an API-key fallback.

## Source CLI

These commands require an already installed, owned Tela Work runtime and a matching signed-in Web
profile. They do not start, update or restart services. The default profile is used unless specified.

```sh
bun run cli web-delegate catalog
bun run cli web-delegate start --cwd /path/to/project --prompt-file /path/to/task.txt
bun run cli web-delegate status --job UUID
bun run cli web-delegate reconcile --job UUID
bun run cli web-delegate result --job UUID
```

`start` prints a job ID early and observes completion through the existing event connection.
The caller can finish its own model turn instead of repeatedly asking whether the worker is done.
Waiting in this process does not invoke a language model. The Web worker still uses inference while
doing its task; preparing and reviewing a task also consumes the calling model's tokens.

`status` reports persisted observations, not proof that an engine is still running. `reconcile` reads
only the acknowledged job's newest turn using bounded public paging, rechecks its owner and stores
a proven final result. Both live collection and reconciliation require an explicit final-answer phase;
phase-less promises and commentary are not results. A completed execution is reported separately from
requested-task success (`taskOutcome: unassessed` until an explicit outcome contract exists). An explicit
final failure/partial/blockage report must not be counted as task success. Older records without final
evidence cannot be returned as verified results. It never sends the prompt again. Lost creation/submission acknowledgements
without an exact turn identity remain uncertain and require inspection.

Tool counts describe observed supported Native items, including collaboration calls. Their coverage
is reported as live events, limited history summary, or unverified for older records. Zero is never
proof of no execution: summaries can omit tools and child-agent activity has separate ownership.
History recovery preserves already observed counts rather than replacing them with summary zeroes.
The final answer is delivered from an explicit final-phase message, or from
the **only** unphased assistant message in an exactly completed Native turn.
Commentary and multiple ambiguous messages are not guessed into a final;
task success remains unassessed either way.
The separate `toolResultItems` count requires bounded result-bearing completed Native tool
items, without storing their command, output or arguments. It is evidence of returned tool
results, not proof of their contents, success of requested effects, or Web semantic use.

The selected model comes from the current complete Web catalog. The isolated release-label policy
selects the highest unambiguous numeric release, prefers Extra high, and permits High only on that
same model. Unknown naming, tied releases, missing efforts or incomplete catalogs fail before Send.
Actual browser selection and readback reuse the normal Web model routing implementation.

Job records and results are private product data under the Codex service state directory, with
restricted filesystem permissions. A hard capacity of 64 records bounds storage; it does not
silently discard results. Do not put these records, prompts, keys or results in a repository or
release. This first version does not yet provide a complete removal lifecycle.

## Browser and permissions

The existing Work activity session picker and Open browser/Interact controls show an owned Web
surface. Closing its viewer normally hides the window; it does not cancel inference. Quitting the
Electron runtime is different. A job-to-surface identity contract is still needed before the product
can offer an automatic per-job browser button. Do not infer that identity from window titles.

The initial execution requests and verifies a read-only Native sandbox with approval policy never.
That policy does not replace the ChatGPT connector's own approval UI or grant external apps write
permission. Do not treat prompt instructions as a filesystem or MCP security boundary.

## Remaining product work

- Durable completion delivery and a result inbox; native automatic wakeup requires a supported host contract.
- Exact cancellation, unknown-ACK reconciliation and owned removal of job/engine resources.
- A structured task specification, bounded file evidence and stale-result detection.
- Exact job-to-browser association and reliable one-shot approvals.
- Consumer UI, installed Windows/Linux acceptance and broader platform verification.
- Write tasks confined to a separately owned worktree, with explicit scoped permissions, change review,
  validation and cleanup. Existing user checkouts and other agents' work must remain protected.

The source CLI and a useful real read-only Web task have been exercised. These facts do not establish
that the entire product workflow, restart durability or write-task support is finished.

## Test-only live round-trip receipt (2026-10-18)

`packages/codex-service/src/web-native-roundtrip.integration.ts` has an opt-in
`--preflight` that creates and officially deletes an exact new empty Native
thread, proving absence before any model call. The separate `--acceptance`
attempts only one read-only Web turn in a new disposable Git repository and
checks a random local marker in the Web final and in a same-turn Native tool
result. Every acknowledged test thread receives at most one official Delete
request; uncertain cleanup retains its local journal for inspection.

In an earlier installed Profile 1 attempt, preflight passed (zero model requests, one exact
Delete/absence). One real Extra High Web request produced an exact-marker
final answer and one Native tool item. Its public Native summary did **not**
independently prove the result payload, so strict same-turn result acceptance
**failed**; the acknowledged synthetic thread was officially deleted and
its absence verified. A subsequent fresh attempt refused before a model
request because one Web surface remained active. That surface's ownership
was not established, so it was not closed. Live events with content-free
result witnesses are now included in the fixture for a later independently
authorized acceptance; no uncertain or retired turn was replayed. This is
not evidence of opaque Legacy-context continuity or an installed new release.

Profile 2 also passed an actual one-request Web/Native-tool/final round trip:
the completed Native command result and same-turn Web final matched a random
disposable-file marker. All synthetic threads were officially deleted and
proven absent; no personal conversations were read. The test-only script's
`--slot 1|2` option does not change normal production behavior.

### Post-upgrade acceptance, same date

After deploying the signed local macOS version
`0.0.0-approval-sequential-20261018.5aca459.1`, both profiles passed
independent preflights: each created one empty synthetic Native thread,
officially deleted it, and proved exact absence without a model call.

Both profiles then passed **separate** one-model-request, read-only
`web-native-roundtrip.integration.ts --acceptance --slot N` runs. Each
recorded one completed Native `commandExecution` item with a live
result carrier containing the test-only random marker, an explicit
Web final answer containing that marker, and proof that both belonged
to the **same Native turn**. The tests read no personal threads and
officially deleted all acknowledged synthetic threads, verifying absence.
These later successes supersede the *earlier* Profile 1 failure for
this **one-tool round-trip acceptance** only; they do not establish
opaque Legacy-context continuity or arbitrary write tasks.

Both tests used a Native read-only sandbox with approval policy
`never`. The separate structural diagnostic windows contained
**zero approval cards**; therefore the installed fix for consecutive,
distinct Web approval cards remains **source-tested and deployed, but
not live multi-card accepted**. Do not report it as proven from these
round-trip results.
