> Historical design notes. The implemented three-task, per-worktree writer policy and continuation contract are documented in [Web delegation](web-delegation.md). Older reader/writer limits below are superseded.

# Turn interruption attribution and Web delegation capacity plan

Status: design and implementation plan; no new attribution or concurrency scheduler is claimed by this document.

## Present evidence and limits

The HTTP host already emits `http_request_start`, `http_transport_closed`, `http_transport_error`, `http_request_observer_aborted`, `http_response_finished` and structural socket-write receipts. `close_source` distinguishes an observed request abort from a response close, and `reason_class=server_shutdown` identifies an observed local server stop. A client disconnect alone cannot distinguish a Stop-button click, tab/navigation close, host cancellation, network loss or a crash. Socket writes prove local writes only, not host rendering or receipt. The first failure can also precede Tela ingress; in that case no local event can reveal its cause.

The current read-only Web delegation store rejects the 65th retained JSON job with a storage-capacity exception. This 64-record ceiling is *not* a concurrency permit. No verified reader=2 or total=3 scheduler is established. The design target is one writer per verified profile, one writer per physical checkout, and a measured reader ceiling. Unknown writers are never released by timeout alone.

## 1. Interruption provenance

Introduce a bounded, append-only termination receipt emitted at the **authority that actually observes the action**, with monotonic sequence number and timestamps. Use a stable enum: `user_stop_confirmed`, `host_cancel_confirmed`, `owner_shutdown_confirmed`, `transport_disconnect_observed`, `network_error_observed`, `provider_failure_observed`, `runtime_exit_observed`, `unknown`. An explicit user-stop classification requires a trusted host control event with authenticated conversation/turn ownership and a matching cancellation acknowledgment; a generic AbortSignal or connection close is insufficient. Where there is only one half of that handshake, expose `user_stop_requested_unconfirmed` and keep outcome unknown. Do not infer intent from timeout, elapsed silence, or the text of a message.

Correlate host control, Native owner, Gateway ingress, HTTP observer, Web provider, tool lifecycle and final-response commit by scoped request/turn/operation fingerprints. Record the first observed termination reason separately from later cleanup and preserve ordered stage boundaries: UI stop requested, host dispatch accepted, Native cancellation requested, provider cancellation requested/acknowledged, tool execution settled, output commit or revoked, physical surface released. Each receipt states `observed_by`, `authority_scope`, `ack_state`, `local_effect_state`, `confidence=confirmed|partial|unknown` and event coverage. Never copy prompt text, browser content, raw paths, IDs, credentials or arbitrary exception strings into structural logs.

Project a single derived `terminationDiagnosis` in existing diagnostics `context`/`inspect` output, with `cause`, `evidenceStages`, `firstObservedAt`, `lastObservedAt`, `coverage`, `uncertainties`, and one next action. On absent host stop evidence, report 'client connection ended; cause unknown' rather than 'user stopped'. Check for local service restart and provider failure first; do not blame the user by default. Include dropped/truncated log coverage. Keep raw private evidence opt-in and retention-bounded. Missing old signals remain unrecoverable.

## 2. Capacity and admission contract

Create one authenticated, lightweight read-only `delegationCapacity` projection per verified profile and checkout. Fields: `profileFingerprint`, `observedAt`, `freshness`, `policyRevision`, `limits` (`writersPerProfile=1`, `writersPerCheckout=1`, `readersPerProfile=null` until measured, `totalPerProfile=null` until measured), `running`, `reserved`, `queued`, `uncertain`, `storage` (`retained`, `maximum=64`), `availableNow` as `yes|no|unknown`, `blockReason`, `nextAction`. Counts must come from an atomic reservation journal, not saved job records, browser tab counts or a stale snapshot. A disconnected status service returns `unknown`, never zero.

Use stable machine-readable admission outcomes: `CAPACITY_WRITER_PROFILE`, `CAPACITY_WRITER_CHECKOUT`, `CAPACITY_READER_PROFILE`, `CAPACITY_TOTAL_PROFILE`, `CAPACITY_STORAGE_RECORDS`, `OWNER_UNVERIFIED`, `UNCERTAIN_RESERVATION`, `SERVICE_UNAVAILABLE`, `AUTHORITY_UNAVAILABLE`, and `POLICY_NOT_CONFIGURED`. Return `limit`, `used`, `queued`, `retryability`, `queuePosition` when proven, `recheckAfter` only when supported, and a plain-language Korean/English explanation. Distinguish capacity saturation (a normal admission refusal), lack of authority, provider quota, and storage retention exhaustion. Do not turn an unknown state into a capacity refusal.

Admission must acquire a durable atomic permit *before* starting a model, browser or worktree. Preserve FIFO within compatible scopes and fair service between independently owned profiles. A queued job is inert. Transition permits through reserved/running/settling/closed with exact owner and ACK fencing; a cancelled queued job needs no provider cancellation. An uncertain active writer retains its permit until exact reconciliation proves a safe release. Never raise read-only authority to writer in response to shortage.

Expose capacity through the same typed error object in CLI, product Control Center and agent-visible tool response. For example: '프로필 2에서 읽기 위임 한도에 도달했습니다(2/2 실행 중, 1개 대기). 지금은 새 읽기 위임을 시작할 수 없습니다. 대기열에 추가하거나 작업이 끝난 뒤 다시 시도하세요.' Show such numeric limits only when a verified policy explicitly defines them. Otherwise say '읽기 동시 실행 한도가 아직 구성되지 않아 현재 가용성을 확정할 수 없습니다.' Storage full must say '보관된 작업 기록 64/64개' and point to an **owned, reviewed** cleanup workflow; never silently delete user results.

## 3. Delivery surfaces

For users, display one concise status row: 'Web delegation: 1 writing, 2 reading, 1 queued' when figures are available; otherwise 'capacity unknown' and the failing boundary. Selecting it opens a compact reason/next-action panel and optional diagnostics link. Keep per-profile counts and physical-checkout writer contention distinct. Agent tools get the same state and a stable code. Don't insert private profile identity or request payload in the response.

## 4. Build sequence and acceptance

1. Establish a trusted host Stop-button/turn cancellation receipt and correlate it with existing HTTP/Native events. Test user stop, tab close, network reset, server shutdown, tool interruption, provider failure, and client disconnect with deliberately absent upstream evidence. A Stop click must be confirmed only with matching host authority; ambiguous disconnect remains unknown.
2. Add the bounded on-demand `terminationDiagnosis` projection and prove event sanitization, first-failure preservation, truncated-log handling and no extra model/browser calls.
3. Implement per-profile/checkout admission journal and typed capacity result, including the distinction between concurrent permits and 64 retained records. Measure realistic read parallelism before assigning a reader default.
4. Wire CLI, Control Center and agent response to one common capacity projection and localized next action. Prove identical reasons across the three surfaces, queue waiting without prewarm, and that refusal performs zero model sends.
5. Exercise cancellation, restart, missing ACK, cross-profile fairness, writer crash and recovery. Verify permits are never double granted or released by elapsed time. Perform bounded real-profile acceptance on disposable owned tasks only; use official cleanup for exact test conversations and retain unknown work.

Success means a button-confirmed stop can be differentiated from a network disconnect with explicit evidence; where it cannot, the user sees 'unknown' and why. A saturated delegation admission must return a typed refusal with proven counts, scope and safe next action before any model work, with identical information available to the agent.
