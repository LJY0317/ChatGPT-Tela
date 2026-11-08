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
The optional multi-profile adapter requires a detected, managed Plura target.
Select it explicitly with `configure --file <product-config.json> --enable-app-owned-desktop --slot 2`
(or `--stdin`); the launcher validates the public target and allocates a separate
private port and capability. Managed targets use authenticated `/v1/` requests and a dedicated
model-list overlay; the independent default Desktop retains its capability-path
`/v1/` URL. Each profile's account binding, tool bridge, route and Web model
choices remain separate. Without `--slot`, `--enable-app-owned-desktop` provisions
only slot 1. Other profiles are never automatically migrated.
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

The recorded installed baseline `83323f73` still has two Native-first profiles,
an embedded Native engine and no `appOwnedResponses`. Neither the historical
build-7 candidate nor the new **engine-free integration candidate** can replace
those routes unchanged. The new build-8 candidate was assembled once from
`026d5100`, ad-hoc signed and verified locally, with no embedded Native engine;
its private receipt is `build/nov08-engine-free-package/candidate-manifest.json`.
This is **not** an approved update or an installed package. Keep the installed
source and both profiles in place until an operator accepts an explicit,
recoverable per-slot configuration change.

The **public packaged launcher routes** `upgrade --dry-run` and `upgrade --apply`
through `runPackagedLifecycleCommand`, but on **macOS both are rejected** by
`planPackagedUpgradeFromPayload` with `macOS updates use Sparkle; choose Check
for Updates in Tela`, before reading source files or preparing an upgrade plan.
Thus the routed command is not a usable macOS preview or apply path. The
isolated whole-payload lifecycle upgrade tests use a Linux fixture. For an
existing app-bundle installation, Sparkle owns app replacement and relaunch;
Tela's separate `application-update wait/prepare/finish/cancel` handshake only
settles owned services and update metadata. A separately verified legacy
split-payload install requires its own owning lifecycle; the recorded current
installation is an app bundle and **does not require** a keep-data uninstall.
See [upgrade recovery](upgrade-recovery.md#macos-updates-through-sparkle).
Neither route has been exercised against the live installed baseline. Build 7
has a synthetic version, ad-hoc signature and test feed, so it is not an
approved public Sparkle update or an accepted production installer.

For a supervised transition after release acceptance:

1. Finish or explicitly cancel active Work/Native tasks; use the existing
   controls to disconnect affected profiles. Preserve the installed signed
   source, ownership/recovery receipts, Tela product config and user-level
   official Codex config. Check the old installation format and the owning
   lifecycle's **read-only** removal/installation previews. Do not apply an
   update if the recoverable source or task settlement is uncertain.
2. Use only the lifecycle appropriate to the verified source format. The
   recorded installation is an app bundle: use a valid signed Sparkle
   feed/update and its standard maintenance handshake. Only a separately
   proven legacy split-payload installation would require its own keep-data
   owner-controlled removal, followed by a new signed install and dry-run.
   Do not invoke macOS `upgrade`, restore an old legacy updater or treat the
   synthetic build-7 label as a release number.
3. **Do not resume the existing empty-route Native-first services merely
   because the engine-free application bytes were replaced.** Obtain the user's
   separate per-profile conversion approval and reviewed settings during the
   supervised transition. Before reconnecting Work or resuming those profiles,
   run the **newly installed** launcher's
   `configure --file <reviewed-product-config.json> --enable-app-owned-desktop`.
   Preserve `multiProfile`; this prepares slot 1 only. For a detected managed
   Plura target, separately run the same command with `--slot 2`. The launcher
   prepares a distinct private port and capability. If the second target cannot
   be proven, leave it disconnected and defer its conversion; do not silently
   replace it with an unmanaged Native engine or reuse slot-1 credentials.
4. Only after explicit route configuration, run `services start`, reconnect
   the approved slot 1 and require account-bound Web discovery
   and its Native+Web model catalog to reach **Ready**. Review
   `desktop-provider register --dry-run` and explicitly apply registration
   only after the reported catalog and ownership are accepted. Independently
   verify the managed target and route and obtain that profile's separate
   account acceptance before reconnecting slot 2. A missing or unapproved
   route remains disconnected; there is no automatic Native-first fallback.
5. Registration does not select a model. The user must choose
   `model_provider = "chatgpt_tela_local"` and a catalog-listed model in their
   user-level official Codex config, then normally restart the official Desktop
   under their own control and accept the real account/provider behavior.
   Synthetic Responses success or Web Ready status does not establish that
   Desktop acceptance.

For recovery, switch the official Codex selection back to its previous
`openai` provider/model first, then review and apply `desktop-provider restore`
for the exact install-owned stanza. Disconnect affected app-owned profiles and
use the preserved source with the **owning** restore/removal/install lifecycle;
`application-update cancel` is valid only while the unchanged signed source
remains. Preserve uncertain transition journals and work state for settlement.
No live dry-run, apply, account change or Desktop restart was performed in this
handoff. Current source gates provider maintenance when a running official
Desktop may have selected Tela, but does not block an unrelated provider merely
because Desktop is running. User-level config alone cannot prove an
already-running session's selection or its overrides; provider-only installation
is distinct from complete Native replacement. The earlier build-7 package does
not contain this guard, explicit multi-slot configure or later source changes.
Its historical source/package receipt is
`build/nov08-transition-handoff/final-candidate-manifest.json`; the new build-8
private receipt records the final source fingerprint and ad-hoc local checks.
Developer ID signing, notarization, a real signed Sparkle feed and user-approved
installed Desktop/account acceptance remain separate steps.

An additional isolated official engine run used this repository's exact
registered provider stanza, a fake `HOME`/`CODEX_HOME` with only a synthetic
API-key login file, and a local Responses endpoint. The engine forwarded
`Authorization: Bearer synthetic-fixture-key`, returned an actual host tool
result and finished the turn in two Responses requests. The local app-owned
ingress test separately traversed the existing composite router with
Native → Web → Native and preserved the synthetic first-party header for
both Native requests. No real login, keychain, browser or upstream call was made.
