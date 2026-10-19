# Experimental Codex model-local compaction

This patch lets an explicitly opted-in model use Codex's existing local, plaintext compaction path
while other models keep the provider's default compaction. It does not change provider identity,
authentication, usage limits, tool execution, permissions, or the official Desktop installation.

The upstream revision, toolchain, patch digest, and verification status are in `manifest.json`.
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
upstream commit, patch SHA-256, and `capabilities: ["model-local-compaction-v1"]`.

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
`["model-local-compaction-v1", "model-catalog-refresh-v1"]` and binds the digest of
the compaction patch followed by this patch. Build the CLI and its code-mode helper
together with the exact upstream-pinned sandbox V8 archive/binding pair; ordinary
upstream V8 download URLs do not publish that pair.

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
