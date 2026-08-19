# DSHX (`dsh-codex`)

DSHX is a production-oriented terminal frontend for **official DeepSeek Harness** with a Codex-grade interaction target.

## Product goal

From any code project, the normal production entry point is:

```bash
dshx
```

The user should get an experience that tracks the pinned Codex CLI/TUI as closely as practical: welcome screen, composer, slash commands, model/permission pickers, approvals, tool/shell cells, diffs, plan/reasoning, steering, interrupt, resume, status/footer, scrolling, resize, mouse and CJK/IME behavior.

## Ownership boundary

We maintain only:

- the Codex TUI thin fork / upstream sync;
- TUI behavior and UX parity;
- the `dshx` launcher and packaging;
- the thinnest practical adapter from DSH **public APIs/events** to the TUI protocol.

We do **not** maintain, fork or recreate DeepSeek Harness capabilities. DSH owns the agent loop, sessions, model routing, tools, sandbox, approval policy, skills, subagents, plugins, jobs/workflows and persistence.

If DSH does not expose a capability, DSHX waits for upstream or degrades/hides the corresponding UI. It does not implement a replacement runtime.

```text
Codex TUI thin fork             ← dsh-codex owns presentation
        │
        │ private JSONL stdio child process
        ▼
thin DSH UI adapter             ← dsh-codex owns translation only
        │
════════════════ ownership boundary ════════════════
        │
        ▼
Official DeepSeek Harness       ← upstream owns capabilities/runtime
```

## Production transport

`dshx` launches the packaged Codex TUI and points it at a private DSHX adapter child process. The TUI and adapter exchange app-server-compatible JSON-RPC messages as newline-delimited JSON over the child's stdin/stdout.

Normal production startup does **not** open a loopback TCP port, does not require a bearer token, does not invoke `codex --remote`, and does not depend on Codex's experimental WebSocket remote mode. Legacy WebSocket protocol fixtures may remain in the source tree for development compatibility tests, but they are excluded from the installable release closure.

## Product principles

1. **Reuse Codex UI instead of imitating it.** Keep upstream rendering/input code as intact as practical.
2. **DSH is authoritative.** Never create a second session database, policy engine or agent runtime.
3. **Adapter, not framework.** Protocol translation is allowed; reimplementation of DSH capabilities is not.
4. **Fail closed.** Permission/approval semantics that cannot be represented faithfully must never be silently weakened.
5. **`dshx` is the product command.** Production users do not manually run Codex remote mode, bridge processes or DSH profile plumbing.
6. **Windows is first-class.** Windows Terminal/PowerShell and CJK behavior are release gates, not follow-up polish.

## Current status

The active production convergence line is `work/production-1.0` (Draft PR #10), stacked on the latest official-DSH adapter work.

Implemented product surfaces include the zero-argument launcher, pinned Codex TUI packaging, DSH session/turn/message projection, resume, permission and approval presentation, shell/tool/diff projection, plan state, DSH-owned fork/compaction delegation, diagnostics, three-platform packaging workflows, Linux PTY smoke and Windows ConPTY smoke. The real TUI smokes exercise the private stdio transport and include CJK input plus terminal resize.

The branch remains a release candidate until its full CI/release gates and the remaining manual UX parity checks are green. In particular, DSHX does not call itself 1.0 merely because the screens render; daily coding loop, security semantics, installable artifacts and terminal behavior must all pass.

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TEAM.md`](docs/TEAM.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/UX-PARITY.md`](docs/UX-PARITY.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SECURITY.md`](SECURITY.md)

## Source checkout

```bash
npm install

# Build the pinned, patched Codex TUI.
./scripts/build-codex-tui.sh      # Linux/macOS
# .\scripts\build-codex-tui.ps1 # Windows PowerShell

node ./bin/dshx.mjs doctor
node ./bin/dshx.mjs
```

Packaged releases include the TUI binary; users do not separately install Codex for normal use.

## License

Apache-2.0 for project-owned code. Synchronized upstream code keeps its applicable upstream notices and license requirements.
