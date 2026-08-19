# DSHX (`dsh-codex`)

DSHX is a terminal frontend for **official DeepSeek Harness** that reuses a pinned Codex TUI thin fork instead of reimplementing a look-alike terminal UI.

## Product contract

From a code project, the normal user entry point is:

```bash
dshx
```

No separate Codex installation, remote-mode command, bridge command, DSH WebUI, or manual profile plumbing is part of the production UX.

The interaction target is the pinned Codex CLI/TUI: welcome screen, composer, slash commands, model and permission pickers, approvals, ask-user flows, tool/shell cells, diffs, plan/reasoning presentation, steering, Ctrl+C interrupt, resume, status/footer, scrolling, resize and mouse behavior. Windows Terminal and CJK/IME are first-class release gates.

## Ownership boundary

We maintain only:

- the Codex TUI thin fork and upstream sync patches;
- TUI behavior and UX parity;
- the `dshx` launcher, local presentation transport and packaging;
- the thinnest practical projection from DSH **public APIs/events** into the TUI protocol.

We do **not** maintain, fork or recreate DeepSeek Harness capabilities. DSH owns the agent loop, sessions, model routing, tools, sandbox, approval policy, skills, subagents, plugins, jobs/workflows and persistence.

If DSH does not expose a capability, DSHX waits for upstream or explicitly hides/degrades the corresponding UI. It does not implement a replacement runtime.

```text
pinned Codex TUI thin fork       ← DSHX presentation
        │
        │ WebSocket framing over private local UDS
        ▼
dshx-ipc-bridge                  ← tiny transport bridge; no runtime state
        │
        │ JSONL over child stdio
        ▼
DSHX presentation adapter        ← translation only
        │
════════════════ ownership boundary ════════════════
        │ official DSH public APIs/events
        ▼
Official DeepSeek Harness        ← Agent / Session / tools / policy / persistence
```

There is **no TCP listener in the production launch path**. The bridge reuses Codex's own cross-platform `codex_uds` implementation so the Rust TUI and Node DSH composition can stay in separate processes without unsafe FFI.

## Current integration status

The active production-integration work is stacked on `work/dsh-public-adapter`, with the local-IPC/packaging gate in Draft PR #8 (`agent/production-ipc`). The implementation now includes:

- zero-argument `dshx` launch and `dshx resume` flows;
- official DSH runtime composition and exact supported DSH release closure checks;
- DSH-backed session/history, model, permissions, approvals, ask-user, tools/shell/diffs, plan/reasoning, steering/interrupt, fork/compaction and subagent presentation boundaries;
- pinned Codex TUI build plus packaged cross-platform local IPC bridge;
- release artifacts for Linux x64, Windows x64, macOS arm64 and macOS x64;
- clean-install `dshx doctor`, including a real local UDS + WebSocket ping/pong data-plane self-check;
- Linux real-TUI PTY smoke through the production local-IPC topology;
- fail-closed ownership/security tests that keep DSH authoritative.

A commit is not called 1.0-ready merely because these paths exist. The final release candidate still must pass the repository CI/release gates and the side-by-side Windows Terminal/CJK/IME acceptance pass described in `docs/UX-PARITY.md`.

## Build from source

Requirements: Node.js 20+, Rust/Cargo, Git and the platform toolchain required by the pinned Codex workspace.

```bash
npm install
```

Linux/macOS:

```bash
./scripts/build-codex-tui.sh
npm link
dshx doctor
dshx
```

Windows PowerShell:

```powershell
.\scripts\build-codex-tui.ps1
npm link
dshx doctor
dshx
```

`dshx doctor` checks Node, the packaged TUI, the local IPC data plane, the official DSH composition and the isolated DSHX presentation home.

## Release model

Tags matching `v*` build platform-specific installable tarballs in GitHub Actions. The release workflow performs adapter/runtime tests, builds the pinned TUI and IPC bridge, clean-installs each artifact, runs `dshx doctor`, and publishes SHA-256 checksums. Release candidates containing `-` in the tag are published as prereleases.

## Design references

- `docs/ARCHITECTURE.md`
- `docs/RUNTIME-INTEGRATION.md`
- `docs/DSH-CAPABILITY-MATRIX.md`
- `docs/ROADMAP.md`
- `docs/UX-PARITY.md`
- `docs/RELEASE-READINESS.md`
- `SECURITY.md`

## License

Apache-2.0 for project-owned code. Synchronized upstream code keeps its applicable upstream notices and license requirements.
