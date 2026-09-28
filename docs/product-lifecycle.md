# Product lifecycle

Installation, upgrades, service supervision, and uninstall are one ownership problem. ChatGPT Tela must be
easy to install without making itself difficult to remove later.

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
or `recognized_once`). It contains no endpoint, browser/account identity, credential, prompt, tool argument,
or persistent-approval grant. Profile processes read the current preference only when they start/restart.

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

The concrete packaged service controller preserves registration identity while quiescing/resuming processes:
Linux uses `systemctl --user stop/start`, macOS keeps the LaunchAgent bootstrapped and uses normal
`launchctl kill SIGTERM` / `kickstart`, and Windows uses `Stop-ScheduledTask` / `Start-ScheduledTask` for the
current-user task. Each transition is followed by bounded state verification; transitional or unrecognized
states fail closed rather than being interpreted as stopped/running.

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

Tela Gateway, Tela Chat, and Tela Codex are separately supervised processes. Installation may place them in
one product bundle/repository, but lifecycle ownership stays independent:

- Gateway can start while either backend is unavailable.
- Chat can be installed/repaired/reset without initializing Codex browser/Responses state.
- Codex can be installed/repaired/reset without opening Chat workspaces or process state.
- Backend health checks are demand-driven/bounded; no backend's failure loop may create a busy loop in the
  other backend or in Gateway.

This independence is required both for day-to-day fallback and for reliable uninstall/repair.
