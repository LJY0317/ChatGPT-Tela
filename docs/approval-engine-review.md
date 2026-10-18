# Approval engine

Behavioral reference: upstream [codex-chatgpt-web approval handler](https://github.com/miuuyy/codex-chatgpt-web/blob/8645a89e6a5fbe011e1bfbb0821a386ca7477ad5/src/adapters/chatgpt-web/browser-worker.ts#L969-L1004), reviewed 2026-10-18. Tela uses the reference to align button selection behavior; it does not import its runtime.

## Current policy

- Approval automation is explicit and off by default. The sole enabled preference is full_access.
- Discovery uses marked provider cards and accessible dialogs with Allow controls. It does not match connector names.
- One visible card and one visible Deny control are required.
- Prefer Allow for this conversation, then Allow once, then generic Allow. The selected target must be unique.
- Card text and warning language are not inspected as risk signals.
- Before input, the existing owner, cancellation, card/revision, target visibility, hit test and one-shot dispatch checks still apply.
- A conversation choice hidden in Approval options is opened once, then linked back to the unchanged card before selection.
- Input receipt, card clearance, owned assistant progress and Native tool result remain separate evidence. An unresolved dispatch blocks another attempt.

## Scope

This policy runs only in an already owned Tela Web operation. ChatGPT host approval cards before Tela receives a tool call are outside this browser adapter. The agent review projection reports structural status and does not create an independent click path.

Source behavior, installed behavior and account-backed completion remain separate acceptance claims. Local renderer fixtures do not establish host behavior or final task success.
