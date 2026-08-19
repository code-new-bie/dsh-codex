# Roadmap

## Milestone 0 — Protocol proof

Goal: prove that an unmodified or minimally modified Codex TUI can render a DSH-backed conversation.

- Pin a Codex upstream commit.
- Implement initialize / thread start / turn start / agent-message streaming.
- Map one DSH read/search tool event into a Codex item.
- Support interrupt.
- Run on Windows Terminal and Linux.

Exit gate: `input → DSH → tool → streaming answer` works end to end in the Codex TUI.

## Milestone 1 — Daily coding loop

- Session resume/list.
- Shell command cells.
- File change + unified diff.
- Approval requests.
- Ask-user prompts.
- Steering during an active turn.
- Model picker backed by DSH model registry.
- Context/token footer.
- Reliable Ctrl+C behavior.

Exit gate: the CLI can be used for a full coding task without falling back to DSH WebUI.

## Milestone 2 — UX parity

- Welcome screen parity.
- Slash command palette parity.
- `/model`, `/permissions`, `/status`, `/review` behavior parity where concepts map cleanly.
- Resume picker parity.
- Plan/reasoning cells.
- Scroll/search/mouse/resize behavior.
- Windows Terminal and CJK/IME regression tests.

Exit gate: side-by-side comparison with the pinned Codex release passes the UX parity matrix.

## Milestone 3 — DSH-native capabilities

- Skills.
- Subagents.
- Jobs/workflows.
- DSH-specific command namespace without disturbing Codex-compatible commands.
- Plugin diagnostics and configuration surface.

## Milestone 4 — Production 1.0

- Versioned protocol compatibility contract.
- Crash recovery and session durability tests.
- Security/approval fail-closed tests.
- Windows/Linux/macOS release artifacts.
- Reproducible CI builds and checksums.
- Upstream sync playbook.
- Release candidate dogfooding gate.

1.0 is released only when the daily coding loop and UX parity matrix are both green on supported platforms.
