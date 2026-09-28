# Security

ChatGPT Tela bridges model-authored tool calls to two independent local execution services, so security bugs
can have local side effects.

- **Tela Gateway** is the only public/Tailscale-facing component and owns no workspace, process, agent,
  Native Codex, browser-profile, or Responses authority.
- **Tela Chat** owns only its workspace/worktree/process/agent state.
- **Tela Codex** preserves Native Codex as the authority for its task, sandbox, and runtime-discovered tools.

Backend failure or compromise must not silently widen authority in the other backend. OpenAI-owned model/tool
names and third-party MCP tool names are runtime observations rather than trusted hardcoded product ids.

Uninstall follows recorded product ownership. Tela must not delete user repositories/workspaces, unrelated
Tailscale routes, or resources whose current identity no longer matches the install manifest. Ambiguous or
dirty resources are preserved and reported.

Tela-created Git worktrees are removable only after repository identity, Git worktree registration,
Git-admin ownership marker, install-manifest identity, working-tree cleanliness, and the original base `HEAD`
are all re-proven. A clean detached commit is preserved rather than treated as disposable state. A managed
path replaced by a symlink or a worktree whose source repository disappeared is also preserved.

If a managed worktree directory disappears while Git still retains its administrative registration, Tela
removes that stale registration only after the exact install manifest, source-repository identity, recorded
path, and Git-admin Tela marker all still agree. Missing or ambiguous markers are preserved rather than
interpreted as permission to prune Git metadata.

Service supervision never treats PID liveness alone as authority. An existing descriptor must answer on its
authenticated loopback endpoint with the same service and instance identity. A dead-PID stale descriptor can
be cleaned; an alive PID whose endpoint is unavailable is not killed or replaced automatically.

The built-in default Desktop adapter follows the same identity rule across platforms. Before requesting
Desktop shutdown it re-resolves the exact ChatGPT executable process and requires one matching PID. macOS uses
the application quit lifecycle, Windows uses `CloseMainWindow()`, and Linux sends graceful `SIGTERM` only to
the re-proven exact PID. A later bounded hard-stop fallback is permitted only for the child process Tela
itself spawned and still owns; ambiguous pre-existing processes are never adopted or killed.

Windows default-runtime discovery does not choose an arbitrary `codex.exe` from a user directory. It first
proves the registered official AppX package family, hashes that package's bundled Codex executable in bounded
chunks, ignores `.staging-*`, and accepts exactly one relocated per-user runtime with the same hash. Linux
package discovery similarly constrains the canonical launcher to supported system roots. Missing, stale,
foreign, or ambiguous discovery state fails closed and requires an explicit executable override.

The `doctor` preflight is intentionally non-mutating: no Desktop start/quit, no Responses route change, no
service registration, and no product configuration write. Its only executable probe is bounded `codex
--version`; Desktop state is observation-only and duplicate exact processes are reported rather than guessed.

Managed Tailscale ingress is exact-path scoped. Tela never emits global Funnel reset as part of route
lifecycle. It records host, HTTPS port, public path, local loopback target, and a lease fingerprint; release
requires the manifest identity and current Tailscale mapping to agree. A matching path that predates the
manifest is treated as external rather than silently becoming uninstallable Tela state.

Uninstall apply re-runs ownership observation at the destructive boundary instead of treating a previous
dry-run as authorization. If a service fails normal shutdown, resources owned by that service are blocked
from automatic removal. Exact clean worktrees and exact owned Funnel paths use their own lifecycle managers,
which revalidate again internally before mutation.

OS service names alone are never sufficient uninstall authority. New Tela service registrations carry an
install-scoped marker plus a definition fingerprint; file-backed launchd/systemd registrations also record
their exact definition path. Windows uses a current-user interactive Scheduled Task rather than a
`LocalSystem` service, and ownership is fingerprinted from its exact action/working-directory/principal
properties. Legacy name-only records and any changed/replaced definition are preserved.

Install plans are non-escalating capabilities. A plan to keep or preserve an existing resource does not gain
permission to create it if the resource disappears before apply. Conversely, a planned create does not gain
permission to overwrite a resource that appears before mutation. Apply always re-inspects first and requires a
new plan after such drift.

Release payload trust has two separate layers. Platform-native code signing controls whether the OS accepts
the packaged executables/bundle; the Tela package manifest independently declares an Ed25519 signing key id,
and signed install/upgrade/repair verify the package tree signature before mutation. The tree fingerprint is computed
after native signing, so any later code-sign or payload-byte change invalidates the release signature.

Packaged repair is non-escalating and intentionally narrower than reinstall. Normal install never overwrites a
completed payload whose bytes drifted. Repair classifies byte drift as `repairable` only when the current
install manifest, binary-directory ownership marker, and original payload receipt still prove the same install
id, product version, resource id, and expected signed payload fingerprint. Service-definition ownership drift
blocks binary repair. Before product binary mutation, exact-owned services are normally quiesced and a durable
repair journal records the transition; only services proven running before repair are resumed. An incomplete
repair blocks service launch, new install/upgrade transition, source start, and destructive uninstall apply.

No source repair command accepts an arbitrary public key or unsigned payload as a trust bypass. Trusted
release keys belong to the future signed updater/installer boundary.

Packaged payload symlinks are allowed only when they are relative and both lexical and resolved targets remain
inside the same payload root. The link target text itself is fingerprinted. Absolute, broken/cyclic, or
escaping links are rejected. This exception exists to preserve native Electron framework structure; it does
not permit a package or installed payload to link into user/system files outside Tela's owned binary root.

Browser profile ownership is never inferred from a familiar path. New setup may marker-own only a profile
directory/account-binding directory it creates for the current install. Existing unmarked cookie/login state
remains external, and a foreign marker is never overwritten. Interactive profile setup holds an install-scoped
PID activity lease; concurrent uninstall preserves Codex-owned profile state while that lease is live or its
ownership is ambiguous.

Historical Chat reviews may contain source-code diffs and bounded snapshots of untracked files. They are
stored only in private product state with `0600` file permissions, strict count/byte/age retention, and are
not published as refs in the user's Git repository. Symlink targets are recorded as link text rather than
followed, and intermediate directory escapes are rejected before untracked content is captured. Treat review
artifacts as sensitive local user data when collecting diagnostics or sharing support bundles.

Tela Chat incident records are intentionally much narrower than review artifacts. They contain no raw path,
command, patch, prompt, process output, error message, or workspace id. Workspace correlation is a truncated
SHA-256 fingerprint of the already-opaque workspace handle; model-visible lookup requires the original handle
and does not return that fingerprint. Incident retention is bounded and a failure to persist diagnostics never
changes the primary tool result.

Tela Chat's subagent lifecycle does not itself grant a provider filesystem authority. The manager passes one
already-authorized workspace root plus an explicit `read_only` or `workspace_write` request to an injected
driver; a concrete driver must enforce that contract at its provider boundary. No driver is configured by
default. Agent prompts are not persisted by the core store. Bounded final responses and opaque continuation
ids are persisted privately because inspection/continuation require them; treat those values as sensitive
local user data. A persisted continuation id alone is never enough to reattach an interrupted running turn.

Provider API keys are not persisted in Tela JSON config, package manifests, service definitions, or argv.
Source/dev mode may resolve an explicitly named environment variable. Installed/background mode may instead
resolve an opaque credential id from a per-user platform store: macOS Keychain, Windows CurrentUser DPAPI, or
Linux Secret Service. Credential writes pass the secret over child stdin rather than argv, and platform-store
commands are bounded by timeout/output limits. The ownership manifest records only store kind, logical
credential id, and a random Tela-only physical store key, never the secret or a secret hash. Provider lookup
must resolve logical id -> exact current manifest resource -> physical store key; it never probes a fixed
human-facing Keychain/Secret-Service account and therefore cannot silently adopt or overwrite a pre-existing
matching credential. Uninstall preserves credentials unless `--remove-data` is explicit and re-proves both
the current manifest record and physical store entry before deletion.

Please do not publish credentials, browser profiles, MCP keys, prompts, or raw diagnostic captures in issues. For a vulnerability, use GitHub's private vulnerability reporting when available; otherwise contact the maintainer privately before public disclosure.
