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
Until trusted input, card clearance and owned assistant progress have been
observed, no second automatic card click is dispatched. Unknown choices
are left for the user, not treated as task failures.

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
