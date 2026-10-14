# Pending user decisions and recovery authority

## Problem observed

An owner reported multiple macOS dialogs left unanswered while away from the
computer, including an **official ChatGPT Desktop quit warning** and a **Tela
menu-bar Web-reopen notice**. Prior service diagnostics showed a 15-second
default-Desktop normal-quit timeout and a 10-second outer Codex shutdown
timeout. The dialogs may have contributed to the stall, but without timestamped
window evidence causation is not established. Do not infer a dialog from a
timeout, or a timeout from a dialog.

The source normal-quit implementation also checked for the presence of
`NSRunningApplication.terminate` without invoking it. Fixing that concrete
bug is independent of the user's confirmation choices.

## Two different observation authorities

1. **Tela-owned UI**: the menu-bar app records its *own* decision events before
   entering `NSAlert.runModal()` and after a result. Events contain an
   ephemeral UI-session UUID, decision UUID, approved profile slot, monotonic
   status category and time; they exclude prompts, chat contents, credentials,
   user paths and third-party windows. Existing bounded UI event storage (max
   64 records, 24-hour window and private local permissions) is reused.
   `chatgpt-tela diagnostics decisions` reads that evidence without modifying
   UI or interpreting an unmatched pending event as proof the window is still
   visible. Exit/crash/OS restart can leave unmatched events.
2. **ChatGPT-owned UI**: Tela must not claim to see a dialog belonging to the
   official app using only its own logs, process state, a service timeout or
   generic popup text. A future macOS adapter can use **on-demand, consented,
   read-only Accessibility observation** against one exactly identified
   running ChatGPT process. Fail closed if Accessibility is not authorized,
   process identity changed, windows are ambiguous or OS permissions are
   unavailable. Return a bounded structural classification only
   (`quit_confirmation_visible`, `other_dialog_visible`,
   `no_dialog_observed`, `unavailable`), not raw window titles, text or
   screenshots. Other apps, profiles and their contents are out of scope.

## Decision and action boundaries

- Distinguish `app_running`, `tela_session_ready`,
  `reconnect_required`, `awaiting_owner_decision`,
  `quit_requested`, `quit_refused`, `quit_timeout`, and
  `observation_unavailable`. Do not label a running, unconnected default
  Desktop as crashed.
- Display one concise contextual action when evidence is current and scoped
  to the right owned profile. Allow users to defer. An installed product
  upgrade must not rely on an unattended modal response.
- **Never automatically accept** an official Desktop prompt warning of active
  local chats, force-quit, cancel an unknown user task, change account,
  bypass OS permissions, or press arbitrary buttons. Pending owner confirmation
  blocks upgrade, and a pre-replacement failure should use verified official
  source cancellation/restoration when available.
- A *future* assisted action may be allowed only on a specific user request
  linked to a fresh, one-time decision identity, the same exact Desktop
  process and profile, current active-work/draft proof, a narrow supported
  UI/OS action contract, and post-action verification. Agent-proposed or
  standing unrestricted approval is not consent. If active work/drafts cannot
  be proven safe, request direct user review and do nothing.
- No continuous screenshot capture, background Accessibility polling, OCR,
  permission escalation, raw dialog automation, or arbitrary AppleScript
  clicking. Local UI capture is an opt-in, bounded troubleshooting path.

## Upgrade and recovery sequence

1. Prove signed payload, owner, exact profile intent and active-work drain;
   evaluate outstanding own-UI decision evidence and, when authorized, exact
   external UI observation. Treat unknown as blocked, not clear.
2. Refuse upgrade if a potentially destructive decision needs the owner.
   Preserve running conversations and the original executable.
3. On explicit owner consent, re-prove target and active work **immediately**
   before invoking the normal application lifecycle. Track accepted request
   separately from verified process exit. Never force-close an unknown app.
4. If pre-replacement stop fails, apply the owned, signed source-restoration
   contract with a durable checkpoint; don't remove the checkpoint or replay
   an uncertain upgrade. Once restored, verify Gateway, Chat, Codex, and each
   *previously intended* connection by its own authority.
5. Post-replacement failures require the separate signed repair/resume
   contract; never assume old source binaries still match.

## Acceptance criteria

- Fixture: a Tela notice can be pending for minutes without producing a
  phantom accepted/rejected decision. It resolves exactly once by decision ID.
- Fixture: source-only code records that a macOS normal-quit request was
  actually sent; a false result never becomes an accepted quit; no force kill.
- Fixture: same-profile replacement, stale prompt, another app's dialog and
  missing Accessibility consent all produce an unknown/blocked state.
- Fixture: pending confirmation during pre-replacement upgrade leaves exact
  user work and app intact and restores only previously active services.
- Live check: user can see which step requires attention and choose to
  continue, defer, or cancel; no assistant can silently approve a destructive
  local action. Live acceptance must use a fresh explicit owner-scoped consent
  and a verified restoration checkpoint.

Current source implements **Tela-owned decision evidence**, the read-only
diagnostic query, and the explicit macOS normal-quit method call. The external
Accessibility adapter, secured one-shot remote consent contract, and
independent crash-resumable upgrade restoration helper remain separate
implementation work and must not be represented as complete.
