# Roadmap

All milestones obey one ownership rule: **DSHX maintains the TUI, launcher and thin public-API adapter only. DeepSeek Harness capabilities remain upstream-owned.**

## Milestone 0 — Codex TUI protocol proof

Goal: prove that the pinned Codex TUI can be driven without Codex's agent runtime.

- Pin Codex and DSH upstream commits.
- Implement a deterministic app-server-compatible development stub.
- Support the TUI bootstrap requests: initialize, account/read, model/list, configRequirements/read and thread/start.
- Support turn/start, agent-message streaming and turn/interrupt.
- Expose a zero-argument development launcher: `dshx`.
- Run the proof on Windows Terminal and Linux.

Exit gate: the pinned Codex TUI launches from `dshx`, accepts a user prompt and renders the deterministic streaming lifecycle through our protocol seam.

The WebSocket remote path is a development harness only and is removed from the production launch path later.

## Milestone 1 — Official DSH public-API adapter / daily coding loop

Replace the deterministic stub with calls to **official DeepSeek Harness public APIs/events only**.

- Session start/resume/list projection.
- Agent response streaming.
- Shell/tool cells from exposed DSH events.
- File change + unified diff from exposed DSH events.
- Approval and ask-user presentation with DSH policy remaining authoritative.
- Steering and reliable Ctrl+C through official DSH control APIs.
- Model picker backed by official DSH model registry/public surface.
- Context/token footer where DSH exposes the data.

Exit gate: a complete coding task can be performed without DSH WebUI and without implementing any DSH runtime capability in this repository.

## Milestone 2 — Codex UX parity

- Welcome screen parity.
- Composer and slash command parity.
- `/model`, `/permissions`, `/status`, `/review` behavior parity where DSH exposes matching semantics.
- Resume picker parity using DSH session data.
- Plan/reasoning cells where exposed by DSH.
- Scroll/search/mouse/resize behavior.
- Windows Terminal and CJK/IME regression tests.

Exit gate: side-by-side comparison with the pinned Codex release passes the UX parity matrix. Unsupported DSH semantics are explicit, never silently emulated.

## Milestone 3 — DSH capability surfaces (presentation only)

Expose additional DSH capabilities **only when official DSH interfaces exist**:

- Skills UI.
- Subagent UI.
- Jobs/workflows UI.
- Plugin diagnostics/configuration UI.
- DSH-specific command namespace without disturbing Codex-compatible commands.

This milestone adds presentation and translation, not new runtime implementations.

## Milestone 4 — Production packaging and 1.0 gate

- `dshx` zero-argument startup with no manual bridge/profile/remote command.
- Pinned Codex TUI thin fork included in release artifacts; no separate Codex install required for normal use.
- Supported local runtime integration; no production dependency on experimental WebSocket remote mode.
- Versioned protocol/DSH compatibility contract.
- Crash recovery and DSH session durability projection tests.
- Security/approval fail-closed tests.
- Windows/Linux/macOS release artifacts.
- Reproducible CI builds and checksums.
- `dshx doctor` diagnostics.
- Codex/DSH upstream sync playbook.
- Release-candidate dogfooding gate.

1.0 ships only when the daily coding loop, UX parity matrix, security checks and zero-argument `dshx` launch contract are green on supported platforms.
