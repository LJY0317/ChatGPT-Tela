# ChatGPT Tela Plugin setup

ChatGPT Tela uses ChatGPT's standard **Plugins -> +** MCP connection flow as its primary installation path.
The user connects one Tela Gateway endpoint, chooses the authentication required by that exposure, and
ChatGPT creates the resulting personal/workspace Plugin directly. No separate App technical id, generated
Plugin archive, or Plugin Creator conversation is required for the standard setup.

    ChatGPT / Work / Codex
            |
            v
      ChatGPT Tela Plugin
       saved MCP connection
            |
            v
         Tela Gateway
          /       \
         v         v
     Tela Chat   Tela Codex

## Why one Plugin still preserves two failure domains

The Plugin is an ingress/discovery surface, not an execution owner. Gateway resolves each backend only when
the corresponding control is called. Tela Chat and Tela Codex keep separate processes, mutable state, health,
timeouts, and diagnostics.

- If Tela Chat is unavailable, Codex inventory/calls can still work.
- If Tela Codex is unavailable, Chat workspace capabilities can still work.
- A backend failure is not permission to silently move an operation to the other backend.
- Gateway or the user's tunnel/HTTPS route is the intentional shared ingress failure domain.

## First-time connection

1. Configure and start ChatGPT Tela so Gateway has a reachable MCP endpoint.
2. In ChatGPT, enable **Developer Mode** under Settings -> Security and login.
3. Open **ChatGPT Plugins** and select **+**.
4. Enter the user-facing name **ChatGPT Tela**, the Tela Gateway MCP endpoint, and the authentication method
   that matches the selected exposure. For the current development Tailscale Funnel path, authentication is
   `None`; authenticated production paths should use the authentication contract actually enforced by the
   endpoint.
5. Create the connection and review the four discovered public controls.
6. Open the resulting Plugin in Personal/Workspace Plugins and install/enable it if the current surface asks
   for a separate install step.
7. Start a new Chat or Work task when validating a newly created/refreshed connection.

The stable public MCP surface exposes exactly:

    chatgpt_tela_chat_capability_inventory
    chatgpt_tela_chat_capability_call
    chatgpt_tela_codex_tool_inventory
    chatgpt_tela_codex_tool_call

The first pair routes ordinary local workspace work to Tela Chat. The second pair is reserved for the exact
active Native Codex turn and routes only through Tela Codex.

## Model guidance

The standard direct-MCP Plugin does not depend on an extra packaged Skill. Model guidance lives at boundaries
that are present for every connection:

- MCP server instructions decide when Tela is relevant and preserve the Chat/Codex authority split.
- Tool and capability descriptions require runtime discovery rather than guessed tool names/schemas.
- Tela Chat agent instructions guide bounded reads, edits, verification, and retry behavior.
- The Codex/Web transport contract preserves system/developer/user priority, exact active request identity,
  opaque turn-capability routing, evidence requirements, and same-task continuation.

Runtime checks remain authoritative. Natural-language guidance never grants filesystem, process, turn,
sandbox, approval, or destructive-action authority.

## Authentication

The current pre-alpha Tailscale Funnel proof uses `None` only because the endpoint is a development path and
has no OAuth resource server yet. For a long-lived consumer product, any route that exposes private local data
or write actions must have authentication enforced by the MCP exposure. OpenAI Secure MCP Tunnel is a strong
local-first candidate because it avoids exposing the local listener directly; OAuth 2.1 is the appropriate
choice when Tela later has a shared/hosted multi-user service or an identity provider-backed endpoint.

## Availability

This direct connection path is the same class of Plugin setup used by OpenAI's MCP Plugin quickstart and does
not require public Plugin Directory publication or an OpenAI Verified badge. Client availability still depends
on the user's plan/workspace, role, and current ChatGPT surface. Web/mobile/desktop behavior should therefore
be validated empirically on the target account.

## Multi-account setups

Single account is the default. Users who intentionally maintain additional isolated ChatGPT accounts repeat
only the Plugin connection/account binding for those extra profiles. The local Tela Gateway and the Chat/Codex
backend implementations stay shared and do not become per-account copies.
