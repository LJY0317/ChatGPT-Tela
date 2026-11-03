# Experimental Codex model-local compaction

This patch lets an explicitly opted-in model use Codex's existing local, plaintext compaction path
while other models keep the provider's default compaction. It does not change provider identity,
authentication, usage limits, tool execution, permissions, or the official Desktop installation.

The upstream revision, toolchain, patch digests, and verification status are in [manifest.json](manifest.json).
The current candidate keeps pre-turn compaction on the selected local-compaction model,
rather than invoking the previous model on a compatibility-hash change or context-window
downshift. Ordinary provider-default model switches retain upstream behavior. This change
is not yet installed; earlier live Web acceptance does not prove this boundary Native-free.
Real ChatGPT Web summarization, canonical plaintext compaction, and exact identifier recall by a
subsequent Web turn have passed in an isolated fixture. The unmodified official engine also cold-resumed
the resulting history. Native replies in this fixture were mocked; exhausted-quota Desktop usability,
consumer release validation remains pending. A release-profile macOS arm64 engine has also passed
signed-payload installation, selection and removal checks. A local ad-hoc signed preview is installed
and selected by a live profile; this is not a notarized consumer release. Ordinary packages without
the optional engine keep using the official engine.

The package builder accepts an optional `--native-engine` executable together with
`--native-engine-metadata` JSON. Metadata uses the package's `nativeEngine` schema: portable executable
path, semantic version, SHA-256, Node platform (`darwin`, `linux`, `win32`), architecture (`arm64`, `x64`),
upstream commit, patch SHA-256, and an ordered capability list. The verified combined
candidate declares all three capabilities listed below.

The builder verifies the supplied bytes/version/platform and includes the engine inside the signed
Tela payload. macOS code signing precedes the final executable digest and payload signature.
Runtime selection requires the installed payload ownership receipt, matching bytes/version/platform,
and no incomplete install transition. Multi-profile owners must advertise `engineOverrideSupported`
and attest the selected `engineOverrideSha256`; incompatible live sessions require normal quit.
Updates and removal use the existing payload lifecycle. No engine path or provider is written into
the user's Codex configuration. Without an owned engine, Tela uses its ordinary official-engine path.

Do not distribute the current debug experiment as a consumer release. OS release binaries, exhausted-quota behavior, and release signing remain separate verification gates.

Automatic-pressure follow-up: browser Responses do not report backend token usage. The
candidate now uses Codex's existing local full-history estimate for context-pressure decisions
on models opting into local compaction. It neither supplies fabricated Responses usage nor
updates quota/billing records. Two no-usage regression cases and 15 automatic compaction
regressions pass; Real automatic Web summary/recall and unmodified official cold resume passed, and the follow-up is installed in the local macOS preview.
The manifest distinguishes the current candidate patch from the installed preview patch.

## Catalog refresh experiment

`model-catalog-refresh.patch` adds the experimental Tela-owned RPC
`tela/modelCatalog/refresh` to the same retained, provider-gated engine catalog.
Its version-1 response is `{ contractVersion, catalog }`, using the ordinary paginated
model-list wire shape with distinct experimental schema identities for the request
and response envelopes. It requests the official `Online` refresh strategy; ordinary
`model/list` keeps its existing cache strategy, and failed remote reads keep the
engine's official last-good fallback. A response is not proof of network freshness
or Desktop picker invalidation. Tela must compare the result with the exact admitted
Web projection before claiming ready.

For this combined candidate, engine metadata declares the ordered capabilities
`["model-local-compaction-v1", "model-catalog-refresh-v1", "model-catalog-seed-v1"]` and binds the digest of
the compaction patch followed by this patch. Build the CLI and its code-mode helper
together with the exact upstream-pinned sandbox V8 archive/binding pair; ordinary
upstream V8 download URLs do not publish that pair.

### Reproducing the verified macOS arm64 source build

At upstream `rust-v0.159.0` (`687a119f0fcaace47e1f1abcc77cec6c813fd6da`), use Rust
1.95.0 and apply the two patches in order. The combined SHA-256 is over their concatenated
bytes (`6f85ea769e0be852ad13e4291201607b0eedd57c810b8c0a68428e661dfb8395`).
The successful source build used V8 `15.0.245.2` / Rust `v8` crate `150.4.0` with the
`ptrcomp_sandbox_release` `aarch64-apple-darwin` archive and matching generated Rust binding:

| Required V8 input | SHA-256 of observed file |
| --- | --- |
| `librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz` | `00adbb48798848c77550441c68673a5e8529b8e1b73eabcdee232cb39b40f4a1` |
| `src_binding_ptrcomp_sandbox_release_aarch64-apple-darwin.rs` | `ca5adf0cf89c9a70ad460ae73648b2fe89b74aa113b3cb7f757b6a02b758394f` |

Obtain and verify this *matching pair* before building. These are observed local checksums,
not an authenticated public download location or signing provenance; an ordinary public clone
cannot be assumed to build without the independently supplied pair. From this Tela repository
and a separate clean upstream Codex checkout, respectively:

```sh
# In the upstream Codex checkout after checking out the pinned commit:
git apply /path/to/ChatGPT-Tela/patches/codex/model-compaction-mode.patch
git apply /path/to/ChatGPT-Tela/patches/codex/model-catalog-refresh.patch
cd codex-rs
RUSTY_V8_ARCHIVE=/path/to/verified/librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz \
RUSTY_V8_SRC_BINDING_PATH=/path/to/verified/src_binding_ptrcomp_sandbox_release_aarch64-apple-darwin.rs \
cargo build --target aarch64-apple-darwin --profile release --bin codex --bin codex-code-mode-host
```

The isolated source build exited successfully and produced `codex-cli 0.159.0` and its
Mach-O arm64 code-mode host. Product metadata parsing and artifact checks accepted all
three declared capabilities. An isolated mock-provider app-server test accepted
`initialize`, fetched an updated catalog via `tela/modelCatalog/refresh`, and returned
that catalog in subsequent `model/list`. This verifies the source/transport contract
under that fixture; it does not verify a live ChatGPT browser, Desktop picker, consumer
installation, signing/notarization, or Windows/Linux release builds. The resulting
binary was not packaged or installed in this build run.

This is a Tela extension, not an upstream API. Some installed previews advertise this
capability; inspect the owned payload metadata rather than infer it from this patch file.
Product source calls it only when the signed owned engine declares `model-catalog-refresh-v1`. Deployment requires a verified engine capability,
one coalesced request per admitted Web catalog transition, actual engine transport
proof, and picker acceptance. Never probe unsupported engines repeatedly, edit their
cache, restart Native to force refresh, or fabricate Desktop notifications.

## Necessity review

The standard engine now has a verified synthetic transport path for Responses
compaction-v2 and startup `model_catalog_json`; these functions do not intrinsically
require this fork. The installed fork still supplies no-usage automatic-pressure
estimation, whose equivalent standard behavior has not been verified. The refresh RPC
also does not invalidate Desktop's picker cache. Keep existing preview compatibility
while validating the standard path; do not expand the fork to repair proxy ownership
or terminal-response replay. See [the responsibility review](../../docs/token-efficiency.md#standard-engine-and-optional-fork).

The catalog patch also reproduces the existing `model-catalog-seed-v1` contract:
`features.tela_seeded_model_catalog=true` treats `model_catalog_json` as an initial
snapshot for the ordinary OpenAI model manager, preserving its remote/cache lifecycle.
Without this opt-in the upstream static-catalog behavior remains unchanged. The owned
engine capability list includes `model-catalog-seed-v1` only after startup and remote
refresh acceptance. These conditions passed in the isolated mock-provider source test;
live Desktop picker acceptance remains outstanding. The manifest binds both ordered patch files; an engine built from
only the compaction patch must not replace a preview declaring both catalog capabilities.
