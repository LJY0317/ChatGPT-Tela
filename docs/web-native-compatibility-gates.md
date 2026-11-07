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

An opt-in isolated acceptance fixture in
`packages/codex-service/src/app-owned-profile.test.ts` uses the unmodified
Desktop-bundled Codex 0.167 app-server, a disposable `CODEX_HOME`, and the
production `startAppOwnedProductResponsesRuntime` Responses route. It seeds
the engine catalog from that route's actual `/models` response and starts one
thread on a Web model before selecting a Native model. The Web turn reaches
the supplied provider; the Native turn reaches the isolated upstream stub,
executes the engine's original `exec_command`, and returns the exact
`function_call_output` to the same thread. The existing separate assembly
fixture proves authenticated supplied Goal-tool roundtrip, disconnected final
retention and exact recovery after an app-owned child restart. This is not
evidence that a Web model can invoke arbitrary Native tools: the supplied
bridge currently admits only originally advertised Goal functions.

Cold-start catalog gap: in the same isolated fixture, official 0.167
`model/list` without `model_catalog_json` does not request the product
`/models` endpoint or expose its Web family. Even fetching that endpoint
after startup does not refresh the already-running official model list.
Separately, the official `debug models` command returns the original Native
catalog in an empty isolated home. The existing managed launch already
combines that catalog with dynamic Web family discovery and writes a temporary
`model_catalog_json` before starting the engine
(`readDefaultDesktopNativeCatalog` and `startDefaultDesktopTargetRuntime`).
The app-owned production starter in
`packages/development-runtime/src/product-profile.ts` currently exposes
only its Responses URL; it has no installation-owned catalog preparation or
official-engine launch configuration contract. Integrating the existing
prelaunch catalog preparation into the app-owned Desktop owner is still
required. The isolated official 0.167 fixture now also reads the full Native
catalog from `codex debug models` in an empty home, merges discovered Web
families using `augmentNativeCodexModelCatalog`, and starts the official
app-server using the resulting catalog; Web and Native model selection and
the original Native tool roundtrip succeed. These are existing assembly
functions, but the production installation/launch connection remains absent.
Its input must be the verified Native discovery and current
account-bound Web families, and its output must be an owned catalog path
provided to the official engine before the first model list. On restart, the
owner must rebuild the projection from current discovery; Native entries must
survive a later Web discovery failure. This requires coordination with the
provider configuration and product runtime owners. The isolated fixture
proves that a restart with a generated catalog makes both model choices
visible and that a later provider `/models` failure does not remove the
already-admitted Native model. It does not prove live official Desktop picker
refresh within the same running session.

For an eventual installed Desktop acceptance, opt into the app-owned route
explicitly on a disposable profile and record the Desktop PID and fixed
Responses URL before starting. In one disposable thread, select a visible Web
model and confirm its actual family/effort and completed turn; switch to a
Native model and observe one original host-tool call, its exact result and
completed turn. Stop and restart only Tela's app-owned child, verify the
Desktop PID and provider URL remain unchanged, and collect the exact
previously unobserved Web operation without another model submission. Confirm
the account binding, internal MCP unmount on stop, and that the managed path
remains available. Desktop picker, real account/browser tool effects and the
installed lifecycle still require owner-observed acceptance; do not change
the installed default based on the isolated fixture.

Native models using their original tools and Web models using Tela Chat are the
minimum target. Web-to-original-Native tool execution is a separate capability,
not a prerequisite for restoring Native Computer Use. An input-only Responses
provider also does not inherently need an out-of-band current-turn socket.
It must not turn supplied request identifiers into authority to change an
original Native Goal or retrieve history that was not supplied.

Official custom-provider configuration is a supported startup mechanism. An
attachment to an already-running private stdio engine is not required when a
normal restart is authorized. See the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

A bounded macOS Desktop trial on official engine 0.166 accepted temporary
`openai_base_url` routing, model discovery, one synthetic final and then a real
Native `cua.getState()` call in the same disposable chat. The engine was a direct
Desktop child; the Native tool returned 33 app entries and two browsers, followed
by a completed Native final. The full existing local Responses ingress handled
compressed requests and WebSocket-to-HTTP negotiation; the user confirmed the
previous `5/5` counter no longer appeared. Do not reproduce selected ingress
behaviors in a separate provider server. Profile configuration was restored
byte-for-byte, the original Web route returned ready, and the other Desktop PID
was unchanged. The disposable chat was deleted and verified absent from both
active and archived lists.

The input-only Electron entry now reuses the same planner, retained-page runner
and Responses transport without a Native source or Native MCP exposure. In a
separate isolated official-engine trial, actual ChatGPT Web family 6 / Extra High
returned a greeting through this entry in about eight seconds. There was no
Native inference fallback, and the existing profile connection was restored.
A later actual Desktop trial accepted a Web-family greeting followed by a
Native model switch in the same chat: the app-owned engine executed
`cua.getState()` and completed both turns. This was a model switch, not Web
invocation of Native tools. The user confirmed that High was selected intentionally and accepted the
trial as successful; do not repeat it to investigate effort selection.
A separate Web tool trial confirmed three successful local-file read effects
and an unchanged file. Its literal nonce assertion failed on Markdown-escaped
underscores, so byte equality and the skipped warm follow-up remain unaccepted.
All profile configuration was restored and the other profile was unchanged.
These are candidate-entry trials, not an installed/default launcher migration.

Built-in `openai` cannot be overridden to add provider headers. The app-owned
trial therefore authenticates the loopback endpoint with a private capability
URL, preserving the original OpenAI Authorization and organization headers.
The existing ingress still handles origin rejection, compressed bodies and
WebSocket-to-HTTP negotiation; no separate authentication server is introduced.

Request metadata supplies correlation only. Duplicate observers join the same
operation, completed results can be collected again, and superseded operations
cannot be replayed within the existing seven-day idle retention period. A lost
HTTP observer does not cancel or restart Web execution. Exact Goal control,
omitted-history retrieval, Native Stop and update-time activity admission still
need supported owner contracts. An empty Native registry is not evidence of an
idle Desktop. Do not claim these capabilities, discard opaque history or switch
the installed launcher before the remaining lifecycle boundaries are accepted.

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
