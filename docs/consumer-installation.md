# Consumer installation and removal

Installing Tela on a computer, registering its ChatGPT plugin, granting account permission, and connecting an optional Web endpoint are separate steps. A ready local service proves only that the local runtime is ready.

## Install and connect

1. Install the packaged Tela application and open it.
2. Choose **Connect to ChatGPT** and follow the official ChatGPT plugin installation and permission flow.
3. Reuse an existing valid registration. Complete sign-in, consent, and plugin creation in ChatGPT when requested.
4. Verify the connection with a harmless tool round trip in the intended account and workspace. If the host does not expose account or installation identity, report that linkage as unverified.

Reconnect through the same connection flow and reauthorize only when the host requests it. Updates should retain the stable plugin identity and existing local configuration. A prepared marketplace entry, a successful login, or local service readiness is not proof that ChatGPT installed or authorized the plugin.

## Host and transport boundaries

For a private/custom MCP connection, Tela prepares the connection details and opens the official ChatGPT plugin entry point. The user completes host sign-in, permission consent, creation, and removal. Keep a valid existing registration. Use standard MCP authentication for an HTTPS endpoint; never fall back silently to anonymous public access.

OpenAI Secure MCP Tunnel can connect an eligible private local MCP server when `tunnel-client` runs with its `tunnel_id` and runtime API key and the tunnel is associated with the target ChatGPT workspace. Eligibility and workspace association must be established before setup. A tunnel is a private/custom connection path; public plugin distribution requires a stable public HTTPS MCP endpoint and the separate partner approval and review process.

Bundled local stdio plugins are a separate Desktop-only path. OpenAI limits local-MCP directory submissions to approved partners whose organization is allowlisted. The plugin runs in locally executed ChatGPT Desktop threads; this contract does not cover ChatGPT Web, mobile, or Tela's Electron-hosted Web workers. Personal or repository marketplace discovery is not public directory approval.

A remote plugin routes to its configured endpoint, not automatically to the computer displaying ChatGPT. Account identity, Origin, IP address, and conversation IDs do not prove the caller's physical device. The current remote connection therefore does not guarantee current-device-only access. Do not add device discovery or remote fallback to imply that guarantee. If a surface cannot use its supported local transport, report the limitation.

## Local recovery and removal

The packaged CLI and maintenance window use the existing owned-resource lifecycle. Start local Chat with `chatgpt-tela services start chat` after installation and configuration. A stopped service can be started through that command. If a service registration appears running but its authenticated runtime is unreachable, maintenance preserves the registration and dependent resources rather than killing an unverified process. A stopped service does not require a live Chat RPC for a local uninstall plan; task status may remain unavailable while Chat is offline.

Repair uses the matching package and requires an authenticated, ready runtime before stopping a service that is still running. Review the repair plan before applying it.

Local removal previews owned-resource changes and asks for confirmation. The default keeps Tela settings and saved data; **Also remove saved Tela data** opts into removing Tela-owned credentials, profiles, caches, diagnostics, services, and routes covered by the ownership manifest. User projects, other plugins, the ChatGPT application, its login and conversation history, and server-side account data remain outside local Tela ownership.

ChatGPT plugin disconnection or deletion is a separate host operation. When the host does not expose a supported removal API, open its official plugin management screen and explain that account cleanup remains to be completed there. Local uninstall cannot promise server-side data erasure. Reinstall may reuse retained settings, but must not silently reauthorize a revoked connection or recreate a plugin the user removed.

## Packaged CLI

Run the install commands from the package being installed. The package directory defaults to the directory containing the launcher; pass `--payload` when using another matching package directory.

On macOS, update from Tela's menu-bar **Check for Updates…** action (when shown), or **Settings → Updates → Check for Updates…**, then follow the Sparkle dialog to **Install and Relaunch** when offered. Tela coordinates active work and running services before relaunch; defer the update if work cannot safely finish, and do not force-quit active sessions. The cross-platform CLI help lists `upgrade`, but both `upgrade --dry-run` and `upgrade --apply` are unsupported on macOS.

```sh
chatgpt-tela install --dry-run
chatgpt-tela install --apply
chatgpt-tela bootstrap-status
chatgpt-tela configure --stdin --if-missing < product-config.json
chatgpt-tela services start chat
chatgpt-tela repair --dry-run --payload <matching-package-directory>
chatgpt-tela repair --apply --payload <matching-package-directory>
chatgpt-tela uninstall --dry-run
chatgpt-tela uninstall --dry-run --remove-data
```

Install first. `bootstrap-status`, `configure`, and service control require the installed package and its ownership receipt. `configure --if-missing` preserves an existing configuration. The `services start chat` command controls the local Chat service only.

For Windows/Linux packaged installations, when a matching new package is available, review and then apply the CLI upgrade from that package:

```sh
chatgpt-tela upgrade --dry-run --payload <new-package-directory>
chatgpt-tela upgrade --apply --payload <new-package-directory>
```

Repair uses the matching package to restore the installed version.

For uninstall, the default keeps configuration, state, browser profiles, and credentials. Add `--remove-data` only when the user explicitly chooses to remove saved Tela data. `uninstall --apply` must run from a separately extracted package copy, not from the installed binary directory; the maintenance window stages the existing external runner for this purpose.

```sh
# Run from a separately extracted package copy.
chatgpt-tela uninstall --apply
chatgpt-tela uninstall --apply --remove-data
```

The configuration file is the secret-free `product-v1.json` described in [product lifecycle](product-lifecycle.md); supply credentials through the documented setup flow rather than copying secrets into a public example. The [plugin setup guide](chatgpt-plugin.md) covers the MCP endpoint, authentication choice, and account connection.

## Related operating contracts

- [Web tasks](web-delegation.md) describes the current app-owned boundary and unavailable automatic conversation management.
- [Token efficiency](token-efficiency.md) defines instruction reuse, checkpoint/continuation budgets, and avoiding duplicate context transfer without truncating current authority or replaying uncertain work.
- [Context continuity](context-continuity-contract.md) explains canonical Native history versus bounded Web working context and the recovery boundary for oversized history.
- [Chat capability discovery](chat-capability-discovery.md) defines runtime capability discovery, execution effects, and why a successful command exit is not task-success evidence.
- [Cross-profile local continuity](cross-profile-local-thread-continuity.md) records the account and physical-profile isolation boundary. Same-account conversation sync does not grant access to another computer's local files.

## References

- [OpenAI: Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI: Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only)
- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: Authentication](https://developers.openai.com/plugins/build/auth)
