# Web and Native compatibility gates

The canonical Native task, current turn, tool inventory, sandbox, history,
compaction and final-result provenance must remain independent of the
replaceable Web provider session. This document tracks requirements without
depending on downstream local patch sets or copying an external runtime.

Official app-owned engine + Tela Web Responses provider is **conditionally
adopted**, not accepted as an installed replacement. Isolated official 0.166
fixtures established catalog seeding, normal tool transport, standard
compaction-v2 and selected cancellation/image inputs; they do not establish
Desktop picker refresh, live Web-to-original-Native-tool execution, image/typed
tool result return, or usage-free automatic compression. `usage: null` stays
unknown; official `ModelInfo` has no fork-only `compaction_mode` selector.
Keep canonical Native authority and one summary/checkpoint source; do not
recreate a broker, provider-specific engine or retry protocol. See
`token-efficiency.md` for the existing compaction evidence.
The official engine can execute a typed tool call returned by a synthetic
Responses provider and forward its exact result, but the current ChatGPT Web
UI event contract exposes no authenticated structured Native tool-call intent
or result-continuation receipt. Rendered Markdown cannot supply that authority;
real Web-to-official-Native-tool continuation remains unaccepted.

Native-only recovery is separate from Web-to-Native tool continuation. On
macOS, ordinary official-app launch with Tela Web disconnected accepted a real
Native `cua.getState()` call on official engine 0.166: app enumeration and
browser discovery returned without errors. Clicking, screenshots and browser
interaction remain unaccepted. The Tela-owned engine route still failed
Native pipe/browser-host startup in the other profile. Do not treat a signed
externally started engine as app-owned, or generalize Native-only acceptance
to a shared-engine replacement: Web, history and compaction gates remain.

## App-owned provider cutover

Native models using their original tools and Web models using Tela Chat are the
minimum target. Web-to-original-Native tool execution is a separate capability,
not a prerequisite for restoring Native Computer Use. An input-only Responses
provider also does not inherently need an out-of-band current-turn socket.
It must not turn supplied request identifiers into authority to change an
original Native Goal or retrieve history that was not supplied.

Official custom-provider configuration is a supported startup mechanism. An
attachment to an already-running private stdio engine is not required when a
normal restart is authorized. Isolated 0.166 `config/read` accepted a custom
Responses provider definition; this proves configuration parsing, not Desktop
model discovery, effective routing or Web execution. A subsequent bounded macOS
Desktop startup with a temporary loopback `openai_base_url` received two real
`GET /v1/models` requests. The profile configuration was restored byte-for-byte,
its original Tela Web route returned ready, and the other Desktop PID was
unchanged. No inference or test chat was created. This accepts startup model-list
routing only: the process snapshot omitted engine arguments containing `-c`, so
it does not independently certify that engine's parentage/version. See the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

A following disposable Desktop chat recorded official engine 0.166, the selected
synthetic model, exactly one HTTP Responses dispatch and one completed final
matching the visible answer. This accepts synthetic final delivery, not real Web
inference or Native Computer Use coexistence. The incomplete test ingress first
omitted compressed-body decoding; after fixing that, the user still saw a `5/5`
counter with repeated WebSocket attempts before successful HTTP delivery.
The exact UI counter mapping remains unproved. Further tests reuse the existing
local Responses ingress, including its decoding and explicit 426 response,
rather than reproducing individual transport behaviors in a test server.

The remaining bounded cutover check is an app-owned Desktop start in one authorized
profile with verified engine identity, clean transport, and an original
Native Computer Use call. Preserve and restore that profile's configuration and
leave other profiles unchanged. Existing Plura routed launch starts an external
engine; it is not evidence of this app-owned start. Only after this boundary is
accepted should the basic provider path shed its mandatory Native control-RPC
binding. Exact Goal control, omitted-history retrieval and Native Stop observation
need their own supported contracts; do not silently claim those capabilities or
discard opaque history during the cutover.

## Accepted, owned operation

- An exact user/send receipt and unique user-to-assistant lineage bind every
  accepted Web operation. DOM rearrangement, navigation or a delayed approval
  must not silently change its accepted identity. Uncertain acceptance must
  never cause blind replay or automatic transfer to another conversation.
- An unchanged owned Web session is reused across compatible turns; an exact
  retained suffix is preferred over repeating the whole logical history.
  Fresh epochs are permitted for changed model/effort, invalidated authority,
  explicit provider rollover and hard context limits, never merely because a
  Native task compacted or a diagnostic poll elapsed.
- Large fresh context may use an exact, bounded in-memory attachment with a
  proven receipt; private files, unknown user drafts and existing attachments
  must not be silently mutated. Checkpoints are bound to the canonical source,
  and ambiguous tool results do not advance retained context.
- Web/native switches keep canonical `openai` provider identity and verify
  currently selected Web family and effort before consequential Send.

## Approvals, cancellation and recovery

- Automatic Web approvals are explicit opt-in. Full access prefers the current
  conversation choice, then a one-shot choice, without matching connector names
  or analyzing card text. A unique card-local target and visible Deny control,
  current owner, cancellation, trusted input and independently observed outcome
  remain part of the dispatch lifecycle.
- A human approval wait is a distinct state, not model progress. An overdue
  review must be surfaced with elapsed time and a supported manual decision
- Native turn termination must interrupt the exact active Web operation.
  Mere HTTP disconnect is not evidence that the accepted operation stopped;
  in-flight effects must be reconciled before another authorized turn.
- Cross-account/profiles do not share user credentials, Native turn
  capabilities, physical Web state or arbitrary worktree write authority.
- Public progress and displayed output must be independently verified;
  renderer-visible progress is not proof of a Native application UI receipt.

## Official tool-registration boundary (0.166 source)

- Ordinary MCP uses `[mcp_servers.<server>] enabled = false`; the isolated
  `33d44f84` fixture already verified its official discovery difference.
- Plugin-provided MCP uses
  `[plugins."<actual-plugin-id>".mcp_servers.<manifest-server>] enabled = false`.
  Official `PluginsConfigToml`/`PluginMcpServerConfig`, plugin loader and
  `Config::to_mcp_config_with_loaded_plugins` apply this policy before
  registration. Whole-plugin `enabled = false` also suppresses its MCP/apps/
  skills, so prefer per-server policy when preserving other plugin features.
  Plugin server keys must come from its actual installed manifest; do not
  derive them from a connector display name or tool name.
  The local-chat package declares one `tela-local-chat` MCP server under its
  local marketplace plugin. Official 0.166 resolves this exact plugin/server
  mapping in isolated app-server `plugin/install` tests: server disabled gives
  no stdio initialization or discovery; enabled gives `initialize`,
  `tools/list` and deferred `fixture_probe` discovery. This tests official
  registration under a disposable `CODEX_HOME`, with no real model.
  Package source uses official `.codex-plugin/plugin.json` and `.mcp.json`
  layout; earlier root-level manifest files remain a legacy installed-source
  compatibility case until Root handles migration.
- Account/cloud apps and plugin app declarations have distinct routing:
  `app_mcp_routing.rs` gates plugin app declarations on Codex backend auth and
  can remove an identically named MCP declaration. An `mcp_servers` toggle
  alone cannot prove the app connection or model-visible tool is suppressed.
  `plugins.*` is a Codex plugin configuration layer, not a ChatGPT account
  plugin switch. Web workers use their separately owned connection context.
- Source proof is from public `openai/codex` tag
  `rust-v0.166.0-alpha.6` (`codex-rs/config/src/types.rs`,
  `core-plugins/src/loader.rs`, `core-plugins/src/app_mcp_routing.rs`,
  `core/src/config/mod.rs`). Isolated plugin registration does not prove the
  installed Desktop's effective configuration or account-connected apps. Root
  must verify the exact installed plugin ID and manifest server name against
  the effective Native `CODEX_HOME`, then obtain official plugin/list/read
  and MCP status before/after, plus the Native model's tool discovery and
  actual invocation result on a disposable host session. Preserve separate
  Chat/Web-worker connections and account-app grants.

## Verification gates

Release checks include (1) real model/effort selection and restoration,
(2) owned Native tool/result continuation within a Web turn,
(3) retained Web surface plus suffix-only context with measured transfers,
(4) manual and ordinary opt-in approvals without replay,
(5) real Native Stop-to-Web termination, and (6) secure recovery from a
renderer hang, changed card, or uncertain accepted request.
Also prove real CUA/browser image output, quota switch and the plugin/app
registration boundaries above on the official Desktop; model tool-list
visibility alone cannot pass acceptance.

Source/test pass, installed service health, and the completion of an actual
user workflow are separate pieces of evidence. Consumer signing,
cross-platform packaging, and published release verification remain separate
from local development installation.
