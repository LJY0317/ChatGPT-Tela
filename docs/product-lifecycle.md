# Product lifecycle

Installation, upgrades, service supervision, and uninstall are one ownership problem. ChatGPT Tela must be
easy to install without making itself difficult to remove later.

## Acceptance scope

Follow the [agreed implementation priorities](architecture.md#agreed-implementation-priorities).
A signed package, fake service-manager fixture or backend readiness result does not establish consumer
release acceptance. Keep source, candidate, installed and actually observed behavior distinct. Login and
consent remain explicit; first-install interaction cost is measured separately from ordinary startup.
Work/Codex preparation and Tela Chat recovery are independent completion criteria. DevSpace replacement
requires its own execution-recovery acceptance, even after a Work/Codex candidate is installed.

## Persistent format compatibility

Source packages declare Chat process-store read/write versions in their signed manifest. Lifecycle
planning/application, the post-shutdown replacement boundary and Chat startup check the existing
bounded physical store. Incompatible readers or format downgrades refuse without rewriting state.
The shared filename remains stable; the JSON header versions the format. Gateway/Codex startup does
not depend on Chat storage health. Missing metadata describes the original version-1 contract.

The signed fixture gate passed with a real Chat/native owner and fake OS registrations. A format
change during draining preserves the old payload and quiesced checkpoint; explicit cancellation now has a source gate described below. This is source acceptance, not installed OS restart, arbitrary
old-installer enforcement or a consumer rollback guarantee. No idle scan or state-content log is added.

## Starting services during a transition

After physical installed-payload, receipt and ownership verification, the source launcher admits only
recorded resume services at the final upgrade `manifest-updated` or repair `repaired` checkpoint.
Install identity, version, target fingerprint and quiescence records must match. Earlier phases,
unrecorded services and general/menu actions remain blocked. Journal reads are bounded to 16 KiB;
unsafe or malformed records refuse without granting launch authority. Chat storage compatibility still
applies independently.

The signed coordinator fixture invokes the actual resolver during upgrade and repair restart
(`build/transition-launch-admission`). OS registration and service payloads are synthetic; repair
shutdown is synthetic. This is source acceptance, not installed platform restoration or old-launcher
compatibility. Explicit pre-replacement cancellation now verifies a retained signed source package against the exact
installed source receipt, version, service definitions and current Chat store. A single
`restoring-source` journal records progress; already-running services are not started again, and only
prior running services are restored. Replacement phases cannot be cancelled. Interrupted restoration
must finish before another upgrade. The packaged source CLI exposes explicit `cancel-upgrade --dry-run|--apply` with a required signed
source package and external trusted key. A real blocked-input Chat/Native owner survives cancellation
with its original descriptor/registry and completes exactly once; the stopped synthetic Gateway
resumes through the actual resolver (`build/upgrade-source-cancel-live`). OS registrations/service
payloads and Gateway shutdown are synthetic. UI, actual OS restoration and old installed-launcher
support remain unaccepted; this source change is not installed.

Source cancellation requires a signed lifecycle protocol declaration (`transitionLaunch: 1`,
`sourceCancellation: 1`) from the exact installed source package. Missing metadata grants no support;
unsupported versions refuse before the restoration journal changes. The production builder declares
this protocol for the new launcher, and signature tests bind it to package bytes. Old-source refusal
and new-source restoration both preserve a real active Native owner (`build/upgrade-launcher-contract`).
The current installed preview has no such declaration; it was inspected read-only. This does not
retrofit old launchers. An old installation must finish its verified target upgrade rather than erase
its checkpoint to start services. A full production-built signed package and compiled fixture coordinator now restore the real compiled
Chat service while `restoring-source` exists, then complete authenticated shutdown and isolated removal
(`build/compiled-transition-boundary`). OS registration is fake; initial refusal and the abandoned
target are synthetic. Native engine was reused; owner activation remains off. The test package and
fixture binary were removed after recording hashes/metadata. Actual platform registration and production
CLI cancellation apply remain unproven; this fixture does not establish consumer release acceptance.

## Independence from original apps and optional providers

**Release invariant:** OpenAI's original ChatGPT Desktop/Native Codex app must
remain independently usable if Tela, Plura Desktop, both, or neither is
installed. Tela and Plura are separately installed and removed products, not
mutual prerequisites. Neither product owns the other's installation,
launch agents, browser partitions, authentication, user data or workspaces.

| Installed choice | Required owner and outcome |
| --- | --- |
| Neither Tela nor Plura | Original ChatGPT Desktop/Native Codex remains usable with its original state. |
| Tela alone | Mainstream default target uses Tela's built-in original-Desktop adapter; Tela never invokes a Plura executable. |
| Plura alone | Plura manages only its own explicitly owned targets; no Tela Gateway/Chat/Codex or Tela browser is required. |
| Both, no provider selected in Tela | Tela default remains built-in; Plura is independently usable and its failure/removal does not affect Tela's default route. |
| Both, Plura explicitly selected in Tela | Tela's built-in adapter still owns default slot 1; Plura owns only the selected additional managed slots (2+). Tela owns its separate Web/task/Responses routes. No slot has competing Desktop owners. |
| Remove Tela, keep Plura | Tela's exact owner-verified uninstall removes only Tela assets and any Tela-owned route lease. Plura and original app continue unchanged. |
| Remove Plura, keep Tela | First finish/disconnect any Plura-owned **additional** Tela targets. Default slot 1 stays on Tela's built-in adapter without reconfiguration. Extra managed slots become unavailable; explicit `configure` without the optional launcher may detach its stale reference. Never switch an active Native turn or take over another Desktop process. |
| Remove both | Apply each product's own owner-verified uninstall independently, preserving the original app, Native home/history and any user-owned repositories. |

Provider-unavailable **optional** selection is a typed target failure,
while the built-in default remains available. It is not evidence that an
unrelated app should be installed, started, shut down or uninstalled.
Plura's public launcher is an optional adapter:
Tela records a reference, not removal authority. Remove-data for Tela may
delete only Tela-owned profile/binding/cache state; it must never remove
Plura's or OpenAI's browser partitions, cookies or Native history.

**Acceptance evidence must be separate:** fake-OS ownership and uninstall
tests may establish source invariants; an installed Tela upgrade and service
readiness do not establish removal of both independent products. Before a
consumer release, exercise each row's install/start/stop/remove/reinstall
flows on a disposable supported host with separate original-app, Tela and
Plura ownership records. Verify the remaining app still starts and retains
its own data after each removal, plus original Desktop startup after both
are gone. The currently signed local preview has not passed that full
installed cross-product removal matrix.
An installed signed **Tela-only** `uninstall --dry-run` also enumerated
exact Tela service registrations, its own route lease, managed worktrees and
product binaries without treating Plura or the original app as an owned
resource. This is a planning observation, not installed uninstall/apply
acceptance. Actual removal of either/both products remains a separate
operator-owned acceptance exercise; production builds must not report it
complete from fake-OS tests alone.

## Product-owned resources

Every persistent resource created by Tela is recorded in one versioned ownership manifest with an install
instance id. The manifest records identity and intent, not secrets. Product-owned resources include:

- installed Tela binaries/application bundles and generated launch helpers;
- Tela Gateway, Tela Chat, and Tela Codex service registrations;
- product config/state/cache/log roots;
- bounded historical Chat review artifacts stored inside the Chat state root;
- Tela-owned ChatGPT browser profiles and account-binding metadata;
- Tela-created temporary/managed worktrees whose ownership can be proven;
- the exact Tailscale Funnel path lease created for the unified gateway;
- exact per-user platform credential entries created for optional provider integrations (identity only; never
  the secret value);
- local runtime descriptors and other generated integration files.

User project roots are **references**, never Tela-owned resources. Installing Tela inside or against a
workspace never grants uninstall permission to delete that workspace.

On macOS, registration names belong to the login session. Before changing a loaded service, Tela verifies
that its actual launchd definition resolves to the expected physical file; matching names and local markers
alone are insufficient. Lifecycle tests inject a service manager: a temporary home directory does not isolate
the operating system's service registrations.

Tela Chat keeps a separate locally approved-root configuration. Adding a root grants the Chat service access
to operate inside that root; it does not add the root itself to the ownership manifest. Removing Tela or
revoking a root therefore removes only Tela configuration/state, never the referenced project directory.

## Path layout

Platform adapters choose native locations, but each resource belongs to one explicit category:

```text
config/   durable user-selected product configuration
state/    durable Tela-owned runtime metadata and service state
cache/    disposable derived data
logs/     bounded diagnostics
runtime/  ephemeral pid/endpoint/credential descriptors
```

Tela Chat and Tela Codex receive separate subroots. They do not share mutable databases or recovery state.
Tela Gateway has its own small subroot. Removing/resetting one backend therefore does not require touching the
other backend's state.

The product-native `config/` root contains `product-v1.json`, the canonical secret-free runtime/exposure
configuration. This file is deliberately separate from ChatGPT browser-profile state. Source and signed
packaged services read only this product-native config boundary.

The same config root may contain `preferences-v1.json`, which is deliberately smaller than runtime config and
contains only user-facing behavioral preferences. Its first setting is approval automation (`off` by default,
or `full_access`) plus an optional bounded approval-delay preset from instant through 15 seconds. It
contains no endpoint, browser/account identity, credential, prompt, tool argument, or account-wide grant.
Previously saved enabled modes are normalized to `full_access`. Profile processes read the current preference
only when they start/restart.

Service diagnostics live under the platform-standard Tela logs root. Source supervision writes
`<service>.log.diagnostics.jsonl`; installed packaged services write `<service>.diagnostics.jsonl`. Both use the
same bounded payload-free event format and retain at most one rotated predecessor. The CLI diagnostics summary
reads only file metadata and deliberately omits absolute paths and event contents.

Each running service publishes a private mode-600 runtime descriptor containing only its install/instance
identity, PID, loopback endpoint, ephemeral bearer, and start time. Supervision reuses a descriptor only after
the endpoint proves the same service/instance identity. A dead-PID stale descriptor may be removed; an alive
PID with an unavailable endpoint is reported and preserved rather than killed or replaced.

## Install and upgrade

Supported installation follows the same lifecycle as setup:

```text
inspect -> plan -> apply -> verify
```

The plan is reviewable before mutation. For dynamically created resources such as managed worktrees, Apply
may first reserve an ownership **intent** before the external mutation, then upgrades that record to proven
active state after the resource marker/identity is established. This makes an interrupted creation visible
instead of leaving an untracked directory. Verify checks the installed version, service registrations, local
service endpoints, dynamic owned resources, and the exact owned Tailscale route. An interrupted install or
resource creation can therefore resume from recorded state rather than guessing from filesystem leftovers.

The source lifecycle now enforces the plan boundary itself. An install plan may say `create`, `keep`, or
`preserve`. Apply re-inspects every resource before mutation: a `keep`/`preserve` step can never widen into a
create just because the resource later disappeared, and a planned create is abandoned if a foreign/drifted
resource appears in the meantime. A fresh plan is required whenever the observed world changes across that
boundary. Verification succeeds only when every desired resource is again observed as exact Tela-owned state.

Default-profile platform readiness has a separate **read-only doctor** boundary. It performs package/runtime
discovery, a bounded `codex --version` probe, and exact Desktop process observation only. It does not launch,
quit, reroute, install, or rewrite configuration. This keeps Windows/Linux field validation and recovery
diagnostics separate from the mutating `inspect -> plan -> apply -> verify` install lifecycle.

The packaged-install library supplies the concrete operator for that lifecycle. A dry plan computes an exact
payload fingerprint and three platform-native service definitions without creating the install manifest.
Apply first reserves ownership intents for only the planned `create` steps, copies the exact validated binary
payload into the marker-owned binary root, writes a payload receipt last, and registers Gateway/Chat/Codex as
dormant OS registrations. Linux units are enabled but not started, macOS LaunchAgents are bootstrapped
with `RunAtLoad=false`, and Windows registers enabled current-user interactive Scheduled Tasks with no trigger
(manual start only). Interrupted binary copies or
service registration can resume only while the same manifest/marker/definition identity is still provable.
Foreign files, orphaned markers, changed payload bytes, and changed definitions remain non-destructive.

The source package builder now supplies the actual multi-file runtime payload. It compiles a stable launcher
and separate Gateway/Chat/Codex executables, carries the Electron/profile runtime, and on macOS includes the
signed AppKit menu-bar executable under the same owned payload tree. It writes
`chatgpt-tela-package-v1.json`, performs platform-native signing before freezing the tree, and signs the tree
fingerprint with Ed25519. Signed install and signed upgrade verify that release signature before entering their
existing ownership transitions. The stable OS registration invokes only the launcher; the launcher re-proves
the owned payload receipt and dispatches the exact service executable declared by the installed manifest.

The menu-bar process is UI, not a fourth backend service. It may be launched from the installed launcher on
macOS, reads the same standard product paths, and calls only authenticated loopback service endpoints. The
macOS install blueprint registers `com.openai.chatgpt-tela.menu-bar` as a product-owned LaunchAgent with its
own definition fingerprint and marker. It is `RunAtLoad` in the Aqua session but is never treated as
Gateway/Chat/Codex authority; uninstall removes it only when the exact definition/marker/manifest ownership is
still proven.

Payload symlinks are not a general escape hatch. They are permitted only as relative links whose lexical and
resolved targets remain inside the same payload root. Their raw target text is included in the fingerprint and
the installer recreates the link exactly. Absolute, broken/cyclic, or escaping links fail closed. This narrow
allowance preserves native Electron framework bundle structure without allowing payload traversal outside the
owned binary root.

First-use bootstrap is part of the installed launcher. The macOS control center uses a receipt-verified,
read-only `bootstrap-status` query to distinguish missing from configured state; verification/schema failures
block setup without overwriting data. It opens first-use guidance only for missing configuration. Configuration
travels over bounded stdin to `configure --stdin --if-missing`, using the same schema/ownership boundary as
`configure --file`: reserve newly created config/service-state/runtime/log/cache directories and write only
Tela configuration. Existing settings are never replaced by first-use UI. Development-only unauthenticated
exposure requires explicit consent; HTTPS routing/Tailscale prerequisites and consumer-release limits remain
visible rather than being silently provisioned.

`setup [--slot N]` launches the signed package's declared login entrypoint with an install-scoped activity
lease. It starts no Native route/model turn and rejects connected or orphaned Work profiles. A human finishes
from the native browser menu or closes the window; proof runs before surface teardown, and an unsuccessful
proof leaves login available. Cancel releases setup without claiming readiness. The control center waits for
completion and then offers the existing Work connection lifecycle, which separately proves connector/model
readiness. Existing unmarked data never gains removal authority. Older packages without setup fail with an
update instruction. No idle login polling or additional always-hidden browser is introduced.

The integrated acceptance test drives signed install, configure, setup ownership/lease, service-restoring
upgrade, keep-data uninstall, reinstall and remove-data uninstall in a temporary home. Exact saved config/login
bytes and external app/config/conversation/project sentinels are checked throughout. Service management and
login are fixtures: this proves lifecycle composition, not real Windows/Linux or login UI behavior.

The remaining packaging boundary is product distribution UX/trust: a public macOS build needs Developer ID
signing and notarization instead of the local ad-hoc proof identity, Windows/Linux still need real release
signing and packaged E2E, and installer/updater UI must surface the existing plan/apply/verify results.

Cross-version packaged upgrade is a separate ownership transition. The first upgrade generation requires the
three service-registration identities to remain byte-for-byte stable; a service definition change is treated
as a future explicit migration rather than silently folded into binary replacement. Before touching payload
bytes, upgrade writes an install-scoped journal, records which services are running, and normally quiesces
Gateway first followed by Codex and Chat. Only after all three are stopped does it replace the exact owned
payload. The new receipt is verified before the ownership manifest version is committed, then only the
previously running services are restored backend-first with Gateway last.

The journal records each quiesce/replacement/commit/resume boundary. A crash during binary replacement can
therefore rebuild the target only inside the exact marker-owned binary root, while a restart failure after the
version commit retries only outstanding service resumes. Ordinary source `start` and destructive uninstall
apply refuse to run while the journal exists, so unrelated lifecycle commands cannot execute or remove a
half-upgraded payload.

The concrete packaged service controller preserves registration identity. Quiescing uses authenticated
private service shutdown after proving the install/runtime identity; active-work refusal or missing
authority stops the transition without OS stop/kill fallback. Bounded platform observation must confirm
stopped state before payload replacement. Resume uses `systemctl --user start`, macOS `launchctl kickstart`,
or Windows `Start-ScheduledTask`. Transitional or unrecognized states fail closed. The controller requires
an explicit shutdown dependency; production uses the owned supervisor, isolated tests a fake contract/OS
runner. This source change is not installed; actual OS-service/update acceptance remains separate.

Same-version packaged repair is separate from both install and upgrade. Normal install deliberately treats a
completed payload whose bytes drifted as ownership drift and will not overwrite it. Repair adds one narrower
`repairable` state: the install manifest, binary-directory marker, payload receipt, install id, product
version, resource id, and expected package fingerprint must all still match while only the current payload
bytes differ. This is the proof that permits restoring Tela-owned product bytes.

Repair planning is non-escalating (`keep`, `repair`, or `preserve`). A resource planned as `keep` never gains
repair authority merely because it breaks later, and foreign/unsafe service-registration drift is always
preserved. Binary repair is blocked while any service registration is ambiguous. When authorized, Tela writes
`packaged-repair-v1.json` before quiescing exact-owned services, repairs payload plus any exact-missing
registrations idempotently, verifies all resources, then resumes only services that were running before the
repair. A failed resume leaves completed checkpoints in the journal so retry resumes only outstanding
services. Repair and upgrade journals are mutually exclusive, and package launch/install plus ordinary source
start and destructive uninstall apply are blocked while either transition is incomplete.

Signed repair plan/apply entrypoints verify the same Ed25519 package signature boundary as signed
install/upgrade. The packaged launcher exposes a pre-release operator CLI for `install`, `repair`, and
`upgrade`; every command requires exactly one of `--dry-run`/`--apply` and an explicit
`--trusted-public-key <pem>`. The key is intentionally external to the package being verified, so replacing a
payload and its embedded metadata cannot redefine trust. Planning verifies the target signature before it
observes or reserves install state, and apply verifies the target signature again before mutation. A wrong
key therefore fails before ownership manifest/service-registration creation.

For the common package-directory flow, the payload defaults to the directory containing the launcher. A
caller may select another target with `--payload <directory>`. Running a known-good same-version package gives
repair its trusted source bytes; running the new target package gives upgrade its replacement bytes. This CLI
is not yet the final consumer trust UX: public release packaging must pin the trusted release key set in the
signed installer/updater rather than requiring users to supply PEM files manually.

## Natural-language self-maintenance target

The operator CLI is an implementation boundary, not the intended everyday UX. Tela Chat and Tela Work/Codex
should eventually accept ordinary requests such as "update Tela", "reinstall Tela", "repair this install",
"remove Tela but keep my data", and "remove Tela completely" and map them to the same lifecycle state
machines documented here.

The model does not gain permission to improvise installation/removal shell scripts. A maintenance request must
resolve to a typed lifecycle intent, inspect current ownership/transition state, produce a reviewable plan, and
then invoke only the corresponding signed lifecycle operation. Destructive data removal remains explicit.

Because a running executable is a poor authority for replacing or deleting itself, the final consumer flow
uses a signed **external maintenance helper**. The helper is launched from outside the installed binary root,
inherits only the verified lifecycle plan and pinned release trust, stops exact-owned Tela services, performs
install/repair/upgrade/uninstall, verifies the resulting ownership/runtime state, restarts Tela when the
operation requires it, and cleans itself up when finished. This also gives Windows, macOS, and Linux one
consistent product contract instead of depending on platform-specific self-deletion behavior.

Persistent ChatGPT profile data follows a stricter adoption rule because it may contain login cookies and
other user-significant state. A fresh product setup may reserve and marker-own only the exact browser profile
directory and account-binding directory it creates. If either directory already exists without a Tela marker,
setup may use it but does not add it to uninstall authority. Foreign/orphaned markers fail closed. Profile
setup also holds an install-scoped activity lease for its whole interactive lifetime; uninstall treats any
live or ambiguous setup lease as a Codex-owner blocker instead of deleting browser/account state underneath a
running setup surface.

Upgrades replace only resources owned by the same install instance. Unknown files, replaced service units,
or a Tailscale route whose current target no longer matches Tela's recorded lease fail closed instead of
being overwritten.

## Uninstall

Uninstall is a first-class product operation, not a README cleanup recipe:

```text
inspect -> plan -> apply -> verify
```

`tela uninstall --dry-run` (or its final packaged equivalent) shows everything Tela intends to stop, detach,
or delete. The source pre-alpha CLI also has an explicit `--apply` path for resource kinds whose ownership
adapters are already implemented. Apply never trusts the earlier plan blindly: it re-observes ownership
immediately before every destructive resource operation. The normal uninstall sequence is:

1. stop accepting new Gateway requests;
2. ask Tela Chat and Tela Codex to stop through their normal service contracts independently;
3. remove only service registrations still owned by the recorded install instance;
4. remove only the exact Tailscale Funnel path lease still pointing at Tela Gateway;
5. inspect managed worktrees while Chat ownership metadata is still available; remove only exact clean owned
   worktrees and preserve/report dirty, committed, drifted, or orphaned worktrees;
6. remove product-owned runtime/cache/log/state/config data selected by uninstall policy;
7. remove product binaries/helpers last;
8. verify that no removable owned service, listener, route, helper, worktree, or manifest entry remains.

Source and packaged uninstall use one shared orchestration runtime rather than duplicating ownership policy.
The packaged launcher exposes `uninstall --dry-run`, `uninstall --apply`, and optional `--remove-data`.
Packaged apply must run from a separately extracted package copy: if the current executable resolves inside
the installed Tela binary root, it fails before stopping services or deleting anything. This avoids relying
on platform-specific self-deletion behavior and keeps the same removal sequence on macOS, Windows, and Linux.

If a backend cannot stop, uninstall reports it separately; a Tela Chat failure must not prevent normal Tela
Codex cleanup, and vice versa. Forced termination is a bounded fallback only for an exact product-owned pid
whose executable/instance identity still matches the ownership record.

The current source apply path deliberately has **no forced-PID fallback**. Service-registration removal is
available only for registrations created with the newer exact ownership identity: the manifest records the
platform, a Tela-owned sidecar marker, and a definition fingerprint (plus the exact unit/plist path for
file-backed registrations). Legacy registration ids with no such evidence remain preserved. A backend that
does not stop through its authenticated private lifecycle blocks removal of that backend's owned resources,
while other owners still proceed.

For macOS launchd and Linux systemd user units, removal requires the marker and exact definition bytes to
still match before the normal service-manager unload/disable request and file removal. Windows uses a
per-user Scheduled Task so Tela remains in the same user/config/Desktop session instead of running as
`LocalSystem`. Its exact action, arguments, working directory, interactive principal, limited run level, and
enabled state are fingerprinted and re-proven before normal stop/unregister. If the definition or registration
identity changes, uninstall preserves it instead of assuming a matching name is still Tela-owned.

### Data safety

- User workspaces/repositories are never deleted.
- A managed worktree is removed only when its source-repository identity, Git registration, ownership marker,
  install-manifest entry, clean status, and creation-base `HEAD` all still match. Dirty worktrees, detached
  commits, replaced/symlinked paths, missing source repositories, marker drift, or otherwise ambiguous
  worktrees are preserved and reported. If the worktree directory itself was externally deleted, Tela may
  remove the **exact stale Git registration only** when the source repository identity, install manifest, and
  Git-admin Tela marker still prove the same worktree; otherwise the registration is preserved for recovery.
- Browser profiles, local service databases, logs, and cached artifacts are product-owned but potentially
  valuable user state. The final UX offers a clear `remove all Tela data` vs `keep local data` choice; the
  action plan makes that choice explicit before deletion.
- Historical review artifacts can contain source patches and snapshots of untracked file content. They are
  private, bounded product state with retention limits. Keeping local Tela data keeps these reviews; removing
  all Tela data removes the review state. Review capture never transfers ownership of the source repository.
- Privacy-safe Chat incident records are also bounded product state. They contain only fixed failure metadata
  plus an opaque workspace fingerprint, never raw commands/paths/prompts/output/error messages, and follow the
  same keep-data vs remove-data lifecycle as the rest of Tela Chat state.
- Durable Chat subagent state is private product data. The core store omits prompts but may contain bounded
  final responses and opaque provider continuation ids. Restart converts unproven running turns to `unknown`
  rather than reconnecting. Keeping Tela data keeps this state; removing all Tela data removes it only through
  the normal marker-owned Chat state lifecycle.
- Provider secrets are not persisted in Tela config or the ownership manifest. The manifest records only
  the platform-store kind, logical credential id, and a random Tela-only physical store key so runtime and
  uninstall can distinguish Tela-owned entries from unrelated/pre-existing secrets without a secret hash.
  macOS uses Keychain, Windows uses CurrentUser DPAPI, and Linux uses Secret
  Service. A normal uninstall preserves provider credentials; `--remove-data` may remove only an exact
  currently-owned credential. Ephemeral runtime credentials still disappear with their owning
  process/runtime directory.

## Tailscale ownership

The intended product ingress is one Tailscale Funnel path terminating at Tela Gateway. Tela does not own the
user's Tailnet, Tailscale installation, hostname, unrelated Serve/Funnel routes, or device login.

The ingress adapter records an ownership lease for only the path/config fragment it creates. Uninstall may
remove that fragment only while current Tailscale state still matches the recorded Tela target. If another
program or the user has changed it, Tela preserves the current configuration and reports the drift instead of
resetting the whole Serve/Funnel configuration.

Route acquisition is transactional around observable state. Tela reserves the exact route identity in its
ownership manifest before creating an absent Funnel mapping, executes only path-scoped `tailscale funnel`
arguments, then re-reads `tailscale serve status --json` and accepts the operation only from that post-state.
If the CLI reports failure after actually mutating the path, the verified post-state wins and the command is
not blindly retried. If verification fails, ownership intent remains visible unless the route is proven
absent. A pre-existing matching route is never auto-adopted into the manifest.

## Service independence

Packaged Native engines include their matching upstream `codex-code-mode-host` beside `codex`
(`.exe` on Windows). The engine source supplied to the package builder must include that sibling
executable. Both files belong to the signed product binary tree and are updated and removed together.
Engine selection rejects missing, linked or non-executable helpers before launching the engine;
the installed payload receipt detects helper byte changes as well as engine changes.

Tela Gateway, Tela Chat, and Tela Codex are separately supervised processes. Installation may place them in
one product bundle/repository, but lifecycle ownership stays independent:

- Gateway can start while either backend is unavailable.
- Chat can be installed/repaired/reset without initializing Codex browser/Responses state.
- Codex can be installed/repaired/reset without opening Chat workspaces or process state.
- Backend health checks are demand-driven/bounded; no backend's failure loop may create a busy loop in the
  other backend or in Gateway.

This independence is required both for day-to-day fallback and for reliable uninstall/repair.


## macOS maintenance preview

The control center launches `maintenance-open` through its installed launcher. A verified temporary copy
of only the launcher and native UI runs outside the installation removal boundary. The standalone window
invokes the existing signed upgrade/repair and ownership uninstall engines; it adds no service authority.
Damaged installations may stage this helper from an independently trusted signed same-version repair
package, after the existing repair planner validates it. Missing launchers require an external installer.

`maintenance review` returns a SHA256 review token bound to the observed plan, signature envelope, and
trusted key bytes, including the complete cancellation journal checkpoint. `maintenance apply` recomputes the plan and rejects changed tokens before mutation.
The UI shows immediate progress, blocks closing while applying, confirms interruptions, and preserves data
by default. Tests inject fake OS managers for every lifecycle mutation, including uninstall.

The native maintenance window groups action, signed-package input, and review; its action footer remains
visible when the content scrolls. Only unfinished upgrades expose cancellation. The signed source package
must explicitly support cancellation and replacement must not have started. `maintenance-open --operation`
can validate either the retained source for cancellation or the original update target for resumption;
repair remains the default. Cancellation never closes an already running service. Synthetic native UI
review/confirmation and fake-OS lifecycle tests do not prove an installed consumer flow.

Normal close removes the exact hash-checked private temporary snapshot. Unknown files or changed bytes
are preserved. A crash may leave that snapshot in the OS temporary directory until temporary-directory
cleanup; no permanent registration is created. Automatic downloads, pinned consumer keys, notarized
release distribution, and Windows/Linux maintenance UI remain pending. Local ad-hoc preview signing does
not establish consumer release trust.
