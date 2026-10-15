# Guarded signed upgrade recovery

The ordinary signed upgrade now prepares source recovery automatically before
stopping services. It verifies the exact owned installed source and release key,
creates a clean signed snapshot in product-owned storage, then uses the same
recovering transition as an explicit operator request. Dry-run reports the source
origin without creating files. `--recovery-payload` and `--recovery-public-key`
remain available for an explicitly verified source/key (for example key rotation).
An unsigned source or source lacking the signed cancellation protocol is refused
before shutdown; the client never silently falls back to an unprotected update.

## Recovery storage

One registered state directory contains fixed `source`, `previous` and `pending`
slots. A bundle holds clean payload bytes, a receipt bound to the install and
source fingerprint, and a retained public key. Release authority is still supplied
externally: the cached key is checked against that authority and is not implicitly
trusted. No development checkout or agent workspace is needed for restoration.
Data-preserving removal retains these receipts; complete removal owns their cleanup.

Snapshot publication uses verified bytes and same-filesystem renames. Interrupted
copying is discarded/rebuilt only under the owned staging intent, while no upgrade
journal exists and the source is proven again. Interrupted publication can reuse a
complete matching slot. Changed signatures, unknown files/ownership or a conflicting
journal are preserved and block mutation. Storage is bounded to the fixed slots;
there is no idle retention timer or model/network retry. Process-interruption tests
are distinct from power-loss guarantees and OS-level installed acceptance.

## Failure boundary

`applySignedPackagedUpgradeWithRecovery` verifies both target authority and a
restoration artifact matching the exact installed source version/fingerprint.
It reuses the existing signed cancellation journal and service controller.

- Before replacement: cancel/restore only after stop settlement is proven.
- Uncertain shutdown: preserve the journal and report `settlement-required`.
- After replacement: report `signed-resume-required`; never restore old files.
- Restoration failure: retain `restoring-source` for reconciliation.
- Successful restoration: report `source-restored` as an **upgrade failure**,
  not successful target installation. Restore only prior running services.
- Interrupted pre-replacement transactions reconcile restoration without
  repeating quit. Unknown prior stop ownership remains blocked.

No new daemon, model request, forced kill, UI click, journal deletion shortcut
or authority transfer is introduced. The launcher must run independently of
services being updated. Initial install, upgrade, repair, signed cancellation, removal
and installed service controls share a product-owned SQLite writer lock
across the entire operation, including awaits and restoration. An OS process exit
releases this lock; no stale-age/PID takeover or heartbeat is used. An existing
transition journal is still reconciled by the signed recovery boundary, never
removed or replayed merely because the lock became available. The coordination
directory is registered in the install manifest and follows normal data-preserving
or complete removal policy. This does not serialize external platform commands or
original ChatGPT actions; there is no OS watchdog.

## Removal and finalization

A removal checkpoint protects the namespace before shutdown/resource changes and
remains visible while the coordinator database closes, its directory is removed
and the install manifest is removed. Install, update, repair, cancellation and
installed service launch/control refuse this checkpoint. This closes the interval
where deleting a lock file alone could admit a new installer. Read-only inspection
does not create state.

Only final metadata cleanup may resume after its former process is proven absent;
PID reuse or inaccessible liveness conservatively blocks takeover. A tiny exclusive
finalization claim prevents competing cleanup. Unknown abandoned claims, unexpected
files, ownership drift or interrupted service/resource removal remain protected for
inspection: the client does not guess or replay shutdown. A normal data-preserving
removal retains the coordinator; complete removal deletes it after database close.
An owned directory enclosing active coordination metadata is preserved rather than
recursively deleting the live authority boundary.

Fixtures use a fake service-registration runner and disposable identities. The
compiled lifecycle fixture proves install, failed update/source restoration, a
successful update and complete removal while preserving external synthetic data.
On macOS the compiled fixture uses the same normal ad-hoc signing/verification
procedure as package smoke; no security setting or existing app is changed.

## Stop evidence

Supervisor admission, stop request and process-exit wait consume one deadline.
Descriptor loss is not process exit. An old process exiting cannot remove a
replacement instance's descriptor. The journal writes a service stop intent before sending it, and clears that
intent only after the controller acknowledges completion. A fresh coordinator can
restore at an acknowledged boundary without replaying quit. A pending or older
unproven intent still requires actual stop settlement; an empty process-local map,
service descriptor disappearance or elapsed deadline cannot authorize restoration.
The controller observes exact requested registrations within their original budgets.
No new quit request is sent during settlement.

JXA zero-argument Objective-C calls are property evaluations. Exactly one
`app.terminate` produces the Boolean request receipt. Parentheses can invoke
quit and then throw a TypeError. Request acceptance does not prove app exit or
permission to accept the app's active-chat warning. Late user choices involving
an original external app are not automatically resolved or cancelled.

## Verification and rollout gates

Synthetic signed installations use a fake service-registration runner. Cases
cover restoration, unknown settlement, untrusted source, post-replacement
failure and interrupted restoration without a second stop. Benign real child
process tests prove slow exit and replacement-descriptor preservation. A
synthetic Objective-C object tests the actual macOS bridge without app actions.
Decision observations distinguish unavailable, empty and stale evidence.

Source tests are not a real installed upgrade acceptance. Before rollout,
combine the current owner's source and diagnostic patches, preserve drafts and
active work and verify independent installed recovery. Previously intended profiles,
Native/Web readiness and account binding require separate receipts after restoration. A remaining user
popup must never be automatically clicked to satisfy an installation gate.
The proactive Web reconnect notice is now a modeless owned AppKit window;
an unanswered notice does not enter a modal run loop. Exact button/close events
record one accepted/deferred decision, and only an explicit accepted decision
calls the existing PID-bound reopen path. This does not observe or approve an
external ChatGPT Quit warning. Modeless-window live acceptance and consented
external-popup observation remain separate work. Windows/Linux OS-level live restoration is not proven by fake
platform runners on macOS.

## Included failure diagnostics

The candidate combines Native capacity/HTTP200 streamed failure diagnostics,
model route/picker proof, bounded tool refusal signals and incident-window evidence.
Provider codes classify overload, usage and rate limits; provider retry hints are
recorded only when actually supplied. Unknown codes, absent receipts and external
host failures remain unproven. No automatic model resend or switch is introduced.
See [diagnostics](diagnostics.md) for bounded capture and privacy rules. These
source changes are not evidence that the installed client emitted the new events.
