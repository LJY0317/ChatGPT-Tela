# Cross-profile local Work/Codex conversation continuity

## Product goal and supported scope

The requested end state is **one selected original local Work/Codex
conversation usable from either separately signed-in desktop profile**.
This is different from switching Native/Web models within one profile or
copying a lossy task summary into a second, unrelated conversation.

Profile 1's official Desktop/Codex session is owned by the built-in Tela
adapter. Profile 2's Desktop/Codex session is owned by Plura's optional
adapter. Their local `CODEX_HOME`, rollouts, indexes, browser partitions,
Native app-server processes, login and remote registration must remain
separate. Sequentially signing another account into *one profile* is
not the same operation as sharing a conversation across two live profiles.
Do not copy local histories, account credentials, thread indexes, live
tool capabilities, login state or entire app-server endpoints between them.

## Verified boundary, 2026-10-13

- The peer Plura source analysis in its
  `docs/PROFILE_CONTINUITY_AND_THREAD_SHARING.ko.md`
  describes two clients on **one isolated App Server** viewing and
  sequentially continuing one thread. It separately demonstrated that
  unrestricted attachment to that server can reveal unrelated private
  conversations. Neither is a two-account authorization proof.
- Today's on-demand privacy-safe Plura filesystem preflight reported
  `codex_storage: separate`, `desktop_browser_storage: separate`,
  distinct installation identities, and **zero shared same-inode
  rollout files** between real profiles 1 and 2. It read no chat text,
  credentials or raw thread identities. Physical separation alone
  does not establish account-side permission or Work/Remote behavior.
- Upstream Codex app-server documents `thread/read`, `thread/resume`,
  `thread/fork`, `thread/list` and remote-control operations. A
  `thread/fork` makes a **new thread identity**. We have not verified a
  supported cross-account, per-thread owner authorization/delegation
  or atomic owner-transfer contract. Do not treat an ability to address
  an opaque thread ID as authorization to read or execute it.
  Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- On the installed, pinned Codex **0.159.0** Native engine, a freshly
  generated **experimental public JSON schema** exposes `thread/read`,
  `thread/resume`, `thread/fork` and `account/read`, but **no method in
  the `thread/(share|grant|delegate|transfer|permission|access)` family**.
  This is a bounded observation of that public schema, **not proof that no
  future or separate ChatGPT-side sharing API could exist**.
- An independent, no-model synthetic App Server experiment was added at
  `packages/codex/src/cross-profile-path-resume.integration.ts`. It
  creates two disposable, separately rooted `CODEX_HOME` instances, starts
  an **empty** Native thread in the first instance, normally closes that
  owner, and attempts a public experimental path-based resume from the
  second instance. On the pinned 0.159.0 engine, this fixture had **no
  persisted rollout file** (it sent no model turn); resume returned
  JSON-RPC `-32600`. The result is expressly
  `inconclusive_no_persisted_rollout`, **not** evidence that resuming
  an ordinary populated thread must fail. It never touched real profiles,
  personal conversations, account credentials or the installed service.
- Tela's installed `CodexAccountCheckContract` deliberately returns
  `userIdentity:"unverified"`; `accountDisplay` exposes at most a
  temporary email-comparison hint and expressly does **not** prove
  matching owner/workspace. Neither is sufficient to authenticate
  a destination account for a cross-profile original conversation.
- A further **read-only** official `account/read(refreshToken:false)` call
  over each installed, owner-bound Native session proved both profiles
  expose `workspaceRouting.chatgptAccountId`, but the **route/account ID
  was equal** while the two actual Native login emails were **different**.
  Raw account IDs, emails and tokens were never printed. Therefore the
  routing ID is NOT a unique user ID or suitable authorization key.

## 2026-10-13 research-only owner relay

An isolated, **unwired** `LocalOriginalThreadRelay` prototype now lives
under `packages/codex-service/src/cross-profile-thread-relay.ts`. Its
synthetic tests exercise the desired *single original conversation* model,
without copying a rollout, inventing a new thread ID, or attaching a
second client to the owner's unrestricted App Server:

- A trusted local user-approval callback selects **one exact Native thread
  T**, original source profile A, destination profile B and read/continue
  permission. An unpredictable, hashed, ephemeral capability is restricted
  to that selection; permission is never inferred from a thread ID.
- Every operation re-proves the authenticated source profile's account,
  session and route binding and the calling destination's exact binding.
  Account switch, owner restart, expiration and explicit revocation deny
  subsequent access. A caller that is **not** the authorized destination
  is denied without revoking the real destination's valid grant; actual
  source or destination owner changes revoke it. No idle timer or
  unrelated thread listing is added.
- Read-only responses are bounded, revision-stable and structurally tied
  to T. A continuation is **requested from A's one canonical Native
  worker** with optimistic revision checking; it is not executed by B's
  independent App Server or silently billed as a B-side turn.
- Concurrent continuation requests cannot both enter the broker's writer
  path. Exact same-request retries replay a proven result locally; a lost
  or malformed owner execution acknowledgement fails closed as
  **uncertain**, with no automatic second turn. These are isolated
  contract tests, not verified Native process transactions.
- `packages/codex-service/src/cross-profile-account-proof.ts` adds a
  **separate, read-only, source-only Native login change detector**. It
  accepts only an independently verified exact owner-bound loopback
  app-server session, reads public `account/read` twice without a token
  refresh, verifies stable login email **and** workspace routing ID,
  checks the same owned process/response route afterward, and returns
  only keyed SHA-256 fingerprints. An email comparison is useful for
  detecting that an already connected Native login changed; it is
  **not** a cryptographic backend user identity, a durable credential,
  or evidence of authorization to read a different account's thread.
  Fixture tests explicitly use **equal routing IDs and distinct login
  emails** and verify the two proofs stay distinct. The same
  read-only proof, using the real signed installed Codex session
  contracts, distinguished both actual profile logins without printing
  either identity; it did not read a chat or send a model message.
  The HMAC key is process-local rather than a permanent account database;
  a restart deliberately invalidates previously derived access bindings.

**Not a released feature.** The real authenticated `profile`, `delegate`,
`approve` and `owner` adapters have intentionally **not** been wired.
In particular, the existing account-check boolean flags and local
Desktop email are not accepted as substitute identities. Before exposing
this as a service endpoint, establish account/workspace-scoped identities
and exact destination request authentication, native owner-mediated
per-thread paging/events, an atomic Native turn writer/revision guard,
durable request-idempotency across crash/restart, and revocation that
survives service transitions. An in-memory uncertainty set alone is not a
production crash-recovery guarantee.

The built-in Desktop/Work conversation list will **not** automatically
display a source-owned T merely because this relay exists. A separately
supported destination UI/Remote route must show T as an explicitly shared
original with its real owner and tool/usage attribution, not pretend that
T belongs to B or silently fork it. Until that route is proven, disable
all user-facing cross-profile sharing claims.

### Next release-critical proofs (not cosmetic UI)

1. Obtain a stable, authenticated source **and destination account/workspace
   and runtime-generation binding**, plus proof that each incoming request
   actually came from the selected destination. Tela's current
   `userIdentity:"unverified"` does not meet this bar.
2. Prove scoped real Native owner reads and owner-atomic turn acceptance
   without giving destination B unrestricted app-server access. An idle
   snapshot and a task/thread ID by themselves do not guarantee exclusive
   original writer state.
3. Persist bounded operation-idempotency/uncertainty through service restart
   and handle exact-thread paging and notification delivery, account logout,
   session loss, compaction and approval/tool-result handoff.
4. Establish a **supported destination UI or Remote link** that can show
   and act on T without pretending it is B's own saved conversation.
   Do not assume Codex Native protocol proves ChatGPT Work account storage,
   billing attribution or mobile Remote portability.

## Required behavior and acceptance gates

1. **Discover one original thread:** User selects exactly one proven local
   source conversation T and an explicit destination profile B. Source
   current owner A proves original thread/runtime/environment identity,
   idle/active turn state, binding revision, and selected account/workspace.
   No broad thread-list, cross-profile search, background discovery,
   private rollout reading or implicit selection.
2. **Prove destination authority:** A supported public or owned explicit
   per-thread sharing contract must bind T, exact source owner A, target
   profile/account B, allowed actions, expiry and revocation. Account
   identity alone, filesystem access, a UI approval dialog, or a generated
   summary is not sufficient. Fail closed until such a contract is proven.
3. **Keep one execution writer:** If B merely views or requests a turn on
   T, A remains the sole canonical Native worker and validates every
   delegated action against live permission/sandbox/tool authority. B
   receives only scoped T events, never A's entire app-server inventory or
   unrelated private conversation P. A transfer of **writer ownership**
   requires an *upstream-supported exclusive handoff*, including exact
   queued/active turn settlement, atomic rejection of A's old writer,
   workspace and tool authority reconciliation, and a rollback on
   nonadmission. Never run two app servers against the same rollout.
4. **Exact continuation:** Opening the shared original in B must preserve
   T's canonical identity and verified ordered history, incremental
   output/notifications, compaction lineage, tool-result receipts and
   cancellation/steering lifecycle. Duplicating T into a newly-created
   thread or injecting a summary is an optional export/import workflow,
   **not original-thread sharing**; its UX must say so.
5. **Account and Remote independence:** A and B retain their existing
   login/Remote registration; never copy tokens/cookies or silently move
   model charges between accounts. Native Codex and ChatGPT Work may
   have different owner and cloud storage contracts; independently
   validate both. If a B-side Remote client cannot route a supported
   scoped request to A, do not advertise it as shared.
6. **Revocation and negative cases:** Prove unrelated P never appears,
   source logout/crash/restart cannot grant stale access, destination
   reconnect cannot replay a turn, and explicit revocation stops new
   reads/actions. Test simultaneous source/destination writes, deleted
   or archived T, model/account changes, and B disconnect before a
   user-visible enabled state. Use only isolated fake profiles until a
   supported account-bound permission route exists.

**Release status:** No cross-profile original-thread sharing UI, Native
writer transfer or Remote relay is enabled or shipped. The peer macOS
dialog for *summary transfer* is not evidence for the above backend
contract and must not be merged as a substitute. The owner-approved
profile-1/2 live test requires the supported route and a cleanup plan
for any new test conversation before sending. The already implemented
single-profile Native/Web model continuity remains an independent
prerequisite, not proof of cross-profile handoff.
