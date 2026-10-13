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
