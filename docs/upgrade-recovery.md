# Guarded signed upgrade recovery

The ordinary signed upgrade now prepares source recovery automatically before
stopping services. It verifies the exact owned installed source and release key,
creates a clean signed snapshot in product-owned storage, then uses the same
recovering transition as an explicit operator request. Dry-run reports the source
origin without creating files. `--recovery-payload` and `--recovery-public-key`
remain available for an explicitly verified source/key (for example key rotation).
When the existing bounded `source` and `previous` recovery slots were signed by
*other* historical keys, supply each trusted out-of-band pair as
`--retained-recovery-key <key-id> <public-key.pem>` alongside the explicit
signed current source. This is not trust-on-first-use: the caller chooses the
external keys, and the shared recovery verifier validates every retained slot
and its receipt against that exact key before *dry-run* succeeds. Unmatched,
damaged, unknown, duplicated, or missing authority blocks both dry-run and apply;
never delete a recovery slot to make a different signature pass.
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

## Start completion

Update, repair, cancellation and installed service start share one completion boundary:
normal OS start followed by authenticated `ready` status from the expected install,
service and instance. An already running registration still requires this status proof.
Descriptor publication and endpoint startup may lag OS process creation; one bounded
observation budget covers both stages without issuing another start. Invalid ownership,
status identity or authentication fails immediately. A timeout keeps the existing
transition checkpoint outstanding; it does not report a completed restoration.
This observer runs only during an explicit lifecycle operation and adds no idle polling.
Service readiness does not prove that every profile's Web model has completed a request.

## Stop evidence

The source Codex service now exposes authenticated, on-demand shutdown readiness
separately from ordinary `ready` health. It checks all owned Native app-server
loaded-thread metadata (never Legacy history pages) and each owned Web runtime's
new count-only activity endpoint with owner account-browser activity (no DOM
or screenshot). Unknown, incomplete or
active work blocks official shutdown. The service also blocks on unowned running
profile targets and in-flight routed Native tool operations, and rejects new
route admissions while an approved shutdown is underway. An unsuccessful service
stop reopens that route admission. Maintenance requires a complete optional
multi-profile target inventory; a provider outage cannot silently omit a running
profile as the ordinary UI inventory may. A service with no owned profiles and
no mounted tool routes can stop without inspecting an unrelated external app.
Pre-stop refusal returns the exact authenticated `shutdown:not-started` receipt,
which preserves the signed upgrader's cancellation boundary. Readiness is rechecked on the shutdown
endpoint, not inferred from a profile count. The packaged launcher requires an
explicit readiness receipt for Chat and Codex, while Gateway preserves its
separate contract. This is a source-level, conservative **idle admission** gate:
it cannot authorize pausing the one currently requesting maintenance turn.
That requires an authenticated exact-turn origin, host-supported durable
continuation, and a separately verified independent installer/restart path.
After the readiness snapshot, the service closes routed-tool admission and
rechecks its in-flight count before any profile stop. A tool accepted in the
intervening interval returns an exact typed `shutdown:not-started` receipt,
and normal admission is restored. Later child-cleanup errors are uncertain
and never borrow that receipt.
Do not claim this source addition is installed merely from local tests.
As the external Native engine remains free to start turns while being inspected,
an on-demand readiness snapshot is not an engine-enforced atomic no-new-turn
freeze; production automatic in-turn upgrades remain disabled.

The default Desktop target settles canonically proven active Native turns through the public
app-server protocol before asking Desktop to quit or closing its proxy/backend. Unproven active
history stops before the first app quit. Backend draining alone is insufficient: it can retain
the old conversation writer and leave a reopened app reporting ownership by another app.
Service shutdown and explicit replacement also request this same work settlement for owned
multi-profile targets. A replacement Desktop never inherits the previous process ownership.

Codex profile shutdown first obtains a successful, authenticated cleanup receipt
bound to the exact profile and Responses route. Only then may the controller
unmount the route, release supervision, and require a successful child exit.
Cleanup refusal leaves the control endpoint and owner available; it does not
acknowledge daemon shutdown. Concurrent requests share the same cleanup, and a
lost acknowledgement can read its completed receipt without repeating quit.
The Codex HTTP acknowledgement consumes the existing service shutdown budget.

On macOS, the LaunchServices `open -W` process is a launcher, not the app.
Normal quit waits for the exact owned application PID to disappear and preserves
replacement processes. A normal Desktop quit timeout fails instead of escalating
to a forced quit. An owned Native backend receives at most one stop signal, with
no forced-exit escalation on retry; POSIX engines may drain after that signal.
Windows backend termination follows Node's process contract and does not prove
POSIX-style draining. Startup rollback is a separate cleanup path. These source
contracts require installed, real-OS acceptance before release claims.

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
