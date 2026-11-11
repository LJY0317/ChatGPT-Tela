# Official Desktop routing with the built-in OpenAI provider

Tela keeps `model_provider = "openai"`. Its existing composite Responses ingress
forwards Native model requests to OpenAI and sends Tela Web model requests to the
browser runtime. The official Desktop continues to own conversations and tool
execution. No separate provider selection, external Native engine, launch-time
proxy or conversation-record rewriting is required.

The official [`openai_base_url` setting](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations)
supports routing the built-in provider without a new `model_providers.<id>` entry.
This is a user-level setting; project-local configuration cannot redirect it.
Native inference also traverses Tela while this setting is active. The local
service must be running; keeping the OpenAI provider identity does not provide
Native service independence or automatic fallback.

## Configure and connect

Explicitly enable the existing app-owned route during product configuration:

```text
chatgpt-tela configure --file <product-config.json> --enable-app-owned-desktop
chatgpt-tela services start
```

The flag also works with `configure --stdin`. Without it, existing configuration
is preserved. The default profile needs no Plura installation. Additional detected
profiles use Plura Desktop's target contract v2 and must be selected explicitly
with `--slot N`; each has its own local route, capability and model catalog.

In Control Center → Work, enable **Web models** for the selected profile and wait
for **Ready**. The installed runtime prepares an account-bound Native/Web model
catalog. Then connect the official user-level config through the existing launcher:

```text
chatgpt-tela desktop-provider register --dry-run
chatgpt-tela desktop-provider register --apply
```

Registration installs only an exact install-marked `openai_base_url` and, when
unoccupied, `model_catalog_json`. It preserves the selected model, unrelated
settings, comments and file permissions. An existing external base URL is not
overwritten. A foreign or edited model catalog is preserved and reported; that
result does not claim Web choices were added. Select the built-in `openai` provider
first if using another provider. Normally restart Desktop to load configuration;
hot reload is not assumed. Choose a Web model only after its catalog is available.

For an additional profile, explicitly select its existing config file:

```text
chatgpt-tela desktop-provider register --dry-run --slot 2 --config-file /selected/profile/config.toml
chatgpt-tela desktop-provider register --apply --slot 2 --config-file /selected/profile/config.toml
```

Tela retains the restoration reference, not ownership of the entire file. It does
not reconstruct private profile paths. Registration does not authorize another
computer: local routing and tool authority remain scoped to this installation.
Native/Chat work-tool inventory policy is separate from provider identity.

## Restore, update and remove

```text
chatgpt-tela desktop-provider restore --dry-run
chatgpt-tela desktop-provider restore --apply
chatgpt-tela desktop-provider restore --apply --slot 2
```

Restore removes the unchanged install-owned base URL and catalog reference, leaving
the built-in provider selected. Tela Web model defaults on affected OpenAI root or
named profiles are cleared so the official engine can select a Native default.
Unrelated model choices and custom providers remain untouched. Uninstall reuses
this same restoration path after activity/ownership admission, before removing
services and catalogs. User-modified settings are preserved; an unresolved active
reference to this installation prevents removing its required resources.

Registration and restore remove an exact owned registration from the retired
`chatgpt_tela_local` path and normalize its config selections to `openai`. This is
removal-only cleanup: new registrations never create that provider. It does not
migrate old conversations. Desktop may refuse old conversations stored with the
retired provider; Tela does not revive them or rewrite their provider history.

On macOS, Sparkle owns download, verification, replacement and relaunch. Tela's
existing handshake restores services and prepares missing opted-in routes. There
is no second CLI upgrade engine. See [upgrade recovery](upgrade-recovery.md#macos-updates-through-sparkle).

## Verification boundary

Isolated tests exercise the packaged configuration transaction, per-profile
separation, uninstall and the official engine's Responses/tool contract while
keeping the `openai` conversation identity. Synthetic authorization and model
responses are not real account-backed inference or production Desktop UI
acceptance. Verify actual Web model selection, existing OpenAI conversation resume
and return to Native tools in the current Desktop before consumer rollout.
