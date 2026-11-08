# Explicit official Desktop provider opt-in

The official Codex user-level `config.toml` supports `model_provider`,
`model_providers.<id>` and `model_catalog_json`. The official Desktop's
Codex agent shares this configuration source with the CLI/IDE. Project-local
`.codex/config.toml` is **not** the place to configure a provider.

For a new installation, explicitly enable the optional app-owned route during
the existing product configuration step. This generates its private slot-1
capability and registers the catalog directory in the install ownership
manifest without changing the default provider or model:

```text
chatgpt-tela configure --file <product-config.json> --enable-app-owned-desktop
```

The option is also accepted with `configure --stdin`. Omitting it preserves the
existing managed-only default. Reconfiguration preserves an existing route;
an explicit `appOwnedResponses: []` in the supplied configuration clears it
when the opt-in flag is absent. With the flag, slot 1 is always provisioned,
including when an old Native-first configuration contains an empty route list.
Already configured additional slots are preserved, and slot 1 receives an
unused loopback port rather than borrowing another slot's port.
The launcher supports `services start` for all three services, or `services
start chat` for Chat alone. It has no `services start codex` form.
After configuring, start the installed services. If this computer has no saved Work
connection yet, open ChatGPT Tela's Control Center → Work and turn on **Web
models** for the ChatGPT profile. That normal connection starts the installed
app-owned profile runtime; an already-saved connection is restored when the
Codex service starts. Wait until the profile reports **Ready** so its
account-bound Web discovery and Native catalog have been prepared. Then use
the packaged launcher's explicit provider registration:

```text
chatgpt-tela services start
chatgpt-tela desktop-provider register --dry-run
chatgpt-tela desktop-provider register --apply
chatgpt-tela desktop-provider restore --dry-run
chatgpt-tela desktop-provider restore --apply
```

The command requires an installed product receipt, the configured fixed
Responses port and capability, an existing regular official Codex
`config.toml` in its user-level home, and a prepared install-owned model
catalog. The installed profile runtime prepares that catalog after Native
catalog reading and account-bound Web model discovery succeed. It is stored
at the install state path `install/desktop-model-catalog/models.json`, tracked
as the `app-owned-desktop-model-catalog` directory resource in the existing
ownership manifest, and validated against its ownership marker before the
registration command reads it. The producer is compiled into the installed
profile runtime and the reader into the packaged launcher, so neither needs
a development checkout or separately installed helper.

Registration never changes the user's default `model_provider`, `model`, or
`openai_base_url`. It installs the top-level `model_catalog_json` only when
that key is unoccupied, and marks the exact value with the install ID and a
path fingerprint. Existing foreign catalog values are preserved and reported
as `foreign-preserved`; in that case registration does not claim the Web
catalog was connected. It adds only the dedicated
`[model_providers.chatgpt_tela_local]` stanza, with an install-ID comment
marking its exact ownership. Unknown or edited provider definitions block
registration/restoration. Reapplying the same owned stanza is a no-op;
restoring removes only that identical stanza and preserves unrelated settings.
Changes are only written on `--apply`, retaining the existing file permissions.
The dedicated provider sets `requires_openai_auth = true`: official Codex passes
its existing first-party authorization header to Tela, whose Native passthrough
requires and forwards that header to the official backend. Tela does not read,
persist, mint, or replace the account token. Synthetic Web-only success without
this header does not verify Native compatibility.

**Registration is not selection.** If the user wants to use this provider,
they must deliberately select `chatgpt_tela_local` in their user-level
Codex configuration and choose a model admitted by that engine. The
registration command cannot promise the Desktop UI exposes a provider
picker. The app-owned Responses runtime must also be running on its configured
port. A normal Desktop
restart may be needed to load config changes; hot reload is not assumed.
Existing Native-first settings do not migrate automatically. This candidate
does not bundle the optional Native engine. Keep the existing `openai` provider
and Native model until the app-owned profile reports Ready and catalog
registration reports `installed` or `already-owned`. Then explicitly select
`model_provider = "chatgpt_tela_local"` and a model in the prepared catalog.
The optional multi-profile adapter requires a detected, managed Plura target
and a separate explicit `appOwnedResponses` entry with a unique slot, port and
capability. Managed targets use authenticated `/v1/` requests and a dedicated
model-list overlay; the independent default Desktop retains its capability-path
`/v1/` URL. Each profile's account binding, tool bridge, route and Web model
choices remain separate. The packaged `--enable-app-owned-desktop` option
provisions only slot 1; it does not migrate an existing Native-first slot 2.
An installed `multiProfile` value with no `appOwnedResponses` entries keeps
the Native-first configuration and is incompatible with replacing an existing
Native-engine-dependent install with this engine-free candidate unchanged.
The installed Desktop's compatibility with this selection still requires
separate acceptance; neither the packaged launcher nor registration selects it.
Tela's existing uninstall path now restores the exact install-marked provider
stanza automatically. When top-level or named-profile `model_provider` selects
Tela, uninstall switches only that selection to Codex's built-in `openai`
provider. A Tela-only synthetic Web model selection is also cleared so the
official provider can choose its default Native model. Unrelated model
selections, settings, comments and permissions remain.
Uninstall dry-run observes the provider without changing the file. Apply first
checks installation ownership, activity, and the removal plan, then stops the
owned services. Only after these admissions succeed does it restore the exact
provider stanza before resource removal. A modified/foreign stanza that is
still selected blocks uninstall and reports the reason. If it is no longer
selected, uninstall preserves that user-modified provider and may remove Tela's
remaining owned resources. No entire user config file becomes Tela-owned.
The separate explicit `desktop-provider restore` command still requires the
user to select a different provider first. Session-specific overrides are
outside the user-level config editor's scope.

An isolated official engine `0.167.0-alpha.3.2` with an explicit fixture
model catalog accepted this provider configuration using
`model_provider = "chatgpt_tela_local"` and
`modelProvider: "chatgpt_tela_local"`. Its local synthetic Responses
endpoint completed the first turn (including tool-result delivery) and a
second turn in the same thread. This verifies the provider contract only:
it does **not** constitute acceptance of production Desktop UI selection,
Web model catalog admission, startup/restart behavior or user permissions.
The app-owned route must remain opt-in until those are separately verified.

## Two Native-first profiles: consumer transition handoff

For an existing installation with `multiProfile` configured and no active
`appOwnedResponses`, retain the installed Native-first binary and its settings
until an operator has explicitly accepted the transition. The first executable,
non-mutating step is to retain a recovery copy of the installed package and run
the candidate's `upgrade --dry-run --payload <candidate.app>`. Inspect the
reported installation ownership, `shutdownBlockers`, recovery source, and
service preservation before considering any `--apply`. A successful dry run
does not make the new Native-engine-free package compatible with the old routes.

For an authorized transition, first complete or cancel active Work and managed
profile tasks, disconnect the affected profiles through their existing controls,
and preserve the current user-level Codex config and Tela product config for
review. Arrange the package upgrade and the explicitly prepared configuration
as one supervised maintenance window: install/upgrade only with the product's
existing verified lifecycle, then use the newly installed launcher to run
`configure --file <reviewed-product-config.json> --enable-app-owned-desktop`
before reconnecting Work. Keep `multiProfile` and add a separate slot-2
`appOwnedResponses` entry only when the optional Plura target is actually
detected; supply a different port and private capability for that slot. The
flag provisions slot 1 only. No ambient `HOME`, `CODEX_HOME`, or `XDG` override
is part of this procedure.

Start the owned services with `services start`, reconnect slot 1, and require
its account-bound Web discovery and Native+Web model catalog to reach Ready.
Only then run `desktop-provider register --dry-run`, review its exact current
catalog/ownership decision, and explicitly authorize `register --apply`.
Registration leaves `model_provider` and the model unchanged: select
`chatgpt_tela_local` and a catalog-listed model in the user-level official
Codex settings and normally restart the official Desktop under the user's
control to make that selection effective. Reconnect slot 2 independently only
after its managed target and route are proven. Do not equate a ready Web route
with a Native RPC/terminalSession, nor infer account acceptance from a synthetic
HTTP fixture. If admission, catalog or target verification fails, preserve the
installed recovery source and use the existing explicit restore/cancellation
path; never fall back silently to an unmanaged Native process.

An additional isolated official engine run used this repository's exact
registered provider stanza, a fake `HOME`/`CODEX_HOME` with only a synthetic
API-key login file, and a local Responses endpoint. The engine forwarded
`Authorization: Bearer synthetic-fixture-key`, returned an actual host tool
result and finished the turn in two Responses requests. The local app-owned
ingress test separately traversed the existing composite router with
Native → Web → Native and preserved the synthetic first-party header for
both Native requests. No real login, keychain, browser or upstream call was made.
