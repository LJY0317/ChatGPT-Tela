# Guarded signed upgrade recovery

The independent packaged launcher supports an upgrade with a verified source
artifact, using `--recovery-payload` and `--recovery-public-key` together.
These operator inputs are also checked by dry-run before stopping services.
The ordinary upgrade contract is unchanged when recovery inputs are absent;
it does not promise automatic source restoration. Consumer updater integration
must supply and retain owned signed artifacts without requiring manual setup.

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
services being updated. A recovery coordinator must retain a single installation
owner and reconcile its durable checkpoint before restart; a second process
must not take over an unknown live owner. This patch does not supply an OS
watchdog or general coordinator ownership protocol.

## Stop evidence

Supervisor admission, stop request and process-exit wait consume one deadline.
Descriptor loss is not process exit. An old process exiting cannot remove a
replacement instance's descriptor. The platform controller observes the exact
service registrations whose stop it requested, within their original budgets;
settlement never sends another quit request. After a crash, unknown stop
requests cannot be declared settled by an empty process-local observation map.

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
active work, prove independent coordinator ownership/crash resume, and verify
previously intended profiles separately after service restoration. Native/Web
readiness and account binding require their own receipts. A remaining user
popup must never be automatically clicked to satisfy an installation gate.
Nonblocking proactive notices and consented external-popup observation remain
separate work. Windows/Linux OS-level live restoration is not proven by fake
platform runners on macOS.
