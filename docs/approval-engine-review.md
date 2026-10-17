# Approval engine review

Baseline: Tela `83e0508`; reference upstream
[`8645a89e6a5fbe011e1bfbb0821a386ca7477ad5`](https://github.com/miuuyy/codex-chatgpt-web/blob/8645a89e6a5fbe011e1bfbb0821a386ca7477ad5/src/adapters/chatgpt-web/browser-worker.ts#L969), reviewed 2026-10-18.

| Boundary | Upstream | Tela after this change |
| --- | --- | --- |
| Discovery | Dialog/testid/data-codex surface, exact connector heading | Marked provider card or connector-owned accessible dialog; nested wrappers deduplicated with warnings retained |
| Choice | Unique Allow/Allow once plus Deny | Exact preferred conversation/once choice; generic Allow only with connector heading; auxiliary controls do not veto |
| Menu | No equivalent scoped-menu proof | One-use disclosure, unchanged card, unique linked menu; button/menuitem controls deduplicated |
| Input | Playwright actionability/click | Existing host trusted pointer, current owner/revision, scroll, viewport/hit test, one-shot fence |
| Success | Card hidden | Trusted receipt, clearance, owned assistant progress; Native tool result remains independent |
| Repeat | No count cap | One unresolved dispatch blocks another; verified approvals unlimited |
| Wait | 60 seconds then Deny | 30-second/two-minute progress, five-minute revalidation, ten-minute local retirement and bounded public Stop; no automatic Deny/replay |
| Warning | No separate classifier | Human security review, separate platform authority |

Upstream [DOM tests](https://github.com/miuuyy/codex-chatgpt-web/blob/8645a89e6a5fbe011e1bfbb0821a386ca7477ad5/tests/tool-approval-dom.test.ts)
and [worker contract tests](https://github.com/miuuyy/codex-chatgpt-web/blob/8645a89e6a5fbe011e1bfbb0821a386ca7477ad5/tests/browser-worker-contract.test.ts)
are behavioral references; no implementation dependency or copied runtime was added.
The upstream DOM suite requires an explicitly configured browser and may skip.

## Complexity and expected effects

Reproducible lexical counts (`if (` tokens and `&&`/`||`, not cyclomatic complexity):

| Scope | Lines before/after | if before/after | logical operators before/after |
| --- | --- | --- | --- |
| Pure policy | 113 / 103 | 9 / 9 | 14 / 3 |
| Renderer approval inspector | 288 / 298 | 47 / 48 | 108 / 107 |
| Evidence/wait observation | 156 / 191 | 21 / 26 | 22 / 37 |

The pure policy's auxiliary-count conditions and duplicated preparation policy
were removed. Candidate discovery, warning scope, explicit Stop and expiry add
necessary lifecycle work; total code did not simply shrink. No new dependency,
model call, retry loop or context reconstruction path was introduced. The
previous constant and compatibility alias for the eight-dispatch budget were
removed; the existing public review category remains wire-compatible.

Synthetic renderer fixtures demonstrate acceptance of auxiliary controls,
missing Deny, connector-owned dialogs, native button/menuitem overlap and nested
wrappers. They also reject changed/duplicate/disabled/occluded targets and wrapper
warnings. Fake clocks cover unchanged-DOM milestones, clearance immediately before
expiry, expiry racing a snapshot/preparation, public cancellation and late input. One operation-owned expiry remains active
through card disappearance without task progress, unresponsive handoff observation
and a caller that stops consuming progress. All retirement paths clear that timer.
These establish specific previously rejected structures; they do not measure
account-backed approval success rate, provider billing or final user task success.

The accepted-user identity rejection still requires evidence. Historical renderer
stall followed by input revocation and fingerprint mismatch is temporal
correlation; it does not prove a real request edit or a DOM extraction defect.
Exact author/lineage fencing remains in force. Fresh Stop proof reuses that same
ownership rule and current author digest, rather than trusting stale turn keys.

## Shared consumers and remaining acceptance

The provider/runtime fix applies to compatible owned Native/Web Work turns and
Web delegation using the shared browser-turn runner. Ordinary Chat platform cards
remain host-controlled. Tela Chat development capabilities do not acquire Native
turn authority. Existing retained task/epoch sessions, suffix transfer and
checkpoint receipts are unchanged; uncertainty never triggers cold replay.

Installation readiness, renderer fixtures, actual provider cards, Native Stop UI,
public-progress rendering and final result delivery are separate acceptance
claims. Use a disposable owned test chat with a verified official cleanup route
for account-backed tests; never use an original user conversation or retry an
accepted uncertain request. Windows/Linux source support does not establish real
packaged or account-backed acceptance on those systems.
