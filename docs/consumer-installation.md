# Consumer installation and removal design

Status: partial source implementation; no installed rollout or account removal has been performed.

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

## Refactoring order

1. Trace the existing setup/maintenance UI and shared install/remove contracts. Replace duplicate
   UI readiness checks with actual lifecycle results; keep local readiness separate from host linkage.
2. Prove the official connection adapter and public-plugin/per-machine binding contract. Choose
   the smallest supported release path before implementing distribution or authentication changes.
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
