# Contributing to ChatGPT Tela

ChatGPT Tela is a public pre-alpha project. Small, reviewable changes that preserve its authority and
ownership boundaries are welcome.

## Development setup

Requirements:

- Bun 1.4.0
- Git
- macOS, Windows, or Linux

Clone and verify:

```sh
git clone https://github.com/LJY0317/ChatGPT-Tela.git
cd ChatGPT-Tela
bun install --frozen-lockfile
bun run verify
```

The CI workflow runs the same verification on macOS, Ubuntu, and Windows.

## Project boundaries

- Tela Gateway, Tela Chat, and Tela Codex are separate runtime failure domains.
- Native Codex remains authoritative for Codex task, environment, sandbox, and tool state.
- Ambiguous ownership or destructive state fails closed.
- OpenAI-owned model names, tool names, UI structure, and executable details should be discovered at runtime
  or isolated behind replaceable adapters rather than treated as product-wide constants.
- Single-profile use is the default product path. Multi-profile support stays optional.

Before changing lifecycle or cleanup behavior, read `SECURITY.md` and `docs/product-lifecycle.md`.

## Local-only files and sensitive state

Do not commit credentials, browser/profile data, Tailscale configuration, MCP secrets, raw diagnostic
captures, or machine-specific paths. Root-level `AGENTS.md`, `STATE.md`, and `MILESTONES.md` are
maintainer working files and are intentionally ignored.

Use obvious fixture values in tests. Never copy a real credential into a test, example, issue, or commit.

## Pull requests

Keep changes focused and include tests for behavioral changes. Before opening a pull request, run:

```sh
bun run verify
git diff --check
```

For security vulnerabilities, follow `SECURITY.md` rather than opening a public issue with sensitive
details.
