# Web approval boundaries

Keep approval UX simple: an approval card is a **pending human decision**, not
a failed task. Tela does not invent permission from model text, card prose,
profile-wide counts or a stale browser observation.

## Two independent scopes

- **Host approval before Tela ingress:** ChatGPT owns the permission dialog
  and decision. Tela cannot inspect, approve or bypass it. An absent local
  tool event does not establish which host decision occurred.
- **Tela-owned Web approval:** the current authenticated Web turn may expose a
  card in its owned browser. The user can inspect/act through the official
  browser UI. A read-only profile preview cannot prove the card belongs to a
  specific Native thread.

## One decision path

Automation defaults to `off`. Explicit `full_access` enables the existing
turn-owned selector: exactly one recognizable card with one Deny and one
unambiguous scoped Allow choice. Prefer **Allow for this conversation**,
then **Allow once**, then the sole generic **Allow**. The browser driver
checks the same current card, target, owner and single-click admission
immediately before input. Indeterminate click results are never replayed.
A different, uniquely owned card may be activated without waiting for
the previous card's assistant text to change. Input receipt, card clearance
and task progress remain diagnostic observations, not cumulative admission
limits. The same card is activated at most once. Unknown choices are left
for the user, not treated as task failures.

No agent-facing second policy classifier, repeated screenshot capture or
30-second/two-minute/five-minute revalidation is needed. In particular,
a card remaining pending for ten minutes **does not terminate the Web turn**.
The existing browser event observation waits for user action or actual
assistant progress. An explicit user cancel, Native owner cancellation,
or separately configured Web-turn deadline can still stop the operation.
Neither waiting nor cancellation authorizes a new send.

## Inspection and recovery

`inspect_native_work` uses the owned service's public Native metadata plus
bounded event stages. A profile-level `approvalState` and a current optional
`approvalWait` provide limited UI context, not an approval grant. Diagnostics
record structural transitions only, without prompts, card text or credentials.
If an accepted send is indeterminate, inspect the **same** operation; never
replay it because a card disappeared or because its status is unavailable.

## Signed local deployment and remaining acceptance (2026-10-18)

The cross-card cumulative verification gate was removed in source commit
`92ecb41` and included in the owner-verified signed macOS installation
`0.0.0-approval-sequential-20261018.5aca459.1`. The 273 focused
approval/provider/DOM tests passed on source `5aca459`. The installed
Gateway, Chat and Codex services were authenticated `ready`; both
owned profiles were Web/Native `ready`.

Two separate, **single-tool** live Web-to-Native-to-Web tests completed,
one per profile, with actual result witnesses and same-turn final answers.
Both synthetic Native threads were officially deleted and proved absent.
Their structural diagnostics recorded **zero approval cards**. These
tests establish installed tool-result/final-answer acceptance, **not**
acceptance of consecutive distinct `Allow once` cards. Continue
ordinary use and capture the next naturally occurring owner-bound
multi-card example before claiming that last approval path live-proven.
Do not create additional writes, bypass a card or replay an uncertain
submission merely to force a test.
