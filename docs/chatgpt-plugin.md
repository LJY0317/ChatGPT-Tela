# ChatGPT Tela Plugin and App

ChatGPT Tela uses **one plugin that references one user-registered ChatGPT App**. The App owns the user's
connection to their own Tela Gateway endpoint; the Plugin adds reusable routing/workflow guidance for both
ordinary ChatGPT conversations and Work/Codex.

The Plugin deliberately contains no bundled MCP server manifest. A direct MCP declaration would bake one
machine's endpoint into the package and can make the Plugin Desktop-only. Instead, each user registers their
own Tela Gateway once and the generated Plugin references that existing App by its opaque technical ID.

    ChatGPT / Work / Codex
            |
            v
      ChatGPT Tela Plugin
       routing + workflow skill
            |
            v
      ChatGPT Tela App
     user-registered connection
            |
            v
         Tela Gateway
          /       \
         v         v
     Tela Chat   Tela Codex

## Why one Plugin still preserves two failure domains

The Plugin and App are discovery/routing surfaces, not execution owners. Gateway resolves each backend only
when the corresponding control is called. Tela Chat and Tela Codex keep separate processes, mutable state,
health, timeouts, and diagnostics.

- If Tela Chat is unavailable, Codex inventory/calls can still work.
- If Tela Codex is unavailable, Chat workspace capabilities can still work.
- A backend failure is not permission to silently move an operation to the other backend.
- Gateway or the user's tunnel is the intentional shared ingress failure domain.

## First-time connection

The current pre-alpha path is deliberately similar to connecting DevSpace or a local Codex Web harness:
the user owns the endpoint and performs the ChatGPT connection once.

1. Configure and start ChatGPT Tela so that Gateway has a reachable MCP endpoint. For the managed Tailscale
   path this is the configured public HTTPS URL ending in /chatgpt-tela.
2. In ChatGPT, enable Developer Mode and create a custom App named **ChatGPT Tela**. Point it at that Gateway
   endpoint and choose authentication that matches the exposure you configured.
3. Finish the App connection/authorization for the ChatGPT account that will use Tela.
4. Copy the App's **technical ID** from ChatGPT. Current Developer Mode-created App IDs are opaque values such
   as plugin_asdk_app_...; keep the exact value rather than deriving or renaming it.
5. From a Tela source checkout, generate the Plugin archive:

       bun run plugin:package --app-id plugin_asdk_app_...

   The default output is build/chatgpt-tela-plugin.tar.gz. The technical App ID is written only into that
   ignored build artifact; it is not committed to Git.
6. In the ChatGPT workspace's Plugins administration surface, upload/install that archive as
   **ChatGPT Tela**. The referenced App must also remain available to the user's role/account.
7. Start a new conversation/task when validating a newly installed or updated Plugin.

The generated archive contains only:

    plugin.json
    .codex-plugin/plugin.json
    .app.json
    skills/chatgpt-tela/SKILL.md

It deliberately contains no mcp.json or .mcp.json.

## Model routing

The bundled skill is intentionally short enough to guide rather than replace runtime enforcement.

- In ordinary ChatGPT conversations, use Tela Chat when the request needs local project/workspace evidence or
  effects. Open/reuse one workspace, discover runtime capabilities, use bounded reads, and avoid duplicate
  command execution after uncertain responses.
- In Work/Codex, use Tela Codex only for the exact active Native turn. The active transport supplies an opaque
  turn capability; the model must reuse it unchanged and discover that turn's current Native tool inventory.
- Actual tool results and platform errors are evidence. The model should not manufacture local success,
  permission failures, or safety blocks.
- Ordinary knowledge/conversation requests that need neither local workspace access nor active-turn
  delegation should not activate Tela.

Runtime checks remain authoritative. The skill does not grant filesystem, process, turn, sandbox, or approval
authority.

## Availability and publication

This path is intended for a private/personal or workspace Plugin and does not require publishing ChatGPT Tela
to a global Plugin Directory or obtaining an OpenAI Verified badge. Surface availability still depends on the
ChatGPT workspace, role, client, and the connected App itself.

The Plugin package avoids the known Desktop-only trigger of directly declaring an MCP server, but that alone
does not guarantee every ChatGPT client can execute every custom App. Web/mobile/desktop behavior must be
validated against the user's actual account and current ChatGPT product surface.

## Multi-account setups

Single account is the default. Users who intentionally maintain additional isolated ChatGPT accounts repeat
only the App connection/account binding for those extra profiles. The local Tela Gateway and the Plugin
architecture do not fork the Chat and Codex backend implementations per account.
