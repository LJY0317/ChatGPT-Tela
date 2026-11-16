# Device locality and Native-quota Web acceptance

Source and existing acceptance reviewed on 2026-11-17. This is a scoped audit,
not an account-backed quota test or a two-computer test. Keep the built-in
`openai` provider and the existing Tela Chat/official Desktop routes.

## Already established

- **Local execution boundary.** The Native Responses listener defaults to
  `127.0.0.1` and authenticates its requests
  (`packages/local-server/src/server.ts`). Tela Chat opens only locally approved
  workspace roots and rechecks their directory/volume identity
  (`packages/chat-service/src/workspaces.ts`). The Gateway routes to its
  configured local services; this source does not discover another computer or
  switch to its service when the current one stops.
- **Explicit model routes.** The composite router forwards Native model
  requests to the official OpenAI backend; only an explicitly selected
  `chatgpt-tela-web/family/*` model enters the browser Web route. Model-list
  augmentation itself depends on a successful Native upstream catalog response
  (`packages/development-runtime/src/composite-provider-router.ts`).
  There is no automatic quota-triggered provider/model fallback.
- **Failure evidence.** Native HTTP and HTTP-200 SSE errors are classified as
  `usage_limit`, `rate_limit`, `server_overloaded`, etc. without retaining raw
  account or message content. A retry hint is recorded only when supplied;
  neither this classification nor a UI banner proves Web availability
  (`packages/development-runtime/src/native-failure-diagnostics.ts`,
  `native-reasoning-observation.ts`).
- **Previously accepted behavior.** [Compatibility gates](web-native-compatibility-gates.md)
  record real macOS Web/Tela Chat reads followed by Native commands in the same
  official-provider conversation on two *profiles*, not two computers. The
  [long-history trial](native-web-continuity.md) recorded an official-engine
  Native compaction before the first Web answer. These successful cases need no
  repetition without new failure evidence.

Targeted route, workspace, loopback and Native-error source tests passed
(37/37, 2026-11-17). They do not establish physical-device or exhausted-account
behavior.

## Limits that remain

1. **A saved remote Plugin endpoint is not bound to the caller's computer.**
   ChatGPT stores the selected HTTPS/tunnel connection; the server reached is
   whichever computer hosts that configured endpoint. Account identity,
   conversation identity, IP address and Origin are not physical-device proof.
   Opening ChatGPT on computer B can still invoke computer A's explicitly
   connected remote server. Local root approval limits *that server's* files;
   it cannot make a remote connection mean “this computer.” See
   [consumer installation](consumer-installation.md#host-and-transport-boundaries).
   Device-local semantics therefore require a supported local Desktop transport
   with verified per-device binding. Current remote Plugin operation must be
   described as **configured-endpoint access**, not current-device-only access.
2. **Native exhaustion does not guarantee Web continuation.** The browser must
   still have a valid account session, Web model, connector and usage entitlement.
   The official engine can perform a previous-Native-model `pre_turn` compaction
   before a first Web request, and Native model-list failure can prevent model
   discovery. A warm admitted Web route may avoid a new Native dispatch for a
   compatible short follow-up, but cannot promise that for all histories.
   See [context continuity](context-continuity-contract.md#official-engine-pre-turn-compaction).
3. **Usage pools are externally defined.** Limits depend on plan, workspace,
   model, task, credits and reset period; no source fixture establishes real
   account quota behavior or precise Web token/billing cost. Treat the account’s actual usage display and response as authoritative; do not assume an independent unlimited Web pool.

## One-time acceptance when prerequisites exist

| Case | Procedure with harmless disposable inputs | Passing evidence |
| --- | --- | --- |
| **D1: two physical devices** | On two owned computers signed into the same account, give each approved local workspace a different nonsensitive sentinel. Record each connection's actual transport/endpoint and invoke bounded reads from each device. Take one local service offline and attempt the same reads again. | Each **local-transport** route reads only its own sentinel, never silently discovers/falls back to the other device, and reports its own offline state. If a saved remote Plugin on B still targets A, classify that as configured-remote behavior and **fail** any current-device-only claim for that route. Two local profiles on one Mac do not pass D1. |
| **D2: genuine Native exhaustion** | Only with a separately authorized disposable or already-exhausted account: record plan/workspace, exact displayed limit and reset; observe a real Native usage/rate-limit response. Explicitly select an available Web model in a short disposable `openai` conversation and check Web selection, delivery, and any Tela Chat tool result. Correlate route/turn diagnostics to detect Native dispatch. Then separately check a long-history first Web switch for Native pre-turn compaction. | Report success **only for the tested account/model/history** if the Web final answer and any tool effect arrive despite proven Native limit, with preparation cost recorded. If Web entitlement fails, catalog is unavailable, or Native compaction is blocked, record that exact limitation. Never claim free, unlimited or automatic fallback. |

Neither a second physical device nor a legitimately exhausted test account was
used in this audit. D1 and D2 are **not user-accepted**; do not artificially drain
credits, change logins or reconnect remote endpoints just to simulate them.
Use existing source fixtures for route, workspace and error-class contracts;
they cannot substitute for these two physical/account observations.

## External contracts

- [OpenAI: Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
  — effective allowances, credits and reset are account/plan dependent.
- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
  — tunnel workspace association and reachable server trust boundary, not
  physical caller-device attestation.
- [OpenAI: Desktop-only local MCP Plugins](https://developers.openai.com/plugins/deploy/desktop-only)
  — local Desktop execution is a separately gated distribution contract.

The remaining work is D1/D2 acceptance in an authorized environment, plus
platform-supported per-device local transport if current-device-only access is
a product requirement for a same-account remote Plugin. No new engine, proxy,
quota scheduler or remote fallback is justified by this evidence.
