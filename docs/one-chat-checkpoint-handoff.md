# One selected local Native conversation → another profile's new thread

## Product objective and account boundary (2026-10-13)

The user accepts a **new destination conversation ID** and wants to
continue **exactly one selected local Work/Codex task** in another Tela
profile with **one contextual action** (at most one extra choice if the
current original thread cannot be identified). Original ChatGPT/Plura
application binaries, logins and other conversations must remain unchanged.

This is a practical **checkpoint-based transfer**, **not** the earlier
research goal of simultaneously owning/sharing one original conversation
across two accounts. Keep the scoped relay/reader research and other
agents' worktrees, but do not route two accounts to one Native writer or
insert an unproven cross-account consent UI for this MVP.

## Proven Native execution path

`one-chat-checkpoint-handoff.ts` takes **one explicit, exact original
thread ID**, independently verified owner source/destination login and
runtime route bindings, a bounded public source-thread snapshot, and an
owner-confirmed, immutable-for-admission project Git snapshot. The source
is never written during transfer. The checkpoint states explicitly that
earlier turns and opaque model context are not fully transferred.

`one-chat-native-destination.ts` uses only public Codex app-server
`thread/start` followed by one `turn/start` in **the selected
destination's own Native account**. The fresh thread has a new ID. Its
initial read-only, no-approval turn receives task data, acknowledges the
limited context and waits; it does not inherit source approvals/tools.
Empty new rollouts must **not** be read with `thread/read` before their
first turn: pinned Codex 0.159.0 can return an empty-rollout metadata
error at that point. The exact `thread/start` receipt and current
owner/session proof authorize the initial turn; once populated, normal
bounded public thread reads resume.

`one-chat-handoff-journal.ts` stores only operation/checkpoint hashes,
states and optional destination IDs in local private SQLite with FULL
synchronous commits. It reserves BEFORE `thread/start`; a repeated
operation or identical source snapshot/new target combination cannot
automatically create another thread **while the owner identity-generation
key remains stable**. After a process restart rotates that local HMAC key,
a freshly approved operation may have a different intent hash; the same
durable operation ID is still blocked across restart. A lost creation/first-turn ACK or
changed destination account is retained as **uncertain**, requiring
owner inspection rather than replay or speculative deletion. No chat
text, private files, login or authentication material is in this ledger.

**Important limitations:** The source reader currently transfers at most
the latest **four** public, indexed/paginated Native turns, with tool
arguments/results and reasoning omitted. This is **not** a sufficient
comprehensive checkpoint for every long-running project, nor proof of
full state/compaction transfer. The Git/admission adapter still must
independently establish source checkout ownership, dirty-file counts,
canonical cwd and that another agent is not writing. The synthetic E2E
uses its **own disposable Git repository**, not a personal worktree.

## Actual two-profile account-backed evidence

On **2026-10-13 around 20:15 KST**, with real authenticated profile 1
and separately authenticated managed profile 2 both `running/ready`:

1. An official, **model-free** newly created test thread was deleted
   on **each** real Native profile. Each exact test thread was absent
   when re-read after official `thread/delete`.
2. An initial account-backed test found a concrete upstream issue:
   immediately reading the **empty first-turn rollout** fails with a
   Native metadata/empty-file error. No model call was made. Its exact
   source synthetic thread was deleted and absence verified. The
   pre-first-turn read was eliminated, not bypassed with retries.
3. Using a **fresh** disposable sample Git checkout, a new Native
   source thread was created under **profile 1** with indexed history.
   A harmless read-only model turn completed. Tela read that **one
   synthetic thread**, built a bounded recent-context/Git checkpoint,
   created a different, new Native thread under **profile 2**, and its
   read-only first model turn also completed. The verified receipt was
   `complete_one_exact_source_to_new_destination`,
   `sameOriginalThreadId:false`, both model turns completed.
4. The two exact synthetic model-backed Native threads were **both
   deleted** using the official `thread/delete`, followed by
   thread-specific absent reads; the sample Git directory and private
   test journal were removed. No other personal conversations were
   read, no saved ChatGPT **Web** chat was created, and no account
   credentials/cookies were transferred.
5. Cleanup proof was then tightened so a transport failure or an
   empty-rollout error is never mistaken for account-side absence.
   An independent real profile-2 no-model creation/delete/read probe
   verified the stricter exact `thread not loaded: <same ID>` predicate.

The sample proves that the **real, installed independent Native accounts
can perform an entire new-thread checkpoint transfer**. It does not
prove that a private 73 MiB Legacy thread can be summarized, that all
previous tool state was inherited, that an arbitrary checkout has no
other writer, or that an independent **ChatGPT Work cloud conversation**
can be created from its native local ID.

## Release gate and minimal consumer UX

**This is source code and an explicit standalone acceptance script, not
a released menu action.** Do not install/enable the code merely because
it packages. Before user exposure:

- Resolve the **currently selected exact Native conversation** through a
  verified owner-side route. If ambiguous, show a single small native
  conversation selector. Never infer identity from the frontmost window
  title or send/checkpoint all conversations.
- Implement the actual owner-scoped workspace/Git/active-writer proof
  and a durable, owner-signed single-handoff approval tied to the
  chosen source thread and destination profile. Source personal
  conversations must never be opened without selection.
- For long tasks, produce a **source-verifiable structured work
  checkpoint** (goals, decisions, checked files/tests, pending tasks,
  unknown facts), rather than pretending the most recent four chat
  messages provide complete continuity. If the source cannot prove
  bounded readable context, ask for the smallest necessary fallback.
- Make the new destination conversation discoverable/visible in the
  intended profile and report actual model completion, not just initial
  `turn/start` admission. Native local account and ChatGPT Web Work
  must be reported as separate outcomes.
- Introduce the low-click menu action **only after** these supported
  owner/UI routes pass an actual user-visible same-project acceptance
  test with exact cleanup and no other conversation touched.

The installed consumer payload is deliberately **unchanged** during
this research. The test driver must only run with
`TELA_EXPLICIT_REAL_HANDOFF_ACCEPTANCE=1`; it never participates in
normal operation.
