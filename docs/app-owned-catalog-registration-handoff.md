# App-owned catalog handoff to the official Desktop

This is the handoff contract for the existing explicit `desktop-provider register`
flow. It is not an installed feature or an instruction to alter a live Codex
account. The official 0.167 engine fixture already establishes that a complete
startup `model_catalog_json` makes dynamically discovered Web models selectable
alongside the original Native models.

## Public configuration boundary

- Codex reads `model_catalog_json` at the **top level** of the user-level
  `config.toml`. The existing `[model_providers.chatgpt_tela_local]` section
  contains provider transport fields (`base_url`, `wire_api`,
  `requires_openai_auth`, `supports_websockets`); it does not own a catalog or
  an engine startup argument. Appending `model_catalog_json` inside that table
  would create a provider field, not the documented top-level setting.
- The registration editor in A's `provider-configuration.ts` deliberately
  preserves the user's top-level `model_catalog_json` and selection. Register
  and restore already use an exact install-ID-marked provider block and refuse
  to replace foreign or modified content. Catalog ownership needs the same
  exact-match rules and must participate in that editor's explicit apply and
  restore transaction. A second independent config editor would race it.
- A shared top-level catalog key is not provider-scoped. A foreign/nonempty
  value must remain untouched. Registering Tela in that case can still install
  the transport provider, but automatic Web catalog admission cannot be
  promised without an explicit user choice to transfer the shared key. This
  is a real scope limit, not a reason to overwrite another provider.

## Minimal integration contract for the owners

1. **D / app-owned child**, after `prepareProductWebDiscovery` and
   `router.refreshWebModelFamilies` have established the bound account, use the
   existing `readDefaultDesktopNativeCatalog` and
   `augmentNativeCodexModelCatalog` to produce the *complete* Native+Web
   `models` document. Write it atomically, mode `0600`, under the verified
   installation's owned cache/profile resource. Do not use model names or a
   persisted Web discovery cache as the source of truth; the source is current
   bound-account discovery. Preparation failure must be distinguishable from
   an HTTP request that never reached `/models`. The already running Desktop
   and its engine remain externally owned.
2. **Registration/CLI owner A**, during the existing explicit registration
   transaction, establish that the catalog file belongs to this installation
   and that its account-bound Web projection was prepared successfully. Add
   the top-level `model_catalog_json = "<owned path>"` only when the top-level
   key is absent and the config has not changed since it was read. Keep it
   before all TOML tables. Record an exact install-ID-marked owned text block
   and the installed catalog resource in the existing installation receipt;
   never claim ownership of the whole user config or change `model_provider`.
   Existing exact provider registration/restore and permission-preserving
   atomic file replacement remain the sole config write path.
3. **Restore/uninstall A**, remove only the unchanged, install-marked catalog
   setting and provider stanza, and retain or refuse removal for user-edited
   or foreign values as the existing registration ownership rules require.
   Remove an owned catalog resource only when the recorded registration no
   longer references it. Desktop may retain a startup-loaded catalog through
   a normal user-controlled restart; stopping Tela's child must not delete a
   catalog still named by user config.
4. **Startup order**, complete the app-owned Web/account proof and catalog
   preparation before the explicit provider registration is applied. The
   user starts or normally restarts the official Desktop after registration;
   Tela never starts, signals, retries, or stops the official engine. Refresh
   or replacement of the file while an engine is already running is *not*
   evidence that official `model/list` has reloaded it. On a new registration
   or normal restart, rebuild from current discovery before the engine loads
   the file, without relying on a stale Web cache.

## Evidence and remaining acceptance

Read-only candidate `8a92ae30` (`provider-configuration.ts` and
`desktop-provider.ts`) proves provider registration has an explicit, exact
owned stanza, and reports `model_catalog_json` as untouched. The official
engine tests at `6f7dfb8a` prove top-level startup catalog admission after
`augmentNativeCodexModelCatalog` with real `debug models` Native metadata,
and separately prove a cold engine without that setting does not fetch the
provider `/models` automatically. Those tests do not prove this handoff is
implemented. Acceptance still requires a disposable installed registration
with initially absent catalog, account-bound discovery, exact owned settings,
the first official Desktop model list and selection, then exact restore while
foreign config keys survive. No provider-local catalog setting or live
Desktop refresh API has been established by the current public contract.
