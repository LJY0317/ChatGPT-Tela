# Consumer installation and removal design

Status: partial implementation; source checks and read-only installed Settings UI accepted.
Full account removal and installed uninstall/reinstall acceptance remain open.

Interrupted removal now resumes through the same review/apply path after reacquiring the existing OS
writer lock. It observes remaining ownership and actual resources again; it does not replay the old plan.
A subprocess-exit test covers an already-removed directory, preserved settings, reinstall and complete
removal with an isolated filesystem and simulated service manager. Real consumer removal remains unverified.

The current source adds official ChatGPT plugin-management links in Settings, setup and the
local removal window. Local maintenance explicitly reports account cleanup as not performed;
the completion screen says removal was from this computer. Existing optional saved-data removal
is unchanged. A simulated unavailable-plugin→explicit reconnect scenario and a keep-data
uninstall→reinstall scenario pass alongside the existing maintenance checks (26 tests total),
TypeScript checking and a macOS UI build. These are source checks, not live account deletion,
installed removal/reinstall, or Windows/Linux UI acceptance. Official transport/authentication,
public-plugin distribution and host-side account cleanup automation remain target work.

## Product boundary

Present one ChatGPT Tela integration. Installation on a computer, installation of a ChatGPT
plugin, authorization to that computer, and optional Web-model connection are distinct facts.
Reuse the existing ownership manifest, lifecycle plans, maintenance executor and connection
verification. Native ChatGPT, its updates, projects and conversation history remain outside
Tela removal ownership. A removed account plugin does not mean local Tela was uninstalled;
a removed local app does not prove ChatGPT removed its plugin or retained data.

## Ordinary user journeys

| Action | User-facing flow | Completion evidence |
| --- | --- | --- |
| Install | Install the OS package → Open Tela → Connect to ChatGPT → approve in ChatGPT | Installed local runtime, supported connection, and one harmless tool round trip from the intended ChatGPT account/workspace |
| Reconnect | Connect to ChatGPT → reuse or reauthorize the existing connection | Successful request through that connection; preserve configuration and user work |
| Update | Check for Updates → Update / Restart to Update | Target version running, services and menu updated, previously enabled connections restored where supported |
| Remove | Settings → Remove Tela → choose whether to remove saved Tela data | Local owned resources removed; account-plugin removal separately reported |
| Reinstall | Install again → reuse retained settings or set up a fresh connection | Same verification as first install; no duplicate plugin merely because of reinstall |

Show only the next necessary action. Use short labels such as “Connect to ChatGPT”,
“Open ChatGPT”, “Check connection”, “Reconnect” and “Remove Tela”. Advanced endpoint,
tunnel and diagnostic details belong in a secondary section. Single-account setup is the
normal path; show account/workspace choices when multiple targets actually exist.
Use host-provided account identifiers and display information when available; otherwise
show that account linkage is unverified rather than inferring identity from an email/title.

## ChatGPT plugin registration

The target public experience uses ChatGPT's supported plugin install and permission screens.
Keep one stable plugin identity and the existing small MCP control ABI. A plugin-directory
listing is a distribution/review deliverable, not a local install receipt. A user-specific
local tunnel is not automatically a dynamically routable endpoint of one published plugin.
Before promising directory installation for local machines, verify the supported binding
contract. Do not introduce a hosted relay, custom account system or new OAuth server just
to simulate an unverified host capability.

For a remote plugin, OpenAI's current contract confirms Secure MCP Tunnel can connect a private local MCP server
to a ChatGPT custom app when `tunnel-client` is running with a `tunnel_id` and runtime API key
and the tunnel is associated with the target ChatGPT workspace. This does not qualify as public
remote plugin submission: that submission path requires a stable public HTTPS MCP endpoint. Treat the
tunnel as the private/custom connection path, not as a replacement for a public consumer
distribution service. See [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

An alternative exists for approved desktop-only local MCP plugins: the organization must be
allowlisted before submitting a bundled stdio server. Installation is through the ChatGPT desktop
app, and use is limited to locally executing threads. This is not general submission access or
evidence that Tela's organization qualifies. The documentation does not establish that this path
serves Tela's temporary ChatGPT Web worker conversations. Confirm eligibility and that surface's
tool access before replacing the current remote connection or adding a second transport. See
[Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only).

### Local execution support by surface

| Surface | Current evidence |
| --- | --- |
| Native/Codex local host | Local plugin installation, stdio startup and Chat tool calls pass in an isolated profile. |
| ChatGPT desktop local Work | Official local-plugin route exists; Tela's actual UI workflow is not yet accepted. |
| Regular web Chat and Tela's Electron Web workers | Not covered by the desktop-only local-thread contract. Tela currently loads the web client without a local plugin executor; the stdio candidate is not a drop-in replacement. |
| Another computer using the same account | No local discovery, registration or remote fallback is intended. Two physical computers remain an acceptance requirement. |

Electron being a desktop program does not make its hosted web conversation a ChatGPT local thread.
Do not label the existing remote connector as current-device-only, silently replace its registration,
or add a custom relay to bridge this unsupported surface. Preserve the working route until an explicit
supported migration is available; its configured-host limitation remains visible above.

Tela already has an `OpenAiSecureMcpTunnelExposure` adapter, currently wired into the
development canary. Production configuration, the packaged gateway and setup UI still use
existing HTTPS or Tailscale Funnel. Reuse that adapter for an eligible private connection;
its source implementation alone does not prove installed onboarding or public distribution.

For currently supported private/custom MCP registration, Tela prepares its connection,
opens the official ChatGPT Plugins entry point, and displays only the connection values
ChatGPT needs. Reuse a valid existing registration. User sign-in, permission consent and
ChatGPT-side creation/removal remain explicit host operations. Do not make unattended
DOM automation, private account APIs or fixed menu labels the lifecycle contract.
A missing directory search result is not evidence that a private plugin cannot be reinstalled.

Prefer an official Secure MCP Tunnel adapter for eligible accounts/workspaces, after a
small end-to-end feasibility check. Reuse its supported client and status/credential storage;
do not reproduce its transport. Keep existing HTTPS as an explicit advanced option with
standard MCP authentication. The current development-only unauthenticated public exposure
is not the final consumer default. Use existing identity providers/standard libraries where
authentication is necessary rather than a homegrown authorization engine. Tunnel eligibility,
workspace association and credentials must be explained before local setup is committed.
No silent fallback from a private/authenticated route to anonymous public access.

Local Ready means the local service is ready, not that ChatGPT has installed the plugin.
Verify setup through the actual ChatGPT→MCP→local-runtime→ChatGPT result path with a
harmless installation-scoped check. Do not invoke a model, create a Goal, touch user project
files or send messages to unrelated conversations to prove setup. Where host identity or
installation state cannot be queried, report that boundary; successful login alone is insufficient.

## Removal and saved data

Use one existing maintenance flow. Stop admission of new Tela work and reconcile active or
uncertain operations using the existing lifecycle; do not require the user to cancel hidden
processes in a terminal. Preserve unfinished questions/results until explicitly settled or
included in the user's data-removal choice. Do not interrupt active work merely to inspect removal.

For account-only disconnection, offer the official host removal path and revoke only the
selected Tela connection's access when the supported provider contract permits it. Other
accounts/connections remain untouched. Account-plugin uninstall, disconnection and deletion
of a private plugin definition are different operations; report the actual supported result.

For local removal, preview the effects once, obtain the ordinary user confirmation, then
execute the existing owned-resource uninstall. Default to keeping saved Tela settings/data;
provide one explicit “Also remove saved Tela data” choice. Avoid a second cleanup engine.
The UI stages the existing external maintenance runner as required; users should not have
to download another package or understand self-deletion restrictions. The runner retains
only the minimal recoverable receipt and cleans itself through the existing maintenance lifecycle.

Where ChatGPT-side removal cannot be automated through a supported contract, open its official
management screen and say “Tela was removed from this computer. Remove its plugin in ChatGPT
to finish account cleanup.” Do not claim complete removal while a known step is unresolved.
A failed or skipped host step must not prevent an independent local removal. Preserve a
minimal non-secret account-cleanup instruction before removing local state; no resident helper
is kept solely to watch for host deletion.

Full local data removal covers Tela-owned credentials, browser profiles, caches, diagnostics,
autostart items, services and owned routes according to the existing manifest. Shared tunnel
clients/routes, other plugins, original ChatGPT app/login/history, and user repositories are
not Tela-owned simply because Tela used them. Account-side retention is governed by ChatGPT;
local uninstall cannot promise server-side erasure. Reinstall must not silently reauthorize a
revoked connection or recreate a user-removed plugin.

## Multiple computers on one ChatGPT account

A remote plugin connection targets its configured endpoint, not the computer displaying ChatGPT.
The current gateway dispatches ordinary Chat capabilities to that endpoint's local Chat service.
Account identity, Origin, IP and conversation IDs do not establish the caller's physical device.
Native turn capabilities restrict an existing task; they do not move execution to the caller's machine.
Consequently, the current remote connection does not guarantee current-device-only local access.

The source now supports `chatgpt-tela local-mcp package <new-output-directory>` in the packaged
launcher. It generates a Chat-only stdio plugin and inactive marketplace using the running Tela
executable; no development checkout, Bun/Node installation or runtime copy is needed. The output
directory must not already exist, so this command cannot replace an existing marketplace or README.
An explicit packaged `local-mcp register` operation now prepares an install-owned metadata source
and adds only its own entry to the documented personal marketplace. Existing same-name entries are
preserved rather than adopted. The product manifest distinguishes an unfinished registration intent
from a proven entry; uninstall removes only the unchanged owned entry and owned source directory,
leaving other entries and user edits intact. This local cleanup does not require the Desktop host to
be reachable and does not remove its plugin cache or account authorization. Product writers use the
existing transition lock; an unrelated external writer does not participate in that lock, so atomic
replacement is not a cross-application compare-and-swap guarantee. Host installation and actual
consumer migration from an experimental personal registration remain separate acceptance steps.

On macOS, the installed launcher's `local-mcp register` was also exercised with an isolated home
and ownership manifest. Registration and reuse, settings-preserving removal, registration again
without duplicates, and explicit saved-data removal passed while preserving an unrelated marketplace
entry. Registration used the installed executable; removal used the product uninstaller. This checks
the local registration lifecycle, not OS app/service installation or Desktop plugin authorization.

Keep the installed launcher at a stable path across upgrades. The manifest uses a bare executable
name and process-local PATH because Agent Plugins do not accept absolute stdio commands. A compiled
runtime test exports the plugin, moves it into a host-style cache, removes the original package and
reads a file through an isolated Chat service with only the Tela executable on PATH. This is source
acceptance, not installed ChatGPT Desktop acceptance.
The same isolated test also replaces the compiled executable with different binary bytes at the
same installed path: the previously cached plugin continues to read and write through the local Chat
service without re-registering. The host cache keeps the executable directory in PATH; an upgrade
that moves or renames the installed launcher is outside this verified contract.

After an installed update, an existing enabled Desktop local plugin also returned exact file contents
through the official Native host's direct tool-call API without reinstallation or registration changes.
That acceptance made no model request; a model-mediated UI turn and a second physical device remain
separate checks.

For development, `bun run local-mcp:package` still creates a Node-based candidate under
`build/local-mcp`; `--launcher /path/to/chatgpt-tela` selects the installed-runtime mode instead.
Packaging also writes a local development marketplace at `<output>/.agents/plugins/marketplace.json`;
it neither installs the marketplace nor changes ChatGPT Desktop configuration. Desktop's supported
personal and repository sources are `~/.agents/plugins/marketplace.json` and
`$REPO_ROOT/.agents/plugins/marketplace.json`; a generated copy outside those roots is not automatically
discovered. Local `source.path` resolves from the marketplace root, not its `.agents/plugins` folder.
OpenAI documents local stdio plugins as Desktop-only and allows local-MCP directory submissions only
from approved partners whose organization is allowlisted; the plugin runs only in locally executed
ChatGPT Desktop threads, not Web or mobile. Its desktop client also supports personal and repository
local marketplaces as a separate install source. See [desktop-only submission](https://developers.openai.com/plugins/deploy/desktop-only)
and [local marketplace packaging](https://developers.openai.com/plugins/build/plugins).

Isolated Chat instances reject each other's workspace IDs and do not fail over when one stops.
The official Native/Codex host passes temporary-profile plugin installation, cache-based startup,
capability-inventory forwarding to the local Chat service, and official removal. The launcher-backed
mode also passes with no Node on the host PATH. No model turn or user config change is required.
A separate process-only host test reads a temporary file through an isolated Chat service.
The signed packaged launcher also completed MCP initialize/tools-list and a local-file read over
stdio against this computer's existing Chat service; this does not prove ChatGPT Desktop plugin installation.
The launcher-backed personal marketplace is now discovered in two installed macOS Desktop profiles.
A user-selected local Desktop thread invoked the plugin's workspace-open and file-read tools, returned
the exact synthetic file content and completed with an empty queue. The test file was removed afterward.
This establishes one local Desktop read workflow, not cloud Work, temporary Web-worker support or
two-physical-device isolation. Clean consumer-install acceptance remains separate.
Public directory submission still requires organization allowlisting; do not conflate it with the
per-device local-marketplace path.
If a host surface cannot use the local transport, report that limit without remote fallback.

The macOS **This Mac** menu shows the existing local Chat status. It does not identify a ChatGPT
conversation's execution host, which is displayed as unverified. Device registration, discovery and
account-based device-list synchronization are outside the intended local-only design. Each computer
must use its own local transport; an unavailable local service must remain unavailable without remote
fallback. Same-account conversation synchronization does not grant access to another computer's files.
Existing MCP diagnostics already correlate local tool execution with the host-supplied `openai/session`;
that identifies a conversation, not its originating computer. Reuse these events for local activity,
without treating a past invocation as a current connection. See the [client metadata contract](https://developers.openai.com/plugins/reference).
[Tailscale Services](https://tailscale.com/docs/features/tailscale-services) can route a service address
among available hosts, which does not meet this local-only execution policy.

Acceptance requires two ChatGPT Desktop computers using the same account and separate local sentinel
files: each local thread must read/write only its own file; stopping one computer's local service must
make that computer unavailable while the other still works. Web/mobile threads must remain unavailable,
with no remote fallback. Same-account conversation sync is separate from local execution authority.

Reference implementations are not equivalent guarantees. [codex-chatgpt-web's security model](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/security-model.md)
binds tools to a local Native turn through its tunnel; it does not establish automatic caller-device
selection for standalone ChatGPT. [Chat on Steroids' desktop-call guard](https://github.com/totec448-spec/chat-on-steroids/blob/main/src/main/mcp/desktop-caller.ts)
records a cross-computer connector incident and checks chat correlation for desktop tools. This is a
useful warning, not proof of isolation for all file and command capabilities.

## Refactoring order

1. Trace the existing setup/maintenance UI and shared install/remove contracts. Replace duplicate
   UI readiness checks with actual lifecycle results; keep local readiness separate from host linkage.
2. Use the documented per-device Desktop local marketplace for local stdio execution. Place a
   personal `~/.agents/plugins/marketplace.json` or repository
   `$REPO_ROOT/.agents/plugins/marketplace.json` source and install/test it in ChatGPT Desktop's
   Plugins Directory. `codex plugin marketplace add` only registers a source with the Codex CLI; its
   plugin install/remove commands do not establish Desktop installation or removal. The current
   `build/local-mcp` output is only a package candidate; validate manifest discovery, local source
   resolution and the Desktop lifecycle in a clean host before wiring it into setup/removal. Keep
   public Directory submission separate; never fall back to a remote host.
3. Consolidate setup/reconnect into the existing connection path, with short contextual guidance
   and actual harmless round-trip verification. Remove name-only connector identification where
   supported stable identity/served-request proof exists; isolate host-page dependencies.
4. Finish the existing maintenance UI's remove/reinstall flow, including account cleanup guidance,
   saved-data choice and staged external execution. Reuse update/repair journals and ownership.
5. Validate consumer install→connect→update→remove→reinstall on supported platforms. Cover
   account-only removal, offline host cleanup, interrupted maintenance, a manually removed plugin,
   and retained versus deleted data. Confirm original ChatGPT still launches and updates normally.
   Keep source tests, installed acceptance and unverified platform coverage distinct.

## Research basis

- [OpenAI: Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt):
  supported custom MCP creation, connection methods, installation, refresh and plugin testing.
- [OpenAI: Authentication](https://developers.openai.com/plugins/build/auth): standard MCP/OAuth
  discovery and existing identity providers; do not confuse OAuth client registration with plugin creation.
- [OpenAI: Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only):
  partner approval, organization allowlisting and local-thread scope for bundled local MCP submission.
- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins): personal/repository
  marketplace sources and Desktop installation. The separate bundled Codex CLI can register a
  marketplace source and manage its own plugin cache; that is not ChatGPT Desktop lifecycle evidence.
- [OpenAI tunnel-client](https://github.com/openai/tunnel-client): supported private/local MCP transport;
  its documented onboarding still distinguishes the ChatGPT custom plugin from a local Codex plugin.
- [DevSpace setup](https://github.com/Waishnav/devspace/blob/main/docs/setup.md): ask only applicable
  setup questions, then configure the client connection; not a complete consumer removal reference.
- [Chat on Steroids setup](https://github.com/totec448-spec/chat-on-steroids/blob/main/docs/setup.md):
  guided setup and visible readiness. Its multiple connectors/browser extension and DOM identity
  heuristics are not requirements for Tela's single integration.
- [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web): packaged runtime, guided MCP setup,
  preserved settings on updates and explicit removal of the Codex integration. Its browser-native-tool
  architecture and exact connector names are not Tela's target contract.
